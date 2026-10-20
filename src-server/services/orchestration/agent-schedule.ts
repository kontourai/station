/**
 * What an agent schedules for itself (wake-ups) and what it only proposes
 * (scheduled jobs), durable on EventStore's own connection.
 *
 * A wake-up is one follow-up turn into the agent's OWN conversation at a
 * later time. The route that records it reads the conversation and the
 * sender from the verified station-control caller, exactly as a dispatch from
 * that caller would resolve them (its user, owner attribution and principal),
 * and the wake-up replays exactly that sender, never a stronger one. When it
 * is due, it is handed to the conversation's durable inbox (#3568) under a
 * key derived from its id, so:
 *
 * - it waits for a running turn to end rather than interrupting it;
 * - the inbox applies the live continuation's own permission rule at
 *   placement and never stores a full-access grant, so the turn runs with
 *   the conversation's existing permissions;
 * - a restart between the hand-off and recording it hands it over again
 *   under the same key, which the inbox accepts once.
 *
 * Timers are in memory; the rows are the record. `reconcile` re-arms every
 * pending wake-up at startup and hands over any that came due while Station
 * was down, unless it is more than a day late (`expired`).
 *
 * A job proposal is a scheduled job an agent asks a person to create. The
 * scheduler's own create route approves it when a person's request names it
 * and creates exactly the job it describes (`jobMatchesProposal`).
 */
import { randomUUID } from 'node:crypto';
import {
  AGENT_JOB_PROPOSAL_MAX_OPEN_PER_CONVERSATION,
  AGENT_WAKE_UP_MAX_HORIZON_MS,
  AGENT_WAKE_UP_MAX_PENDING_PER_CONVERSATION,
  AGENT_WAKE_UP_MIN_DELAY_MS,
  AGENT_WAKE_UP_NOTE_MAX_CHARS,
  type AgentJobProposal,
  type AgentJobProposalJob,
  type AgentJobProposalState,
  type AgentWakeUp,
  type AgentWakeUpFailureCode,
  type AgentWakeUpRefusalCode,
  type AgentWakeUpState,
} from '@kontourai/station-contracts/agent-schedule';
import {
  CLIENT_ORIGIN_VERSION,
  type ClientOrigin,
  UNKNOWN_CLIENT_REPORTED_ORIGIN,
} from '@kontourai/station-contracts/client-origin';
import {
  isPrincipalRef,
  type PrincipalRef,
} from '@kontourai/station-contracts/principal';
import {
  type TransactionalSqliteDatabase,
  writeTransaction,
} from './delegation-result-delivery.js';
import type { StartOwnerAttribution } from './session-owner-attribution.js';
import type {
  ThreadInboxPayload,
  ThreadInboxSubmission,
} from './thread-inbox.js';

/**
 * The origin a wake-up's turn records: Station's own server code, never a
 * person, as a delegated result's is.
 */
export const AGENT_WAKE_UP_CLIENT_ORIGIN: ClientOrigin = Object.freeze({
  version: CLIENT_ORIGIN_VERSION,
  actor: Object.freeze({ kind: 'internal' as const }),
  reported: UNKNOWN_CLIENT_REPORTED_ORIGIN,
});

/** The inbox key a wake-up is handed over under. */
export function wakeUpClientTurnId(id: string): string {
  return `wake-up:${id}`;
}

/** What the agent reads when its wake-up arrives. */
export function wakeUpMessage(note: string): string {
  return `Scheduled check-back: ${note}`;
}

export const AGENT_SCHEDULE_SCHEMA = `CREATE TABLE IF NOT EXISTS agent_wake_ups (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  actor_attribution TEXT NOT NULL,
  actor_principal_json TEXT,
  note TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  state TEXT NOT NULL,
  canceled_by TEXT,
  reason_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_wake_ups_conversation
  ON agent_wake_ups (conversation_id, state);
CREATE INDEX IF NOT EXISTS agent_wake_ups_pending
  ON agent_wake_ups (state, due_at);
CREATE TABLE IF NOT EXISTS agent_job_proposals (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  job_json TEXT NOT NULL,
  rationale TEXT,
  state TEXT NOT NULL,
  settled_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_job_proposals_conversation
  ON agent_job_proposals (conversation_id, state)`;

/** Who a wake-up is sent as: the sender its creating request resolved. */
export interface AgentWakeUpActor {
  readonly userId: string;
  readonly attribution: StartOwnerAttribution;
  readonly principal?: PrincipalRef;
}

interface WakeUpRecord extends AgentWakeUp {
  readonly sessionId: string;
  readonly actor: AgentWakeUpActor;
  readonly dueAtMs: number;
}

const iso = (ms: number) => new Date(ms).toISOString();

function parsePrincipal(value: unknown): PrincipalRef | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return isPrincipalRef(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function wakeUpOf(row: Record<string, unknown>): WakeUpRecord {
  const principal = parsePrincipal(row.actor_principal_json);
  const dueAtMs = Number(row.due_at);
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    sessionId: String(row.session_id),
    actor: {
      userId: String(row.actor_user_id),
      // Only the two values a start knows; anything else replays as the
      // weaker one.
      attribution:
        row.actor_attribution === 'verified-bound'
          ? 'verified-bound'
          : 'unattributed-agent',
      ...(principal ? { principal } : {}),
    },
    note: String(row.note),
    dueAtMs,
    dueAt: iso(dueAtMs),
    state: String(row.state) as AgentWakeUpState,
    ...(row.canceled_by === 'agent' || row.canceled_by === 'person'
      ? { canceledBy: row.canceled_by }
      : {}),
    ...(typeof row.reason_code === 'string'
      ? { reasonCode: row.reason_code as AgentWakeUpFailureCode }
      : {}),
    createdAt: iso(Number(row.created_at)),
    updatedAt: iso(Number(row.updated_at)),
  };
}

/** The public projection: never the sender a wake-up replays. */
export function publicWakeUp(record: AgentWakeUp): AgentWakeUp {
  return {
    id: record.id,
    conversationId: record.conversationId,
    dueAt: record.dueAt,
    note: record.note,
    state: record.state,
    ...(record.canceledBy ? { canceledBy: record.canceledBy } : {}),
    ...(record.reasonCode ? { reasonCode: record.reasonCode } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function proposalOf(row: Record<string, unknown>): AgentJobProposal & {
  readonly sessionId: string;
} {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    sessionId: String(row.session_id),
    job: JSON.parse(String(row.job_json)) as AgentJobProposalJob,
    ...(typeof row.rationale === 'string' ? { rationale: row.rationale } : {}),
    state: String(row.state) as AgentJobProposalState,
    createdAt: iso(Number(row.created_at)),
    updatedAt: iso(Number(row.updated_at)),
  };
}

export function publicJobProposal(record: AgentJobProposal): AgentJobProposal {
  return {
    id: record.id,
    conversationId: record.conversationId,
    job: record.job,
    ...(record.rationale ? { rationale: record.rationale } : {}),
    state: record.state,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export type ScheduleWakeUpResult =
  | { readonly outcome: 'scheduled'; readonly wakeUp: AgentWakeUp }
  | { readonly outcome: 'refused'; readonly code: AgentWakeUpRefusalCode };

export type ProposeJobResult =
  | { readonly outcome: 'proposed'; readonly proposal: AgentJobProposal }
  | { readonly outcome: 'limit-reached' };

/** The durable records; every transition is one conditional UPDATE. */
export function createSqliteAgentScheduleStore(
  db: TransactionalSqliteDatabase,
) {
  db.exec(AGENT_SCHEDULE_SCHEMA);
  const readWakeUp = (id: string): WakeUpRecord | undefined => {
    const row = db
      .prepare('SELECT * FROM agent_wake_ups WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? wakeUpOf(row) : undefined;
  };
  const readProposal = (id: string) => {
    const row = db
      .prepare('SELECT * FROM agent_job_proposals WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? proposalOf(row) : undefined;
  };
  return {
    /**
     * Record a wake-up if the conversation has room. The count reads one
     * past the cap inside the same write transaction as the insert, so two
     * concurrent schedules cannot both pass it.
     */
    insertWakeUp(input: {
      conversationId: string;
      sessionId: string;
      actor: AgentWakeUpActor;
      note: string;
      dueAtMs: number;
      now: number;
    }): WakeUpRecord | 'limit-reached' {
      return writeTransaction(db, 'agent_wake_up_insert', () => {
        const pending = db
          .prepare(
            "SELECT id FROM agent_wake_ups WHERE conversation_id = ? AND state = 'pending' LIMIT ?",
          )
          .all(
            input.conversationId,
            AGENT_WAKE_UP_MAX_PENDING_PER_CONVERSATION + 1,
          );
        if (pending.length >= AGENT_WAKE_UP_MAX_PENDING_PER_CONVERSATION)
          return 'limit-reached' as const;
        const id = randomUUID();
        db.prepare(
          `INSERT INTO agent_wake_ups (id, conversation_id, session_id,
             actor_user_id, actor_attribution, actor_principal_json, note,
             due_at, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        ).run(
          id,
          input.conversationId,
          input.sessionId,
          input.actor.userId,
          input.actor.attribution,
          input.actor.principal ? JSON.stringify(input.actor.principal) : null,
          input.note,
          input.dueAtMs,
          input.now,
          input.now,
        );
        return readWakeUp(id)!;
      });
    },
    wakeUp: readWakeUp,
    /** A conversation's wake-ups still waiting, soonest first. */
    pendingWakeUps(conversationId?: string): WakeUpRecord[] {
      const rows = (
        conversationId === undefined
          ? db
              .prepare(
                "SELECT * FROM agent_wake_ups WHERE state = 'pending' ORDER BY due_at",
              )
              .all()
          : db
              .prepare(
                "SELECT * FROM agent_wake_ups WHERE conversation_id = ? AND state = 'pending' ORDER BY due_at",
              )
              .all(conversationId)
      ) as Record<string, unknown>[];
      return rows.map(wakeUpOf);
    },
    /** Settle a still-pending wake-up; false when it no longer is. */
    settleWakeUp(
      id: string,
      to: Exclude<AgentWakeUpState, 'pending'>,
      now: number,
      detail: {
        canceledBy?: 'agent' | 'person';
        reasonCode?: AgentWakeUpFailureCode;
      } = {},
    ): boolean {
      const result = db
        .prepare(
          `UPDATE agent_wake_ups
             SET state = ?, canceled_by = ?, reason_code = ?, updated_at = ?
           WHERE id = ? AND state = 'pending'`,
        )
        .run(
          to,
          detail.canceledBy ?? null,
          detail.reasonCode ?? null,
          now,
          id,
        ) as { changes?: number | bigint };
      return Number(result.changes ?? 0) === 1;
    },
    insertJobProposal(input: {
      conversationId: string;
      sessionId: string;
      job: AgentJobProposalJob;
      rationale?: string;
      now: number;
    }): ProposeJobResult {
      return writeTransaction(db, 'agent_job_proposal_insert', () => {
        const open = db
          .prepare(
            "SELECT id FROM agent_job_proposals WHERE conversation_id = ? AND state = 'open' LIMIT ?",
          )
          .all(
            input.conversationId,
            AGENT_JOB_PROPOSAL_MAX_OPEN_PER_CONVERSATION + 1,
          );
        if (open.length >= AGENT_JOB_PROPOSAL_MAX_OPEN_PER_CONVERSATION)
          return { outcome: 'limit-reached' as const };
        const id = randomUUID();
        db.prepare(
          `INSERT INTO agent_job_proposals (id, conversation_id, session_id,
             job_json, rationale, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`,
        ).run(
          id,
          input.conversationId,
          input.sessionId,
          JSON.stringify(input.job),
          input.rationale ?? null,
          input.now,
          input.now,
        );
        return {
          outcome: 'proposed' as const,
          proposal: readProposal(id)!,
        };
      });
    },
    jobProposal: readProposal,
    openJobProposals(conversationId: string) {
      return (
        db
          .prepare(
            "SELECT * FROM agent_job_proposals WHERE conversation_id = ? AND state = 'open' ORDER BY created_at",
          )
          .all(conversationId) as Record<string, unknown>[]
      ).map(proposalOf);
    },
    /** Jobs approved from this conversation, newest first, bounded. */
    approvedJobs(conversationId: string, limit: number) {
      return (
        db
          .prepare(
            "SELECT id, job_json FROM agent_job_proposals WHERE conversation_id = ? AND state = 'approved' ORDER BY updated_at DESC LIMIT ?",
          )
          .all(conversationId, limit) as Record<string, unknown>[]
      ).map((row) => ({
        proposalId: String(row.id),
        name: (JSON.parse(String(row.job_json)) as AgentJobProposalJob).name,
      }));
    },
    /** Settle a still-open proposal; false when it no longer is. */
    settleJobProposal(
      id: string,
      to: Exclude<AgentJobProposalState, 'open'>,
      settledBy: string,
      now: number,
    ): boolean {
      const result = db
        .prepare(
          `UPDATE agent_job_proposals SET state = ?, settled_by = ?, updated_at = ?
           WHERE id = ? AND state = 'open'`,
        )
        .run(to, settledBy, now, id) as { changes?: number | bigint };
      return Number(result.changes ?? 0) === 1;
    },
  };
}

export type AgentScheduleStore = ReturnType<
  typeof createSqliteAgentScheduleStore
>;

export interface AgentWakeUpDeliveryPorts {
  readonly store: AgentScheduleStore;
  /** Hand a due wake-up to its conversation's inbox. */
  submit(input: {
    conversationId: string;
    clientTurnId: string;
    payload: ThreadInboxPayload;
  }): ThreadInboxSubmission;
  readonly logger: {
    warn(message: string, meta?: Record<string, unknown>): void;
  };
  readonly now?: () => number;
}

/** Arms the in-memory timers for the durable wake-ups, and sends them. */
export class AgentWakeUpDelivery {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private stopped = false;

  constructor(private readonly ports: AgentWakeUpDeliveryPorts) {}

  private now(): number {
    return this.ports.now?.() ?? Date.now();
  }

  /**
   * Validate and record one wake-up for the caller's own conversation, then
   * arm it. Every bound is a refusal: nothing is clamped or cut short.
   */
  schedule(input: {
    conversationId: string;
    sessionId: string;
    actor: AgentWakeUpActor;
    note: string;
    delayMs: number;
  }): ScheduleWakeUpResult {
    if (this.stopped)
      return { outcome: 'refused', code: 'wake_up_unavailable' };
    if (
      !Number.isFinite(input.delayMs) ||
      input.delayMs < AGENT_WAKE_UP_MIN_DELAY_MS
    )
      return { outcome: 'refused', code: 'wake_up_too_soon' };
    if (input.delayMs > AGENT_WAKE_UP_MAX_HORIZON_MS)
      return { outcome: 'refused', code: 'wake_up_too_far' };
    if (input.note.length > AGENT_WAKE_UP_NOTE_MAX_CHARS)
      return { outcome: 'refused', code: 'wake_up_note_too_long' };
    const now = this.now();
    const record = this.ports.store.insertWakeUp({
      conversationId: input.conversationId,
      sessionId: input.sessionId,
      actor: input.actor,
      note: input.note,
      dueAtMs: now + input.delayMs,
      now,
    });
    if (record === 'limit-reached')
      return { outcome: 'refused', code: 'wake_up_limit_reached' };
    this.arm(record);
    return { outcome: 'scheduled', wakeUp: publicWakeUp(record) };
  }

  /** Cancel a pending wake-up; false when it was not pending. */
  cancel(id: string, by: 'agent' | 'person'): boolean {
    const canceled = this.ports.store.settleWakeUp(id, 'canceled', this.now(), {
      canceledBy: by,
    });
    if (canceled) this.clearTimer(id);
    return canceled;
  }

  /** Startup: re-arm every pending wake-up; due ones go now. */
  reconcile(): void {
    for (const record of this.ports.store.pendingWakeUps()) this.arm(record);
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private clearTimer(id: string): void {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
  }

  private arm(record: WakeUpRecord): void {
    if (this.stopped) return;
    this.clearTimer(record.id);
    const delay = Math.max(0, record.dueAtMs - this.now());
    const timer = setTimeout(() => {
      this.timers.delete(record.id);
      this.fire(record.id);
    }, delay);
    timer.unref?.();
    this.timers.set(record.id, timer);
  }

  /** Send one due wake-up. Exported through the class for the restart path. */
  fire(id: string): void {
    if (this.stopped) return;
    const record = this.ports.store.wakeUp(id);
    if (record?.state !== 'pending') return;
    const now = this.now();
    if (now - record.dueAtMs > AGENT_WAKE_UP_MAX_HORIZON_MS) {
      this.ports.store.settleWakeUp(id, 'failed', now, {
        reasonCode: 'expired',
      });
      return;
    }
    let submitted: ThreadInboxSubmission;
    try {
      submitted = this.ports.submit({
        conversationId: record.conversationId,
        clientTurnId: wakeUpClientTurnId(record.id),
        payload: {
          message: wakeUpMessage(record.note),
          actor: {
            userId: record.actor.userId,
            ownerAttribution: record.actor.attribution,
            ...(record.actor.principal
              ? { principal: record.actor.principal }
              : {}),
          },
          clientOrigin: AGENT_WAKE_UP_CLIENT_ORIGIN,
        },
      });
    } catch (error) {
      this.ports.logger.warn('agent wake-up could not be sent', {
        wakeUpId: id,
        error: error instanceof Error ? error.message : String(error),
      });
      this.ports.store.settleWakeUp(id, 'failed', now, {
        reasonCode: 'send_failed',
      });
      return;
    }
    if (submitted.outcome === 'queued')
      this.ports.store.settleWakeUp(id, 'sent', now);
    else
      this.ports.store.settleWakeUp(id, 'failed', now, {
        reasonCode:
          submitted.outcome === 'capacity'
            ? 'capacity'
            : submitted.outcome === 'not-permitted'
              ? 'not_permitted'
              : 'send_failed',
      });
  }
}
