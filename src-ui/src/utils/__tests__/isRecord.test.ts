import { describe, expect, it } from 'vitest';
import { isPlainRecord, isRecord } from '../isRecord';

class Instance {
  field = 1;
}

describe('isRecord', () => {
  it('accepts any non-array object', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord(new Instance())).toBe(true);
    expect(isRecord(Object.create(null))).toBe(true);
  });

  it('rejects arrays, null and primitives', () => {
    for (const value of [[], null, undefined, 0, '', 'x', true]) {
      expect(isRecord(value)).toBe(false);
    }
  });
});

describe('isPlainRecord', () => {
  it('accepts an object whose prototype is Object.prototype', () => {
    expect(isPlainRecord({ a: 1 })).toBe(true);
    expect(isPlainRecord(JSON.parse('{"a":1}'))).toBe(true);
  });

  it('rejects class instances and null-prototype objects that isRecord accepts', () => {
    expect(isPlainRecord(new Instance())).toBe(false);
    expect(isPlainRecord(Object.create(null))).toBe(false);
    expect(isPlainRecord([])).toBe(false);
    expect(isPlainRecord(null)).toBe(false);
  });
});
