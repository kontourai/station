import { describe, expect, test } from 'vitest';
import { errorMessage } from '../error-message.js';

describe('errorMessage', () => {
  test('answers an Error’s own message, not its stringification', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage(new TypeError('bad type'))).toBe('bad type');
    // `String(new Error('boom'))` is 'Error: boom' — the prefix the ternary
    // exists to avoid.
    expect(errorMessage(new Error('boom'))).not.toContain('Error:');
  });

  test('stringifies a thrown non-Error rather than dropping it', () => {
    expect(errorMessage('plain string')).toBe('plain string');
    expect(errorMessage(42)).toBe('42');
    expect(errorMessage(null)).toBe('null');
    expect(errorMessage(undefined)).toBe('undefined');
    expect(errorMessage({ code: 'EACCES' })).toBe('[object Object]');
  });

  test('keeps an empty Error message empty instead of substituting a label', () => {
    // The route seam's same-named helper answers 'Request failed' for values
    // this one renders verbatim; that difference is the reason both exist.
    expect(errorMessage(new Error(''))).toBe('');
  });
});
