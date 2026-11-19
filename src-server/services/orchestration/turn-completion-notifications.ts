/**
 * wireTurnCompletionNotifications — archive#1225 (offline):
 * push-on-completion, the second half of "the differentiator". A turn that
 * completes or fails gets a notification record ("Your agent finished")
 * through the exact SAME pipeline `wireApprovalInboxNotifications`
 * (`../approvals/approval-inbox.ts`) and the notification delivery router
 * (`../notifications/delivery/router.ts`, #2586) already provide for
 * approval-request/job-failure notifications — this module only decides
 * WHETHER to schedule a record, never how it reaches a device.
 *
 * "Is anyone watching?" is the router's decision, per surface, not this
 * module's (`policy.ts`): a focused surface with a live in-app stream gets
 * no OS alert or push for the record; the same person's other surfaces skip
 * a "done" record and hold a "failed" one for `escalateAfterMs`, sending it
 * then only if it is still unread. The record carries an envelope (system
 * source, the session's readers, a session target) so that reading it —
 * opening it, or a person attending to its chat on a focused client (recent
 * input, not focus alone) — cancels that escalation and retracts what was
 * already sent. Read state is per record: the first reader's read cancels
 * the escalation for every reader of the session. This listener used to skip
 * scheduling whenever the owner held ANY live `/api/orchestration/events`
 * stream; a desktop app idling in the tray keeps one open, so that gate
 * silenced every completion on every device. The
 * listener still resolves the completed session's private presence subject
 * through `OrchestrationService.resolveSessionPresenceSubject`: a session
 * that resolves no subject (it has no recorded owner, or a hosted one lacks
 * a valid binding) has no one who may read it, so nothing is scheduled for
 * it at all.
 *
 * A finish is announced once per completion episode, not once per turn. A
 * `done` or `replied` outcome waits while the session still has work that
 * will produce more (`finished-alert-hold.ts`: subagents, delegated or owned
 * sessions, a foreground command, unclassified open engine work, Claude's
 * pending follow-up, a queued inbox follow-up). It is sent after
 * `FINISHED_ALERT_CONFIRM_MS` with nothing holding it and no new turn. A
 * Station-delegated child whose result returns to its parent announces no
 * finish of its own. Failures, stops, approvals and questions are not held.
 *
 * Body is deliberately minimal (`Agent finished in session <threadId>`) —
 * never the turn's `outputText` — matching archive#1225's guardrail against
 * a push notification leaking response content.
 *
 * The EventBus callback stays synchronous and delegates to NotificationService's
 * one ordered, rejection-safe async adapter. The inner try/catch records an
 * operation-level failure; the adapter observes any rejection that escapes it
 * without creating an unhandled promise or poisoning later notifications.
 */

import {
  type Notification,
  type NotificationEnvelopeV1,
  TURN_COMPLETION_NOTIFICATION_SOURCE,
} from '@kontourai/station-contracts/notification';
import {
  type CanonicalRuntimeEvent,
  describeAcpTurnStopFailure,
  isProviderTriggeredTurn,
  SERVER_EVENTS,
} from '@kontourai/station-contracts/runtime-events';
import { readNotificationEnvelope } from '@kontourai/station-shared/notification-envelope';
import { turnCompletionNotificationOps } from '../../telemetry/metrics.js';
import { errorMessage } from '../../utils/error-message.js';
import { FINISH_ALERT_WINDOW_MS } from '../notifications/agent-activity-card.js';
import { ON_ACTIVITY_CARD_METADATA_KEY } from '../notifications/delivery/card-alerted-categories.js';
import {
  NotificationDedupeSourceConflictError,
  type NotificationService,
} from '../notifications/notification-service.js';
import type { EventBus } from './event-bus.js';
import {
  FINISHED_ALERT_EPISODES_MAX,
  type FinishedAlertEpisodeStore,
  FinishedAlertEpisodes,
  type PersistedFinishedAlertEpisode,
} from './finished-alert-episodes.js';
import type { OrchestrationStreamPresenceSubject } from './orchestration-stream-presence.js';
import {
  acceptsTurnTerminalEvent,
  isDeferredRetriableTurnError,
  nextTurnIdentityAnchor,
  type TurnIdentityAnchor,
} from './session-lifecycle-service.js';

const TURN_COMPLETION_SOURCE = TURN_COMPLETION_NOTIFICATION_SOURCE;
const SESSION_KIND = 'runtime';

/**
 * `replied` (#2324, owner decision D1): a turn the engine opened on its own
 * finished — a reply nobody sent a message for, such as after background
 * work. Delivered in the `turn-completed` category, worded as a reply.
 * `reply-failed` (#2324 review F1): such a turn failed — its own error
 * result, or the recovery abort boot publishes for one a crashed process
 * left open. Still a failure worth an offline push, worded as the agent's
 * reply failing rather than a turn the user started needing attention. A
 * provider turn the live process closes without its result (the engine
 * ended, or moved on) is `turn.completed` with `closedWithoutResult` and
 * pushes nothing.
 */
type TurnOutcome = 'done' | 'failed' | 'stopped' | 'replied' | 'reply-failed';

interface TurnCompletionOrchestrationService {
  isReadOnlyAttachedSession(threadId: string): boolean;
  resolveSessionPresenceSubject(
    threadId: string,
  ): OrchestrationStreamPresenceSubject | undefined;
  /**
   * archive#3525: optional so no existing caller/test needs new plumbing.
   * When present, returns true (and consumes the armed entry) exactly when
   * `InternalStopSuppression.arm` marked `turnId` as a
   * stop this process initiated as internal machinery (a credential-profile
   * recovery restart, or connection-smoke cleanup) rather than a user
   * action or a genuine unattended mid-turn death.
   */
  consumeInternalStopSuppression?(turnId: string): boolean;
  /**
   * #2589: an ephemeral (webhook) session is left out of the session read
   * model the agent-activity card is built from, so its turns are never on
   * the card.
   */
  isEphemeralSession(threadId: string): boolean;
  /**
   * Why the session's "finished" alert must wait; empty when nothing holds
   * it (`OrchestrationService.readFinishedAlertHold`). The runtime passes a
   * reader that also counts queued inbox follow-ups through
   * {@link TurnCompletionNotificationOptions.readFinishedAlertHold}, which
   * takes precedence. Absent in both places: nothing holds.
   */
  readFinishedAlertHold?(threadId: string): readonly string[];
  /**
   * A Station-delegated child whose result goes back to its parent
   * conversation: its own finish is not announced. Absent: never.
   */
  isDelegatedChildSession?(threadId: string): boolean;
}

type Cancel = () => void;

export interface TurnCompletionNotificationOptions {
  /**
   * #5072: the local Project (`ProjectConfig.id`) the session recorded at
   * its start, stamped on the record so the Project's notification level and
   * foreground suppression apply. Absent or `undefined`: no Project.
   */
  resolveProjectId?: (threadId: string) => string | undefined;
  /** See {@link TurnCompletionOrchestrationService.readFinishedAlertHold}. */
  readFinishedAlertHold?: (threadId: string) => readonly string[];
  /** Defaults to {@link FINISHED_ALERT_CONFIRM_MS}. */
  confirmMs?: number;
  /** Defaults to {@link FINISHED_ALERT_RECHECK_MS}. */
  recheckMs?: number;
  /** Tests: replaces the unref'd `setTimeout` behind the confirmation. */
  setTimer?: (callback: () => void, delayMs: number) => Cancel;
  /**
   * The episode record the phone card reads (`finished-alert-episodes.ts`).
   * This listener is its only writer. Absent: a private one.
   */
  episodes?: FinishedAlertEpisodes;
  /**
   * Where pending episodes persist, so a restart before the finish is sent
   * does not lose it. Replayed when this listener is wired. Absent: memory
   * only.
   */
  episodeStore?: FinishedAlertEpisodeStore;
  /** The release time the card dates a finish from. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * A restart found the finish's record already written and delivered (the
   * process stopped after the write, before it was acknowledged): the
   * record's first NOTIFICATION_DELIVERED may never have reached its
   * readers. Called with that record instead of writing or re-emitting it,
   * which would push the phones again. The runtime hands it to the
   * coordinator wake, whose durable item dedupe drops a repeat.
   */
  onReplayedDelivery?: (notification: Notification) => void;
}

/**
 * How long a finish must stay settled (no new turn, nothing holding it)
 * before its alert goes out. An engine can end a turn moments before it
 * opens its own follow-up turn, as Claude does after a background child
 * settles.
 */
export const FINISHED_ALERT_CONFIRM_MS = 5_000;
/**
 * While a finish is held, how often its hold is read again. Events that can
 * release a hold also trigger a read; this catches releases that publish
 * nothing on the bus (an adapter's open-work flag, an owned session's row).
 */
export const FINISHED_ALERT_RECHECK_MS = 10_000;
/** A failed record write is retried after this, doubling per failure. */
export const FINISHED_ALERT_RETRY_BASE_MS = 10_000;
/** The longest wait between retries of a failed record write. */
export const FINISHED_ALERT_RETRY_MAX_MS = 10 * 60_000;

/** Whether `record` is this producer's own finish for exactly this turn. */
function isOwnFinishRecord(
  record: Notification,
  threadId: string,
  turnId: string,
): boolean {
  if (record.source !== TURN_COMPLETION_SOURCE) return false;
  if (record.category !== 'turn-completed') return false;
  const metadata = record.metadata as Record<string, unknown> | undefined;
  if (
    metadata?.sessionId !== threadId ||
    metadata.threadId !== threadId ||
    metadata.turnId !== turnId ||
    metadata.dedupeTag !== `turn-completion:${threadId}:${turnId}`
  )
    return false;
  const envelope = readNotificationEnvelope(record);
  return (
    envelope?.source.kind === 'system' &&
    envelope.source.subsystem === TURN_COMPLETION_SOURCE &&
    envelope.audience.kind === 'session-readers' &&
    envelope.audience.sessionId === threadId &&
    envelope.target?.kind === 'session' &&
    envelope.target.sessionId === threadId
  );
}

function defaultSetTimer(callback: () => void, delayMs: number): Cancel {
  const timer = setTimeout(callback, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}

/** Events that can release a held finish on any thread (see `isHoldRelevantEvent`). */
const HOLD_RELEVANT_METHODS: ReadonlySet<string> = new Set([
  'child-work.updated',
  'extension.notification',
  'session.exited',
  'session.state-changed',
  'turn.completed',
  'turn.aborted',
  'runtime.error',
]);

/**
 * #2589: whether the agent-activity card carries this terminal, so the phone
 * alert channels can leave it to the card (`isCardAlerted`). Two facts:
 *
 * - The session is listed: an ephemeral session is never on the card.
 * - The terminal leaves the session in a phase the card shows. The lifecycle
 *   fold (session-lifecycle-service.ts) turns `turn.aborted`, and a
 *   `turn.completed` whose `finishReason` is `'cancelled'`, into `canceled`,
 *   which the card leaves off (`agentActivityPhaseFor`); a completed turn
 *   (`idle`) reads Done and a `runtime.error` (`failed`) reads Failed. A
 *   test pins this against the real fold and card phase.
 *
 * Fail-soft to `false`: an unmarked notification still alerts.
 */
export function turnTerminalOnActivityCard(
  orchestrationService: Pick<
    TurnCompletionOrchestrationService,
    'isEphemeralSession'
  >,
  event: Pick<CanonicalRuntimeEvent, 'method' | 'threadId'> & {
    finishReason?: unknown;
  },
): boolean {
  const shown =
    event.method === 'runtime.error' ||
    (event.method === 'turn.completed' && event.finishReason !== 'cancelled');
  if (!shown) return false;
  try {
    return !orchestrationService.isEphemeralSession(event.threadId);
  } catch {
    return false;
  }
}

interface TurnCompletionLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

/** The subset of `EventBus.subscribe`'s message this listener reads. */
interface TurnCompletionEventMessage {
  event: string;
  data?: Record<string, unknown>;
}

/**
 * archive#3525 fix round: the "resolve recipient, decide, schedule" body
 * shared by `wireTurnCompletionNotifications` and
 * `wireInternalStopRedispatchFailureNotifications` — one push-delivery
 * decision, not two copies that could drift on title/category/dedupeTag.
 */
async function deliverTurnCompletionPush(input: {
  orchestrationService: TurnCompletionOrchestrationService;
  notificationService: NotificationService;
  threadId: string;
  turnId: string;
  outcome: TurnOutcome;
  /**
   * See {@link turnTerminalOnActivityCard}. Absent leaves the notification
   * unmarked, so it alerts: the internal-stop redispatch failure below is
   * not a terminal event the card folds.
   */
  onActivityCard?: boolean;
  resolveProjectId?: (threadId: string) => string | undefined;
}): Promise<'scheduled' | 'skipped_no_recipient' | 'skipped_external'> {
  const {
    orchestrationService,
    notificationService,
    threadId,
    turnId,
    outcome,
    onActivityCard,
  } = input;
  // Decoration only: a lookup that throws leaves the record Project-less,
  // never undelivered.
  let projectId: string | undefined;
  try {
    projectId = input.resolveProjectId?.(threadId) || undefined;
  } catch {
    projectId = undefined;
  }
  if (orchestrationService.isReadOnlyAttachedSession(threadId))
    return 'skipped_external';
  const presenceSubject =
    orchestrationService.resolveSessionPresenceSubject(threadId);
  // No subject means no one may read this session: a push would announce a
  // turn to devices whose owner cannot open it.
  if (presenceSubject === undefined) return 'skipped_no_recipient';
  // No live-stream check here: the delivery router decides per surface
  // (focused + live in-app stream → in-app only). Skipping on any open
  // stream silenced every surface while one idle client stayed connected.

  const failed = outcome === 'failed' || outcome === 'reply-failed';
  // System source, not `agent`: Station observed this terminal; no agent
  // sent it, and an agent source claims a verified station-control caller
  // (`assurance`) that does not exist here. It also keeps the per-agent
  // mutes, which apply to what an agent chose to send, off these records.
  const envelope: NotificationEnvelopeV1 = {
    v: 1,
    source: {
      kind: 'system',
      subsystem: TURN_COMPLETION_SOURCE,
      ...(projectId ? { projectId } : {}),
    },
    audience: { kind: 'session-readers', sessionId: threadId },
    // The urgency the legacy category already ranked as
    // (`classifyNotificationCategory`): a stop is quiet like a finish.
    urgency: failed ? 'failed' : 'done',
    target: { kind: 'session', sessionId: threadId },
    interrupt: 'default',
  };
  await notificationService.scheduleEnveloped(
    TURN_COMPLETION_SOURCE,
    {
      category: failed
        ? 'turn-failed'
        : outcome === 'stopped'
          ? 'turn-stopped'
          : 'turn-completed',
      title:
        outcome === 'failed'
          ? 'Your agent needs attention'
          : outcome === 'reply-failed'
            ? "Your agent's reply failed"
            : outcome === 'stopped'
              ? 'Your agent stopped'
              : outcome === 'replied'
                ? 'Your agent replied'
                : 'Your agent finished',
      body:
        outcome === 'reply-failed'
          ? `Your agent's reply on its own failed in session ${threadId}`
          : `Agent ${outcome === 'failed' ? 'failed' : outcome === 'stopped' ? 'stopped' : outcome === 'replied' ? 'replied' : 'finished'} in session ${threadId}`,
      priority:
        outcome === 'failed' || outcome === 'reply-failed' ? 'high' : 'normal',
      dedupeTag: `turn-completion:${threadId}:${turnId}`,
      metadata: {
        sessionId: threadId,
        sessionKind: SESSION_KIND,
        threadId,
        turnId,
        ...(onActivityCard ? { [ON_ACTIVITY_CARD_METADATA_KEY]: true } : {}),
      },
    },
    envelope,
  );
  return 'scheduled';
}

/**
 * Resolves the outcome this listener cares about from a canonical runtime
 * event, or `undefined` for every event method it doesn't act on. Exported
 * for unit coverage without standing up an EventBus.
 */
export function resolveTurnCompletionOutcome(
  event: Pick<CanonicalRuntimeEvent, 'method'> & {
    provider?: CanonicalRuntimeEvent['provider'];
    retriable?: boolean;
    finishReason?: unknown;
    stopReason?: unknown;
    metadata?: unknown;
  },
): TurnOutcome | undefined {
  if (event.method === 'turn.completed')
    return describeAcpTurnStopFailure(event) ? 'failed' : 'done';
  // station#2235: a recovery-synthesized abort (`recoveryTerminal`) maps
  // here like any abort — deliberately, not by omission. The needs_input
  // attention path schedules no offline push, so this is the crash's ONLY
  // offline signal ("Agent failed in session …"), the same payoff
  // archive#3473 claims for the codex-crash push above. The in-app copy is
  // owned by the interrupted-turn banner: the delivery router keeps a
  // focused, live surface to its in-app step, and the client does not toast
  // these records (`handleNotificationDeliveredToast`), so the two framings
  // do not meet as two toasts on one surface.
  if (event.method === 'turn.aborted') return 'failed';
  // archive#3442: `runtime.error` is the ONLY canonical event a genuine
  // turn/stream failure publishes while a turnId is still known — see
  // bedrock-adapter.ts's and ollama-adapter.ts's `publishTurnFailure`, and
  // codex-adapter-notifications.ts's `'error'` notification case and its
  // `turn.status === 'failed'` branch of the `turn/completed` case. Before
  // this arm, a codex usage-limit death (or any other runtime.error) matched
  // none of these branches and scheduled NO push notification at all, the
  // exact case this file exists to cover.
  //
  // archive#3451 fix round D7: the paragraph this replaces claimed
  // `codex-adapter-transport.ts`'s `finalizeUnexpectedExit` (an app-server
  // process dying mid-turn) "publishes `session.exited`, never
  // `runtime.error`" and that "a codex app-server crash mid-turn still
  // produces no push after this fix." Both were true when written and are
  // false now: archive#3473 made `finalizeUnexpectedExit` (and
  // `stopSession`, and the process `'error'` handler — archive#3451 finding
  // D3) synthesize a turn-scoped `runtime.error` (retriable left unset)
  // before publishing `session.exited`, whenever an active turn is
  // unresolved. That synthesized event has no `retriable` flag, so
  // `isDeferredRetriableTurnError` below returns false and this function
  // returns 'failed' — a codex app-server crash mid-turn now DOES schedule
  // the push. That is archive#3473's stated payoff.
  if (event.method === 'runtime.error') {
    // archive#3442 round 2 (HIGH-1): codex's app-server `'error'`
    // notification (codex-adapter-notifications.ts) is the ONE
    // `runtime.error` publish site this repo's own audit documents as not
    // proof the turn is over — see orchestration-session-state.ts's
    // `hasOpenTurn` doc: "codex may retry the same turn without a new
    // `turn.started`". When that happens, the eventual outcome shows up as
    // a LATER `turn.completed` for the SAME `turnId`, which lands on this
    // same dedupe key and corrects the stored notification (see
    // notification-service.ts's dedupe-update) — so deferring here, rather
    // than pushing an alarm that a subsequent success can never recall, is
    // the smallest fix that stays honest.
    //
    // archive#3451 fix round D7: the paragraph this replaces claimed a
    // retry loop ending via Stop had no working path at all — that this
    // event's `activeTurnId` fold left `interruptUserTurnCooperatively`
    // early-returning without ever calling `adapter.interruptTurn`, and the
    // stall watchdog's `TERMINAL_METHODS` excluded `runtime.error` in a way
    // that left its forced-stop hitting the same early return. archive#3473
    // (archive#3451 findings B1/D1 and 4/H2) fixed both, for the FIRST turn
    // on a thread: `session-lifecycle-service.ts`'s
    // `interruptibleTurnIdForEvents` now keeps a codex deferred-retriable
    // turn interruptible instead of folding it away, so Stop reaches
    // `adapter.interruptTurn`; the watchdog's `observe()` now has an
    // explicit `runtime.error` branch, clearing on a genuine terminal and
    // continuing to time a deferred one, rather than excluding the method
    // entirely. Filed separately, not fixed here: for a SECOND turn on the
    // same thread, `interruptibleTurnIdForEvents` still fails closed to "no
    // active turn" rather than trusting the event's own `turnId` — Stop for
    // turn 2+ is unfixed, and that is a deliberate design question (trust
    // the observation vs. the bounded-fact-set reconstruction), not an
    // oversight of this file.
    //
    // Still true: this listener is turnId-keyed, so a path that publishes
    // only `session.exited` with no turnId and no preceding `runtime.error`
    // (an idle-session `stopSession`/crash with no active turn to
    // synthesize a failure for) remains unrepresented here — there is no
    // turn outcome to report in that case, so this is a scope boundary, not
    // a gap.
    //
    // Gating on `retriable` alone was rejected (round-1 review): bedrock and
    // ollama's `publishTurnFailure` never set it,
    // codex-adapter-notifications' OTHER `runtime.error` site (a definitive
    // `turn.status === 'failed'`) never sets it, and
    // station-agent-adapter.ts's two `runtime.error` sites
    // (`:528`/`:1126`) hardcode `retriable: true` for turns that are
    // ALREADY terminal — both clear `activeTurnId`/`activeController`
    // synchronously in the same tick before publishing. Filtering on the
    // flag alone would silently drop those genuine failures (a false alarm
    // traded for a missing one). Requiring `provider === PROVIDER_CODEX` as
    // well scopes the defer to exactly the one adapter+flag combination the
    // audit names as ambiguous — every other provider's `runtime.error`,
    // and codex's own non-retriable/terminal `runtime.error`s, still
    // notify immediately, unchanged. A codex-family engine reached over ACP
    // carries `provider: 'acp'` (acp-adapter.ts:438), not `PROVIDER_CODEX`,
    // so it fails safe here (it still notifies) — the false-alarm class this
    // arm exists to suppress returns, unnoticed, for that path.
    // archive#3451: was a hand-copied inline condition
    // (`event.provider === PROVIDER_CODEX && event.retriable === true`) —
    // now the shared predicate `session-lifecycle-service.ts` and three
    // other consumers already use, so this file cannot independently drift
    // from what "deferred-retriable" means elsewhere. Byte-identical logic;
    // see that function's doc for the full station-agent-adapter rationale
    // the paragraph above summarizes.
    if (isDeferredRetriableTurnError(event)) {
      return undefined;
    }
    return 'failed';
  }
  return undefined;
}

/**
 * archive#3581 review MEDIUM 2: `nextTurnIdentityAnchor` retains a thread's
 * anchor for the SESSION'S LIFE now (it clears only on a fresh
 * `turn.started`, never on an accepted terminal) — so without eviction,
 * `wireTurnCompletionNotifications`'s in-memory map below would grow one
 * entry per thread that has EVER run a turn, for the life of the process.
 * Purely a leak-prevention bound, not correctness-bearing — mirrors
 * `InternalStopSuppression`'s `internalStopTurnIds` `setTimeout(...).unref()`
 * pattern, generously sized and DEBOUNCED (reset on `turn.started`/
 * `turn.completed`/`turn.aborted` for that thread — see
 * `isAnchorRelevantEvent` below — not fired-once-at-creation) since a
 * long-running turn or a slow multi-turn conversation must not have its
 * anchor evicted out from under it mid-session.
 *
 * Two failure directions, and only ONE of them was disclosed through the
 * MEDIUM 2 round (review round 3 LOW 3 caught the omission): an EARLY
 * eviction (the entry is gone sooner than 24h of real inactivity) is
 * fail-OPEN — it only degrades back to the already-disclosed fresh-restart
 * gap (permissive accept until the next `turn.started`), never to a false
 * rejection. But the session-lived anchor (MEDIUM 3) flipped what a
 * *missed* `turn.started` does: under the OLD clear-on-accept design, a
 * missed `turn.started(t2)` left the anchor `undefined`, so `t2`'s own
 * legitimate completion fell through to the permissive default and was
 * accepted (fail-open). Now the STALE anchor (still naming `t1`) survives
 * a missed `turn.started(t2)`, so `t2`'s legitimate completion is
 * REJECTED — a real "turn done" push suppressed (fail-CLOSED). Unreachable
 * today: this listener observes the same in-order EventBus every fold
 * that would need to have missed `turn.started(t2)` also observes, and an
 * empty map (process restart) is the permissive direction, not this one.
 * Written down because only the fail-open direction was, and a future
 * change to how this listener sources events (a second bus, a replay path
 * that can skip `turn.started`) would make this the live risk.
 */
const TURN_IDENTITY_ANCHOR_EVICTION_MS = 24 * 60 * 60_000;
/** Bounds the live stop-fact join if its terminal counterpart never arrives. */
const SETTLED_STOP_NOTIFICATION_RETENTION_MS = 60_000;

/**
 * archive#3581 review round 3 LOW 1: `nextTurnIdentityAnchor` can only ever
 * produce a DIFFERENT value on `turn.started` (see its doc) — every other
 * canonical method, including an accepted terminal, is a pass-through
 * no-op. So computing it (or touching the eviction timer) for every event
 * on the bus — every streamed `content.text-delta`/`content.reasoning-delta`
 * token included — is two Map operations and a timer-heap
 * `clearTimeout`+`setTimeout` pair that can never change anything, on a
 * path that already queues an async dispatch task per event. Gating to
 * `turn.started` plus the two terminal methods keeps the eviction timer
 * touched across a turn's full lifecycle (not just its start — a
 * long-running turn's LAST activity should keep resetting the TTL, not
 * only its first), while skipping the no-op cost for every progress event.
 */
function isAnchorRelevantEvent(
  event: Pick<CanonicalRuntimeEvent, 'method'>,
): boolean {
  return (
    event.method === 'turn.started' ||
    event.method === 'turn.completed' ||
    event.method === 'turn.aborted'
  );
}

export function wireTurnCompletionNotifications(
  eventBus: EventBus,
  orchestrationService: TurnCompletionOrchestrationService,
  notificationService: NotificationService,
  logger: TurnCompletionLogger,
  options: TurnCompletionNotificationOptions = {},
): () => void {
  const confirmMs = options.confirmMs ?? FINISHED_ALERT_CONFIRM_MS;
  const recheckMs = options.recheckMs ?? FINISHED_ALERT_RECHECK_MS;
  const setTimer = options.setTimer ?? defaultSetTimer;
  // One completion episode per thread. A `done` or `replied` outcome is not
  // pushed when its turn ends. It is held here until nothing holds it (see
  // finished-alert-hold.ts) and no turn has started for FINISHED_ALERT_CONFIRM_MS,
  // then ONE push goes out for the whole episode: "finished" if any turn in
  // it was the user's, "replied" if every turn was the engine's own. A later
  // turn's completion joins the episode (its turn id is the push's), so a
  // user turn followed by a provider reply after background work is one
  // alert, not two. A failure or stop ends the episode and is pushed at once,
  // as before. The record is written only at delivery: writing it early
  // would put "finished" in the in-app list while work still runs. The
  // coordinator wake reads the same delivery, so it wakes on the settled
  // finish. Each finish persists (`episodeStore`) as it moves held ->
  // writing -> released (finished-alert-episodes.ts): a restart replays the
  // rows by state, reads holds again, looks a `writing` finish's record up
  // before writing it, and sends each once nothing holds it. The
  // phone card reads the same episodes (`episodes`), so it shows Running
  // until the release and raises its one "Agent finished" from it.
  interface HeldFinish {
    turnId: string;
    outcome: 'done' | 'replied';
    onActivityCard: boolean;
    /** The episode's last terminal event: the card's entry key. */
    terminalEventId?: string;
    /** A turn started after the episode's latest completion and has not ended. */
    turnOpen: boolean;
    cancelConfirm?: Cancel;
  }
  const heldFinishes = new Map<string, HeldFinish>();
  /**
   * Released and saved as `writing`; its record is not written yet (a write
   * failed and waits for its retry, or a restart is looking it up).
   */
  interface WritingFinish {
    turnId: string;
    outcome: 'done' | 'replied';
    onActivityCard: boolean;
    terminalEventId?: string;
    attempts: number;
    nextAttemptAt?: number;
    cancelRetry?: Cancel;
    /**
     * Replayed from a restart and not yet looked up: the record may already
     * exist, so it must go through `replayWriting`, never a plain write.
     */
    needsLookup?: true;
  }
  const writingFinishes = new Map<string, WritingFinish>();
  /** Written, kept for the card's alert window (oldest first). */
  const releasedFinishes = new Map<
    string,
    { turnId: string; releaseKey: string; releasedAt: number }
  >();
  let cancelRecheck: Cancel | undefined;
  const episodes = options.episodes ?? new FinishedAlertEpisodes();
  const nowMs = options.now ?? Date.now;

  const pruneReleased = (): void => {
    const now = nowMs();
    for (const [threadId, row] of releasedFinishes)
      if (now - row.releasedAt > FINISH_ALERT_WINDOW_MS)
        releasedFinishes.delete(threadId);
  };

  /** Saves every row; false when the store refused the write. */
  const persistEpisodes = (): boolean => {
    if (!options.episodeStore) return true;
    pruneReleased();
    const rows: PersistedFinishedAlertEpisode[] = [];
    const finishOf = (
      threadId: string,
      episode: HeldFinish | WritingFinish,
    ) => ({
      threadId,
      turnId: episode.turnId,
      outcome: episode.outcome,
      onActivityCard: episode.onActivityCard,
      ...(episode.terminalEventId
        ? { terminalEventId: episode.terminalEventId }
        : {}),
    });
    for (const [threadId, row] of releasedFinishes)
      rows.push({ state: 'released', threadId, ...row });
    for (const [threadId, episode] of writingFinishes)
      rows.push({
        state: 'writing',
        ...finishOf(threadId, episode),
        attempts: episode.attempts,
        ...(episode.nextAttemptAt !== undefined
          ? { nextAttemptAt: episode.nextAttemptAt }
          : {}),
      });
    for (const [threadId, episode] of heldFinishes)
      rows.push({ state: 'held', ...finishOf(threadId, episode) });
    try {
      options.episodeStore.save(rows);
      return true;
    } catch (error) {
      logger.warn('turn-completion: pending finished alerts were not saved', {
        error: errorMessage(error),
      });
      return false;
    }
  };

  const episodeRows = (): number =>
    heldFinishes.size + writingFinishes.size + releasedFinishes.size;

  /**
   * Whether a new held finish fits under FINISHED_ALERT_EPISODES_MAX, in
   * memory and on disk alike. Released rows give way first (only a card
   * re-date is lost, never a record); held and writing ones never do, so a
   * full store refuses the newcomer instead.
   */
  const admitHeld = (threadId: string): boolean => {
    if (heldFinishes.has(threadId) || writingFinishes.has(threadId))
      return true;
    if (episodeRows() < FINISHED_ALERT_EPISODES_MAX) return true;
    pruneReleased();
    for (const releasedThread of releasedFinishes.keys()) {
      if (episodeRows() < FINISHED_ALERT_EPISODES_MAX) break;
      releasedFinishes.delete(releasedThread);
    }
    return episodeRows() < FINISHED_ALERT_EPISODES_MAX;
  };

  const setHeldFinish = (threadId: string, episode: HeldFinish): void => {
    heldFinishes.get(threadId)?.cancelConfirm?.();
    // An older finish on this thread whose write failed is replaced: the
    // newer one covers the episode, as one alert, and an older turn never
    // shadows it.
    writingFinishes.get(threadId)?.cancelRetry?.();
    writingFinishes.delete(threadId);
    heldFinishes.set(threadId, episode);
    episodes.setHeld(threadId, true);
    persistEpisodes();
  };

  const readHold = (threadId: string): readonly string[] => {
    try {
      return (
        options.readFinishedAlertHold?.(threadId) ??
        orchestrationService.readFinishedAlertHold?.(threadId) ??
        []
      );
    } catch (error) {
      // Fail open: an unreadable hold must not swallow the alert.
      logger.warn('turn-completion: finished-alert hold is unreadable', {
        threadId,
        error: errorMessage(error),
      });
      return [];
    }
  };

  const isDelegatedChild = (threadId: string): boolean => {
    try {
      return orchestrationService.isDelegatedChildSession?.(threadId) === true;
    } catch (error) {
      // Fail open: announce the finish rather than lose it.
      logger.warn('turn-completion: delegated-child lookup failed', {
        threadId,
        error: errorMessage(error),
      });
      return false;
    }
  };

  const dropHeldFinish = (threadId: string): void => {
    const pending = heldFinishes.get(threadId);
    const writing = writingFinishes.get(threadId);
    if (!pending && !writing) return;
    pending?.cancelConfirm?.();
    heldFinishes.delete(threadId);
    // A finish still waiting on a write retry ends with the episode too: a
    // later failure, stop or child result must not be followed by it.
    writing?.cancelRetry?.();
    writingFinishes.delete(threadId);
    episodes.setHeld(threadId, false);
    persistEpisodes();
  };

  const armRecheck = (): void => {
    if (cancelRecheck) return;
    cancelRecheck = setTimer(() => {
      cancelRecheck = undefined;
      notificationService.dispatch(TURN_COMPLETION_SOURCE, async () => {
        for (const threadId of [...heldFinishes.keys()])
          evaluateHeldFinish(threadId);
      });
    }, recheckMs);
  };

  /**
   * This producer's record exists (written now, or found delivered on a
   * restart): the row becomes `released` and is saved before the card hears
   * of it. A failed save is
   * logged and the card is still told, since the record exists; a restart
   * then reads the row as `writing`, finds the record and does not write it
   * again.
   */
  const releaseWritten = (threadId: string, writing: WritingFinish): void => {
    if (writingFinishes.get(threadId) !== writing) return;
    writingFinishes.delete(threadId);
    const release = {
      key: writing.terminalEventId
        ? `event:${writing.terminalEventId}`
        : `finish:${writing.turnId}`,
      at: nowMs(),
    };
    releasedFinishes.delete(threadId);
    releasedFinishes.set(threadId, {
      turnId: writing.turnId,
      releaseKey: release.key,
      releasedAt: release.at,
    });
    persistEpisodes();
    // A newer finish already held on this thread owns the card's entry.
    if (!heldFinishes.has(threadId)) episodes.recordRelease(threadId, release);
  };

  /**
   * The finish ends without a record of this producer's behind it (a refused
   * or ambiguous replay, a tag another producer owns, a session no one may
   * read): only that row goes, with no release, so the card reads Done
   * without an "Agent finished". A newer held finish on the thread keeps the
   * card held, and an earlier legitimate release is left as it is.
   */
  const endUnreleased = (threadId: string, writing: WritingFinish): void => {
    if (writingFinishes.get(threadId) !== writing) return;
    writing.cancelRetry?.();
    writingFinishes.delete(threadId);
    persistEpisodes();
    if (!heldFinishes.has(threadId)) episodes.setHeld(threadId, false);
  };

  const attemptWrite = async (
    threadId: string,
    writing: WritingFinish,
  ): Promise<void> => {
    if (writingFinishes.get(threadId) !== writing) return;
    writing.cancelRetry = undefined;
    let result: Awaited<ReturnType<typeof deliverTurnCompletionPush>>;
    try {
      result = await deliverTurnCompletionPush({
        orchestrationService,
        notificationService,
        threadId,
        turnId: writing.turnId,
        outcome: writing.outcome,
        onActivityCard: writing.onActivityCard,
        resolveProjectId: options.resolveProjectId,
      });
    } catch (error) {
      if (writingFinishes.get(threadId) !== writing) return;
      if (error instanceof NotificationDedupeSourceConflictError) {
        // Another producer owns this tag: no retry can write it. The episode
        // ends without a record rather than holding the card in Running.
        logger.warn(
          'turn-completion: a finished alert cannot be written; its tag belongs to another producer',
          { threadId, turnId: writing.turnId },
        );
        turnCompletionNotificationOps.add(1, {
          outcome: writing.outcome,
          result: 'skipped_tag_conflict',
        });
        endUnreleased(threadId, writing);
        return;
      }
      retryLater(threadId, writing, error, attemptWrite);
      return;
    }
    turnCompletionNotificationOps.add(1, { outcome: writing.outcome, result });
    // No record was written (no one may read the session, or it is an
    // external transcript): nothing to announce.
    if (result !== 'scheduled') {
      endUnreleased(threadId, writing);
      return;
    }
    releaseWritten(threadId, writing);
  };

  /**
   * A write (or a restart's record lookup) failed: no release, so the card
   * keeps the finish pending, and the row stays `writing` until `run` is
   * tried again, after 10 s doubling to at most 10 min.
   */
  function retryLater(
    threadId: string,
    writing: WritingFinish,
    error: unknown,
    run: (threadId: string, writing: WritingFinish) => Promise<void>,
  ): void {
    writing.attempts += 1;
    const delayMs = Math.min(
      FINISHED_ALERT_RETRY_BASE_MS * 2 ** (writing.attempts - 1),
      FINISHED_ALERT_RETRY_MAX_MS,
    );
    writing.nextAttemptAt = nowMs() + delayMs;
    persistEpisodes();
    turnCompletionNotificationOps.add(1, {
      outcome: writing.outcome,
      result: 'error',
    });
    logger.warn('turn-completion: a finished alert was not written', {
      threadId,
      attempts: writing.attempts,
      retryInMs: delayMs,
      error: errorMessage(error),
    });
    writing.cancelRetry = setTimer(() => {
      notificationService.dispatch(TURN_COMPLETION_SOURCE, () =>
        run(threadId, writing),
      );
    }, delayMs);
  }

  /**
   * A restart found this finish saved as `writing`: the process may have
   * stopped after its record was written. The record decides:
   *
   * - none: it was never written, or the person cleared it; the two look
   *   the same, so nothing is written, pushed or announced
   *   (`replay_ambiguous`);
   * - this producer's own record for this turn, still `delivered` and not
   *   held by an action: handed to `onReplayedDelivery` if the thread still
   *   has a reader. It is never rewritten (a rewrite resets its read state)
   *   and NOTIFICATION_DELIVERED is not emitted again (that pushes phones);
   * - dismissed, actioned, expired, snoozed (`pending`), leased, readerless,
   *   or not this producer's: the person's decision or the other owner
   *   stands; nothing is replayed and the card gets no release. A snoozed
   *   record is delivered by the service when the snooze ends.
   */
  const replayWriting = async (
    threadId: string,
    writing: WritingFinish,
  ): Promise<void> => {
    if (writingFinishes.get(threadId) !== writing) return;
    writing.cancelRetry = undefined;
    let found: Awaited<ReturnType<NotificationService['findByDedupeTag']>>;
    let hasReader: boolean;
    try {
      found = await notificationService.findByDedupeTag(
        `turn-completion:${threadId}:${writing.turnId}`,
      );
      hasReader =
        !orchestrationService.isReadOnlyAttachedSession(threadId) &&
        orchestrationService.resolveSessionPresenceSubject(threadId) !==
          undefined;
    } catch (error) {
      if (writingFinishes.get(threadId) !== writing) return;
      retryLater(threadId, writing, error, replayWriting);
      return;
    }
    if (writingFinishes.get(threadId) !== writing) return;
    delete writing.needsLookup;
    if (!found) {
      logger.warn(
        'turn-completion: replay_ambiguous: a saved finish has no record, and a cleared one looks the same; not replayed',
        { threadId, turnId: writing.turnId },
      );
      turnCompletionNotificationOps.add(1, {
        outcome: writing.outcome,
        result: 'replay_ambiguous',
      });
      endUnreleased(threadId, writing);
      return;
    }
    const { notification, leased } = found;
    const own = isOwnFinishRecord(notification, threadId, writing.turnId);
    if (!own)
      logger.warn(
        'turn-completion: a saved finish names a record this producer did not write; not replayed',
        { threadId, turnId: writing.turnId },
      );
    if (!(own && notification.status === 'delivered' && !leased && hasReader)) {
      turnCompletionNotificationOps.add(1, {
        outcome: writing.outcome,
        result: 'replay_skipped',
      });
      endUnreleased(threadId, writing);
      return;
    }
    try {
      options.onReplayedDelivery?.(notification);
    } catch (error) {
      logger.warn('turn-completion: a replayed finish was not handed on', {
        threadId,
        error: errorMessage(error),
      });
    }
    turnCompletionNotificationOps.add(1, {
      outcome: writing.outcome,
      result: 'replayed',
    });
    releaseWritten(threadId, writing);
  };

  const confirmHeldFinish = async (
    threadId: string,
    expected: HeldFinish,
  ): Promise<void> => {
    const pending = heldFinishes.get(threadId);
    if (pending !== expected) return;
    pending.cancelConfirm = undefined;
    if (pending.turnOpen) return;
    if (readHold(threadId).length > 0) {
      armRecheck();
      return;
    }
    // held -> writing, saved before the record is written: nothing is
    // announced on a state a restart could not resume.
    const superseded = writingFinishes.get(threadId);
    const writing: WritingFinish = {
      turnId: pending.turnId,
      outcome: pending.outcome,
      onActivityCard: pending.onActivityCard,
      ...(pending.terminalEventId
        ? { terminalEventId: pending.terminalEventId }
        : {}),
      attempts: 0,
    };
    heldFinishes.delete(threadId);
    writingFinishes.set(threadId, writing);
    if (!persistEpisodes()) {
      writingFinishes.delete(threadId);
      if (superseded) writingFinishes.set(threadId, superseded);
      heldFinishes.set(threadId, pending);
      armRecheck();
      return;
    }
    superseded?.cancelRetry?.();
    await attemptWrite(threadId, writing);
  };

  /** Starts, keeps, or cancels the episode's confirmation window. */
  function evaluateHeldFinish(threadId: string): void {
    const pending = heldFinishes.get(threadId);
    if (!pending || pending.turnOpen) return;
    if (readHold(threadId).length > 0) {
      // Work is running: any window in progress no longer counts.
      pending.cancelConfirm?.();
      pending.cancelConfirm = undefined;
      armRecheck();
      return;
    }
    if (pending.cancelConfirm) return;
    pending.cancelConfirm = setTimer(() => {
      notificationService.dispatch(TURN_COMPLETION_SOURCE, async () => {
        try {
          await confirmHeldFinish(threadId, pending);
        } catch (error) {
          turnCompletionNotificationOps.add(1, { result: 'error' });
          logger.warn(
            'turn-completion: failed to schedule a push-on-completion notification',
            { error: errorMessage(error) },
          );
        }
      });
    }, confirmMs);
  }

  // archive#3573: a third, independent turn-identity fold, scoped to the
  // life of this one wiring (fresh per call) — deliberately NOT a call into
  // `OrchestrationService`. This listener observes the SAME event stream
  // `deriveLifecycleTransition`/`deriveAgentRunStatus` fold (every published
  // `CanonicalRuntimeEvent` reaches this subscriber, and
  // `notificationService.dispatch('turn-completion', ...)` chains every task
  // onto one shared queue, so events for a given thread are processed in
  // publish order), so it can track `nextTurnIdentityAnchor` itself and
  // reuse the exported `acceptsTurnTerminalEvent` predicate rather than
  // growing a fourth variant of the guard. Known, disclosed gap: this map is
  // in-memory only and starts empty on every process restart, so a stale
  // terminal for a turn that started before a restart is not guarded until
  // this listener observes a subsequent `turn.started` for that thread —
  // the same class of fresh-start gap already accepted for
  // `internalStopTurnIds`. Bounded by `TURN_IDENTITY_ANCHOR_EVICTION_MS`
  // (see its doc) so an ended thread does not occupy this map forever, and
  // cleared entirely by the returned disposer below (review round 3 LOW 2)
  // so unwiring this listener does not leave timers (each retaining a
  // closure over both Maps) alive for up to 24h afterward.
  const turnIdentityAnchors = new Map<string, TurnIdentityAnchor>();
  const turnIdentityAnchorEvictionTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  // The EventBus publishes the forced-stop fact immediately before
  // `turn.aborted`. Retain that one exact turn identity long enough to join
  // the two events without changing the notification system into a reader of
  // the event store's durable projection.
  const settledStops = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; reported: boolean }
  >();
  const stopKey = (threadId: string, turnId: string) => `${threadId}:${turnId}`;

  const rememberSettledStop = (threadId: string, turnId: string): void => {
    const key = stopKey(threadId, turnId);
    const existing = settledStops.get(key);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      settledStops.delete(key);
    }, SETTLED_STOP_NOTIFICATION_RETENTION_MS);
    timer.unref?.();
    settledStops.set(key, { timer, reported: existing?.reported ?? false });
  };

  const touchTurnIdentityAnchorEviction = (threadId: string): void => {
    const existing = turnIdentityAnchorEvictionTimers.get(threadId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      turnIdentityAnchors.delete(threadId);
      turnIdentityAnchorEvictionTimers.delete(threadId);
    }, TURN_IDENTITY_ANCHOR_EVICTION_MS);
    timer.unref?.();
    turnIdentityAnchorEvictionTimers.set(threadId, timer);
  };

  const unsubscribe = eventBus.subscribe(
    (message: TurnCompletionEventMessage) => {
      // A completed turn may start or extend an episode. Mark it pending
      // now, on the bus, so the phone card cannot read it as Done before
      // the queued task below decides.
      const observed =
        message.event === SERVER_EVENTS.ORCHESTRATION_EVENT
          ? (message.data?.event as CanonicalRuntimeEvent | undefined)
          : undefined;
      const deciding =
        observed?.method === 'turn.completed' &&
        typeof observed.threadId === 'string' &&
        observed.turnId
          ? observed.threadId
          : undefined;
      if (deciding) episodes.beginDeciding(deciding);
      // A projection change publishes no runtime event (Claude's pending
      // follow-up expiring, for one): it can still release a held finish.
      const projectionThread =
        message.event ===
          SERVER_EVENTS.ORCHESTRATION_SESSION_PROJECTION_UPDATED &&
        typeof message.data?.threadId === 'string'
          ? message.data.threadId
          : undefined;
      if (projectionThread !== undefined && !heldFinishes.has(projectionThread))
        return;
      notificationService.dispatch(TURN_COMPLETION_SOURCE, async () => {
        try {
          if (projectionThread !== undefined) {
            evaluateHeldFinish(projectionThread);
            return;
          }
          if (
            message.event !== SERVER_EVENTS.ORCHESTRATION_EVENT ||
            !message.data?.event
          ) {
            return;
          }

          const event = message.data.event as CanonicalRuntimeEvent;

          if (event.method === 'session.stop-settled' && event.turnId) {
            rememberSettledStop(event.threadId, event.turnId);
            return;
          }

          // archive#3573: read BEFORE the outcome/early-return checks below
          // so a `turn.started` for a second turn on this thread is never
          // missed by the guard further down — the anchor must be current
          // for every relevant event, not only the ones this listener acts
          // on. The fold itself (and the eviction touch) only runs for
          // `isAnchorRelevantEvent` — see that function's doc — since
          // `nextTurnIdentityAnchor` is a no-op for everything else and a
          // `.get()` alone is cheap enough to pay unconditionally.
          const previousAnchor = turnIdentityAnchors.get(event.threadId);
          if (isAnchorRelevantEvent(event)) {
            // `nextTurnIdentityAnchor` can only return `undefined` here when
            // `previousAnchor` was ALREADY `undefined` (no turn has ever
            // started for this thread) — once a turn has started, the anchor
            // is retained for the session's life (archive#3581 MEDIUM 3), so
            // there is no "clear the map entry" case left to handle; only
            // "set" is reachable.
            const nextAnchor = nextTurnIdentityAnchor(previousAnchor, event);
            if (nextAnchor !== undefined) {
              turnIdentityAnchors.set(event.threadId, nextAnchor);
            }
            touchTurnIdentityAnchorEviction(event.threadId);
          }

          // A new turn on a held episode's thread cancels its confirmation
          // window; the turn's own end decides what comes next.
          if (event.method === 'turn.started') {
            // A finish whose write failed and waits on a retry rejoins the
            // episode as held with this turn open: its alert must not go
            // out while the new turn runs; the turn's end decides.
            const waiting = writingFinishes.get(event.threadId);
            if (
              waiting &&
              !waiting.needsLookup &&
              !heldFinishes.has(event.threadId)
            ) {
              waiting.cancelRetry?.();
              writingFinishes.delete(event.threadId);
              heldFinishes.set(event.threadId, {
                turnId: waiting.turnId,
                outcome: waiting.outcome,
                onActivityCard: waiting.onActivityCard,
                ...(waiting.terminalEventId
                  ? { terminalEventId: waiting.terminalEventId }
                  : {}),
                turnOpen: true,
              });
              persistEpisodes();
            }
            const episode = heldFinishes.get(event.threadId);
            if (episode) {
              episode.turnOpen = true;
              episode.cancelConfirm?.();
              episode.cancelConfirm = undefined;
            }
          }
          // A child settling, a delegated session ending, or Claude's
          // follow-up fact can release a held finish on this thread or its
          // parent. A terminal on this thread is handled below instead.
          if (
            heldFinishes.size > 0 &&
            HOLD_RELEVANT_METHODS.has(event.method)
          ) {
            const ownTerminal =
              event.method === 'turn.completed' ||
              event.method === 'turn.aborted' ||
              event.method === 'runtime.error';
            for (const threadId of [...heldFinishes.keys()])
              if (!ownTerminal || threadId !== event.threadId)
                evaluateHeldFinish(threadId);
          }

          let outcome = resolveTurnCompletionOutcome(event);
          if (!outcome || !event.turnId) return;
          const providerTurn = isProviderTriggeredTurn(event);

          // archive#3573: a stale `turn.completed`/`turn.aborted` naming a
          // turn the session has already moved past (codex's own protocol
          // timing — see codex-adapter-notifications.ts's `'turn/completed'`
          // case, archive#3572) must not fire a "turn done"/"needs attention" push
          // while a LATER turn on the same thread is still running. Checked
          // against the anchor as of BEFORE this event (`previousAnchor`),
          // mirroring `deriveLifecycleTransition`/`deriveAgentRunStatus`'s own
          // guard on the identical events.
          if (
            (event.method === 'turn.completed' ||
              event.method === 'turn.aborted' ||
              (event.method === 'runtime.error' &&
                typeof previousAnchor === 'object' &&
                (event.turnId !== undefined ||
                  event.invocationId !== undefined))) &&
            !acceptsTurnTerminalEvent(event, previousAnchor)
          ) {
            turnCompletionNotificationOps.add(1, {
              outcome,
              result: 'skipped_stale_terminal',
            });
            return;
          }

          const settledStop =
            event.method === 'turn.completed' || event.method === 'turn.aborted'
              ? settledStops.get(stopKey(event.threadId, event.turnId))
              : undefined;
          if (settledStop?.reported) return;

          // The terminal is accepted: the turn a held episode was waiting
          // on has ended, whatever it is about to be reported as.
          const episode = heldFinishes.get(event.threadId);
          if (episode) episode.turnOpen = false;

          // A Codex stop can confirm as turn.completed with
          // finishReason:'cancelled'; the settled-stop fact is the proof that
          // this particular completion was a stop, while an unaccompanied
          // cancelled completion keeps its existing done mapping.
          if (settledStop) {
            // Keep the exact Stop until its normal expiry. A legacy
            // duplicate terminal must not turn it into a finished alert.
            settledStop.reported = true;
            // #2324 (D1): a provider turn is never reported "stopped" — the
            // Stop was the user's own act on a reply they did not ask for.
            if (providerTurn) {
              // The person stopped it, so they are here: the episode ends
              // without an alert.
              dropHeldFinish(event.threadId);
              turnCompletionNotificationOps.add(1, {
                outcome: 'stopped',
                result: 'skipped_provider_turn',
              });
              return;
            }
            outcome = 'stopped';
          }
          if (providerTurn && event.method === 'turn.completed') {
            // Closed without its own result (a send the engine folded into
            // it, a new turn, the session ending): whatever came next carries
            // the news, so this one does not add a push of its own. Read
            // from the adapter's own marker, not `finishReason`: a reply that
            // ended on a deferred tool is `'other'` too, and is a reply.
            if (event.metadata?.closedWithoutResult !== undefined) {
              // An episode it interrupted resumes waiting. This terminal is
              // now the one the card's Done derives from, so the release
              // names it: a key from before this turn would never match.
              const interrupted = heldFinishes.get(event.threadId);
              if (interrupted && event.eventId) {
                interrupted.terminalEventId = event.eventId;
                persistEpisodes();
              }
              evaluateHeldFinish(event.threadId);
              turnCompletionNotificationOps.add(1, {
                outcome,
                result: 'skipped_provider_turn',
              });
              return;
            }
            if (outcome === 'done') outcome = 'replied';
          }
          if (providerTurn && outcome === 'failed') outcome = 'reply-failed';

          // archive#3525: a stop this process initiated as internal machinery
          // (not a user action, not an unattended mid-turn death) armed this
          // exact turn id for exactly one suppressed push. See
          // `InternalStopSuppression`'s `internalStopTurnIds` doc for why this is
          // keyed by turn id rather than a presence/thread check.
          //
          // Gated on a non-clean outcome (fix round, MEDIUM 1): only ever
          // CONSUME the armed entry for the failure/stop this mechanism exists
          // to suppress. A genuine `turn.completed` can race into the window
          // between arming and the `stopSession` call resolving (the armed
          // turn was already finishing naturally) — checking this before the
          // outcome branch swallowed that legitimate "done" push entirely, so
          // a successfully finished turn produced no notification at all. A
          // 'done' outcome now leaves the entry armed (harmless: the same
          // turn id cannot legitimately publish a second terminal, so it is
          // reclaimed later by the leak-prevention timer, never by a real
          // event) and always schedules normally.
          if (
            (outcome === 'failed' ||
              outcome === 'reply-failed' ||
              outcome === 'stopped') &&
            orchestrationService.consumeInternalStopSuppression?.(event.turnId)
          ) {
            // The redispatch's `turn.started` cancels this window.
            evaluateHeldFinish(event.threadId);
            turnCompletionNotificationOps.add(1, {
              outcome,
              result: 'skipped_internal_stop',
            });
            return;
          }

          if (outcome === 'done' || outcome === 'replied') {
            if (isDelegatedChild(event.threadId)) {
              dropHeldFinish(event.threadId);
              turnCompletionNotificationOps.add(1, {
                outcome,
                result: 'skipped_delegated_child',
              });
              return;
            }
            if (!admitHeld(event.threadId)) {
              // Every row is a held or unwritten finish: those are kept, and
              // this one is not announced. Recovery is the store draining.
              logger.warn(
                `finished-alert episodes full (${FINISHED_ALERT_EPISODES_MAX}); finish for ${event.threadId} not held`,
                { threadId: event.threadId },
              );
              turnCompletionNotificationOps.add(1, {
                outcome,
                result: 'overflow',
              });
              return;
            }
            const previous =
              heldFinishes.get(event.threadId) ??
              writingFinishes.get(event.threadId);
            setHeldFinish(event.threadId, {
              turnId: event.turnId,
              ...(event.eventId ? { terminalEventId: event.eventId } : {}),
              outcome:
                previous?.outcome === 'done' || outcome === 'done'
                  ? 'done'
                  : 'replied',
              onActivityCard: turnTerminalOnActivityCard(
                orchestrationService,
                event,
              ),
              turnOpen: false,
            });
            turnCompletionNotificationOps.add(1, {
              outcome,
              result: 'deferred',
            });
            evaluateHeldFinish(event.threadId);
            return;
          }

          // A failure or stop ends the episode and is reported at once.
          dropHeldFinish(event.threadId);
          const result = await deliverTurnCompletionPush({
            orchestrationService,
            notificationService,
            threadId: event.threadId,
            turnId: event.turnId,
            outcome,
            onActivityCard: turnTerminalOnActivityCard(
              orchestrationService,
              event,
            ),
            resolveProjectId: options.resolveProjectId,
          });
          turnCompletionNotificationOps.add(1, { outcome, result });
        } catch (error) {
          // See the file-header note: never rethrow — EventBus permanently
          // unsubscribes a throwing listener.
          turnCompletionNotificationOps.add(1, { result: 'error' });
          logger.warn(
            'turn-completion: failed to schedule a push-on-completion notification',
            { error: errorMessage(error) },
          );
        } finally {
          if (deciding) episodes.endDeciding(deciding);
        }
      });
    },
  );

  // Restart: rows come back by state, never by position. A release still in
  // the card's window re-dates the card; a `writing` row is looked up before
  // anything is written; a held one is read again (no turn is open: the
  // engine did not survive the restart) and sent once nothing holds it,
  // through the same confirmation window.
  if (options.episodeStore) {
    let replayed: PersistedFinishedAlertEpisode[] = [];
    try {
      replayed = options.episodeStore.load();
    } catch (error) {
      logger.warn(
        'turn-completion: pending finished alerts are unreadable; none were replayed',
        { error: errorMessage(error) },
      );
    }
    const now = nowMs();
    for (const row of replayed) {
      if (row.state !== 'released') continue;
      if (now - row.releasedAt > FINISH_ALERT_WINDOW_MS) continue;
      releasedFinishes.delete(row.threadId);
      releasedFinishes.set(row.threadId, {
        turnId: row.turnId,
        releaseKey: row.releaseKey,
        releasedAt: row.releasedAt,
      });
      episodes.recordRelease(row.threadId, {
        key: row.releaseKey,
        at: row.releasedAt,
      });
    }
    for (const row of replayed) {
      if (row.state === 'released') continue;
      const finish = {
        turnId: row.turnId,
        outcome: row.outcome,
        onActivityCard: row.onActivityCard,
        ...(row.terminalEventId
          ? { terminalEventId: row.terminalEventId }
          : {}),
      };
      if (row.state === 'writing')
        writingFinishes.set(row.threadId, {
          ...finish,
          needsLookup: true,
          attempts: row.attempts,
          ...(row.nextAttemptAt !== undefined
            ? { nextAttemptAt: row.nextAttemptAt }
            : {}),
        });
      else heldFinishes.set(row.threadId, { ...finish, turnOpen: false });
      episodes.setHeld(row.threadId, true);
    }
    if (heldFinishes.size > 0 || writingFinishes.size > 0)
      notificationService.dispatch(TURN_COMPLETION_SOURCE, async () => {
        for (const [threadId, writing] of [...writingFinishes]) {
          try {
            await replayWriting(threadId, writing);
          } catch (error) {
            // The row stays `writing`: the next start looks it up again.
            logger.warn('turn-completion: a saved finish could not be read', {
              threadId,
              error: errorMessage(error),
            });
          }
        }
        for (const threadId of [...heldFinishes.keys()])
          evaluateHeldFinish(threadId);
      });
  }

  // archive#3581 review round 3 LOW 2: unwiring this listener must also
  // clear every pending eviction timer, not just the EventBus subscription.
  // Each `.unref()`d timer cannot hold the process open by itself, but it
  // retains a closure over BOTH maps for up to 24h after the listener that
  // populated them is gone — real cost in a repeatedly-wired-and-unwired
  // context (this wires fresh per test, and any future dynamic
  // wire/unwire caller would accumulate the same way).
  return () => {
    unsubscribe();
    for (const timer of turnIdentityAnchorEvictionTimers.values()) {
      clearTimeout(timer);
    }
    turnIdentityAnchorEvictionTimers.clear();
    turnIdentityAnchors.clear();
    for (const { timer } of settledStops.values()) clearTimeout(timer);
    settledStops.clear();
    for (const episode of heldFinishes.values()) episode.cancelConfirm?.();
    for (const writing of writingFinishes.values()) writing.cancelRetry?.();
    // Unwiring is not settling: the saved episodes stay for the next start.
    heldFinishes.clear();
    writingFinishes.clear();
    releasedFinishes.clear();
    if (!options.episodes) episodes.clear();
    cancelRecheck?.();
    cancelRecheck = undefined;
  };
}

/**
 * archive#3525 fix round FIX 1: the corrective half of internal-stop
 * suppression. `wireTurnCompletionNotifications`'s suppression check
 * (`consumeInternalStopSuppression`) reliably WINS its race against a
 * caller's later failure — proven live: the adapter's orphaned
 * `runtime.error` for a stopped turn is observed essentially synchronously
 * with `stopSession()` returning, well before a credential-profile
 * restart's OWN several-`await` failure path (`resolveSessionAgentForStart`,
 * `admitEngineStart`, `adapter.startSession`) can ever catch up — so a plain
 * "rescind the Set entry in a catch block" cannot undo a suppression that
 * already happened. Once the failure is genuinely known,
 * `OrchestrationService` emits `SERVER_EVENTS.INTERNAL_STOP_REDISPATCH_FAILED`
 * (never a `CanonicalRuntimeEvent` — this is Station's own bookkeeping fact,
 * not a provider-reported one) and THIS listener turns it into the exact
 * same "Your agent needs attention" push the generic listener would have
 * sent had it never suppressed anything, at the point the outcome is
 * actually known instead of guessed. A separate `EventBus` subscription
 * (not folded into `wireTurnCompletionNotifications`), but NOT a separate
 * dispatch queue — fix round correction: both listeners call
 * `notificationService.dispatch(...)`, which chains every task from every
 * `operation` onto the SAME `asyncDispatchTail` on the SAME
 * `NotificationService` instance. There is exactly one shared queue; nothing
 * here gives this channel its own. What actually keeps this from blocking
 * unrelated notifications is that nothing in this task `await`s the restart
 * itself — by the time `INTERNAL_STOP_REDISPATCH_FAILED` fires, the restart
 * has already concluded (successfully or not), so this dispatched task only
 * does a recipient check and one `scheduleEnveloped()` call, the same bounded work
 * `wireTurnCompletionNotifications`'s own task does.
 */
export function wireInternalStopRedispatchFailureNotifications(
  eventBus: EventBus,
  orchestrationService: TurnCompletionOrchestrationService,
  notificationService: NotificationService,
  logger: TurnCompletionLogger,
  options: Pick<TurnCompletionNotificationOptions, 'resolveProjectId'> = {},
): () => void {
  return eventBus.subscribe((message: TurnCompletionEventMessage) => {
    notificationService.dispatch(
      'internal-stop-redispatch-failed',
      async () => {
        try {
          if (
            message.event !== SERVER_EVENTS.INTERNAL_STOP_REDISPATCH_FAILED ||
            typeof message.data?.threadId !== 'string' ||
            typeof message.data?.turnId !== 'string'
          ) {
            return;
          }
          const result = await deliverTurnCompletionPush({
            orchestrationService,
            notificationService,
            threadId: message.data.threadId,
            turnId: message.data.turnId,
            outcome: 'failed',
            resolveProjectId: options.resolveProjectId,
          });
          turnCompletionNotificationOps.add(1, { outcome: 'failed', result });
        } catch (error) {
          turnCompletionNotificationOps.add(1, { result: 'error' });
          logger.warn(
            'internal-stop-redispatch-failed: failed to schedule a push-on-completion notification',
            { error: errorMessage(error) },
          );
        }
      },
    );
  });
}
