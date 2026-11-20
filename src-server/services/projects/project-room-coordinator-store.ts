/**
 * Durable state of the `#general` coordinator (#5063): the suggested-Tasks
 * cards and each row's progress from proposed to settled.
 *
 * Every transition is a compare-and-set on the row's state, and a slot is
 * claimed in one `BEGIN IMMEDIATE` transaction that counts the rows already
 * holding one. So the Project's concurrency limit holds across concurrent
 * Starts, the background pump and a restart: no path can move a row to
 * `starting` without that count.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ProjectMembershipScope } from '@kontourai/station-contracts/project-membership';
import {
  COORDINATOR_TASK_STATES,
  type CoordinatorTaskState,
} from '@kontourai/station-contracts/project-room-coordinator';
import { z } from 'zod/v3';
import { openPrivateSqlite } from '../../utils/private-sqlite.js';

const scopeSchema = z
  .object({
    stationId: z.string().min(1),
    localProjectId: z.string().min(1),
    localProjectSlug: z.string().min(1),
    portableProjectId: z.string().min(1),
  })
  .strict();

const rowSchema = z
  .object({
    rowId: z.string().min(1),
    proposalId: z.string().min(1),
    position: z.number().int().nonnegative(),
    scope: scopeSchema,
    roomId: z.string().min(1),
    title: z.string().min(1),
    prompt: z.string().min(1),
    agentId: z.string().min(1),
    agentLabel: z.string().min(1),
    placement: z.enum(['project', 'worktree']),
    mayOpenPullRequest: z.boolean(),
    state: z.enum(COORDINATOR_TASK_STATES),
    /** Who pressed Start (or asked, when the Project starts without asking). */
    starterId: z.string().min(1).optional(),
    starterName: z.string().min(1).optional(),
    queuedSeq: z.number().int().nonnegative().optional(),
    taskId: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
    conversationId: z.string().min(1).optional(),
    refusal: z.string().min(1).optional(),
    outcome: z.enum(['completed', 'failed']).optional(),
    resultText: z.string().min(1).optional(),
    resultMessageId: z.string().min(1).optional(),
    /** The result could not be posted: the starter or the room changed. */
    resultWithheld: z.string().min(1).optional(),
    pullRequestRefusals: z.number().int().nonnegative(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict();
export type CoordinatorRowRecord = z.infer<typeof rowSchema>;

export interface CoordinatorProposalRecord {
  proposalId: string;
  requestId: string;
  localProjectId: string;
  roomId: string;
  messageId?: string;
  createdAt: string;
  /** The Project started its rows without asking when it was made. */
  autoStart: boolean;
  rows: CoordinatorRowRecord[];
}

/** A stable id from its parts, so a replayed write lands on the same row. */
export function coordinatorId(...parts: string[]): string {
  return createHash('sha256')
    .update(JSON.stringify(parts))
    .digest('hex')
    .slice(0, 32);
}

export type CoordinatorRowDraft = Pick<
  CoordinatorRowRecord,
  | 'title'
  | 'prompt'
  | 'agentId'
  | 'agentLabel'
  | 'placement'
  | 'mayOpenPullRequest'
>;

export class ProjectRoomCoordinatorStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => Date = () => new Date(),
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS coordinator_proposals (proposal_id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, local_project_id TEXT NOT NULL, room_id TEXT NOT NULL, message_id TEXT, created_at TEXT NOT NULL, auto_start INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS coordinator_rows (row_id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL, position INTEGER NOT NULL, local_project_id TEXT NOT NULL, state TEXT NOT NULL, queued_seq INTEGER, session_id TEXT, conversation_id TEXT, task_id TEXT, record TEXT NOT NULL) STRICT;
      CREATE INDEX IF NOT EXISTS coordinator_rows_project_state ON coordinator_rows (local_project_id, state);
      CREATE INDEX IF NOT EXISTS coordinator_rows_session ON coordinator_rows (session_id);
      CREATE INDEX IF NOT EXISTS coordinator_rows_conversation ON coordinator_rows (conversation_id);
      CREATE TABLE IF NOT EXISTS coordinator_queue (seq INTEGER PRIMARY KEY CHECK (seq = 1), next INTEGER NOT NULL) STRICT;`);
  }

  private transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = run();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private parse(record: unknown): CoordinatorRowRecord {
    return rowSchema.parse(JSON.parse(String(record)));
  }

  private write(row: CoordinatorRowRecord): void {
    const value = rowSchema.parse(row);
    this.db
      .prepare(
        'INSERT INTO coordinator_rows VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(row_id) DO UPDATE SET state=excluded.state, queued_seq=excluded.queued_seq, session_id=excluded.session_id, conversation_id=excluded.conversation_id, task_id=excluded.task_id, record=excluded.record',
      )
      .run(
        value.rowId,
        value.proposalId,
        value.position,
        value.scope.localProjectId,
        value.state,
        value.queuedSeq ?? null,
        value.sessionId ?? null,
        value.conversationId ?? null,
        value.taskId ?? null,
        JSON.stringify(value),
      );
  }

  private nextQueueSeq(): number {
    const row = this.db.prepare('SELECT next FROM coordinator_queue').get();
    const next = row ? Number(row.next) : 1;
    this.db
      .prepare(
        'INSERT INTO coordinator_queue VALUES (1, ?) ON CONFLICT(seq) DO UPDATE SET next=excluded.next',
      )
      .run(next + 1);
    return next;
  }

  /**
   * Record one reply's card, once per agent request. A replay returns the
   * card the first write made, whatever this call carries.
   */
  recordProposal(input: {
    requestId: string;
    scope: ProjectMembershipScope;
    roomId: string;
    rows: readonly CoordinatorRowDraft[];
    /** Present: the Project starts without asking, as this person. */
    startAs?: { id: string; name: string };
  }): CoordinatorProposalRecord {
    const proposalId = coordinatorId('proposal', input.requestId);
    return this.transaction(() => {
      const existing = this.proposal(proposalId);
      if (existing) return existing;
      const at = this.now().toISOString();
      this.db
        .prepare(
          'INSERT INTO coordinator_proposals VALUES (?, ?, ?, ?, NULL, ?, ?)',
        )
        .run(
          proposalId,
          input.requestId,
          input.scope.localProjectId,
          input.roomId,
          at,
          input.startAs ? 1 : 0,
        );
      input.rows.forEach((draft, position) => {
        this.write({
          ...draft,
          rowId: coordinatorId('row', proposalId, String(position)),
          proposalId,
          position,
          scope: { ...input.scope },
          roomId: input.roomId,
          state: input.startAs ? 'waiting' : 'proposed',
          ...(input.startAs
            ? {
                starterId: input.startAs.id,
                starterName: input.startAs.name,
                queuedSeq: this.nextQueueSeq(),
              }
            : {}),
          pullRequestRefusals: 0,
          createdAt: at,
          updatedAt: at,
        });
      });
      return this.proposal(proposalId)!;
    });
  }

  /** The room message a card sits under. Set once. */
  attachMessage(proposalId: string, messageId: string): void {
    this.db
      .prepare(
        'UPDATE coordinator_proposals SET message_id=? WHERE proposal_id=? AND message_id IS NULL',
      )
      .run(messageId, proposalId);
  }

  proposal(proposalId: string): CoordinatorProposalRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM coordinator_proposals WHERE proposal_id=?')
      .get(proposalId);
    if (!row) return undefined;
    return {
      proposalId: String(row.proposal_id),
      requestId: String(row.request_id),
      localProjectId: String(row.local_project_id),
      roomId: String(row.room_id),
      ...(row.message_id ? { messageId: String(row.message_id) } : {}),
      createdAt: String(row.created_at),
      autoStart: Number(row.auto_start) === 1,
      rows: this.db
        .prepare(
          'SELECT record FROM coordinator_rows WHERE proposal_id=? ORDER BY position',
        )
        .all(proposalId)
        .map((r) => this.parse(r.record)),
    };
  }

  /** A Project's cards in one room, newest first. */
  proposals(
    localProjectId: string,
    roomId: string,
    limit: number,
  ): CoordinatorProposalRecord[] {
    return this.db
      .prepare(
        'SELECT proposal_id FROM coordinator_proposals WHERE local_project_id=? AND room_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?',
      )
      .all(localProjectId, roomId, limit)
      .map((row) => this.proposal(String(row.proposal_id))!);
  }

  row(rowId: string): CoordinatorRowRecord | undefined {
    const row = this.db
      .prepare('SELECT record FROM coordinator_rows WHERE row_id=?')
      .get(rowId);
    return row ? this.parse(row.record) : undefined;
  }

  /** Rows in these states, oldest queued first; one Project when named. */
  rowsIn(
    states: readonly CoordinatorTaskState[],
    localProjectId?: string,
  ): CoordinatorRowRecord[] {
    const rows = localProjectId
      ? this.db
          .prepare(
            'SELECT record FROM coordinator_rows WHERE local_project_id=? AND state IN (SELECT value FROM json_each(?)) ORDER BY queued_seq, rowid',
          )
          .all(localProjectId, JSON.stringify(states))
      : this.db
          .prepare(
            'SELECT record FROM coordinator_rows WHERE state IN (SELECT value FROM json_each(?)) ORDER BY queued_seq, rowid',
          )
          .all(JSON.stringify(states));
    return rows.map((row) => this.parse(row.record));
  }

  /** The row whose Task Session or conversation this is. */
  rowForSession(id: string): CoordinatorRowRecord | undefined {
    const row = this.db
      .prepare(
        'SELECT record FROM coordinator_rows WHERE session_id=? OR conversation_id=? LIMIT 1',
      )
      .get(id, id);
    return row ? this.parse(row.record) : undefined;
  }

  /** The row that started this Task, in this Project. */
  rowForTask(
    localProjectId: string,
    taskId: string,
  ): CoordinatorRowRecord | undefined {
    const row = this.db
      .prepare(
        'SELECT record FROM coordinator_rows WHERE local_project_id=? AND task_id=? LIMIT 1',
      )
      .get(localProjectId, taskId);
    return row ? this.parse(row.record) : undefined;
  }

  /**
   * Start: move a card's `proposed` rows (all, or the named ones) to
   * `waiting` as this person. Rows already started are left as they are, so
   * a repeated Start all changes nothing.
   */
  queue(
    proposalId: string,
    rowIds: readonly string[] | undefined,
    starter: { id: string; name: string },
  ): CoordinatorRowRecord[] {
    return this.transaction(() => {
      const proposal = this.proposal(proposalId);
      if (!proposal) return [];
      const at = this.now().toISOString();
      const queued: CoordinatorRowRecord[] = [];
      for (const row of proposal.rows) {
        if (row.state !== 'proposed') continue;
        if (rowIds && !rowIds.includes(row.rowId)) continue;
        const next: CoordinatorRowRecord = {
          ...row,
          state: 'waiting',
          starterId: starter.id,
          starterName: starter.name,
          queuedSeq: this.nextQueueSeq(),
          updatedAt: at,
        };
        this.write(next);
        queued.push(next);
      }
      return queued;
    });
  }

  /** Rows holding one of this Project's slots now. */
  holding(localProjectId: string): number {
    return Number(
      this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM coordinator_rows WHERE local_project_id=? AND state IN ('starting', 'working')",
        )
        .get(localProjectId)?.n ?? 0,
    );
  }

  /**
   * Claim free slots: move the oldest `waiting` rows to `starting`, up to
   * `limit` rows holding a slot in this Project. One transaction counts and
   * claims, so two pumps never claim past the limit.
   */
  claimSlots(localProjectId: string, limit: number): CoordinatorRowRecord[] {
    return this.transaction(() => {
      const free = Math.max(0, limit - this.holding(localProjectId));
      if (!free) return [];
      const at = this.now().toISOString();
      return this.db
        .prepare(
          "SELECT record FROM coordinator_rows WHERE local_project_id=? AND state='waiting' ORDER BY queued_seq, rowid LIMIT ?",
        )
        .all(localProjectId, free)
        .map((r) => {
          const next: CoordinatorRowRecord = {
            ...this.parse(r.record),
            state: 'starting',
            updatedAt: at,
          };
          this.write(next);
          return next;
        });
    });
  }

  /**
   * Change a row only while it is in one of `from`. Answers the new row, or
   * undefined when another path moved it first.
   */
  transition(
    rowId: string,
    from: readonly CoordinatorTaskState[],
    patch: Partial<Omit<CoordinatorRowRecord, 'rowId' | 'proposalId'>>,
  ): CoordinatorRowRecord | undefined {
    return this.transaction(() => {
      const row = this.row(rowId);
      if (!row || !from.includes(row.state)) return undefined;
      const next = {
        ...row,
        ...patch,
        updatedAt: this.now().toISOString(),
      };
      this.write(next);
      return next;
    });
  }

  /** Count one refused pull request on the row of this Session. */
  countPullRequestRefusal(rowId: string): void {
    this.transaction(() => {
      const row = this.row(rowId);
      if (!row) return;
      this.write({ ...row, pullRequestRefusals: row.pullRequestRefusals + 1 });
    });
  }

  /** Every Project with a row waiting or holding a slot. */
  activeProjects(): string[] {
    return this.db
      .prepare(
        "SELECT DISTINCT local_project_id FROM coordinator_rows WHERE state IN ('waiting', 'starting', 'working')",
      )
      .all()
      .map((row) => String(row.local_project_id));
  }
}

export function openProjectRoomCoordinatorStore(home: string): {
  store: ProjectRoomCoordinatorStore;
  close(): void;
} {
  const db = openPrivateSqlite(
    join(home, 'security', 'project-room-coordinator.sqlite'),
    'Project Room coordinator',
  );
  try {
    return {
      store: new ProjectRoomCoordinatorStore(db),
      close: () => db.close(),
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
