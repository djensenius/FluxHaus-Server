import { TautulliClient } from '../../clients/tautulli';

vi.mock('../../logger', () => ({
  __esModule: true,
  default: {
    child: () => ({
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    }),
  },
}));

global.fetch = vi.fn();

describe('TautulliClient', () => {
  const mockConfig = { url: 'http://tautulli:8181', apiKey: 'test-key' };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('configured', () => {
    it('returns true when url and apiKey are provided', () => {
      const client = new TautulliClient(mockConfig);
      expect(client.configured).toBe(true);
    });

    it('returns false when url is empty', () => {
      const client = new TautulliClient({ url: '', apiKey: 'test-key' });
      expect(client.configured).toBe(false);
    });

    it('returns false when apiKey is empty', () => {
      const client = new TautulliClient({ url: 'http://tautulli:8181', apiKey: '' });
      expect(client.configured).toBe(false);
    });
  });

  describe('getActivity', () => {
    it('calls with cmd=get_activity and unwraps response data', async () => {
      const client = new TautulliClient(mockConfig);
      const activityData = { sessions: [], stream_count: 0 };

      (global.fetch as vi.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ response: { data: activityData } }),
      });

      const result = await client.getActivity();

      expect(result).toEqual(activityData);
      const calledUrl = (global.fetch as vi.Mock).mock.calls[0][0] as string;
      expect(calledUrl).toContain('http://tautulli:8181/api/v2?');
      expect(calledUrl).toContain('apikey=test-key');
      expect(calledUrl).toContain('cmd=get_activity');
    });
  });

  describe('getHistory', () => {
    it('passes length param as string', async () => {
      const client = new TautulliClient(mockConfig);

      (global.fetch as vi.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ response: { data: { data: [] } } }),
      });

      await client.getHistory(10);

      const calledUrl = (global.fetch as vi.Mock).mock.calls[0][0] as string;
      expect(calledUrl).toContain('cmd=get_history');
      expect(calledUrl).toContain('length=10');
    });
  });

  describe('error handling', () => {
    it('throws on non-ok response', async () => {
      const client = new TautulliClient(mockConfig);

      (global.fetch as vi.Mock).mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      await expect(client.getActivity()).rejects.toThrow(
        'Tautulli request failed: 500 Internal Server Error',
      );
    });
  });
});
