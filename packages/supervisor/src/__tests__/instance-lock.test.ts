/**
 * One supervisor per (home, instance), whatever control socket it is given.
 * The instance lock is taken before the supervisor touches the token, the
 * generation registry, or the socket, and before it reaps anything.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.ts';
import { makeShortHome, startSupervisor } from './harness.ts';

const makeTempDir = trackTempDirs();

function lockPath(home: string): string {
  return join(home, 'run', 'supervisor-test.lock');
}

function lockOwner(home: string): number {
  return (JSON.parse(readFileSync(lockPath(home), 'utf8')) as { pid: number })
    .pid;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A pid that certainly belonged to a process that has exited. */
function deadPid(): number {
  const result = spawnSync(
    process.execPath,
    ['-e', 'process.stdout.write(String(process.pid))'],
    {
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  return Number(result.stdout);
}

describe('instance lock (real processes)', () => {
  it('refuses a second supervisor for the same instance even with its own --control socket', async () => {
    const home = makeTempDir('sup-lock-');
    const first = await startSupervisor({ home });
    const before = await first.status();
    const second = await startSupervisor({
      home,
      args: ['--control', join(makeShortHome(), 'b.sock')],
      waitForServing: false,
    });
    const exit = await second.exited;
    expect(exit.code, second.output()).toBe(1);
    expect(second.output()).toContain(
      `another supervisor (pid ${first.child.pid}) holds instance test`,
    );
    expect(second.output()).not.toContain('reaped');
    expect(second.output()).not.toMatch(/generation \d+ started/);
    // The first supervisor's core was never touched.
    const after = await first.status();
    expect(after.state).toBe('serving');
    expect(after.active?.pid).toBe(before.active?.pid);
    expect(after.restarts.consecutiveFailures).toBe(0);
    expect(lockOwner(home)).toBe(first.child.pid);
  }, 60_000);

  it('lets exactly one of two concurrent supervisors take over a stale lock', async () => {
    const home = makeTempDir('sup-lock-race-');
    mkdirSync(join(home, 'run'), { mode: 0o700 });
    writeFileSync(
      lockPath(home),
      JSON.stringify({ pid: deadPid(), fingerprint: 'stale' }),
    );
    const [a, b] = await Promise.all([
      startSupervisor({ home, waitForServing: false }),
      startSupervisor({ home, waitForServing: false }),
    ]);
    // One of them refuses and exits; the other serves.
    const loser = await Promise.race([
      a.exited.then(() => a),
      b.exited.then(() => b),
    ]);
    const winner = loser === a ? b : a;
    expect((await loser.exited).code, loser.output()).toBe(1);
    expect(loser.output()).toContain(
      `another supervisor (pid ${winner.child.pid}) holds instance test`,
    );
    expect(loser.output()).not.toMatch(/generation \d+ started/);
    await vi.waitFor(
      async () => expect((await winner.status()).state).toBe('serving'),
      { timeout: 20_000, interval: 100 },
    );
    const status = await winner.status();
    expect(status.supervisor.pid).toBe(winner.child.pid);
    expect(isAlive(status.active?.pid as number)).toBe(true);
    expect(status.restarts.consecutiveFailures).toBe(0);
    expect(lockOwner(home)).toBe(winner.child.pid);
  }, 60_000);

  it('takes over the lock of a SIGKILLed supervisor', async () => {
    const home = makeTempDir('sup-lock-kill-');
    const first = await startSupervisor({ home });
    expect(lockOwner(home)).toBe(first.child.pid);
    first.child.kill('SIGKILL');
    await first.exited;
    const second = await startSupervisor({ home });
    expect((await second.status()).state).toBe('serving');
    expect(lockOwner(home)).toBe(second.child.pid);
    expect(second.output()).toContain(
      `took over the instance lock of dead supervisor pid ${first.child.pid}`,
    );
  }, 60_000);
});
