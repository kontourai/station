import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONFINEMENT_REFUSAL_CODES } from '../execution-confinement.js';
import { CONTINUATION_WORKSPACE_REFUSAL_CODES } from '../execution-target.js';
import {
  PROVIDER_FAILURE_KINDS,
  PROVIDER_FAILURE_RETRYABLE,
} from '../provider-failure.js';

// Discover the contract exports independently: adding a code must not silently
// inherit a classification or disappear from a test that only iterates the map.
const modules = await Promise.all(
  readdirSync(new URL('..', import.meta.url))
    .filter((name) => name.endsWith('.ts'))
    .map(async (name) => ({
      name,
      exports: await import(`../${name.slice(0, -3)}.ts`),
    })),
);

describe('provider failure wire contract', () => {
  it('classifies every exported diagnostic code, including other contract modules', () => {
    const codes = modules.flatMap(({ name, exports }) =>
      Object.entries(exports)
        .filter(
          ([symbol, value]) =>
            symbol.endsWith('_CODE') && typeof value === 'string',
        )
        .map(([symbol, value]) => ({
          module: name,
          symbol,
          code: value as string,
        })),
    );
    expect(codes.length).toBeGreaterThan(0);
    const mapping: Readonly<Record<string, string>> = PROVIDER_FAILURE_KINDS;
    for (const { module, symbol, code } of codes) {
      expect(
        mapping[code],
        `${module}:${symbol} (${code}) has no failure kind`,
      ).toBeDefined();
    }
    for (const code of [
      ...CONFINEMENT_REFUSAL_CODES,
      ...CONTINUATION_WORKSPACE_REFUSAL_CODES,
    ]) {
      expect(mapping[code], `${code} has no failure kind`).toBeDefined();
    }
  });

  it('requires changed input, authority, quota reset or inspection before those failures can be retried', () => {
    expect(PROVIDER_FAILURE_RETRYABLE).toMatchObject({
      auth: false,
      quota_exhausted: false,
      model_unavailable: false,
      provider_error: false,
      cancelled: false,
      input_unsupported: false,
      session_gone: false,
      permission_denied: false,
      conflict: false,
      indeterminate: false,
      busy: true,
      timeout: true,
      engine_crashed: true,
      unavailable: true,
      rate_limited: true,
    });
  });
});
