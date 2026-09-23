import {
  ORCHESTRATION_STREAM_CAUGHT_UP_EVENT,
  SERVER_EVENTS,
} from '@kontourai/station-contracts/runtime-events';
import { type FetchSseConnection, fetchSSE } from '@kontourai/station-sdk';
import type { QueryClient } from '@tanstack/react-query';
import { activeChatsStore } from '../../contexts/active-chats-store';
import {
  handleOrchestrationEvent,
  settleSemanticDeliveryBuffer,
} from './eventHandlers';
import { drainQueuedMessagesOnOpenTurnClosed } from './queueDrain';
import {
  recordReplayConnection,
  recordReplaySnapshot,
} from './replay/capture-tap';
import { createStreamCursorTracker } from './resumeCursor';
import { applyOrchestrationSnapshot } from './snapshotHandlers';
import { setStreamConnectionState } from './streamConnectionState';
import type { OrchestrationEvent, OrchestrationSnapshotPayload } from './types';

const activeSources = new Map<string, FetchSseConnection>();

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
 * NOT LIVE IN PRODUCTION TODAY (#2307). This whole refresh needs a
 * `QueryClient`, and no production caller supplies one: the only caller,
 * `ChatDock.tsx`, calls `ensureOrchestrationEventStream(apiBase)` with none,
 * so `client` below is `undefined` and every branch returns early. The code is
 * correct for the moment #2307 wires a client; until then a Draft's first turn
 * reaches OTHER devices only through an unrelated refetch of the session list
 * (the sending device re-reads on its own send — `useSendMessage`). #2309
 * Phase B, a server-pushed conversation activity record, supersedes this.
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
 * The app's one `QueryClient`, recorded by whichever caller has it.
 *
 * `ensureOrchestrationEventStream` dedups per `apiBase` and only the FIRST
 * call for one takes effect, so the client is bound here rather than to the
 * stream's closure: a later call that carries a client still arms the refresh
 * above for a stream an earlier, client-less call created. No production
 * caller passes one yet (#2307), so in production this stays `undefined`.
 */
let sharedQueryClient: QueryClient | undefined;
function refreshSessionReadModelOnFact(
  queryClient: QueryClient | undefined,
  event: OrchestrationEvent,
): void {
  const client = queryClient ?? sharedQueryClient;
  if (!client || !SESSION_READ_MODEL_FACT_METHODS.has(event.method)) return;
  const elapsed = Date.now() - lastSessionReadModelRefreshAt;
  if (elapsed < SESSION_READ_MODEL_REFRESH_WINDOW_MS) {
    // One deferred refresh covers every fact that arrives in the window.
    if (deferredSessionReadModelRefresh === undefined) {
      deferredSessionReadModelRefresh = setTimeout(() => {
        deferredSessionReadModelRefresh = undefined;
        lastSessionReadModelRefreshAt = Date.now();
        void client.invalidateQueries({ queryKey: ['orchestration-sessions'] });
      }, SESSION_READ_MODEL_REFRESH_WINDOW_MS - elapsed);
    }
    return;
  }
  lastSessionReadModelRefreshAt = Date.now();
  void client.invalidateQueries({ queryKey: ['orchestration-sessions'] });
}

/**
 * Test-only: clears the module-global refresh throttle and client binding,
 * so each test starts from a quiet window instead of inheriting the last
 * test's (#2310 review L3).
 */
export function resetSessionReadModelRefreshForTests(): void {
  if (deferredSessionReadModelRefresh !== undefined) {
    clearTimeout(deferredSessionReadModelRefresh);
  }
  deferredSessionReadModelRefresh = undefined;
  lastSessionReadModelRefreshAt = 0;
  sharedQueryClient = undefined;
}

/**
 * archive#1225 `queryClient`, when supplied by a caller (none in production
 * yet — #2307), is threaded down to
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
  if (activeSources.has(apiBase)) return;
  // #2309: a queued follow-up drains when the server record closes the
  // chat's open turn, wherever that turn ran. One listener per stream.
  const stopDrainOnTurnClose = activeChatsStore.onOpenTurnClosed((closure) =>
    drainQueuedMessagesOnOpenTurnClosed(apiBase, closure),
  );
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
  // `isReconnectFallback` option for what that triggers. This flag lives on
  // the stream's own closure (not module scope), so it naturally resets if
  // `onTerminal` ever tears the whole stream down and a fresh
  // `ensureOrchestrationEventStream(apiBase)` call starts a new one.
  let hasReceivedSnapshot = false;
  let receiving = false;
  const authenticatedStream = fetchSSE(`${apiBase}/api/orchestration/events`, {
    authentication: 'required',
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
        refreshSessionReadModelOnFact(queryClient, payload.event);
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
    // archive#1094: a TERMINAL (401/403) failure now parks
    // this stream indefinitely waiting for an explicit wake instead of
    // giving up — `onError` alone would leave it an orphan: no longer
    // reachable to close (dropped from `activeSources` already), but still
    // strongly referenced by the SDK's origin-scoped credential-change wake
    // registry, and it would silently reactivate — re-applying events
    // against its own stale cursor alongside whatever stream a later
    // `ensureOrchestrationEventStream(apiBase)` call created in the
    // meantime — the next time a matching credential change fires.
    // `close` aborts the controller, which `fetchSSE` checks for
    // immediately after invoking this callback, so the stream never even
    // reaches the wake-registry registration below.
    onTerminal: () => {
      // fetchSSE invokes onError first. Cancel its deferred transient flush:
      // a terminal 401/403 means authority was lost, so hidden content is
      // discarded rather than projected into a later replacement owner.
      settleSemanticDeliveryBuffer(apiBase, true);
      recordReplayConnection(apiBase, 'closed');
      setStreamConnectionState(apiBase, 'closed');
      authenticatedStream.close();
      activeSources.delete(apiBase);
      stopDrainOnTurnClose();
    },
  });

  activeSources.set(apiBase, authenticatedStream);
}
