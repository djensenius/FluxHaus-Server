/* eslint-disable no-underscore-dangle */
/* eslint-disable import/extensions */
import fs from 'fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
/* eslint-enable import/extensions */
import createMcpServer from '../mcp-server';
import {
  MCP_FULL_ONLY_PROMPTS, MCP_FULL_ONLY_RESOURCES, MCP_FULL_ONLY_TOOLS,
  MCP_READ_PROMPTS, MCP_READ_RESOURCES, MCP_READ_TOOLS, McpAccess, mcpAccessForUser,
  isSensitiveKey, omitKeysDeep, redactMcpResult, redactSensitive,
} from '../mcp-access';
import { FluxHausServices } from '../services';
import { InfluxDBClient } from '../clients/influxdb';
import { ForgejoClient } from '../clients/forgejo';
import { ImmichClient } from '../clients/immich';
import { KomgaClient } from '../clients/komga';
import { AudiobookshelfClient } from '../clients/audiobookshelf';
import { BookloreClient } from '../clients/booklore';
import { GrafanaClient } from '../clients/grafana';
import { HomeAssistantClient } from '../homeassistant-client';

vi.mock('fs');

const CAMERA_TOKEN = 'secretcameratoken123';
const cameraEntity = {
  entity_id: 'camera.front_door',
  state: 'idle',
  attributes: {
    friendly_name: 'Front door',
    access_token: CAMERA_TOKEN,
    entity_picture: `/api/camera_proxy/camera.front_door?token=${CAMERA_TOKEN}`,
  },
};

const unifiDevice = {
  mac: 'aa:bb:cc:dd:ee:ff',
  name: 'Office AP',
  x_authkey: 'unifiauthkey',
  x_vwirekey: 'unifivwirekey',
  x_ssh_hostkey_fingerprint: 'fp',
  wlan_overrides: [{ x_passphrase: 'wifipassphrase' }],
  config_network: { type: 'dhcp' },
};

/* eslint-disable @typescript-eslint/no-explicit-any */
function mockServices(): { services: FluxHausServices; car: any; portainer: any } {
  const portainer = {
    configured: true,
    listEndpoints: vi.fn().mockResolvedValue([{ Id: 1, EdgeKey: 'edge-secret' }]),
    listContainers: vi.fn().mockResolvedValue([{
      Id: 'c1',
      Names: ['/db'],
      Command: 'postgres --password=cmdsecret',
      Labels: { 'com.example.db-password': 'labelsecret' },
    }]),
    listStacks: vi.fn().mockResolvedValue([{ Env: [{ name: 'POSTGRES_PASSWORD', value: 'pw' }] }]),
    getContainer: vi.fn().mockResolvedValue({ Config: { Env: ['POSTGRES_PASSWORD=pw'] } }),
  };
  const car = {
    status: { doorLock: true },
    odometer: 15000,
    lock: vi.fn().mockResolvedValue('Locked'),
    unlock: vi.fn().mockResolvedValue('Unlocked'),
  };
  const services = {
    homeAssistantClient: {
      getState: vi.fn().mockImplementation(async (id: string) => (id ? cameraEntity : [cameraEntity])),
      getHistory: vi.fn().mockResolvedValue([[cameraEntity]]),
      renderTemplate: vi.fn().mockResolvedValue(CAMERA_TOKEN),
      callService: vi.fn().mockResolvedValue({}),
    },
    portainer,
    unifi: {
      configured: true,
      listDevices: vi.fn().mockResolvedValue([unifiDevice]),
      getDevice: vi.fn().mockResolvedValue(unifiDevice),
    },
    prometheus: {
      configured: true,
      getTargets: vi.fn().mockResolvedValue({
        status: 'success',
        data: {
          activeTargets: [{
            labels: { job: 'node' },
            discoveredLabels: { __meta_docker_container_label_secret: 'discoveredsecret' },
            health: 'up',
          }],
          droppedTargets: [{ discoveredLabels: { __address__: 'droppedsecret' } }],
        },
      }),
    },
    cleanbot: { cachedStatus: { docked: true } },
    car,
    mieleClient: { washer: {}, dryer: {} },
    dishwasher: { dishwasher: {} },
    cameraURL: 'http://camera.local/stream',
    romperURL: '',
    gymURL: '',
  } as any as FluxHausServices;
  return { services, car, portainer };
}

const registeredNames = (server: any) => ({
  tools: Object.keys(server._registeredTools),
  resources: Object.values(server._registeredResources).map((r: any) => r.name as string),
  prompts: Object.keys(server._registeredPrompts),
});
/* eslint-enable @typescript-eslint/no-explicit-any */

async function connect(access: McpAccess, overrides: Partial<FluxHausServices> = {}) {
  const { services, car, portainer } = mockServices();
  const server = createMcpServer({ ...services, ...overrides } as FluxHausServices, { userSub: 'user-1', access });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client, car, portainer, close: async () => { await client.close(); await server.close(); },
  };
}

describe('MCP access policy', () => {
  beforeEach(() => {
    (fs.existsSync as vi.Mock).mockReturnValue(false);
  });

  it('classifies every registered tool, resource, and prompt exactly once', () => {
    const { tools, resources, prompts } = registeredNames(createMcpServer(mockServices().services));
    const unclassifiedTools = tools.filter((n) => MCP_READ_TOOLS.has(n) === MCP_FULL_ONLY_TOOLS.has(n));
    const unclassifiedResources = resources
      .filter((n) => MCP_READ_RESOURCES.has(n) === MCP_FULL_ONLY_RESOURCES.has(n));
    const unclassifiedPrompts = prompts.filter((n) => MCP_READ_PROMPTS.has(n) === MCP_FULL_ONLY_PROMPTS.has(n));
    expect(unclassifiedTools).toEqual([]);
    expect(unclassifiedResources).toEqual([]);
    expect(unclassifiedPrompts).toEqual([]);
    // No stale policy entries for things that no longer exist.
    expect([...MCP_READ_TOOLS, ...MCP_FULL_ONLY_TOOLS].filter((n) => !tools.includes(n))).toEqual([]);
    expect([...MCP_READ_RESOURCES, ...MCP_FULL_ONLY_RESOURCES].filter((n) => !resources.includes(n)))
      .toEqual([]);
    expect([...MCP_READ_PROMPTS, ...MCP_FULL_ONLY_PROMPTS].filter((n) => !prompts.includes(n))).toEqual([]);
  });

  it('keeps required exclusions out of the read allowlist', () => {
    [
      'lock_car', 'unlock_car', 'start_car', 'stop_car', 'resync_car', 'start_robot', 'stop_robot',
      'clean_room', 'call_ha_service', 'activate_scene', 'set_thermostat', 'create_calendar_event',
      'update_calendar_event', 'delete_calendar_event', 'overseerr_request_media',
      'overseerr_approve_request', 'portainer_container_action', 'influxdb_query',
      'grafana_query_datasource', 'generate_image', 'web_search', 'summarize_url', 'fetch_webpage',
      'view_image',
    ].forEach((name) => expect(MCP_READ_TOOLS.has(name)).toBe(false));
    expect(MCP_READ_RESOURCES.has('camera-url')).toBe(false);
  });

  it('defaults createMcpServer to full access', async () => {
    const { client, close } = await connect('full');
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['lock_car', 'get_car_status']));
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.name)).toContain('camera-url');
    await close();
  });

  it('hides non-allowlisted tools and resources for read access', async () => {
    const { client, close } = await connect('read');
    const toolNames = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(toolNames).toEqual([...MCP_READ_TOOLS].sort());
    const resourceNames = (await client.listResources()).resources.map((r) => r.name).sort();
    expect(resourceNames).toEqual([...MCP_READ_RESOURCES].sort());
    const promptNames = (await client.listPrompts()).prompts.map((p) => p.name).sort();
    expect(promptNames).toEqual([...MCP_READ_PROMPTS].sort());
    await close();
  });

  it('refuses calls to non-allowlisted tools and resources for read access', async () => {
    const { client, car, close } = await connect('read');
    const result = await client.callTool({ name: 'unlock_car', arguments: {} })
      .catch((err: Error) => ({ isError: true, content: [{ type: 'text', text: err.message }] }));
    expect(result.isError).toBe(true);
    expect(car.unlock).not.toHaveBeenCalled();
    await expect(client.readResource({ uri: 'fluxhaus://camera/url' })).rejects.toThrow(/disabled/);
    const allowed = await client.callTool({ name: 'get_car_status', arguments: {} });
    expect(allowed.isError).toBeFalsy();
    await close();
  });

  it('refuses in the wrapped handlers even if a disabled entry is re-enabled', async () => {
    const { services, car } = mockServices();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const server: any = createMcpServer(services, { access: 'read' });
    const tool = server._registeredTools.unlock_car;
    expect(tool.enabled).toBe(false);
    const result = await tool.handler({});
    expect(result.isError).toBe(true);
    expect(car.unlock).not.toHaveBeenCalled();
    const resource = server._registeredResources['fluxhaus://camera/url'];
    expect(resource.enabled).toBe(false);
    await expect(resource.readCallback(new URL('fluxhaus://camera/url'), {})).rejects.toThrow(/read-only/);
  });
});

describe('read access secret isolation', () => {
  beforeEach(() => {
    (fs.existsSync as vi.Mock).mockReturnValue(true);
    (fs.readFileSync as vi.Mock).mockReturnValue(JSON.stringify({
      washer: { image: `https://ha.local/api/camera_proxy/camera.x?token=${CAMERA_TOKEN}` },
    }));
  });

  const callText = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return JSON.stringify(result);
  };

  it.each(['portainer_list_stacks', 'portainer_get_container', 'portainer_list_endpoints', 'render_template'])(
    'a read key cannot list or call %s',
    async (name) => {
      const { client, portainer, close } = await connect('read');
      expect((await client.listTools()).tools.map((t) => t.name)).not.toContain(name);
      const result = await client.callTool({
        name, arguments: { endpointId: 1, containerId: 'c1', template: '{{ 1 }}' },
      }).catch((err: Error) => ({ isError: true, content: [{ type: 'text', text: err.message }] }));
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toMatch(/POSTGRES_PASSWORD|edge-secret|secretcameratoken/);
      expect(portainer.listStacks).not.toHaveBeenCalled();
      expect(portainer.getContainer).not.toHaveBeenCalled();
      expect(portainer.listEndpoints).not.toHaveBeenCalled();
      await close();
    },
  );

  it('still lets a read key list containers', async () => {
    const { client, close } = await connect('read');
    expect(await callText(client, 'portainer_list_containers', { endpointId: 1 })).toContain('/db');
    await close();
  });

  it('redacts camera tokens from every read tool, resource, and prompt that returns HA data', async () => {
    const { client, close } = await connect('read');
    const outputs = [
      await callText(client, 'get_entity_state', { entity_id: 'camera.front_door' }),
      await callText(client, 'list_entities', {}),
      await callText(client, 'get_entity_history', { entity_id: 'camera.front_door', start: '2026-01-01T00:00:00Z' }),
      await callText(client, 'get_home_summary', {}),
      JSON.stringify(await client.readResource({ uri: 'fluxhaus://appliances/status' })),
      JSON.stringify(await client.getPrompt({ name: 'appliance_report' })),
      JSON.stringify(await client.getPrompt({ name: 'goodnight' })),
    ];
    outputs.forEach((output) => expect(output).not.toContain(CAMERA_TOKEN));
    expect(outputs[0]).toContain('[REDACTED]');
    expect(outputs[0]).toContain('/api/camera_proxy/camera.front_door?token=[REDACTED]');
    expect(outputs[0]).toContain('Front door');
    await close();
  });

  it('redacts UniFi device credentials for read access', async () => {
    const { client, close } = await connect('read');
    const outputs = [
      await callText(client, 'unifi_list_devices', {}),
      await callText(client, 'unifi_get_device', { mac: unifiDevice.mac }),
    ];
    outputs.forEach((output) => {
      expect(output).not.toMatch(/unifiauthkey|unifivwirekey|wifipassphrase/);
      expect(output).toContain('Office AP');
      expect(output).toContain('x_authkey');
    });
    await close();
  });

  it('omits container Command/Labels and Prometheus discoveredLabels for read access', async () => {
    const read = await connect('read');
    const containers = await callText(read.client, 'portainer_list_containers', { endpointId: 1 });
    expect(containers).toContain('/db');
    expect(containers).not.toMatch(/Command|Labels|cmdsecret|labelsecret/);
    const targets = await callText(read.client, 'prometheus_get_targets', {});
    expect(targets).toContain('node');
    expect(targets).not.toMatch(/discoveredLabels|discoveredsecret|droppedsecret/);
    await read.close();

    const full = await connect('full');
    expect(await callText(full.client, 'portainer_list_containers', { endpointId: 1 })).toContain('cmdsecret');
    expect(await callText(full.client, 'prometheus_get_targets', {})).toContain('discoveredsecret');
    await full.close();
  });

  it('does not redact for full access', async () => {
    const { client, close } = await connect('full');
    expect(await callText(client, 'get_entity_state', { entity_id: 'camera.front_door' })).toContain(CAMERA_TOKEN);
    await close();
  });

  it('redacts sensitive keys, token query params, and embedded JSON text', () => {
    expect(redactSensitive({
      a: { access_token: 'x', password: 'p', token: 7, nested: [{ entity_picture: '/p?a=1&token=abc&b=2' }] },
      ok: 'plain',
    })).toEqual({
      a: {
        access_token: '[REDACTED]',
        password: '[REDACTED]',
        token: '[REDACTED]',
        nested: [{ entity_picture: '/p?a=1&token=[REDACTED]&b=2' }],
      },
      ok: 'plain',
    });
    expect(redactSensitive({
      credentials: { user: 'u', pass: 'p' },
      private_key: ['line1', 'line2'],
      api_key: 123,
      authkey: 'a',
      x_iapp_key: 'k',
      client_secret: 's',
      total_tokens: 5,
      monkey: 'banana',
      keyboard: 'qwerty',
      empty_token: null,
    })).toEqual({
      credentials: '[REDACTED]',
      private_key: '[REDACTED]',
      api_key: '[REDACTED]',
      authkey: '[REDACTED]',
      x_iapp_key: '[REDACTED]',
      client_secret: '[REDACTED]',
      total_tokens: 5,
      monkey: 'banana',
      keyboard: 'qwerty',
      empty_token: null,
    });
    const urls = redactSensitive([
      'https://h/x?apikey=a1&api_key=a2&key=a3&auth=a4&authSig=a5&password=a6&secret=a7&access_token=a8&keep=ok',
      'postgres://admin:hunter2@db:5432/app',
      'https://user@host/path',
    ]);
    expect(urls[0]).not.toMatch(/a[1-8]\b/);
    expect(urls[0]).toContain('keep=ok');
    expect(urls[1]).toBe('postgres://[REDACTED]@db:5432/app');
    expect(urls[2]).toBe('https://user@host/path');
    expect(['x_vwirekey', 'x_authkey', 'db_password', 'passphrase', 'credential'].every(isSensitiveKey)).toBe(true);
    expect(['accessToken', 'refreshToken', 'authToken', 'clientSecret', 'authKey', 'apiKey', 'AuthKey',
      'privateKey', 'userPassword', 'awsCredentials'].every(isSensitiveKey)).toBe(true);
    expect(['tokens', 'keyboard', 'secretary', 'entity_picture', 'total_tokens', 'monkey', 'totalTokens',
      'secretaryName', 'tokenCount', 'hotkey'].some(isSensitiveKey)).toBe(false);
    expect(redactSensitive({ accessToken: 'a', clientSecret: { v: 1 }, totalTokens: 3 }))
      .toEqual({ accessToken: '[REDACTED]', clientSecret: '[REDACTED]', totalTokens: 3 });
    expect(redactSensitive('https://plex/library/parts/1/file?X-Plex-Token=plexsecret&download=1'))
      .toBe('https://plex/library/parts/1/file?X-Plex-Token=[REDACTED]&download=1');
    expect(redactSensitive('/photo/:/transcode?url=x&x-plex-token=plexsecret'))
      .toBe('/photo/:/transcode?url=x&x-plex-token=[REDACTED]');
    expect(redactMcpResult({ content: [{ type: 'text', text: 'not json "x_authkey": "zz" and "api_key": 42' }] }))
      .toEqual({ content: [{ type: 'text', text: 'not json "x_authkey": "[REDACTED]" and "api_key": "[REDACTED]"' }] });
    expect(omitKeysDeep({ a: [{ Labels: 1, b: { Labels: 2, c: 3 } }] }, new Set(['Labels'])))
      .toEqual({ a: [{ b: { c: 3 } }] });
    const prompt = redactMcpResult({
      messages: [{ content: { type: 'text', text: 'Data:\n{\n  "access_token": "abc"\n} see /x?token=abc' } }],
    });
    expect(JSON.stringify(prompt)).not.toContain('abc');
  });
});

describe('read access input injection', () => {
  let fetchSpy: vi.SpyInstance;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('[]', {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
  });

  afterEach(() => fetchSpy.mockRestore());

  const realClients = (): Partial<FluxHausServices> => ({
    influxdb: new InfluxDBClient({ url: 'http://influx', token: 't', org: 'o', bucket: 'b' }),
    forgejo: new ForgejoClient({ url: 'http://forgejo', token: 't' }),
    immich: new ImmichClient({ url: 'http://immich', apiKey: 'k' }),
    komga: new KomgaClient({ url: 'http://komga', user: 'u', password: 'p' }),
    audiobookshelf: new AudiobookshelfClient({ url: 'http://abs', apiKey: 'k' }),
    booklore: new BookloreClient({ url: 'http://booklore', user: 'u', password: 'p' }),
    grafana: new GrafanaClient({ url: 'http://grafana', user: 'u', password: 'p' }),
    homeAssistantClient: new HomeAssistantClient({ url: 'http://ha', token: 't' }),
  } as unknown as Partial<FluxHausServices>);

  const attacks: [string, Record<string, unknown>][] = [
    ['influxdb_list_measurements', { bucket: 'b") from(bucket: "secrets") |> range(start: -1y) |> yield(name: "x' }],
    ['influxdb_list_measurements', { bucket: 'b"\nimport "experimental/http"' }],
    ['get_entity_state', { entity_id: '../error_log' }],
    ['get_entity_state', { entity_id: 'camera.x/../../camera_proxy/camera.x' }],
    ['get_entity_history', { entity_id: 'sensor.x', start: '2026-01-01/../../../config' }],
    ['get_logbook', { start: '../../states' }],
    ['forgejo_get_repo', { owner: '..', repo: 'admin' }],
    ['forgejo_get_repo', { owner: 'me', repo: 'r/../../../admin/users' }],
    ['forgejo_list_issues', { owner: 'me', repo: 'r', state: 'open&type=pulls' }],
    ['forgejo_list_repos', { owner: '../user/applications/oauth2?' }],
    ['immich_get_album', { albumId: '../system-config' }],
    ['immich_get_person_assets', { personId: '..%2F..%2Fapi-keys' }],
    ['komga_get_series', { seriesId: '../../settings' }],
    ['audiobookshelf_get_item', { itemId: '../../authorize?x=' }],
    ['audiobookshelf_list_items', { libraryId: '../../users' }],
    ['booklore_get_book', { bookId: '../settings' }],
    ['grafana_get_dashboard', { uid: '..' }],
  ];

  it.each(attacks)('%s rejects injected input %j before any request', async (name, args) => {
    const { client, close } = await connect('read', realClients());
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/Invalid|not found/);
    const urls = fetchSpy.mock.calls.map((call) => String(call[0]));
    expect(urls).toEqual([]);
    await close();
  });

  it('still serves valid read inputs', async () => {
    const { client, close } = await connect('read', realClients());
    await client.callTool({ name: 'influxdb_list_measurements', arguments: { bucket: 'home_assistant' } });
    await client.callTool({ name: 'forgejo_get_repo', arguments: { owner: 'me', repo: 'site.github.io' } });
    await client.callTool({ name: 'get_entity_state', arguments: { entity_id: 'sensor.temp' } });
    const urls = fetchSpy.mock.calls.map((call) => String(call[0]));
    expect(urls).toContain('http://forgejo/api/v1/repos/me/site.github.io');
    expect(urls).toContain('http://ha/api/states/sensor.temp');
    expect(String(fetchSpy.mock.calls[0][1]?.body)).toContain('bucket: "home_assistant"');
    await close();
  });
});

describe('mcpAccessForUser', () => {
  it('grants full access to non-key users', () => {
    expect(mcpAccessForUser({ role: 'admin', username: 'u', sub: 's' })).toBe('full');
  });

  it('uses the key scope and fails closed to read', () => {
    expect(mcpAccessForUser({
      role: 'admin', username: 'u', sub: 's', authMethod: 'mcp_api_key', mcpAccess: 'full',
    })).toBe('full');
    expect(mcpAccessForUser({
      role: 'admin', username: 'u', sub: 's', authMethod: 'mcp_api_key', mcpAccess: 'read',
    })).toBe('read');
    expect(mcpAccessForUser({ role: 'admin', username: 'u', sub: 's', authMethod: 'mcp_api_key' }))
      .toBe('read');
  });
});
