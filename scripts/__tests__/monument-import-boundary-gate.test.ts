/**
 * The monument import boundary, run as the child process CI runs, against a
 * scratch repository carrying the production gate bytes (#3565). Each
 * rejection is paired with the clean control, which is what binds a non-zero
 * exit to the planted import rather than to a malformed fixture.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scratchRepo } from './helpers/guardrail-scratch.js';

const SCRIPT = 'monument-import-boundary-gate.mjs';
const ROOT = 'packages/monument';
const CASE_TIMEOUT = 30_000;
const MANIFEST = `${ROOT}/package.json`;
const CLEAN = {
  // Files the package may hold besides source: the allowlist's control.
  [`${ROOT}/README.md`]: '# Monument\n',
  [`${ROOT}/LICENSE`]: 'Apache-2.0\n',
  [`${ROOT}/tsconfig.json`]: '{}\n',
  [`${ROOT}/tsconfig.build.json`]: '{}\n',
  [`${ROOT}/src/index.ts`]:
    "import { DatabaseSync } from 'node:sqlite';\nexport { local } from './local.js';\nexport type Db = DatabaseSync;\n",
  [`${ROOT}/src/local.ts`]: 'export const local = 1;\n',
  [`${ROOT}/src/__tests__/local.test.ts`]:
    "import { spawnSync } from 'node:child_process';\nimport { expect, it } from 'vitest';\nimport { local } from '../local.js';\nit('works', () => expect(local + (spawnSync ? 0 : 1)).toBe(1));\n",
};

function run(
  files: Record<string, string>,
  links: ReadonlyArray<readonly [path: string, target: string]> = [],
  after: (dir: string) => void = () => {},
) {
  const dir = scratchRepo({
    script: SCRIPT,
    productionFiles: [MANIFEST],
    files,
  });
  // The gate parses with the workspace's TypeScript API.
  symlinkSync(resolve('node_modules'), join(dir, 'node_modules'), 'dir');
  // Untracked on purpose: the gate must see a link before it is added.
  for (const [path, target] of links) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    symlinkSync(target, join(dir, path));
  }
  after(dir);
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
        'export class D { get require() { return 1; } set require(v: number) {} }',
        'const { require: r } = o; export { r };',
        '',
      ].join('\n'),
    });
    expect(result.status, result.output).toBe(0);
  });

  it('rejects the remaining routes out: node_modules, nested manifests and repositories, code loaders', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const result = run(
      {
        ...CLEAN,
        'packages/shared/src/index.ts': 'export const s = 1;\n',
        [`${ROOT}/src/through.ts`]:
          "export { s } from '../node_modules/@kontourai/station-shared/src/index.ts';\n",
        [`${ROOT}/src/cjs/package.json`]: '{"type":"commonjs"}\n',
        [`${ROOT}/src/cjs/legacy.js`]:
          "module.exports = module.require('@kontourai/station-shared');\n",
        [`${ROOT}/src/code.ts`]: [
          "export const f = new Function('return 1');",
          "import { runInThisContext } from 'node:vm';",
          "import { fork } from 'node:child_process';",
          "import { Worker } from 'node:worker_threads';",
          'export { runInThisContext, fork, Worker };',
          '',
        ].join('\n'),
      },
      [[`${ROOT}/node_modules/@kontourai/station-shared`, '../../../shared']],
      (dir) => {
        // An untracked nested repository: git lists only its directory.
        const vendor = join(dir, ROOT, 'src', 'vendor');
        mkdirSync(vendor, { recursive: true });
        execFileSync('git', ['init', '-q'], { cwd: vendor, windowsHide: true });
        writeFileSync(
          join(vendor, 'hidden.ts'),
          "export * from '@kontourai/station-shared';\n",
        );
      },
    );
    expect(result.status, result.output).toBe(1);
    for (const line of [
      `escapes-package: ${ROOT}/src/through.ts:1 ../node_modules/@kontourai/station-shared/src/index.ts`,
      `nested-manifest: ${ROOT}/src/cjs/package.json:1`,
      `module-loader: ${ROOT}/src/cjs/legacy.js:1 <member require>`,
      `module-loader: ${ROOT}/src/code.ts:1 <Function>`,
      `module-loader: ${ROOT}/src/code.ts:2 node:vm`,
      `module-loader: ${ROOT}/src/code.ts:3 node:child_process`,
      `module-loader: ${ROOT}/src/code.ts:4 node:worker_threads`,
      `unscanned-directory: ${ROOT}/src/vendor/`,
    ])
      expect(result.stderr).toContain(line);
  });

  it('rejects declaring a Station package as a dependency', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const manifest = JSON.parse(
      readFileSync(
        new URL('../../packages/monument/package.json', import.meta.url),
        'utf8',
      ),
    );
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

  it('resolves relative specifiers as Node does: no percent-encoding or backslashes', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const result = run({
      ...CLEAN,
      'src-server/secret.mjs': 'export const secret = 1;\n',
      [`${ROOT}/src/encoded.ts`]: [
        "export * from './%2e%2e/%2e%2e/%2e%2e/src-server/secret.mjs';",
        "export * from '.\\\\..\\\\..\\\\..\\\\src-server\\\\secret.mjs';",
        "export * from './local%2ejs';",
        '',
      ].join('\n'),
    });
    expect(result.status, result.output).toBe(1);
    for (const line of [
      `encoded-specifier: ${ROOT}/src/encoded.ts:1 ./%2e%2e/%2e%2e/%2e%2e/src-server/secret.mjs`,
      `encoded-specifier: ${ROOT}/src/encoded.ts:2`,
      `encoded-specifier: ${ROOT}/src/encoded.ts:3 ./local%2ejs`,
    ])
      expect(result.stderr).toContain(line);
  });

  it('refuses every dependency entry, aliased or not', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const manifest = JSON.parse(
      readFileSync(
        new URL('../../packages/monument/package.json', import.meta.url),
        'utf8',
      ),
    );
    const result = run({
      ...CLEAN,
      [MANIFEST]: JSON.stringify({
        ...manifest,
        dependencies: {
          innocent: 'workspace:@kontourai/station-shared@*',
          a: 'npm:@kontourai/station-sdk@1',
          b: 'file:../shared',
          c: 'link:../sdk',
          'left-pad': '1.3.0',
        },
        bin: { monument: './bin.js' },
        scripts: { postinstall: 'node ./x.js', test: 'vitest' },
        peerDependencies: { d: 'portal:../cli' },
      }),
      [`${ROOT}/src/aliased.ts`]: "export * from 'innocent';\n",
    });
    expect(result.status, result.output).toBe(1);
    for (const line of [
      `aliased-dependency: ${MANIFEST}:1 dependencies.innocent`,
      `aliased-dependency: ${MANIFEST}:1 dependencies.a`,
      `aliased-dependency: ${MANIFEST}:1 dependencies.b`,
      `aliased-dependency: ${MANIFEST}:1 dependencies.c`,
      `aliased-dependency: ${MANIFEST}:1 peerDependencies.d`,
      `unapproved-dependency: ${MANIFEST}:1 dependencies.left-pad`,
      `undeclared-import: ${ROOT}/src/aliased.ts:1 innocent`,
      `manifest-hook: ${MANIFEST}:1 bin`,
      `manifest-hook: ${MANIFEST}:1 scripts.postinstall`,
    ])
      expect(result.stderr).toContain(line);
  });

  it('refuses Station code that reaches past the package entry points', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const result = run({
      ...CLEAN,
      'src-server/uses-entry.ts': [
        "import { openMemoryKernelStorage } from '@kontourai/monument';",
        "import { openSqliteKernelStorage } from '@kontourai/monument/sqlite';",
        'export { openMemoryKernelStorage, openSqliteKernelStorage };',
        '',
      ].join('\n'),
      'src-server/uses-internals.ts': [
        "export * from '../packages/monument/src/step.js';",
        "export * from '@kontourai/monument/src/step';",
        "export * from '@kontourai/monument/package.json';",
        '',
      ].join('\n'),
    });
    expect(result.status, result.output).toBe(1);
    for (const line of [
      'monument-internal-import: src-server/uses-internals.ts:1 ../packages/monument/src/step.js',
      'monument-internal-import: src-server/uses-internals.ts:2 @kontourai/monument/src/step',
      'monument-internal-import: src-server/uses-internals.ts:3 @kontourai/monument/package.json',
    ])
      expect(result.stderr).toContain(line);
    expect(result.stderr).not.toContain('uses-entry.ts');
  });

  it('refuses a file whose type is not on the allowlist (an extensionless module)', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const result = run({
      ...CLEAN,
      'src-server/zz-target.mjs': 'export const target = 1;\n',
      [`${ROOT}/src/helper`]: "import '../../../src-server/zz-target.mjs';\n",
      [`${ROOT}/src/helper.d.ts`]: 'export {};\n',
      [`${ROOT}/src/zz.ts`]: "import './helper';\n",
      [`${ROOT}/src/data.json`]: '{}\n',
    });
    expect(result.status, result.output).toBe(1);
    expect(result.stderr).toContain(`unexpected-file: ${ROOT}/src/helper `);
    expect(result.stderr).toContain(`unexpected-file: ${ROOT}/src/data.json`);
  });

  it('refuses Station-side routes into the package however they are spelled', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const result = run(
      {
        ...CLEAN,
        'src-server/percent.ts':
          "export * from '../packages/monu%6dent/src/index.ts';\n",
        'src-server/escaped.ts':
          "export * from '../packages/\\u006donument/src/index.ts';\n",
        'src-server/cased.ts':
          "export * from '../packages/Monument/src/index.ts';\n",
        'src-server/linked.ts': "export * from './link/index.ts';\n",
        'src-server/modules.ts':
          "export * from '../node_modules/@kontourai/monument/src/index.ts';\n",
        'src-server/dynamic.ts':
          "// The package is named in code, so an unreadable reference is refused.\nconst label = '@kontourai/monument parts';\nexport const m = import(label);\n",
        [`${ROOT}/src/upper.ts`]:
          "export * from './NODE_MODULES/@kontourai/station-shared/index.js';\n",
      },
      [['src-server/link', '../packages/monument/src']],
      // Station depends on the package now, so an installed checkout has
      // `node_modules/@kontourai/monument` linked to the workspace directory.
      // The scratch repository's node_modules is the real one, whose link
      // leads out of the scratch tree; give it the link an install of the
      // scratch tree would make, or the route resolves outside the package.
      (dir) => {
        const modules = join(dir, 'node_modules');
        rmSync(modules);
        mkdirSync(join(modules, '@kontourai'), { recursive: true });
        symlinkSync(
          join(resolve('node_modules'), 'typescript-api'),
          join(modules, 'typescript-api'),
          'dir',
        );
        symlinkSync(
          `../../${ROOT}`,
          join(modules, '@kontourai', 'monument'),
          'dir',
        );
      },
    );
    expect(result.status, result.output).toBe(1);
    for (const line of [
      'monument-internal-import: src-server/percent.ts:1',
      'monument-internal-import: src-server/escaped.ts:1',
      'monument-internal-import: src-server/cased.ts:1',
      'monument-symlink: src-server/link',
      'monument-internal-import: src-server/modules.ts:1',
      'monument-unverifiable-import: src-server/dynamic.ts:3',
      `escapes-package: ${ROOT}/src/upper.ts:1`,
    ])
      expect(result.stderr).toContain(line);
  });

  it('refuses a relative import of anything but source, and Markdown below the root', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const result = run({
      ...CLEAN,
      [`${ROOT}/src/notes.md`]: '# notes\n',
      [`${ROOT}/src/loads.ts`]:
        "import '../LICENSE';\nimport './notes.md';\nimport '../README.md';\n",
    });
    expect(result.status, result.output).toBe(1);
    for (const line of [
      `non-source-import: ${ROOT}/src/loads.ts:1 ../LICENSE`,
      `non-source-import: ${ROOT}/src/loads.ts:2 ./notes.md`,
      `non-source-import: ${ROOT}/src/loads.ts:3 ../README.md`,
      `unexpected-file: ${ROOT}/src/notes.md`,
    ])
      expect(result.stderr).toContain(line);
  });

  it('refuses path strings into the package in Station files, not only imports', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const result = run({
      ...CLEAN,
      'src-server/strings.ts': [
        "import { vi } from 'vitest';",
        "export const a = await vi.importActual('../packages/monument/src/step.ts');",
        "import { createRequire } from 'node:module'; const req = createRequire(import.meta.url); export const b = req('../packages/monument/src/local.ts');",
        "export const w = new URL('../packages/monument/src/worker.ts', import.meta.url);",
        "export const m = '@kontourai/monument/src/step';",
        "export const manifest = new URL('../packages/monument/package.json', import.meta.url);",
        "export const entry = '@kontourai/monument/sqlite';",
        '',
      ].join('\n'),
      'src-server/bad.ts': "export * from '../packages/monument/%zz.ts';\n",
    });
    expect(result.status, result.output).toBe(1);
    for (const line of [
      'monument-internal-reference: src-server/strings.ts:2 ../packages/monument/src/step.ts',
      'monument-internal-reference: src-server/strings.ts:3 ../packages/monument/src/local.ts',
      'monument-internal-reference: src-server/strings.ts:4 ../packages/monument/src/worker.ts',
      'monument-internal-reference: src-server/strings.ts:5 @kontourai/monument/src/step',
      'encoded-specifier: src-server/bad.ts:1',
    ])
      expect(result.stderr).toContain(line);
    expect(result.stderr).not.toContain('src-server/strings.ts:6');
    expect(result.stderr).not.toContain('src-server/strings.ts:7');
  });

  it('refuses package.json imports and tsconfig paths that alias into the package', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const result = run({
      ...CLEAN,
      'package.json': JSON.stringify({
        name: 'root',
        imports: {
          '#k/*': './packages/monument/src/*',
          '#cond': { node: './packages/monument/src/local.ts' },
          '#ok': './packages/monument/src/index.ts',
        },
      }),
      'tsconfig.json':
        '{\n  // comments are allowed here\n  "compilerOptions": { "paths": { "k/*": ["./packages/monument/src/*"], "ok": ["./packages/monument/src/index.ts"] } }\n}\n',
      'src-server/tsconfig.test.json': JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: { 'm/*': ['../packages/monument/src/*'] },
        },
      }),
    });
    expect(result.status, result.output).toBe(1);
    for (const line of [
      'monument-alias: package.json:1 imports.#k/*',
      'monument-alias: package.json:1 imports.#cond',
      'monument-alias: tsconfig.json:1 compilerOptions.paths.k/*',
      'monument-alias: src-server/tsconfig.test.json:1 compilerOptions.paths.m/*',
    ])
      expect(result.stderr).toContain(line);
    expect(result.stderr).not.toContain('imports.#ok');
    expect(result.stderr).not.toContain('paths.ok');
  });

  it('does not refuse a file that mentions the package only in a comment (control)', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const result = run({
      ...CLEAN,
      'src-server/comment.ts':
        "// Later this will use the Monument kernel.\nconst name = 'x';\nexport const m = import(name);\n",
    });
    expect(result.status, result.output).toBe(0);
  });

  it('alias-scans every tsconfig and jsconfig, and resolves bare paths targets against baseUrl', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const result = run({
      ...CLEAN,
      'scripts/capture.tsconfig.json': JSON.stringify({
        compilerOptions: { paths: { 'x/*': ['../packages/monument/src/*'] } },
      }),
      'jsconfig.json': JSON.stringify({
        compilerOptions: { paths: { 'j/*': ['./packages/monument/src/*'] } },
      }),
      'config/tsconfig.base.json': JSON.stringify({
        compilerOptions: {
          baseUrl: '..',
          paths: { '@kontourai/monument/*': ['packages/monument/src/*'] },
        },
      }),
      'config/tsconfig.nobase.json': JSON.stringify({
        compilerOptions: { paths: { 'n/*': ['../packages/monument/src/*'] } },
      }),
    });
    expect(result.status, result.output).toBe(1);
    for (const line of [
      'monument-alias: scripts/capture.tsconfig.json:1 compilerOptions.paths.x/*',
      'monument-alias: jsconfig.json:1 compilerOptions.paths.j/*',
      'monument-alias: config/tsconfig.base.json:1 compilerOptions.paths.@kontourai/monument/*',
      'monument-alias: config/tsconfig.nobase.json:1 compilerOptions.paths.n/*',
    ])
      expect(result.stderr).toContain(line);
  });

  it('counts a template literal as naming the package', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const result = run({
      ...CLEAN,
      // The fixture's source text holds a template literal with a substitution.
      'src-server/template.ts':
        "const name = 'step';\nexport const m = import(`../packages/monument/src/$" +
        '{name}.ts`);\n',
    });
    expect(result.status, result.output).toBe(1);
    expect(result.stderr).toContain(
      'monument-unverifiable-import: src-server/template.ts:2',
    );
  });

  it('resolves repo-relative strings in path.resolve/join calls and vite or vitest configs', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const result = run({
      ...CLEAN,
      'src-server/paths.ts': [
        "import path from 'node:path';",
        "export const p = path.resolve(__dirname, '..', 'packages/monument/src');",
        "export const q = path.join(process.cwd(), 'packages/monument/src/step.ts');",
        "export const listed = ['packages/monument/src/__tests__/x.test.ts'];",
        '',
      ].join('\n'),
      'vitest.config.ts':
        "export default { resolve: { alias: { k: 'packages/monument/src/step.ts' } } };\n",
    });
    expect(result.status, result.output).toBe(1);
    for (const line of [
      'monument-internal-reference: src-server/paths.ts:2 packages/monument/src',
      'monument-internal-reference: src-server/paths.ts:3 packages/monument/src/step.ts',
      'monument-internal-reference: vitest.config.ts:1 packages/monument/src/step.ts',
    ])
      expect(result.stderr).toContain(line);
    // A plain list entry is not a path the file loads.
    expect(result.stderr).not.toContain('src-server/paths.ts:4');
  });

  it('refuses a glob into the package, as a string or in an array', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const result = run({
      ...CLEAN,
      'src-server/glob.ts': [
        "export const a = import.meta.glob('../packages/monument/src/*.ts');",
        "export const b = import.meta.glob(['../packages/monument/src/**/*.ts']);",
        "export const c = import.meta.glob('../packages/other/*.ts');",
        // Undecodable only after its first '*': the fixed prefix still decodes.
        "export const d = import.meta.glob('../packages/monument/src/*/100%.ts');",
        '',
      ].join('\n'),
    });
    expect(result.status, result.output).toBe(1);
    for (const line of [
      'monument-internal-reference: src-server/glob.ts:1 ../packages/monument/src/*.ts',
      'monument-internal-reference: src-server/glob.ts:2 ../packages/monument/src/**/*.ts',
      'monument-internal-reference: src-server/glob.ts:4 ../packages/monument/src/*/100%.ts',
    ])
      expect(result.stderr).toContain(line);
    expect(result.stderr).not.toContain('src-server/glob.ts:3');
  });

  it('does not fail ordinary strings in a file that names the package (controls)', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const result = run({
      ...CLEAN,
      'src-server/gate-name.ts':
        "export const script = 'monument-import-boundary:gate';\nconst n = 'x';\nexport const m = import(n);\n",
      'src-server/ordinary.ts': [
        "export const entry = '@kontourai/monument';",
        "export const coverage = '/coverage/100%';",
        "export const format = './%s.json';",
        "export const readme = new URL('../packages/monument/README.md', import.meta.url);",
        "export const context = new URL('../packages/monument/CONTEXT.md', import.meta.url);",
        "export const licence = new URL('../packages/monument/LICENSE', import.meta.url);",
        "export const index = '../packages/monument/src/index.ts';",
        "export const aliases = { '@kontourai/monument/*': ['x'], glob: 'packages/monument/src/**' };",
        '',
      ].join('\n'),
    });
    expect(result.status, result.output).toBe(0);
  });

  it('refuses an empty scope rather than reporting it clean', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const result = run({ 'packages/other/src/index.ts': 'export {};\n' });
    expect(result.status, result.output).toBe(1);
    expect(result.stderr).toContain('found no source files');
  });
});
