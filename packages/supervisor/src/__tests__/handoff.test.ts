import { describe, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.ts';
import { getBoot, startLoad, startSse, startSupervisor } from './harness.ts';

// Created before the harness hooks run so directories outlive the supervisor.
const makeTempDir = trackTempDirs();

describe('supervisor generation handoff (real processes)', () => {
  it('hands the listener through repeated handoffs with no refused or reset connection', async () => {
    const home = makeTempDir('sup-handoff-');
    const supervisor = await startSupervisor({ home });
    const initial = await supervisor.status();
    const port = supervisor.port;
    expect(initial.active?.generation).toBe(1);
    expect(initial.active?.port).toBe(port);
    expect(initial.listeners).toEqual([{ name: 'api', port }]);

    const sse = startSse(port);
    const load = startLoad(port);
    try {
      await vi.waitFor(() =>
        expect(sse.bootIds).toEqual([initial.active?.bootId]),
      );
      await vi.waitFor(() => expect(load.stats.ok).toBeGreaterThan(50));

      const bootIds = [initial.active?.bootId];
      for (let round = 1; round <= 3; round += 1) {
        const result = await supervisor.handoff();
        expect(result, supervisor.output()).toMatchObject({
          type: 'handoff.result',
          outcome: 'committed',
          generation: round + 1,
        });
        const status = await supervisor.status();
        expect(status.state).toBe('serving');
        expect(status.active?.generation).toBe(round + 1);
        expect(status.active?.port).toBe(port);
        expect(status.listeners).toEqual([{ name: 'api', port }]);
        bootIds.push(status.active?.bootId);
        // The new generation is serving the load client, on the same port.
        const servedBefore = load.stats.ok;
        await vi.waitFor(() => {
          expect(load.stats.bootIds.at(-1)).toBe(status.active?.bootId);
          expect(load.stats.ok).toBeGreaterThan(servedBefore + 20);
        });
        await vi.waitFor(() =>
          expect(sse.bootIds.at(-1)).toBe(status.active?.bootId),
        );
      }

      const stats = await load.stop();
      sse.stop();
      expect(stats.errors).toEqual({});
      // Every handoff closed all eight keep-alive connections, so the client
      // reconnected across each swap rather than riding one connection.
      expect(stats.connections).toBeGreaterThanOrEqual(8 * 4);
      expect(Object.keys(stats.statuses)).toEqual(['200']);
      expect(stats.bootIds).toEqual(bootIds);
      expect(sse.bootIds).toEqual(bootIds);
      expect(sse.errors).toEqual([]);
      expect((await getBoot(port)).bootId).toBe(bootIds.at(-1));
    } finally {
      await load.stop();
      sse.stop();
    }
  }, 120_000);

  it('runs a handoff the active core asks for over IPC', async () => {
    const home = makeTempDir('sup-core-request-');
    const supervisor = await startSupervisor({
      home,
      env: { FAKE_CORE_REQUEST_HANDOFF: '1' },
      waitForServing: false,
    });
    await vi.waitFor(
      async () => {
        const status = await supervisor.status();
        expect(status.state).toBe('serving');
        expect(status.active?.generation).toBe(2);
      },
      { timeout: 30_000, interval: 100 },
    );
    expect((await getBoot(supervisor.port)).generation).toBe(2);
  }, 60_000);
});
