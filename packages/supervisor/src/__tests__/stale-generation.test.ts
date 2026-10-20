/**
 * A core must exit when its supervisor's IPC channel closes. If one does not
 * (a protocol violation, or a hung process) and the supervisor was killed
 * outright, the next supervisor reaps it, verifying a start-time fingerprint
 * so a recycled pid is never killed.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.ts';
import { processFingerprint } from '../generation-registry.ts';
import { supervisorRunDir } from '../protocol.ts';
import {
  freePort,
  getBoot,
  startSupervisor,
  trackHome,
  writeCoreVariant,
} from './harness.ts';

const makeTempDir = trackTempDirs();
const strays: number[] = [];

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(() => {
  for (const pid of strays.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
});

describe('stale generations (real processes)', () => {
  // POSIX: a core that ignores disconnect outlives a SIGKILLed supervisor.
  it.skipIf(process.platform === 'win32')(
    'reaps a core orphaned by a SIGKILLed supervisor and comes up serving',
    async () => {
      const home = makeTempDir('sup-stale-home-');
      const entry = writeCoreVariant(makeTempDir('sup-stale-'), 'core', {
        FAKE_CORE_IGNORE_DISCONNECT: '1',
      });
      const first = await startSupervisor({ home, entry });
      const port = first.port;
      const orphan = (await first.status()).active?.pid as number;
      strays.push(orphan);
      first.child.kill('SIGKILL');
      await first.exited;
      // The orphan outlives its supervisor and still holds the port.
      expect(isAlive(orphan)).toBe(true);
      expect((await getBoot(port)).generation).toBe(1);

      const second = await startSupervisor({
        home,
        entry,
        port,
        waitForServing: false,
      });
      await vi.waitFor(
        async () => {
          const status = await second.status().catch((error: unknown) => {
            throw new Error(`${String(error)}\n${second.output()}`);
          });
          expect(status.state, second.output()).toBe('serving');
        },
        { timeout: 30_000, interval: 100 },
      );
      expect(isAlive(orphan)).toBe(false);
      expect(second.output()).toContain(
        `reaped stale generation 1 (pid ${orphan})`,
      );
      expect(second.output()).not.toContain('EADDRINUSE');
      const status = await second.status();
      expect(status.active?.pid).not.toBe(orphan);
      expect((await getBoot(port)).bootId).toBe(status.active?.bootId);
    },
    90_000,
  );

  it.skipIf(process.platform === 'win32')(
    "reaps an orphan's own child processes with it",
    async () => {
      const home = makeTempDir('sup-stale-tree-home-');
      const pidFile = join(makeTempDir('sup-stale-tree-'), 'helper.pid');
      const entry = writeCoreVariant(
        makeTempDir('sup-stale-tree-entry-'),
        'core',
        {
          FAKE_CORE_IGNORE_DISCONNECT: '1',
          FAKE_CORE_CHILD_PID_FILE: pidFile,
        },
      );
      const first = await startSupervisor({ home, entry });
      const orphan = (await first.status()).active?.pid as number;
      await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true));
      const helper = Number(readFileSync(pidFile, 'utf8'));
      strays.push(orphan, helper);
      first.child.kill('SIGKILL');
      await first.exited;
      expect(isAlive(orphan)).toBe(true);
      expect(isAlive(helper)).toBe(true);

      const second = await startSupervisor({ home, entry, port: first.port });
      expect((await second.status()).state).toBe('serving');
      expect(second.output()).toContain(
        `reaped stale generation 1 (pid ${orphan})`,
      );
      expect(isAlive(orphan)).toBe(false);
      await vi.waitFor(() => expect(isAlive(helper)).toBe(false), {
        timeout: 5_000,
      });
    },
    90_000,
  );

  // Windows: a non-detached child dies with its supervisor even when it
  // ignores disconnect, so the orphan the POSIX case reaps never exists.
  it.runIf(process.platform === 'win32')(
    'a core dies with its supervisor even when it ignores disconnect',
    async () => {
      const entry = writeCoreVariant(makeTempDir('sup-stale-win-'), 'core', {
        FAKE_CORE_IGNORE_DISCONNECT: '1',
      });
      const supervisor = await startSupervisor({
        home: makeTempDir('sup-stale-win-home-'),
        entry,
      });
      const core = (await supervisor.status()).active?.pid as number;
      strays.push(core);
      supervisor.child.kill('SIGKILL');
      await supervisor.exited;
      await vi.waitFor(() => expect(isAlive(core)).toBe(false), {
        timeout: 10_000,
      });
    },
    60_000,
  );

  it('reaps a recorded orphan that holds the port, then serves on it', async () => {
    const home = makeTempDir('sup-stale-recorded-');
    const port = await freePort();
    // An escaped core from an older build: detached, listening on the port.
    const orphan = spawn(
      process.execPath,
      ['-e', `require('net').createServer().listen(${port}, '127.0.0.1')`],
      { detached: true, stdio: 'ignore', windowsHide: true },
    );
    const pid = orphan.pid as number;
    strays.push(pid);
    await vi.waitFor(
      () =>
        new Promise<void>((resolve, reject) => {
          const probe = createConnection(port, '127.0.0.1');
          probe.once('connect', () => {
            probe.destroy();
            resolve();
          });
          probe.once('error', reject);
        }),
      { timeout: 10_000, interval: 50 },
    );
    const fingerprint = await processFingerprint(pid);
    expect(fingerprint.status).toBe('ok');
    mkdirSync(supervisorRunDir(trackHome(home)), { mode: 0o700 });
    writeFileSync(
      join(supervisorRunDir(home), 'supervisor-test.generations.json'),
      JSON.stringify([
        {
          pid,
          generation: 7,
          fingerprint: fingerprint.status === 'ok' ? fingerprint.value : '',
        },
      ]),
    );
    const supervisor = await startSupervisor({ home, port });
    expect((await supervisor.status()).state).toBe('serving');
    expect(supervisor.output()).toContain(
      `reaped stale generation 7 (pid ${pid})`,
    );
    expect(isAlive(pid)).toBe(false);
    expect((await getBoot(port)).generation).toBe(1);
  }, 60_000);
});
