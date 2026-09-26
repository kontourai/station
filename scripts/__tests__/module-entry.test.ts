/**
 * `invokedDirectly` against real `node` entry points (#2682).
 *
 * The bug it closes is only visible across a process boundary: Node
 * realpaths and percent-encodes `import.meta.url` for the entry module while
 * `argv[1]` stays the path as given. So each case copies the real helper and
 * a probe script that uses it into a temp directory whose path has a space,
 * a `%`, or a symlink in it, runs the probe with `node`, and asserts its body
 * RAN — the probe prints a marker and exits 3, so a silent exit 0 is a
 * failure. A second probe with the hand-rolled guard that was on main runs
 * alongside it and must NOT reach its body on the same path, which proves
 * each fixture actually exercises the failure.
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { invokedDirectly } from '../lib/module-entry.mjs';

const HELPER = resolve(import.meta.dirname, '../lib/module-entry.mjs');
const MARKER = 'ENTRY-BODY-RAN';
const makeTempDir = trackTempDirs();
/**
 * The OS temp dir is itself behind a symlink on macOS (/var -> /private/var),
 * so each case starts from its real path: the space and `%` cases then differ
 * from the entry path only by encoding, and the symlink cases only by the
 * link they create.
 */
const realTempDir = () => realpathSync(makeTempDir('station-entry-'));

const PROBE = [
  "import { invokedDirectly } from './lib/module-entry.mjs';",
  'if (invokedDirectly(import.meta.url)) {',
  `  console.log('${MARKER}');`,
  '  process.exitCode = 3;',
  '}',
  '',
].join('\n');
// The guard 32 scripts used on main before #2682.
const RAW_PROBE = [
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the source text of a bad guard, not a template
  'if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {',
  `  console.log('${MARKER}');`,
  '  process.exitCode = 3;',
  '}',
  '',
].join('\n');

/** A scripts/ directory under `root` holding both probes and the real helper. */
function installProbes(root: string): string {
  const scripts = join(root, 'scripts');
  mkdirSync(join(scripts, 'lib'), { recursive: true });
  copyFileSync(HELPER, join(scripts, 'lib', 'module-entry.mjs'));
  writeFileSync(join(scripts, 'probe.mjs'), PROBE);
  writeFileSync(join(scripts, 'raw-probe.mjs'), RAW_PROBE);
  return scripts;
}

function run(entry: string) {
  const result = spawnSync(process.execPath, [entry], {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  });
  expect(result.error, entry).toBeUndefined();
  return result;
}

function expectBodyRan(entry: string) {
  const result = run(entry);
  expect({ status: result.status, stderr: result.stderr }, entry).toEqual({
    status: 3,
    stderr: '',
  });
  expect(result.stdout.trim(), entry).toBe(MARKER);
}

function expectRawGuardSkipped(entry: string) {
  const result = run(entry);
  expect(result.status, entry).toBe(0);
  expect(result.stdout, entry).toBe('');
}

describe('invokedDirectly from a real node entry point (#2682)', () => {
  test('runs the body from a directory whose name has a space', () => {
    const scripts = installProbes(join(realTempDir(), 'space probe'));
    expectBodyRan(join(scripts, 'probe.mjs'));
    expectRawGuardSkipped(join(scripts, 'raw-probe.mjs'));
  });

  test('runs the body from a directory whose name has a percent sign', () => {
    const scripts = installProbes(join(realTempDir(), '100%probe'));
    expectBodyRan(join(scripts, 'probe.mjs'));
    expectRawGuardSkipped(join(scripts, 'raw-probe.mjs'));
  });

  test.skipIf(process.platform === 'win32')(
    'runs the body when the checkout is reached through a symlinked directory',
    () => {
      const base = realTempDir();
      const real = join(base, 'real-checkout');
      installProbes(real);
      const link = join(base, 'linked-checkout');
      symlinkSync(real, link, 'dir');
      expectBodyRan(join(link, 'scripts', 'probe.mjs'));
      expectRawGuardSkipped(join(link, 'scripts', 'raw-probe.mjs'));
    },
  );

  test.skipIf(process.platform === 'win32')(
    'runs the body when the script itself is a symlink',
    () => {
      const base = realTempDir();
      const scripts = installProbes(join(base, 'checkout'));
      const link = join(base, 'probe-link.mjs');
      symlinkSync(join(scripts, 'probe.mjs'), link);
      expectBodyRan(link);
    },
  );

  test('does not run the body when another entry point imports the module', () => {
    const scripts = installProbes(
      join(makeTempDir('station-entry-'), 'space probe'),
    );
    const importer = join(scripts, 'importer.mjs');
    writeFileSync(
      importer,
      `await import(${JSON.stringify(pathToFileURL(join(scripts, 'probe.mjs')).href)});\nconsole.log('imported');\n`,
    );
    const result = run(importer);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('imported');
  });

  test('does not run the body, or throw, when imported with no argv[1] (node -e)', () => {
    const scripts = installProbes(realTempDir());
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `await import(${JSON.stringify(pathToFileURL(join(scripts, 'probe.mjs')).href)}); console.log('imported');`,
      ],
      { encoding: 'utf8', timeout: 30_000, windowsHide: true },
    );
    expect({ status: result.status, stderr: result.stderr }).toEqual({
      status: 0,
      stderr: '',
    });
    expect(result.stdout.trim()).toBe('imported');
  });
});

describe('invokedDirectly decisions', () => {
  test('is false with no entry path, or one that names no file', () => {
    const here = pathToFileURL(HELPER).href;
    expect(invokedDirectly(here, undefined)).toBe(false);
    expect(invokedDirectly(here, '')).toBe(false);
    expect(
      invokedDirectly(here, join(makeTempDir('station-entry-'), 'nope.mjs')),
    ).toBe(false);
    // ENOTDIR: a path "inside" a regular file.
    expect(invokedDirectly(here, join(HELPER, 'child.mjs'))).toBe(false);
  });

  test('is false for a different existing file, true for the same one', () => {
    const here = pathToFileURL(HELPER).href;
    expect(invokedDirectly(here, import.meta.filename)).toBe(false);
    expect(invokedDirectly(here, HELPER)).toBe(true);
    expect(invokedDirectly(here, realpathSync(HELPER))).toBe(true);
  });

  test.skipIf(process.platform === 'win32')(
    'throws, rather than reading "imported", when the entry path cannot be resolved',
    () => {
      const base = makeTempDir('station-entry-');
      symlinkSync(join(base, 'b'), join(base, 'a'));
      symlinkSync(join(base, 'a'), join(base, 'b'));
      expect(() =>
        invokedDirectly(pathToFileURL(HELPER).href, join(base, 'a')),
      ).toThrow(/ELOOP/);
    },
  );
});
