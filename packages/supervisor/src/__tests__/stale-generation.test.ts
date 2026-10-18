/**
 * A core must exit when its supervisor's IPC channel closes. If one does not
 * (a protocol violation, or a hung process) and the supervisor was killed
 * outright, the next supervisor reaps it, verifying a start-time fingerprint
 * so a recycled pid is never killed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.ts';
import { getBoot, startSupervisor, writeCoreVariant } from './harness.ts';

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
  it('reaps a core orphaned by a SIGKILLed supervisor and comes up serving', async () => {
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
  }, 90_000);
});
