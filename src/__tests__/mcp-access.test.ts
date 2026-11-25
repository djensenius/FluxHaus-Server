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
  redactMcpResult, redactSensitive,
} from '../mcp-access';
import { FluxHausServices } from '../services';

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

/* eslint-disable @typescript-eslint/no-explicit-any */
function mockServices(): { services: FluxHausServices; car: any; portainer: any } {
  const portainer = {
    configured: true,
    listEndpoints: vi.fn().mockResolvedValue([{ Id: 1, EdgeKey: 'edge-secret' }]),
    listContainers: vi.fn().mockResolvedValue([{ Id: 'c1', Names: ['/db'] }]),
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

async function connect(access: McpAccess) {
  const { services, car, portainer } = mockServices();
  const server = createMcpServer(services, { userSub: 'user-1', access });
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
    const prompt = redactMcpResult({
      messages: [{ content: { type: 'text', text: 'Data:\n{\n  "access_token": "abc"\n} see /x?token=abc' } }],
    });
    expect(JSON.stringify(prompt)).not.toContain('abc');
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
