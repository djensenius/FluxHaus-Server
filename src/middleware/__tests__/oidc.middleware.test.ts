import { jwtVerify } from 'jose';
import { fetchUserInfo } from 'openid-client';
import { initOidc, validateBearerToken } from '../oidc.middleware';

const PRIMARY = 'https://auth.example.com/application/o/fluxhaus/';
const MOBILE = 'https://auth.example.com/application/o/mobile/';

vi.mock('openid-client', () => ({
  discovery: vi.fn().mockResolvedValue({
    serverMetadata: () => ({ issuer: 'https://auth.example.com/application/o/fluxhaus/', jwks_uri: 'https://auth.example.com/jwks/' }),
  }),
  ClientSecretPost: vi.fn(),
  fetchUserInfo: vi.fn(),
  skipSubjectCheck: Symbol('skip'),
}));

vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn().mockReturnValue({}),
  jwtVerify: vi.fn(),
}));

vi.mock('../../logger', () => ({
  __esModule: true,
  default: {
    child: () => ({
      debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn(),
    }),
  },
}));

vi.mock('../../audit', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../influx', () => ({ writePoint: vi.fn() }));

describe('validateBearerToken issuer', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.OIDC_ISSUER_URL = PRIMARY;
    process.env.OIDC_CLIENT_ID = 'client';
    process.env.OIDC_ADDITIONAL_ISSUERS = MOBILE;
    await initOidc();
  });

  afterEach(() => {
    delete process.env.OIDC_ISSUER_URL;
    delete process.env.OIDC_CLIENT_ID;
    delete process.env.OIDC_ADDITIONAL_ISSUERS;
  });

  it('returns the issuer that actually validated the token', async () => {
    (jwtVerify as vi.Mock).mockImplementation(async (_t, _k, opts: { issuer: string }) => {
      if (opts.issuer !== MOBILE) throw new Error('unexpected "iss" claim value');
      return { payload: { sub: 'user-1', email: 'u@example.com' } };
    });
    await expect(validateBearerToken('jwt')).resolves.toEqual({
      sub: 'user-1', email: 'u@example.com', preferred_username: undefined, issuer: MOBILE,
    });
  });

  it('attributes userinfo-validated opaque tokens to the primary issuer', async () => {
    (jwtVerify as vi.Mock).mockRejectedValue(new Error('not a jwt'));
    (fetchUserInfo as vi.Mock).mockResolvedValue({ sub: 'user-2' });
    const claims = await validateBearerToken('opaque');
    expect(claims?.sub).toBe('user-2');
    expect(claims?.issuer).toBe(PRIMARY);
  });
});
