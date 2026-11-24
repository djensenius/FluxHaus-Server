import { HindsightClient, parseAllowedIssuers, parseHindsightTimeout } from '../../clients/hindsight';

const logCalls: unknown[][] = [];
vi.mock('../../logger', () => {
  const record = (...args: unknown[]) => { logCalls.push(args); };
  return {
    __esModule: true,
    default: {
      child: () => ({
        debug: record, error: record, info: record, warn: record,
      }),
    },
  };
});

const APP_KEY = 'test-app-key-not-real';
const ISSUER = 'https://auth.example.com/application/o/fluxhaus/';

function makeClient(overrides: Partial<ConstructorParameters<typeof HindsightClient>[0]> = {}) {
  return new HindsightClient({
    url: 'http://127.0.0.1:9088/',
    appKey: APP_KEY,
    allowedIssuers: [ISSUER],
    ...overrides,
  });
}

const cancelSpies: vi.Mock[] = [];
function jsonResponse(status: number, body: unknown = {}) {
  const cancel = vi.fn().mockResolvedValue(undefined);
  cancelSpies.push(cancel);
  return {
    ok: status >= 200 && status < 300,
    status,
    body: { cancel },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe('HindsightClient', () => {
  let fetchMock: vi.Mock;

  beforeEach(() => {
    logCalls.length = 0;
    cancelSpies.length = 0;
    fetchMock = vi.fn();
    global.fetch = fetchMock;
  });

  it('is configured only when url, key, and allowed issuers are set', () => {
    expect(makeClient().configured).toBe(true);
    expect(makeClient({ url: '' }).configured).toBe(false);
    expect(makeClient({ appKey: '' }).configured).toBe(false);
    expect(makeClient({ allowedIssuers: [] }).configured).toBe(false);
  });

  it('checks issuers against the allow list (trailing slash insensitive)', () => {
    const client = makeClient();
    expect(client.isIssuerAllowed(ISSUER)).toBe(true);
    expect(client.isIssuerAllowed(ISSUER.replace(/\/$/, ''))).toBe(true);
    expect(client.isIssuerAllowed('https://evil.example.com/')).toBe(false);
    expect(client.isIssuerAllowed(undefined)).toBe(false);
  });

  it('recall sends auth, subject, JSON body, redirect error, and a timeout signal', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {
      results: [
        { id: 'm1', text: 'Prefers oat milk', type: 'world' },
        { id: 'm2', text: 42 },
      ],
    }));
    const results = await makeClient().recall('user-sub-1', 'coffee');

    expect(results).toEqual([{ id: 'm1', text: 'Prefers oat milk', type: 'world' }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:9088/v1/default/banks/shared/memories/recall');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.headers).toEqual(expect.objectContaining({
      Authorization: `Bearer ${APP_KEY}`,
      'X-Hindsight-Subject': 'user-sub-1',
      'Content-Type': 'application/json',
    }));
    expect(JSON.parse(init.body)).toEqual({ query: 'coffee', budget: 'low', max_tokens: 1024 });
  });

  it('uses the configured bank and timeout', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { results: [] }));
    await makeClient({ bank: 'my bank', timeoutMs: 1234 }).recall('s', 'q');
    expect(fetchMock.mock.calls[0][0]).toContain('/v1/default/banks/my%20bank/memories/recall');
    expect(timeoutSpy).toHaveBeenCalledWith(1234);
    timeoutSpy.mockRestore();
  });

  it('recall on 404 ensures the bank and returns empty', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(404))
      .mockResolvedValueOnce(jsonResponse(200));
    const results = await makeClient().recall('user-sub-1', 'anything');

    expect(results).toEqual([]);
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe('http://127.0.0.1:9088/v1/default/banks/shared');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ name: 'Shared personal memory' });
    expect(init.headers['X-Hindsight-Subject']).toBe('user-sub-1');
  });

  it('retain ensures the bank once per subject then posts the memory', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200));
    const client = makeClient();
    await client.retain('user-sub-1', 'Has a vegetable garden');
    await client.retain('user-sub-1', 'Bikes to work');

    const methods = fetchMock.mock.calls.map(([u, i]) => `${i.method} ${u}`);
    expect(methods).toEqual([
      'PUT http://127.0.0.1:9088/v1/default/banks/shared',
      'POST http://127.0.0.1:9088/v1/default/banks/shared/memories',
      'POST http://127.0.0.1:9088/v1/default/banks/shared/memories',
    ]);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      items: [{
        content: 'Has a vegetable garden',
        context: 'fluxhaus',
        tags: ['source:fluxhaus'],
        metadata: { source: 'fluxhaus' },
      }],
      async: true,
    });

    // A different subject gets its own ensure call.
    await client.retain('user-sub-2', 'Likes jazz');
    expect(fetchMock.mock.calls[3][1].method).toBe('PUT');
    expect(fetchMock.mock.calls[3][1].headers['X-Hindsight-Subject']).toBe('user-sub-2');
  });

  it('does not cache a failed bank ensure', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(500))
      .mockResolvedValueOnce(jsonResponse(200))
      .mockResolvedValueOnce(jsonResponse(200));
    const client = makeClient();
    await expect(client.retain('s', 'fact')).rejects.toThrow('ensure_bank failed: 500');
    await client.retain('s', 'fact');
    expect(fetchMock.mock.calls[1][1].method).toBe('PUT');
  });

  it('throws generic errors and never logs content, query, or key', async () => {
    const secretish = 'Unique memory content 9f2c';
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { detail: secretish }));
    await expect(makeClient().recall('user-sub-1', secretish)).rejects.toThrow('recall failed: 500');

    fetchMock.mockRejectedValueOnce(Object.assign(new Error(`boom ${APP_KEY}`), { name: 'TimeoutError' }));
    const err = await makeClient().retain('user-sub-1', secretish).catch((e) => e);
    expect(err.message).not.toContain(APP_KEY);
    expect(err.message).not.toContain(secretish);

    const logged = JSON.stringify(logCalls);
    expect(logged).not.toContain(APP_KEY);
    expect(logged).not.toContain(secretish);
  });

  it('caps the per-request timeout at 12s', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { results: [] }));
    await makeClient({ timeoutMs: 60_000 }).recall('s', 'q');
    expect(timeoutSpy.mock.calls[0][0]).toBeLessThanOrEqual(12_000);
    timeoutSpy.mockRestore();
  });

  it('shares one deadline across the requests of an operation', async () => {
    vi.useFakeTimers();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    // First request (recall) takes 7s and returns 404; the ensure-bank retry
    // must only get the remainder of the 2 * 4s budget.
    fetchMock
      .mockImplementationOnce(async () => {
        vi.advanceTimersByTime(7000);
        return jsonResponse(404);
      })
      .mockResolvedValueOnce(jsonResponse(200));
    await makeClient({ timeoutMs: 4000 }).recall('s', 'q');
    expect(timeoutSpy.mock.calls[0][0]).toBe(4000);
    expect(timeoutSpy.mock.calls[1][0]).toBeLessThanOrEqual(1000);
    timeoutSpy.mockRestore();
    vi.useRealTimers();
  });

  it('fails without another request once the operation deadline has passed', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementationOnce(async () => {
      vi.advanceTimersByTime(9000);
      return jsonResponse(404);
    });
    await expect(makeClient({ timeoutMs: 4000 }).recall('s', 'q')).rejects.toThrow('timed out');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('retain re-ensures the bank and retries once on 404', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200)) // ensure
      .mockResolvedValueOnce(jsonResponse(404)) // retain
      .mockResolvedValueOnce(jsonResponse(200)) // ensure again
      .mockResolvedValueOnce(jsonResponse(200)); // retain retry
    await makeClient().retain('user-sub-1', 'Bikes to work');
    expect(fetchMock.mock.calls.map(([, i]) => i.method)).toEqual(['PUT', 'POST', 'PUT', 'POST']);
  });

  it('retain gives up after a single retry', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200))
      .mockResolvedValueOnce(jsonResponse(404))
      .mockResolvedValueOnce(jsonResponse(200))
      .mockResolvedValueOnce(jsonResponse(404));
    await expect(makeClient().retain('s', 'fact')).rejects.toThrow('retain failed: 404');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('cancels unread response bodies on non-OK responses', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(500));
    await expect(makeClient().recall('s', 'q')).rejects.toThrow('recall failed: 500');
    expect(cancelSpies[0]).toHaveBeenCalled();
  });

  it('refuses to make requests when unconfigured', async () => {
    await expect(makeClient({ appKey: '' }).recall('s', 'q')).rejects.toThrow('not configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Hindsight config parsing', () => {
  it('parses timeout with default and cap', () => {
    expect(parseHindsightTimeout(undefined)).toBe(4000);
    expect(parseHindsightTimeout('abc')).toBe(4000);
    expect(parseHindsightTimeout('2500')).toBe(2500);
    expect(parseHindsightTimeout('600000')).toBe(12000);
  });

  it('parses allowed issuers', () => {
    expect(parseAllowedIssuers(' a , ,b ')).toEqual(['a', 'b']);
    expect(parseAllowedIssuers(undefined)).toEqual([]);
  });
});
