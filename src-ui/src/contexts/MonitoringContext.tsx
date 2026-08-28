import { MS_PER_MINUTE } from '@kontourai/station-contracts/time';
import {
  type FetchSseConnection,
  fetchMonitoringEvents,
  fetchSSE,
  useMonitoringStatsQuery,
} from '@kontourai/station-sdk';
import { K } from '@shared/monitoring-keys';
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { log } from '@/utils/logger';
import { useApiBase } from './ApiBaseContext';

export interface AgentStats {
  slug: string;
  name: string;
  status: 'idle' | 'active' | 'running';
  model: string;
  conversationCount: number;
  messageCount: number;
  cost: number;
  healthy?: boolean;
}

export interface MonitoringStats {
  agents: AgentStats[];
  summary: {
    totalAgents: number;
    activeAgents: number;
    runningAgents: number;
    totalMessages: number;
    totalCost: number;
  };
}

export interface MonitoringEvent {
  timestamp: string;
  'timestamp.ms': number;
  'trace.id': string;
  'gen_ai.operation.name': string;
  'gen_ai.provider.name'?: string;
  'gen_ai.request.model'?: string;
  'gen_ai.conversation.id'?: string;
  'gen_ai.usage.input_tokens'?: number;
  'gen_ai.usage.output_tokens'?: number;
  'gen_ai.response.finish_reasons'?: string[];
  'gen_ai.tool.name'?: string;
  'gen_ai.tool.call.id'?: string;
  'gen_ai.tool.call.arguments'?: unknown;
  'gen_ai.tool.call.result'?: unknown;
  'span.kind': 'start' | 'end' | 'event' | 'log';
  'station.agent.slug'?: string;
  'station.agent.steps'?: number;
  'station.agent.max_steps'?: number;
  'station.input.chars'?: number;
  'station.output.chars'?: number;
  'station.artifacts'?: Array<{
    type: string;
    name?: string;
    content?: unknown;
  }>;
  'station.user.id'?: string;
  'station.health.healthy'?: boolean;
  'station.health.checks'?: Record<string, boolean>;
  'station.health.integrations'?: Array<{
    id: string;
    type: string;
    connected: boolean;
    metadata?: { transport?: string; toolCount?: number };
  }>;
  'station.reasoning.text'?: string;
  'station.agent_telemetry.session_id'?: string;
  'station.agent_telemetry.event_id'?: string;
  'station.agent_telemetry.schema_version'?: string;
  'station.agent_telemetry.context'?: unknown;
  'station.agent_telemetry.enrichment'?: unknown;
  [key: string]: unknown;
}

/**
 * A key-order-independent serialization, so the same event canonicalizes
 * identically whether it arrived down the SSE stream or came back through a
 * JSON round-trip from the event log. `MonitoringEmitter` emits and persists
 * the one redacted object, so the CONTENT is identical; only key order is not
 * guaranteed to be.
 */
function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object')
    return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`)
    .join(',')}}`;
}

/**
 * Canonicalized once per event OBJECT, ever. The
 * same instance flows from the store into the view, so the reconciliation and
 * the new-event highlight both read a cached string instead of re-walking a
 * payload that can carry sizable nested tool results. Weak, so an event that
 * falls off the retention cap is collectable.
 */
const identityCache = new WeakMap<object, string>();

/**
 * The one identity two copies of the same monitoring event share
 * (archive#3658).
 *
 * The live SSE transport and the historical read deliver the SAME events by
 * different routes, so reconciling them needs a key. The emitter's own event
 * id is used when it has one. Otherwise the key is the event's own
 * canonicalized content — not a hash of it.
 *
 * Still-open: this used to be a 32-bit FNV-1a digest
 * of that canonical form, and a 32-bit digest used as an EQUALITY key is a
 * claim that two payloads are the same event when all that matched is 4 bytes
 * of hash. The review's probe found a real pair —
 * `"payload-v3xik8-s20"` and `"payload-kjjohx-160e"` as tool results under an
 * identical timestamp/trace/operation/kind — that collide, so a snapshot
 * containing one would confirm and erase the other. Two distinct events must
 * never share an identity, and the canonical string is the only key that
 * guarantees it. Memory is bounded: at most `MAX_RETAINED_EVENTS` live keys,
 * each cached against its own event object.
 *
 * Exported so the reconciliation is testable rather than inferred from the
 * rendered list.
 */
export function monitoringEventIdentity(event: MonitoringEvent): string {
  const emitted = event[K.AT_EVENT_ID];
  if (typeof emitted === 'string' && emitted) return emitted;
  const cached = identityCache.get(event);
  if (cached !== undefined) return cached;
  const identity = stableSerialize(event);
  identityCache.set(event, identity);
  return identity;
}

const MAX_RETAINED_EVENTS = 1000;

/**
 * When a row happened, derived exactly as the `/monitoring/events` route
 * derives it (see its own note): `typeof`, not `Number`, because
 * `Number(null)` is a finite 0 and would sort a row with a good ISO
 * `timestamp` as 1970; and an untimed row sorts oldest rather than being
 * dropped.
 */
function monitoringEventTime(event: MonitoringEvent): number {
  const raw = event[K.TIMESTAMP_MS];
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  const parsed = Date.parse(String(event[K.TIMESTAMP] ?? ''));
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

/**
 * The store's one ordering rule (archive#3658): chronological, oldest
 * first, and capped to the MOST RECENT
 * `MAX_RETAINED_EVENTS`.
 *
 * ORDER. Historical rows arrive oldest-first — the route says so in its own
 * words, "this endpoint returns rows oldest-first and the Monitoring view
 * relies on it" — while SSE arrivals used to be prepended, so a reconciled
 * list read 10:03, 10:02, 10:00, 10:01 and rows jumped position when a later
 * snapshot confirmed them. Three things in the view agree on which direction
 * is right: `MonitoringLogStream` renders `logEndRef` AFTER the rows and
 * auto-follow scrolls to it, so the newest belongs at the BOTTOM; and
 * `MonitoringView`'s new-event highlight walks `prevCount → length`, which
 * only marks the right rows if arrivals land at the END. Sorting newest-first
 * would have inverted the timeline and pointed auto-follow at the oldest
 * event. Ties keep insertion order (an explicit index tiebreak rather than a
 * bet on engine sort stability).
 *
 * CAP. `slice(0, N)` kept the OLDEST N of an oldest-first snapshot: a "today"
 * that returned 1,500 rows silently dropped the newest 500 — a regression the
 * reconciliation introduced, since hydration was not client-truncated before
 * it. A bounded view of a growing log is only useful from the recent end, so
 * the cap takes the tail, which is the same semantics the route's own limit
 * uses.
 */
function orderedRecentEvents(events: MonitoringEvent[]): MonitoringEvent[] {
  const ordered = events
    .map((event, index) => ({ event, index, time: monitoringEventTime(event) }))
    .sort((left, right) => left.time - right.time || left.index - right.index)
    .map((entry) => entry.event);
  return ordered.length > MAX_RETAINED_EVENTS
    ? ordered.slice(ordered.length - MAX_RETAINED_EVENTS)
    : ordered;
}

class MonitoringStore {
  private events: MonitoringEvent[] = [];
  private listeners = new Set<() => void>();
  private eventSource: FetchSseConnection | null = null;
  readonly apiBase: string;
  private lastHeartbeat: number = Date.now();
  private heartbeatCheckInterval: NodeJS.Timeout | null = null;
  private hydrationController: AbortController | null = null;
  private hydrationGeneration = 0;
  private cachedSnapshot: {
    events: MonitoringEvent[];
    connectionStatus: 'connected' | 'connecting' | 'disconnected' | 'error';
    isLoading: boolean;
    readError: unknown;
  } | null = null;
  isLiveMode: boolean = true;
  dateRange: { start?: Date; end?: Date } | null = null;
  connectionStatus: 'connected' | 'connecting' | 'disconnected' | 'error' =
    'disconnected';
  isLoading: boolean = false;
  /**
   * archive#3658: the historical read's own failure, kept rather than logged
   * and dropped. This store is outside React Query, so nothing else holds it —
   * and without it the view has no way to tell "this Station recorded no
   * events" from "this Station could not be asked", and drew the first over
   * the second. Live SSE health stays in `connectionStatus`; the two are
   * independent facts about independent transports.
   */
  readError: unknown = null;
  /**
   * The bounds the read that produced `readError` actually asked for
   * (archive#3653/archive#3658). Retry must re-ask THAT interval:
   * re-deriving the live default at click time asks for `now - 5m`, so a
   * hydration of 11:55–12:00 that failed and is retried at 12:08 would fetch
   * 12:03–12:08 and skip the failed window forever. Cleared on success and
   * whenever the mode/range changes, because those pick a new window on
   * purpose.
   */
  private failedWindow: { start?: Date; end?: Date } | null = null;
  /**
   * SSE-delivered events no hydration snapshot has confirmed yet
   * (archive#3658). A successful hydration used to ASSIGN
   * its snapshot over the shared list, so an event the live stream had
   * already shown the operator — including one that arrived under a rendered
   * read failure — vanished the moment a lagging disk snapshot came back, and
   * the view could then draw "No events yet" over it. Kept until a snapshot
   * contains it, so the two transports converge instead of overwriting.
   */
  private liveArrivals: MonitoringEvent[] = [];

  constructor(apiBase: string) {
    this.apiBase = apiBase;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    // Reference-counted lifecycle (archive#1989): the live monitoring SSE + its
    // heartbeat exist only while at least one view is mounted. The first
    // subscriber (re)connects in the store's current mode; the last one to
    // leave tears the stream down. Leaving /developer/telemetry therefore
    // stops the stream instead of leaking it for the app's lifetime.
    if (this.listeners.size === 1) {
      this.connect();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.disconnect();
      }
    };
  };

  /** (Re)establish the store's data source for its current time mode. */
  private connect() {
    if (this.isLiveMode) {
      this.connectEventStream(this.dateRange?.start);
    } else {
      this.fetchHistoricalEvents(this.dateRange?.start, this.dateRange?.end);
    }
  }

  /**
   * The window the current mode hydrates from. One derivation, so a retry
   * asks for exactly what the failed read asked for instead of re-guessing
   * the live-mode default in a second place.
   */
  private hydrationWindow(startFrom?: Date): { start?: Date; end?: Date } {
    if (!this.isLiveMode) {
      return { start: this.dateRange?.start, end: this.dateRange?.end };
    }
    const now = new Date();
    return {
      start:
        startFrom ??
        this.dateRange?.start ??
        new Date(now.getTime() - 5 * 60 * 1000),
      end: now,
    };
  }

  getSnapshot = () => {
    if (!this.cachedSnapshot) {
      this.cachedSnapshot = {
        events: this.events,
        connectionStatus: this.connectionStatus,
        isLoading: this.isLoading,
        readError: this.readError,
      };
    }
    return this.cachedSnapshot;
  };

  private notify() {
    this.cachedSnapshot = null;
    this.listeners.forEach((listener) => listener());
  }

  async fetchHistoricalEvents(start?: Date, end?: Date) {
    const requested = { start, end };
    this.hydrationController?.abort();
    const controller = new AbortController();
    this.hydrationController = controller;
    const generation = ++this.hydrationGeneration;
    try {
      this.isLoading = true;
      // A new attempt is not yet a failure: clear the previous one so the
      // retry shows its own outcome, not the one it was launched to replace.
      // The recorded window goes with it — this attempt owns the slot now,
      // and its own catch below re-records `requested` if it fails too.
      this.readError = null;
      this.failedWindow = null;
      this.notify();
      const events = (await fetchMonitoringEvents(
        start,
        end,
        controller.signal,
      )) as MonitoringEvent[];
      if (
        controller.signal.aborted ||
        generation !== this.hydrationGeneration ||
        this.hydrationController !== controller
      ) {
        return;
      }
      this.events = this.mergeHydratedEvents(events);
      this.failedWindow = null;
    } catch (error) {
      if (!controller.signal.aborted) {
        log.api('Failed to fetch historical events:', error);
        // Only the read that is still current may claim the view's error
        // slot — a superseded attempt failing late must not overwrite the
        // outcome of the one that replaced it (same guard as the success
        // path above).
        if (generation === this.hydrationGeneration) {
          this.readError = error;
          this.failedWindow = requested;
        }
      }
    } finally {
      if (generation === this.hydrationGeneration) {
        this.hydrationController = null;
        this.isLoading = false;
        this.notify();
      }
    }
  }

  /**
   * A hydration snapshot, plus the live events it does not yet contain.
   *
   * Confirmed arrivals are pruned from `liveArrivals` as the snapshot catches
   * up, so the buffer converges to empty rather than pinning events forever.
   */
  private mergeHydratedEvents(hydrated: MonitoringEvent[]): MonitoringEvent[] {
    // cap FIRST, then reconcile. `/monitoring/events`
    // has no default result limit and a monitoring event has no per-event byte
    // ceiling, so a wide window full of nested tool results used to be
    // canonicalized row by row on the UI thread — including every row the very
    // next line was about to discard. Rows that cannot survive the cap are
    // never canonicalized at all.
    const recent = orderedRecentEvents(hydrated);
    //.and when nothing is awaiting reconciliation there is no identity work
    // to do in the first place, which is the ordinary case: a hydration with a
    // healthy stream and no unconfirmed arrivals hashes nothing.
    if (this.liveArrivals.length === 0) {
      return recent;
    }
    const hydratedIds = new Set(recent.map(monitoringEventIdentity));
    this.liveArrivals = this.liveArrivals.filter(
      (event) => !hydratedIds.has(monitoringEventIdentity(event)),
    );
    return orderedRecentEvents([...this.liveArrivals, ...recent]);
  }

  setDateRange(range: 'now' | 'today' | 'week' | 'month' | 'all') {
    const now = new Date();
    let start: Date | undefined;
    let end: Date | undefined = now;

    switch (range) {
      case 'now':
        // Live mode - no date range
        this.isLiveMode = true;
        this.dateRange = null;
        this.disconnect();
        this.connectEventStream();
        return;

      case 'today':
        start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        break;

      case 'week':
        start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;

      case 'month':
        start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        break;

      case 'all':
        start = undefined;
        end = undefined;
        break;
    }

    this.isLiveMode = false;
    this.dateRange = { start, end };
    this.disconnect();
    this.fetchHistoricalEvents(start, end);
  }

  setTimeRange(start?: Date, end?: Date, isLive: boolean = false) {
    if (isLive) {
      this.isLiveMode = true;
      this.dateRange = start ? { start, end } : null;
      this.disconnect();
      this.connectEventStream(start);
    } else {
      this.isLiveMode = false;
      this.dateRange = { start, end };
      this.disconnect();
      this.fetchHistoricalEvents(start, end);
    }
  }

  connectEventStream(startFrom?: Date) {
    if (this.eventSource) return;

    this.connectionStatus = 'connecting';
    this.notify();

    // Load historical data from specified start time or last 5 minutes
    const { start, end } = this.hydrationWindow(startFrom);
    this.fetchHistoricalEvents(start, end);

    this.eventSource = fetchSSE(`${this.apiBase}/monitoring/events`, {
      authentication: 'required',
      // archive#1848: see `ensureOrchestrationEventStream.ts` — a ceiling
      // equal to the initial delay is a fixed poll, not a ladder.
      retryDelayMs: 5000,
      maxRetryDelayMs: 30_000,
      onOpen: () => {
        this.connectionStatus = 'connected';
        this.notify();
      },
      onMessage: (event) => {
        try {
          const data = JSON.parse(event.data);

          // Filter out SSE protocol events
          if (data[K.SYSTEM_TYPE] === 'heartbeat') {
            this.lastHeartbeat = Date.now();
            return;
          }
          if (data[K.SYSTEM_TYPE] === 'connected') {
            this.connectionStatus = 'connected';
            this.notify();
            return;
          }

          // Placed by its timestamp, not pushed to the front: the same one
          // ordering rule the hydration merge uses (see
          // `orderedRecentEvents`), so the list is chronological at every
          // moment rather than only just after a merge.
          this.events = orderedRecentEvents([...this.events, data]);
          // Also held unreconciled, so a later hydration snapshot cannot
          // silently drop an event the operator has already been shown.
          this.liveArrivals = orderedRecentEvents([...this.liveArrivals, data]);
          this.notify();
        } catch (error) {
          log.api('Failed to parse event:', error);
        }
      },
      onError: () => {
        log.api('Monitoring stream error, reconnecting...');
        this.connectionStatus = 'error';
        this.notify();
      },
    });

    // Check heartbeat every 10 seconds - mark stale if no heartbeat
    this.heartbeatCheckInterval = setInterval(() => {
      const timeSinceHeartbeat = Date.now() - this.lastHeartbeat;
      if (
        timeSinceHeartbeat > MS_PER_MINUTE &&
        this.connectionStatus === 'connected'
      ) {
        log.api('No heartbeat for 60s, marking connection as error');
        this.connectionStatus = 'error';
        this.notify();
      }
    }, 10000);
  }

  disconnect() {
    // The stream is going away, and its unconfirmed arrivals belong to the
    // window it was serving — carrying them into another mode's window would
    // show events outside the range the operator asked for.
    this.liveArrivals = [];
    this.hydrationGeneration++;
    this.hydrationController?.abort();
    this.hydrationController = null;
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    if (this.heartbeatCheckInterval) {
      clearInterval(this.heartbeatCheckInterval);
      this.heartbeatCheckInterval = null;
    }
    this.connectionStatus = 'disconnected';
  }

  /**
   * Re-run the historical read the view is currently showing (archive#3658).
   * Deliberately does not touch the SSE stream: the live transport has its
   * own reconnect ladder and its own status, and a failed history read is no
   * reason to tear a healthy stream down.
   */
  retryHistoricalRead = () => {
    // Re-ask the interval that failed. The END may widen to now — anything
    // recorded since is legitimately part of what the operator is looking at
    // but the START never advances, or the failed window is skipped
    //  With no recorded failure this is an ordinary
    // refresh of the current mode's window.
    const failed = this.failedWindow;
    if (!failed) {
      const { start, end } = this.hydrationWindow();
      this.fetchHistoricalEvents(start, end);
      return;
    }
    // Live mode's window ends at "now" by construction, so widening its end
    // is the same question asked later. An explicit historical range is the
    // operator's own bounds — re-ask those verbatim.
    this.fetchHistoricalEvents(
      failed.start,
      this.isLiveMode ? new Date() : failed.end,
    );
  };

  clearEvents() {
    this.events = [];
    this.liveArrivals = [];
    this.notify();
  }
}

const stores = new Map<string, MonitoringStore>();

function getStore(apiBase: string): MonitoringStore {
  if (!stores.has(apiBase)) {
    // No eager connect: the stream is driven by subscriber reference counting
    // (see `subscribe`) so it opens only while a consumer is mounted and
    // reconnects on remount, instead of running for the app's lifetime.
    stores.set(apiBase, new MonitoringStore(apiBase));
  }
  return stores.get(apiBase)!;
}

export function useMonitoring() {
  const { apiBase } = useApiBase();
  const store = useMemo(() => getStore(apiBase), [apiBase]);
  const data = useSyncExternalStore(store.subscribe, store.getSnapshot);

  // Stats via useQuery — replaces manual polling
  const { data: stats } = useMonitoringStatsQuery();

  const clearEvents = useCallback(() => store.clearEvents(), [store]);
  const retryRead = useCallback(() => store.retryHistoricalRead(), [store]);
  const setDateRange = useCallback(
    (range: 'now' | 'today' | 'week' | 'month' | 'all') =>
      store.setDateRange(range),
    [store],
  );
  const setTimeRange = useCallback(
    (start?: Date, end?: Date, isLive?: boolean) =>
      store.setTimeRange(start, end, isLive),
    [store],
  );

  return {
    stats: stats ?? null,
    events: data.events,
    connectionStatus: data.connectionStatus,
    isLoading: data.isLoading,
    readError: data.readError,
    retryRead,
    clearEvents,
    setDateRange,
    setTimeRange,
  };
}
