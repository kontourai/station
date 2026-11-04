/**
 * Durable per-Task follow-up observations (#4508): what happened on a Task's
 * followed GitHub items, who did it, how decision 2 sorts them, and when.
 *
 * Keyed by Task incarnation (`taskId` + `taskCreatedAt`, as Task memory is),
 * so a Task recreated under the same id starts with nothing. An observation
 * is identified by its GitHub kind and database id within that incarnation;
 * recording it again changes nothing.
 *
 * A stream's cursor (`github-follow-up-reader.ts`) is written in the same
 * transaction as the page's items, so the cursor can never move past an item
 * that was not recorded.
 *
 * One SQLite file in the Station home, opened only once something writes to
 * it; a brief read before any poll finds no file and shows nothing.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  FollowUpActorClass,
  FollowUpItem,
  FollowUpKind,
  FollowUpStream,
} from './github-follow-up-reader.js';

export interface TaskIncarnation {
  taskId: string;
  taskCreatedAt: string;
}

export interface TaskFollowUpObservation extends FollowUpItem {
  /** The followed item it happened on: `github:owner/repo#N`. */
  itemRef: string;
  /** When Station recorded it. */
  recordedAt: string;
}

/** Check conclusions the brief counts rather than shows. */
const PASSING_CONCLUSIONS = ['SUCCESS', 'NEUTRAL', 'SKIPPED'] as const;
/** Observations kept per Task incarnation; the oldest go past it. */
const MAX_OBSERVATIONS_PER_TASK = 500;

export function taskFollowUpStorePath(homeDir: string): string {
  return join(homeDir, 'task-follow-ups', 'task-follow-ups.sqlite');
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS follow_up_observations (
    task_id TEXT NOT NULL,
    task_created_at TEXT NOT NULL,
    kind TEXT NOT NULL,
    github_id TEXT NOT NULL,
    item_ref TEXT NOT NULL,
    author TEXT NOT NULL,
    actor_class TEXT NOT NULL,
    association TEXT,
    occurred_at TEXT NOT NULL,
    url TEXT,
    excerpt TEXT NOT NULL,
    truncated INTEGER NOT NULL,
    review_state TEXT,
    check_name TEXT,
    conclusion TEXT,
    recorded_at TEXT NOT NULL,
    PRIMARY KEY (task_id, task_created_at, kind, github_id)
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS follow_up_observations_by_time
    ON follow_up_observations (task_id, task_created_at, occurred_at)`,
  `CREATE TABLE IF NOT EXISTS follow_up_cursors (
    task_id TEXT NOT NULL,
    task_created_at TEXT NOT NULL,
    item_ref TEXT NOT NULL,
    stream TEXT NOT NULL,
    cursor TEXT NOT NULL,
    PRIMARY KEY (task_id, task_created_at, item_ref, stream)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS follow_up_not_followed (
    task_id TEXT NOT NULL,
    task_created_at TEXT NOT NULL,
    item_ref TEXT NOT NULL,
    reason TEXT NOT NULL,
    PRIMARY KEY (task_id, task_created_at, item_ref)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS follow_up_polls (
    task_id TEXT NOT NULL,
    task_created_at TEXT NOT NULL,
    polled_at TEXT NOT NULL,
    outcome TEXT NOT NULL,
    PRIMARY KEY (task_id, task_created_at)
  ) STRICT`,
];

interface ObservationRow {
  kind: string;
  github_id: string;
  item_ref: string;
  author: string;
  actor_class: string;
  association: string | null;
  occurred_at: string;
  url: string | null;
  excerpt: string;
  truncated: number;
  review_state: string | null;
  check_name: string | null;
  conclusion: string | null;
  recorded_at: string;
}

/** One SQLite row as the store wrote it; a column of another type refuses. */
function readRow(raw: Record<string, unknown>): ObservationRow {
  const text = (key: keyof ObservationRow): string => {
    const value = raw[key];
    if (typeof value !== 'string')
      throw new Error(`Task follow-up row has no ${key}.`);
    return value;
  };
  const optional = (key: keyof ObservationRow): string | null => {
    const value = raw[key];
    if (value === null) return null;
    if (typeof value !== 'string')
      throw new Error(`Task follow-up row has an unreadable ${key}.`);
    return value;
  };
  const truncated = raw.truncated;
  if (typeof truncated !== 'number')
    throw new Error('Task follow-up row has no truncated flag.');
  return {
    kind: text('kind'),
    github_id: text('github_id'),
    item_ref: text('item_ref'),
    author: text('author'),
    actor_class: text('actor_class'),
    association: optional('association'),
    occurred_at: text('occurred_at'),
    url: optional('url'),
    excerpt: text('excerpt'),
    truncated,
    review_state: optional('review_state'),
    check_name: optional('check_name'),
    conclusion: optional('conclusion'),
    recorded_at: text('recorded_at'),
  };
}

function fromRow(row: ObservationRow): TaskFollowUpObservation {
  return {
    kind: row.kind as FollowUpKind,
    githubId: row.github_id,
    itemRef: row.item_ref,
    author: row.author,
    actorClass: row.actor_class as FollowUpActorClass,
    ...(row.association ? { association: row.association } : {}),
    occurredAt: row.occurred_at,
    ...(row.url ? { url: row.url } : {}),
    excerpt: row.excerpt,
    truncated: row.truncated === 1,
    ...(row.review_state ? { reviewState: row.review_state } : {}),
    ...(row.check_name !== null ? { checkName: row.check_name } : {}),
    ...(row.conclusion ? { conclusion: row.conclusion } : {}),
    recordedAt: row.recorded_at,
  };
}

/** A kept pull request the poller refused to follow, and why. */
export interface TaskFollowUpNotFollowed {
  itemRef: string;
  reason: 'different-repository';
}

/** What the brief shows: newest first, passing checks only counted. */
export interface TaskFollowUpBriefView {
  items: TaskFollowUpObservation[];
  /** Kept pull requests the last poll did not follow. */
  notFollowed: TaskFollowUpNotFollowed[];
  /** Observations the view did not list (past `limit`), passing checks aside. */
  more: number;
  passingChecks: number;
  lastPolledAt?: string;
}

export class TaskFollowUpStore {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    for (const statement of SCHEMA) this.db.exec(statement);
  }

  readCursor(
    task: TaskIncarnation,
    itemRef: string,
    stream: FollowUpStream,
  ): string | undefined {
    const row = this.db
      .prepare(
        'SELECT cursor FROM follow_up_cursors WHERE task_id = ? AND task_created_at = ? AND item_ref = ? AND stream = ?',
      )
      .get(task.taskId, task.taskCreatedAt, itemRef, stream) as
      | { cursor: string }
      | undefined;
    return row?.cursor;
  }

  /**
   * Record one page: its items (each once) and, in the same transaction,
   * each stream's new cursor. A stream with no cursor keeps the one it had.
   * Returns how many items were new.
   */
  recordPage(
    task: TaskIncarnation,
    itemRef: string,
    page: {
      items: readonly FollowUpItem[];
      cursors: Partial<Record<FollowUpStream, string>>;
    },
    recordedAt: string,
  ): number {
    const insert = this.db.prepare(
      `INSERT INTO follow_up_observations (task_id, task_created_at, kind, github_id, item_ref, author, actor_class, association, occurred_at, url, excerpt, truncated, review_state, check_name, conclusion, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    );
    const cursor = this.db.prepare(
      `INSERT INTO follow_up_cursors (task_id, task_created_at, item_ref, stream, cursor) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (task_id, task_created_at, item_ref, stream) DO UPDATE SET cursor = excluded.cursor`,
    );
    let added = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const item of page.items) {
        const result = insert.run(
          task.taskId,
          task.taskCreatedAt,
          item.kind,
          item.githubId,
          itemRef,
          item.author,
          item.actorClass,
          item.association ?? null,
          item.occurredAt,
          item.url ?? null,
          item.excerpt,
          item.truncated ? 1 : 0,
          item.reviewState ?? null,
          item.checkName ?? null,
          item.conclusion ?? null,
          recordedAt,
        );
        added += Number(result.changes);
      }
      for (const [stream, value] of Object.entries(page.cursors))
        if (value)
          cursor.run(task.taskId, task.taskCreatedAt, itemRef, stream, value);
      if (added > 0) this.prune(task);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return added;
  }

  private prune(task: TaskIncarnation): void {
    this.db
      .prepare(
        `DELETE FROM follow_up_observations WHERE task_id = ? AND task_created_at = ? AND rowid NOT IN (
           SELECT rowid FROM follow_up_observations WHERE task_id = ? AND task_created_at = ?
           ORDER BY occurred_at DESC, rowid DESC LIMIT ?)`,
      )
      .run(
        task.taskId,
        task.taskCreatedAt,
        task.taskId,
        task.taskCreatedAt,
        MAX_OBSERVATIONS_PER_TASK,
      );
  }

  markPolled(task: TaskIncarnation, polledAt: string, outcome: string): void {
    this.db
      .prepare(
        `INSERT INTO follow_up_polls (task_id, task_created_at, polled_at, outcome) VALUES (?, ?, ?, ?)
         ON CONFLICT (task_id, task_created_at) DO UPDATE SET polled_at = excluded.polled_at, outcome = excluded.outcome`,
      )
      .run(task.taskId, task.taskCreatedAt, polledAt, outcome);
  }

  /** Replace the Task's not-followed list with what this poll decided. */
  replaceNotFollowed(
    task: TaskIncarnation,
    entries: readonly TaskFollowUpNotFollowed[],
  ): void {
    const insert = this.db.prepare(
      'INSERT OR REPLACE INTO follow_up_not_followed (task_id, task_created_at, item_ref, reason) VALUES (?, ?, ?, ?)',
    );
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          'DELETE FROM follow_up_not_followed WHERE task_id = ? AND task_created_at = ?',
        )
        .run(task.taskId, task.taskCreatedAt);
      for (const entry of entries)
        insert.run(task.taskId, task.taskCreatedAt, entry.itemRef, entry.reason);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private notFollowed(task: TaskIncarnation): TaskFollowUpNotFollowed[] {
    return this.db
      .prepare(
        'SELECT item_ref, reason FROM follow_up_not_followed WHERE task_id = ? AND task_created_at = ? ORDER BY item_ref',
      )
      .all(task.taskId, task.taskCreatedAt)
      .flatMap((row) =>
        typeof row.item_ref === 'string' && row.reason === 'different-repository'
          ? [{ itemRef: row.item_ref, reason: 'different-repository' as const }]
          : [],
      );
  }

  lastPolledAt(task: TaskIncarnation): string | undefined {
    const row = this.db
      .prepare(
        'SELECT polled_at FROM follow_up_polls WHERE task_id = ? AND task_created_at = ?',
      )
      .get(task.taskId, task.taskCreatedAt) as
      | { polled_at: string }
      | undefined;
    return row?.polled_at;
  }

  /** Every observation of the incarnation, newest first. */
  list(task: TaskIncarnation): TaskFollowUpObservation[] {
    return this.db
      .prepare(
        `SELECT * FROM follow_up_observations WHERE task_id = ? AND task_created_at = ?
           ORDER BY occurred_at DESC, rowid DESC`,
      )
      .all(task.taskId, task.taskCreatedAt)
      .map((raw) => fromRow(readRow(raw)));
  }

  briefView(task: TaskIncarnation, limit: number): TaskFollowUpBriefView {
    const passing = PASSING_CONCLUSIONS.map(() => '?').join(', ');
    const shown = `task_id = ? AND task_created_at = ? AND NOT (kind = 'check_run' AND conclusion IN (${passing}))`;
    const args = [task.taskId, task.taskCreatedAt, ...PASSING_CONCLUSIONS];
    const items = this.db
      .prepare(
        `SELECT * FROM follow_up_observations WHERE ${shown} ORDER BY occurred_at DESC, rowid DESC LIMIT ?`,
      )
      .all(...args, limit)
      .map((raw) => fromRow(readRow(raw)));
    const total = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM follow_up_observations WHERE ${shown}`,
        )
        .get(...args) as { n: number }
    ).n;
    const passingChecks = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM follow_up_observations WHERE task_id = ? AND task_created_at = ? AND kind = 'check_run' AND conclusion IN (${passing})`,
        )
        .get(...args) as { n: number }
    ).n;
    const lastPolledAt = this.lastPolledAt(task);
    return {
      items,
      notFollowed: this.notFollowed(task),
      more: Math.max(0, total - items.length),
      passingChecks,
      ...(lastPolledAt ? { lastPolledAt } : {}),
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

/**
 * The runtime's one store, opened lazily: the poller opens it to write, and a
 * brief read uses it only when the file already exists.
 */
export class TaskFollowUpStoreHolder {
  private store: TaskFollowUpStore | undefined;
  private closed = false;

  constructor(private readonly path: () => string) {}

  forWrite(): TaskFollowUpStore | undefined {
    if (this.closed) return undefined;
    this.store ??= new TaskFollowUpStore(this.path());
    return this.store;
  }

  forRead(): TaskFollowUpStore | undefined {
    if (this.closed) return undefined;
    if (!this.store && !existsSync(this.path())) return undefined;
    return this.forWrite();
  }

  close(): void {
    this.closed = true;
    this.store?.close();
    this.store = undefined;
  }
}
