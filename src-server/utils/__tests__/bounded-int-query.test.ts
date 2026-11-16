import { describe, expect, test } from 'vitest';
import { boundedIntQuery } from '../bounded-int-query.js';

describe('boundedIntQuery', () => {
  const bounds = { min: 1, max: 100 };

  test('returns an in-range integer unchanged', () => {
    expect(boundedIntQuery('1', bounds)).toBe(1);
    expect(boundedIntQuery('42', bounds)).toBe(42);
    expect(boundedIntQuery('100', bounds)).toBe(100);
    expect(boundedIntQuery(' 7 ', bounds)).toBe(7);
    expect(boundedIntQuery('+7', bounds)).toBe(7);
  });

  test('clamps an out-of-range integer to the nearest bound', () => {
    expect(boundedIntQuery('0', bounds)).toBe(1);
    expect(boundedIntQuery('-5', bounds)).toBe(1);
    expect(boundedIntQuery('101', bounds)).toBe(100);
    expect(boundedIntQuery('9'.repeat(400), bounds)).toBe(100);
    expect(boundedIntQuery('-0', { min: 0, max: 10 })).toBe(0);
  });

  test('answers undefined for an absent or non-integer value, never NaN', () => {
    for (const value of [
      undefined,
      '',
      '   ',
      'abc',
      '10abc',
      '1.5',
      '1e2',
      '0x10',
      'NaN',
      'Infinity',
      '--5',
    ]) {
      expect(boundedIntQuery(value, bounds)).toBeUndefined();
    }
  });
});
