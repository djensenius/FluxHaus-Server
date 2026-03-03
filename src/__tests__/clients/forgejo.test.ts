import { ForgejoClient } from '../../clients/forgejo';

jest.mock('../../logger', () => ({
  __esModule: true,
  default: {
    child: () => ({
      debug: jest.fn(),
      error: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
    }),
  },
}));

global.fetch = jest.fn();

describe('ForgejoClient', () => {
  const config = { url: 'http://forgejo:3000', token: 'test-token' };
  let client: ForgejoClient;

  beforeEach(() => {
    jest.clearAllMocks();
    client = new ForgejoClient(config);
  });

  describe('configured', () => {
    it('returns true when url and token are set', () => {
      expect(client.configured).toBe(true);
    });

    it('returns false when token is missing', () => {
      const c = new ForgejoClient({ url: 'http://forgejo:3000', token: '' });
      expect(c.configured).toBe(false);
    });

    it('returns false when url is missing', () => {
      const c = new ForgejoClient({ url: '', token: 'test-token' });
      expect(c.configured).toBe(false);
    });
  });

  describe('listRepos', () => {
    it('calls /api/v1/repos/search without owner', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => [{ id: 1, name: 'repo1' }],
      });

      const result = await client.listRepos();

      expect(global.fetch).toHaveBeenCalledWith(
        'http://forgejo:3000/api/v1/repos/search',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'token test-token',
          }),
        }),
      );
      expect(result).toEqual([{ id: 1, name: 'repo1' }]);
    });

    it('calls /api/v1/users/:owner/repos with owner', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => [{ id: 2, name: 'repo2' }],
      });

      await client.listRepos('myuser');

      expect(global.fetch).toHaveBeenCalledWith(
        'http://forgejo:3000/api/v1/users/myuser/repos',
        expect.any(Object),
      );
    });
  });

  describe('listIssues', () => {
    it('defaults state to open', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      });

      await client.listIssues('owner', 'repo');

      expect(global.fetch).toHaveBeenCalledWith(
        'http://forgejo:3000/api/v1/repos/owner/repo/issues?state=open',
        expect.any(Object),
      );
    });

    it('uses provided state', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      });

      await client.listIssues('owner', 'repo', 'closed');

      expect(global.fetch).toHaveBeenCalledWith(
        'http://forgejo:3000/api/v1/repos/owner/repo/issues?state=closed',
        expect.any(Object),
      );
    });
  });

  describe('listPullRequests', () => {
    it('uses explicit state param', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      });

      await client.listPullRequests('owner', 'repo', 'closed');

      expect(global.fetch).toHaveBeenCalledWith(
        'http://forgejo:3000/api/v1/repos/owner/repo/pulls?state=closed',
        expect.any(Object),
      );
    });

    it('defaults state to open', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      });

      await client.listPullRequests('owner', 'repo');

      expect(global.fetch).toHaveBeenCalledWith(
        'http://forgejo:3000/api/v1/repos/owner/repo/pulls?state=open',
        expect.any(Object),
      );
    });
  });

  describe('error handling', () => {
    it('throws on error response', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      });

      await expect(client.listRepos()).rejects.toThrow(
        'Forgejo request failed: 404 Not Found',
      );
    });
  });
});
