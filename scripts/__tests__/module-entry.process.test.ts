/**
 * `invokedDirectly` in eval mode, and under a direct invocation.
 *
 * Under `node --input-type=module -e '<code>' <arg>`, `argv[1]` is the first
 * positional argument. `.github/workflows/internal-testflight.yml` imports
 * `ios-testflight-internal-authority.mjs` that way with the product version
 * (`1.2.3`) as the argument; that module imports `product-version.mjs`, whose
 * entry check calls `invokedDirectly`. A strict `realpathSync('1.2.3')`
 * threw ENOENT at import and crashed the step. In eval or print mode there is
 * no entry module, so the helper answers `false` without reading `argv[1]`.
 *
 * Outside eval mode it stays strict: a direct invocation whose `argv[1]` does
 * not resolve must throw, not skip `main()` and exit 0.
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { internalTestFlightBuild } from '../ios-testflight-internal-authority.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ENTRY_HELPER = fileURLToPath(
  new URL('../lib/module-entry.mjs', import.meta.url),
);
const CASE_TIMEOUT = 30_000;

const makeTempDir = trackTempDirs();

/** The workflow's own command shape, run from the repository root. */
function evalWithPositional(code: string, positional: string) {
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', code, positional],
    { cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true },
  );
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

const WORKFLOW_IMPORT =
  'import { internalTestFlightBuild } from "./scripts/ios-testflight-internal-authority.mjs"; process.stdout.write(internalTestFlightBuild({channel:"stable",version:process.argv[1]}));';

describe('invokedDirectly with a non-path argv[1]', () => {
  it('imports cleanly under `node -e` with a version as the positional argument (internal-testflight.yml)', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const { status, stdout, output } = evalWithPositional(
      WORKFLOW_IMPORT,
      '1.2.3',
    );
    expect(status, output).toBe(0);
    expect(stdout).toBe(
      String(internalTestFlightBuild({ channel: 'stable', version: '1.2.3' })),
    );
  });

  it('treats an argv[1] under a regular file (ENOTDIR) as not the entry', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const { status, stdout, output } = evalWithPositional(
      'import { PRODUCT_VERSION } from "./scripts/product-version.mjs"; process.stdout.write(String(PRODUCT_VERSION.test("1.2.3")));',
      'package.json/not-a-dir',
    );
    expect(status, output).toBe(0);
    expect(stdout).toBe('true');
  });

  it('treats print mode (`node -p`) as having no entry module', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const result = spawnSync(
      process.execPath,
      [
        '-p',
        'require("./scripts/product-version.mjs").PRODUCT_VERSION.test("1.2.3")',
        '1.2.3',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true },
    );
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout.trim()).toBe('true');
  });

  it('throws, rather than skipping main(), when a direct invocation has an argv[1] that does not exist', {
    timeout: CASE_TIMEOUT,
  }, () => {
    // A preload rewrites argv[1] before the entry script runs: the shape of a
    // loader that changes argv, or of a script deleted after load.
    const dir = makeTempDir('station-module-entry-direct-');
    const preload = join(dir, 'rewrite-argv.mjs');
    writeFileSync(
      preload,
      `process.argv[1] = ${JSON.stringify(join(dir, 'missing.mjs'))};\n`,
    );
    const script = join(dir, 'entry.mjs');
    writeFileSync(
      script,
      `import { invokedDirectly } from ${JSON.stringify(pathToFileURL(ENTRY_HELPER).href)};\nprocess.stdout.write(String(invokedDirectly(import.meta.url)));\n`,
    );
    const result = spawnSync(
      process.execPath,
      ['--import', pathToFileURL(preload).href, script],
      { encoding: 'utf8', windowsHide: true },
    );
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    expect(result.status, output).not.toBe(0);
    expect(output).toContain('ENOENT');
    expect(result.stdout).not.toBe('false');
  });
});
