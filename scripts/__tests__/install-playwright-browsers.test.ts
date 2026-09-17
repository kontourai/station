import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  classifyPlaywrightInstallFailure,
  DEFAULT_INSTALL_ATTEMPTS,
  runPlaywrightInstallWithRetry,
  validateInstallBrowsers,
  WITH_DEPS_FLAG,
} from '../install-playwright-browsers.mjs';

const script = resolve(
  import.meta.dirname,
  '../install-playwright-browsers.mjs',
);

/**
 * station#1648 measured this exact text on run 33970282053, job
 * 101317443813 — the only `ci-extended` run in the history, whose three
 * identical attempts are the regression these tests pin.
 */
const SUDO_FAILURE = [
  'Installing dependencies...',
  'Switching to root user to install dependencies...',
  'sudo: a terminal is required to read the password; either use the -S option to read from standard input or configure an askpass helper',
  'sudo: a password is required',
  'Failed to install browsers',
  'Error: Installation process exited with code: 1',
].join('\n');

describe('classifyPlaywrightInstallFailure', () => {
  test('calls the measured fleet failure permanent', () => {
    expect(classifyPlaywrightInstallFailure(SUDO_FAILURE)).toMatchObject({
      classification: 'permanent',
      cause:
        'the installer needed root and this runner has no passwordless sudo',
    });
  });

  test('names a place for every permanent cause', () => {
    for (const output of [
      SUDO_FAILURE,
      'npm error could not determine executable to run',
      'Error: EACCES: permission denied, mkdir',
      'Error: ENOSPC: no space left on device',
      'Error: Unknown browser: sausage',
    ]) {
      const verdict = classifyPlaywrightInstallFailure(output);
      expect(verdict.classification, output).toBe('permanent');
      // A remedy that names no PLACE sends the reader to repair the tree they
      // happen to be standing in.
      expect(verdict.place, output).toBeTruthy();
    }
  });

  test('retries genuine download flakes', () => {
    for (const output of [
      'Error: read ECONNRESET',
      'Error: socket hang up',
      'Download failed: size mismatch',
      'failed to download chromium, status code 503',
    ])
      expect(
        classifyPlaywrightInstallFailure(output).classification,
        output,
      ).toBe('transient');
  });

  test('does not claim transience for an unrecognised cause', () => {
    expect(
      classifyPlaywrightInstallFailure('something nobody has seen before')
        .classification,
    ).toBe('unclassified');
  });

  test('treats a wedged attempt the bound killed as transient', () => {
    expect(
      classifyPlaywrightInstallFailure('', { timedOut: true }).classification,
    ).toBe('transient');
  });

  // `Switching to root user` is printed on the happy path too, so it must not
  // be what classifies anything — otherwise a genuinely transient apt failure
  // after a successful sudo would be called permanent and lose its retry.
  test('a timed-out apt step is still transient, root switch notwithstanding', () => {
    expect(
      classifyPlaywrightInstallFailure(
        'Switching to root user to install dependencies...\nGet:1 http://archive.ubuntu.com',
        { timedOut: true },
      ).classification,
    ).toBe('transient');
  });

  // The other direction: a permanent cause already printed before the bound
  // fired is still the truth about that attempt.
  test('a permanent cause outranks the timeout that killed it', () => {
    expect(
      classifyPlaywrightInstallFailure(SUDO_FAILURE, { timedOut: true })
        .classification,
    ).toBe('permanent');
  });
});

describe('validateInstallBrowsers', () => {
  test('defaults to chromium', () => {
    expect(validateInstallBrowsers([])).toEqual({
      ok: true,
      browsers: ['chromium'],
    });
  });

  test('accepts the real browser names', () => {
    expect(
      validateInstallBrowsers(['chromium', 'firefox', 'webkit', 'msedge']).ok,
    ).toBe(true);
  });

  test(`refuses ${WITH_DEPS_FLAG} and names the runner image`, () => {
    const verdict = validateInstallBrowsers(['chromium', WITH_DEPS_FLAG]);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.message).toContain('RUNNER IMAGE');
    expect(verdict.message).toContain('no passwordless sudo');
  });

  test('refuses every other flag, so none can be smuggled through', () => {
    for (const flag of ['--force', '-h', '--with-deps=true', '--dry-run'])
      expect(validateInstallBrowsers([flag]).ok, flag).toBe(false);
  });
});

describe('runPlaywrightInstallWithRetry', () => {
  function harness(
    results: { exitCode: number; output?: string; timedOut?: boolean }[],
  ) {
    const calls: { args: string[] }[] = [];
    const lines: string[] = [];
    const slept: number[] = [];
    return {
      calls,
      lines,
      slept,
      run: (overrides = {}) =>
        runPlaywrightInstallWithRetry({
          browsers: ['chromium'],
          execute: async ({ args }: { args: string[] }) => {
            calls.push({ args });
            const result = results[calls.length - 1];
            if (!result) throw new Error('unexpected extra install attempt');
            return { output: '', timedOut: false, ...result };
          },
          sleep: async (ms: number) => {
            slept.push(ms);
          },
          log: (line: string) => lines.push(line),
          ...overrides,
        }),
    };
  }

  test('never passes --with-deps to the installer', async () => {
    const h = harness([{ exitCode: 0 }]);
    await h.run();
    expect(h.calls[0].args).toEqual([
      '--no',
      'playwright',
      'install',
      'chromium',
    ]);
    expect(h.calls[0].args).not.toContain(WITH_DEPS_FLAG);
  });

  // The regression itself: the measured failure burned all three attempts and
  // called a permanent condition retryable.
  test('spends one attempt, not three, on the measured fleet failure', async () => {
    const h = harness([{ exitCode: 1, output: SUDO_FAILURE }]);
    const result = await h.run();

    expect(h.calls).toHaveLength(1);
    expect(h.slept).toEqual([]);
    expect(result).toMatchObject({
      ok: false,
      attempts: 1,
      classification: 'permanent',
      exitCode: 1,
    });
    const error = h.lines.find((line) => line.startsWith('::error::'));
    expect(error).toContain('failed permanently on attempt 1/3');
    expect(error).toContain('Retrying cannot clear this');
    expect(error).toContain('RUNNER IMAGE of the self-hosted host');
    // Nothing may describe this permanent condition as retryable.
    expect(h.lines.filter((line) => line.startsWith('::warning::'))).toEqual(
      [],
    );
  });

  test('retries a transient failure and reports the attempt it succeeded on', async () => {
    const h = harness([
      { exitCode: 1, output: 'Error: read ECONNRESET' },
      { exitCode: 1, output: 'Download failed: size mismatch' },
      { exitCode: 0 },
    ]);
    const result = await h.run();

    expect(h.calls).toHaveLength(3);
    expect(h.slept).toHaveLength(2);
    expect(result).toMatchObject({ ok: true, attempts: 3 });
    expect(
      h.lines.filter((line) => line.includes('transient failure')),
    ).toHaveLength(2);
  });

  test('exhausts the budget on a persistently transient failure', async () => {
    const h = harness(
      Array.from({ length: DEFAULT_INSTALL_ATTEMPTS }, () => ({
        exitCode: 1,
        output: 'Error: read ECONNRESET',
      })),
    );
    const result = await h.run();

    expect(h.calls).toHaveLength(DEFAULT_INSTALL_ATTEMPTS);
    expect(result).toMatchObject({
      ok: false,
      classification: 'transient-exhausted',
      exitCode: 1,
    });
  });

  test('retries an unrecognised failure but calls it unrecognised, not transient', async () => {
    const h = harness([
      { exitCode: 1, output: 'a cause nobody has classified' },
      { exitCode: 0 },
    ]);
    await h.run();

    const warning = h.lines.find((line) => line.startsWith('::warning::'));
    expect(warning).toContain('unrecognised reason');
    expect(warning).toContain('in case it is transient');
    expect(warning).not.toMatch(/hit a transient failure/);
  });

  test('refuses --with-deps without spawning anything', async () => {
    const h = harness([]);
    const result = await h.run({ browsers: ['chromium', WITH_DEPS_FLAG] });

    expect(h.calls).toEqual([]);
    expect(result).toMatchObject({
      ok: false,
      attempts: 0,
      classification: 'refused',
      exitCode: 1,
    });
  });

  test('rejects an out-of-range attempt budget', async () => {
    await expect(
      runPlaywrightInstallWithRetry({ maxAttempts: 0 }),
    ).rejects.toThrow(/attempts must be an integer from 1 through 5/);
    await expect(
      runPlaywrightInstallWithRetry({ maxAttempts: 6 }),
    ).rejects.toThrow(/attempts must be an integer from 1 through 5/);
  });
});

// The exit status and the argv are the two things only a real run can prove:
// this script sets `process.exitCode` rather than calling `process.exit()`,
// and nothing above would notice if that stopped exiting non-zero.
//
// The seam is a fake `npx` earlier on PATH — no test-only hook exists in the
// script itself, so these cases exercise the argv it really builds. That
// needs an executable shell shim, which win32 resolves differently (.cmd),
// so the real-process cases are POSIX-only; every branch they cover is also
// covered cross-platform by the injected-`execute` cases above.
describe.skipIf(process.platform === 'win32')('as a real process', () => {
  function fakeNpx(plan: { exitCode: number; output?: string }[]) {
    const dir = mkdtempSync(join(tmpdir(), 'station-playwright-install-'));
    const planPath = join(dir, 'plan.json');
    const argvLog = join(dir, 'argv.log');
    const runner = join(dir, 'npx-fake.mjs');
    writeFileSync(planPath, JSON.stringify(plan));
    writeFileSync(
      runner,
      [
        "import { appendFileSync, readFileSync, writeSync } from 'node:fs';",
        `const plan = JSON.parse(readFileSync(${JSON.stringify(planPath)}, 'utf8'));`,
        `appendFileSync(${JSON.stringify(argvLog)}, process.argv.slice(2).join(' ') + '\\n');`,
        `const attempt = readFileSync(${JSON.stringify(argvLog)}, 'utf8').trim().split('\\n').length;`,
        'const step = plan[attempt - 1] ?? plan.at(-1);',
        // `writeSync`, not `process.stderr.write`: an async write followed by
        // `process.exit` truncates whatever has not reached the pipe yet, so
        // the overflow case below silently delivered ~64KB instead of 300KB
        // and never exercised the cap it names.
        'if (step.output) writeSync(2, step.output + "\\n");',
        'process.exit(step.exitCode);',
      ].join('\n'),
    );
    const shim = join(dir, 'npx');
    writeFileSync(
      shim,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(runner)} "$@"\n`,
    );
    chmodSync(shim, 0o755);
    return {
      dir,
      attempts: () => {
        try {
          return readFileSync(argvLog, 'utf8')
            .trim()
            .split('\n')
            .filter(Boolean);
        } catch {
          return [];
        }
      },
    };
  }

  function runScript(args: string[], fake: { dir: string }) {
    return spawnSync(process.execPath, [script, ...args], {
      encoding: 'utf8',
      windowsHide: true,
      env: {
        ...process.env,
        PATH: `${fake.dir}${delimiter}${process.env.PATH ?? ''}`,
      },
    });
  }

  test('exits 0 and asks the installer for chromium and nothing else', () => {
    const fake = fakeNpx([{ exitCode: 0 }]);
    const result = runScript(['chromium'], fake);

    expect(result.status).toBe(0);
    expect(fake.attempts()).toEqual(['--no playwright install chromium']);
  });

  test('exits non-zero after ONE attempt on the measured fleet failure', () => {
    const fake = fakeNpx([{ exitCode: 1, output: SUDO_FAILURE }]);
    const result = runScript(['chromium'], fake);

    expect(result.status).toBe(1);
    // Three attempts here is the bug; one is the fix.
    expect(fake.attempts()).toHaveLength(1);
    expect(result.stdout).toContain('failed permanently on attempt 1/3');
    expect(result.stdout).toContain('RUNNER IMAGE of the self-hosted host');
  });

  test('exits non-zero and spawns nothing when handed --with-deps', () => {
    const fake = fakeNpx([{ exitCode: 0 }]);
    const result = runScript(['chromium', WITH_DEPS_FLAG], fake);

    expect(result.status).toBe(1);
    expect(fake.attempts()).toEqual([]);
    expect(result.stdout).toContain('RUNNER IMAGE');
  });

  // A chatty install that then fails permanently must still be classified as
  // permanent. Retaining a bounded PREFIX is what makes that true: replacing
  // the capture with a placeholder on overflow would report the failure as
  // unrecognised and retry it three times — the defect being removed here.
  test('classifies a permanent failure buried under an overflowing capture', () => {
    const fake = fakeNpx([
      {
        exitCode: 1,
        output: `${SUDO_FAILURE}\n${'apt noise '.repeat(30_000)}`,
      },
    ]);
    const result = runScript(['chromium'], fake);

    expect(result.status).toBe(1);
    expect(fake.attempts()).toHaveLength(1);
    expect(result.stdout).toContain('failed permanently on attempt 1/3');
    // Non-vacuity: the capture really did overflow, so this case exercises
    // the truncation path rather than passing because the output fit.
    expect(result.stdout).toContain('capture=truncated');
  });

  test('names the job, not the runner image, when the CLI is absent', () => {
    const fake = fakeNpx([
      {
        exitCode: 1,
        output: 'npm error could not determine executable to run',
      },
    ]);
    const result = runScript(['chromium'], fake);

    expect(result.status).toBe(1);
    expect(fake.attempts()).toHaveLength(1);
    expect(result.stdout).toContain('npm run dependencies:ci');
  });
});
