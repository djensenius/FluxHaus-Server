import formatApplianceDisplayText from '../appliance-display';

describe('formatApplianceDisplayText', () => {
  it('humanizes identifiers while preserving mixed-case display names', () => {
    expect(formatApplianceDisplayText('main_wash')).toBe('Main Wash');
    expect(formatApplianceDisplayText('i-DOS')).toBe('i-DOS');
    expect(formatApplianceDisplayText('OFF')).toBe('Off');
  });
});
