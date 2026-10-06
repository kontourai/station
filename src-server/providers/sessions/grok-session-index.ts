import { lstatSync, opendirSync } from 'node:fs';
import { join } from 'node:path';
import type { AttachedSessionSourceOutcome } from './attached-session-source.js';

/**
 * Incremental index of the Grok session tree, `<group>/<session>/`, for
 * discovery under bounded per-poll work. Station's own ACP workspaces are
 * excluded by the caller before any of this runs, which leaves ordinary trees
 * small; the bounds below are for a pathological one, and every bound defers
 * work to a later poll instead of dropping it.
 *
 * - Directory reads. Groups that changed since the last poll (a session
 *   folder was added or removed) are read first, newest first; the rest
 *   follow in a rotation that advances past whatever a poll reached. An
 *   unchanged group is not re-read, and a group whose last read ran out of
 *   budget does not jump the queue.
 * - Stats: listed sessions, this poll's new folders, the never-statted
 *   backlog, then a rotating sweep with the rest of the budget. Grok renames
 *   a fresh summary.json into a session folder on every append, so the folder
 *   mtime tracks activity.
 * - Inspections: new folders in changed groups, then folders with activity
 *   since they were last seen, then the backlog in admission order.
 *
 * The index holds at most `maxEntries` folders. When it is full, a folder in
 * a changed group evicts an inspected, settled, prompt-less folder from a
 * group not read this poll (that group is re-read later). Other folders are
 * admitted only while the waiting work fits one poll, so an over-cap tree is
 * covered as a sliding window that never outpaces inspection. A folder
 * inspected within its 2 s mtime tick is not settled. A single group with
 * more folders than the entry budget is only partly listed, in directory
 * order.
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
  /**
   * False for a group (one working directory) that never holds user
   * sessions; it is skipped before any stat or admission.
   */
  includeGroup?: (groupPath: string, name: string) => boolean;
  /** Test seam: directory reads. */
  openDirectory?: (path: string) => import('node:fs').Dir;
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
  /** The group's mtime when a poll last saw it. */
  seenAt?: number;
  /** Its last read ran out of budget: it does not jump the queue again. */
  truncated?: boolean;
  /** mtime at the last complete read; absent when the group must be re-read. */
  cleanAt?: number;
  /**
   * A read cut short by the entry budget at this mtime, and how many entries
   * it covered. Directory order is stable while the mtime is, so re-reading
   * with no more budget than that would list the same names again.
   */
  partial?: { mtime: number; entries: number };
}

/** A group read within this window of its mtime may still be changing. */
const MTIME_SETTLE_MS = 2000;
/** Sorting more never-statted names than this would block; use list order. */
const MAX_SORTED_UNSTATTED = 16_384;
/** Units of work between event-loop yields; each block stays a few milliseconds. */
const YIELD_EVERY = 1024;
/** Evictable folders examined per eviction attempt. */
const MAX_EVICTION_SCAN = 4096;
const STAT_YIELD_EVERY = 32;
const INSPECTION_YIELD_EVERY = 4;

export class GrokSessionIndex {
  private readonly entries = new Map<string, Entry>();
  private readonly groups = new Map<string, Group>();
  private readonly unstatted = new Set<string>();
  private readonly listed = new Set<string>();
  private readonly uninspected = new Set<string>();
  /** Inspected before, and changed since. */
  private readonly changed = new Set<string>();
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

    // Stats: listed, this poll's admissions, never-statted backlog, then a
    // rotating sweep of everything else with the rest of the budget.
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
    // Admissions follow the newest-first group order. In the backlog, Grok's
    // generated session ids are UUIDv7, so a greater name is newer; a backlog
    // too large to sort without blocking keeps admission order.
    const admitted = this.admittedThisPoll;
    let backlog: Iterable<string> = this.unstatted;
    if (this.unstatted.size <= MAX_SORTED_UNSTATTED) {
      backlog = [...this.unstatted].sort((left, right) =>
        left < right ? 1 : -1,
      );
    }
    const priorityBudget = this.options.maxStats - this.options.maxSweepStats;
    for (const path of chain([this.listed, admitted, backlog])) {
      if (!(await stat(path, priorityBudget))) {
        raise('candidate_limit');
        break;
      }
    }
    // The sweep re-checks everything else in rotation with what is left of
    // the budget (at least its reserved share), at most once around a poll.
    for (let visited = 0; visited < this.entries.size; visited += 1) {
      this.sweep ??= this.entries.keys();
      const next = this.sweep.next();
      if (next.done) {
        this.sweep = undefined;
        continue;
      }
      if (!(await stat(next.value, this.options.maxStats))) break;
    }

    // Inspections: this poll's admissions newest first, then folders that
    // changed since they were inspected (newest first), then the backlog in
    // admission order. Every admitted folder is reached in a bounded number
    // of polls, and new activity is never queued behind old backlog.
    let changed: Iterable<string> = this.changed;
    if (this.changed.size <= MAX_SORTED_UNSTATTED) {
      changed = [...this.changed].sort(
        (left, right) =>
          (this.entries.get(right)?.modifiedAt ?? 0) -
          (this.entries.get(left)?.modifiedAt ?? 0),
      );
    }
    const inspected = new Set<string>();
    // The backlog's order is admission order because it needs no sort. It
    // does not decide what is found: the admission gate (see `admit`) keeps
    // the backlog to about one poll of inspections once the index is full,
    // so any order drains it within a poll or two. No test pins this order on
    // its own for that reason; with the gate removed, it is what keeps the
    // backlog draining (the full-ratio test fails without both).
    let inspections = 0;
    for (const path of chain([admitted, changed, this.uninspected])) {
      const entry = this.entries.get(path);
      if (
        !entry ||
        !this.uninspected.has(path) ||
        entry.modifiedAt === undefined ||
        inspected.has(path)
      ) {
        await this.tick();
        continue;
      }
      if (inspections >= this.options.maxInspections) {
        raise('candidate_limit');
        break;
      }
      inspections += 1;
      inspected.add(path);
      await this.tick(INSPECTION_YIELD_EVERY);
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
        handle = (this.options.openDirectory ?? opendirSync)(directory);
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
    // Newest groups first, so a burst of new sessions is never queued behind
    // old ones. A group's mtime changes when a session folder is added.
    const included: Array<{ path: string; mtime: number }> = [];
    for (const name of names) {
      const path = join(root, name);
      if (this.options.includeGroup && !this.options.includeGroup(path, name)) {
        continue;
      }
      try {
        included.push({ path, mtime: lstatSync(path).mtimeMs });
      } catch {
        rejected = true;
      }
    }
    included.sort(
      (left, right) =>
        right.mtime - left.mtime || (left.path < right.path ? -1 : 1),
    );
    if (rootRead === 'complete') {
      const present = new Set(included.map((group) => group.path));
      for (const group of [...this.groups.keys()]) {
        if (!present.has(group)) this.dropGroup(group);
      }
    }

    const readThisPoll = new Set<string>();
    let complete = rootRead === 'complete';
    // Groups that changed since the last poll (a new session folder, or a
    // new group) go first, newest first; the rest follow in a rotation that
    // advances whenever a poll could not cover or admit everything.
    const fresh: typeof included = [];
    const rest: typeof included = [];
    for (const item of included) {
      const known = this.groups.get(item.path);
      (known?.seenAt !== item.mtime && !known?.truncated ? fresh : rest).push(
        item,
      );
    }
    const start = rest.length ? this.groupOffset % rest.length : 0;
    const ordered = [...fresh, ...rest.slice(start), ...rest.slice(0, start)];
    // Rotated groups this poll got to; the next poll starts after them.
    let rotatedReads = 0;
    const rotated = new Set(rest.map((item) => item.path));
    for (const { path: groupPath, mtime } of ordered) {
      if (budget > 0 && rotated.has(groupPath)) rotatedReads += 1;
      const group = this.groups.get(groupPath) ?? { members: new Set() };
      this.groups.set(groupPath, group);
      group.seenAt = mtime;
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
      const isFresh = !rotated.has(groupPath);
      const budgetBefore = budget;
      const refusedBefore = refused;
      const seen = new Set<string>();
      const read = await readNames(groupPath, (name) => {
        const path = join(groupPath, name);
        seen.add(path);
        // Once the index refuses a folder, it refuses the rest of this poll.
        if (
          !this.entries.has(path) &&
          (refused || !this.admit(path, groupPath, name, readThisPoll, isFresh))
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
        group.truncated = true;
        // Refused names must be offered again once eviction makes room.
        if (refused === refusedBefore) {
          group.partial = { mtime, entries: budgetBefore };
        } else {
          delete group.partial;
        }
        break;
      }
      delete group.partial;
      group.truncated = false;
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
    // Any poll that could not admit everything starts one group later next
    // time, so a refusal never pins the same groups to the front.
    this.groupOffset =
      complete && !refused ? 0 : start + Math.max(1, rotatedReads);
    return { complete, rejected, refused };
  }

  /**
   * Add a folder, evicting a stale one when the index is full. A folder in a
   * group that changed since the last poll (where new sessions appear) is
   * always worth room. Otherwise, when full, a folder is admitted only while
   * the waiting stat and inspection work fits one poll, so rotating through
   * an over-cap tree never outpaces inspection: the window slides, and every
   * folder in it is inspected before it can be evicted.
   */
  private admit(
    path: string,
    groupPath: string,
    dirName: string,
    readThisPoll: ReadonlySet<string>,
    fresh: boolean,
  ): boolean {
    if (this.entries.size >= this.options.maxEntries) {
      if (
        !fresh &&
        this.unstatted.size + this.uninspected.size >=
          this.options.maxInspections
      ) {
        return false;
      }
      if (!this.evictOne(readThisPoll)) return false;
    }
    this.entries.set(path, { group: groupPath, dirName });
    this.groups.get(groupPath)?.members.add(path);
    this.unstatted.add(path);
    if (fresh) this.admittedThisPoll.push(path);
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
    const previous = entry.modifiedAt;
    entry.modifiedAt = info.mtimeMs;
    this.unstatted.delete(path);
    if (entry.inspectedAt !== entry.modifiedAt) {
      this.uninspected.add(path);
      // Activity since it was last seen: ahead of the never-inspected backlog.
      if (
        entry.inspection ||
        (previous !== undefined && previous !== info.mtimeMs)
      ) {
        this.changed.add(path);
      }
      // Changed since inspected: it may have gained a prompt, so keep it.
      this.evictable.delete(path);
    }
  }

  private record(path: string, entry: Entry, inspection: IndexedInspection) {
    entry.inspection = inspection;
    // A folder changed within one mtime tick may change again without its
    // mtime moving: it is not settled as prompt-less until the tick passes.
    const settled =
      inspection.session !== undefined ||
      (entry.modifiedAt !== undefined &&
        this.options.now() - entry.modifiedAt >= MTIME_SETTLE_MS);
    if (inspection.cacheable && settled) {
      entry.inspectedAt = entry.modifiedAt;
      this.uninspected.delete(path);
      this.changed.delete(path);
    } else {
      delete entry.inspectedAt;
    }
    if (inspection.session) {
      this.listed.add(path);
      this.evictable.delete(path);
    } else {
      this.listed.delete(path);
      if (inspection.cacheable && settled) this.evictable.add(path);
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
    this.uninspected.delete(path);
    this.changed.delete(path);
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

function* chain(lists: Iterable<string>[]): Generator<string> {
  for (const list of lists) yield* list;
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
