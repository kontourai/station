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

function run(
  files: Record<string, string>,
  links: ReadonlyArray<readonly [path: string, target: string]> = [],
) {
  const dir = scratchRepo({
    script: SCRIPT,
    productionFiles: [MANIFEST],
    files,
  });
  // The gate parses with the workspace's TypeScript API.
  symlinkSync(resolve('node_modules'), join(dir, 'node_modules'), 'dir');
  // Untracked on purpose: the gate must see a link before it is added.
  for (const [path, target] of links) symlinkSync(target, join(dir, path));
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

  it('rejects a symlink that would let a relative import leave the package', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const result = run(
      {
        ...CLEAN,
        'src-server/services/turn-idempotency.ts': 'export const s = 1;\n',
        [`${ROOT}/src/probe.ts`]:
          "export { s } from './station/turn-idempotency.js';\n",
      },
      [[`${ROOT}/src/station`, '../../../src-server/services']],
    );
    expect(result.status, result.output).toBe(1);
    expect(result.stderr).toContain(`symlink: ${ROOT}/src/station`);
  });

  it('rejects module loaders the import graph cannot see, and scans .d.ts', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const result = run({
      ...CLEAN,
      [`${ROOT}/src/types.d.ts`]:
        "export * from '@kontourai/station-contracts';\n",
      [`${ROOT}/src/loaders.ts`]: [
        "import { createRequire } from 'node:module';",
        "export const a = createRequire(import.meta.url)('@kontourai/station-shared');",
        "export const b = process.getBuiltinModule('node:module');",
        'const r = require;',
        "export const c = import.meta.resolve('@kontourai/station-sdk');",
        '',
      ].join('\n'),
    });
    expect(result.status, result.output).toBe(1);
    for (const line of [
      `station-import: ${ROOT}/src/types.d.ts:1 @kontourai/station-contracts`,
      `module-loader: ${ROOT}/src/loaders.ts:1 node:module`,
      `module-loader: ${ROOT}/src/loaders.ts:3 <getBuiltinModule>`,
      `module-loader: ${ROOT}/src/loaders.ts:4 <require reference>`,
      `module-loader: ${ROOT}/src/loaders.ts:5 <import.meta.resolve>`,
    ])
      expect(result.stderr).toContain(line);
  });

  it('rejects every spelling of the loaders that bypass the import graph', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const result = run({
      ...CLEAN,
      [`${ROOT}/src/spellings.ts`]: [
        "export const a = (process as any)['getBuiltinModule']('node:module');",
        'const { getBuiltinModule } = process;',
        "export const b = import.meta['resolve']('x');",
        "export const c = eval('1');",
        'export const d = (globalThis as any).createRequire;',
        '',
      ].join('\n'),
      [`${ROOT}/src/legacy.cts`]:
        "module.exports = module.require('@kontourai/station-shared');\n",
    });
    expect(result.status, result.output).toBe(1);
    for (const line of [
      `module-loader: ${ROOT}/src/spellings.ts:1 <getBuiltinModule>`,
      `module-loader: ${ROOT}/src/spellings.ts:2 <getBuiltinModule>`,
      `module-loader: ${ROOT}/src/spellings.ts:3 <import.meta.resolve>`,
      `module-loader: ${ROOT}/src/spellings.ts:4 <eval>`,
      `module-loader: ${ROOT}/src/spellings.ts:5 <createRequire>`,
      `commonjs-source: ${ROOT}/src/legacy.cts:1`,
    ])
      expect(result.stderr).toContain(line);
  });

  it('inspects git-ignored paths under the package too', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const result = run(
      {
        ...CLEAN,
        '.gitignore': 'dist/\n*.log\n',
        [`${ROOT}/src/dist/evil.ts`]:
          "export * from '@kontourai/station-shared';\n",
      },
      [[`${ROOT}/src/x.log`, '../../../src-server']],
    );
    expect(result.status, result.output).toBe(1);
    expect(result.stderr).toContain(
      `station-import: ${ROOT}/src/dist/evil.ts:1 @kontourai/station-shared`,
    );
    expect(result.stderr).toContain(`symlink: ${ROOT}/src/x.log`);
  });

  it('does not flag declarations that merely use the names (control)', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const result = run({
      ...CLEAN,
      [`${ROOT}/src/names.ts`]: [
        'export class C { require = true; get resolve() { return 1; } }',
        'export enum E { require = 1 }',
        'export function g(require: string, { resolve }: { resolve: number }) { return resolve; }',
        'export const o = { require: 1, resolve: Promise.resolve(1) };',
        '',
      ].join('\n'),
    });
    expect(result.status, result.output).toBe(0);
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
