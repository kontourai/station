/**
 * The type-laundering gate, run as a real child process from a checkout path
 * that contains a space.
 *
 * `verification:policy:gate` runs this gate in the required Windows portable
 * floor job. Its entry check used to compare `import.meta.url` with a URL
 * string built from `process.argv[1]`: `import.meta.url` percent-encodes a
 * space (and on Windows carries `file:///C:/...` where argv has `C:\...`), so
 * the comparison was false, `main()` never ran, and the gate exited 0 with no
 * output. The pure-function tests in `type-laundering-gate.test.ts` import the
 * scanner and never cross the entry check, so they could not see that.
 *
 * Both cases run in the same spaced directory. The known-bad case must exit 1
 * with the FAIL line; the clean control must print the PASS verdict, which a
 * gate whose `main()` never ran would not print either.
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';

const GATE = fileURLToPath(
  new URL('../type-laundering-gate.mjs', import.meta.url),
);
const ENTRY_HELPER = fileURLToPath(
  new URL('../lib/module-entry.mjs', import.meta.url),
);
const CASE_TIMEOUT = 30_000;

const makeTempDir = trackTempDirs();

/**
 * A checkout whose path contains a space, holding the production gate bytes,
 * the entry helper it imports, and one source file under a scanned root. The
 * gate scans `process.cwd()`, so the child runs with this checkout as cwd.
 *
 * The temp base is realpathed first: on macOS `tmpdir()` sits behind a
 * `/var` -> `/private/var` symlink, and without this a red here could come
 * from the symlink rather than the space.
 */
function spacedCheckout(source: string): string {
  const base = realpathSync(makeTempDir('station-type-laundering-entry-'));
  const checkout = join(base, 'checkout with space');
  mkdirSync(join(checkout, 'scripts', 'lib'), { recursive: true });
  copyFileSync(GATE, join(checkout, 'scripts', 'type-laundering-gate.mjs'));
  copyFileSync(
    ENTRY_HELPER,
    join(checkout, 'scripts', 'lib', 'module-entry.mjs'),
  );
  // The executed bytes must be production's, or reverting the real gate's
  // entry check would not reach this case.
  expect(
    readFileSync(join(checkout, 'scripts', 'type-laundering-gate.mjs'), 'utf8'),
  ).toBe(readFileSync(GATE, 'utf8'));
  mkdirSync(join(checkout, 'src-server'));
  writeFileSync(join(checkout, 'src-server', 'sample.ts'), source);
  return checkout;
}

function runGate(checkout: string) {
  const script = join(checkout, 'scripts', 'type-laundering-gate.mjs');
  expect(script).toContain(' ');
  const result = spawnSync(process.execPath, [script], {
    cwd: checkout,
    encoding: 'utf8',
    windowsHide: true,
    // The gate asks git for the upstream baseline; stop the lookup at the
    // temp base so a repository above $TMPDIR cannot supply one.
    env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(checkout) },
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

describe('type-laundering gate invoked from a path containing a space', () => {
  it('rejects a new `as any` cast (exit 1, FAIL line)', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const checkout = spacedCheckout('export const meta = payload as any;\n');
    const { status, output } = runGate(checkout);
    expect(output).toContain(
      'FAIL: type-laundering: as-any at src-server/sample.ts:1 is not in the baseline',
    );
    expect(output).toContain('[type-laundering] FAIL; findings=1 errors=1');
    expect(status, output).toBe(1);
  });

  it('passes a clean tree with a PASS verdict (exit 0) — the control', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const checkout = spacedCheckout('export const meta: unknown = payload;\n');
    const { status, output } = runGate(checkout);
    expect(output).not.toContain('FAIL:');
    expect(output).toContain('[type-laundering] PASS; findings=0 errors=0');
    expect(status, output).toBe(0);
  });
});
