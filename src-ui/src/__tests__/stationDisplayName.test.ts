import { describe, expect, test } from 'vitest';
import { stationDisplayName } from '../hooks/useActiveStationName';

describe('stationDisplayName (#4402)', () => {
  test('the seeded "Default" connection reads as the machine it runs on', () => {
    expect(stationDisplayName('Default', 'desktop-win')).toBe('desktop-win');
  });

  test('a name the person chose is kept, even one equal to a machine name', () => {
    expect(stationDisplayName('Home server', 'desktop-win')).toBe(
      'Home server',
    );
    expect(stationDisplayName('default', 'desktop-win')).toBe('default');
  });

  test('without a known machine name the stored name stays', () => {
    expect(stationDisplayName('Default', undefined)).toBe('Default');
    // `resolveHostName`'s fallback is not a machine name.
    expect(stationDisplayName('Default', 'the host')).toBe('Default');
    expect(stationDisplayName(undefined, 'desktop-win')).toBeUndefined();
    expect(stationDisplayName('  ', 'desktop-win')).toBeUndefined();
  });
});
