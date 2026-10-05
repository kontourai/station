import { lstatSync, opendirSync } from 'node:fs';
import { join } from 'node:path';
import type { AttachedSessionSourceOutcome } from './attached-session-source.js';

/**
 * Incremental index of the Grok session tree, `<group>/<session>/`, for
 * discovery under bounded per-poll work.
 *
 * Station's own ACP probes leave a prompt-less session per run, so the tree
 * can outgrow any single poll. Work per poll is bounded three ways, and every
 * bound defers work to a later poll instead of dropping it:
 *
 * - Directory reads. A group (one working directory) is re-read only when its
 *   own mtime changed, which is exactly when a session folder was added or
 *   removed in it. A read the entry budget cuts short leaves the group dirty,
 *   and the next poll starts one group later, so no group is starved.
 * - Stats. Listed sessions first, then never-statted folders (carried until
 *   reached), then recently changed prompt-less ones, then a reserved
 *   rotating sweep of everything else. Grok renames a fresh summary.json into
 *   a session folder on every append, so the folder mtime tracks activity.
 * - Inspections, newest first.
 *
 * The index itself holds at most `maxEntries` folders. When it is full, a new
 * folder evicts an inspected prompt-less folder from a group this poll has not
 * read, and that group is marked for a re-read, so stale entries never block
 * new ones. A single group with more folders than the entry budget is only
 * partly listed, in directory order.
 */

export interface IndexedInspection {
  outcome: AttachedSessionSourceOutcome;
  /** Absent: not a listed session (not prompted, or not recognized). */
  session?: { sessionId: string; cwd: string; createdAt: string };
  /** False when the answer may change while the folder's mtime does not. */
  cacheable: boolean;
}

export interface GrokSessionIndexOptions {
  /** Directory entries read per poll, and folders the index holds. */
  maxEntries: number;
  maxStats: number;
  /** Of `maxStats`, the share reserved for the rotating sweep. */
  maxSweepStats: number;
  maxInspections: number;
  now: () => number;
  yieldFn: () => Promise<void>;
}

interface Entry {
  group: string;
  dirName: string;
  modifiedAt?: number;
  inspection?: IndexedInspection;
  inspectedAt?: number;
}

interface Group {
  members: Set<string>;
  /** mtime at the last complete read; absent when the group must be re-read. */
  cleanAt?: number;
  /**
   * A read cut short by the entry budget at this mtime, and how many entries
   * it covered. Directory order is stable while the mtime is, so re-reading
   * with no more budget than that would list the same names again.
   */
  partial?: { mtime: number; entries: number };
}

/** A prompt-less folder this recent is re-checked every poll. */
const RECENT_MS = 60 * 60 * 1000;
/** A group read within this window of its mtime may still be changing. */
const MTIME_SETTLE_MS = 2000;
/** Sorting more never-statted names than this would block; use list order. */
const MAX_SORTED_UNSTATTED = 16_384;
/** Units of work between event-loop yields; each block stays a few milliseconds. */
const YIELD_EVERY = 1024;
/** Evictable folders examined per eviction attempt. */
const MAX_EVICTION_SCAN = 4096;
const STAT_YIELD_EVERY = 32;
const INSPECTION_YIELD_EVERY = 16;

export class GrokSessionIndex {
  private readonly entries = new Map<string, Entry>();
  private readonly groups = new Map<string, Group>();
  private readonly unstatted = new Set<string>();
  private readonly listed = new Set<string>();
  private readonly recent = new Set<string>();
  private readonly uninspected = new Set<string>();
  private readonly unrecognized = new Map<
    string,
    AttachedSessionSourceOutcome
  >();
  private groupOffset = 0;
  private sweep?: IterableIterator<string>;
  private eviction?: IterableIterator<string>;
  private work = 0;
  private admittedThisPoll: string[] = [];
  /** Inspected prompt-less folders: the only ones eviction may forget. */
  private readonly evictable = new Set<string>();

  constructor(private readonly options: GrokSessionIndexOptions) {}

  async refresh(
    root: string,
    inspect: (sessionDir: string, dirName: string) => IndexedInspection,
  ): Promise<{
    outcome: AttachedSessionSourceOutcome;
    sessions: Array<{
      sessionDir: string;
      modifiedAt: number;
      inspection: IndexedInspection;
    }>;
  }> {
    this.work = 0;
    this.admittedThisPoll = [];
    let outcome: AttachedSessionSourceOutcome = 'ok';
    const raise = (next: AttachedSessionSourceOutcome) => {
      outcome = mergeOutcome(outcome, next);
    };
    const listing = await this.list(root);
    if (!listing.complete) raise('candidate_limit');
    if (listing.rejected) raise('rejected_candidate');
    if (listing.refused) raise('candidate_limit');

    // Stats: listed, never statted, recent, then the reserved sweep.
    const statted = new Set<string>();
    let stats = 0;
    const stat = async (path: string, budget: number): Promise<boolean> => {
      if (statted.has(path) || !this.entries.has(path)) return true;
      if (stats >= budget) return false;
      stats += 1;
      statted.add(path);
      await this.tick(STAT_YIELD_EVERY);
      this.restat(path);
      return true;
    };
    // Never statted: this poll's admissions newest first, then the backlog.
    // Grok's generated session ids are UUIDv7, so a greater name is newer; a
    // backlog too large to sort without blocking keeps admission order.
    const admitted = this.admittedThisPoll.reverse();
    let backlog: Iterable<string> = this.unstatted;
    if (this.unstatted.size <= MAX_SORTED_UNSTATTED) {
      backlog = [...this.unstatted].sort((left, right) =>
        left < right ? 1 : -1,
      );
    }
    const recentSince = this.options.now() - RECENT_MS;
    const recent: string[] = [];
    for (const path of this.recent) {
      await this.tick();
      const modifiedAt = this.entries.get(path)?.modifiedAt;
      if (modifiedAt === undefined || modifiedAt < recentSince) {
        this.recent.delete(path);
      } else {
        recent.push(path);
      }
    }
    const priorityBudget = this.options.maxStats - this.options.maxSweepStats;
    const order = function* (lists: Iterable<string>[]) {
      for (const list of lists) yield* list;
    };
    for (const path of order([this.listed, admitted, backlog, recent])) {
      if (!(await stat(path, priorityBudget))) {
        raise('candidate_limit');
        break;
      }
    }
    for (let swept = 0; swept < this.options.maxSweepStats; ) {
      this.sweep ??= this.entries.keys();
      const next = this.sweep.next();
      if (next.done) {
        this.sweep = undefined;
        if (swept === 0 || this.entries.size <= statted.size) break;
        continue;
      }
      if (statted.has(next.value)) continue;
      if (!(await stat(next.value, this.options.maxStats))) break;
      swept += 1;
    }

    // Inspections, newest first.
    // Only the newest `maxInspections` are needed: a bounded heap with
    // yields, not a sort of every waiting folder.
    const newest = new NewestHeap(this.options.maxInspections);
    for (const path of this.uninspected) {
      await this.tick();
      const modifiedAt = this.entries.get(path)?.modifiedAt;
      if (modifiedAt !== undefined) newest.offer(path, modifiedAt);
    }
    if (newest.offered > this.options.maxInspections) raise('candidate_limit');
    for (const path of newest.drainNewestFirst()) {
      await this.tick(INSPECTION_YIELD_EVERY);
      const entry = this.entries.get(path);
      if (!entry) continue;
      this.record(path, entry, inspect(path, entry.dirName));
    }

    for (const unrecognized of this.unrecognized.values()) raise(unrecognized);
    const sessions = [];
    for (const path of this.listed) {
      const entry = this.entries.get(path);
      if (entry?.inspection?.session && entry.modifiedAt !== undefined) {
        sessions.push({
          sessionDir: path,
          modifiedAt: entry.modifiedAt,
          inspection: entry.inspection,
        });
      }
    }
    sessions.sort(
      (left, right) =>
        right.modifiedAt - left.modifiedAt ||
        // Code-unit order: localeCompare costs ~0.5s over 7.5k entries.
        (left.sessionDir < right.sessionDir ? -1 : 1),
    );
    return { outcome, sessions };
  }

  /** Yield to the event loop every `every` units of work. */
  private async tick(every = YIELD_EVERY): Promise<void> {
    this.work += 1;
    if (this.work % every === 0) await this.options.yieldFn();
  }

  private async list(root: string): Promise<{
    complete: boolean;
    rejected: boolean;
    refused: boolean;
  }> {
    let budget = this.options.maxEntries;
    let rejected = false;
    let refused = false;
    const readNames = async (
      directory: string,
      onDirectory: (name: string) => void,
    ): Promise<'complete' | 'partial' | 'failed'> => {
      let handle: import('node:fs').Dir;
      try {
        handle = opendirSync(directory);
      } catch {
        return 'failed';
      }
      try {
        let entry = handle.readSync();
        while (entry) {
          if (budget <= 0) return 'partial';
          budget -= 1;
          await this.tick();
          if (entry.isDirectory()) onDirectory(entry.name);
          entry = handle.readSync();
        }
      } finally {
        handle.closeSync();
      }
      return 'complete';
    };

    const names: string[] = [];
    const rootRead = await readNames(root, (name) => names.push(name));
    if (rootRead === 'failed')
      return { complete: false, rejected: true, refused };
    const groupPaths = names.map((name) => join(root, name)).sort();
    if (rootRead === 'complete') {
      const present = new Set(groupPaths);
      for (const group of [...this.groups.keys()]) {
        if (!present.has(group)) this.dropGroup(group);
      }
    }

    const readThisPoll = new Set<string>();
    let complete = rootRead === 'complete';
    const start = groupPaths.length ? this.groupOffset % groupPaths.length : 0;
    for (let index = 0; index < groupPaths.length; index += 1) {
      const groupPath = groupPaths[(start + index) % groupPaths.length]!;
      const group = this.groups.get(groupPath) ?? { members: new Set() };
      this.groups.set(groupPath, group);
      let mtime: number;
      try {
        mtime = lstatSync(groupPath).mtimeMs;
      } catch {
        rejected = true;
        continue;
      }
      if (group.cleanAt === mtime) continue;
      if (group.partial?.mtime === mtime && group.partial.entries >= budget) {
        complete = false;
        continue;
      }
      if (budget <= 0) {
        complete = false;
        break;
      }
      readThisPoll.add(groupPath);
      const budgetBefore = budget;
      const refusedBefore = refused;
      const seen = new Set<string>();
      const read = await readNames(groupPath, (name) => {
        const path = join(groupPath, name);
        seen.add(path);
        // Once the index refuses a folder, it refuses the rest of this poll.
        if (
          !this.entries.has(path) &&
          (refused || !this.admit(path, groupPath, name, readThisPoll))
        ) {
          refused = true;
        }
      });
      if (read === 'failed') {
        // Unreadable now: keep what this group listed before.
        rejected = true;
        continue;
      }
      if (read === 'partial') {
        complete = false;
        // Refused names must be offered again once eviction makes room.
        if (refused === refusedBefore) {
          group.partial = { mtime, entries: budgetBefore };
        } else {
          delete group.partial;
        }
        break;
      }
      delete group.partial;
      // Deleting while iterating a Set is safe; no copy of a large group.
      for (const path of group.members) {
        await this.tick();
        if (!seen.has(path)) this.drop(path);
      }
      // A group changed this recently may change again within one mtime tick.
      if (refused || this.options.now() - mtime < MTIME_SETTLE_MS) {
        delete group.cleanAt;
      } else {
        group.cleanAt = mtime;
      }
    }
    this.groupOffset = complete ? 0 : start + 1;
    return { complete, rejected, refused };
  }

  /** Add a folder, evicting a stale one when the index is full. */
  private admit(
    path: string,
    groupPath: string,
    dirName: string,
    readThisPoll: ReadonlySet<string>,
  ): boolean {
    if (this.entries.size >= this.options.maxEntries) {
      if (!this.evictOne(readThisPoll)) return false;
    }
    this.entries.set(path, { group: groupPath, dirName });
    this.groups.get(groupPath)?.members.add(path);
    this.unstatted.add(path);
    this.admittedThisPoll.push(path);
    return true;
  }

  /**
   * Evicts an inspected prompt-less folder from a group not read this poll,
   * and marks that group for a re-read so the folder is listed again later.
   */
  private evictOne(readThisPoll: ReadonlySet<string>): boolean {
    // A bounded scan: the iterator persists, so a later call resumes here.
    for (let scanned = 0, restarts = 0; restarts < 2; scanned += 1) {
      if (scanned >= MAX_EVICTION_SCAN) return false;
      this.eviction ??= this.evictable.values();
      const next = this.eviction.next();
      if (next.done) {
        this.eviction = undefined;
        restarts += 1;
        continue;
      }
      const entry = this.entries.get(next.value);
      if (!entry || readThisPoll.has(entry.group)) continue;
      const group = this.groups.get(entry.group);
      if (group) {
        delete group.cleanAt;
        delete group.partial;
      }
      this.drop(next.value);
      return true;
    }
    return false;
  }

  private restat(path: string): void {
    const entry = this.entries.get(path);
    if (!entry) return;
    let info: import('node:fs').Stats | undefined;
    try {
      info = lstatSync(path);
    } catch (error) {
      // Only a folder that is gone leaves the index; an unreadable one stays.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return;
    }
    if (!info?.isDirectory()) {
      const group = this.groups.get(entry.group);
      if (group) {
        delete group.cleanAt;
        delete group.partial;
      }
      this.drop(path);
      return;
    }
    entry.modifiedAt = info.mtimeMs;
    this.unstatted.delete(path);
    if (entry.inspectedAt !== entry.modifiedAt) {
      this.uninspected.add(path);
      // Changed since inspected: it may have gained a prompt, so keep it.
      this.evictable.delete(path);
    }
    if (
      !entry.inspection?.session &&
      entry.modifiedAt >= this.options.now() - RECENT_MS
    ) {
      this.recent.add(path);
    }
  }

  private record(path: string, entry: Entry, inspection: IndexedInspection) {
    entry.inspection = inspection;
    if (inspection.cacheable) {
      entry.inspectedAt = entry.modifiedAt;
      this.uninspected.delete(path);
    } else {
      delete entry.inspectedAt;
    }
    if (inspection.session) {
      this.listed.add(path);
      this.recent.delete(path);
      this.evictable.delete(path);
    } else {
      this.listed.delete(path);
      if (inspection.cacheable) this.evictable.add(path);
      else this.evictable.delete(path);
    }
    if (!inspection.session && inspection.outcome !== 'ok') {
      this.unrecognized.set(path, inspection.outcome);
    } else {
      this.unrecognized.delete(path);
    }
  }

  private drop(path: string): void {
    const entry = this.entries.get(path);
    if (entry) this.groups.get(entry.group)?.members.delete(path);
    this.entries.delete(path);
    this.unstatted.delete(path);
    this.listed.delete(path);
    this.recent.delete(path);
    this.uninspected.delete(path);
    this.unrecognized.delete(path);
    this.evictable.delete(path);
  }

  private dropGroup(groupPath: string): void {
    for (const path of this.groups.get(groupPath)?.members ?? []) {
      this.drop(path);
    }
    this.groups.delete(groupPath);
  }
}

/** Keeps the `capacity` items with the greatest key (a min-heap on key). */
class NewestHeap {
  private readonly items: Array<{ path: string; key: number }> = [];
  offered = 0;

  constructor(private readonly capacity: number) {}

  offer(path: string, key: number): void {
    this.offered += 1;
    const items = this.items;
    if (items.length < this.capacity) {
      items.push({ path, key });
      let index = items.length - 1;
      while (index > 0) {
        const parent = (index - 1) >> 1;
        if (items[parent]!.key <= items[index]!.key) break;
        [items[parent], items[index]] = [items[index]!, items[parent]!];
        index = parent;
      }
      return;
    }
    if (key <= items[0]!.key) return;
    items[0] = { path, key };
    let index = 0;
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (left < items.length && items[left]!.key < items[smallest]!.key)
        smallest = left;
      if (right < items.length && items[right]!.key < items[smallest]!.key)
        smallest = right;
      if (smallest === index) break;
      [items[smallest], items[index]] = [items[index]!, items[smallest]!];
      index = smallest;
    }
  }

  drainNewestFirst(): string[] {
    return this.items
      .sort((left, right) => right.key - left.key)
      .map((item) => item.path);
  }
}

export function mergeOutcome(
  current: AttachedSessionSourceOutcome,
  next: AttachedSessionSourceOutcome,
): AttachedSessionSourceOutcome {
  const priority: Record<AttachedSessionSourceOutcome, number> = {
    ok: 0,
    incomplete_tail: 1,
    byte_limit: 2,
    line_limit: 3,
    candidate_limit: 4,
    malformed_record: 5,
    rejected_candidate: 6,
    missing_root: 7,
    unknown_source: 8,
  };
  return priority[next] > priority[current] ? next : current;
}
