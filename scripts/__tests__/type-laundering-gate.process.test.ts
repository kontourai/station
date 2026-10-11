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
import { sanitizedGitEnvironment } from '../lib/git-environment.mjs';
import { fingerprintFor } from '../type-laundering-gate.mjs';

const GATE = fileURLToPath(
  new URL('../type-laundering-gate.mjs', import.meta.url),
);
const ENTRY_HELPER = fileURLToPath(
  new URL('../lib/module-entry.mjs', import.meta.url),
);
const GIT_REF_HELPER = fileURLToPath(
  new URL('../lib/git-ref.mjs', import.meta.url),
);
const CAPTURE_HELPER = fileURLToPath(
  new URL('../lib/bounded-capture.mjs', import.meta.url),
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
  copyFileSync(GIT_REF_HELPER, join(checkout, 'scripts', 'lib', 'git-ref.mjs'));
  copyFileSync(
    CAPTURE_HELPER,
    join(checkout, 'scripts', 'lib', 'bounded-capture.mjs'),
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
    // Below the case timeout, so a hung gate surfaces as a spawn error.
    timeout: CASE_TIMEOUT - 5_000,
    windowsHide: true,
    // The gate asks git for the upstream baseline; stop the lookup at the
    // temp base so a repository above $TMPDIR cannot supply one.
    env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(checkout) },
  });
  expect(result.error).toBeUndefined();
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

/**
 * #3101 slice F: "a baseline entry may only shrink" is judged against the
 * baseline this branch started from (its merge base with origin/main), not
 * origin/main's tip. Main fixing a cast and dropping its entry must not fail
 * an unmerged branch that still carries both; a branch that adds an entry
 * must still fail. Real git, real gate process.
 */
describe('type-laundering baseline growth is judged against the merge base', () => {
  const castA = 'export const a = payload as any;';
  const castB = 'export const b = payload as any;';
  const castC = 'export const c = payload as any;';
  const entry = (file: string, line: string) => ({
    file,
    rule: 'as-any',
    fingerprint: fingerprintFor('as-any', line),
    reason: 'legacy-cast',
  });

  function repo() {
    const checkout = spacedCheckout(`${castA}\n`);
    const env = {
      ...sanitizedGitEnvironment(process.env),
      GIT_CEILING_DIRECTORIES: dirname(checkout),
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    };
    const git = (...args: string[]) => {
      const result = spawnSync('git', args, {
        cwd: checkout,
        env,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10_000,
      });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    const write = (files: Record<string, string>, entries: object[]) => {
      for (const [file, text] of Object.entries(files))
        writeFileSync(join(checkout, 'src-server', file), text);
      writeFileSync(
        join(checkout, 'scripts', 'type-laundering-baseline.json'),
        `${JSON.stringify({ version: 1, entries }, null, 2)}\n`,
      );
      git('add', '-A');
      git('commit', '-qm', 'step');
      return git('rev-parse', 'HEAD');
    };
    git('init', '-q', '-b', 'main');
    // Merge base: two legacy casts, both baselined.
    const base = write({ 'sample.ts': `${castA}\n`, 'b.ts': `${castB}\n` }, [
      entry('src-server/sample.ts', castA),
      entry('src-server/b.ts', castB),
    ]);
    // Main moves on: it fixes b.ts and drops that entry.
    const mainTip = write({ 'b.ts': 'export const b = payload;\n' }, [
      entry('src-server/sample.ts', castA),
    ]);
    git('update-ref', 'refs/remotes/origin/main', mainTip);
    git('checkout', '-q', '-b', 'feat', base);
    return { checkout, git, write };
  }

  it('passes a branch that still carries an entry main has since removed', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const { checkout, write } = repo();
    write({ 'unrelated.ts': 'export const u = 1;\n' }, [
      entry('src-server/sample.ts', castA),
      entry('src-server/b.ts', castB),
    ]);
    const { status, output } = runGate(checkout);
    expect(output).not.toContain('baseline entry cannot be added');
    expect(output).toContain('[type-laundering] PASS');
    expect(status, output).toBe(0);
  });

  it('still refuses a branch that adds a baseline entry (exit 1)', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const { checkout, write } = repo();
    write({ 'c.ts': `${castC}\n` }, [
      entry('src-server/sample.ts', castA),
      entry('src-server/b.ts', castB),
      entry('src-server/c.ts', castC),
    ]);
    const { status, output } = runGate(checkout);
    expect(output).toContain(
      'baseline entry cannot be added: src-server/c.ts (as-any)',
    );
    expect(status, output).toBe(1);
  });
});
