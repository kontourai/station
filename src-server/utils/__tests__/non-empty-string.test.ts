import { describe, expect, test } from 'vitest';
import { isNonEmptyString } from '../non-empty-string.js';

describe('isNonEmptyString', () => {
  test('accepts a string carrying non-whitespace', () => {
    expect(isNonEmptyString('a')).toBe(true);
    expect(isNonEmptyString('  padded  ')).toBe(true);
  });

  test('refuses a blank string the same way it refuses an absent one', () => {
    expect(isNonEmptyString('')).toBe(false);
    expect(isNonEmptyString('   ')).toBe(false);
    expect(isNonEmptyString('\t\n ')).toBe(false);
    expect(isNonEmptyString(undefined)).toBe(false);
  });

  test('refuses non-strings, including values that stringify non-empty', () => {
    expect(isNonEmptyString(null)).toBe(false);
    expect(isNonEmptyString(0)).toBe(false);
    expect(isNonEmptyString(1)).toBe(false);
    expect(isNonEmptyString(['a'])).toBe(false);
    expect(isNonEmptyString({ toString: () => 'a' })).toBe(false);
  });
});
