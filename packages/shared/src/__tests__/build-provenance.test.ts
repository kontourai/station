import { describe, expect, test } from 'vitest';
import {
  formatArtifactBuildTimestamp,
  formatBuildAge,
} from '../build-provenance.js';

describe('artifact build timestamp presentation', () => {
  test('uses the immutable UTC artifact timestamp for exact date and age', () => {
    expect(
      formatArtifactBuildTimestamp('2026-08-30T12:34:56.000Z', {
        nowMs: Date.parse('2026-09-01T12:34:56.000Z'),
      }),
    ).toEqual({
      state: 'available',
      utc: '2026-08-30T12:34:56.000Z',
      date: 'Aug 30, 2026 12:34 UTC',
      age: '2 days ago',
      description:
        'Built Aug 30, 2026 12:34 UTC (2 days ago); canonical UTC timestamp 2026-08-30T12:34:56.000Z.',
    });
  });

  test('does not fabricate a timestamp for source or malformed artifacts', () => {
    expect(
      formatArtifactBuildTimestamp(undefined, { development: true }),
    ).toEqual({
      state: 'development',
      description: 'Development build; immutable build timestamp unavailable.',
    });
    expect(formatArtifactBuildTimestamp('2026-08-30T12:00:00')).toEqual({
      state: 'invalid',
      description: 'Build timestamp is invalid.',
    });
    expect(formatArtifactBuildTimestamp('2026-02-31T12:00:00.000Z')).toEqual({
      state: 'invalid',
      description: 'Build timestamp is invalid.',
    });
    expect(
      formatArtifactBuildTimestamp('2026-08-30T12:00:00.000Z', {
        nowMs: Number.NaN,
      }),
    ).toEqual({ state: 'invalid', description: 'Build timestamp is invalid.' });
  });

  test.each([
    [59, 'just now'],
    [60, '1 minute ago'],
    [3_600, '1 hour ago'],
    [86_400, '1 day ago'],
    [1_209_600, '2 weeks ago'],
  ])('formats %i seconds as %s', (seconds, expected) => {
    expect(formatBuildAge(seconds)).toBe(expected);
  });
});
