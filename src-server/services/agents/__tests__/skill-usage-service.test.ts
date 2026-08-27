import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SkillStats } from '@kontourai/station-contracts/catalog';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  PROTOTYPE_AFFECTING_KEYS,
  SkillUsageService,
  SkillUsageUnreadableError,
  skillUsagePath,
} from '../skill-usage-service.js';

let homeDir: string;
let service: SkillUsageService;

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'skill-usage-'));
  service = new SkillUsageService(() => homeDir);
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
});

describe('SkillUsageService', () => {
  test('a skill nobody has run has no stats at all', () => {
    expect(service.snapshot()).toEqual({ stats: {} });
    expect(service.statsFor('release-check')).toBeUndefined();
  });

  test('trackRun counts a run and stamps when it happened', async () => {
    const stats = await service.trackRun('release-check');
    expect(stats.runs).toBe(1);
    expect(stats.successes).toBe(0);
    expect(stats.qualityScore).toBeNull();
    expect(stats.lastRunAt).toBeTruthy();
    expect(service.statsFor('release-check')?.runs).toBe(1);
  });

  test('qualityScore is computed from outcomes and never stored', async () => {
    await service.recordOutcome('release-check', 'success');
    await service.recordOutcome('release-check', 'success');
    await service.recordOutcome('release-check', 'failure');

    expect(service.statsFor('release-check')).toMatchObject({
      successes: 2,
      failures: 1,
      qualityScore: 67,
    });

    const persisted = JSON.parse(
      readFileSync(skillUsagePath(homeDir), 'utf-8'),
    );
    expect(persisted['release-check']).not.toHaveProperty('qualityScore');
  });

  test('counters live in the side store, not in any skill package', async () => {
    await service.trackRun('canonical-package-skill');
    expect(existsSync(join(homeDir, 'skills', '.usage.json'))).toBe(true);
    expect(existsSync(join(homeDir, 'skills', 'canonical-package-skill'))).toBe(
      false,
    );
    expect(service.statsFor('canonical-package-skill')?.runs).toBe(1);
  });

  test('50 concurrent runs of one skill all land (serialized writes)', async () => {
    await Promise.all(
      Array.from({ length: 50 }, () => service.trackRun('release-check')),
    );
    expect(service.statsFor('release-check')?.runs).toBe(50);
  });

  test('concurrent writes to different skills do not lose each other', async () => {
    await Promise.all([
      ...Array.from({ length: 20 }, () => service.trackRun('one')),
      ...Array.from({ length: 20 }, () =>
        service.recordOutcome('two', 'success'),
      ),
    ]);
    expect(service.statsFor('one')?.runs).toBe(20);
    expect(service.statsFor('two')?.successes).toBe(20);
  });

  test('a corrupt counter file is an ERROR, and is never overwritten', async () => {
    await service.trackRun('release-check');
    await service.trackRun('release-check');
    const { writeFileSync, readFileSync: read } = await import('node:fs');
    const corrupt = '{"release-check": {"runs": 2, TRUNCATED';
    writeFileSync(skillUsagePath(homeDir), corrupt, 'utf-8');

    // A read says "unavailable" — NOT "no runs". Those are different facts.
    const snapshot = service.snapshot();
    expect(snapshot.stats).toEqual({});
    expect(snapshot.unavailable).toContain(skillUsagePath(homeDir));
    expect(service.statsFor('release-check')).toBeUndefined();

    // A write refuses rather than replacing recoverable counters with a
    // one-entry store.
    await expect(service.trackRun('release-check')).rejects.toBeInstanceOf(
      SkillUsageUnreadableError,
    );
    expect(read(skillUsagePath(homeDir), 'utf-8')).toBe(corrupt);
  });

  test('a prototype-affecting skill name is refused, not silently uncounted', async () => {
    for (const name of PROTOTYPE_AFFECTING_KEYS) {
      await expect(service.trackRun(name)).rejects.toThrow(
        /cannot be used as a usage-counter key/,
      );
    }
    expect(existsSync(skillUsagePath(homeDir))).toBe(false);
  });

  test('a __proto__ entry already on disk cannot pollute the store', async () => {
    const { writeFileSync } = await import('node:fs');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(homeDir, 'skills'), { recursive: true });
    writeFileSync(
      skillUsagePath(homeDir),
      '{"__proto__": {"runs": 9}, "real": {"runs": 1}}',
      'utf-8',
    );

    const snapshot = service.snapshot();
    expect(snapshot.unavailable).toBeUndefined();
    expect(Object.keys(snapshot.stats)).toEqual(['real']);
    expect(({} as Record<string, unknown>).runs).toBeUndefined();

    await service.trackRun('real');
    expect(service.statsFor('real')?.runs).toBe(2);
  });

  test('valid JSON that is not a record is unreadable on BOTH paths', async () => {
    // Delta finding 2: `[]` parses, so the mutation path treated it as empty
    // and published over it while the read path called it unavailable.
    const {
      writeFileSync,
      mkdirSync,
      readFileSync: read,
    } = await import('node:fs');
    mkdirSync(join(homeDir, 'skills'), { recursive: true });
    for (const corrupt of ['[]', '"a string"', '42', 'null']) {
      writeFileSync(skillUsagePath(homeDir), corrupt, 'utf-8');

      expect(service.snapshot().unavailable, corrupt).toContain(
        skillUsagePath(homeDir),
      );
      await expect(service.trackRun('release-check')).rejects.toBeInstanceOf(
        SkillUsageUnreadableError,
      );
      await expect(
        service.recordOutcome('release-check', 'success'),
      ).rejects.toBeInstanceOf(SkillUsageUnreadableError);
      expect(read(skillUsagePath(homeDir), 'utf-8'), corrupt).toBe(corrupt);
    }
  });

  test('concurrent mutations coalesce into ONE read/derive/publish', async () => {
    // Delta-2 finding (e): serializing whole lock ACQUISITIONS meant each
    // caller's deadline began only at the head of the queue, so a sibling
    // holding the lock turned one bounded failure into N sequential ones. The
    // property is about the number of transactions, not how long they take.
    const before = SkillUsageService.publishCount();
    await Promise.all([
      ...Array.from({ length: 50 }, () => service.trackRun('one')),
      ...Array.from({ length: 10 }, () =>
        service.recordOutcome('two', 'success'),
      ),
    ]);
    const publishes = SkillUsageService.publishCount() - before;

    expect(service.statsFor('one')?.runs).toBe(50);
    expect(service.statsFor('two')?.successes).toBe(10);
    // 60 callers, one transaction. Allow a second for a straggler that arrived
    // while the first batch was publishing; 60 would mean no coalescing at all.
    expect(publishes).toBeLessThanOrEqual(2);
  });

  test('each caller still receives the value as of its own application', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => service.trackRun('ordered')),
    );
    expect(results.map((stats) => stats.runs)).toEqual([1, 2, 3, 4, 5]);
  });

  test('one throwing updater rejects only its own caller (delta-3 e)', async () => {
    // Reaching the private `mutate` deliberately: no updater the public API
    // builds can fail today, so this defensive branch would otherwise be a
    // guardrail whose rejection path has never run. The property is real —
    // any future updater that validates its input would take down every
    // sibling in its batch.
    const internal = service as unknown as {
      mutate: (
        name: string,
        apply: (stats: SkillStats) => SkillStats,
      ) => Promise<SkillStats>;
    };
    const bump = (stats: SkillStats) => ({
      ...stats,
      runs: stats.runs + 1,
      lastRunAt: new Date().toISOString(),
    });

    const settled = await Promise.allSettled([
      internal.mutate.call(service, 'shared', bump),
      internal.mutate.call(service, 'shared', () => {
        throw new Error('this updater is broken');
      }),
      internal.mutate.call(service, 'shared', bump),
    ]);

    expect(settled.map((entry) => entry.status)).toEqual([
      'fulfilled',
      'rejected',
      'fulfilled',
    ]);
    expect((settled[1] as PromiseRejectedResult).reason.message).toBe(
      'this updater is broken',
    );
    // The two good callers' work was PUBLISHED, not discarded with the bad one.
    expect(service.statsFor('shared')?.runs).toBe(2);
    expect((settled[0] as PromiseFulfilledResult<SkillStats>).value.runs).toBe(
      1,
    );
    expect((settled[2] as PromiseFulfilledResult<SkillStats>).value.runs).toBe(
      2,
    );
  });

  test('a failed TRANSACTION still fails the whole batch — nothing was published', async () => {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(join(homeDir, 'skills'), { recursive: true });
    writeFileSync(skillUsagePath(homeDir), '{ truncated', 'utf-8');

    const settled = await Promise.allSettled([
      service.trackRun('one'),
      service.trackRun('two'),
    ]);
    expect(settled.map((entry) => entry.status)).toEqual([
      'rejected',
      'rejected',
    ]);
    for (const entry of settled) {
      expect((entry as PromiseRejectedResult).reason).toBeInstanceOf(
        SkillUsageUnreadableError,
      );
    }
  });
});
