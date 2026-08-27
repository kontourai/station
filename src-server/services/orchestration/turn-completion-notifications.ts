/**
 * wireTurnCompletionNotifications — station#1225 (offline slice 3):
 * push-on-completion, the second half of "the differentiator". A turn that
 * completes or fails while its owning user is NOT actively connected to
 * `/api/orchestration/events` gets a Web Push notification ("Your agent
 * finished") through the exact SAME pipeline `wireApprovalInboxNotifications`
 * (`../approvals/approval-inbox.ts`) and `wireWebPushDelivery`
 * (`../notifications/web-push-delivery.ts`) already provide for
 * approval-request/job-failure notifications — this module only decides
 * WHEN to call `NotificationService.schedule()`, never how a scheduled
 * notification reaches a device.
 *
 * The "is anyone watching?" gate (never double-notify a connected client):
 * `OrchestrationStreamPresence` tracks live `/events` subscribers per user
 * (wired in `orchestration.ts`'s `/events` route); this listener resolves the
 * completed session's private presence subject through
 * `OrchestrationService.resolveSessionPresenceSubject` and skips scheduling
 * only when that exact subject holds a live stream. Hosted subjects include
 * the persisted tenant binding; an incomplete hosted binding never borrows a
 * same-user stream from another tenant. Personal ownerless sessions retain
 * their single-user-compatible any-connected-user fallback inside that seam.
 *
 * Body is deliberately minimal (`Agent finished in session <threadId>`) —
 * never the turn's `outputText` — matching station#1225's guardrail against
 * a push notification leaking response content.
 *
 * The EventBus callback stays synchronous and delegates to NotificationService's
 * one ordered, rejection-safe async adapter. The inner try/catch records an
 * operation-level failure; the adapter observes any rejection that escapes it
 * without creating an unhandled promise or poisoning later notifications.
 */
import {
  type CanonicalRuntimeEvent,
  SERVER_EVENTS,
} from '@kontourai/station-contracts/runtime-events';
import { turnCompletionNotificationOps } from '../../telemetry/metrics.js';
import type { NotificationService } from '../notifications/notification-service.js';
import type { EventBus } from './event-bus.js';
import type {
  OrchestrationStreamPresence,
  OrchestrationStreamPresenceSubject,
} from './orchestration-stream-presence.js';
import {
  acceptsTurnTerminalEvent,
  isDeferredRetriableTurnError,
  nextTurnIdentityAnchor,
} from './session-lifecycle-service.js';

const TURN_COMPLETION_SOURCE = 'turn-completion';
const SESSION_KIND = 'runtime';

type TurnOutcome = 'done' | 'failed' | 'stopped';

interface TurnCompletionOrchestrationService {
  resolveSessionPresenceSubject(
    threadId: string,
  ): OrchestrationStreamPresenceSubject | undefined;
  /**
   * station#3525: optional so no existing caller/test needs new plumbing.
   * When present, returns true (and consumes the armed entry) exactly when
   * `InternalStopSuppression.arm` marked `turnId` as a
   * stop this process initiated as internal machinery (a credential-profile
   * recovery restart, or connection-smoke cleanup) rather than a user
   * action or a genuine unattended mid-turn death.
   */
  consumeInternalStopSuppression?(turnId: string): boolean;
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
 * station#3525 fix round: the "resolve presence, decide, schedule" body
 * shared by `wireTurnCompletionNotifications` and
 * `wireInternalStopRedispatchFailureNotifications` — one push-delivery
 * decision, not two copies that could drift on title/category/dedupeTag.
 */
async function deliverTurnCompletionPush(input: {
  orchestrationService: TurnCompletionOrchestrationService;
  presence: OrchestrationStreamPresence;
  notificationService: NotificationService;
  threadId: string;
  turnId: string;
  outcome: TurnOutcome;
}): Promise<'scheduled' | 'skipped_connected'> {
  const {
    orchestrationService,
    presence,
    notificationService,
    threadId,
    turnId,
    outcome,
  } = input;
  const presenceSubject =
    orchestrationService.resolveSessionPresenceSubject(threadId);
  const watching =
    presenceSubject !== undefined && presence.isConnected(presenceSubject);
  if (watching) return 'skipped_connected';

  await notificationService.schedule(TURN_COMPLETION_SOURCE, {
    category:
      outcome === 'failed'
        ? 'turn-failed'
        : outcome === 'stopped'
          ? 'turn-stopped'
          : 'turn-completed',
    title:
      outcome === 'failed'
        ? 'Your agent needs attention'
        : outcome === 'stopped'
          ? 'Your agent stopped'
          : 'Your agent finished',
    body: `Agent ${outcome === 'failed' ? 'failed' : outcome === 'stopped' ? 'stopped' : 'finished'} in session ${threadId}`,
    priority: outcome === 'failed' ? 'high' : 'normal',
    dedupeTag: `turn-completion:${threadId}:${turnId}`,
    metadata: {
      sessionId: threadId,
      sessionKind: SESSION_KIND,
      threadId,
      turnId,
    },
  });
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
  },
): TurnOutcome | undefined {
  if (event.method === 'turn.completed') return 'done';
  if (event.method === 'turn.aborted') return 'failed';
  // station#3442: `runtime.error` is the ONLY canonical event a genuine
  // turn/stream failure publishes while a turnId is still known — see
  // bedrock-adapter.ts's and ollama-adapter.ts's `publishTurnFailure`, and
  // codex-adapter-notifications.ts's `'error'` notification case and its
  // `turn.status === 'failed'` branch of the `turn/completed` case. Before
  // this arm, a codex usage-limit death (or any other runtime.error) matched
  // none of these branches and scheduled NO push notification at all, the
  // exact case this file exists to cover.
  //
  // station#3451 fix round D7: the paragraph this replaces claimed
  // `codex-adapter-transport.ts`'s `finalizeUnexpectedExit` (an app-server
  // process dying mid-turn) "publishes `session.exited`, never
  // `runtime.error`" and that "a codex app-server crash mid-turn still
  // produces no push after this fix." Both were true when written and are
  // false now: station#3473 made `finalizeUnexpectedExit` (and
  // `stopSession`, and the process `'error'` handler — station#3451 finding
  // D3) synthesize a turn-scoped `runtime.error` (retriable left unset)
  // before publishing `session.exited`, whenever an active turn is
  // unresolved. That synthesized event has no `retriable` flag, so
  // `isDeferredRetriableTurnError` below returns false and this function
  // returns 'failed' — a codex app-server crash mid-turn now DOES schedule
  // the push. That is #3473's stated payoff.
  if (event.method === 'runtime.error') {
    // station#3442 round 2 (HIGH-1): codex's app-server `'error'`
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
    // station#3451 fix round D7: the paragraph this replaces claimed a
    // retry loop ending via Stop had no working path at all — that this
    // event's `activeTurnId` fold left `interruptUserTurnCooperatively`
    // early-returning without ever calling `adapter.interruptTurn`, and the
    // stall watchdog's `TERMINAL_METHODS` excluded `runtime.error` in a way
    // that left its forced-stop hitting the same early return. station#3473
    // (station#3451 findings B1/D1 and 4/H2) fixed both, for the FIRST turn
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
    // station#3451: was a hand-copied inline condition
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
 * station#3581 review MEDIUM 2: `nextTurnIdentityAnchor` retains a thread's
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
 * station#3581 review round 3 LOW 1: `nextTurnIdentityAnchor` can only ever
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
  presence: OrchestrationStreamPresence,
  notificationService: NotificationService,
  logger: TurnCompletionLogger,
): () => void {
  // station#3573: a third, independent turn-identity fold, scoped to the
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
  const turnIdentityAnchors = new Map<string, string>();
  const turnIdentityAnchorEvictionTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  // The EventBus publishes the forced-stop fact immediately before
  // `turn.aborted`. Retain that one exact turn identity long enough to join
  // the two events without changing the notification system into a reader of
  // the event store's durable projection.
  const settledStopTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const stopKey = (threadId: string, turnId: string) => `${threadId}:${turnId}`;

  const rememberSettledStop = (threadId: string, turnId: string): void => {
    const key = stopKey(threadId, turnId);
    const existing = settledStopTimers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      settledStopTimers.delete(key);
    }, SETTLED_STOP_NOTIFICATION_RETENTION_MS);
    timer.unref?.();
    settledStopTimers.set(key, timer);
  };

  const consumeSettledStop = (threadId: string, turnId: string): boolean => {
    const key = stopKey(threadId, turnId);
    const timer = settledStopTimers.get(key);
    if (!timer) return false;
    clearTimeout(timer);
    settledStopTimers.delete(key);
    return true;
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
      notificationService.dispatch('turn-completion', async () => {
        try {
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

          // station#3573: read BEFORE the outcome/early-return checks below
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
            // is retained for the session's life (station#3581 MEDIUM 3), so
            // there is no "clear the map entry" case left to handle; only
            // "set" is reachable.
            const nextAnchor = nextTurnIdentityAnchor(previousAnchor, event);
            if (nextAnchor !== undefined) {
              turnIdentityAnchors.set(event.threadId, nextAnchor);
            }
            touchTurnIdentityAnchorEviction(event.threadId);
          }

          let outcome = resolveTurnCompletionOutcome(event);
          if (!outcome || !event.turnId) return;

          // station#3573: a stale `turn.completed`/`turn.aborted` naming a
          // turn the session has already moved past (codex's own protocol
          // timing — see codex-adapter-notifications.ts's `'turn/completed'`
          // case, #3572) must not fire a "turn done"/"needs attention" push
          // while a LATER turn on the same thread is still running. Checked
          // against the anchor as of BEFORE this event (`previousAnchor`),
          // mirroring `deriveLifecycleTransition`/`deriveAgentRunStatus`'s own
          // guard on the identical events.
          if (
            (event.method === 'turn.completed' ||
              event.method === 'turn.aborted') &&
            !acceptsTurnTerminalEvent(event, previousAnchor)
          ) {
            turnCompletionNotificationOps.add(1, {
              outcome,
              result: 'skipped_stale_terminal',
            });
            return;
          }

          // A Codex stop can confirm as turn.completed with
          // finishReason:'cancelled'; the settled-stop fact is the proof that
          // this particular completion was a stop, while an unaccompanied
          // cancelled completion keeps its existing done mapping.
          if (
            (event.method === 'turn.completed' ||
              event.method === 'turn.aborted') &&
            consumeSettledStop(event.threadId, event.turnId)
          ) {
            outcome = 'stopped';
          }

          // station#3525: a stop this process initiated as internal machinery
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
            (outcome === 'failed' || outcome === 'stopped') &&
            orchestrationService.consumeInternalStopSuppression?.(event.turnId)
          ) {
            turnCompletionNotificationOps.add(1, {
              outcome,
              result: 'skipped_internal_stop',
            });
            return;
          }

          const result = await deliverTurnCompletionPush({
            orchestrationService,
            presence,
            notificationService,
            threadId: event.threadId,
            turnId: event.turnId,
            outcome,
          });
          turnCompletionNotificationOps.add(1, { outcome, result });
        } catch (error) {
          // See the file-header note: never rethrow — EventBus permanently
          // unsubscribes a throwing listener.
          turnCompletionNotificationOps.add(1, { result: 'error' });
          logger.warn(
            'turn-completion: failed to schedule a push-on-completion notification',
            { error: error instanceof Error ? error.message : String(error) },
          );
        }
      });
    },
  );

  // station#3581 review round 3 LOW 2: unwiring this listener must also
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
    for (const timer of settledStopTimers.values()) clearTimeout(timer);
    settledStopTimers.clear();
  };
}

/**
 * station#3525 fix round FIX 1: the corrective half of internal-stop
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
 * does a presence check and one `schedule()` call, the same bounded work
 * `wireTurnCompletionNotifications`'s own task does.
 */
export function wireInternalStopRedispatchFailureNotifications(
  eventBus: EventBus,
  orchestrationService: TurnCompletionOrchestrationService,
  presence: OrchestrationStreamPresence,
  notificationService: NotificationService,
  logger: TurnCompletionLogger,
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
            presence,
            notificationService,
            threadId: message.data.threadId,
            turnId: message.data.turnId,
            outcome: 'failed',
          });
          turnCompletionNotificationOps.add(1, { outcome: 'failed', result });
        } catch (error) {
          turnCompletionNotificationOps.add(1, { result: 'error' });
          logger.warn(
            'internal-stop-redispatch-failed: failed to schedule a push-on-completion notification',
            { error: error instanceof Error ? error.message : String(error) },
          );
        }
      },
    );
  });
}
