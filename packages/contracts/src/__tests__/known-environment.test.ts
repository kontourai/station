import { describe, expect, test } from 'vitest';
import { KNOWN_ENVIRONMENT_SCHEMA_VERSION } from '../known-environment.js';

describe('known-environment contracts', () => {
  test('fixes the schema version', () => {
    expect(KNOWN_ENVIRONMENT_SCHEMA_VERSION).toBe(1);
  });
});
