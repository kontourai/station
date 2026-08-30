import { isTerminalConnectionStatus } from '@kontourai/station-contracts/http';
import type { RuntimeEventElisionReason } from '@kontourai/station-contracts/orchestration';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import {
  claimSessionEventWindowCapabilityRecovery,
  fetchEventStreamResumeCapability,
  fetchOrchestrationSessionEventWindow,
  fetchSessionEventWindowCapability,
  fetchSSE,
  invalidateSessionEventWindowCapabilityCache,
  resetSessionEventWindowCapabilityRecovery,
  SESSION_EVENT_WINDOW_CAPABILITY_RETRY_MS,
  SESSION_EVENT_WINDOW_UNSUPPORTED_RETRY_MS,
  StationHttpError,
} from '@kontourai/station-sdk';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type ElidedHistorySummary,
  NO_ELIDED_HISTORY,
  summarizeElidedReasons,
} from '../../utils/elidedHistory';
import { createStreamCursorTracker } from './resumeCursor';
import type { OrchestrationEvent } from './types';

/** Keep the live feed bounded so a long-running session never grows unbounded. */
export const MAX_FEED_EVENTS = 200;

/**
 * Backoff for a transient `/event-window` history failure — archive#3378.
 *
 * The failure this replaces was silent and permanent: one failed history fetch
 * called `close` on the live stream and nothing ever reopened it, so a blip
 * in ONE endpoint took the session's live feed down until the component
 * remounted. The ceiling is `SESSION_EVENT_WINDOW_CAPABILITY_RETRY_MS` — the
 * cadence the capability path already re-probes an unavailable host on — so
 * the two recovery paths in this hook decay to the same rate rather than two
 * unrelated ones.
 */
const HISTORY_RETRY_BASE_MS = 1_000;
const HISTORY_RETRY_MAX_MS = SESSION_EVENT_WINDOW_CAPABILITY_RETRY_MS;

/**
 * Only a credential failure is terminal for the history window: a 401/403
 * rejects every retry identically, so a ladder against it can never clear and
 * stopping is the honest end state. Every other status — and any network
 * error — is the class a retry exists for. Same vocabulary, and the same
 * `isTerminalConnectionStatus` derivation, as the SSE transport's own
 * `classifySseFailure` (archive#1094).
 */
function isTerminalHistoryFailure(cause: unknown): boolean {
  return (
    cause instanceof StationHttpError &&
    isTerminalConnectionStatus(cause.status)
  );
}
type SessionEventWindow = Awaited<
  ReturnType<typeof fetchOrchestrationSessionEventWindow>
>;

function eventKey(event: OrchestrationEvent): string {
  return event.eventId || `${event.method}:${event.createdAt}`;
}

const CANONICAL_UTC_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function compareCreatedAt(
  left: OrchestrationEvent,
  right: OrchestrationEvent,
): number {
  if (left.createdAt === right.createdAt) return 0;
  // Normal Station producers use Date#toISOString, whose fixed-width UTC
  // spelling is chronologically lexicographic. Attached Claude transcripts
  // may retain a valid source offset, so normalize only that exceptional
  // shape rather than paying Date.parse/Intl cost for every live event.
  if (
    !CANONICAL_UTC_TIMESTAMP.test(left.createdAt) ||
    !CANONICAL_UTC_TIMESTAMP.test(right.createdAt)
  ) {
    const leftEpoch = Date.parse(left.createdAt);
    const rightEpoch = Date.parse(right.createdAt);
    if (
      Number.isFinite(leftEpoch) &&
      Number.isFinite(rightEpoch) &&
      leftEpoch !== rightEpoch
    ) {
      return leftEpoch < rightEpoch ? -1 : 1;
    }
  }
  return left.createdAt < right.createdAt ? -1 : 1;
}

/** Merge persisted recovery state and live frames without replay duplicates. */
export function mergeSessionEvents(
  current: OrchestrationEvent[],
  incoming: OrchestrationEvent[],
  persistedKeys: ReadonlySet<string> = new Set(),
): OrchestrationEvent[] {
  const byId = new Map<string, OrchestrationEvent>();
  for (const event of [...current, ...incoming]) {
    byId.set(eventKey(event), event);
  }
  const ordered = [...byId.values()].sort(compareCreatedAt);
  const live = ordered.filter((event) => !persistedKeys.has(eventKey(event)));
  let retained = live.slice(-MAX_FEED_EVENTS);
  const boundaryTurnId = retained[0]?.turnId;
  const boundaryAnchor =
    boundaryTurnId === undefined
      ? undefined
      : live.find(
          (event) =>
            event.turnId === boundaryTurnId && event.method === 'turn.started',
        );
  if (
    boundaryAnchor &&
    !retained.some((event) => eventKey(event) === eventKey(boundaryAnchor))
  ) {
    retained = [boundaryAnchor, ...retained.slice(-(MAX_FEED_EVENTS - 1))];
  }
  const retainedLive = new Set(retained.map(eventKey));
  return ordered.filter(
    (event) =>
      persistedKeys.has(eventKey(event)) || retainedLive.has(eventKey(event)),
  );
}

/**
 * The newest `turn.started` for `turnId` among frames about to be dropped —
 * the same frame `mergeSessionEvents`'s boundary anchor looks for, so trimming
 * the buffer cannot delete what the merge would have restored.
 */
function findLastTurnStart(
  dropped: ReadonlyArray<{ id: string; event: OrchestrationEvent }>,
  turnId: string,
): { id: string; event: OrchestrationEvent } | undefined {
  for (let index = dropped.length - 1; index >= 0; index -= 1) {
    const candidate = dropped[index];
    if (
      candidate.event.turnId === turnId &&
      candidate.event.method === 'turn.started'
    ) {
      return candidate;
    }
  }
  return undefined;
}

function prependOlderSessionEvents(
  older: OrchestrationEvent[],
  current: OrchestrationEvent[],
): OrchestrationEvent[] {
  const byId = new Map<string, OrchestrationEvent>();
  for (const event of [...older, ...current]) byId.set(eventKey(event), event);
  return [...byId.values()].sort(compareCreatedAt);
}

export interface SessionEventStream {
  events: OrchestrationEvent[];
  connected: boolean;
  hasMore: boolean;
  loadOlder: () => Promise<void>;
  upgradeRequired: boolean;
  error?: Error;
  /**
   * Mirrors the history-retry schedule (archive#3378): set when a retry is
   * scheduled, cleared when a hydration succeeds or the failure is classified
   * terminal. Nothing computes it from the timer — it is written by the same
   * two code paths that own the timer, and it is only as true as they are.
   *
   * It exists because an `error` alone cannot separate the two stories a
   * reader needs apart: history is late and coming back, versus history
   * stopped and the live feed with it.
   */
  historyRetrying: boolean;
  /**
   * How much of the CURRENTLY RETAINED feed a bounded read handed back
   * reduced, by reason (archive#3386). Recomputed wherever the feed changes,
   * so an event the feed later trims stops being counted.
   */
  elidedHistory: ElidedHistorySummary;
  /**
   * archive#3426: the live `/api/orchestration/events` stream classified its
   * own failure `terminal` (401/403, via `fetchSSE`'s `onTerminal`) and gave
   * up automatic reconnection — set there, cleared on the next successful
   * `onOpen`. Distinct from `connected === false`, which is equally true
   * while the transport is mid-backoff and about to reconnect on its own.
   */
  liveStreamStoppedTerminal: boolean;
  /**
   * archive#3426: the `/event-window` history read's own retry ladder hit a
   * terminal (401/403) failure and stopped — same `isTerminalHistoryFailure`
   * branch that clears `historyRetrying`, so the two together tell "history
   * failed and is coming back" (`historyRetrying`) apart from "history
   * failed and stopped for good" (this).
   */
  historyStoppedTerminal: boolean;
  /**
   * archive#3426: the bounded capability re-probe
   * (`claimSessionEventWindowCapabilityRecovery`, budget
   * `MAX_AUTOMATIC_CAPABILITY_RECOVERIES` = 3) ran out of automatic attempts.
   * Unlike the two terminal flags above, this is not a credential rejection —
   * the probe just could not confirm support in three tries — so it is a
   * distinct, recoverable stop: `retryCapabilityRecovery` resets the budget
   * and re-probes immediately.
   */
  capabilityRecoveryExhausted: boolean;
  /** Manually resets the capability re-probe budget and re-probes now. */
  retryCapabilityRecovery: () => void;
}

/**
 * Subscribe to ONE session's live runtime events via the server's per-session
 * SSE filter (`/api/orchestration/events?threadId=`). Returns the accumulated
 * (bounded) event feed plus a connection flag. Resets when `threadId` changes
 * and tears the fetch-SSE stream down on unmount. This is the streaming
 * counterpart to the react-query session queries.
 */
export function useSessionEventStream(
  apiBase: string,
  threadId: string | null,
): SessionEventStream {
  const [events, setEvents] = useState<OrchestrationEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [upgradeRequired, setUpgradeRequired] = useState(false);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [historyRetrying, setHistoryRetrying] = useState(false);
  const [elidedHistory, setElidedHistory] =
    useState<ElidedHistorySummary>(NO_ELIDED_HISTORY);
  const [recoveryRevision, setRecoveryRevision] = useState(0);
  const [liveStreamStoppedTerminal, setLiveStreamStoppedTerminal] =
    useState(false);
  const [historyStoppedTerminal, setHistoryStoppedTerminal] = useState(false);
  const [capabilityRecoveryExhausted, setCapabilityRecoveryExhausted] =
    useState(false);
  const retryCapabilityRecoveryRef = useRef<() => void>(() => {});
  const epoch = useRef(0);
  const eventsRef = useRef<OrchestrationEvent[]>([]);
  const cursorRef = useRef<string | undefined>(undefined);
  const appliedWatermark = useRef(0);
  const pendingOlder = useRef<SessionEventWindow | undefined>(undefined);
  const persistedKeys = useRef(new Set<string>());
  const queue = useRef(Promise.resolve());
  const reloadWindow = useRef<() => Promise<void>>(async () => {});
  const recoveredCapabilityKey = useRef<string | undefined>(undefined);
  // archive#3386: the window read reports which budget withheld part of an
  // event's payload. Both readers below (`loadOlder` and the hydration path)
  // unwrap `item.event` and would otherwise drop it on the floor, which is
  // how one consumer of this read disclosed the elision and the other stayed
  // silent about the same amputated turn.
  const elidedReasons = useRef(new Map<string, RuntimeEventElisionReason>());
  const apply = useCallback((next: OrchestrationEvent[]) => {
    eventsRef.current = next;
    setEvents(next);
    // Derived at the one choke point every feed change passes through, over
    // the events actually retained — not accumulated as pages arrive, which
    // would keep counting an event the bounded feed has already dropped.
    setElidedHistory(
      summarizeElidedReasons(
        next.map((event) => elidedReasons.current.get(eventKey(event))),
      ),
    );
  }, []);

  /** Records the read's own budget report for the events on one page. */
  const rememberElidedReasons = useCallback(
    (page: {
      events: Array<{ event: OrchestrationEvent; elided?: unknown }>;
    }) => {
      for (const item of page.events) {
        if (item.elided === 'byte_limit' || item.elided === 'output_limit') {
          elidedReasons.current.set(eventKey(item.event), item.elided);
        }
      }
    },
    [],
  );

  const loadOlder = useCallback(async () => {
    if (!threadId || !cursorRef.current) return;
    const requestEpoch = epoch.current;
    try {
      const page = await fetchOrchestrationSessionEventWindow(
        threadId,
        apiBase,
        {
          cursor: cursorRef.current,
          turnLimit: 20,
        },
      );
      queue.current = queue.current.then(() => {
        if (requestEpoch !== epoch.current) return;
        if (page.watermark > appliedWatermark.current) {
          pendingOlder.current = page;
          return;
        }
        if (page.watermark < appliedWatermark.current) {
          void reloadWindow.current();
          return;
        }
        for (const item of page.events) {
          persistedKeys.current.add(eventKey(item.event));
        }
        rememberElidedReasons(page);
        apply(
          prependOlderSessionEvents(
            page.events.map((item) => item.event),
            eventsRef.current,
          ),
        );
        cursorRef.current = page.nextCursor;
        setNextCursor(page.nextCursor);
      });
      await queue.current;
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error(String(cause)));
    }
  }, [apiBase, threadId, apply, rememberElidedReasons]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: recoveryRevision intentionally restarts this effect after a successful capability recovery; the ref carries the recovery handoff.
  useEffect(() => {
    setEvents([]);
    setConnected(false);
    setNextCursor(undefined);
    setUpgradeRequired(false);
    setError(undefined);
    setHistoryRetrying(false);
    setElidedHistory(NO_ELIDED_HISTORY);
    setLiveStreamStoppedTerminal(false);
    setHistoryStoppedTerminal(false);
    setCapabilityRecoveryExhausted(false);
    persistedKeys.current = new Set();
    elidedReasons.current = new Map();
    epoch.current += 1;
    if (!threadId) return;

    let active = true;
    const capabilityKey = `${apiBase}\u0000${threadId}`;
    const capabilityWasRecovered =
      recoveredCapabilityKey.current === capabilityKey;
    if (capabilityWasRecovered) recoveredCapabilityKey.current = undefined;
    let windowCapable = capabilityWasRecovered;
    // archive#3458: hydration used to gate on a
    // `streamOpened` flag written only by `onOpen` — a reasonable proxy for
    // "the host answered us" pre-archive#3458, when `onOpen` fired for EVERY
    // response, ok or not. Once `onOpen` only fires for a response the
    // transport actually consumes, that flag would mean what its name says —
    // the live connection is genuinely open — and stop being true for a live
    // stream stuck retrying a 5xx/502/503/504. That is a DIFFERENT fact from
    // "a response has been observed at all, so reading persisted history is
    // worth attempting", which is what hydration actually needs (archive#3378:
    // the live stream and the history read are different endpoints, and a
    // blip in one must not freeze the other). `hostResponded` is that second
    // fact — the hook has no remaining reader for "is the live connection
    // literally open" as a fact distinct from `connected`, so there is no
    // separate flag to keep alongside it. Set from every path that can
    // independently establish it: a genuine open, a rejected-but-real HTTP
    // response on the live stream (`onError` with a `StationHttpError`), and
    // a successful capability probe (`negotiateWindow`'s own REST call to the
    // same host succeeding is itself evidence the host is up, independent of
    // whether the live stream has managed to open yet).
    let hostResponded = false;
    let initialHydrationStarted = false;
    let capabilityStopped = false;
    const recoveryTimers = new Set<ReturnType<typeof setTimeout>>();
    let hydrated = false;
    let authenticatedStream: { close(): void } | undefined;
    const bufferedLive: Array<{ id: string; event: OrchestrationEvent }> = [];
    let historyRetryDelay = HISTORY_RETRY_BASE_MS;
    let historyRetryScheduled = false;
    let historyRetryTimer: ReturnType<typeof setTimeout> | undefined;
    // archive#3445: a retry scheduled under "this failure was transient" must
    // not be left to fire after a LATER attempt has already established
    // "this failure is terminal" — the pending timer knows nothing of that
    // later outcome and would otherwise fire anyway, succeed or fail, and
    // either clear the honest terminal signal or duplicate the retry. Called
    // from the terminal branch below, before it returns.
    const cancelHistoryRetry = () => {
      if (historyRetryTimer !== undefined) {
        clearTimeout(historyRetryTimer);
        recoveryTimers.delete(historyRetryTimer);
        historyRetryTimer = undefined;
      }
      historyRetryScheduled = false;
    };
    const scheduleHistoryRetry = () => {
      if (historyRetryScheduled) return;
      historyRetryScheduled = true;
      setHistoryRetrying(true);
      const delay = historyRetryDelay;
      historyRetryDelay = Math.min(historyRetryDelay * 2, HISTORY_RETRY_MAX_MS);
      const retryTimer = setTimeout(() => {
        recoveryTimers.delete(retryTimer);
        historyRetryScheduled = false;
        historyRetryTimer = undefined;
        if (!active) return;
        void recoverPersistedEvents();
      }, delay);
      historyRetryTimer = retryTimer;
      recoveryTimers.add(retryTimer);
    };
    // archive#3518: `recoverPersistedEvents` has five independent entries —
    // the retry timer, `startInitialHydration`, the `onOpen` reconnect path,
    // the snapshot-frame `onMessage` handler, and `loadOlder`'s
    // watermark-regression branch via `reloadWindow.current` below. All
    // five funnel through this one function body, so the epoch checks inside
    // it (not a per-call-site guard) are what every entry honours. A call
    // issued AFTER a terminal has been established must still be allowed to
    // succeed and clear it — `epoch.current` is captured fresh at that call's
    // own start, which is already past the terminal's bump, so it passes the
    // checks below on its own merits. The one entry that can actually reach
    // this AFTER a terminal in production is `loadOlder`'s: the terminal
    // branch's `authenticatedStream?.close` aborts the live SSE
    // connection, and its reconnect loop only runs `while
    // (!controller.signal.aborted)`, so no further `onOpen`/`onMessage` can
    // fire for this effect instance once a terminal has landed — `loadOlder`
    // is the one caller that stays reachable, gated only on `hasMore`
    // (`cursorRef.current`), not on `historyStoppedTerminal`.
    const recoverPersistedEvents = async () => {
      hydrated = false;
      const requestEpoch = epoch.current;
      try {
        const page = await fetchOrchestrationSessionEventWindow(
          threadId,
          apiBase,
          {
            turnLimit: 10,
          },
        );
        // archive#3518: this call may have started BEFORE a later,
        // independent call to `recoverPersistedEvents` established a
        // terminal outcome — the terminal branch below now bumps
        // `epoch.current` itself (its own comment explains why), so a
        // success landing after that terminal fails this check and cannot
        // clear the signals the terminal branch just set. `epoch.current`
        // only ever increases, so for the two straddling-race tests below
        // this checkpoint is REDUNDANT with the one inside
        // `queue.current.then`: if this one would bail, the queued one bails
        // too, and removing this one only turns an early return into a
        // queued no-op ( confirmed: removing it alone leaves
        // the full suite green). It is NOT redundant for the third test
        // below ("a terminal landing while the queue drains") — there, this
        // checkpoint runs BEFORE the terminal lands and passes, and only the
        // queued checkpoint (evaluated a microtask-queue turn later, after
        // the terminal has landed) catches it. Fault injection confirmed
        // that split precisely: removing the queued checkpoint alone reds
        // only that one test; removing this checkpoint alone reds nothing.
        // Keep both: this one is a cheap early-out for the common case, the
        // queued one is what actually closes the queue-drain window.
        if (!active || requestEpoch !== epoch.current) return;
        queue.current = queue.current.then(() => {
          if (!active || requestEpoch !== epoch.current) return;
          epoch.current += 1;
          appliedWatermark.current = page.watermark;
          pendingOlder.current = undefined;
          cursorRef.current = page.nextCursor;
          setNextCursor(page.nextCursor);
          persistedKeys.current = new Set(
            page.events.map((item) => eventKey(item.event)),
          );
          rememberElidedReasons(page);
          let restored = mergeSessionEvents(
            [],
            page.events.map((item) => item.event),
            persistedKeys.current,
          );
          for (const buffered of bufferedLive.splice(0)) {
            restored = mergeSessionEvents(
              restored,
              [buffered.event],
              persistedKeys.current,
            );
            appliedWatermark.current = Math.max(
              appliedWatermark.current,
              Number(buffered.id) || 0,
            );
          }
          apply(restored);
          hydrated = true;
          historyRetryDelay = HISTORY_RETRY_BASE_MS;
          setHistoryRetrying(false);
          setHistoryStoppedTerminal(false);
          setError(undefined);
          // No `setUpgradeRequired(false)` here, deliberately. Review asked
          // for one; an injection proved it unreachable, and the reason is
          // worth keeping: `upgradeRequired` is set true only for
          // `capability === false`, which `fetchSessionEventWindowCapability`
          // returns only when a handshake PARSED and did not advertise
          // `sessionEventWindow`. A host declaring no `/event-window` while
          // also serving a successful window read is self-contradictory, so
          // there is no state where this line has anything to clear.
          // (The observed clearing path is the effect restart that capability
          // recovery forces; that is not an exhaustive exit from the stopped
          // state — the recovery budget can be spent, leaving no exit at all —
          // which is why the argument above rests on the contradiction, not on
          // the restart.) A redundant setter here would read like the thing
          // that clears a stale upgrade claim while never once executing.
          // `useSessionEventStream.test.tsx` pins the user-visible outcome
          // against the restart that actually performs it.
        });
        await queue.current;
      } catch (cause) {
        if (!active) return;
        // archive#3518: this call may itself be stale — started
        // before a DIFFERENT, independent call already established a
        // terminal outcome (or completed a success) that bumped
        // `epoch.current`. Without this check, `setError`/`setUpgradeRequired`
        // below would overwrite the honest terminal error with this call's
        // own (often generic transient) failure message, and a late
        // non-terminal rejection would still reach `scheduleHistoryRetry`
        // and re-arm polling over a session already stopped for good.
        if (requestEpoch !== epoch.current) return;
        const failure =
          cause instanceof Error ? cause : new Error(String(cause));
        setError(failure);
        setUpgradeRequired(false);
        if (isTerminalHistoryFailure(cause)) {
          // archive#3518: bump `epoch.current` here, the ONE place
          // that previously never did — every OTHER call already in flight
          // (this attempt's own overlapping siblings, or a retry whose timer
          // already fired) captured its `requestEpoch` before this moment,
          // so the check above (on its own next turn) and the two checks in
          // the success path both fall behind and bail. This is the same
          // invalidation `epoch.current` already performs for the effect
          // restart, applied here to "a terminal just happened" instead.
          epoch.current += 1;
          bufferedLive.splice(0);
          authenticatedStream?.close();
          // archive#3445: a retry scheduled by an EARLIER transient failure
          // (this attempt may not be the first) must not survive this
          // terminal outcome — left alone, it fires later regardless, and a
          // subsequent success would clear historyStoppedTerminal/error and
          // leave `connected: true` with the SSE stream already closed above:
          // the worst state available, a live-looking session with a dead
          // feed and nothing left to reopen it.
          cancelHistoryRetry();
          setHistoryRetrying(false);
          setHistoryStoppedTerminal(true);
          return;
        }
        // archive#3378: the live stream is a DIFFERENT endpoint, and tearing
        // it down because this one blipped is what froze the session's feed
        // with nothing to restart it. Leave it connected, keep buffering what
        // it delivers, and retry the history read on its own ladder.
        scheduleHistoryRetry();
      }
    };
    reloadWindow.current = recoverPersistedEvents;
    const startInitialHydration = () => {
      if (!windowCapable || !hostResponded || initialHydrationStarted) return;
      initialHydrationStarted = true;
      void recoverPersistedEvents();
    };
    // archive#3437 (extended in 2):
    // guards `negotiateWindow` against overlapping probes. Two synchronous
    // `retryCapabilityRecovery` calls (a genuine double-click, or two
    // callers racing) would otherwise each invalidate the cache and start
    // their OWN probe — two parallel recovery chains that each independently
    // consume a budget slot on resolution, so the ladder exhausts after one
    // 30s round instead of three.
    //
    // The guard is consulted inside `negotiateWindow` itself (below), not
    // only at the manual-retry entry point, because `negotiateWindow` has
    // FOUR entries that can race one another: the manual retry
    // (`retryCapabilityRecoveryRef`), `onError` (fires on every dropped SSE
    // connection, including one refused faster than the 5s handshake probe
    // settles — the ordinary unreachable-host case), the automatic re-probe
    // timer (`scheduleCapabilityRecovery`'s `setTimeout`), and this effect's
    // own start. A guard that covered only the manual entry left the other
    // three unguarded against each other — two of three automatic recoveries
    // could be spent on one user-visible round. Collapsing to "one probe in
    // flight per hook instance" does not starve the recovery budget: every
    // caller is asking the same host/session the same question, so folding a
    // second, third, or fourth simultaneous ask into the one already running
    // answers all of them correctly with the single request already paying
    // for the budget slot.
    let capabilityProbeInFlight = false;
    const scheduleCapabilityRecovery = (capability: boolean | undefined) => {
      if (!claimSessionEventWindowCapabilityRecovery(apiBase, threadId)) {
        // `capability === false` is a definitive, already-named answer
        // (`upgradeRequired`) — exhausting the re-probe budget there changes
        // nothing about that message. This flag is only for the genuinely
        // undetermined case: three probe attempts that could not confirm
        // support either way.
        if (capability !== false) setCapabilityRecoveryExhausted(true);
        return;
      }
      const recoveryTimer = setTimeout(
        () => {
          recoveryTimers.delete(recoveryTimer);
          negotiateWindow();
        },
        capability === false
          ? SESSION_EVENT_WINDOW_UNSUPPORTED_RETRY_MS
          : SESSION_EVENT_WINDOW_CAPABILITY_RETRY_MS,
      );
      recoveryTimers.add(recoveryTimer);
    };
    const negotiateWindow = () => {
      // archive#3437: the guard now lives here, so
      // EVERY entry (manual retry, onError, the automatic re-probe timer,
      // and this effect's own start) shares it, not just the manual one.
      if (capabilityProbeInFlight) return;
      capabilityProbeInFlight = true;
      void fetchSessionEventWindowCapability(apiBase)
        .then((capability) => {
          if (!active) return;
          windowCapable = capability === true;
          if (capability === true) {
            // A successful capability probe is itself a Response from this
            // host — independent evidence, on a REST call that has nothing
            // to do with the live SSE stream's own open/error state, that
            // reading persisted history is worth attempting.
            hostResponded = true;
          }
          if (capability !== true) {
            bufferedLive.splice(0);
            authenticatedStream?.close();
            capabilityStopped = true;
            const upgradeRequired = capability === false;
            setUpgradeRequired(upgradeRequired);
            setError(
              new Error(
                upgradeRequired
                  ? 'Session history requires a Station upgrade'
                  : 'Session history transport failed.',
              ),
            );
            scheduleCapabilityRecovery(capability);
            return;
          }
          resetSessionEventWindowCapabilityRecovery(apiBase, threadId);
          setCapabilityRecoveryExhausted(false);
          if (capabilityStopped) {
            recoveredCapabilityKey.current = capabilityKey;
            setRecoveryRevision((current) => current + 1);
            return;
          }
          startInitialHydration();
        })
        .catch(() => {
          // archive#3437 (NIT): `.finally` alone releases the
          // guard on a rejection but does not handle it, leaving an
          // unhandled rejection — swallow it here so the defense-in-depth
          // below is complete, not just half of it.
        })
        .finally(() => {
          // Defense-in-depth (archive#3437 2,
          // maintenance note): `fetchSessionEventWindowCapability` cannot
          // currently reject — every internal failure is caught and resolved
          // as `undefined` — so this never fires ahead of the `.then` above
          // in practice today. But the guard's release must not depend on
          // that staying true forever: a stuck `true` flag here permanently
          // disables every future negotiate call, manual retry included.
          capabilityProbeInFlight = false;
        });
    };
    retryCapabilityRecoveryRef.current = () => {
      if (!active) return;
      // archive#3437: a probe already in flight (whether
      // from this same manual retry re-entered, or an automatic re-probe
      // timer) owns the current recovery attempt — do not start a second,
      // parallel one. `negotiateWindow` itself now enforces this same guard
      // ( 2) for every entry, so this early return is no
      // longer the only thing standing between a manual click and a second
      // probe — it stays here to skip the RESET/INVALIDATE side effects
      // below too, not just the probe itself, when one is already running.
      if (capabilityProbeInFlight) return;
      resetSessionEventWindowCapabilityRecovery(apiBase, threadId);
      // archive#3437: without this, the capability CACHE
      // (distinct from the recovery BUDGET reset above) still holds the
      // just-resolved probe from the automatic round that set
      // `capabilityRecoveryExhausted` — `negotiateWindow` below would
      // return that cached settlement, issuing zero new requests for up to
      // `SESSION_EVENT_WINDOW_CAPABILITY_RETRY_MS` while the copy claims a
      // fresh probe is running.
      invalidateSessionEventWindowCapabilityCache(apiBase);
      setCapabilityRecoveryExhausted(false);
      negotiateWindow();
    };

    // archive#1092: whether this host's stream honors a resume cursor at
    // all. Resolved async and defaults to "not yet known" (`false`) so the
    // very first `onOpen` — which fires before this can possibly resolve —
    // conservatively keeps refetching, same as pre-archive#1092 behavior; only a
    // later reconnect, once the flag is known, can skip the redundant
    // refetch below.
    let resumeCapable = false;
    void fetchEventStreamResumeCapability(apiBase).then((capable) => {
      if (active) resumeCapable = capable;
    });

    // archive#1092: drop a duplicate/overlapping frame the replay path
    // re-delivers. `mergeSessionEvents` already dedups by eventId, so this
    // is a cheap early-out rather than a correctness requirement here — but
    // keeping it consistent with the global stream's guard avoids a
    // needless state update/render for a frame we already have.
    const cursor = createStreamCursorTracker();

    authenticatedStream = fetchSSE(
      `${apiBase}/api/orchestration/events?threadId=${encodeURIComponent(threadId)}`,
      {
        authentication: 'required',
        onOpen: () => {
          setConnected(true);
          setLiveStreamStoppedTerminal(false);
          hostResponded = true;
          if (!initialHydrationStarted) {
            startInitialHydration();
            return;
          }
          if (resumeCapable) {
            // The server replays exactly what was missed via the retained
            // `Last-Event-ID` cursor — a REST refetch here would be the
            // redundant merge path archive#1092 removes.
            return;
          }
          // Pre-archive#1092 (or not-yet-known) host: a reconnect can span missed
          // frames with no server-side replay, so rehydrate from persisted
          // history before continuing from live delivery — the prior
          // behavior, unchanged.
          if (windowCapable) void recoverPersistedEvents();
        },
        onError: (cause) => {
          resumeCapable = false;
          // A rejected response (401/403, or any non-2xx — archive#3458 made
          // `onOpen` stop firing for these) still means the host answered:
          // `consumeSseResponse` only ever throws a `StationHttpError` for a
          // `Response` it actually received. A NETWORK-level failure (no
          // `Response` at all — DNS, connection refused, CORS) throws
          // something else, and must not count.
          if (cause instanceof StationHttpError) hostResponded = true;
          windowCapable = false;
          initialHydrationStarted = false;
          negotiateWindow();
          setConnected(false);
        },
        // Fires once alongside `onError` for the SAME failure, only when
        // `fetchSSE` classified it `terminal` (401/403) and gave up
        // automatic reconnection — the additive signal `connected === false`
        // alone cannot give (archive#3426): that is equally true while the
        // ladder is mid-backoff and about to retry on its own.
        onTerminal: () => setLiveStreamStoppedTerminal(true),
        // archive#3437: `onOpen` was the only clearing path,
        // but the transport's terminal state ends at the WAKE (`retry` or
        // `notifyCredentialChanged`), not at a successful open — a resumed
        // attempt that fails transiently (network-level, or an HTTP-status
        // rejection such as a 500) only fires `onError`, never `onOpen`
        // (archive#3458 made `onOpen` fire only for a response the
        // transport actually consumes), so the flag stayed stuck true
        // through a failure that is not a credential rejection. Clear it as
        // soon as the transport is actively retrying again; `onOpen` still
        // also clears it for the ordinary (non-terminal-stop) reconnect
        // path.
        onRetry: () => setLiveStreamStoppedTerminal(false),
        onMessage: (raw) => {
          if (raw.event === 'orchestration:snapshot') {
            // archive#1092 fix (defense in depth): a snapshot
            // frame on THIS thread-scoped stream means the server could not
            // bound-replay what was missed — a genuine per-thread
            // gap>threshold, an invalid/foreign cursor, or (belt-and-braces
            // against the server-side fix above) any other reason the route
            // fell back to snapshot. Silently discarding it, as before,
            // permanently loses this thread's own missed events: the
            // eventStreamResume-capable branch above already skipped
            // `recoverPersistedEvents` on this `onOpen`, and `fetchSSE`
            // has already advanced `Last-Event-ID` to the snapshot's `id`,
            // so nothing else will ever re-deliver them. Treat "replay did
            // not happen" as the explicit trigger to refetch persisted
            // history instead.
            cursor.adopt(raw.id);
            void recoverPersistedEvents();
            return;
          }
          if (raw.event !== SERVER_EVENTS.ORCHESTRATION_EVENT) return;
          if (!cursor.admit(raw.id)) return;
          try {
            const payload = JSON.parse(raw.data) as {
              event: OrchestrationEvent;
            };
            if (!payload?.event) return;
            if (!hydrated) {
              bufferedLive.push({ id: raw.id ?? '0', event: payload.event });
              // archive#3378: a retried hydration can stay unhydrated for as
              // long as `/event-window` keeps failing, so this buffer now has
              // a lifetime instead of a request, and an unbounded array is the
              // only way a longer wait could cost more than a slower one.
              //
              // The trim is NOT simply "keep the newest N", which is what
              // `mergeSessionEvents` would have done anyway. That merge also
              // rescues the `turn.started` anchoring the retained window's
              // first turn, reaching back past its own cut to find it — so a
              // blind splice here deletes a frame the merge would have kept,
              // and the turn arrives with no beginning (archive#3378).
              if (bufferedLive.length > MAX_FEED_EVENTS) {
                const dropped = bufferedLive.splice(
                  0,
                  bufferedLive.length - MAX_FEED_EVENTS,
                );
                const anchorTurnId = bufferedLive[0]?.event.turnId;
                const anchor =
                  anchorTurnId === undefined
                    ? undefined
                    : findLastTurnStart(dropped, anchorTurnId);
                // Disclosed divergence: this settles at MAX_FEED_EVENTS + 1,
                // where `mergeSessionEvents` produces exactly MAX (it slices
                // to MAX - 1 and prepends the anchor). Matching it exactly
                // would mean dropping one more live frame to make room for the
                // anchor — paying real data to satisfy an off-by-one in a
                // memory guard. It does not grow: the extra slot is taken by
                // an anchor, and the next trim rebuilds from the same MAX.
                if (anchor) bufferedLive.unshift(anchor);
              }
              return;
            }
            queue.current = queue.current.then(() => {
              appliedWatermark.current = Math.max(
                appliedWatermark.current,
                Number(raw.id) || 0,
              );
              const method = (payload.event as { method: string }).method;
              if (method === 'turn.reverted' || method === 'session.deleted') {
                epoch.current += 1;
                pendingOlder.current = undefined;
              }
              apply(
                mergeSessionEvents(
                  eventsRef.current,
                  [payload.event],
                  persistedKeys.current,
                ),
              );
              const pending = pendingOlder.current;
              if (pending && pending.watermark <= appliedWatermark.current) {
                pendingOlder.current = undefined;
                for (const item of pending.events) {
                  persistedKeys.current.add(eventKey(item.event));
                }
                rememberElidedReasons(pending);
                apply(
                  prependOlderSessionEvents(
                    pending.events.map((item) => item.event),
                    eventsRef.current,
                  ),
                );
                cursorRef.current = pending.nextCursor;
                setNextCursor(pending.nextCursor);
              }
            });
          } catch {
            // Ignore a malformed SSE frame rather than break the feed.
          }
        },
      },
    );

    if (!capabilityWasRecovered) negotiateWindow();

    return () => {
      active = false;
      reloadWindow.current = async () => {};
      retryCapabilityRecoveryRef.current = () => {};
      epoch.current += 1;
      for (const recoveryTimer of recoveryTimers) clearTimeout(recoveryTimer);
      recoveryTimers.clear();
      authenticatedStream?.close();
    };
  }, [apiBase, threadId, apply, rememberElidedReasons, recoveryRevision]);

  const retryCapabilityRecovery = useCallback(
    () => retryCapabilityRecoveryRef.current(),
    [],
  );

  return {
    events,
    connected,
    hasMore: Boolean(nextCursor),
    loadOlder,
    upgradeRequired,
    error,
    historyRetrying,
    elidedHistory,
    liveStreamStoppedTerminal,
    historyStoppedTerminal,
    capabilityRecoveryExhausted,
    retryCapabilityRecovery,
  };
}
