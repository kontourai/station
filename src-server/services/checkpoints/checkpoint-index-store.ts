import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { isSafeCheckpointRefSegment } from '@kontourai/station-shared/checkpoints';
import { JsonFileStore } from '../infra/json-store.js';

const STORE_VERSION = 1 as const;
const MAX_TURN_RECORDS_PER_THREAD = 200;
const MAX_THREADS = 400;

/**
 * station#2802 fix round (H2): the index is ONE FILE PER THREAD, not one
 * whole-home document. The captured document (`turn-checkpoints.json`)
 * made every recordTurnPhase a read+write of a file whose size scaled with
 * the GLOBAL thread/turn population — measured at 85.7 MB / ~335 ms of
 * synchronous I/O at this store's own documented bounds (400 threads × 200
 * turns), twice per turn, and the not_applicable branch taken by every
 * unbound chat pays it too. Per thread, one write is bounded by
 * maxTurnsPerThread records (~100 KB, ~1-2 ms) no matter how many threads
 * the home tracks — the write cost now scales with the population the
 * record belongs to, which is the shape the bounds describe.
 */
const INDEX_DIR_NAME = 'turn-checkpoints';
export const EVICTED_INDEX_DIR_NAME = 'turn-checkpoints-evicted';

interface ThreadCheckpointFile {
  version: typeof STORE_VERSION;
  turns: Record<string, TurnCheckpointRecord>;
}

export type TurnCheckpointPhase = 'baseline' | 'settle';

/**
 * The recorded outcome of ONE boundary capture for one turn.
 *
 * The four statuses are deliberately distinct so "we could not know" can
 * never be misread as "nothing changed": `captured` names a real commit,
 * `not_applicable` says the session had no project working directory to
 * checkpoint, `skipped` names a typed repository reason (degraded HEAD
 * state, non-git directory, git timeout, …), and `failed` says the capture
 * attempted and threw. A turn with NO record at all was never observed —
 * also not "nothing changed".
 */
export type TurnPhaseCheckpoint =
  | {
      status: 'captured';
      checkpointId: string;
      commitSha: string;
      treeSha: string;
      repoRoot: string;
      capturedAt: string;
    }
  | {
      status: 'not_applicable';
      reason: 'no_project_working_directory';
      recordedAt: string;
    }
  | {
      status: 'skipped';
      reason: string;
      detail?: string;
      recordedAt: string;
    }
  | {
      status: 'failed';
      error: string;
      recordedAt: string;
    };

export interface TurnCheckpointRecord {
  threadId: string;
  turnId: string;
  baseline?: TurnPhaseCheckpoint;
  settle?: TurnPhaseCheckpoint;
  updatedAt: string;
}

export type ThreadCheckpointDiscovery =
  | { status: 'ok'; records: TurnCheckpointRecord[] }
  | { status: 'failed'; reason: 'corrupt_discovery' | 'read_failed' };

/**
 * What an updater supplies: the phase records for a turn. The store owns
 * the identity fields (`threadId`, `turnId`) and the `updatedAt` stamp, so
 * a caller cannot forge or forget them.
 */
export type TurnCheckpointWrite = Partial<
  Pick<TurnCheckpointRecord, 'baseline' | 'settle'>
>;

/**
 * Durable, thread-scoped index of turn checkpoint outcomes: one JSON file
 * per thread under `<dataDir>/turn-checkpoints/<threadId>.json`.
 *
 * The ref store is the truth about WHICH commits exist — and since the fix
 * round the git side is self-describing (turnId and capturedAt live in the
 * commit message), so this index is a genuinely REBUILDABLE cache of the
 * turn mapping, not the only record. A corrupt file resets ONE thread's
 * cache (the whole-home `onCorruption: 'default-value'` reset previously
 * severed every thread's link at once, while the refs — now carrying the
 * turnId — survive as the rebuild source).
 *
 * Records are written only through `recordTurnPhase`, whose updater runs
 * against a freshly parsed defensive copy and whose write is issued in the
 * same synchronous call — there is no read-modify-write surface a caller
 * could split across an await (the CAS-less RMW shape that produced
 * station#1588/#1600/#1606 is unreachable by construction).
 */
export interface CheckpointIndexStoreOptions {
  /** Documented bound: newest N turn records per thread. Default 200. */
  maxTurnsPerThread?: number;
  /** Documented bound: newest N threads retained. Default 400. */
  maxThreads?: number;
  /** Test seam for atomic active-index -> discovery-archive eviction. */
  archiveEvictedThread?: (source: string, target: string) => void;
}

export class CheckpointIndexStore {
  private readonly dir: string;
  private readonly maxTurnsPerThread: number;
  private readonly maxThreads: number;
  private readonly archiveEvictedThread: (
    source: string,
    target: string,
  ) => void;
  private readonly caches = new Map<
    string,
    JsonFileStore<ThreadCheckpointFile>
  >();

  constructor(dataDir: string, options: CheckpointIndexStoreOptions = {}) {
    this.dir = join(dataDir, INDEX_DIR_NAME);
    this.maxTurnsPerThread =
      options.maxTurnsPerThread ?? MAX_TURN_RECORDS_PER_THREAD;
    this.maxThreads = options.maxThreads ?? MAX_THREADS;
    this.archiveEvictedThread =
      options.archiveEvictedThread ??
      ((source, target) => {
        mkdirSync(join(this.dir, '..', EVICTED_INDEX_DIR_NAME), {
          recursive: true,
        });
        renameSync(source, target);
        // JsonFileStore retains a recovery sibling. Once the primary's exact
        // bytes are durably discoverable in the archive, leaving that sibling
        // behind would let a later read resurrect the evicted active index.
        rmSync(`${source}.previous`, { force: true });
      });
  }

  /**
   * The threadId becomes a FILE NAME, so it is segment-validated with the
   * same pattern as ref names — a route-supplied `threadId` param can never
   * traverse out of the index directory. An unsafe id is a no-op read /
   * empty list, matching the "no records" contract callers already handle.
   */
  private storeFor(
    threadId: string,
  ): JsonFileStore<ThreadCheckpointFile> | null {
    if (!isSafeCheckpointRefSegment(threadId)) return null;
    let store = this.caches.get(threadId);
    if (!store) {
      store = new JsonFileStore<ThreadCheckpointFile>(
        join(this.dir, `${threadId}.json`),
        { version: STORE_VERSION, turns: {} },
        // tear-safe atomic write: the temp file + rename + retained
        // `.previous` mean the file is never torn (a torn file is the one
        // corruption that would silently drop records), while the ~15 ms of
        // crash-safe fsyncs per write is deliberately not paid for a
        // rebuildable cache whose source of truth is git.
        { durableAtomicWrite: true, atomicWriteDurability: 'tear-safe' },
      );
      this.caches.set(threadId, store);
    }
    return store;
  }

  recordTurnPhase(
    threadId: string,
    turnId: string,
    resolve: (current: TurnCheckpointRecord | undefined) => TurnCheckpointWrite,
  ): void {
    const store = this.storeFor(threadId);
    if (!store) return;
    const data = this.readData(store);
    // Defensive copy: the updater mutates a private parse, never an object
    // any other reader holds.
    const current = structuredClone(data.turns[turnId]);
    const next = resolve(current);
    // Phase-MERGE, not replace: a turn's record accumulates baseline and
    // settle across two writes, and the settle write must never clobber the
    // baseline it cannot see (a replace here dropped the baseline phase —
    // caught by the suite, not by types).
    data.turns[turnId] = {
      ...data.turns[turnId],
      ...next,
      threadId,
      turnId,
      updatedAt: new Date().toISOString(),
    };
    trimTurns(data, this.maxTurnsPerThread);
    store.write(data);
    this.trimThreads();
  }

  readTurn(threadId: string, turnId: string): TurnCheckpointRecord | undefined {
    const store = this.storeFor(threadId);
    if (!store) return undefined;
    const record = this.readData(store).turns[turnId];
    return record ? structuredClone(record) : undefined;
  }

  listThread(threadId: string): TurnCheckpointRecord[] {
    const store = this.storeFor(threadId);
    if (!store) return [];
    return Object.values(this.readData(store).turns)
      .map((record) => structuredClone(record))
      .sort(
        (a, b) =>
          // turnId as the deterministic tie-break: same-millisecond writes
          // are the common case for baseline/settle, not an edge.
          a.updatedAt.localeCompare(b.updatedAt) ||
          a.turnId.localeCompare(b.turnId),
      );
  }

  /**
   * Lossless retention discovery across every archived generation plus the
   * active index. Unlike the transcript read path, corruption fails closed:
   * retention must exceed its soft bound instead of deleting refs from an
   * incomplete view of the repositories or protected baselines.
   */
  listThreadDiscovery(threadId: string): ThreadCheckpointDiscovery {
    if (!isSafeCheckpointRefSegment(threadId)) {
      return { status: 'failed', reason: 'read_failed' };
    }
    const records: TurnCheckpointRecord[] = [];
    const archiveDir = join(this.dir, '..', EVICTED_INDEX_DIR_NAME);
    try {
      if (existsDirectory(archiveDir)) {
        for (const entry of readdirSync(archiveDir)) {
          if (!entry.endsWith('.json')) continue;
          const parsed = parseCheckpointFile(join(archiveDir, entry));
          const values = Object.values(parsed.turns);
          if (!values.some((record) => record.threadId === threadId)) continue;
          if (values.some((record) => record.threadId !== threadId)) {
            return { status: 'failed', reason: 'corrupt_discovery' };
          }
          records.push(...values);
        }
      }
      const activePath = join(this.dir, `${threadId}.json`);
      try {
        records.push(...Object.values(parseCheckpointFile(activePath).turns));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    } catch (error) {
      return {
        status: 'failed',
        reason:
          error instanceof SyntaxError ? 'corrupt_discovery' : 'read_failed',
      };
    }
    const unique = new Map<string, TurnCheckpointRecord>();
    for (const record of records) {
      const baselineId =
        record.baseline?.status === 'captured'
          ? record.baseline.checkpointId
          : (record.baseline?.status ?? '');
      const settleId =
        record.settle?.status === 'captured'
          ? record.settle.checkpointId
          : (record.settle?.status ?? '');
      const key = `${record.turnId}\0${record.updatedAt}\0${baselineId}\0${settleId}`;
      unique.set(key, structuredClone(record));
    }
    return {
      status: 'ok',
      records: [...unique.values()].sort(
        (a, b) =>
          a.updatedAt.localeCompare(b.updatedAt) ||
          a.turnId.localeCompare(b.turnId),
      ),
    };
  }

  private readData(
    store: JsonFileStore<ThreadCheckpointFile>,
  ): ThreadCheckpointFile {
    const data = store.read();
    if (data.version !== STORE_VERSION) {
      return { version: STORE_VERSION, turns: {} };
    }
    return data;
  }

  /**
   * Keep at most maxThreads files, deleting the stalest by mtime (each
   * write refreshes its file's mtime, so staleness == least recently
   * written). Called after every write; cheap because it only acts when
   * the bound is exceeded.
   */
  private trimThreads(): void {
    let entries: string[];
    try {
      entries = readdirSync(this.dir).filter((name) => name.endsWith('.json'));
    } catch {
      return;
    }
    if (entries.length <= this.maxThreads) return;
    const statted = entries
      .map((name) => {
        const path = join(this.dir, name);
        const mtime = statSync(path).mtimeMs;
        return { name, path, mtime };
      })
      .sort((a, b) => a.mtime - b.mtime);
    for (const entry of statted.slice(0, statted.length - this.maxThreads)) {
      const threadId = entry.name.replace(/\.json$/, '');
      const archivePath = join(
        this.dir,
        '..',
        EVICTED_INDEX_DIR_NAME,
        `${threadId}.${Date.now()}.${randomUUID()}.json`,
      );
      try {
        // Never unlink the only repoRoot -> hidden-ref discovery record.
        // Atomic rename means either the active index remains, or the CLI's
        // discovery archive owns the exact same bytes. A failed archive is
        // deliberately fail-closed: exceed the soft bound and retry later.
        this.archiveEvictedThread(entry.path, archivePath);
      } catch {
        continue;
      }
      this.caches.delete(threadId);
    }
  }
}

function existsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function parseCheckpointFile(path: string): ThreadCheckpointFile {
  const parsed = JSON.parse(
    readFileSync(path, 'utf-8'),
  ) as ThreadCheckpointFile;
  if (parsed.version !== STORE_VERSION || !parsed.turns) {
    throw new SyntaxError('unsupported checkpoint discovery document');
  }
  return parsed;
}

/** Documented bound: newest N turns per thread, oldest dropped first. */
function trimTurns(
  data: ThreadCheckpointFile,
  maxTurnsPerThread: number,
): void {
  const ids = Object.keys(data.turns);
  if (ids.length <= maxTurnsPerThread) return;
  const ordered = ids.sort((a, b) =>
    data.turns[a].updatedAt.localeCompare(data.turns[b].updatedAt),
  );
  for (const id of ordered.slice(0, ids.length - maxTurnsPerThread)) {
    delete data.turns[id];
  }
}
