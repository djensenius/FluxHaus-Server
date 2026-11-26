import {
  fluxBucketLiteral, safeEntityId, safeEnum, safeMacAddress, safePathSegment, safeTimestamp, UnsafeParameterError,
} from '../../clients/safe-params';

describe('safe-params', () => {
  it('accepts opaque IDs, names, and integers as path segments', () => {
    expect(safePathSegment('abc-123_DEF', 'id')).toBe('abc-123_DEF');
    expect(safePathSegment('my.repo', 'repo')).toBe('my.repo');
    expect(safePathSegment('6a1b2c3d-0000-4000-8000-000000000000', 'id')).toBe('6a1b2c3d-0000-4000-8000-000000000000');
    expect(safePathSegment(42, 'index')).toBe('42');
  });

  it.each([
    '..', '.', '.hidden', '../config', 'a/b', 'a?b=1', 'a#b', 'a&b', '%2e%2e', 'a%2Fb', 'a b', 'a"b', 'a\\b',
    'a\nb', 'a\tb', '', 'x'.repeat(300),
  ])('rejects unsafe path segment %j', (value) => {
    expect(() => safePathSegment(value, 'id')).toThrow(UnsafeParameterError);
  });

  it('rejects non-string, non-integer values', () => {
    expect(() => safePathSegment(1.5, 'id')).toThrow('Invalid id');
    expect(() => safePathSegment(undefined, 'id')).toThrow('Invalid id');
    expect(() => safePathSegment({}, 'id')).toThrow('Invalid id');
  });

  it('validates Home Assistant entity IDs, timestamps, MACs, and enums', () => {
    expect(safeEntityId('light.living_room')).toBe('light.living_room');
    expect(() => safeEntityId('../error_log')).toThrow('Invalid entity_id');
    expect(() => safeEntityId('light.x/../../config')).toThrow('Invalid entity_id');
    expect(() => safeEntityId('light.x?a=1')).toThrow('Invalid entity_id');
    expect(safeTimestamp('2026-01-01T00:00:00+05:00')).toBe('2026-01-01T00%3A00%3A00%2B05%3A00');
    expect(() => safeTimestamp('2026-01-01/../../states')).toThrow('Invalid timestamp');
    expect(() => safeTimestamp('../config')).toThrow('Invalid timestamp');
    expect(safeMacAddress('AA:BB:CC:DD:EE:FF')).toBe('aa:bb:cc:dd:ee:ff');
    expect(safeMacAddress('aabbccddeeff')).toBe('aabbccddeeff');
    expect(() => safeMacAddress('aa:bb:cc:dd:ee:ff/../../rest/user')).toThrow('Invalid MAC address');
    expect(safeEnum('open', ['open', 'closed'], 'state')).toBe('open');
    expect(() => safeEnum('open&type=x', ['open', 'closed'], 'state')).toThrow('Invalid state');
  });

  it('quotes safe InfluxDB bucket names and rejects Flux injection', () => {
    expect(fluxBucketLiteral('home_assistant')).toBe('"home_assistant"');
    expect(fluxBucketLiteral('_monitoring')).toBe('"_monitoring"');
    expect(fluxBucketLiteral('my bucket-1.v2')).toBe('"my bucket-1.v2"');
    [
      'x") |> yield() from(bucket: "other',
      'x\\" ',
      'x\nimport "http"',
      'x${token}',
      'x\u0000',
      '',
      '-leading',
    ].forEach((bucket) => expect(() => fluxBucketLiteral(bucket)).toThrow('Invalid bucket name'));
  });
});
