/**
 * #3568: a conversation's durable inbox for follow-ups sent while its turn
 * runs.
 *
 * Today a client holds such a message itself (per-tab session storage, the
 * IndexedDB outbox) and sends it when it sees `turn.completed`, so the
 * follow-up goes only if that app stays open. A sender that opts in
 * (`POST /chat` with `whenBusy: 'queue'`) hands it to Station instead: the
 * entry is committed before the route answers, and Station sends it itself
 * when the turn ends, across a closed tab, another device or a restart.
 *
 * The rules (idempotency by key and digest, FIFO, one placement in flight,
 * a possible effect never placed again) are Monument's `inbox` machine,
 * run through its `node:sqlite` adapter on EventStore's own connection. This
 * module owns what is Station's:
 *
 * - The payload: the message and the sender as the route resolved it (user,
 *   principal, owner attribution, client origin). Placement replays exactly
 *   that actor, never a stronger one, through the continuation seam
 *   (`continueExecutionTargetMessage`) that `/chat/:id/continue`, Discord and
 *   delegated results use. A per-request full-access grant is never stored:
 *   an engine restarted to take a queued follow-up starts confined.
 * - When to place. A follow-up is placed after its conversation's current
 *   Session ends a turn: on each persisted fold event (the bus publishes after
 *   the append), after each submit (the turn may have ended before it
 *   committed), at startup, and on bounded re-checks for a live "busy" flag
 *   that outlives its terminal.
 * - What a placement did. The Session targeted is recorded before the effect
 *   (`placing`), and the start carries the entry's key as its `clientTurnId`.
 *   Turn deduplication is per Session (Monument's `turnDedup`, #3559), and a
 *   continuation can reserve a successor Session when the one it targeted has
 *   ended, so before every start the turn ledger is read for the key across
 *   the whole conversation (`startUnlessDelivered`):
 *     - `started` on any Session: `placed`, and nothing is sent again;
 *     - begun or unknown (`indeterminate`, `expired`): `unconfirmed`:
 *       surfaced, never placed again, and later entries wait behind it until
 *       someone who may send dismisses it;
 *     - a live claim (`received`): back to the queue, looked at again later;
 *     - no Session holds it (including a dead owner that never began): sent,
 *       once, wherever the conversation continues now.
 *   A start that has not answered by its deadline is `unconfirmed`
 *   (`start_deadline`); the next drive reads the ledger again and settles it
 *   `placed` if it started, or queues it again if no Session took it.
 *
 * Steer and display-only entries, and a stale-head check, are not here yet.
 */
import { createHash } from 'node:crypto';
import {
  type ConversationKeyInspection,
  type InboxCancelResult,
  type InboxEntryRecord,
  type InboxSubmitResult,
  inboxHead,
  type KernelCommand,
  type KernelResults,
  type OwnerLiveness,
  type SessionStartResult,
  startUnlessDelivered,
} from '@kontourai/monument';
import {
  openSqliteKernelStorage,
  type SqliteKernelTables,
} from '@kontourai/monument/sqlite';
import {
  type ClientOrigin,
  isClientOrigin,
} from '@kontourai/station-contracts/client-origin';
import type { ExecutionModelRequest } from '@kontourai/station-contracts/execution-target';
import {
  CONTINUATION_WORKSPACE_REFUSAL_CODES,
  EXECUTION_ENGINE_CHANGED_CODE,
} from '@kontourai/station-contracts/execution-target';
import type {
  ConversationInboxEntry,
  ConversationInboxEntryState,
  TurnDeliveryOutcome,
} from '@kontourai/station-contracts/orchestration';
import {
  isPrincipalRef,
  type PrincipalRef,
} from '@kontourai/station-contracts/principal';
import {
  CLIENT_TURN_IN_FLIGHT_CODE,
  MODEL_NOT_ADVERTISED_CODE,
  MUSE_TURN_SLOT_RELEASING_CODE,
  PROVIDER_SESSION_START_FAILED_CODE,
  PROVIDER_SESSION_STARTING_CODE,
  PROVIDER_TURN_IN_PROGRESS_CODE,
} from '@kontourai/station-contracts/provider';
import { SESSION_ENDED_REJECTION_CODE } from '@kontourai/station-contracts/session-lifecycle';
import { ClientTurnInputConflictError } from '../../providers/adapter-shape.js';
import { turnIdentityAnchorForEvents } from './session-lifecycle-service.js';
import type { StartOwnerAttribution } from './session-owner-attribution.js';
import type { SessionTurnBoundaryAuthority } from './session-turn-boundary.js';
import {
  evaluateSessionWait,
  type SessionTurnWaitPorts,
  type SessionWaitFoldEvent,
} from './session-turn-wait.js';
import type { SqliteDatabase } from './sqlite-database.js';

/** The inbox is the only machine this kernel storage keeps. */
const THREAD_INBOX_KERNEL_TABLES: SqliteKernelTables = {
  turnDedup: 'unused',
  requestKeys: 'unused',
  turnBoundary: 'unused',
};

/** No inbox command asks about owner liveness. */
const NO_LIVENESS: OwnerLiveness = () => 'unknown';

/**
 * Events after which a waiting follow-up may now be placeable: a turn's
 * start or end, and a Session becoming ready or changing state (a start that
 * was still in progress ends with no turn terminal).
 */
const TRIGGER_METHODS: ReadonlySet<string> = new Set([
  'turn.started',
  'turn.completed',
  'turn.aborted',
  'runtime.error',
  'session.exited',
  'session.started',
  'session.configured',
  'session.state-changed',
]);

/**
 * Refusals that say only "not now": nothing was sent, and the same send
 * succeeds once the Session is free. The entry goes back to the queue.
 */
const BUSY_REFUSAL_CODES: ReadonlySet<string> = new Set([
  PROVIDER_TURN_IN_PROGRESS_CODE,
  PROVIDER_SESSION_STARTING_CODE,
  MUSE_TURN_SLOT_RELEASING_CODE,
  'session_start_in_flight',
  'resource_engine_start_capacity',
]);

/** Delays of the bounded re-checks after a busy wait or a held key. */
const RETRY_DELAYS_MS = [2_000, 10_000, 30_000, 120_000] as const;

/** Who sent a queued follow-up, as the route resolved them. */
export interface ThreadInboxActor {
  readonly userId: string;
  readonly principal?: PrincipalRef;
  readonly ownerAttribution?: StartOwnerAttribution;
}

/** What a queued follow-up sends: the continuation's input, and its sender. */
export interface ThreadInboxPayload {
  readonly message: string;
  /** Original server-captured identity; older queued entries have unknown proof. */
  readonly inputDigest?: string;
  readonly ambientContext?: string;
  readonly model?: ExecutionModelRequest;
  readonly actor: ThreadInboxActor;
  readonly clientOrigin?: ClientOrigin;
}

/** JSON with object keys sorted, so equal inputs digest equally. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  return JSON.stringify(value ?? null);
}

/**
 * The digest a reused key must match: who sent it and everything that
 * changes what the engine receives. The client origin is not part of it: the
 * same message resent from another surface is the same submission.
 */
function threadInboxDigest(payload: ThreadInboxPayload): string {
  return createHash('sha256')
    .update(
      canonicalJson([
        payload.actor.userId,
        payload.message,
        payload.ambientContext ?? null,
        payload.model ?? null,
      ]),
    )
    .digest('hex');
}

function decodePayload(raw: string): ThreadInboxPayload | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const value = parsed as Record<string, unknown> | null;
  const actor = value?.actor as Record<string, unknown> | undefined;
  if (typeof value?.message !== 'string' || typeof actor?.userId !== 'string')
    return undefined;
  const attribution = actor.ownerAttribution;
  return {
    message: value.message,
    ...(typeof value.inputDigest === 'string'
      ? { inputDigest: value.inputDigest }
      : {}),
    ...(typeof value.ambientContext === 'string'
      ? { ambientContext: value.ambientContext }
      : {}),
    ...(value.model && typeof value.model === 'object'
      ? { model: value.model as ExecutionModelRequest }
      : {}),
    actor: {
      userId: actor.userId,
      ...(isPrincipalRef(actor.principal)
        ? { principal: actor.principal }
        : {}),
      // Only the two values a start knows; anything else replays as none,
      // which the start then reads as no stronger than unattributed.
      ...(attribution === 'verified-bound' ||
      attribution === 'unattributed-agent'
        ? { ownerAttribution: attribution as StartOwnerAttribution }
        : {}),
    },
    ...(isClientOrigin(value.clientOrigin)
      ? { clientOrigin: value.clientOrigin }
      : {}),
  };
}

/** Existing FIFO acceptance, returned only after the caller's read/send checks. */
export class ConversationTurnQueuedError extends Error {
  constructor(
    readonly entry: ConversationInboxEntry & { clientTurnId: string },
  ) {
    super('This message is already waiting in the conversation inbox.');
    this.name = 'ConversationTurnQueuedError';
  }
}

/** What a settled entry recorded about its effect. */
interface PlacementOutcome {
  readonly turnId?: string;
  readonly sessionId?: string;
  /** A stable code (`not_permitted`, `may_have_been_sent`, an error code). */
  readonly reasonCode?: string;
  /** A fixed, user-facing message; never raw error text. */
  readonly reason?: string;
}

function decodeOutcome(raw: string | null): PlacementOutcome {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      ...(typeof parsed.turnId === 'string' ? { turnId: parsed.turnId } : {}),
      ...(typeof parsed.sessionId === 'string'
        ? { sessionId: parsed.sessionId }
        : {}),
      ...(typeof parsed.reasonCode === 'string'
        ? { reasonCode: parsed.reasonCode }
        : {}),
      ...(typeof parsed.reason === 'string' ? { reason: parsed.reason } : {}),
    };
  } catch {
    return {};
  }
}

const PUBLIC_STATE: Record<
  InboxEntryRecord['state'],
  ConversationInboxEntryState
> = {
  queued: 'queued',
  placing: 'sending',
  placed: 'sent',
  unconfirmed: 'unconfirmed',
  refused: 'refused',
  cancelled: 'cancelled',
};

/** The public projection of one entry; `position` among those still waiting. */
function projectThreadInboxEntry(
  entry: InboxEntryRecord,
  position?: number,
): ConversationInboxEntry {
  const payload = decodePayload(entry.payload);
  const outcome = decodeOutcome(entry.outcome);
  const sessionId = outcome.sessionId ?? entry.placement ?? undefined;
  return {
    conversationId: entry.inboxId,
    clientTurnId: entry.key,
    kind: entry.kind,
    state: PUBLIC_STATE[entry.state],
    ...(position !== undefined ? { position } : {}),
    message: payload?.message ?? '',
    createdAt: new Date(entry.createdAt).toISOString(),
    updatedAt: new Date(entry.updatedAt).toISOString(),
    ...(outcome.turnId ? { turnId: outcome.turnId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(outcome.reasonCode ? { reasonCode: outcome.reasonCode } : {}),
    ...(outcome.reason ? { reason: outcome.reason } : {}),
  };
}

/**
 * States in which an entry may still be sent: waiting, being sent, or
 * `unconfirmed` (a start abandoned at its deadline may be queued again).
 */
const MAY_STILL_SEND: ReadonlySet<InboxEntryRecord['state']> = new Set([
  'queued',
  'placing',
  'unconfirmed',
]);

/** Positions (1 = next) of the entries still waiting, by key. */
function waitingPositions(
  entries: readonly InboxEntryRecord[],
): Map<string, number> {
  const positions = new Map<string, number>();
  for (const entry of entries)
    if (
      entry.state === 'queued' ||
      entry.state === 'placing' ||
      entry.state === 'unconfirmed'
    )
      positions.set(entry.key, positions.size + 1);
  return positions;
}

/**
 * The storage half: Monument's inbox commands over EventStore's connection.
 * Every call is one transaction of its own, except `forget`, which joins the
 * transaction the caller holds.
 */
export function createSqliteThreadInboxStore(db: SqliteDatabase) {
  const kernel = openSqliteKernelStorage({
    database: db,
    tables: THREAD_INBOX_KERNEL_TABLES,
  });
  const run = <C extends KernelCommand>(
    command: C,
  ): KernelResults[C['type']] => {
    const result = kernel.executeSync(command, { liveness: NO_LIVENESS });
    // Only a participant refuses a command, and this storage has none.
    if (result.kind === 'refused' && 'participant' in result)
      throw new Error(`thread inbox: ${command.type} was refused.`);
    return result as KernelResults[C['type']];
  };
  return {
    submit(input: {
      conversationId: string;
      clientTurnId: string;
      payload: ThreadInboxPayload;
      now: number;
    }): InboxSubmitResult {
      return run({
        type: 'inbox.submit',
        inboxId: input.conversationId,
        key: input.clientTurnId,
        kind: 'follow-up',
        digest: threadInboxDigest(input.payload),
        payload: JSON.stringify(input.payload),
        now: input.now,
      });
    },
    claimNext(conversationId: string, placement: string, now: number) {
      return run({
        type: 'inbox.claimNext',
        inboxId: conversationId,
        placement,
        now,
      });
    },
    settle(
      entry: InboxEntryRecord,
      to: 'placed' | 'unconfirmed' | 'refused',
      outcome: PlacementOutcome,
      now: number,
    ) {
      return run({
        type: 'inbox.settle',
        inboxId: entry.inboxId,
        key: entry.key,
        to,
        outcome: JSON.stringify(outcome),
        now,
      });
    },
    release(entry: InboxEntryRecord, keepPlacement: boolean, now: number) {
      return run({
        type: 'inbox.release',
        inboxId: entry.inboxId,
        key: entry.key,
        keepPlacement,
        now,
      });
    },
    resolveUnconfirmed(
      entry: InboxEntryRecord,
      to: 'placed' | 'queued',
      outcome: PlacementOutcome,
      now: number,
    ) {
      return run({
        type: 'inbox.resolveUnconfirmed',
        inboxId: entry.inboxId,
        key: entry.key,
        to,
        outcome: JSON.stringify(outcome),
        now,
      });
    },
    cancel(
      conversationId: string,
      clientTurnId: string,
      now: number,
    ): InboxCancelResult {
      return run({
        type: 'inbox.cancel',
        inboxId: conversationId,
        key: clientTurnId,
        now,
      });
    },
    read(conversationId: string, clientTurnId: string) {
      const result = run({
        type: 'inbox.read',
        inboxId: conversationId,
        key: clientTurnId,
      });
      return result.kind === 'found' ? result.entry : undefined;
    },
    readPendingSubmission(conversationId: string, clientTurnId: string) {
      const result = run({
        type: 'inbox.read',
        inboxId: conversationId,
        key: clientTurnId,
      });
      if (result.kind !== 'found' || !MAY_STILL_SEND.has(result.entry.state))
        return undefined;
      const payload = decodePayload(result.entry.payload);
      if (!payload)
        throw new Error('Station could not read this queued message.');
      return {
        entry: {
          ...projectThreadInboxEntry(result.entry),
          clientTurnId: result.entry.key,
        },
        userId: payload.actor.userId,
        ...(payload.inputDigest !== undefined
          ? { inputDigest: payload.inputDigest }
          : {}),
      };
    },
    list(conversationId: string): readonly InboxEntryRecord[] {
      return run({ type: 'inbox.list', inboxId: conversationId }).entries;
    },
    listOpen(): readonly InboxEntryRecord[] {
      return run({ type: 'inbox.listOpen' }).entries;
    },
    /** Forget a deleted conversation's entries, inside the caller's transaction. */
    forget(conversationId: string): void {
      kernel.executeSync(
        { type: 'inbox.forget', inboxId: conversationId },
        { liveness: NO_LIVENESS },
        { withinHostTransaction: true },
      );
    },
  };
}

export type ThreadInboxStore = ReturnType<typeof createSqliteThreadInboxStore>;

export interface ThreadInboxDeliveryPorts {
  readonly store: ThreadInboxStore;
  /** A Session's lifecycle fold events, oldest first (`ACTIVE_TURN_FOLD_METHODS`). */
  foldEvents(threadId: string): readonly SessionWaitFoldEvent[];
  headSequence(threadId: string): number;
  /** Whether the live coordinator holds a turn the log has not shown yet. */
  coordinatorBusy(threadId: string): boolean;
  /** Fresh input placement only; never requested-work acknowledgement. */
  hasPossibleEffect?: SessionTurnBoundaryAuthority['hasPossibleEffect'];
  readInputlessTurnDisposition?: SessionTurnWaitPorts['readInputlessTurnDisposition'];
  readInvocationTerminal?: SessionTurnWaitPorts['readInvocationTerminal'];
  /** The conversation a Session belongs to (itself when it has none). */
  conversationOf(threadId: string): string;
  /** A conversation's current execution Session. */
  currentSessionId(conversationId: string): string;
  /**
   * Whether `userId` may send to the conversation now, by the same rule a
   * live `POST /chat` continuation applies (its recorded owner, or a reader
   * a personal Station lets continue it).
   */
  mayContinue(conversationId: string, userId: string): boolean;
  /**
   * Whether a paired device or personal access token is still unrevoked and
   * still holds the scope a live send needs, and (account-tied) its account
   * is enabled and not signed out everywhere at or after `since`, the time
   * the entry was queued. A device-sent entry is refused without it (fail
   * closed).
   */
  deviceMaySend?(deviceId: string, since: number): boolean;
  /** The turn ledger's answer for the key across the whole conversation. */
  inspectDelivery(
    conversationId: string,
    clientTurnId: string,
    inputDigest?: string,
    userId?: string,
  ): ConversationKeyInspection;
  /**
   * Continue the conversation with the entry's input, as its recorded actor.
   * Throws only when the start was refused before any effect; an uncertain
   * outcome is `indeterminate`.
   */
  start(input: {
    readonly conversationId: string;
    readonly threadId: string;
    readonly payload: ThreadInboxPayload;
    readonly clientTurnId: string;
  }): Promise<SessionStartResult>;
  /** Called after each canonical event is persisted; returns the unsubscribe. */
  subscribe(
    listener: (event: { threadId: string; method: string }) => void,
  ): () => void;
  readonly logger: {
    warn(message: string, meta?: Record<string, unknown>): void;
  };
  /** Test seams. */
  readonly retryDelaysMs?: readonly number[];
  /** Re-checks while entries wait; the last delay repeats up to this many. */
  readonly maxRetries?: number;
  /** How long one start may take before the entry is `unconfirmed`. */
  readonly placementDeadlineMs?: number;
  readonly now?: () => number;
}

export type ThreadInboxSubmission =
  | { readonly outcome: 'queued'; readonly entry: ConversationInboxEntry }
  /** The key names a different message. Nothing was written. */
  | { readonly outcome: 'conflict' }
  | { readonly outcome: 'capacity'; readonly limit: number }
  /**
   * Placement would refuse this sender; nothing was written, and the caller
   * sends it the live way (which refuses it at once).
   */
  | { readonly outcome: 'not-permitted' };

export type ThreadInboxCancel =
  | InboxCancelResult
  /** Not the caller's to withdraw (or dismiss); reads as missing. */
  | { readonly kind: 'forbidden' };

function errorCodeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The refusal codes an entry may record as its `reasonCode`, a closed list:
 * the start refusals a continuation can answer with, by their contract
 * names. Anything else is `start_refused`, so a reader never sees a code
 * nobody documented. The inbox's own codes are set where they arise:
 * `not_permitted`, `device_not_permitted`, `may_have_been_sent`,
 * `start_deadline` and `unreadable_entry`.
 */
const START_REFUSAL_CODES: ReadonlySet<string> = new Set([
  SESSION_ENDED_REJECTION_CODE,
  EXECUTION_ENGINE_CHANGED_CODE,
  PROVIDER_SESSION_START_FAILED_CODE,
  MODEL_NOT_ADVERTISED_CODE,
  // Every `ContinuationWorkspaceError` code: its type is this list's.
  ...CONTINUATION_WORKSPACE_REFUSAL_CODES,
]);

/**
 * What a refused start records: an allowed code and a fixed message, never
 * the error's own text (which every reader of the inbox would see).
 */
function refusalOf(error: unknown): PlacementOutcome {
  const code = errorCodeOf(error);
  return {
    reasonCode: code && START_REFUSAL_CODES.has(code) ? code : 'start_refused',
    reason: 'Station could not send this message. Nothing was sent.',
  };
}

const DEADLINE = Symbol('thread-inbox-placement-deadline');

/** Fallback re-check bound: the last delay repeats this many times at most. */
const MAX_RETRIES = 30;
/** A start that has not answered by then is treated as possibly sent. */
const PLACEMENT_DEADLINE_MS = 10 * 60 * 1000;

export class ThreadInboxDelivery {
  /** One drive per conversation; `again` re-runs it when an event lands mid-drive. */
  private readonly drives = new Map<
    string,
    { run: Promise<void>; again: boolean }
  >();
  /**
   * The periodic re-check per conversation: `fired` counts timer firings
   * only, and survives until a placement clears it or a newly accepted
   * message resets it, so a re-check call past the cap never starts the
   * count again.
   */
  private readonly retries = new Map<
    string,
    {
      fired: number;
      redrive: boolean;
      timer: ReturnType<typeof setTimeout> | undefined;
    }
  >();
  /**
   * Keys this process is starting, per conversation, from before the start
   * begins until it answers, including past its deadline. While one is here
   * the ledger cannot be trusted: a cold start claims the key only once its
   * Session exists, so `not-received` would let a second send of it run (a
   * re-queue, or a live send). A restart empties it, and the old process is
   * gone with its start, so the ledger is trusted then.
   */
  private readonly startsInProgress = new Map<string, Set<string>>();
  private unsubscribe: (() => void) | undefined;
  private stopped = false;

  constructor(private readonly ports: ThreadInboxDeliveryPorts) {}

  private now(): number {
    return this.ports.now?.() ?? Date.now();
  }

  /** The inbox id: a conversation, whichever of its Sessions a caller named. */
  private inboxOf(conversationId: string): string {
    return this.ports.conversationOf(conversationId);
  }

  /** Follow persisted events from now on. */
  start(): void {
    this.unsubscribe ??= this.ports.subscribe(({ threadId, method }) => {
      if (!TRIGGER_METHODS.has(method)) return;
      try {
        this.drive(this.ports.conversationOf(threadId), false);
      } catch (error) {
        this.ports.logger.warn('thread inbox delivery failed', {
          error: errorText(error),
        });
      }
    });
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const { timer } of this.retries.values())
      if (timer) clearTimeout(timer);
    this.retries.clear();
  }

  /** Every drive in flight has finished (tests and orderly shutdown). */
  async idle(): Promise<void> {
    while (this.drives.size > 0)
      await Promise.allSettled([...this.drives.values()].map((d) => d.run));
  }

  /** Startup: place what a restart left queued, and re-drive what was placing. */
  async reconcile(): Promise<void> {
    const conversations = new Set(
      this.ports.store.listOpen().map((entry) => entry.inboxId),
    );
    for (const conversationId of conversations)
      this.drive(conversationId, true);
    await this.idle();
  }

  /**
   * Whether a send to this conversation must wait in its inbox: its current
   * Session is running a turn, or earlier follow-ups are still waiting (a new
   * one never overtakes them).
   */
  mustQueue(conversationId: string): boolean {
    const inbox = this.inboxOf(conversationId);
    if (this.isBusy(this.ports.currentSessionId(inbox))) return true;
    return this.ports.store
      .list(inbox)
      .some(
        (entry) =>
          entry.state === 'queued' ||
          entry.state === 'placing' ||
          entry.state === 'unconfirmed',
      );
  }

  private inspectDelivery(
    conversationId: string,
    clientTurnId: string,
    payload: ThreadInboxPayload,
  ) {
    const inspection = this.ports.inspectDelivery(
      conversationId,
      clientTurnId,
      payload.inputDigest,
      payload.actor.userId,
    );
    if (inspection === null || inspection === undefined)
      throw new Error('The requested conversation is unavailable.');
    return inspection;
  }

  /**
   * Accept a follow-up, durable before this returns, and try to place it. A
   * sender placement would refuse is never accepted.
   */
  submit(input: {
    conversationId: string;
    clientTurnId: string;
    payload: ThreadInboxPayload;
  }): ThreadInboxSubmission {
    const inbox = this.inboxOf(input.conversationId);
    const now = this.now();
    if (this.refusalFor(inbox, input.payload, now))
      return { outcome: 'not-permitted' };
    this.inspectDelivery(inbox, input.clientTurnId, input.payload);
    const prior = this.ports.store.read(inbox, input.clientTurnId);
    const priorDigest = prior
      ? decodePayload(prior.payload)?.inputDigest
      : undefined;
    if (
      priorDigest !== undefined &&
      input.payload.inputDigest !== undefined &&
      priorDigest !== input.payload.inputDigest
    )
      throw new ClientTurnInputConflictError();
    const result = this.ports.store.submit({
      ...input,
      conversationId: inbox,
      now,
    });
    if (result.kind === 'conflict') return { outcome: 'conflict' };
    if (result.kind === 'capacity')
      return { outcome: 'capacity', limit: result.limit };
    // A newly accepted message gets the full re-check budget again, even if
    // an earlier one spent it.
    if (result.kind === 'accepted') this.resetRetryBudget(inbox);
    // The turn may have ended before this committed: look once now.
    this.drive(inbox, false);
    return {
      outcome: 'queued',
      entry:
        this.project(inbox, result.entry.key) ??
        projectThreadInboxEntry(result.entry),
    };
  }

  /**
   * Every retained entry of the conversation, in the order they are sent.
   * The key of someone else's entry that may still be sent (`queued`,
   * `sending`, or `unconfirmed`, which a later drive may queue again) is
   * left out for `viewerUserId`.
   */
  list(
    conversationId: string,
    viewerUserId?: string,
  ): ConversationInboxEntry[] {
    const entries = this.ports.store.list(this.inboxOf(conversationId));
    const positions = waitingPositions(entries);
    return entries.map((entry) => {
      const projected = projectThreadInboxEntry(
        entry,
        positions.get(entry.key),
      );
      if (
        viewerUserId === undefined ||
        !MAY_STILL_SEND.has(entry.state) ||
        decodePayload(entry.payload)?.actor.userId === viewerUserId
      )
        return projected;
      const { clientTurnId: _hidden, ...withoutKey } = projected;
      return withoutKey;
    });
  }

  /**
   * Whether the inbox holds `clientTurnId` for someone other than `userId`
   * in a state it may still send (`queued`, `sending`, `unconfirmed`). A
   * live send under that key would take the turn claim the entry waits for,
   * so `/chat` refuses it.
   */
  heldByOther(
    conversationId: string,
    clientTurnId: string,
    userId: string,
  ): boolean {
    const record = this.ports.store.read(
      this.inboxOf(conversationId),
      clientTurnId,
    );
    return (
      record !== undefined &&
      MAY_STILL_SEND.has(record.state) &&
      decodePayload(record.payload)?.actor.userId !== userId
    );
  }

  /**
   * Whether this process is starting `clientTurnId` now, before or after its
   * deadline. The ledger may not hold the key yet, so a live send under it
   * would be a second send; `/chat` and `/chat/:id/continue` refuse it.
   */
  inFlight(conversationId: string, clientTurnId: string): boolean {
    return (
      this.startsInProgress
        .get(this.inboxOf(conversationId))
        ?.has(clientTurnId) === true
    );
  }

  /** One entry as `list` shows it. */
  entry(
    conversationId: string,
    clientTurnId: string,
  ): ConversationInboxEntry | undefined {
    const inbox = this.inboxOf(conversationId);
    const record = this.ports.store.read(inbox, clientTurnId);
    if (!record) return undefined;
    return this.project(inbox, clientTurnId) ?? projectThreadInboxEntry(record);
  }

  /**
   * What the delivery lookup says of a key the inbox holds, or undefined when
   * the inbox has nothing to add (the turn ledger answers for a sent one).
   */
  deliveryOutcome(
    conversationId: string,
    clientTurnId: string,
    userId: string,
  ):
    | Extract<TurnDeliveryOutcome, 'queued' | 'received' | 'indeterminate'>
    | undefined {
    const record = this.ports.store.read(
      this.inboxOf(conversationId),
      clientTurnId,
    );
    if (!record || decodePayload(record.payload)?.actor.userId !== userId)
      return undefined;
    switch (record.state) {
      case 'queued':
        return 'queued';
      case 'placing':
        return 'received';
      case 'unconfirmed':
        return 'indeterminate';
      default:
        return undefined;
    }
  }

  /**
   * Withdraw a waiting entry (its sender only), or dismiss one that is
   * `unconfirmed` or `refused` (anyone who may send to the conversation:
   * otherwise one person's possibly-sent message would hold everyone's).
   */
  cancel(
    conversationId: string,
    clientTurnId: string,
    callerUserId: string,
  ): ThreadInboxCancel {
    const inbox = this.inboxOf(conversationId);
    const record = this.ports.store.read(inbox, clientTurnId);
    if (!record) return { kind: 'missing' };
    const sender = decodePayload(record.payload)?.actor.userId;
    const dismissal =
      record.state === 'unconfirmed' || record.state === 'refused';
    const allowed = dismissal
      ? sender === callerUserId || this.ports.mayContinue(inbox, callerUserId)
      : sender === callerUserId;
    if (!allowed) return { kind: 'forbidden' };
    const result = this.ports.store.cancel(inbox, clientTurnId, this.now());
    // A dismissed head unblocks what waited behind it.
    if (result.kind === 'cancelled') this.drive(inbox, false);
    return result;
  }

  /**
   * Why placement would refuse this sender now: the live send rule, and a
   * device that is still paired and still holds the scope to send.
   */
  private refusalFor(
    conversationId: string,
    payload: ThreadInboxPayload,
    since: number,
  ): PlacementOutcome | undefined {
    if (!this.ports.mayContinue(conversationId, payload.actor.userId))
      return {
        reasonCode: 'not_permitted',
        reason:
          'The person who queued this may no longer send to this conversation.',
      };
    const actor = payload.clientOrigin?.actor;
    if (
      actor?.kind === 'device' &&
      this.ports.deviceMaySend?.(actor.deviceId, since) !== true
    )
      return {
        reasonCode: 'device_not_permitted',
        reason:
          'The device that queued this was removed, or may no longer send.',
      };
    return undefined;
  }

  private project(
    inbox: string,
    clientTurnId: string,
  ): ConversationInboxEntry | undefined {
    const entries = this.ports.store.list(inbox);
    const record = entries.find((entry) => entry.key === clientTurnId);
    return record
      ? projectThreadInboxEntry(
          record,
          waitingPositions(entries).get(record.key),
        )
      : undefined;
  }

  private isBusy(threadId: string): boolean {
    if (this.ports.coordinatorBusy(threadId)) return true;
    const durable = this.ports.hasPossibleEffect?.(threadId);
    if (durable?.kind !== 'available' || durable.active) return true;
    const events = this.ports.foldEvents(threadId);
    const idle = evaluateSessionWait(
      {
        foldEvents: () => events,
        headSequence: (thread) => this.ports.headSequence(thread),
        coordinatorBusy: (thread) => this.ports.coordinatorBusy(thread),
        readInvocationTerminal: this.ports.readInvocationTerminal,
        readInputlessTurnDisposition: this.ports.readInputlessTurnDisposition,
      },
      threadId,
      'idle',
      0,
    );
    if (idle.satisfied) return false;
    const anchor = turnIdentityAnchorForEvents(
      events.map(({ event }) => event),
    );
    // Guarded recovery may dispose a captured effect without an ordinary ACK.
    // A later provider/legacy start remains busy under the shared anchor policy.
    return typeof anchor !== 'object' || anchor.turnId !== idle.view.openTurnId;
  }

  /**
   * Run the conversation's placement loop, one at a time. An event that lands
   * while it runs makes it look again when it finishes. `redrive` (startup,
   * or a re-check after a drive failed) lets it re-drive a `placing` head.
   */
  private drive(conversationId: string, redrive: boolean): void {
    if (this.stopped) return;
    const running = this.drives.get(conversationId);
    if (running) {
      running.again = true;
      return;
    }
    const state = { run: Promise.resolve(), again: false };
    state.run = (async () => {
      let first = true;
      while (first || state.again) {
        state.again = false;
        try {
          await this.place(conversationId, first && redrive);
        } catch (error) {
          // A store write failed mid-placement (the entry may be left
          // `placing`): look again later, re-driving it under its key.
          this.ports.logger.warn('thread inbox delivery failed', {
            conversationId,
            error: errorText(error),
          });
          this.scheduleRetry(conversationId, true);
        }
        first = false;
        if (this.stopped) break;
      }
    })().finally(() => this.drives.delete(conversationId));
    this.drives.set(conversationId, state);
  }

  /** The start, bounded: past the deadline it may still reach the engine. */
  private async startWithin(
    conversationId: string,
    clientTurnId: string,
    begin: () => Promise<SessionStartResult>,
  ): Promise<SessionStartResult | typeof DEADLINE> {
    // In progress from before it begins until it answers: a cold start
    // claims the key only once its Session exists, so until then only this
    // set knows a send of it is under way.
    const keys = this.startsInProgress.get(conversationId) ?? new Set<string>();
    keys.add(clientTurnId);
    this.startsInProgress.set(conversationId, keys);
    let abandoned = false;
    const answered = () => {
      keys.delete(clientTurnId);
      if (keys.size === 0 && this.startsInProgress.get(conversationId) === keys)
        this.startsInProgress.delete(conversationId);
      // Abandoned at its deadline: now that it answered, read the ledger.
      if (abandoned) this.drive(conversationId, false);
    };
    let work: Promise<SessionStartResult>;
    try {
      work = begin();
    } catch (error) {
      answered();
      throw error;
    }
    const tracked = work.finally(answered);
    // An abandoned start may still settle; its answer is the ledger's now.
    tracked.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<typeof DEADLINE>((resolve) => {
      timer = setTimeout(() => {
        abandoned = true;
        resolve(DEADLINE);
      }, this.ports.placementDeadlineMs ?? PLACEMENT_DEADLINE_MS);
      timer.unref?.();
    });
    try {
      return await Promise.race([tracked, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * An entry abandoned at its start deadline, judged again from the ledger:
   * `started` anywhere settles it `placed`; no Session holding the key (the
   * abandoned start never claimed it, or was refused cleanly) queues it
   * again, but only once a start this process abandoned has answered.
   * Anything else leaves it `unconfirmed`. Returns whether it moved.
   */
  private resolveAbandoned(
    conversationId: string,
    head: InboxEntryRecord,
  ): boolean {
    if (decodeOutcome(head.outcome).reasonCode !== 'start_deadline')
      return false;
    const payload = decodePayload(head.payload);
    if (!payload)
      throw new Error('Station could not read this queued message.');
    const held = this.inspectDelivery(conversationId, head.key, payload);
    if (held?.outcome === 'started') {
      this.ports.store.resolveUnconfirmed(
        head,
        'placed',
        { turnId: held.turnId, sessionId: held.sessionId },
        this.now(),
      );
      return true;
    }
    // `not-received` proves nothing while the abandoned start still runs in
    // this process (a cold start claims the key only once its Session
    // exists): queuing it again would start it a second time alongside it.
    if (
      held?.outcome === 'not-received' &&
      !this.startsInProgress.get(conversationId)?.has(head.key)
    ) {
      this.ports.store.resolveUnconfirmed(head, 'queued', {}, this.now());
      return true;
    }
    return false;
  }

  private async place(conversationId: string, redrive: boolean): Promise<void> {
    const store = this.ports.store;
    // #4003 verifier V3: an entry the inbox accepted and then did not
    // deliver (refused, or unconfirmed) is recorded on the entry, which the
    // conversation inbox read lists, and logged here, so a refused wake or
    // held follow-up is observable without reading the store.
    const settle: typeof store.settle = (entry, to, outcome, now) => {
      const settled = store.settle(entry, to, outcome, now);
      // Only a settle that applied: a stale one (another drive settled the
      // entry first) wrote nothing and is not this outcome (round 2, P3-8).
      if (to !== 'placed' && settled.kind === 'applied')
        this.ports.logger.warn('thread inbox entry not delivered', {
          conversationId,
          clientTurnId: entry.key,
          state: to,
          ...(outcome.reasonCode ? { reasonCode: outcome.reasonCode } : {}),
        });
      return settled;
    };
    // Each entry is attempted at most once per drive. The inbox settles or
    // releases every attempt, so a head met twice means its state did not
    // move: look again later rather than start it again in a loop.
    const attemptedKeys = new Set<string>();
    for (;;) {
      if (this.stopped) return;
      const head = inboxHead(store.list(conversationId));
      if (!head) return;
      if (head.state === 'unconfirmed') {
        if (this.resolveAbandoned(conversationId, head)) continue;
        return;
      }
      if (attemptedKeys.has(head.key)) {
        this.ports.logger.warn('thread inbox entry did not settle', {
          conversationId,
          clientTurnId: head.key,
          state: head.state,
        });
        this.scheduleRetry(conversationId);
        return;
      }
      attemptedKeys.add(head.key);
      const current = this.ports.currentSessionId(conversationId);
      let entry: InboxEntryRecord;
      if (head.state === 'placing') {
        if (!redrive) return;
        // Once per drive: a placing head re-driven now is this loop's own.
        redrive = false;
        entry = head;
      } else {
        if (this.isBusy(current)) {
          // Waits for the turn's terminal; the re-check covers a live busy
          // flag that outlives it, or a start that ends with no terminal.
          this.scheduleRetry(conversationId);
          return;
        }
        const claimed = store.claimNext(conversationId, current, this.now());
        if (claimed.kind !== 'claimed') return;
        entry = claimed.entry;
      }
      const payload = decodePayload(entry.payload);
      if (!payload) {
        settle(
          entry,
          'refused',
          {
            reasonCode: 'unreadable_entry',
            reason: 'Station could not read this message back.',
          },
          this.now(),
        );
        continue;
      }
      // The live send's own rule, checked again: a sender or device that
      // lost the right since it queued is refused, and nothing is sent.
      const refusal = this.refusalFor(conversationId, payload, entry.createdAt);
      if (refusal) {
        settle(entry, 'refused', refusal, this.now());
        continue;
      }
      let started: SessionStartResult | typeof DEADLINE;
      try {
        // The whole conversation's ledger first (D1): a key an earlier
        // attempt took on any Session is answered from there, never sent
        // again into a successor Session.
        started = await this.startWithin(conversationId, entry.key, () =>
          startUnlessDelivered({
            conversationId,
            inspect: () =>
              this.inspectDelivery(conversationId, entry.key, payload),
            start: () =>
              this.ports.start({
                conversationId,
                threadId: current,
                payload,
                clientTurnId: entry.key,
              }),
          }),
        );
      } catch (error) {
        // A stopped process records nothing more; its next startup re-drives.
        if (this.stopped) return;
        const code = errorCodeOf(error);
        if (
          code === CLIENT_TURN_IN_FLIGHT_CODE ||
          (code && BUSY_REFUSAL_CODES.has(code)) ||
          this.isBusy(this.ports.currentSessionId(conversationId))
        ) {
          // Nothing was sent: the Session is not free yet, or a live attempt
          // holds the key. Back to the queue; the ledger answers next time.
          store.release(entry, false, this.now());
          this.scheduleRetry(conversationId);
          return;
        }
        settle(
          entry,
          'refused',
          { sessionId: entry.placement ?? current, ...refusalOf(error) },
          this.now(),
        );
        continue;
      }
      if (this.stopped) return;
      if (started === DEADLINE) {
        settle(
          entry,
          'unconfirmed',
          {
            reasonCode: 'start_deadline',
            reason:
              'Station gave up waiting for the agent to take it; it may have been sent.',
          },
          this.now(),
        );
        return;
      }
      if (started.outcome === 'started') {
        settle(
          entry,
          'placed',
          { turnId: started.turnId, sessionId: started.sessionId },
          this.now(),
        );
        this.clearRetry(conversationId);
        // The next entry waits for this turn to end.
        continue;
      }
      settle(
        entry,
        'unconfirmed',
        {
          reasonCode: 'may_have_been_sent',
          reason:
            'Station could not confirm it reached the agent; it may have been sent.',
        },
        this.now(),
      );
      return;
    }
  }

  /**
   * The periodic re-check, one pending per conversation: the delays in
   * order, then the last one again, at most `max(delays, maxRetries)` firings
   * in all until a placement or a newly accepted message resets the count. It runs only while the inbox
   * still holds a waiting entry. It covers a busy flag that outlives its
   * terminal, a start that ends with no terminal event, and a drive that
   * failed mid-placement (`redrive`).
   */
  private scheduleRetry(conversationId: string, redrive = false): void {
    if (this.stopped) return;
    const delays = this.ports.retryDelaysMs ?? RETRY_DELAYS_MS;
    if (delays.length === 0) return;
    const state = this.retries.get(conversationId) ?? {
      fired: 0,
      redrive: false,
      timer: undefined,
    };
    this.retries.set(conversationId, state);
    state.redrive ||= redrive;
    if (state.timer) return;
    if (
      state.fired >=
      Math.max(delays.length, this.ports.maxRetries ?? MAX_RETRIES)
    )
      return;
    let waiting = false;
    try {
      waiting = this.ports.store
        .list(conversationId)
        .some((entry) => entry.state === 'queued' || entry.state === 'placing');
    } catch {
      // The store is failing: look again on schedule.
      waiting = true;
    }
    if (!waiting) return;
    const timer = setTimeout(
      () => {
        state.timer = undefined;
        state.fired += 1;
        const again = state.redrive;
        state.redrive = false;
        this.drive(conversationId, again);
      },
      delays[Math.min(state.fired, delays.length - 1)],
    );
    timer.unref?.();
    state.timer = timer;
  }

  /** A new message: the re-check count starts again; a pending timer stays. */
  private resetRetryBudget(conversationId: string): void {
    const retry = this.retries.get(conversationId);
    if (retry) retry.fired = 0;
  }

  private clearRetry(conversationId: string): void {
    const retry = this.retries.get(conversationId);
    if (retry?.timer) clearTimeout(retry.timer);
    this.retries.delete(conversationId);
  }
}
