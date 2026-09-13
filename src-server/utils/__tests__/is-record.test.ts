import { describe, expect, test } from 'vitest';
import { isRecord } from '../is-record.js';

describe('isRecord', () => {
  test('accepts objects that carry named fields', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord(Object.create(null))).toBe(true);
    expect(isRecord(new Date())).toBe(true);
  });

  test('rejects arrays, which `typeof` alone reports as objects', () => {
    // The condition the consolidated copies would silently lose: an array
    // reaching a field read answers `undefined` instead of being refused.
    expect(isRecord([])).toBe(false);
    expect(isRecord([{ a: 1 }])).toBe(false);
    expect(typeof []).toBe('object');
  });

  test('rejects null and every non-object primitive', () => {
    expect(isRecord(null)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
    expect(isRecord(0)).toBe(false);
    expect(isRecord('')).toBe(false);
    expect(isRecord('{}')).toBe(false);
    expect(isRecord(false)).toBe(false);
    expect(isRecord(() => {})).toBe(false);
  });
});
