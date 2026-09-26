/**
 * `invokedDirectly(import.meta)` under every way these scripts are started.
 *
 * Each earlier entry check rebuilt the answer from `process.argv[1]` and was
 * wrong for some invocation shape: a space or a Windows path (URL strings), a
 * symlink, `node -e … <arg>` or stdin (realpath), a worker (`execArgv`
 * sniffing). The helper now returns Node's own `import.meta.main`. These cases
 * run each shape as a real child process, because the answer depends on how
 * Node started the process and nothing in-process can fake that.
 *
 * - Imported by an eval, print, or stdin program with a positional argument:
 *   `.github/workflows/internal-testflight.yml` imports
 *   `ios-testflight-internal-authority.mjs` (which imports the converted
 *   `product-version.mjs`) under `-e` with `1.2.3` as the argument. The import
 *   must not crash, and must not run `main()`.
 * - Started directly from a path with a space or through a symlink: `main()`
 *   must run.
 * - A worker's entry module, started from an eval parent: `main()` must run.
 * - A Node without `import.meta.main`: the helper throws rather than
 *   answering `false`.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { internalTestFlightBuild } from '../ios-testflight-internal-authority.mjs';
import { invokedDirectly } from '../lib/module-entry.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ENTRY_HELPER = fileURLToPath(
  new URL('../lib/module-entry.mjs', import.meta.url),
);
const PRODUCT_VERSION_GATE = fileURLToPath(
  new URL('../product-version.mjs', import.meta.url),
);
const CASE_TIMEOUT = 30_000;

const makeTempDir = trackTempDirs();

function run(args: string[], options: { input?: string; cwd?: string } = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: options.cwd ?? REPO_ROOT,
    encoding: 'utf8',
    windowsHide: true,
    ...(options.input === undefined ? {} : { input: options.input }),
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

/** A script that prints what the helper answers for itself. */
function probeScript(dir: string): string {
  const script = join(dir, 'entry.mjs');
  writeFileSync(
    script,
    `import { invokedDirectly } from ${JSON.stringify(pathToFileURL(ENTRY_HELPER).href)};\nprocess.stdout.write(String(invokedDirectly(import.meta)));\n`,
  );
  return script;
}

describe('imported by an eval, print, or stdin program with a positional argument', () => {
  it('`node --input-type=module -e` (internal-testflight.yml) imports cleanly', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const { status, stdout, output } = run([
      '--input-type=module',
      '-e',
      'import { internalTestFlightBuild } from "./scripts/ios-testflight-internal-authority.mjs"; process.stdout.write(internalTestFlightBuild({channel:"stable",version:process.argv[1]}));',
      '1.2.3',
    ]);
    expect(status, output).toBe(0);
    expect(stdout).toBe(
      String(internalTestFlightBuild({ channel: 'stable', version: '1.2.3' })),
    );
  });

  it('`node -p` imports cleanly', { timeout: CASE_TIMEOUT }, () => {
    const { status, stdout, output } = run([
      '-p',
      'require("./scripts/product-version.mjs").PRODUCT_VERSION.test("1.2.3")',
      '1.2.3',
    ]);
    expect(status, output).toBe(0);
    expect(stdout.trim()).toBe('true');
  });

  it('stdin (`node -`) imports cleanly and does not run main()', {
    timeout: CASE_TIMEOUT,
  }, () => {
    // `--check` as the positional: were main() to run, it would read it and
    // print the product-version verdict.
    const { status, stdout, output } = run(
      ['--input-type=module', '-', '--check'],
      {
        input:
          'import "./scripts/product-version.mjs"; process.stdout.write("imported");',
      },
    );
    expect(status, output).toBe(0);
    expect(stdout).toBe('imported');
  });
});

describe('started directly', () => {
  it('from a path containing a space', { timeout: CASE_TIMEOUT }, () => {
    const dir = join(makeTempDir('station-module-entry-'), 'with space');
    mkdirSync(dir);
    const { status, stdout, output } = run([probeScript(dir)]);
    expect(status, output).toBe(0);
    expect(stdout).toBe('true');
  });

  // Symlink creation needs a privilege Windows runners may not grant.
  it.skipIf(process.platform === 'win32')(
    'through a symlinked directory',
    { timeout: CASE_TIMEOUT },
    () => {
      const base = makeTempDir('station-module-entry-link-');
      const real = join(base, 'real');
      mkdirSync(real);
      probeScript(real);
      const link = join(base, 'link');
      symlinkSync(real, link, 'dir');
      const { status, stdout, output } = run([join(link, 'entry.mjs')]);
      expect(status, output).toBe(0);
      expect(stdout).toBe('true');
    },
  );

  it("as a worker's entry module, from an eval parent, runs main()", {
    timeout: CASE_TIMEOUT,
  }, () => {
    // The parent is itself `-e` with a positional argument, which workers
    // inherit in `execArgv`; the gate must still see itself as the entry.
    // CommonJS eval, because a worker would also inherit `--input-type` and
    // Node refuses that for a file entry.
    const { status, stdout, output } = run([
      '-e',
      `const { Worker } = require("node:worker_threads"); const worker = new Worker(new URL(${JSON.stringify(pathToFileURL(PRODUCT_VERSION_GATE).href)}), { argv: ["--check"] }); worker.on("exit", (code) => { process.exitCode = code; });`,
      '1.2.3',
    ]);
    expect(status, output).toBe(0);
    expect(stdout).toMatch(/Product version \S+ is synchronized\./);
  });
});

describe('a Node without import.meta.main', () => {
  it.each([
    ['an import.meta with no main', {}],
    ['main undefined', { main: undefined }],
    ['a URL string (the stale call shape)', 'file:///x.mjs'],
  ])('throws for %s instead of answering false', (_name, importMeta) => {
    expect(() => invokedDirectly(importMeta)).toThrow(
      /import\.meta\.main is \w+, not a boolean/,
    );
  });
});
