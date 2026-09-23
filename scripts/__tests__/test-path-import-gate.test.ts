import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import { afterEach, describe, expect, test } from 'vitest';
import { SECURITY_CODEQL_CONFIG } from '../actionlint-gate.mjs';
import { PREPUSH_STATIC_GATES } from '../check-prepush-static-gates.mjs';
import { FAST_STATIC_COMMANDS } from '../run-ci-fast.mjs';
import {
  codeqlIgnoreGlobs,
  extractModuleSpecifiers,
  ignoredPathMatcher,
  isScannedProductFile,
  scanRepository,
} from '../test-path-import-gate.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const gatePath = join(repoRoot, 'scripts/test-path-import-gate.mjs');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { force: true, recursive: true });
});

/** A throwaway git repo: the gate scopes itself with `git ls-files`. */
function scratchRepo(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'station-test-path-import-'));
  roots.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  execFileSync('git', ['add', '-A'], { cwd: root, windowsHide: true });
  return root;
}

function runGate(root: string) {
  const result = spawnSync(process.execPath, [gatePath, '--root', root], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

describe('glob source', () => {
  test('the globs are exactly the CodeQL paths-ignore list', () => {
    const declared = (
      load(SECURITY_CODEQL_CONFIG) as { 'paths-ignore': string[] }
    )['paths-ignore'];
    expect(codeqlIgnoreGlobs()).toEqual(declared);
    expect(declared.length).toBeGreaterThan(0);
  });

  test('the gate restates none of the globs in its own source', () => {
    const source = readFileSync(gatePath, 'utf8');
    for (const glob of codeqlIgnoreGlobs()) expect(source).not.toContain(glob);
  });

  test('changing the CodeQL config changes what the guard reports', () => {
    const root = scratchRepo({
      'packages/sdk/src/product.ts': "import { x } from './foo.spec.ts';\n",
      'packages/sdk/src/foo.spec.ts': 'export const x = 1;\n',
    });
    expect(scanRepository(root).findings).toHaveLength(1);
    // The same tree under a config that no longer skips `*.spec.*`: the spec
    // file is now scanned product code, so importing it is not a violation.
    const narrowed = SECURITY_CODEQL_CONFIG.split('\n')
      .filter((line) => !line.includes('.spec.'))
      .join('\n');
    expect(narrowed).not.toBe(SECURITY_CODEQL_CONFIG);
    expect(scanRepository(root, { config: narrowed }).findings).toEqual([]);
  });

  test('refuses a config with nothing to guard rather than passing', () => {
    expect(() => codeqlIgnoreGlobs('paths-ignore: []\n')).toThrow(/refusing/);
    expect(() => codeqlIgnoreGlobs('{}\n')).toThrow(/refusing/);
  });
});

describe('scope and extraction', () => {
  const isIgnored = ignoredPathMatcher();

  test('test files are not product; test-named directories that are not ignored are', () => {
    expect(isScannedProductFile('src-ui/src/__tests__/a.ts', isIgnored)).toBe(
      false,
    );
    expect(isScannedProductFile('src-server/foo.test.ts', isIgnored)).toBe(
      false,
    );
    expect(
      isScannedProductFile('src-ui/src/testing-utils/a.ts', isIgnored),
    ).toBe(true);
    expect(isScannedProductFile('packages/sdk/src/index.ts', isIgnored)).toBe(
      true,
    );
    expect(
      isScannedProductFile('packages/sdk/scripts/build.mjs', isIgnored),
    ).toBe(false);
    expect(isScannedProductFile('src-ui/playwright.config.ts', isIgnored)).toBe(
      false,
    );
    expect(isScannedProductFile('tests/e2e/a.ts', isIgnored)).toBe(false);
  });

  test('extracts static, re-export, dynamic, require, import= and type-query forms', () => {
    const content = [
      "import a from './a';",
      "import type { B } from './b';",
      "export { c } from './c';",
      "export * from './d';",
      "const e = await import('./e');",
      "const f = require('./f');",
      "import g = require('./g');",
      "type H = typeof import('./h');",
      "// import z from './comment-only';",
    ].join('\n');
    expect(extractModuleSpecifiers(content).map((s) => s.specifier)).toEqual([
      './a',
      './b',
      './c',
      './d',
      './e',
      './f',
      './g',
      './h',
    ]);
  });
});

describe('gate as a child process', () => {
  test('known-bad: product code importing ../__tests__/x fails and names the line', () => {
    const root = scratchRepo({
      'src-ui/src/lib/product.ts':
        "export const ok = 1;\nimport { x } from '../__tests__/x';\n",
      'src-ui/src/__tests__/x.ts': 'export const x = 1;\n',
    });
    const { status, output } = runGate(root);
    expect(status).toBe(1);
    expect(output).toContain(
      "src-ui/src/lib/product.ts:2: '../__tests__/x' -> src-ui/src/__tests__/x.ts",
    );
  });

  test('known-bad: product code importing foo.spec.ts fails', () => {
    const root = scratchRepo({
      'packages/sdk/src/product.ts': "export { x } from './foo.spec.ts';\n",
      'packages/sdk/src/foo.spec.ts': 'export const x = 1;\n',
    });
    const { status, output } = runGate(root);
    expect(status).toBe(1);
    expect(output).toContain('packages/sdk/src/product.ts:1');
  });

  test('known-bad: .js specifiers, directory index, aliases and unresolved paths all resolve onto the ignored target', () => {
    const root = scratchRepo({
      'src-server/a.ts': "import { x } from './helper.test.js';\n",
      'src-server/helper.test.ts': 'export const x = 1;\n',
      'src-server/b.ts': "const m = await import('./fixtures/__tests__');\n",
      'src-server/fixtures/__tests__/index.ts': 'export const y = 1;\n',
      'src-ui/src/c.tsx': "import { z } from '@/__tests__/z';\n",
      'src-ui/src/__tests__/z.ts': 'export const z = 1;\n',
      'src-shared/d.ts': "const w = require('./gone.spec');\n",
      'src-ui/src/e.ts': "import type { T } from '../../tests/helpers/t';\n",
    });
    const { status, output } = runGate(root);
    expect(status).toBe(1);
    expect(output).toContain(
      "src-server/a.ts:1: './helper.test.js' -> src-server/helper.test.ts",
    );
    expect(output).toContain('-> src-server/fixtures/__tests__/index.ts');
    expect(output).toContain('-> src-ui/src/__tests__/z.ts');
    expect(output).toContain("src-shared/d.ts:1: './gone.spec'");
    expect(output).toContain("src-ui/src/e.ts:1: '../../tests/helpers/t'");
    expect(output).toContain('FAIL: 5 product import(s)');
  });

  test('false-positive control: test-to-test imports, testing-utils/ and exempt tooling pass', () => {
    const root = scratchRepo({
      'src-ui/src/__tests__/a.test.ts': "import { h } from './helpers';\n",
      'src-ui/src/__tests__/helpers.ts': 'export const h = 1;\n',
      'packages/sdk/src/b.spec.ts': "import { x } from './c.test';\n",
      'packages/sdk/src/c.test.ts': 'export const x = 1;\n',
      'src-ui/src/product.ts': "import { t } from './testing-utils/helper';\n",
      'src-ui/src/testing-utils/helper.ts': 'export const t = 1;\n',
      'src-server/latest-tests-summary.ts':
        "import { s } from './testsuite';\n",
      'src-server/testsuite.ts': 'export const s = 1;\n',
      'src-ui/playwright.config.ts':
        "import { m } from '../tests/e2e-manifest.mjs';\n",
      'tests/e2e-manifest.mjs': 'export const m = 1;\n',
    });
    const { status, output } = runGate(root);
    expect(output).toContain('OK: 4 product file(s) scanned');
    expect(status).toBe(0);
  });

  test('an empty scope fails rather than reporting a vacuous OK', () => {
    const root = scratchRepo({ 'README.md': '# nothing\n' });
    const { status, output } = runGate(root);
    expect(status).toBe(1);
    expect(output).toContain('no product files were found');
  });

  test('this repository has no violations', () => {
    const { status, output } = runGate(repoRoot);
    expect(output).toMatch(/OK: \d+ product file\(s\) scanned/);
    expect(status).toBe(0);
  });
});

describe('wiring', () => {
  const scripts = JSON.parse(
    readFileSync(join(repoRoot, 'package.json'), 'utf8'),
  ).scripts as Record<string, string>;
  const command = 'node scripts/test-path-import-gate.mjs';

  test('gate:workflows runs the gate, and ci:fast runs gate:workflows', () => {
    expect(
      scripts['gate:workflows'].split('&&').map((s) => s.trim()),
    ).toContain(command);
    expect(
      FAST_STATIC_COMMANDS.map((entry) => JSON.stringify(entry)),
    ).toContain(JSON.stringify(['npm', ['run', 'gate:workflows']]));
  });

  test('the pre-push static gates (and so gate:for) include it', () => {
    expect(PREPUSH_STATIC_GATES).toContain('test-path-import-gate');
  });

  test('the command gate:workflows names executes the gate in this repository', () => {
    const [bin, ...args] = command.split(' ');
    expect(bin).toBe('node');
    const result = spawnSync(process.execPath, args, {
      cwd: repoRoot,
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(result.stdout).toContain('Test-path import gate (#2333)');
    expect(result.status).toBe(0);
  });
});
