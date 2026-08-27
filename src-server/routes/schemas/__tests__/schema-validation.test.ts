import { describe, expect, test } from 'vitest';
import { errorMessage } from '../schema-validation.js';

describe('schema-validation helpers', () => {
  test('errorMessage sanitizes Error instances', () => {
    expect(
      errorMessage(
        new Error(
          'engine stderr https://provider.example.test/private?token=secret',
        ),
      ),
    ).toBe('engine stderr [REDACTED_URL]');
  });

  test('errorMessage refuses to coerce non-Error values', () => {
    expect(errorMessage({ code: 'E_FAIL' })).toBe('Request failed');
  });
});
