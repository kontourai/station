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
 * A wake-up from an agent whose session runs unconfined (`host`) and whose
 * credential is not bound is recorded `needs_approval`: it is armed only when
 * a person approves it, and fails `not_approved` if it comes due first. At
 * fire time the scope rule is decided again for the recorded caller
 * (`admit`); a person's approval answers its `host` refusal, nothing else.
 *
 * A job proposal is a scheduled job an agent asks a person to create. The
 * scheduler's own create route approves it when a person's request names it
 * and creates exactly the job it describes (`jobMatchesProposal`). Approval
 * claims the proposal (`open` -> `approving`) before the job is created, so a
 * Decline racing it loses, and finalizes or reverts the claim after.
 */
import { randomUUID } from 'node:crypto';
import {
  AGENT_JOB_PROPOSAL_MAX_CREATED_PER_WINDOW,
  AGENT_JOB_PROPOSAL_MAX_OPEN_PER_CONVERSATION,
  AGENT_SCHEDULE_RATE_WINDOW_MS,
  AGENT_WAKE_UP_MAX_CREATED_PER_WINDOW,
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
  wakeUpClientTurnId,
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
const AGENT_WAKE_UP_CLIENT_ORIGIN: ClientOrigin = Object.freeze({
  version: CLIENT_ORIGIN_VERSION,
  actor: Object.freeze({ kind: 'internal' as const }),
  reported: UNKNOWN_CLIENT_REPORTED_ORIGIN,
});

export { wakeUpClientTurnId };

/**
 * What the agent reads when its wake-up arrives. Station's own words frame
 * it: the turn is sent as the person (the conversation's own permissions),
 * so the agent's note is quoted as the agent's, never presented as
 * something the person wrote. Every note that reaches here was either
 * scheduled from a confined session or shown to the person on the approval
 * card they accepted.
 */
export function wakeUpMessage(note: string): string {
  return `[Station] The check-back you scheduled is due. This message is from Station, not the person. Your note:\n\n${note}`;
}

/**
 * The verified caller a wake-up was scheduled by, as the scope rule reads
 * it. Recorded so the rule can be decided again when it fires.
 */
export interface AgentWakeUpCaller {
  readonly assurance: 'bound' | 'delegated-custody' | 'bearer-exposed';
  readonly sessionId?: string;
  readonly conversationId?: string;
  readonly principal?: {
    readonly id: string;
    readonly elevationEligible: boolean;
  };
  readonly localProjectId?: string;
  readonly projectIdSource?: 'session-record' | 'slug-lookup';
  readonly projectSlug?: string;
}

function parseCaller(value: unknown): AgentWakeUpCaller | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown> | null;
    const assurance = parsed?.assurance;
    if (
      assurance !== 'bound' &&
      assurance !== 'delegated-custody' &&
      assurance !== 'bearer-exposed'
    )
      return undefined;
    const principal = parsed?.principal as
      | { id?: unknown; elevationEligible?: unknown }
      | undefined;
    const str = (key: string) =>
      typeof parsed?.[key] === 'string' ? (parsed[key] as string) : undefined;
    const source = str('projectIdSource');
    return {
      assurance,
      ...(str('sessionId') ? { sessionId: str('sessionId') } : {}),
      ...(str('conversationId')
        ? { conversationId: str('conversationId') }
        : {}),
      ...(typeof principal?.id === 'string' &&
      typeof principal.elevationEligible === 'boolean'
        ? {
            principal: {
              id: principal.id,
              elevationEligible: principal.elevationEligible,
            },
          }
        : {}),
      ...(str('localProjectId')
        ? { localProjectId: str('localProjectId') }
        : {}),
      ...(source === 'session-record' || source === 'slug-lookup'
        ? { projectIdSource: source }
        : {}),
      ...(str('projectSlug') ? { projectSlug: str('projectSlug') } : {}),
    };
  } catch {
    return undefined;
  }
}

/** Only the fields the scope rule reads; nothing else is stored. */
function callerJson(caller: AgentWakeUpCaller): string {
  return JSON.stringify({
    assurance: caller.assurance,
    sessionId: caller.sessionId,
    conversationId: caller.conversationId,
    principal: caller.principal
      ? {
          id: caller.principal.id,
          elevationEligible: caller.principal.elevationEligible,
        }
      : undefined,
    localProjectId: caller.localProjectId,
    projectIdSource: caller.projectIdSource,
    projectSlug: caller.projectSlug,
  });
}

const AGENT_SCHEDULE_SCHEMA = `CREATE TABLE IF NOT EXISTS agent_wake_ups (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  actor_attribution TEXT NOT NULL,
  actor_principal_json TEXT,
  caller_json TEXT,
  note TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  state TEXT NOT NULL,
  approved_by TEXT,
  canceled_by TEXT,
  reason_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_wake_ups_conversation
  ON agent_wake_ups (conversation_id, state);
CREATE INDEX IF NOT EXISTS agent_wake_ups_pending
  ON agent_wake_ups (state, due_at);
CREATE INDEX IF NOT EXISTS agent_wake_ups_created
  ON agent_wake_ups (conversation_id, created_at);
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
  ON agent_job_proposals (conversation_id, state);
CREATE INDEX IF NOT EXISTS agent_job_proposals_created
  ON agent_job_proposals (conversation_id, created_at)`;

/** Wake-up states a person or the agent can still act on. */
const OPEN_WAKE_UP_STATES = "('needs_approval', 'pending')";
/**
 * Proposal states still waiting for a person. `approving` is an Approve in
 * flight (the job is being created); it reads as `open`.
 */
const OPEN_PROPOSAL_STATES = "('open', 'approving')";

/** Who a wake-up is sent as: the sender its creating request resolved. */
export interface AgentWakeUpActor {
  readonly userId: string;
  readonly attribution: StartOwnerAttribution;
  readonly principal?: PrincipalRef;
}

export interface WakeUpRecord extends AgentWakeUp {
  readonly sessionId: string;
  readonly actor: AgentWakeUpActor;
  /** Absent on a row Station cannot read it from: the scope rule refuses. */
  readonly caller?: AgentWakeUpCaller;
  /** The person who approved it, when it needed approval. */
  readonly approvedBy?: string;
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
  const caller = parseCaller(row.caller_json);
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
    ...(caller ? { caller } : {}),
    ...(typeof row.approved_by === 'string'
      ? { approvedBy: row.approved_by, approved: true as const }
      : {}),
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
    ...(record.approved ? { approved: true as const } : {}),
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
    // An Approve in flight is still waiting for its outcome.
    state: (row.state === 'approving'
      ? 'open'
      : String(row.state)) as AgentJobProposalState,
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
  | { readonly outcome: 'limit-reached' }
  | { readonly outcome: 'rate-limited' };

export type ApproveWakeUpResult =
  | { readonly outcome: 'approved'; readonly wakeUp: AgentWakeUp }
  /** Not waiting for approval (any more): already decided, or past due. */
  | {
      readonly outcome: 'settled';
      readonly state: AgentWakeUpState;
      readonly reasonCode?: AgentWakeUpFailureCode;
    }
  /** Delivery is stopped: nothing can be armed. */
  | { readonly outcome: 'unavailable' };

/**
 * Rows created in the window, counted one past the limit, inside the
 * caller's write transaction.
 */
function createdInWindow(
  db: TransactionalSqliteDatabase,
  table: 'agent_wake_ups' | 'agent_job_proposals',
  conversationId: string,
  now: number,
  limit: number,
): number {
  return db
    .prepare(
      `SELECT id FROM ${table} WHERE conversation_id = ? AND created_at > ? LIMIT ?`,
    )
    .all(conversationId, now - AGENT_SCHEDULE_RATE_WINDOW_MS, limit + 1).length;
}

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
      caller: AgentWakeUpCaller;
      note: string;
      dueAtMs: number;
      /** `needs_approval` waits for a person before it is armed. */
      state: 'pending' | 'needs_approval';
      now: number;
    }): WakeUpRecord | 'limit-reached' | 'rate-limited' {
      return writeTransaction(db, 'agent_wake_up_insert', () => {
        // Settled rows past the window count toward nothing; drop them.
        db.prepare(
          `DELETE FROM agent_wake_ups
            WHERE state NOT IN ${OPEN_WAKE_UP_STATES} AND updated_at <= ?`,
        ).run(input.now - AGENT_SCHEDULE_RATE_WINDOW_MS);
        const open = db
          .prepare(
            `SELECT id FROM agent_wake_ups WHERE conversation_id = ? AND state IN ${OPEN_WAKE_UP_STATES} LIMIT ?`,
          )
          .all(
            input.conversationId,
            AGENT_WAKE_UP_MAX_PENDING_PER_CONVERSATION + 1,
          );
        if (open.length >= AGENT_WAKE_UP_MAX_PENDING_PER_CONVERSATION)
          return 'limit-reached' as const;
        if (
          createdInWindow(
            db,
            'agent_wake_ups',
            input.conversationId,
            input.now,
            AGENT_WAKE_UP_MAX_CREATED_PER_WINDOW,
          ) >= AGENT_WAKE_UP_MAX_CREATED_PER_WINDOW
        )
          return 'rate-limited' as const;
        const id = randomUUID();
        db.prepare(
          `INSERT INTO agent_wake_ups (id, conversation_id, session_id,
             actor_user_id, actor_attribution, actor_principal_json,
             caller_json, note, due_at, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          input.conversationId,
          input.sessionId,
          input.actor.userId,
          input.actor.attribution,
          input.actor.principal ? JSON.stringify(input.actor.principal) : null,
          callerJson(input.caller),
          input.note,
          input.dueAtMs,
          input.state,
          input.now,
          input.now,
        );
        return readWakeUp(id)!;
      });
    },
    wakeUp: readWakeUp,
    /**
     * A conversation's wake-ups still waiting (armed, or waiting for a
     * person's approval), soonest first.
     */
    pendingWakeUps(conversationId?: string): WakeUpRecord[] {
      const rows = (
        conversationId === undefined
          ? db
              .prepare(
                `SELECT * FROM agent_wake_ups WHERE state IN ${OPEN_WAKE_UP_STATES} ORDER BY due_at`,
              )
              .all()
          : db
              .prepare(
                `SELECT * FROM agent_wake_ups WHERE conversation_id = ? AND state IN ${OPEN_WAKE_UP_STATES} ORDER BY due_at`,
              )
              .all(conversationId)
      ) as Record<string, unknown>[];
      return rows.map(wakeUpOf);
    },
    /**
     * Settle a wake-up that is still in one of `from`; false when it no
     * longer is. One conditional UPDATE, so of two racing settles exactly
     * one wins.
     */
    settleWakeUp(
      id: string,
      to: Exclude<AgentWakeUpState, 'pending' | 'needs_approval'>,
      now: number,
      detail: {
        canceledBy?: 'agent' | 'person';
        reasonCode?: AgentWakeUpFailureCode;
      } = {},
      from: 'pending' | 'needs_approval' | 'open' = 'pending',
    ): boolean {
      const states = from === 'open' ? OPEN_WAKE_UP_STATES : `('${from}')`;
      const result = db
        .prepare(
          `UPDATE agent_wake_ups
             SET state = ?, canceled_by = ?, reason_code = ?, updated_at = ?
           WHERE id = ? AND state IN ${states}`,
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
    /**
     * A person's approval: `needs_approval` -> `pending`, only while it is
     * not yet due. One conditional UPDATE, so it and a racing Decline or
     * cancel cannot both take effect.
     */
    approveWakeUp(id: string, userId: string, now: number): boolean {
      const result = db
        .prepare(
          `UPDATE agent_wake_ups SET state = 'pending', approved_by = ?, updated_at = ?
           WHERE id = ? AND state = 'needs_approval' AND due_at > ?`,
        )
        .run(userId, now, id, now) as { changes?: number | bigint };
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
        // Declined proposals past the window count toward nothing. Approved
        // ones stay: they name the jobs this conversation set up.
        db.prepare(
          `DELETE FROM agent_job_proposals WHERE state = 'declined' AND updated_at <= ?`,
        ).run(input.now - AGENT_SCHEDULE_RATE_WINDOW_MS);
        const open = db
          .prepare(
            `SELECT id FROM agent_job_proposals WHERE conversation_id = ? AND state IN ${OPEN_PROPOSAL_STATES} LIMIT ?`,
          )
          .all(
            input.conversationId,
            AGENT_JOB_PROPOSAL_MAX_OPEN_PER_CONVERSATION + 1,
          );
        if (open.length >= AGENT_JOB_PROPOSAL_MAX_OPEN_PER_CONVERSATION)
          return { outcome: 'limit-reached' as const };
        if (
          createdInWindow(
            db,
            'agent_job_proposals',
            input.conversationId,
            input.now,
            AGENT_JOB_PROPOSAL_MAX_CREATED_PER_WINDOW,
          ) >= AGENT_JOB_PROPOSAL_MAX_CREATED_PER_WINDOW
        )
          return { outcome: 'rate-limited' as const };
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
            `SELECT * FROM agent_job_proposals WHERE conversation_id = ? AND state IN ${OPEN_PROPOSAL_STATES} ORDER BY created_at`,
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
    /**
     * Move a proposal `from` one state `to` another; false when it is no
     * longer in `from`. Approve claims (`open` -> `approving`) before the
     * job is created and then finalizes (`approving` -> `approved`) or
     * reverts (`approving` -> `open`); Decline is `open` -> `declined`, so a
     * Decline racing an Approve that already claimed it changes nothing.
     */
    transitionJobProposal(
      id: string,
      from: 'open' | 'approving',
      to: 'approving' | 'approved' | 'declined' | 'open',
      settledBy: string | null,
      now: number,
    ): boolean {
      const result = db
        .prepare(
          `UPDATE agent_job_proposals SET state = ?, settled_by = ?, updated_at = ?
           WHERE id = ? AND state = ?`,
        )
        .run(to, settledBy, now, id, from) as { changes?: number | bigint };
      return Number(result.changes ?? 0) === 1;
    },
    /**
     * Startup: an Approve a restart cut short is open again. Only claims
     * made before `claimedBefore` (this process's start): an Approve this
     * process already claimed is still running. If its job was created,
     * approving again is refused by the scheduler as a duplicate name.
     * Returns how many were reopened.
     */
    reopenInterruptedApprovals(claimedBefore: number, now: number): number {
      const result = db
        .prepare(
          `UPDATE agent_job_proposals SET state = 'open', settled_by = NULL, updated_at = ?
           WHERE state = 'approving' AND updated_at < ?`,
        )
        .run(now, claimedBefore) as { changes?: number | bigint };
      return Number(result.changes ?? 0);
    },
    /** The proposal's raw state, `approving` included. */
    jobProposalState(id: string): string | undefined {
      const row = db
        .prepare('SELECT state FROM agent_job_proposals WHERE id = ?')
        .get(id) as { state?: unknown } | undefined;
      return typeof row?.state === 'string' ? row.state : undefined;
    },
  };
}

export type AgentScheduleStore = ReturnType<
  typeof createSqliteAgentScheduleStore
>;

export interface AgentWakeUpDeliveryPorts {
  readonly store: AgentScheduleStore;
  /**
   * The scope rule decided again when the wake-up fires, for the caller
   * that scheduled it: false refuses it (`not_permitted`). A person's
   * approval (`approvedBy`) answers the rule's `host` refusal, and only that.
   */
  admit(record: WakeUpRecord): boolean;
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

/** The longest delay `setTimeout` honours (2^31 - 1 ms, about 24.8 days). */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

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
    caller: AgentWakeUpCaller;
    note: string;
    delayMs: number;
    /** Recorded `needs_approval`: armed only once a person approves it. */
    needsApproval?: boolean;
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
      caller: input.caller,
      note: input.note,
      dueAtMs: now + input.delayMs,
      state: input.needsApproval ? 'needs_approval' : 'pending',
      now,
    });
    if (record === 'limit-reached')
      return { outcome: 'refused', code: 'wake_up_limit_reached' };
    if (record === 'rate-limited')
      return { outcome: 'refused', code: 'wake_up_rate_limited' };
    // A wake-up waiting for approval is armed too: at its due time it
    // settles `not_approved` if nobody approved it.
    this.arm(record);
    return { outcome: 'scheduled', wakeUp: publicWakeUp(record) };
  }

  /**
   * A person approves a wake-up waiting for it. It keeps its due time; one
   * already due, decided, or canceled is not approved.
   */
  approve(id: string, userId: string): ApproveWakeUpResult {
    if (this.stopped) return { outcome: 'unavailable' };
    const now = this.now();
    if (this.ports.store.approveWakeUp(id, userId, now)) {
      const record = this.ports.store.wakeUp(id)!;
      this.arm(record);
      return { outcome: 'approved', wakeUp: publicWakeUp(record) };
    }
    const record = this.ports.store.wakeUp(id);
    return {
      outcome: 'settled',
      state: record?.state ?? 'canceled',
      ...(record?.reasonCode ? { reasonCode: record.reasonCode } : {}),
    };
  }

  /**
   * Cancel a wake-up still waiting (armed or for approval); false when it
   * was not. A person's Decline of one waiting for approval is this too.
   */
  cancel(id: string, by: 'agent' | 'person'): boolean {
    const canceled = this.ports.store.settleWakeUp(
      id,
      'canceled',
      this.now(),
      { canceledBy: by },
      'open',
    );
    if (canceled) this.clearTimer(id);
    return canceled;
  }

  /** Startup: re-arm every waiting wake-up; due ones go now. */
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
    // Node runs a delay above its timer maximum after 1ms. A clock far
    // behind the due time waits in steps of the maximum instead, and a
    // step that ends early only arms again: it never sends.
    const capped = delay > MAX_TIMER_DELAY_MS;
    const timer = setTimeout(
      () => {
        this.timers.delete(record.id);
        if (capped) this.arm(record);
        else this.fire(record.id);
      },
      capped ? MAX_TIMER_DELAY_MS : delay,
    );
    timer.unref?.();
    this.timers.set(record.id, timer);
  }

  /** Send one due wake-up. Exported through the class for the restart path. */
  fire(id: string): void {
    if (this.stopped) return;
    const record = this.ports.store.wakeUp(id);
    const now = this.now();
    if (record?.state === 'needs_approval') {
      // A timer can fire a little early, and the wall clock can step back.
      // Before its due time it can still be approved (approval is decided
      // by the clock), so it waits again rather than being left unsettled.
      if (now < record.dueAtMs) {
        this.arm(record);
        return;
      }
      // Not approved before it came due: never sent.
      this.ports.store.settleWakeUp(
        id,
        'failed',
        now,
        { reasonCode: 'not_approved' },
        'needs_approval',
      );
      return;
    }
    // `pending` goes when its timer fires, even a moment before `dueAtMs`
    // by the clock: the timer measures the delay that was asked for.
    if (record?.state !== 'pending') return;
    if (now - record.dueAtMs > AGENT_WAKE_UP_MAX_HORIZON_MS) {
      this.ports.store.settleWakeUp(id, 'failed', now, {
        reasonCode: 'expired',
      });
      return;
    }
    let admitted: boolean;
    try {
      admitted = this.ports.admit(record);
    } catch {
      admitted = false;
    }
    if (!admitted) {
      this.ports.store.settleWakeUp(id, 'failed', now, {
        reasonCode: 'not_permitted',
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
