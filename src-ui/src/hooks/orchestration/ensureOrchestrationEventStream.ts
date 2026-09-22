import {
  ORCHESTRATION_STREAM_CAUGHT_UP_EVENT,
  SERVER_EVENTS,
} from '@kontourai/station-contracts/runtime-events';
import { type FetchSseConnection, fetchSSE } from '@kontourai/station-sdk';
import type { QueryClient } from '@tanstack/react-query';
import { CLIENT_DOCUMENT_SESSION_ID } from '../clientDocumentSession';
import {
  handleOrchestrationEvent,
  settleSemanticDeliveryBuffer,
} from './eventHandlers';
import {
  recordReplayConnection,
  recordReplaySnapshot,
} from './replay/capture-tap';
import { createStreamCursorTracker } from './resumeCursor';
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
/** apiBases whose chats this document has already seeded from a snapshot. */
const basesWithSnapshot = new Set<string>();

function reensureRequestedStreams(): void {
  if (
    (globalThis as { document?: { hidden?: boolean } }).document?.hidden ===
    true
  )
    return;
  for (const apiBase of requestedBases) ensureOrchestrationEventStream(apiBase);
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
    reensureRequestedStreams,
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
 * fold. Only a session-ending event triggers it, and at most once a second, so
 * a chatty stream cannot turn this into a refetch loop.
 */
const TERMINAL_METHODS: ReadonlySet<string> = new Set([
  'runtime.error',
  'session.exited',
  'turn.completed',
  'turn.aborted',
]);
let lastSessionReadModelRefreshAt = 0;
/**
 * The app's one `QueryClient`, recorded by whichever caller has it.
 *
 * `ensureOrchestrationEventStream` dedups per `apiBase` and only the FIRST
 * call for one takes effect — and `ChatDock.tsx` calls it WITHOUT a client
 * while `useOrchestration` calls it WITH one, so which of the two wins is a
 * mount-order accident. Binding the client here instead of to the stream's
 * closure means the refresh above works whichever call created the stream.
 * Safe because there is exactly one `QueryClient` for the app's lifetime (the
 * same premise the parameter's own docblock already rests on).
 */
let sharedQueryClient: QueryClient | undefined;
function refreshSessionReadModelOnTerminal(
  queryClient: QueryClient | undefined,
  event: OrchestrationEvent,
): void {
  const client = queryClient ?? sharedQueryClient;
  if (!client || !TERMINAL_METHODS.has(event.method)) return;
  const now = Date.now();
  if (now - lastSessionReadModelRefreshAt < 1000) return;
  lastSessionReadModelRefreshAt = now;
  void client.invalidateQueries({ queryKey: ['orchestration-sessions'] });
}

/**
 * archive#1225 `queryClient`, when supplied by the
 * caller (`useOrchestration`'s `useQueryClient`), is threaded down to
 * `applyOrchestrationSnapshot`'s reconnect-fallback refetch so it keeps the
 * SAME `toolMappings` cache-lookup fallback the mount-time rehydrate path
 * has — see `rehydrateChatSession.ts`'s file-header note. Only the FIRST
 * call for a given `apiBase` takes effect (the existing dedup guard below
 * returns early on every later call) — in practice there is exactly one
 * `QueryClient` for the app's lifetime, so this is never observably stale.
 */
export function ensureOrchestrationEventStream(
  apiBase: string,
  queryClient?: QueryClient,
) {
  if (queryClient) sharedQueryClient = queryClient;
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
    return;
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
    // station#2301: lets the server's stream open/close lines say WHICH
    // document connected — see `clientDocumentSession.ts`.
    headers: { 'X-Station-Client-Session': CLIENT_DOCUMENT_SESSION_ID },
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
        setStreamConnectionState(apiBase, 'caught-up');
        recordReplayConnection(apiBase, 'caught-up');
      } else if (raw.event === 'orchestration:snapshot') {
        // A replacement snapshot already contains every durable delta. Reveal
        // locally held text first, then let the snapshot become authoritative.
        settleSemanticDeliveryBuffer(apiBase);
        // A snapshot always replaces local state — adopt its cursor
        // unconditionally rather than gating it through `admit`.
        cursor.adopt(raw.id);
        const payload = JSON.parse(raw.data) as OrchestrationSnapshotPayload;
        recordReplaySnapshot(apiBase, payload, hasReceivedSnapshot);
        applyOrchestrationSnapshot(payload, {
          apiBase,
          isReconnectFallback: hasReceivedSnapshot,
          queryClient,
        });
        hasReceivedSnapshot = true;
        basesWithSnapshot.add(apiBase);
      } else if (raw.event === SERVER_EVENTS.ORCHESTRATION_EVENT) {
        if (!cursor.admit(raw.id)) return;
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
        );
        refreshSessionReadModelOnTerminal(queryClient, payload.event);
      } else if (
        raw.event === SERVER_EVENTS.ORCHESTRATION_SESSION_PROJECTION_UPDATED
      ) {
        // archive#4054: this frame carries no claim beyond "re-read the
        // server projection". In particular, the client must not turn
        // `lastEventAt` into a second silence detector; the watchdog's
        // narrower progress derivation is serialized on that projection.
        void (queryClient ?? sharedQueryClient)?.invalidateQueries({
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
      owned.parked = false;
      clearDeferredParkedRetry(owned);
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
}
