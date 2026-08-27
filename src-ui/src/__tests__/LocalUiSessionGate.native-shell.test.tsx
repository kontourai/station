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
    expect(main).toContain(
      'const resolution = await resolveLocalUiSession(localUiApiBase);',
    );
    expect(main).toContain("if (resolution.kind === 'authenticated') {");
    expect(main).toContain('await fetchAndSeedBootPayload(queryClient);');
    expect(
      main.indexOf('const resolution = await resolveLocalUiSession'),
    ).toBeLessThan(main.indexOf('await fetchAndSeedBootPayload(queryClient);'));
  });
});
