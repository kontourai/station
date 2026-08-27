import { type ChildProcess, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * station#1812: the fixture child leaks specifically when the WORKER
 * process that spawned it is killed abnormally -- a corpus-coordinator
 * timeout/abort (scripts/lib/owned-process.mjs signalling the vitest
 * worker's process group), or a plain Ctrl-C -- not when a single test
 * merely fails or times out inside a worker that keeps running, which
 * `afterEach` already covers. A test that only asserts "the child is gone
 * after a normal run" cannot discriminate that path: it passes whether or
 * not the abnormal-exit reaper exists.
 *
 * This test drives the real spawn-and-reap machinery
 * (spawnLongRunningFixtureChild / installAbnormalExitReaper) in a genuinely
 * separate process via abnormal-exit-harness.ts, sends that process SIGTERM
 * before it has any chance to run an afterEach, and asserts the grandchild
 * it spawned did not survive.
 */

const harnessPath = resolve(import.meta.dirname, 'abnormal-exit-harness.ts');

let harnessProc: ChildProcess | undefined;

afterEach(() => {
  if (
    harnessProc &&
    harnessProc.exitCode === null &&
    harnessProc.signalCode === null
  ) {
    try {
      harnessProc.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
  harnessProc = undefined;
});

describe('abnormal suite teardown (station#1812)', () => {
  it('reaps the fixture grandchild even when the spawning worker is SIGTERMed before any afterEach runs', async () => {
    // `--import tsx` gives the harness the same `.js`-specifier ->
    // `.ts`-file resolution esbuild/vitest apply everywhere else in this
    // repo (Node's own native TS support requires literal `.ts` specifiers,
    // which `tsc`'s "bundler" moduleResolution rejects without an extra
    // compiler flag this repo doesn't otherwise need).
    harnessProc = spawn(process.execPath, ['--import', 'tsx', harnessPath], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    const grandchildPid = await new Promise<number>((resolvePid, reject) => {
      const rl = createInterface({ input: harnessProc!.stdout! });
      const onError = (error: Error) => {
        rl.close();
        reject(error);
      };
      rl.once('line', (line) => {
        rl.close();
        harnessProc!.off('error', onError);
        const pid = Number.parseInt(line, 10);
        if (!Number.isInteger(pid)) {
          reject(new Error(`harness did not report a pid, got: ${line}`));
          return;
        }
        resolvePid(pid);
      });
      harnessProc!.once('error', onError);
    });

    // Sanity: the grandchild is really alive before we do anything to it.
    expect(() => process.kill(grandchildPid, 0)).not.toThrow();

    // Simulate an external kill of the whole worker process -- exactly what
    // the corpus coordinator does to a hung/timed-out group, and what
    // Ctrl-C does to the foreground process group. The harness never
    // registers a normal test lifecycle, so its ONLY chance to reap the
    // grandchild is whatever spawnLongRunningFixtureChild installed.
    harnessProc.kill('SIGTERM');
    await new Promise<void>((resolveExit) => {
      harnessProc!.once('exit', () => resolveExit());
    });

    // Poll briefly for the grandchild to settle rather than asserting the
    // instant the harness process table entry clears.
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      try {
        process.kill(grandchildPid, 0);
      } catch {
        return; // gone: the reaper worked.
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(() => process.kill(grandchildPid, 0)).toThrow();
  }, 10_000);
});
