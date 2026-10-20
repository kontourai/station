import { realpathSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.ts';
import {
  getBoot,
  startLoad,
  startSupervisor,
  writeCoreVariant,
} from './harness.ts';

const makeTempDir = trackTempDirs();

describe('supervisor handoff rollback (real processes)', () => {
  it.each<{ name: string; env: Record<string, string>; reason: string }>([
    {
      name: 'never reports ready',
      env: { FAKE_CORE_NEVER_READY: '1' },
      reason: 'trial-readiness-timeout',
    },
    {
      name: 'exits after promote',
      env: { FAKE_CORE_EXIT_AFTER_PROMOTE: '1' },
      reason: 'trial-exited-after-promote',
    },
  ])(
    'rolls back to the previous entry when the trial $name',
    async ({ env, reason }) => {
      const home = makeTempDir('sup-rollback-');
      // Both entries live in one build root: the supervisor runs nothing outside it.
      const buildRoot = makeTempDir('sup-build-');
      const goodEntry = realpathSync(writeCoreVariant(buildRoot, 'core', {}));
      const badEntry = writeCoreVariant(buildRoot, 'bad-core', env);
      const supervisor = await startSupervisor({ home, entry: goodEntry });
      const port = supervisor.port;
      const before = await supervisor.status();
      const load = startLoad(port);
      try {
        await vi.waitFor(() => expect(load.stats.ok).toBeGreaterThan(20));

        const result = await supervisor.handoff({
          entry: badEntry,
          readinessTimeoutMs: 1_500,
        });
        expect(result, supervisor.output()).toMatchObject({
          outcome: 'rolled-back',
          reason,
        });

        const after = await supervisor.status();
        expect(after.state).toBe('serving');
        // gen 1 drained, gen 2 was the failed trial, gen 3 relaunched the previous entry.
        expect(after.active?.generation).toBe(3);
        expect(after.active?.entry).toBe(goodEntry);
        expect(after.active?.bootId).not.toBe(before.active?.bootId);
        expect(after.listeners).toEqual([{ name: 'api', port }]);
        const servedBefore = load.stats.ok;
        await vi.waitFor(() => {
          expect(load.stats.bootIds.at(-1)).toBe(after.active?.bootId);
          expect(load.stats.ok).toBeGreaterThan(servedBefore + 20);
        });
        expect((await getBoot(port)).entry).toBe(goodEntry);

        const stats = await load.stop();
        expect(stats.errors).toEqual({});
        expect(stats.bootIds).toEqual([
          before.active?.bootId,
          after.active?.bootId,
        ]);
      } finally {
        await load.stop();
      }
    },
    90_000,
  );

  it('drains a promoted trial that serves but misses readiness, resetting no client', async () => {
    const home = makeTempDir('sup-rollback-serving-');
    const buildRoot = makeTempDir('sup-build-');
    const goodEntry = realpathSync(writeCoreVariant(buildRoot, 'core', {}));
    const badEntry = writeCoreVariant(buildRoot, 'serves-unready', {
      FAKE_CORE_SERVE_WITHOUT_READY: '1',
    });
    const supervisor = await startSupervisor({ home, entry: goodEntry });
    const port = supervisor.port;
    const load = startLoad(port);
    try {
      await vi.waitFor(() => expect(load.stats.ok).toBeGreaterThan(20));
      const result = await supervisor.handoff({
        entry: badEntry,
        readinessTimeoutMs: 1_500,
      });
      expect(result, supervisor.output()).toMatchObject({
        outcome: 'rolled-back',
        reason: 'trial-readiness-timeout',
      });
      const after = await supervisor.status();
      expect(after.active?.generation).toBe(3);
      const servedBefore = load.stats.ok;
      await vi.waitFor(() => {
        expect(load.stats.bootIds.at(-1)).toBe(after.active?.bootId);
        expect(load.stats.ok).toBeGreaterThan(servedBefore + 20);
      });
      const stats = await load.stop();
      // The trial served this load before it failed; it was drained, not
      // signalled, so none of its keep-alive connections was reset.
      expect(stats.bootIds.length).toBe(3);
      expect(stats.errors, supervisor.output()).toEqual({});
    } finally {
      await load.stop();
    }
  }, 90_000);

  it('never disturbs the active generation when the trial fails before parking', async () => {
    const home = makeTempDir('sup-rollback-park-');
    const buildRoot = makeTempDir('sup-build-');
    const goodEntry = writeCoreVariant(buildRoot, 'core', {});
    const badEntry = writeCoreVariant(buildRoot, 'boot-fail', {
      FAKE_CORE_EXIT_ON_BOOT: '1',
    });
    const supervisor = await startSupervisor({ home, entry: goodEntry });
    const before = await supervisor.status();
    const load = startLoad(supervisor.port);
    try {
      const result = await supervisor.handoff({ entry: badEntry });
      expect(result).toMatchObject({
        outcome: 'rolled-back',
        reason: 'trial-exited-before-parked',
        generation: 1,
      });
      const after = await supervisor.status();
      expect(after.active?.generation).toBe(1);
      expect(after.active?.bootId).toBe(before.active?.bootId);
      const stats = await load.stop();
      expect(stats.errors).toEqual({});
      expect(stats.bootIds).toEqual([before.active?.bootId]);
    } finally {
      await load.stop();
    }
  }, 60_000);
});
