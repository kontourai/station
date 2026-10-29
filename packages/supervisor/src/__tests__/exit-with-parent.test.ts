/**
 * `--exit-with-parent`: a supervisor whose launcher is killed outright drains
 * and exits, taking its core with it. Real processes: a launcher child starts
 * the supervisor (detached, as `station start` does, with an IPC channel as
 * `station service run` does) and is killed.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
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
      '--exit-with-parent',
    ])}, {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true,
      env: { ...process.env, FAKE_CORE_PORT: ${JSON.stringify(String(port))} },
    });
    child.channel.unref();
    child.unref();
    setInterval(() => {}, 1000);
  `;
  return spawn(process.execPath, ['-e', script], {
    stdio: 'ignore',
    windowsHide: true,
  });
}

describe('supervisor --exit-with-parent (child processes)', () => {
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
      // A live launcher keeps it serving.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(alive(pid)).toBe(true);
      expect(alive(core)).toBe(true);

      // SIGKILL on POSIX, TerminateProcess on Windows: nothing runs in it.
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

  it('refuses --exit-with-parent without a launcher channel, exit 2', () => {
    const home = trackHome(makeShortHome());
    const result = spawnSync(
      process.execPath,
      [
        SUPERVISOR_MAIN,
        '--entry',
        FAKE_CORE,
        '--home',
        home,
        '--instance',
        'test',
        '--exit-with-parent',
      ],
      { encoding: 'utf8', timeout: 20_000, windowsHide: true },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      '--exit-with-parent needs an IPC channel from its launcher',
    );
  });
});
