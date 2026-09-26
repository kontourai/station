/**
 * `invokedDirectly` when `process.argv[1]` is not a script path.
 *
 * Under `node --input-type=module -e '<code>' <arg>`, `argv[1]` is the first
 * positional argument. `.github/workflows/internal-testflight.yml` imports
 * `ios-testflight-internal-authority.mjs` that way with the product version
 * (`1.2.3`) as the argument; that module imports `product-version.mjs`, whose
 * entry check calls `invokedDirectly`. A strict `realpathSync('1.2.3')`
 * threw ENOENT at import and crashed the step. A path that does not exist
 * cannot be this module, so the helper answers `false`. Any other resolution
 * error must still throw.
 */
import { spawnSync } from 'node:child_process';
import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { internalTestFlightBuild } from '../ios-testflight-internal-authority.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
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

  // Symlink creation needs a privilege Windows runners may not grant.
  it.skipIf(process.platform === 'win32')(
    'still throws for a resolution error other than ENOENT/ENOTDIR (ELOOP)',
    { timeout: CASE_TIMEOUT },
    () => {
      const dir = makeTempDir('station-module-entry-eloop-');
      const loop = join(dir, 'loop');
      symlinkSync(loop, loop);
      const { status, output } = evalWithPositional(
        'import "./scripts/product-version.mjs";',
        loop,
      );
      expect(status).not.toBe(0);
      expect(output).toContain('ELOOP');
    },
  );
});
