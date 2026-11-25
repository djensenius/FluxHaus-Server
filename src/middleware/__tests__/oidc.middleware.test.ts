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

  const fakeJwt = (claims: Record<string, unknown>) => [
    Buffer.from('{"alg":"RS256"}').toString('base64url'),
    Buffer.from(JSON.stringify(claims)).toString('base64url'),
    'sig',
  ].join('.');

  it('labels a userinfo-validated JWT claiming the primary issuer with PRIMARY', async () => {
    (jwtVerify as vi.Mock).mockRejectedValue(new Error('signature mismatch'));
    (fetchUserInfo as vi.Mock).mockResolvedValue({ sub: 'user-2' });
    const claims = await validateBearerToken(fakeJwt({ iss: PRIMARY.replace(/\/$/, ''), sub: 'user-2' }));
    expect(claims?.sub).toBe('user-2');
    expect(claims?.issuer).toBe(PRIMARY);
  });

  it('leaves issuer undefined for a userinfo-validated JWT from a foreign issuer', async () => {
    (jwtVerify as vi.Mock).mockRejectedValue(new Error('unexpected "iss" claim value'));
    (fetchUserInfo as vi.Mock).mockResolvedValue({ sub: 'user-3' });
    const claims = await validateBearerToken(
      fakeJwt({ iss: 'https://auth.example.com/application/o/other/', sub: 'user-3' }),
    );
    expect(claims?.sub).toBe('user-3');
    expect(claims?.issuer).toBeUndefined();
  });

  it('leaves issuer undefined for opaque tokens accepted by userinfo', async () => {
    (jwtVerify as vi.Mock).mockRejectedValue(new Error('not a jwt'));
    (fetchUserInfo as vi.Mock).mockResolvedValue({ sub: 'user-4' });
    const claims = await validateBearerToken('opaque-token');
    expect(claims?.sub).toBe('user-4');
    expect(claims?.issuer).toBeUndefined();
  });
});
