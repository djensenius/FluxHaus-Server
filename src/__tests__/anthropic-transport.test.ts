import type Anthropic from '@anthropic-ai/sdk';
import { executeAICommand } from '../ai-command';
import type { FluxHausServices } from '../services';

// Keep the SDK and provider unmocked: intercept only HTTP, with synthetic fixtures.
describe('Anthropic Messages transport compatibility', () => {
  const imageURL = 'https://fixture.invalid/image.png';
  const imageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwC'
    + 'AAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=';
  const expectedTransport = {
    url: 'https://anthropic.fixture.invalid/v1/messages',
    method: 'POST',
    version: '2023-06-01',
    apiKey: 'synthetic-test-key',
    authorization: null,
    contentType: 'application/json',
  };
  const services = {
    car: { status: { locked: true }, odometer: 42 },
    cameraURL: '',
  } as unknown as FluxHausServices;
  let requests: Anthropic.MessageCreateParamsNonStreaming[];
  let transport: Record<string, string | null>[];
  let replies: Record<string, unknown>[];

  function reply(content: unknown[], stopReason = 'end_turn') {
    return {
      id: 'msg_fixture',
      type: 'message',
      role: 'assistant',
      model: 'claude-3-5-sonnet-20241022',
      content,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    };
  }

  beforeEach(() => {
    requests = [];
    transport = [];
    replies = [];
    vi.stubEnv('AI_PROVIDER', 'anthropic');
    vi.stubEnv('AI_MODEL', 'claude-3-5-sonnet-20241022');
    vi.stubEnv('ANTHROPIC_API_KEY', 'synthetic-test-key');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://anthropic.fixture.invalid');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.url === imageURL) {
        return new Response(Buffer.from(imageBase64, 'base64'), {
          headers: { 'content-type': 'image/png' },
        });
      }
      // Never delegate to real fetch, including unexpected requests or retries.
      if (request.url !== expectedTransport.url) throw new Error('Unexpected HTTP destination');
      transport.push({
        url: request.url,
        method: request.method,
        version: request.headers.get('anthropic-version'),
        apiKey: request.headers.get('x-api-key'),
        authorization: request.headers.get('authorization'),
        contentType: request.headers.get('content-type'),
      });
      requests.push(await request.json() as Anthropic.MessageCreateParamsNonStreaming);
      const response = replies.shift();
      if (!response) throw new Error('Unexpected SDK request: no fixture response');
      return new Response(JSON.stringify(response), {
        headers: { 'content-type': 'application/json' },
      });
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('serializes text/history and parses a legacy end_turn response', async () => {
    replies.push(reply([{ type: 'text', text: 'Hello fixture.', citations: null }]));
    const progress = vi.fn();

    expect(await executeAICommand('Hello', services, [
      { role: 'user', content: 'Earlier question' },
      { role: 'assistant', content: 'Earlier answer' },
    ], progress)).toBe('Hello fixture.');
    expect(requests).toHaveLength(1);
    expect(transport).toEqual([expectedTransport]);
    expect(requests[0]).toMatchObject({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 4096,
      messages: [
        { role: 'user', content: 'Earlier question' },
        { role: 'assistant', content: 'Earlier answer' },
        { role: 'user', content: 'Hello' },
      ],
    });
    expect(requests[0].system).toContain('You are FluxHaus');
    expect(progress).toHaveBeenCalledWith({ type: 'done', text: 'Hello fixture.' });
    expect(replies).toHaveLength(0);
  });

  it('parses tool_use and serializes the actual read-only tool result', async () => {
    const toolUse = { type: 'tool_use', id: 'tool_status', name: 'get_car_status', input: {} };
    replies.push(
      reply([{ type: 'text', text: 'Checking fixture.', citations: null }, toolUse], 'tool_use'),
      reply([{ type: 'text', text: 'Fixture is locked.', citations: null }]),
    );
    const progress = vi.fn();

    expect(await executeAICommand('Read fixture status', services, [], progress))
      .toBe('Fixture is locked.');
    expect(requests).toHaveLength(2);
    expect(transport).toEqual([expectedTransport, expectedTransport]);
    expect(requests[0].tools).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'get_car_status',
        input_schema: { type: 'object', properties: {} },
      }),
    ]));
    expect(requests[1].messages.slice(1)).toEqual([
      { role: 'assistant', content: [
        { type: 'text', text: 'Checking fixture.', citations: null }, toolUse,
      ] },
      { role: 'user', content: [{
        type: 'tool_result',
        tool_use_id: 'tool_status',
        content: JSON.stringify({ status: { locked: true }, odometer: 42 }, null, 2),
      }] },
    ]);
    expect(progress.mock.calls.map(([event]) => event)).toEqual([
      { type: 'progress', text: 'Checking fixture.' },
      { type: 'tool_call', tool: 'get_car_status' },
      { type: 'done', text: 'Fixture is locked.' },
    ]);
    expect(replies).toHaveLength(0);
  });

  it('serializes input/history images and rich image tool results', async () => {
    const image = {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: imageBase64 },
    };
    replies.push(
      reply([{
        type: 'tool_use', id: 'tool_image', name: 'view_image',
        input: { url: imageURL, question: 'Describe the fixture' },
      }], 'tool_use'),
      reply([{ type: 'text', text: 'Image fixture received.', citations: null }]),
    );

    expect(await executeAICommand('Current image', services, [{
      role: 'user', content: 'Earlier image',
      images: [{ base64: imageBase64, mediaType: 'image/png' }],
    }], undefined, [{ base64: imageBase64, mediaType: 'image/png' }]))
      .toBe('Image fixture received.');
    expect(requests).toHaveLength(2);
    expect(transport).toEqual([expectedTransport, expectedTransport]);
    expect(requests[0].messages).toEqual([
      { role: 'user', content: [image, { type: 'text', text: 'Earlier image' }] },
      { role: 'user', content: [image, { type: 'text', text: 'Current image' }] },
    ]);
    expect(requests[1].messages.at(-1)).toEqual({
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'tool_image',
        content: [image, {
          type: 'text', text: `Image fetched from ${imageURL}. Describe the fixture`,
        }],
      }],
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(replies).toHaveLength(0);
  });
});
