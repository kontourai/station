/**
 * SkillUsageService — run/outcome counters for skills, in a side store.
 *
 * The counters live in `<home>/skills/.usage.json` (`{ [skillName]: stats }`),
 * NOT in each skill's `skill.json`, for two reasons that both matter:
 *
 *  - **Read-only skills have usage too.** Canonical package skills (flow-agents)
 *    and plugin-contributed skills are served from roots Station must not write
 *    to, and they have no `skill.json` of their own. A per-skill record could
 *    only count runs for skills the user happens to own.
 *  - **Usage is not part of the skill.** A `SKILL.md` package exported or
 *    re-installed elsewhere should not carry this Station's run counts.
 *
 * `qualityScore` is computed on read from the counters, never stored, so a
 * persisted score can never disagree with the successes/failures behind it.
 *
 * Every mutation goes through `mutateJsonFile`, the repository's existing
 * read/derive/publish transaction: it takes the on-disk mutation lock, so the
 * increment is serialized across STATION PROCESSES, not merely across callers
 * inside one of them (review finding 1, HIGH — a process-local promise chain
 * let two servers sharing a home each read `runs: 0` and each write `runs: 1`).
 *
 * A counter file that exists but cannot be parsed is an ERROR, never an empty
 * store: `readJsonFile` throws for anything but `ENOENT`, so a truncated file
 * holding months of counters makes the mutation fail loudly instead of being
 * silently replaced by a one-entry store (review finding 4).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  SkillOutcome,
  SkillStats,
} from '@kontourai/station-contracts/catalog';
import {
  computeGuidanceQualityScore,
  createGuidanceStats,
} from '@kontourai/station-contracts/guidance-assets';
import { mutateJsonFile } from '../../domain/file-storage-helpers.js';

// Re-exported (not redefined): a skill name is a KEY here and a PATH there, and
// both readings must refuse the same set.
export { PROTOTYPE_AFFECTING_KEYS } from '../../domain/skill-paths.js';

import { PROTOTYPE_AFFECTING_KEYS } from '../../domain/skill-paths.js';

/** `{ [skillName]: stats }`, as persisted (without `qualityScore`). */
export type SkillUsageRecord = Record<string, SkillStats>;

export const SKILL_USAGE_FILENAME = '.usage.json';

/** Raised when the counter file exists but cannot be read as a record. */
export class SkillUsageUnreadableError extends Error {
  constructor(
    readonly path: string,
    cause?: unknown,
  ) {
    super(`Skill usage counters are unreadable: ${path}`, { cause });
    this.name = 'SkillUsageUnreadableError';
  }
}

export function skillUsagePath(projectHomeDir: string): string {
  return join(projectHomeDir, 'skills', SKILL_USAGE_FILENAME);
}

/** What a read of the counter file found — including "could not read it". */
export interface SkillUsageSnapshot {
  stats: Record<string, SkillStats>;
  /**
   * Why the counters are missing, when they are. Absent means the read
   * succeeded; a caller must render this instead of "0 runs", which is a
   * different fact.
   */
  unavailable?: string;
}

function emptyRecord(): SkillUsageRecord {
  return Object.create(null) as SkillUsageRecord;
}

function withQualityScore(stats: SkillStats): SkillStats {
  return { ...stats, qualityScore: computeGuidanceQualityScore(stats) };
}

/**
 * Is this parsed value a counter store at all?
 *
 * ONE check, used by the read AND the mutation path. They disagreed before
 * (review delta finding 2): `snapshot()` called a non-record root unavailable
 * while the mutation passed the same value through `toUsageRecord`, read it as
 * empty, and published a replacement — so `.usage.json` containing valid JSON
 * `[]` listed as unavailable and was then destroyed by the next run.
 */
function isUsableUsageRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A null-prototype copy carrying only own, plausibly-shaped entries. */
function toUsageRecord(parsed: unknown): SkillUsageRecord {
  const record = emptyRecord();
  if (!isUsableUsageRecord(parsed)) {
    return record;
  }
  for (const [name, value] of Object.entries(parsed)) {
    if (PROTOTYPE_AFFECTING_KEYS.includes(name)) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    Object.defineProperty(record, name, {
      value: { ...createGuidanceStats(), ...(value as SkillStats) },
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return record;
}

function statsFrom(record: SkillUsageRecord, name: string): SkillStats {
  const current = Object.hasOwn(record, name) ? record[name] : undefined;
  return { ...createGuidanceStats(), ...(current ?? {}) };
}

interface PendingMutation {
  name: string;
  apply: (stats: SkillStats) => SkillStats;
  resolve: (stats: SkillStats) => void;
  reject: (error: unknown) => void;
}

/**
 * Matches the on-disk lock's own retry granularity
 * (`acquireFileMutationLockAsync`), so a yield here is exactly one poll for a
 * sibling waiting on it.
 */
const LOCK_FAIRNESS_YIELD_MS = 10;

export class SkillUsageService {
  /** Mutations queued per resolved usage-file path; see `mutate`/`drain`. */
  private static readonly pending = new Map<string, PendingMutation[]>();

  /**
   * How many read/derive/publish transactions this process has performed.
   *
   * Deliberately observable: coalescing is a property about the NUMBER of lock
   * acquisitions, and a test that could only measure wall-clock time would be
   * asserting a constant chosen on a quiet host — the exact thing this repo's
   * resource-manifest notes warn against. This counts the thing itself.
   */
  private static publishes = 0;

  static publishCount(): number {
    return SkillUsageService.publishes;
  }

  constructor(private readonly getProjectHomeDir: () => string) {}

  private path(): string {
    return skillUsagePath(this.getProjectHomeDir());
  }

  /**
   * Every skill's stats, read synchronously so a synchronous `listSkills()` can
   * join them. Never throws and never takes the lock: a listing must survive
   * unreadable counters, but it reports them as unavailable rather than as
   * zero.
   */
  snapshot(): SkillUsageSnapshot {
    const path = this.path();
    if (!existsSync(path)) return { stats: emptyRecord() };
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
      return {
        stats: emptyRecord(),
        unavailable: `usage counters could not be read from ${path}`,
      };
    }
    if (!isUsableUsageRecord(parsed)) {
      return {
        stats: emptyRecord(),
        unavailable: `usage counters are not a record in ${path}`,
      };
    }
    const record = toUsageRecord(parsed);
    const result = emptyRecord();
    for (const name of Object.keys(record)) {
      Object.defineProperty(result, name, {
        value: withQualityScore(record[name]),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return { stats: result };
  }

  /** One skill's stats, or `undefined` when it has never been run or rated. */
  statsFor(name: string): SkillStats | undefined {
    const { stats } = this.snapshot();
    return Object.hasOwn(stats, name) ? stats[name] : undefined;
  }

  async trackRun(name: string): Promise<SkillStats> {
    return this.mutate(name, (stats) => ({
      ...stats,
      runs: stats.runs + 1,
      lastRunAt: new Date().toISOString(),
    }));
  }

  async recordOutcome(
    name: string,
    outcome: SkillOutcome,
  ): Promise<SkillStats> {
    return this.mutate(name, (stats) => ({
      ...stats,
      successes: stats.successes + (outcome === 'success' ? 1 : 0),
      failures: stats.failures + (outcome === 'failure' ? 1 : 0),
      lastOutcomeAt: new Date().toISOString(),
    }));
  }

  /**
   * Take a migrated record's counters over as this skill's — the one write
   * `station doctor --migrate-playbooks` makes to this store.
   *
   * It adopts ONLY into a counter nothing has touched. The migration is
   * idempotent and resumable, so a second pass over the same record must not
   * re-seed a skill that has been run since, and a partial first pass must not
   * double it. An already-counted skill keeps its own numbers and the caller
   * is told which happened, because "we kept yours" and "we adopted the
   * migrated ones" are different facts and the migration report states them
   * separately.
   */
  async adoptStats(
    name: string,
    incoming: SkillStats,
  ): Promise<{ stats: SkillStats; adopted: boolean }> {
    let adopted = false;
    const stats = await this.mutate(name, (current) => {
      if (
        current.runs !== 0 ||
        current.successes !== 0 ||
        current.failures !== 0 ||
        current.lastRunAt !== undefined ||
        current.lastOutcomeAt !== undefined
      ) {
        return current;
      }
      adopted = true;
      return { ...current, ...incoming };
    });
    return { stats, adopted };
  }

  /**
   * Read → apply → publish inside the shared file-mutation transaction. The
   * updater is synchronous by contract, so no caller-controlled await can widen
   * the window between the read and the write.
   */
  private async mutate(
    name: string,
    apply: (stats: SkillStats) => SkillStats,
  ): Promise<SkillStats> {
    if (PROTOTYPE_AFFECTING_KEYS.includes(name)) {
      throw new Error(
        `Skill name ${JSON.stringify(name)} cannot be used as a usage-counter key`,
      );
    }
    const path = this.path();
    return new Promise<SkillStats>((resolve, reject) => {
      const pending = SkillUsageService.pending.get(path);
      const item: PendingMutation = { name, apply, resolve, reject };
      if (pending) {
        pending.push(item);
        return;
      }
      SkillUsageService.pending.set(path, [item]);
      void this.drain(path);
    });
  }

  /**
   * COALESCING drain: every mutation queued for this file is applied inside ONE
   * read/derive/publish, so N in-process callers cost one lock acquisition and
   * one deadline rather than N of each.
   *
   * That is not only faster. Serializing whole lock acquisitions meant each
   * caller's 10-second deadline started only when it reached the head, so a
   * sibling process holding the lock turned one bounded failure into 50
   * sequential ones (~500s); and a busy local queue could reacquire
   * immediately after every release and starve that sibling until its own
   * deadline tripped. One batch shares one bounded outcome, and the lock is
   * genuinely free between batches (review delta-2 finding (e)).
   */
  private async drain(path: string): Promise<void> {
    while (true) {
      const batch = SkillUsageService.pending.get(path);
      if (!batch || batch.length === 0) {
        SkillUsageService.pending.delete(path);
        return;
      }
      // Take everything queued RIGHT NOW; anything arriving during the publish
      // forms the next batch and gets its own, later, lock acquisition.
      const taken = batch.splice(0, batch.length);
      try {
        const results = await this.publishBatch(path, taken);
        for (const [index, item] of taken.entries()) {
          const result = results[index];
          if (result && typeof result === 'object' && 'failure' in result) {
            item.reject(result.failure);
          } else {
            item.resolve(result as SkillStats);
          }
        }
      } catch (error) {
        // One batch, one outcome: a shared read failure is reported to every
        // caller in it rather than re-attempted 50 times.
        for (const item of taken) item.reject(error);
      }
      if ((SkillUsageService.pending.get(path)?.length ?? 0) > 0) {
        // Yield the lock's own poll granularity before reacquiring, so a
        // sibling process polling for it wins the race at least as often as we
        // do instead of being starved by a continuously busy local queue.
        await new Promise((resolveSleep) =>
          setTimeout(resolveSleep, LOCK_FAIRNESS_YIELD_MS),
        );
      }
    }
  }

  /** Apply a whole batch of updaters inside one read/derive/publish. */
  /**
   * Apply a whole batch of updaters inside one read/derive/publish.
   *
   * Each updater is applied INDIVIDUALLY: one that throws rejects only its own
   * caller, and its siblings' derived values are still published. A single
   * `batch.map` aborted the whole loop, so one bad updater discarded every
   * sibling's already-correct result and rejected callers whose work had no
   * problem (review delta-3, item (e)).
   *
   * A failure of the TRANSACTION itself — an unreadable file, an expired lock —
   * is different in kind and still fails the whole batch: nothing was
   * published, so there is no per-caller outcome to report.
   */
  private async publishBatch(
    path: string,
    batch: readonly PendingMutation[],
  ): Promise<Array<SkillStats | { failure: unknown }>> {
    let results: Array<SkillStats | { failure: unknown }> = [];
    SkillUsageService.publishes += 1;
    try {
      await mutateJsonFile<SkillUsageRecord>(path, emptyRecord(), (current) => {
        // Structurally wrong but syntactically valid JSON is just as
        // unreadable as a truncated file, and just as recoverable by hand —
        // refuse instead of publishing over it.
        if (!isUsableUsageRecord(current)) {
          throw new SkillUsageUnreadableError(path);
        }
        const record = toUsageRecord(current);
        // Re-derived per updater, so two increments of the same skill in one
        // batch compose instead of overwriting each other, and each caller
        // still receives the value as of its own application.
        results = batch.map((item) => {
          try {
            const updated = item.apply(statsFrom(record, item.name));
            // `qualityScore` is derived on read; persisting it would drift.
            const { qualityScore: _derivedOnRead, ...persisted } = updated;
            Object.defineProperty(record, item.name, {
              value: persisted as SkillStats,
              enumerable: true,
              writable: true,
              configurable: true,
            });
            return withQualityScore(updated);
          } catch (failure) {
            // This caller's own updater is at fault. Leave the record as it
            // was for this skill and carry the failure back to just them.
            return { failure };
          }
        });
        return record;
      });
    } catch (error) {
      if (error instanceof SkillUsageUnreadableError) throw error;
      if (error instanceof SyntaxError) {
        // The file exists and holds something — refuse rather than overwrite
        // counters that may still be recoverable by hand.
        throw new SkillUsageUnreadableError(path, error);
      }
      throw error;
    }
    if (results.length !== batch.length) {
      throw new SkillUsageUnreadableError(path);
    }
    return results;
  }
}
