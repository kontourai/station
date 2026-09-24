import {
  ORCHESTRATION_STREAM_CAUGHT_UP_EVENT,
  SERVER_EVENTS,
} from '@kontourai/station-contracts/runtime-events';
import { type FetchSseConnection, fetchSSE } from '@kontourai/station-sdk';
import type { QueryClient } from '@tanstack/react-query';
import { activeChatsStore } from '../../contexts/active-chats-store';
import { CLIENT_DOCUMENT_SESSION_ID } from '../clientDocumentSession';
import {
  handleOrchestrationEvent,
  settleSemanticDeliveryBuffer,
} from './eventHandlers';
import {
  recordReplayConnection,
  recordReplaySnapshot,
} from './replay/capture-tap';
import { createStreamCursorTracker, parseStreamSequence } from './resumeCursor';
import { applyOrchestrationSnapshot } from './snapshotHandlers';
import { setStreamConnectionState } from './streamConnectionState';
import type { OrchestrationEvent, OrchestrationSnapshotPayload } from './types';

interface OwnedStream {
  connection: FetchSseConnection;
  /** Waiting out a terminal (401/403) stop — see `onTerminal` below. */
  parked: boolean;
  /**
   * Monotonic time (`monotonicNow`) of the last refusal or retry of a parked
   * stream.
   */
  lastParkedRetryAt: number;
  /** The one deferred retry a throttled recovery signal left behind. */
  deferredParkedRetry: ReturnType<typeof setTimeout> | undefined;
  /** The connection's loop has returned, whether or not it was aborted. */
  ended: boolean;
}

/**
 * station#2301 review (M1): a parked stream is one whose credential the server
 * REFUSED, so every retry it makes is a failed authentication — and the
 * runtime rate-limits those per peer (10 a minute by default). Focus and
 * visibility fire as often as a user switches windows, so without a floor a
 * user with a revoked credential could trip that limiter on their own peer
 * and have the request that fixes the credential refused too.
 *
 * A signal inside the floor is DEFERRED, not dropped: it leaves one retry
 * scheduled for the end of the floor. A parked stream has no timer of its
 * own, so a dropped signal could strand it — a user who repaired the
 * authorization on the host and came back 20s after the refusal would then
 * sit on "Connection needs attention" until they happened to switch windows
 * again. The credential-change wake is not throttled, because it means the
 * saved credential actually changed.
 */
const PARKED_RETRY_MIN_INTERVAL_MS = 30_000;

/**
 * The floor is an interval, so it reads a monotonic clock: a wall clock
 * stepped backwards (NTP, a manual change, sleep fix-up) would otherwise hold
 * every parked retry off until the clock caught up.
 */
function monotonicNow(): number {
  return globalThis.performance?.now() ?? Date.now();
}

function clearDeferredParkedRetry(owned: OwnedStream): void {
  if (owned.deferredParkedRetry === undefined) return;
  clearTimeout(owned.deferredParkedRetry);
  owned.deferredParkedRetry = undefined;
}

function retryParkedStream(owned: OwnedStream): void {
  clearDeferredParkedRetry(owned);
  if (!owned.parked || owned.ended || owned.connection.signal.aborted) return;
  owned.lastParkedRetryAt = monotonicNow();
  owned.connection.retry();
}

/**
 * station#2301: the single-flight registry. An entry counts only while its
 * connection is LIVE: the guard below checks the connection's own abort
 * signal, so an abort from ANY path — a non-persisted `pagehide`, a caller
 * signal, a future one nobody has written yet — frees the slot for the next
 * ensure, including one in the same tick as the abort. Before this, the guard
 * checked presence and only the 401/403 path ever deleted an entry, so every
 * other abort left a dead connection registered forever and every later
 * ensure returned early against it. A loop that ends WITHOUT an abort (a
 * callback throwing inside the SDK's retry loop) is caught by `ended`.
 */
const activeSources = new Map<string, OwnedStream>();

/**
 * station#2301: silence longer than this on a connected stream means the
 * socket is dead, not idle. The server writes a keepalive frame every
 * `SSE_KEEPALIVE_INTERVAL_MS` (30s, `src-server/constants.ts`), so 75s is two
 * and a half missed heartbeats — enough slack for a slow proxy flush, short
 * enough that a frozen transcript recovers without an app restart.
 */
const ORCHESTRATION_STREAM_STALL_TIMEOUT_MS = 75_000;

/**
 * station#2301: every apiBase a caller has asked for, so a recovery signal can
 * re-ensure a stream whose connection ended without anyone remounting the
 * dock. `ChatDock`'s mount effect is the only caller, and it does not re-run
 * when the page merely comes back to the foreground.
 */
const requestedBases = new Set<string>();
let recoveryListenersInstalled = false;
let hiddenSince: number | undefined;
/** apiBases whose chats this document has already seeded from a snapshot. */
const basesWithSnapshot = new Set<string>();
/** Last sequence this document applied, retained when a transport is replaced. */
const appliedCursors = new Map<string, string>();
const streamEpochs = new Map<string, string>();

function reensureRequestedStreams(): void {
  if (
    (globalThis as { document?: { hidden?: boolean } }).document?.hidden ===
    true
  )
    return;
  for (const apiBase of requestedBases) ensureOrchestrationEventStream(apiBase);
}

function recoverAfterVisibilityChange(): void {
  if ((globalThis as { document?: { hidden?: boolean } }).document?.hidden) {
    hiddenSince = Date.now();
    return;
  }
  const hiddenFor = hiddenSince === undefined ? 0 : Date.now() - hiddenSince;
  hiddenSince = undefined;
  if (hiddenFor > 30_000) {
    for (const owned of activeSources.values()) {
      if (!owned.ended && !owned.connection.signal.aborted)
        owned.connection.restart();
    }
  }
  reensureRequestedStreams();
}

function installRecoveryListeners(): void {
  if (recoveryListenersInstalled) return;
  recoveryListenersInstalled = true;
  const scope = globalThis as {
    document?: EventTarget;
    window?: EventTarget;
  };
  scope.document?.addEventListener(
    'visibilitychange',
    recoverAfterVisibilityChange,
  );
  scope.window?.addEventListener('focus', reensureRequestedStreams);
  scope.window?.addEventListener('online', reensureRequestedStreams);
  scope.window?.addEventListener('pageshow', reensureRequestedStreams);
}

/**
 * V3 the chat dock's failure banner reads the
 * SHARED orchestration session read-model (`utils/sessionFailure`, the one
 * fold every session surface reads), and nothing invalidated that query when a
 * session failed live. So a turn killed mid-flight showed a red `Failed` chip —
 * fed by the live event stream — beside a transcript that simply stopped, and
 * where the reason belongs the dock said nothing at all: its copy of the
 * session record still read `lifecycleState: 'running'`, minted before the
 * failure. The chip and the reason were reading two different sources.
 *
 * The fix is to keep the one derivation current, not to add a second local
 * fold. Only a turn-boundary event triggers it, at most once a second, so a
 * chatty stream cannot turn this into a refetch loop.
 *
 * #2310: `turn.started` is a boundary too. A session nothing has been sent to
 * reads as a Draft (the server's lineage fold), outside "Active now", and its
 * first turn is the moment that changes. A refresh that lands inside the
 * throttle window is deferred to the window's end rather than dropped.
 *
 * #2307: the refresh targets the `QueryClient` REGISTERED for the stream's
 * apiBase (see `streamQueryClients` below) at the moment it fires. `ChatDock`
 * registers its own client on mount, so a stream with no mounted dock for its
 * apiBase refreshes nothing. #2309 Phase B, a server-pushed conversation
 * activity record, supersedes this.
 */
const SESSION_READ_MODEL_FACT_METHODS: ReadonlySet<string> = new Set([
  'turn.started',
  'runtime.error',
  'session.exited',
  'turn.completed',
  'turn.aborted',
]);
const SESSION_READ_MODEL_REFRESH_WINDOW_MS = 1000;
let lastSessionReadModelRefreshAt = 0;
let deferredSessionReadModelRefresh: ReturnType<typeof setTimeout> | undefined;
/**
 * #2307: the `QueryClient` each apiBase's stream writes through.
 *
 * There is no single app-lifetime client. `AuthorityQueryContext` mints a
 * FRESH client per verified authority namespace (and a fresh ephemeral one for
 * every unverified fallback) and replaces its whole protected subtree when
 * that changes, while this stream is module-scoped per apiBase and outlives
 * any one of those subtrees. So the client is not bound to the stream's
 * closure: `ChatDock`, which renders inside that protected subtree, registers
 * the client `useQueryClient()` gives it and releases it on unmount, and every
 * consumer below resolves the CURRENT registration for its apiBase when it
 * runs. A retired authority's subtree unmounts before (or in the same commit
 * as) `retireAuthorityClient`, so its client stops receiving invalidations
 * and reconnect refetches at that point, and a stream whose apiBase has no
 * mounted dock writes into no cache at all.
 *
 * The registry is keyed by apiBase, not by authority. A principal switch on
 * the SAME apiBase does not by itself reconnect a live stream (credential
 * change only wakes a parked one), so until that connection cycles, facts it
 * carries under the previous principal invalidate the new authority's client.
 * Invalidation carries no payload — the new client refetches under its own
 * credential — so the effect is spurious refetches, not cross-authority data;
 * a reconnect-fallback snapshot always arrives on a fresh connect, which does
 * carry the current credential.
 *
 * A list, not a slot: more than one dock can mount at once (a docked and a
 * full-screen Chat share one authority's client), and releasing one of them
 * must not unregister the other. Each registration is its own entry, so a
 * release removes exactly that one; the last live entry for an apiBase wins.
 */
const streamQueryClients: { apiBase: string; queryClient: QueryClient }[] = [];

function currentStreamQueryClient(apiBase: string): QueryClient | undefined {
  return streamQueryClients.filter((entry) => entry.apiBase === apiBase).at(-1)
    ?.queryClient;
}

function registerStreamQueryClient(
  apiBase: string,
  queryClient: QueryClient,
): () => void {
  const registration = { apiBase, queryClient };
  streamQueryClients.push(registration);
  return () => {
    const index = streamQueryClients.indexOf(registration);
    if (index !== -1) streamQueryClients.splice(index, 1);
  };
}

function refreshSessionReadModelOnFact(
  apiBase: string,
  event: OrchestrationEvent,
): void {
  const client = currentStreamQueryClient(apiBase);
  if (!client || !SESSION_READ_MODEL_FACT_METHODS.has(event.method)) return;
  const elapsed = Date.now() - lastSessionReadModelRefreshAt;
  if (elapsed < SESSION_READ_MODEL_REFRESH_WINDOW_MS) {
    // One deferred refresh covers every fact that arrives in the window. It
    // re-resolves the client when it fires: an authority switch inside the
    // window must not send the refresh to the client it retired.
    if (deferredSessionReadModelRefresh === undefined) {
      deferredSessionReadModelRefresh = setTimeout(() => {
        deferredSessionReadModelRefresh = undefined;
        lastSessionReadModelRefreshAt = Date.now();
        void currentStreamQueryClient(apiBase)?.invalidateQueries({
          queryKey: ['orchestration-sessions'],
        });
      }, SESSION_READ_MODEL_REFRESH_WINDOW_MS - elapsed);
    }
    return;
  }
  lastSessionReadModelRefreshAt = Date.now();
  void client.invalidateQueries({ queryKey: ['orchestration-sessions'] });
}

/**
 * Test-only: clears the module-global refresh throttle and client registrations,
 * so each test starts from a quiet window instead of inheriting the last
 * test's (#2310 review L3).
 */
export function resetSessionReadModelRefreshForTests(): void {
  if (deferredSessionReadModelRefresh !== undefined) {
    clearTimeout(deferredSessionReadModelRefresh);
  }
  deferredSessionReadModelRefresh = undefined;
  lastSessionReadModelRefreshAt = 0;
  streamQueryClients.length = 0;
}

/**
 * Ensures the one orchestration event stream for `apiBase`.
 *
 * #2307: a supplied `queryClient` is REGISTERED for `apiBase` (see
 * `streamQueryClients`) and the returned function releases that registration;
 * `ChatDock` passes its `useQueryClient()` and returns the release as its
 * effect cleanup. The stream itself is created by the first call for an
 * apiBase and deduplicated after that, so the client is never read from this
 * call's closure: the session read-model refresh, the projection-update
 * invalidation, and `applyOrchestrationSnapshot`'s reconnect-fallback
 * refetch (archive#1225 — the `toolMappings` cache lookup, see
 * `rehydrateChatSession.ts`) all resolve the apiBase's current registration
 * when they run. Calls without a client (the recovery re-ensure below)
 * register nothing and return a no-op.
 */
export function ensureOrchestrationEventStream(
  apiBase: string,
  queryClient?: QueryClient,
): () => void {
  const release = queryClient
    ? registerStreamQueryClient(apiBase, queryClient)
    : () => {};
  requestedBases.add(apiBase);
  installRecoveryListeners();
  const existing = activeSources.get(apiBase);
  if (existing && !existing.ended && !existing.connection.signal.aborted) {
    // A parked stream is alive but waiting for a credential change that may
    // have arrived by a path that never announced it. Ask again at most once
    // per floor interval, deferring rather than dropping a signal that lands
    // inside it — see `PARKED_RETRY_MIN_INTERVAL_MS`.
    if (existing.parked) {
      const wait =
        existing.lastParkedRetryAt +
        PARKED_RETRY_MIN_INTERVAL_MS -
        monotonicNow();
      if (wait <= 0) retryParkedStream(existing);
      else if (existing.deferredParkedRetry === undefined)
        existing.deferredParkedRetry = setTimeout(
          () => retryParkedStream(existing),
          wait,
        );
    }
    return release;
  }
  if (existing) activeSources.delete(apiBase);
  // archive#1092: dedup guard against duplicate/overlapping frames on a
  // sequence-cursor resume. Applying a stale duplicate here would
  // reapply deltas (e.g. `content.text-delta`) into already-updated chat
  // state, not just re-render an already-correct list — unlike
  // `useSessionEventStream`'s eventId-keyed merge, this handler has no
  // independent dedup of its own. Safe unconditionally: a pre-archive#1092 host
  // never sets a frame `id:`, so the guard never drops anything against it.
  const cursor = createStreamCursorTracker();
  const initialLastEventId = appliedCursors.get(apiBase);
  cursor.adopt(initialLastEventId);
  // archive#1225: the FIRST snapshot this stream instance ever receives is
  // always the ordinary connect-time snapshot (a brand-new stream has no
  // `Last-Event-ID` yet, so `resolveStreamResumePlan` always picks the
  // snapshot branch on that very first request) — nothing is stale yet, so
  // no refetch is warranted. Any LATER snapshot on this same stream means
  // the server fell back on a genuine RECONNECT (bounded-gap-exceeded or a
  // stale/evicted cursor); see `applyOrchestrationSnapshot`'s
  // `isReconnectFallback` option for what that triggers.
  //
  // station#2301: "first" is per DOCUMENT, not per stream. A stream that
  // replaces a dead predecessor starts without a cursor, so its first frame
  // is a snapshot — but this document has been showing state since the
  // predecessor's last event, and whatever it missed in between needs exactly
  // the catch-up a reconnect fallback triggers.
  let hasReceivedSnapshot = basesWithSnapshot.has(apiBase);
  let receiving = false;
  const authenticatedStream = fetchSSE(`${apiBase}/api/orchestration/events`, {
    authentication: 'required',
    initialLastEventId,
    // station#2301: lets the server's stream open/close lines say WHICH
    // document connected — see `clientDocumentSession.ts`.
    headers: {
      'X-Station-Client-Session': CLIENT_DOCUMENT_SESSION_ID,
      ...(streamEpochs.has(apiBase)
        ? { 'X-Station-Stream-Epoch': streamEpochs.get(apiBase)! }
        : {}),
    },
    // archive#1848: a ceiling equal to the initial delay is not a backoff
    // ladder — it is a fixed 2s poll that never decays, so a server that is
    // down, restarting, or refusing keeps receiving ~30 requests/minute from
    // every open client for as long as the app is open. The ceiling is safe
    // to raise only because `fetchSSE` now restarts the ladder after an
    // attempt that actually delivered frames, so an ordinary blip on a
    // healthy stream still reconnects in 2s rather than inheriting a
    // ratcheted-up delay.
    retryDelayMs: 2000,
    maxRetryDelayMs: 30_000,
    stallTimeoutMs: ORCHESTRATION_STREAM_STALL_TIMEOUT_MS,
    onMessage: (raw) => {
      if (!receiving) {
        recordReplayConnection(apiBase, 'receiving');
        setStreamConnectionState(apiBase, 'receiving');
        receiving = true;
      }
      if (raw.event === ORCHESTRATION_STREAM_CAUGHT_UP_EVENT) {
        const caughtUp = JSON.parse(
          raw.data,
        ) as Partial<OrchestrationSnapshotPayload>;
        if (caughtUp.sessions) {
          applyOrchestrationSnapshot(caughtUp as OrchestrationSnapshotPayload, {
            apiBase,
            isReconnectFallback: hasReceivedSnapshot,
            queryClient: currentStreamQueryClient(apiBase),
          });
          hasReceivedSnapshot = true;
          basesWithSnapshot.add(apiBase);
        }
        if (parseStreamSequence(raw.id) !== undefined) {
          cursor.adopt(raw.id);
          appliedCursors.set(apiBase, raw.id!);
        }
        setStreamConnectionState(apiBase, 'caught-up');
        recordReplayConnection(apiBase, 'caught-up');
      } else if (raw.event === 'orchestration:snapshot') {
        // A replacement snapshot already contains every durable delta. Reveal
        // locally held text first, then let the snapshot become authoritative.
        settleSemanticDeliveryBuffer(apiBase);
        // A snapshot always replaces local state — adopt its cursor
        // unconditionally rather than gating it through `admit`.
        const payload = JSON.parse(raw.data) as OrchestrationSnapshotPayload;
        const previousEpoch = streamEpochs.get(apiBase);
        if (payload.epoch && previousEpoch && payload.epoch !== previousEpoch) {
          activeChatsStore.clearConversationActivity();
        }
        if (payload.epoch) streamEpochs.set(apiBase, payload.epoch);
        cursor.adopt(raw.id);
        if (parseStreamSequence(raw.id) !== undefined)
          appliedCursors.set(apiBase, raw.id!);
        recordReplaySnapshot(apiBase, payload, hasReceivedSnapshot);
        applyOrchestrationSnapshot(payload, {
          apiBase,
          isReconnectFallback: hasReceivedSnapshot,
          queryClient: currentStreamQueryClient(apiBase),
        });
        hasReceivedSnapshot = true;
        basesWithSnapshot.add(apiBase);
      } else if (raw.event === SERVER_EVENTS.ORCHESTRATION_EVENT) {
        if (!cursor.admit(raw.id)) return;
        if (parseStreamSequence(raw.id) !== undefined)
          appliedCursors.set(apiBase, raw.id!);
        // archive#1410: the frame is a wrapper, not a bare event — the
        // server attaches a completed turn's provenance envelope as a
        // SIBLING of `event` so the canonical event itself stays untouched.
        // Typed `unknown` all the way to the render boundary, which is the
        // only place that decides whether this build can read it.
        const payload = JSON.parse(raw.data) as {
          event: OrchestrationEvent;
          provenance?: unknown;
          conversation?: import('@kontourai/station-contracts/orchestration').OrchestrationConversationStreamBinding;
        };
        handleOrchestrationEvent(
          apiBase,
          payload.event,
          payload.provenance,
          payload.conversation,
          parseStreamSequence(raw.id),
        );
        refreshSessionReadModelOnFact(apiBase, payload.event);
      } else if (
        raw.event === SERVER_EVENTS.ORCHESTRATION_SESSION_PROJECTION_UPDATED
      ) {
        // archive#4054: this frame carries no claim beyond "re-read the
        // server projection". In particular, the client must not turn
        // `lastEventAt` into a second silence detector; the watchdog's
        // narrower progress derivation is serialized on that projection.
        void currentStreamQueryClient(apiBase)?.invalidateQueries({
          queryKey: ['orchestration-sessions'],
        });
      }
    },
    // `fetchSSE` owns transient retry. Keep its single-flight entry until it
    // reaches a terminal stop: deleting it here makes a remount during the
    // backoff window create a second stream while this one is still live and
    // scheduled to reconnect. Both streams then replay and apply the same
    // orchestration events.
    onError: () => {
      // Do not leave the last partial answer invisible during retry/backoff.
      settleSemanticDeliveryBuffer(apiBase, false);
      receiving = false;
      if (setStreamConnectionState(apiBase, 'interrupted'))
        recordReplayConnection(apiBase, 'interrupted');
    },
    // station#2301: a TERMINAL (401/403) failure parks this stream IN PLACE,
    // still registered, until the SDK's origin-scoped credential wake
    // (`notifyCredentialChanged`, fired by `ApiBaseContext` when the saved
    // credential changes) or an explicit `retry()` resumes it. It used to
    // `close()` and drop the entry instead, which aborted before the SDK
    // could register that wake — so fixing the credential recovered nothing,
    // and the dock sat on "Connection needs attention" until an app restart.
    //
    // archive#1094's concern still holds and is why the entry is KEPT: a
    // parked stream that had been dropped from `activeSources` would be an
    // orphan — unreachable to close, yet woken by a credential change to
    // replay against its stale cursor beside whatever stream a later ensure
    // created. Keeping it registered makes it the one owner, so no second
    // stream is ever created while it waits.
    //
    // Resuming in place keeps this stream's cursor. That assumes the new
    // credential is the same principal's; if it is not, the server still
    // gates every replayed event by the NEW request's authority.
    onTerminal: () => {
      // fetchSSE invokes onError first. Cancel its deferred transient flush:
      // a terminal 401/403 means authority was lost, so hidden content is
      // discarded rather than projected into a later replacement owner.
      settleSemanticDeliveryBuffer(apiBase, true);
      recordReplayConnection(apiBase, 'closed');
      setStreamConnectionState(apiBase, 'closed');
      owned.parked = true;
      // The floor counts from the rejection, so the first recovery signal
      // after a 401 does not immediately repeat it.
      owned.lastParkedRetryAt = monotonicNow();
    },
    onRetry: () => {
      // A deferred retry still pending re-checks `parked` before it fires.
      owned.parked = false;
    },
  });

  const owned: OwnedStream = {
    connection: authenticatedStream,
    parked: false,
    lastParkedRetryAt: 0,
    deferredParkedRetry: undefined,
    ended: false,
  };
  activeSources.set(apiBase, owned);
  // station#2301 review (L1): the abort signal covers every abort, but the
  // loop can also end by REJECTING — a callback above throwing inside the
  // SDK's catch — without aborting. Either way the connection is gone.
  void authenticatedStream.completed.then(
    () => {
      owned.ended = true;
      clearDeferredParkedRetry(owned);
    },
    (error: unknown) => {
      owned.ended = true;
      clearDeferredParkedRetry(owned);
      // Not silent: the dock must stop claiming a live feed, and whatever
      // threw is a defect worth seeing. The next recovery signal replaces it.
      if (setStreamConnectionState(apiBase, 'interrupted'))
        recordReplayConnection(apiBase, 'interrupted');
      console.error(
        '[orchestration] event stream ended unexpectedly; it will be replaced on the next ensure',
        error,
      );
    },
  );
  return release;
}
