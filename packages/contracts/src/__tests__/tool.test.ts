import { describe, expect, it } from 'vitest';
import { EXECUTION_MODE, normalizeExecutionMode } from '../tool.js';

describe('EXECUTION_MODE (Phase-B vocabulary rename)', () => {
  it('exposes the renamed canonical values', () => {
    expect(EXECUTION_MODE).toEqual({
      EXTERNAL: 'external',
      STATION: 'station',
    });
  });
});

describe('normalizeExecutionMode', () => {
  it.each([
    ['runtime', 'external'],
    ['provider-managed', 'station'],
    ['external', 'external'],
    ['station', 'station'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeExecutionMode(input)).toBe(expected);
  });

  it.each([undefined, null, '', 'junk', 42, {}])(
    'returns undefined for non-executionMode value %j',
    (value) => {
      expect(normalizeExecutionMode(value)).toBeUndefined();
    },
  );
});
