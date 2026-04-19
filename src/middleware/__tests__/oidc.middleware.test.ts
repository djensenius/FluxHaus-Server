import { normalizeIssuers } from '../oidc.middleware';

describe('normalizeIssuers', () => {
  it('adds trailing slash variant for issuer without one', () => {
    const result = normalizeIssuers([
      'https://auth.example.com/application/o/myapp',
    ]);
    expect(result).toEqual([
      'https://auth.example.com/application/o/myapp',
      'https://auth.example.com/application/o/myapp/',
    ]);
  });

  it('adds without-slash variant for issuer with trailing slash', () => {
    const result = normalizeIssuers([
      'https://auth.example.com/application/o/myapp/',
    ]);
    expect(result).toEqual([
      'https://auth.example.com/application/o/myapp/',
      'https://auth.example.com/application/o/myapp',
    ]);
  });

  it('preserves configured issuer first in order', () => {
    const withSlash = 'https://auth.example.com/o/app/';
    const result = normalizeIssuers([withSlash]);
    expect(result[0]).toBe(withSlash);
  });

  it('deduplicates when both variants are already present', () => {
    const result = normalizeIssuers([
      'https://auth.example.com/o/app/',
      'https://auth.example.com/o/app',
    ]);
    expect(result).toEqual([
      'https://auth.example.com/o/app/',
      'https://auth.example.com/o/app',
    ]);
    expect(result).toHaveLength(2);
  });

  it('handles multiple distinct issuers', () => {
    const result = normalizeIssuers([
      'https://auth.example.com/o/fluxhaus/',
      'https://auth.example.com/o/gt3-companion',
    ]);
    expect(result).toEqual([
      'https://auth.example.com/o/fluxhaus/',
      'https://auth.example.com/o/fluxhaus',
      'https://auth.example.com/o/gt3-companion',
      'https://auth.example.com/o/gt3-companion/',
    ]);
  });

  it('returns empty array for empty input', () => {
    expect(normalizeIssuers([])).toEqual([]);
  });

  it('rejects unrelated issuers (no false positives)', () => {
    const result = normalizeIssuers([
      'https://auth.example.com/o/myapp/',
    ]);
    expect(result).not.toContain('https://evil.example.com/o/myapp/');
    expect(result).not.toContain('https://auth.example.com/o/other/');
  });
});
