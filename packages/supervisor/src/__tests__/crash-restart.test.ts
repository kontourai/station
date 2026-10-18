import { existsSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.ts';
import { startLoad, startSupervisor, writeCoreVariant } from './harness.ts';

const makeTempDir = trackTempDirs();

describe('supervisor crash restart (real processes)', () => {
  it('restarts a killed generation after the backoff while connections queue', async () => {
    const home = makeTempDir('sup-crash-');
    // A long enough backoff that the load client certainly connects during the gap.
    const supervisor = await startSupervisor({
      home,
      args: ['--restart-backoff-ms', '750'],
    });
    const before = await supervisor.status();
    const pid = before.active?.pid;
    expect(pid).toBeTypeOf('number');
    const load = startLoad(supervisor.port);
    try {
      await vi.waitFor(() => expect(load.stats.ok).toBeGreaterThan(20));
      const connectionsBefore = load.stats.connections;
      process.kill(pid as number, 'SIGKILL');

      await vi.waitFor(
        async () => {
          const status = await supervisor.status();
          expect(status.state).toBe('serving');
          expect(status.active?.generation).toBe(2);
        },
        { timeout: 20_000, interval: 50 },
      );
      const after = await supervisor.status();
      expect(after.restarts).toEqual({
        consecutiveFailures: 1,
        lastBackoffMs: 750,
      });
      await vi.waitFor(() =>
        expect(load.stats.bootIds.at(-1)).toBe(after.active?.bootId),
      );

      const stats = await load.stop();
      // SIGKILL resets the connections the dead generation had accepted; those
      // are not refusals. Every connection opened after it died queued.
      expect(stats.errors.ECONNREFUSED).toBeUndefined();
      expect(
        Object.keys(stats.errors).filter((code) => code !== 'ECONNRESET'),
      ).toEqual([]);
      expect(stats.errors.ECONNRESET ?? 0).toBeLessThanOrEqual(8);
      expect(stats.connections).toBeGreaterThan(connectionsBefore);
      // Checked after the client's view: the held listener is the reason.
      expect(after.listeners).toEqual([{ name: 'api', port: supervisor.port }]);
      expect(stats.bootIds).toEqual([
        before.active?.bootId,
        after.active?.bootId,
      ]);
      expect(supervisor.output()).toContain('restarting in 750ms (failure 1)');
    } finally {
      await load.stop();
    }
  }, 60_000);

  it('gives up and exits nonzero after repeated failures', async () => {
    const home = makeTempDir('sup-giveup-');
    const entry = writeCoreVariant(makeTempDir('sup-entry-'), 'crashing', {
      FAKE_CORE_EXIT_ON_BOOT: '1',
    });
    const supervisor = await startSupervisor({
      home,
      entry,
      args: ['--restart-backoff-ms', '20', '--restart-max-failures', '3'],
      waitForServing: false,
    });
    const exit = await supervisor.exited;
    expect(exit, supervisor.output()).toEqual({ code: 1, signal: null });
    expect(supervisor.output()).toContain('giving up after 3 failures');
    expect(existsSync(supervisor.endpoint.tokenPath)).toBe(false);
    expect(existsSync(supervisor.endpoint.path)).toBe(false);
  }, 60_000);
});
