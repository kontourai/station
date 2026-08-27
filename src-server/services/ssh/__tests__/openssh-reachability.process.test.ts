/**
 * The probe's timeout must bound PROCESSES, not just the `ssh` binary (sol
 * review finding 4).
 *
 * `execFile`'s `timeout` signals the direct child only, and `ssh` is rarely
 * the only process it started: a `ProxyCommand` — which `ProxyJump` compiles
 * to — is an arbitrary program (`nc`, `cloudflared`, `aws ssm
 * start-session`) that OpenSSH does not necessarily reap. On a surface any
 * authenticated caller can trigger, a descendant surviving the timeout is an
 * unbounded process leak.
 *
 * This runs a REAL `ssh` with `ProxyCommand=sleep 30`, because the claim is
 * about how the operating system delivers a signal — a fake child could not
 * disprove it. It is classified process-heavy in
 * `scripts/vitest-resource-manifest.mjs` for that reason.
 *
 * Scope, disclosed: `pgrep`, `ps` and process groups are POSIX, so this file
 * proves the POSIX path only. Windows has no process groups and takes the
 * `taskkill /T /F` branch; its SELECTION is unit-tested against a mocked
 * platform in `openssh-reachability.test.ts`, and nothing here — or anywhere
 * in this repo — runs on a real Windows host.
 */

import { execFileSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';
import { createSystemSshReachabilityAttempt } from '../openssh-reachability.js';

/** Every pid currently in `pgid`'s process group, `ssh` itself included. */
function processGroup(pgid: number): number[] {
  try {
    return execFileSync('pgrep', ['-g', String(pgid)], { encoding: 'utf8' })
      .split('\n')
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((pid) => Number.isInteger(pid));
  } catch {
    // `pgrep` exits 1 when nothing matches — an empty group, not an error.
    return [];
  }
}

function commandOf(pid: number): string {
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return '';
  }
}

/** The ssh process this test started, found by an argument only it carries. */
function findSsh(marker: string): number | undefined {
  try {
    const pid = execFileSync('pgrep', ['-f', marker], { encoding: 'utf8' })
      .split('\n')
      .map((line) => Number.parseInt(line.trim(), 10))
      .find((value) => Number.isInteger(value) && value !== process.pid);
    return pid;
  } catch {
    return undefined;
  }
}

function groupIdOf(pid: number): number | undefined {
  try {
    const pgid = Number.parseInt(
      execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], {
        encoding: 'utf8',
      }).trim(),
      10,
    );
    return Number.isInteger(pgid) ? pgid : undefined;
  } catch {
    return undefined;
  }
}

async function until(
  predicate: () => boolean,
  budgetMs: number,
): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

describe('the probe attempt runner', () => {
  test('kills the whole process group on timeout, so a ProxyCommand child does not outlive it', {
    timeout: 60_000,
  }, async () => {
    // A host name only this run uses, so `pgrep -f` finds exactly our ssh.
    const marker = `station-probe-cleanup-${process.pid}-${Date.now()}.invalid`;
    // Long enough that the group is observably formed BEFORE the timeout
    // fires on a loaded host; short enough that the whole test is quick.
    const attempt = createSystemSshReachabilityAttempt({ timeoutMs: 5_000 });
    const finished = attempt([
      '-o',
      'BatchMode=yes',
      '-o',
      'ProxyCommand=sleep 30',
      '-o',
      'ConnectTimeout=25',
      '-T',
      '--',
      marker,
      'true',
    ]);

    let sshPid: number | undefined;
    let groupId: number | undefined;
    try {
      // Wait for the child to exist and its ProxyCommand to be running. The
      // budget is generous because a busy host is slow to spawn, not because
      // the assertion is timing-sensitive: it is the CONTENT of the group.
      const started = await until(() => {
        sshPid ??= findSsh(marker);
        if (sshPid === undefined) return false;
        groupId ??= groupIdOf(sshPid);
        if (groupId === undefined) return false;
        return processGroup(groupId).some((pid) =>
          commandOf(pid).startsWith('sleep 30'),
        );
      }, 20_000);
      // If this fails the test proves nothing, so it must fail loudly rather
      // than let an empty group read as a successful cleanup.
      expect(
        started,
        `ssh + ProxyCommand child never appeared for ${marker}`,
      ).toBe(true);
      // ssh must be its OWN group leader — that is what `detached` buys, and
      // what makes `process.kill(-pid)` reach the ProxyCommand rather than
      // this vitest worker's group.
      expect(groupId).toBe(sshPid);

      // Deliberately NOT `await finished` first. Under the defect this test
      // exists to catch, the leaked `sleep 30` inherits ssh's stdout/stderr
      // pipes, so `close` does not fire until that child dies on its own —
      // awaiting the promise would wait out the leak and then observe an
      // empty group, turning 30 seconds of leak into a passing test. (That
      // is exactly what the first version of this test did.)
      const cleared = await until(
        () => processGroup(groupId as number).length === 0,
        20_000,
      );
      const survivors = processGroup(groupId as number).map(
        (pid) => `${pid}: ${commandOf(pid)}`,
      );
      expect(
        cleared,
        `the ProxyCommand child outlived the probe timeout: ${survivors.join(', ')}`,
      ).toBe(true);

      // The same defect also strands the promise. Bound it: after the group
      // is gone the attempt must settle promptly, not at the leaked child's
      // natural death.
      const settled = await Promise.race([
        finished.then(() => true),
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(false), 5_000),
        ),
      ]);
      expect(
        settled,
        'the probe promise never settled after its own timeout',
      ).toBe(true);
    } finally {
      // Never leave a leaked group behind for a sibling suite to inherit.
      if (groupId !== undefined) {
        try {
          process.kill(-groupId, 'SIGKILL');
        } catch {
          // Already gone — the passing case.
        }
      }
    }
  });
});
