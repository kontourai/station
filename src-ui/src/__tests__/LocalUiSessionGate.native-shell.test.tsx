/** @vitest-environment jsdom */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

describe('LocalUiSessionGate native shell boundary', () => {
  test('never probes tauri://localhost as though it were an HTTP Station', () => {
    const main = readFileSync(
      resolve(import.meta.dirname, '../main.tsx'),
      'utf8',
    );
    expect(main).toContain('profile.isTauri ?');
    expect(main).toContain('<PlatformSessionGate>');
    expect(main).not.toContain(
      '<LocalUiSessionGate apiBase={window.location.origin}>',
    );
  });

  test('waits for local access resolution before seeding web boot data', () => {
    const main = readFileSync(
      resolve(import.meta.dirname, '../main.tsx'),
      'utf8',
    );

    expect(main).not.toContain('hadBootstrapToken');
    // #2278 moved the boot fast path from main.tsx into the authority
    // provider's verified effect. The invariant survives the move: the
    // identity resolution happens first, seeding is gated on the
    // authenticated kind (and scope currency), and the seed follows both.
    const authority = readFileSync(
      resolve(import.meta.dirname, '../contexts/AuthorityQueryContext.tsx'),
      'utf8',
    );
    expect(authority).toContain(
      'const resolution = await resolveLocalUiSession(localUiApiBase);',
    );
    expect(authority).toContain("resolution.kind !== 'authenticated'");
    expect(authority).toContain('seedBootPayloadGuarded(');
    expect(
      authority.indexOf('const resolution = await resolveLocalUiSession'),
    ).toBeLessThan(authority.indexOf("resolution.kind !== 'authenticated'"));
    expect(
      authority.indexOf("resolution.kind !== 'authenticated'"),
    ).toBeLessThan(authority.indexOf('seedBootPayloadGuarded('));
  });
});
