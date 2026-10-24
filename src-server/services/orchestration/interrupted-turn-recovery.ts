import crypto from 'node:crypto';
import {
  type CanonicalRuntimeEvent,
  isDeferredRetriableTurnError,
  isProviderTriggeredTurn,
  PROVIDER_TURN_TRIGGER,
} from '@kontourai/station-contracts/runtime-events';
import { TURN_INTERRUPTED_MESSAGE } from '@kontourai/station-shared/runtime-event-projection';
// Same directory depth as the service, so this specifier resolves to the id
// `interrupted-turn-recovery.test.ts` already `vi.mock`s. A module at a
// different depth would silently get the REAL resolver and red the
// delegation test — the T12 failure mode in a non-metrics guise.
import { resolveConversationTranscriptSource } from '../../runtime/conversation/conversation-transcript-source.js';
import { errorMessage } from '../../utils/error-message.js';
import { sleep } from '../../utils/sleep.js';
import type { EventStore, PersistedRuntimeEvent } from './event-store.js';
import { TURN_ABORT_SETTLED_REQUEST_STATUS } from './open-requests.js';
import {
  isProviderTurnBoundary,
  type SessionTurnBoundaryRecord,
} from './session-turn-boundary.js';

/**
 * `request.resolved.response.reason` on the resolution recovery writes for a
 * request its dead turn left open (#3071), so a reader of the log can tell
 * it from a person's or an engine's decision.
 */
const INTERRUPTED_TURN_REQUEST_REASON = 'turn-interrupted';

/** Narrow structural logger: this module warns, never debugs. */
type InterruptedTurnRecoveryLogger = {
  warn(message: string, meta?: Record<string, unknown>): void;
};

interface InterruptedTurnRecoveryDeps {
  /**
   * Called, not captured: the store is optional on the service options and a
   * swap after construction must be honoured. The handle crosses here
   * deliberately — the nine operations this module needs
   * (`takeInterruptedTurnBoundaries`, `latestEventByMethod`,
   * `listTurnStartsSince`, `listEventsByMethodsAfterSequence`,
   * `listEventsForTurn`, `listUnresolvedRequestEvents`,
   * `firstOtherTurnStartedAfter`, `hasEventId`,
   * `resolveInterruptedTurnBoundary`) are
   * one transactional unit over the boundary table and event log, and
   * fanning them into nine unrelated arrows would hide that. No Map crosses (T13).
   */
  eventStore: () => EventStore | undefined;
  /**
   * The `options.memoryAdapters` Map is absorbed at the ctor seam, so this
   * module never holds a Map handle (T13) — only the narrow
   * `InterruptedTurnMemoryAdapter` seam, which moves with it.
   */
  memoryAdapterFor: (
    agentSlug: string,
  ) => InterruptedTurnMemoryAdapter | undefined;
  /**
   * The service's projection+publish (`projectAndPublishEvent`). Returns
   * boolean in-service and the refusal
   * branch READS it — a declined publish must retain the boundary row — so
   * unlike the CooperativeStop/FlowPolicySidecar precedent this is NOT
   * `void`. Narrowing it would silently convert "declined" into "done".
   */
  publishEvent: (event: CanonicalRuntimeEvent) => boolean;
  logger: InterruptedTurnRecoveryLogger;
}

/**
 * archive#4080: the narrow FileMemory seam
 * `consumeInterruptedTurnBoundaries` needs — the same three operations
 * `routes/chat/conversations.ts`'s `readConversationMessages` uses to decide
 * whether a session's transcript lives in this store at all. `getMessages`'s
 * `metadata` echoes whatever `addMessage` wrote (round-tripped verbatim
 * through the JSONL store), which is how the interrupted-turn banner's own
 * idempotence marker (H1b) survives a read.
 */
export interface InterruptedTurnMemoryAdapter {
  addMessage(
    message: {
      id: string;
      role: 'user';
      parts: Array<{ type: 'text'; text: string }>;
      metadata?: { interruptedTurnBoundaryId: string };
    },
    userId: string,
    conversationId: string,
  ): Promise<void>;
  getMessages(
    userId: string,
    conversationId: string,
    options?: { limit?: number },
  ): Promise<Array<{ metadata?: { interruptedTurnBoundaryId?: string } }>>;
  getConversation(conversationId: string): Promise<{ userId: string } | null>;
}

/**
 * archive#4080: `options.limit` bounds the RESULT
 * `resolveConversationTranscriptSource`'s `getMessages` call returns — the
 * underlying `FileMemoryAdapter.getMessages` (`readStoredMessages`) reads
 * the conversation's whole JSONL file and slices the last `limit` entries
 * off the end before returning, so this bounds what this method inspects,
 * not what it reads off disk. That bounded RESULT is used for two things:
 * deciding whether the store is occupied at all (any result is a positive
 * answer — `readConversationMessages`'s own check is likewise "is this
 * non-empty", never "read everything") and scanning for the interruption
 * banner's own idempotence marker. The marker scan's soundness rests on an
 * ordering assumption, not a guarantee: `consumeInterruptedTurnBoundaries`
 * runs fire-and-forget once, after boot's session-attachment settles — not
 * before live traffic can reach this thread. If a real message is sent
 * before this method runs for a given boundary, the marker (if a prior
 * attempt already wrote one) is no longer guaranteed to be within the tail
 * `limit` messages this scan inspects, and a residual crash-window replay
 * could double-banner. Five is slack for the ordinary case — appended right
 * after boot, before anything else has had the chance to write to a session
 * whose owning process just died — not a guarantee against a live send
 * racing it.
 */
const INTERRUPTED_TURN_MEMORY_SCAN_LIMIT = 5;

/**
 * archive#4080 (delegates to the shared
 * `resolveConversationTranscriptSource` rather than re-deriving its own copy
 * of the lookup). Occupancy is decided
 * by the SAME two-step FileMemory lookup `readConversationMessages` uses —
 * see that function's own doc for why this is the one shared definition.
 * `alreadyBannered` is this caller's own use of the bounded result: the
 * interrupted-turn banner's idempotence check (H1b), not part of the shared
 * occupancy question itself.
 */
async function resolveFileMemoryOccupancy(
  adapter: InterruptedTurnMemoryAdapter,
  agentSlug: string,
  threadId: string,
): Promise<{
  occupied: boolean;
  userId: string;
  alreadyBannered: (boundaryId: string) => boolean;
}> {
  const source = await resolveConversationTranscriptSource<{
    metadata?: { interruptedTurnBoundaryId?: string };
  }>(adapter, `agent:${agentSlug}`, threadId, {
    limit: INTERRUPTED_TURN_MEMORY_SCAN_LIMIT,
  });
  return {
    occupied: source.occupied,
    userId: source.userId,
    alreadyBannered: (boundaryId: string) =>
      source.messages.some(
        (message) => message.metadata?.interruptedTurnBoundaryId === boundaryId,
      ),
  };
}

/**
 * #3562: the in-boot backoff `consume` retries a failed record on, one
 * delay per retry (so four attempts in all, about 1.75s of waiting). Bounded
 * on purpose: a failure that outlives it is not transient, and the boundary
 * row is the durable "recovery pending" state a restart finds again.
 */
const INTERRUPTED_TURN_RETRY_DELAYS_MS: readonly number[] = [250, 500, 1_000];

/**
 * #3562: how many `turn.started` rows after a claim `deriveOwnTurn` reads.
 * A dispatch that died mid-invocation leaves a handful at most; past this
 * bound the owner is not guessed (banner, no abort).
 */
const OWN_TURN_START_SCAN_LIMIT = 64;

/**
 * #3562: the turn a boundary that died `invoking` opened, when the store can
 * prove it. A row reaches boot with no recorded turn id when its owner died
 * after `beginInvocation` and before `accepted`, and production persists the
 * adapter's `turn.started` inside that window — so the dead dispatch's own
 * start is normally NEWER than its claim, and must not read as the thread
 * moving on.
 *
 * Claim exclusivity alone does not identify it: `accepted` rows do not block
 * a new claim, and a steer takes no claim and re-publishes a non-provider
 * `turn.started` carrying the id of whatever turn is open — possibly an
 * earlier accepted row's. So the owned turn is the LATEST turn id, among
 * starts at or after the claim, whose FIRST `turn.started`:
 *  - is itself at or after the claim (a steer of an older turn is not);
 *  - is not a steer (`inputKind: 'steer'`) and not a turn the engine opened
 *    on its own (#2324), neither of which any dispatch caused;
 *  - names a turn no other interrupted boundary row names (an accepted
 *    row's own start can arrive late, e.g. deferred behind a Stop).
 * Latest, not earliest: a later fresh start under the same claim is still
 * this dispatch's, and taking the earliest would read the later one as
 * "moved on" and resolve the dead turn silently — the defect itself.
 *
 * Anything else returns `undefined`: the row then gets the banner and no
 * abort, because closing a turn this row cannot prove it opened could close
 * someone else's.
 */
function deriveOwnTurn(
  eventStore: EventStore,
  record: SessionTurnBoundaryRecord,
  interrupted: readonly SessionTurnBoundaryRecord[],
): { turnId: string; start: PersistedRuntimeEvent } | undefined {
  const starts = eventStore.listTurnStartsSince(
    record.threadId,
    record.createdAt,
    OWN_TURN_START_SCAN_LIMIT + 1,
  );
  if (starts.length > OWN_TURN_START_SCAN_LIMIT) return undefined;
  const otherRowTurnIds = new Set(
    interrupted
      .filter(
        (other) =>
          other.threadId === record.threadId &&
          other.boundaryId !== record.boundaryId,
      )
      .map((other) => other.providerTurnId)
      .filter((turnId): turnId is string => turnId !== undefined),
  );
  for (const start of starts) {
    const turnId = start.turnId;
    if (turnId === undefined || otherRowTurnIds.has(turnId)) continue;
    const first = eventStore
      .listEventsForTurn(record.threadId, turnId, 64)
      .find((event) => event.payload.method === 'turn.started');
    if (
      first === undefined ||
      first.createdAt < record.createdAt ||
      first.payload.method !== 'turn.started' ||
      first.payload.inputKind === 'steer' ||
      isProviderTriggeredTurn(first.payload)
    ) {
      continue;
    }
    return { turnId, start: first };
  }
  return undefined;
}

/**
 * #3562: how an owned turn already ended, read from that turn's own
 * terminals after its first start (never the thread's latest terminal: a
 * later terminal of a different turn must not hide this one's).
 *
 * `completed`: a real `turn.completed` that was not a cancellation — the
 * dispatch's turn ran to its end, so nothing was interrupted. `ended`: any
 * other terminal (an abort, a cancelled completion, a non-retriable error).
 * Those prove the turn is closed but not that THIS dispatch's work happened:
 * Claude's Stop-while-queued publishes an accepted row's held start and its
 * abort after a later claim and retires that row, and the turn is then
 * indistinguishable from the later dispatch's own. So `ended` still banners,
 * without an abort (the turn is already closed). This module's own
 * `recoveryTerminal` abort from an unfinished earlier pass reads as `ended`
 * too, which finishes that pass with its banner. Not a terminal: a codex
 * deferred-retriable `runtime.error`, after which the same turn may resume.
 * Past the page bound the answer is `undefined` (still open), which recovers
 * rather than resolve silently.
 */
function ownTurnEnding(
  eventStore: EventStore,
  threadId: string,
  own: { turnId: string; start: PersistedRuntimeEvent; invocationId?: string },
): 'completed' | 'ended' | undefined {
  let ending: 'completed' | 'ended' | undefined;
  for (const event of eventStore.listEventsByMethodsAfterSequence(
    threadId,
    ['turn.completed', 'turn.aborted', 'runtime.error'],
    own.start.sequence,
    1_000,
  )) {
    if (event.turnId !== own.turnId) continue;
    const terminal = event.payload;
    if (
      terminal.invocationId !== undefined &&
      terminal.invocationId !== own.invocationId
    )
      continue;
    if (
      own.start.payload.invocationId !== undefined &&
      terminal.invocationId !== own.start.payload.invocationId
    )
      continue;
    if (terminal.method === 'turn.completed') {
      if (terminal.finishReason !== 'cancelled') return 'completed';
      ending = 'ended';
    } else if (terminal.method === 'turn.aborted') {
      ending = 'ended';
    } else if (
      terminal.method === 'runtime.error' &&
      !isDeferredRetriableTurnError(terminal)
    ) {
      ending = 'ended';
    }
  }
  return ending;
}

/**
 * Boot-time interrupted-turn recovery (epic archive#4024, archive#4080).
 *
 * Owns no state: one method, driven once per boot, fire-and-forget from
 * `initialize()`'s third un-awaited tail. Four deps. The scope is
 * deliberately narrower than the map's "C16 — boot, recovery,
 * materialization": three of that cluster's four owned fields cannot move
 * (`initialize()` is pinned by a byte-exact source guard, `started` is its
 * T9 latch, `sessionAttachmentSettled` is read by C7's
 * `observeAnswerability`, and `recoveryCoordinator` has three non-C16
 * readers plus two test cast reach-ins), and `recoverSessions` /
 * `recoveredSessionStartOptions` are dep TABLES for
 * `recoverOrchestrationSessions`, which is already extracted — moving them
 * would nest one options interface inside another. See the map's §II.3 C16
 * closure section.
 *
 * Emits no metrics, deliberately: nothing here needs the T12-compliant
 * `'../../telemetry/metrics.js'` specifier, and its absence is not an
 * oversight to "fix".
 */
export class InterruptedTurnRecovery {
  /** Aborted by `stop()`: no further pass runs and a backoff ends early. */
  private readonly stopSignal = new AbortController();

  constructor(private readonly deps: InterruptedTurnRecoveryDeps) {}

  /**
   * #3562: the service is shutting down. A pass already inside a record
   * finishes that record; no further record or retry pass starts, and a
   * backoff in progress ends now rather than after its delay. Unfinished rows
   * stay for the next boot, which is the durable path.
   */
  stop(): void {
    this.stopSignal.abort();
  }

  /**
   * archive#4080: consumes this process's own boot-time findings
   * from `EventStore.takeInterruptedTurnBoundaries()` — dead-owner
   * `accepted`/`indeterminate` `orchestration_turn_boundaries` rows, i.e.
   * turns that were in flight when their owning process died (a `kill -9`
   * never leaves any of the ordinary terminal facts — no `turn.completed`,
   * no `runtime.error`, no `session.exited` — for this thread to fold from
   * on its own). Every banner this writes is gated on exactly one such row;
   * there is no code path that writes one without a matching row.
   *
   * PRESENTATION PATH: chosen the SAME
   * way the read path chooses it — `readConversationMessages` serves
   * FileMemory whenever it is non-empty for the thread, regardless of
   * provider, and the persisted-runtime-events projection otherwise. This
   * method now asks the identical question (`resolveFileMemoryOccupancy`)
   * instead of branching on `provider === 'station-agent'`: a provider
   * branch was wrong in both directions (a station-agent conversation
   * created under a real user id, not the conventional `agent:${slug}` one,
   * would have gone unseen; every other provider was silently assumed
   * empty with no check). Exactly one path is ever written per session.
   *
   * LIFECYCLE-STATE FIX, engine-agnostic and always applied: a killed
   * turn's `turn.started` sets both `AgentRunStatus` (`running`,
   * `orchestration-session-state.ts`'s `deriveAgentRunStatus`) and
   * `SessionLifecycleState` (`running`, `session-lifecycle-service.ts`'s
   * `deriveLifecycleTransition`) and neither fold has anything left to
   * read it out of `running` once the crash swallows every terminal event.
   * One `session.state-changed` event stamped `sessionState:'needs_input'`
   * fixes both: `projectSessionLifecycle`'s generic early-return honors any
   * event's explicit `sessionState` stamp regardless of the fold's own
   * current state (no `validateSessionLifecycleTransition` legality check
   * applies to a system-derived recovery fact, unlike a user-initiated
   * Board transition), and `deriveAgentRunStatus`'s `session.state-changed`
   * arm reads the same event's raw `to:'awaiting-approval'` into
   * `waiting_for_approval` — the nearest `AgentRunStatus` has to "needs
   * input" (that contract has no separate value for it). The SAME event
   * also carries the visible banner for every non-FileMemory-occupied
   * session (`runtime-event-projection.ts`'s `session.state-changed` case),
   * gated on the dedicated `interruptedTurnBoundary` field rather than
   * on the (sessionState, transitionReason, transitionSource) vocabulary
   * triple — see that field's own doc in `runtime-events.ts`.
   *
   * station#2235: the banner alone does not settle the TURN. Nothing else
   * closes `turn.started`'s open window, so `hasActiveTurn` reads true
   * forever and a live client's streaming shell never engages the banner —
   * it keeps rendering a running turn under a "Waiting for approval" the
   * store cannot back (no `request.opened` exists). consume() therefore
   * publishes a `turn.aborted` (`turn-interrupted-abort:<boundaryId>`,
   * `turnId` = the boundary's `providerTurnId`) BEFORE the banner, for the
   * same reason an adapter publishes one on failure: it is the terminal
   * turn fact every fold already honors. Same idempotence (deterministic
   * id + `hasEventId`) and same refusal semantics as the banner. The
   * abort accepts through the turn-identity guard any real abort for that
   * turn would, and because the banner lands after it, the banner's
   * explicit `sessionState` stamp still decides the lifecycle: the turn
   * reads closed AND the session reads needs_input. Skipped (banner only)
   * when the boundary never accepted a turn and names none.
   *
   * #3071: nor does the abort settle what the turn was WAITING ON. A request
   * the dead turn opened has no adapter left to resolve it, so consume()
   * publishes its `request.resolved` (`expired`,
   * `turn-interrupted-request:<boundaryId>:<requestId>`) before the abort,
   * for every request still unresolved that was opened since the turn
   * started and before any other turn started. Requests outside that window
   * are left alone.
   *
   * IDEMPOTENCE: the write→delete gap between a
   * banner landing and `resolveInterruptedTurnBoundary` closing its row is
   * a real crash window — a process that dies in it leaves the row for a
   * next boot to find again. Both write paths are therefore made
   * idempotent by boundary-derived identity BEFORE that DELETE is trusted
   * to be the only guard: the event's `eventId` is deterministic
   * (`turn-interrupted:<boundaryId>`, checked via `EventStore.hasEventId`
   * before writing), and the FileMemory message carries the boundaryId as
   * `metadata.interruptedTurnBoundaryId`, scanned for before writing. A
   * retry that finds either already present skips straight to close.
   *
   * REFUSAL: `projectAndPublishEvent` returns `false`
   * when it declines to publish (e.g. a quarantined thread) — honored here
   * by leaving the boundary row unresolved and logging, rather than
   * silently treating a declined publish as done.
   *
   * INFORMATION CARRIED FORWARD: the boundary row's
   * own facts — prior state, provider turn id, owner id, its own
   * created/updated timestamps — are copied onto the event's
   * `interruptedTurnBoundary` payload before the row is deleted, so nothing
   * DELETE discards is unavailable to a future slice (e.g. bounded
   * auto-resume) reading the durable event alone.
   */
  async consume(): Promise<string[]> {
    const drainedFrom = this.deps.eventStore();
    if (!drainedFrom) return [];
    // Drained once: the retries below work from this list, never from a second
    // take, which would be empty.
    const interrupted = drainedFrom.takeInterruptedTurnBoundaries();
    let pending = await this.recoverPass(drainedFrom, interrupted, interrupted);
    // #3562: a record that failed (a throw, or a declined publish) keeps its
    // row but was drained from the store's in-memory list, so nothing else
    // would look at it before the next boot. Retry just those records on a
    // bounded schedule, each pass re-deciding from the log (the writes are
    // idempotent by boundary-derived id, and `movedOn` is asked again, so a
    // turn that started during the wait is still honoured).
    let abandoned: 'shutdown' | 'event-store-changed' | undefined;
    for (const delay of INTERRUPTED_TURN_RETRY_DELAYS_MS) {
      if (pending.length === 0) break;
      if (this.stopSignal.signal.aborted) {
        abandoned = 'shutdown';
        break;
      }
      await sleep(delay, this.stopSignal.signal);
      // The store dep is lazy (it may be swapped after construction), so it
      // is read again for every pass. The rows belong to the store they were
      // drained from; a different one, or none, ends the retries.
      const eventStore = this.deps.eventStore();
      if (this.stopSignal.signal.aborted) abandoned = 'shutdown';
      else if (eventStore !== drainedFrom) abandoned = 'event-store-changed';
      if (abandoned !== undefined) break;
      pending = await this.recoverPass(drainedFrom, interrupted, pending);
    }
    if (abandoned === undefined && this.stopSignal.signal.aborted) {
      abandoned = 'shutdown';
    }
    const unrecovered = pending.map((record) => record.boundaryId);
    if (unrecovered.length > 0) {
      // The durable "recovery pending" state is the boundary row itself, which
      // a restart finds again; this is the one line saying so for this boot.
      this.deps.logger.warn(
        abandoned === undefined
          ? 'Interrupted-turn recovery gave up for this boot; the boundary rows stay for the next boot'
          : 'Interrupted-turn recovery stopped before it finished; the boundary rows stay for the next boot',
        {
          boundaryIds: unrecovered,
          ...(abandoned === undefined
            ? { attempts: INTERRUPTED_TURN_RETRY_DELAYS_MS.length + 1 }
            : { reason: abandoned }),
        },
      );
    }
    return unrecovered;
  }

  /**
   * One pass over `pending`. Returns the records whose recovery did not
   * finish (their row is kept); `interrupted` is every record this boot
   * drained, which `deriveOwnTurn` reads to tell the rows' turns apart.
   */
  private async recoverPass(
    eventStore: EventStore,
    interrupted: readonly SessionTurnBoundaryRecord[],
    pending: readonly SessionTurnBoundaryRecord[],
  ): Promise<SessionTurnBoundaryRecord[]> {
    const failed: SessionTurnBoundaryRecord[] = [];
    for (const record of pending) {
      if (this.stopSignal.signal.aborted) {
        // Shutting down: leave this row, and every one after it, for the
        // next boot rather than publish on a torn-down service.
        failed.push(record);
        continue;
      }
      if (record.state !== 'accepted' && record.state !== 'indeterminate') {
        // Read-only defensive guard: `EventStore.takeInterruptedTurnBoundaries()`
        // only ever fills this list from those two states (see
        // `session-turn-boundary.ts`'s `reconcileDeadOwners`); skip anything
        // else rather than resolve a row this method does not understand.
        continue;
      }
      try {
        // station#2235: the row outlives the crash, not the
        // session's future. If the thread opened a NEWER turn after this
        // boundary was claimed — a new owner attached and the user kept
        // going before this boot's consume ran — both recovery events would
        // be stale: the abort is anchor-rejected by every fold (harmless),
        // but the banner still forces needs_input over a genuinely running
        // turn (and the live client would tear down that turn's shell and
        // grants). Resolve the row silently and publish nothing: the folds
        // moved on. Compared by turn identity AND creation time: a start
        // newer than the claim is evidence only when it is not this
        // boundary's own turn (#3562, `ownTurnId` below). Inside the
        // per-record try like everything else: a throwing resolve must
        // strand this row, not the whole loop.
        // #3071: asked twice — here, and again after the FileMemory await
        // below. A turn can start during that await, and everything after
        // it (the request resolutions, the abort, the banner) must be
        // decided against the thread as it is then, not as it was.
        const boundaryState = record.state;
        // #3562: the turn this boundary's dispatch opened. `accepted` records
        // it; a row that died `invoking` never got that far, yet production
        // persists the adapter's `turn.started` while `sendTurn` is still
        // pending — after the claim, before `accepted`. See
        // `deriveOwnTurn` for the rule. Derived once, before the await
        // below: the owner is dead, so nothing that starts during recovery
        // can be its turn.
        const derivedOwn =
          record.providerTurnId === undefined
            ? deriveOwnTurn(eventStore, record, interrupted)
            : undefined;
        const ownTurnId = record.providerTurnId ?? derivedOwn?.turnId;
        const movedOn = (): boolean => {
          const latestTurnStarted = eventStore.latestEventByMethod(
            record.threadId,
            'turn.started',
          );
          // #2324: a turn the engine opened on its own records its row just
          // BEFORE its `turn.started` is persisted. If that start is not the
          // thread's latest turn start, the process died before it landed (or
          // the thread moved on): there is no turn to close or banner.
          const providerTurn = isProviderTurnBoundary(record);
          // #2324: a send the engine accepted but never started (it
          // was queued behind a turn the engine opened itself when the process
          // died) has no `turn.started` of its own — the start is published
          // only when the engine starts it. A newer start on the thread is then
          // not "the thread moved on past it": that send still needs its
          // terminal and banner, or it vanishes without a trace. Disclosed:
          // if a NEWER turn is genuinely running by the time this runs (the
          // same window the moved-on check above exists for), that send's
          // banner still lands and forces needs_input over it — accepted
          // because the alternative loses the user's message silently. The
          // window is real and #3562's retries stretch it by up to the backoff
          // schedule: a new owner can claim the thread (an `accepted` row does
          // not block a claim) before its own `turn.started` is persisted, and
          // a pass landing in between banners `needs_input`. It self-heals,
          // because that start then folds the session back to running. It is
          // the first pass's window, only longer.
          const ownTurnStarted =
            ownTurnId !== undefined &&
            eventStore
              .listEventsForTurn(record.threadId, ownTurnId, 64)
              .some((event) => event.payload.method === 'turn.started');
          if (
            (providerTurn &&
              latestTurnStarted?.turnId !== record.providerTurnId) ||
            (!providerTurn &&
              (ownTurnId === undefined || ownTurnStarted) &&
              latestTurnStarted?.turnId !== undefined &&
              latestTurnStarted.turnId !== ownTurnId &&
              latestTurnStarted.createdAt > record.createdAt &&
              // #3562: a row that owns no turn cannot tell a dispatch's
              // start from a steer of some other turn, so only a turn the
              // engine opened on its own (#2324) — which takes no claim —
              // is evidence the thread moved on past it.
              (ownTurnId !== undefined ||
                isProviderTriggeredTurn(latestTurnStarted.payload)))
          ) {
            this.deps.logger.warn(
              'Interrupted-turn boundary is stale; the thread moved on — resolving without recovery events',
              { threadId: record.threadId, boundaryId: record.boundaryId },
            );
            eventStore.resolveInterruptedTurnBoundary({
              boundaryId: record.boundaryId,
              ownerId: record.ownerId,
              state: boundaryState,
            });
            return true;
          }
          return false;
        };
        if (movedOn()) continue;
        const ownStart =
          derivedOwn?.start ??
          (ownTurnId === undefined
            ? undefined
            : eventStore
                .listTurnStartsSince(
                  record.threadId,
                  record.createdAt,
                  OWN_TURN_START_SCAN_LIMIT,
                )
                .find(
                  (event) =>
                    event.turnId === ownTurnId &&
                    event.payload.method === 'turn.started' &&
                    event.payload.inputKind !== 'steer',
                ));
        const ownEnding =
          ownStart === undefined || ownTurnId === undefined
            ? undefined
            : ownTurnEnding(eventStore, record.threadId, {
                turnId: ownTurnId,
                start: ownStart,
                invocationId:
                  record.intent?.invocationId ?? ownStart.payload.invocationId,
              });
        if (ownEnding === 'completed') {
          // A retained boundary is a possible-effect fence, not proof that
          // a native turn with a recorded completion was interrupted.
          this.deps.logger.warn(
            'Interrupted-turn boundary names a turn that already finished — skipping recovery events',
            { threadId: record.threadId, boundaryId: record.boundaryId },
          );
          // Untagged native completion suppresses a false interruption, but
          // cannot release captured input's invocation-safety fence.
          if (record.intent === undefined) {
            eventStore.resolveInterruptedTurnBoundary({
              boundaryId: record.boundaryId,
              ownerId: record.ownerId,
              state: boundaryState,
            });
          }
          continue;
        }
        const providerTurn = isProviderTurnBoundary(record);
        const startEvent = eventStore.latestEventByMethod(
          record.threadId,
          'session.started',
        );
        const provider = startEvent?.provider;
        const agentSlug =
          typeof (startEvent?.payload as { metadata?: Record<string, unknown> })
            ?.metadata?.agentSlug === 'string'
            ? ((startEvent!.payload as { metadata: Record<string, unknown> })
                .metadata.agentSlug as string)
            : undefined;
        const now = new Date().toISOString();

        // ---- choose the presentation path by FileMemory
        // occupancy, exactly like the read path — never by provider. ----
        const memoryAdapter = agentSlug
          ? this.deps.memoryAdapterFor(agentSlug)
          : undefined;
        let fileMemoryTarget:
          | { userId: string; alreadyBannered: boolean }
          | undefined;
        if (memoryAdapter && agentSlug) {
          try {
            const occupancy = await resolveFileMemoryOccupancy(
              memoryAdapter,
              agentSlug,
              record.threadId,
            );
            if (occupancy.occupied) {
              fileMemoryTarget = {
                userId: occupancy.userId,
                alreadyBannered: occupancy.alreadyBannered(record.boundaryId),
              };
            }
          } catch (error) {
            // Safe default direction: if occupancy can't be determined,
            // fall back to the event-projected path rather than risk a
            // wrong-store write. `fileMemoryTarget` stays undefined.
            this.deps.logger.warn(
              'Interrupted-turn banner: FileMemory occupancy check failed; defaulting to the event-projected path',
              {
                threadId: record.threadId,
                agentSlug,
                error: errorMessage(error),
              },
            );
          }
        }

        // ---- idempotent, provenance-gated,
        // fact-carrying lifecycle/banner event. ----
        //
        // station#2235: close the dead turn FIRST. A crashed turn otherwise
        // leaves `turn.started` as its last turn fact, so `hasActiveTurn`
        // reads true forever and every live client keeps its streaming shell
        // open under the needs_input banner below ('Waiting for approval'
        // with nothing to approve). The abort rides the SAME acceptance
        // folds a real adapter abort rides (`acceptsTurnTerminalEvent` on
        // the anchor both folds track), and the banner lands AFTER it, so
        // the banner's explicit `sessionState:'needs_input'` stamp is still
        // the fold's final word — the turn reads closed AND the session
        // reads needs_input. Skipped when the boundary names no turn —
        // neither accepted one nor (#3562) opened one after its claim
        // (`ownTurnId` absent): there is no turn to close.
        // #3071: the occupancy check above awaited. If a newer turn started
        // meanwhile, this boundary is stale now even though it was not when
        // first asked; publish nothing, exactly as the first check would.
        // #3562: likewise a shutdown that landed during that await. Checked
        // before `movedOn()`, which can itself resolve the row; a stopped
        // record keeps its row and counts as unrecovered, not resolved.
        if (this.stopSignal.signal.aborted) {
          failed.push(record);
          continue;
        }
        if (movedOn()) continue;
        // #3562: a derived turn that already ended is closed; recovery
        // banners it but neither settles its requests nor aborts it again.
        const providerTurnId = ownEnding === 'ended' ? undefined : ownTurnId;
        if (providerTurnId !== undefined) {
          // #3071: settle what the dead turn was waiting on, BEFORE the
          // abort. Every live abort path has an adapter holding the pending
          // request, and that adapter publishes its `request.resolved`;
          // here the process that held it is gone, so nothing else ever
          // will. Left open, the request re-stamped the session
          // `review_pending` over the banner below and every surface
          // offered an approval nothing could take. `expired`: nobody
          // decided anything.
          //
          // WHICH requests: every one still unresolved that was opened
          // since this turn's `turn.started` — the recovery arm of
          // `requestIdsSettledByTurnAbort`, read from the store's own
          // request table. Not only the ones the turn "owned": a background
          // subagent's, or one opened after a mid-turn error, died with the
          // same process. A request opened before the turn started is left
          // open.
          //
          // ORDER: before the abort because a blocking `request.resolved`
          // folds to `running`, which is only true while the turn is still
          // the open one; the abort and banner then have the last word. A
          // crash after these resolutions and before the abort leaves the
          // session reading exactly what an unrecovered crash already reads
          // (turn open, running) with the boundary row intact, and the next
          // boot finishes: the resolved requests are no longer in the open
          // set, so no `hasEventId` check is needed for them.
          const turnStartSequence = eventStore
            .listEventsForTurn(record.threadId, providerTurnId, 64)
            .find((event) => event.payload.method === 'turn.started')?.sequence;
          // Bounded above by the next turn of a different id: a request
          // opened after another turn started belongs to work that is alive
          // (the #2324 case above can reach here with a newer turn running),
          // and its adapter is waiting on it. Same bound as the fold's.
          const supersededAtSequence =
            turnStartSequence === undefined
              ? undefined
              : eventStore.firstOtherTurnStartedAfter(
                  record.threadId,
                  providerTurnId,
                  turnStartSequence,
                )?.sequence;
          const interruptedRequests =
            turnStartSequence === undefined
              ? []
              : eventStore
                  .listUnresolvedRequestEvents(record.threadId)
                  .filter(
                    (event) =>
                      event.sequence > turnStartSequence &&
                      (supersededAtSequence === undefined ||
                        event.sequence < supersededAtSequence),
                  );
          let requestSettlementDeclined = false;
          for (const opened of interruptedRequests) {
            const request = opened.payload;
            if (request.method !== 'request.opened') continue;
            const requestId = request.requestId;
            const published = this.deps.publishEvent({
              eventId: `turn-interrupted-request:${record.boundaryId}:${requestId}`,
              provider: provider ?? 'unknown',
              threadId: record.threadId,
              turnId: providerTurnId,
              createdAt: now,
              method: 'request.resolved',
              requestId,
              // An asynchronous question never paused the turn, and its
              // resolution must not read as resuming one.
              ...(request.blocking === false ? { blocking: false } : {}),
              status: TURN_ABORT_SETTLED_REQUEST_STATUS,
              response: { reason: INTERRUPTED_TURN_REQUEST_REASON },
            });
            if (!published) {
              requestSettlementDeclined = true;
              break;
            }
          }
          if (requestSettlementDeclined) {
            // Same refusal handling as the abort and banner below.
            this.deps.logger.warn(
              'Interrupted-turn request settlement was declined; leaving the boundary row for the next boot',
              {
                threadId: record.threadId,
                boundaryId: record.boundaryId,
                reason: 'projectAndPublishEvent returned false',
              },
            );
            failed.push(record);
            continue;
          }
          const abortEventId = `turn-interrupted-abort:${record.boundaryId}`;
          if (!eventStore.hasEventId(abortEventId)) {
            const published = this.deps.publishEvent({
              eventId: abortEventId,
              provider: provider ?? 'unknown',
              threadId: record.threadId,
              turnId: providerTurnId,
              createdAt: now,
              method: 'turn.aborted',
              reason: TURN_INTERRUPTED_MESSAGE,
              // Carries the marker `TurnAbortedEvent.recoveryTerminal`
              // documents: the boundary-retirement machinery must NOT treat
              // this abort as the turn's own terminal fact (which would
              // delete this row mid-flow and void the crash-window
              // guarantees below), while every turn fold still settles the
              // dead turn on it.
              recoveryTerminal: true as const,
              // #2324: the abort carries the trigger its turn's start did,
              // so every consumer reads it as that provider turn's end.
              ...(providerTurn
                ? { metadata: { trigger: PROVIDER_TURN_TRIGGER } }
                : {}),
            });
            if (!published) {
              // Same refusal handling as the banner below: a declined publish must
              // not be treated as done — retain the row for the next boot.
              this.deps.logger.warn(
                'Interrupted-turn abort event was declined; leaving the boundary row for the next boot',
                {
                  threadId: record.threadId,
                  boundaryId: record.boundaryId,
                  reason: 'projectAndPublishEvent returned false',
                },
              );
              failed.push(record);
              continue;
            }
          }
        }
        const bannerEventId = `turn-interrupted:${record.boundaryId}`;
        if (!eventStore.hasEventId(bannerEventId)) {
          const published = this.deps.publishEvent({
            eventId: bannerEventId,
            // `EngineId` is a plain string alias, not a closed union —
            // 'unknown' is an honest fallback for the (should not happen)
            // case where no `session.started` survives for a thread that
            // still has an unresolved turn boundary.
            provider: provider ?? 'unknown',
            threadId: record.threadId,
            createdAt: now,
            method: 'session.state-changed',
            sessionId: record.threadId,
            from: 'running',
            to: 'awaiting-approval',
            reason: TURN_INTERRUPTED_MESSAGE,
            sessionState: 'needs_input',
            transitionReason: 'runtime_exit',
            transitionSource: 'system_recovery',
            interruptedTurnBoundary: {
              boundaryId: record.boundaryId,
              priorState: record.state,
              ...(record.providerTurnId
                ? { providerTurnId: record.providerTurnId }
                : {}),
              ownerId: record.ownerId,
              boundaryCreatedAt: record.createdAt,
              boundaryUpdatedAt: record.updatedAt,
            },
          });
          if (!published) {
            // A declined publish (e.g. a quarantined thread) must not
            // be treated as done — retain the row for the next boot.
            this.deps.logger.warn(
              'Interrupted-turn banner event was declined; leaving the boundary row for the next boot',
              {
                threadId: record.threadId,
                boundaryId: record.boundaryId,
                reason: 'projectAndPublishEvent returned false',
              },
            );
            failed.push(record);
            continue;
          }
        }

        // ---- idempotent FileMemory write, keyed on the SAME
        // boundaryId, only when that store is the session's real transcript. ----
        if (fileMemoryTarget && !fileMemoryTarget.alreadyBannered) {
          await memoryAdapter!.addMessage(
            {
              id: crypto.randomUUID(),
              role: 'user',
              parts: [
                {
                  type: 'text',
                  text: `[SYSTEM_EVENT] [TURN_INTERRUPTED] ${TURN_INTERRUPTED_MESSAGE}`,
                },
              ],
              metadata: { interruptedTurnBoundaryId: record.boundaryId },
            },
            fileMemoryTarget.userId,
            record.threadId,
          );
        }

        eventStore.resolveInterruptedTurnBoundary({
          boundaryId: record.boundaryId,
          ownerId: record.ownerId,
          state: record.state,
        });
      } catch (error) {
        failed.push(record);
        this.deps.logger.warn(
          'Interrupted-turn banner failed; leaving the boundary row for the next boot',
          {
            threadId: record.threadId,
            error: errorMessage(error),
          },
        );
      }
    }
    return failed;
  }
}
