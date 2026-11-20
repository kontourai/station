import { describe, expect, it } from 'vitest';
import { parseEpochMs } from '../parseEpochMs';

describe('parseEpochMs', () => {
  it('reads an ISO stamp as epoch milliseconds', () => {
    expect(parseEpochMs('2026-10-01T17:32:00.000Z')).toBe(
      Date.UTC(2026, 9, 1, 17, 32),
    );
  });

  it('is undefined for an absent or unparseable stamp', () => {
    expect(parseEpochMs(undefined)).toBeUndefined();
    expect(parseEpochMs(null)).toBeUndefined();
    expect(parseEpochMs('')).toBeUndefined();
    expect(parseEpochMs('not a date')).toBeUndefined();
  });
});
