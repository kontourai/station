import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('SDK package Vitest discovery', () => {
  it('includes TypeScript component tests as well as non-JSX tests', () => {
    const configSource = readFileSync(
      new URL('../../vitest.config.ts', import.meta.url),
      'utf8',
    );
    expect(configSource).toContain(
      "include: ['src/__tests__/**/*.test.{ts,tsx}']",
    );
  });
});
