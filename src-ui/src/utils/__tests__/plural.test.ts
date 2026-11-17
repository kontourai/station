import { describe, expect, it } from 'vitest';
import { plural } from '../plural';

describe('plural', () => {
  it('pairs a count with its noun, singular only for exactly one', () => {
    expect(plural(0, 'check')).toBe('0 checks');
    expect(plural(1, 'check')).toBe('1 check');
    expect(plural(3, 'document')).toBe('3 documents');
  });
});
