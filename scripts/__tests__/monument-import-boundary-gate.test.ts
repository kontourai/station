/**
 * The monument import boundary, run as the child process CI runs, against a
 * scratch repository carrying the production gate bytes (#3565). Each
 * rejection is paired with the clean control, which is what binds a non-zero
 * exit to the planted import rather than to a malformed fixture.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scratchRepo } from './helpers/guardrail-scratch.js';

const SCRIPT = 'monument-import-boundary-gate.mjs';
const ROOT = 'packages/monument';
const CASE_TIMEOUT = 30_000;
const MANIFEST = `${ROOT}/package.json`;
const CLEAN = {
  [`${ROOT}/src/index.ts`]:
    "import { DatabaseSync } from 'node:sqlite';\nexport { local } from './local.js';\nexport type Db = DatabaseSync;\n",
  [`${ROOT}/src/local.ts`]: 'export const local = 1;\n',
  [`${ROOT}/src/__tests__/local.test.ts`]:
    "import { expect, it } from 'vitest';\nimport { local } from '../local.js';\nit('works', () => expect(local).toBe(1));\n",
};

function run(files: Record<string, string>) {
  const dir = scratchRepo({
    script: SCRIPT,
    productionFiles: [MANIFEST],
    files,
  });
  // The gate parses with the workspace's TypeScript API.
  symlinkSync(resolve('node_modules'), join(dir, 'node_modules'), 'dir');
  const result = spawnSync(process.execPath, [join('scripts', SCRIPT)], {
    cwd: dir,
    encoding: 'utf8',
    windowsHide: true,
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { status: result.status, stdout, stderr, output: stdout + stderr };
}

describe('monument import boundary gate', () => {
  it('accepts node: builtins, package-local modules and vitest in tests (control)', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const result = run(CLEAN);
    expect(result.status, result.output).toBe(0);
    expect(result.stdout).toContain('OK: monument import boundary: 3 source');
  });

  it('rejects an import of @kontourai/station-contracts', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const result = run({
      ...CLEAN,
      [`${ROOT}/src/evil.ts`]:
        "import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';\nexport type E = CanonicalRuntimeEvent;\n",
    });
    expect(result.status, result.output).toBe(1);
    expect(result.stderr).toContain('FAIL: monument import boundary');
    expect(result.stderr).toContain(
      `station-import: ${ROOT}/src/evil.ts:1 @kontourai/station-contracts/runtime-events`,
    );
  });

  it('rejects every other way of reaching Station or an undeclared module', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const result = run({
      ...CLEAN,
      [`${ROOT}/src/evil.ts`]: [
        "export * from '@kontourai/station-shared';",
        "const later = () => import('@kontourai/station');",
        "import { x } from '../../../src-server/services/turn-idempotency.js';",
        "import { readFileSync } from 'fs';",
        "import { thing } from '@/alias';",
        "type T = import('@kontourai/station-sdk').Thing;",
        "const name = 'x'; const dyn = require(name);",
        "import { it } from 'vitest';",
        '',
      ].join('\n'),
    });
    expect(result.status, result.output).toBe(1);
    for (const line of [
      `station-import: ${ROOT}/src/evil.ts:1 @kontourai/station-shared`,
      `station-import: ${ROOT}/src/evil.ts:2 @kontourai/station`,
      `escapes-package: ${ROOT}/src/evil.ts:3 ../../../src-server/services/turn-idempotency.js`,
      `undeclared-import: ${ROOT}/src/evil.ts:4 fs`,
      `undeclared-import: ${ROOT}/src/evil.ts:5 @/alias`,
      `station-import: ${ROOT}/src/evil.ts:6 @kontourai/station-sdk`,
      `unverifiable-import: ${ROOT}/src/evil.ts:7 <non-constant require>`,
      // vitest is allowed in test files only.
      `undeclared-import: ${ROOT}/src/evil.ts:8 vitest`,
    ])
      expect(result.stderr).toContain(line);
  });

  it('rejects declaring a Station package as a dependency', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
    const result = run({
      ...CLEAN,
      [MANIFEST]: JSON.stringify({
        ...manifest,
        dependencies: { '@kontourai/station-contracts': 'workspace:*' },
      }),
      [`${ROOT}/src/evil.ts`]:
        "export * from '@kontourai/station-contracts';\n",
    });
    expect(result.status, result.output).toBe(1);
    expect(result.stderr).toContain(
      `station-dependency: ${MANIFEST}:1 dependencies.@kontourai/station-contracts`,
    );
    // Declaring it does not make the import legal.
    expect(result.stderr).toContain(
      `station-import: ${ROOT}/src/evil.ts:1 @kontourai/station-contracts`,
    );
  });

  it('refuses an empty scope rather than reporting it clean', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const result = run({ 'packages/other/src/index.ts': 'export {};\n' });
    expect(result.status, result.output).toBe(1);
    expect(result.stderr).toContain('found no source files');
  });
});
