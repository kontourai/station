/**
 * `--parent-pid`: a supervisor whose launcher is killed outright drains and
 * exits, taking its core with it. Real processes: a launcher child starts
 * the supervisor (detached, as `station start` does) and is SIGKILLed.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { launcherGone } from '../parent-watch.ts';
import {
  FAKE_CORE,
  freePort,
  makeShortHome,
  SUPERVISOR_MAIN,
  trackHome,
} from './harness.ts';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(condition: () => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return true;
}

function status(home: string): { pid: number; core: number } | null {
  const result = spawnSync(
    process.execPath,
    [
      SUPERVISOR_MAIN,
      '--request',
      'status',
      '--home',
      home,
      '--instance',
      'test',
    ],
    { encoding: 'utf8', timeout: 20_000, windowsHide: true },
  );
  if (result.status !== 0) return null;
  const reply = JSON.parse(result.stdout.trim().split('\n')[0] ?? '{}');
  const active = reply.status?.active;
  return active?.state === 'serving'
    ? { pid: reply.status.supervisor.pid, core: active.pid }
    : null;
}

/** A launcher that starts a detached supervisor watching it, then idles. */
function startLauncher(home: string, port: number): ChildProcess {
  const script = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ${JSON.stringify([
      SUPERVISOR_MAIN,
      '--entry',
      FAKE_CORE,
      '--home',
      home,
      '--instance',
      'test',
      '--parent-check-ms',
      '250',
    ])}.concat(['--parent-pid', String(process.pid)]), {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, FAKE_CORE_PORT: ${JSON.stringify(String(port))} },
    });
    child.unref();
    setInterval(() => {}, 1000);
  `;
  return spawn(process.execPath, ['-e', script], {
    stdio: 'ignore',
    windowsHide: true,
  });
}

describe('launcherGone', () => {
  const state = { parentPid: 40, fingerprint: 'ps:Mon 1', wasParent: true };
  it('is gone when the pid is gone or now belongs to another process', () => {
    expect(launcherGone(state, { status: 'gone' }, 40, 'darwin')).toBe(true);
    expect(
      launcherGone(state, { status: 'ok', value: 'ps:Tue 2' }, 1, 'darwin'),
    ).toBe(true);
    expect(
      launcherGone(state, { status: 'ok', value: 'ps:Mon 1' }, 1, 'darwin'),
    ).toBe(false);
  });

  it('falls back to the parent pid only on POSIX, and only for its real parent', () => {
    const unknown = { status: 'unknown', reason: 'ps timed out' } as const;
    expect(launcherGone(state, unknown, 1, 'linux')).toBe(true);
    expect(launcherGone(state, unknown, 40, 'linux')).toBe(false);
    expect(launcherGone(state, unknown, 1, 'win32')).toBe(false);
    expect(
      launcherGone({ ...state, wasParent: false }, unknown, 1, 'linux'),
    ).toBe(false);
  });
});

describe('supervisor --parent-pid (child processes)', () => {
  it('drains and exits, with its core, once its launcher is SIGKILLed', async () => {
    const home = trackHome(makeShortHome());
    const launcher = startLauncher(home, await freePort());
    const seen: { value: { pid: number; core: number } | null } = {
      value: null,
    };
    try {
      expect(
        await waitUntil(() => {
          seen.value = status(home);
          return seen.value !== null;
        }, 60_000),
      ).toBe(true);
      const running = seen.value;
      if (!running) throw new Error('the supervisor never served');
      const { pid, core } = running;
      // A live launcher keeps it serving across several checks.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(alive(pid)).toBe(true);
      expect(alive(core)).toBe(true);

      launcher.kill('SIGKILL');
      expect(await waitUntil(() => !alive(pid) && !alive(core), 30_000)).toBe(
        true,
      );
    } finally {
      launcher.kill('SIGKILL');
      for (const pid of seen.value ? [seen.value.pid, seen.value.core] : []) {
        if (alive(pid)) process.kill(pid, 'SIGKILL');
      }
    }
  }, 120_000);
});
