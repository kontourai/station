/**
 * Agent-activity push publisher: keeps one card per Station current on every
 * phone that registered for native push, by way of the Kontour push gateway
 * (`POST {gateway}/v1/fcm/send`, Station-signed; see deploy/push-gateway and
 * docs/design/notification-delivery.md, "Station contract").
 *
 * Shape, following `wireWebPushDelivery` and the console bridge:
 * - an EventBus subscriber that only marks the card dirty, and only for
 *   events that can change a session's lifecycle or title (never streamed
 *   content), and only while at least one phone is registered — a Station
 *   with no registration makes no reads and no gateway traffic;
 * - a `KeyedCoalescingWorker` that coalesces bursts (~1 s) into one read of
 *   the session read model, builds the card, and seals it separately to each
 *   registered phone that has not received it;
 * - one unref'd timer that re-flushes when a delivery failed (with backoff),
 *   when a device was held back by the per-device send interval, when a live
 *   card nears its expiry on the phone, and once shortly after boot;
 * - never throws into the bus and never blocks it: all work is asynchronous
 *   and every failure is caught and logged without the token or payload.
 *
 * The card is end-to-end encrypted to the phone (`agent-activity-seal.ts`):
 * the gateway and FCM see only `station_kind`, the registrationId and the
 * sealed blob.
 *
 * Gateway answers: 200 sent; 410 the token is dead — clear that device's
 * registration (only if it still holds that token); 503/429/5xx and network
 * errors wait for the timer with backoff; 401/400/413/422 are logged and the
 * card is not retried.
 */
import type { NativePushSealedData } from '@kontourai/station-contracts/native-push';
import type { OrchestrationSessionSummary } from '@kontourai/station-contracts/orchestration';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { errorMessage } from '../../utils/error-message.js';
import { KeyedCoalescingWorker } from '../infra/keyed-coalescing-worker.js';
import type { EventBus } from '../orchestration/event-bus.js';
import { collectOpenRequests } from '../orchestration/open-requests.js';
import {
  type AgentActivityCard,
  type AgentActivityPhase,
  type AgentActivitySessionFacts,
  type AgentActivitySnapshot,
  agentActivityAlertFields,
  agentActivityPhaseFor,
  buildAgentActivityCard,
  composeAgentActivityPlaintext,
} from './agent-activity-card.js';
import { sealAgentActivityCard } from './agent-activity-seal.js';
import type { NativePushRegistration } from './native-push-registration-store.js';
import type { PushSigningKey } from './push-signing-key-store.js';

const DEFAULT_PUSH_GATEWAY_URL = 'https://push.kontourai.io';
const SEND_PATH = '/v1/fcm/send';
const COALESCE_WINDOW_MS = 1_000;
const REQUEST_TIMEOUT_MS = 10_000;
/**
 * The gateway allows 30 sends a minute per push token; never send to one
 * device more often than this. A change inside the interval is coalesced
 * into the next send, which the timer schedules.
 */
const MIN_SEND_INTERVAL_MS = 3_000;
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;
/** After this many consecutive failures only a new event retries. */
const MAX_TIMED_RETRIES = 8;
/** Re-send a live card this long before the phone would expire it. */
const REFRESH_BEFORE_EXPIRY_MS = 30 * 60_000;
const BOOT_FLUSH_DELAY_MS = 5_000;
/** Alert ids remembered per device, so an alert is raised once. */
const ALERTED_MEMORY = 256;
const CARD_KEY = 'card';

/**
 * Canonical runtime events that can move a session's lifecycle state or set
 * its display title. Content deltas and tool traffic are deliberately absent:
 * they would turn every streamed token into a read-model scan.
 */
const CARD_RELEVANT_METHODS = new Set([
  'session.started',
  'session.configured',
  'session.state-changed',
  'session.exited',
  'turn.started',
  'turn.completed',
  'turn.aborted',
  'request.opened',
  'request.resolved',
  'runtime.error',
]);

export interface PushGatewayConfig {
  /** Absolute URL of the send endpoint. */
  sendUrl: string;
  /** The gateway origin: the token's `aud`. */
  audience: string;
}

/**
 * `STATION_PUSH_GATEWAY_URL` (default the Kontour gateway): an https origin
 * and nothing else. A path, query, fragment or credentials are refused rather
 * than silently dropped, and so is plain http — the request carries the
 * phone's FCM token. Null disables native push (routes and publisher).
 */
export function resolvePushGatewayConfig(
  env: NodeJS.ProcessEnv = process.env,
): PushGatewayConfig | null {
  const raw = env.STATION_PUSH_GATEWAY_URL?.trim() || DEFAULT_PUSH_GATEWAY_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    raw.includes('?') ||
    raw.includes('#')
  )
    return null;
  return {
    sendUrl: new URL(SEND_PATH, url.origin).toString(),
    audience: url.origin,
  };
}

/** The session facts the card is built from; nothing else is read. */
export interface AgentActivitySessionRow extends AgentActivitySessionFacts {
  sessionId: string;
  title?: string;
  project?: string;
  /** ISO time of the session's latest event; fallback entry time. */
  lastEventAt?: string;
  /** Which entry into its current phase, from the event log. */
  entry?: { key: string; at: number };
}

/**
 * The privacy boundary: projects a read-model row down to title, project
 * name and lifecycle facts. Transcripts, prompts, tool output and paths are
 * not in the result type, so nothing downstream can send them.
 */
export function agentActivityRowFromSummary(
  summary: OrchestrationSessionSummary,
  projectName: (slug: string) => string | undefined,
): AgentActivitySessionRow {
  return {
    sessionId: summary.threadId,
    ...(summary.displayTitle ? { title: summary.displayTitle } : {}),
    ...(summary.projectSlug
      ? { project: projectName(summary.projectSlug) ?? summary.projectSlug }
      : {}),
    ...(summary.lifecycleState
      ? { lifecycleState: summary.lifecycleState }
      : {}),
    status: summary.status,
    ...(summary.pendingReview !== undefined
      ? { pendingReview: summary.pendingReview }
      : {}),
    // Only the kind: the attribution's detail is free text.
    ...(summary.terminalAttribution
      ? { terminalAttribution: { kind: summary.terminalAttribution.kind } }
      : {}),
    ...(summary.hasActiveTurn !== undefined
      ? { hasActiveTurn: summary.hasActiveTurn }
      : {}),
    isLoaded: summary.isLoaded,
    ...(summary.draft !== undefined ? { draft: summary.draft } : {}),
    ...(summary.lastEventAt ? { lastEventAt: summary.lastEventAt } : {}),
  };
}

function latestOf(
  events: readonly CanonicalRuntimeEvent[],
  methods: readonly string[],
): CanonicalRuntimeEvent | undefined {
  let latest: CanonicalRuntimeEvent | undefined;
  for (const event of events) {
    if (!methods.includes(event.method)) continue;
    if (!latest || Date.parse(event.createdAt) >= Date.parse(latest.createdAt))
      latest = event;
  }
  return latest;
}

/**
 * Which entry into `phase` the session is in, from its lifecycle event log
 * (the same projection events the read model folds): the open request for a
 * waiting session, the turn for a live one, the terminal event for a
 * finished one. Two approvals on one session are two entries, even when
 * nothing observed the session between them.
 */
export function phaseEntryFromEvents(
  phase: AgentActivityPhase,
  events: readonly CanonicalRuntimeEvent[],
): { key: string; at: number } | undefined {
  let event: CanonicalRuntimeEvent | undefined;
  let key: string | undefined;
  if (phase === 'waiting_for_approval' || phase === 'waiting_for_input') {
    const wantInput = phase === 'waiting_for_input';
    const open = [...collectOpenRequests([...events]).values()].filter(
      (request) => (request.requestType === 'input') === wantInput,
    );
    event = latestOf(open, ['request.opened']);
    if (event?.method === 'request.opened') key = `request:${event.requestId}`;
  } else if (phase === 'running' || phase === 'starting') {
    event = latestOf(events, ['turn.started']);
    if (event) key = `turn:${event.turnId ?? event.eventId}`;
  } else if (phase === 'completed') {
    event = latestOf(events, ['turn.completed', 'session.exited']);
    if (event) key = `event:${event.eventId}`;
  } else if (phase === 'failed') {
    event = latestOf(events, ['runtime.error', 'session.exited']);
    if (event) key = `event:${event.eventId}`;
  } else {
    event = latestOf(events, ['session.state-changed']);
    if (event) key = `event:${event.eventId}`;
  }
  const at = event ? Date.parse(event.createdAt) : Number.NaN;
  return key && Number.isFinite(at) ? { key, at } : undefined;
}

/**
 * Read-model rows plus each carded session's entry identity. Only sessions
 * that will be on the card have their (bounded, lifecycle-only) projection
 * events read.
 */
export function agentActivityRowsWithEntries(
  rows: AgentActivitySessionRow[],
  readEvents: (threadIds: string[]) => Map<string, CanonicalRuntimeEvent[]>,
): AgentActivitySessionRow[] {
  const phases = new Map(
    rows.flatMap((row) => {
      const phase = agentActivityPhaseFor(row);
      return phase ? [[row.sessionId, phase] as const] : [];
    }),
  );
  if (phases.size === 0) return rows;
  const events = readEvents([...phases.keys()]);
  return rows.map((row) => {
    const phase = phases.get(row.sessionId);
    const entry = phase
      ? phaseEntryFromEvents(phase, events.get(row.sessionId) ?? [])
      : undefined;
    return entry ? { ...row, entry } : row;
  });
}

export interface AgentActivityDevicePairing {
  listNativePushRegistrations(): Array<{
    deviceId: string;
    registration: NativePushRegistration;
  }>;
  clearNativePush(deviceId: string, expectedToken?: string): unknown;
  environmentId(): string;
}

interface AgentActivityLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

type Cancel = () => void;

export interface AgentActivityPublisherOptions {
  eventBus: EventBus;
  devicePairing: AgentActivityDevicePairing;
  signingKey: { read(): PushSigningKey | null };
  listSessions: () => Promise<AgentActivitySessionRow[]>;
  gateway: PushGatewayConfig;
  logger: AgentActivityLogger;
  /** Hosted mode or an invalid gateway URL: do not even subscribe. */
  enabled?: boolean;
  fetchImpl?: typeof fetch;
  now?: () => number;
  windowMs?: number;
  /** Tests: replaces the unref'd `setTimeout` behind the publisher's timer. */
  setTimer?: (callback: () => void, delayMs: number) => Cancel;
}

export interface AgentActivityPublisher {
  /** Rebuild and send the card now (e.g. a phone just registered). */
  requestFlush(): void;
  /** Resolves once every queued or in-flight flush has finished. */
  drain(): Promise<void>;
  stop(): Promise<void>;
}

type SendOutcome = 'sent' | 'unregistered' | 'retryable' | 'rejected';

function classify(status: number): SendOutcome {
  if (status >= 200 && status < 300) return 'sent';
  if (status === 410) return 'unregistered';
  if (status === 429 || status >= 500) return 'retryable';
  return 'rejected';
}

interface DeviceState {
  registrationId: string;
  token: string;
  /** Content key of the last card this device accepted. */
  cardKey?: string;
  deliveredActive?: boolean;
  deliveredExpiresAt?: number;
  /** Alert entry ids this device has been sent, oldest first. */
  alerted: string[];
  lastAttemptAt?: number;
  failures: number;
  retryAt?: number;
}

/**
 * When a session entered the phase it was just observed in, when the event
 * log could not say: the latest event, falling back to the observation time
 * when that time is missing, in the future, or older than the phase already
 * known.
 */
function phaseEntryTime(
  lastEventAt: string | undefined,
  previousEnteredAt: number | undefined,
  at: number,
): number {
  const eventAt = lastEventAt ? Date.parse(lastEventAt) : Number.NaN;
  if (!Number.isFinite(eventAt) || eventAt > at) return at;
  if (previousEnteredAt !== undefined && eventAt < previousEnteredAt) return at;
  return eventAt;
}

const defaultSetTimer = (callback: () => void, delayMs: number): Cancel => {
  const handle = setTimeout(callback, delayMs);
  handle.unref?.();
  return () => clearTimeout(handle);
};

export function wireAgentActivityPublisher(
  options: AgentActivityPublisherOptions,
): AgentActivityPublisher {
  if (options.enabled === false) {
    return {
      requestFlush: () => {},
      drain: async () => {},
      stop: async () => {},
    };
  }
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
  const setTimer = options.setTimer ?? defaultSetTimer;
  const { logger, devicePairing } = options;

  const snapshots = new Map<string, AgentActivitySnapshot>();
  const devices = new Map<string, DeviceState>();
  const warned = new Set<string>();
  let lastUpdatedAt = 0;
  let stopped = false;
  let cancelTimer: Cancel | undefined;
  let timerAt: number | undefined;

  function warnOnce(key: string, message: string) {
    if (warned.has(key)) return;
    warned.add(key);
    logger.warn(message);
  }

  function registrations() {
    try {
      const list = devicePairing.listNativePushRegistrations();
      warned.delete('registrations');
      return list;
    } catch (error) {
      warnOnce(
        'registrations',
        `agent-activity: native push registrations are unreadable (${errorMessage(error)}); not sending`,
      );
      return [];
    }
  }

  function refreshSnapshots(rows: AgentActivitySessionRow[], at: number) {
    const seen = new Set<string>();
    for (const row of rows) {
      const phase = agentActivityPhaseFor(row);
      if (!phase) continue;
      seen.add(row.sessionId);
      const previous = snapshots.get(row.sessionId);
      let enteredAt: number;
      let entryKey: string;
      if (row.entry) {
        enteredAt = Math.min(row.entry.at, at);
        entryKey = row.entry.key;
      } else if (previous?.phase === phase) {
        enteredAt = previous.enteredAt;
        entryKey = previous.entryKey;
      } else {
        enteredAt = phaseEntryTime(row.lastEventAt, previous?.enteredAt, at);
        entryKey = `observed:${enteredAt}`;
      }
      snapshots.set(row.sessionId, {
        sessionId: row.sessionId,
        title: row.title ?? '',
        project: row.project ?? '',
        phase,
        enteredAt,
        entryKey,
      });
    }
    for (const sessionId of [...snapshots.keys()])
      if (!seen.has(sessionId)) snapshots.delete(sessionId);
  }

  function stateFor(deviceId: string, registration: NativePushRegistration) {
    const current = devices.get(deviceId);
    if (
      current &&
      current.registrationId === registration.registrationId &&
      current.token === registration.token
    )
      return current;
    // A new token or registration has seen nothing yet.
    const fresh: DeviceState = {
      registrationId: registration.registrationId,
      token: registration.token,
      alerted: [],
      failures: 0,
      ...(current?.lastAttemptAt !== undefined
        ? { lastAttemptAt: current.lastAttemptAt }
        : {}),
    };
    devices.set(deviceId, fresh);
    return fresh;
  }

  async function send(body: string, key: PushSigningKey): Promise<SendOutcome> {
    const bytes = Buffer.from(body, 'utf8');
    try {
      const authorization = `Station ${key.signRequest(bytes, {
        audience: options.gateway.audience,
        nowMs: now(),
      })}`;
      const response = await fetchImpl(options.gateway.sendUrl, {
        method: 'POST',
        headers: { authorization, 'content-type': 'application/json' },
        body: bytes,
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      // Drain so the connection can be reused; the body is never needed.
      await response.arrayBuffer().catch(() => undefined);
      const outcome = classify(response.status);
      if (outcome !== 'sent')
        logger.warn('agent-activity: gateway did not accept a card', {
          status: response.status,
        });
      return outcome;
    } catch (error) {
      logger.warn('agent-activity: gateway request failed', {
        error: errorMessage(error),
      });
      return 'retryable';
    }
  }

  function scheduleWake(at: number) {
    if (stopped) return;
    const wakes: number[] = [];
    for (const state of devices.values()) {
      if (state.retryAt !== undefined) wakes.push(state.retryAt);
      if (
        state.deliveredActive &&
        state.deliveredExpiresAt !== undefined &&
        state.retryAt === undefined
      )
        wakes.push(state.deliveredExpiresAt - REFRESH_BEFORE_EXPIRY_MS);
    }
    const next = wakes.length
      ? Math.max(Math.min(...wakes), at + 1)
      : undefined;
    if (next === timerAt) return;
    cancelTimer?.();
    cancelTimer = undefined;
    timerAt = next;
    if (next === undefined) return;
    cancelTimer = setTimer(() => {
      cancelTimer = undefined;
      timerAt = undefined;
      requestFlush();
    }, next - at);
  }

  async function deliver(
    deviceId: string,
    registration: NativePushRegistration,
    state: DeviceState,
    card: AgentActivityCard,
    key: PushSigningKey,
    at: number,
    updatedAt: number,
  ) {
    const pendingAlerts = card.alertables.filter(
      (entry) => !state.alerted.includes(entry.id),
    );
    const plaintext = composeAgentActivityPlaintext(
      card,
      agentActivityAlertFields(pendingAlerts),
      updatedAt,
    );
    const data: NativePushSealedData = {
      station_kind: 'agent_activity',
      device_id: registration.registrationId,
      sealed: sealAgentActivityCard({
        plaintext,
        payloadKey: registration.payloadKey,
        registrationId: registration.registrationId,
      }),
    };
    state.lastAttemptAt = at;
    const outcome = await send(
      JSON.stringify({
        token: registration.token,
        packageName: registration.packageName,
        data,
      }),
      key,
    );
    if (outcome === 'unregistered') {
      devices.delete(deviceId);
      try {
        devicePairing.clearNativePush(deviceId, registration.token);
      } catch (error) {
        logger.warn('agent-activity: failed to clear a dead registration', {
          error: errorMessage(error),
        });
      }
      return;
    }
    if (outcome === 'retryable') {
      state.failures += 1;
      delete state.retryAt;
      if (state.failures <= MAX_TIMED_RETRIES)
        state.retryAt =
          at +
          Math.min(RETRY_BASE_MS * 3 ** (state.failures - 1), RETRY_MAX_MS);
      return;
    }
    // Sent, or refused for good: either way this card is done with. A
    // refused card is not re-sent until the card itself changes.
    state.failures = 0;
    delete state.retryAt;
    state.cardKey = card.contentKey;
    state.alerted = [
      ...state.alerted,
      ...pendingAlerts.map((entry) => entry.id),
    ].slice(-ALERTED_MEMORY);
    state.deliveredActive = outcome === 'sent' && card.active;
    state.deliveredExpiresAt = card.expiresAt;
  }

  async function flush(): Promise<void> {
    const targets = registrations();
    if (targets.length === 0) {
      devices.clear();
      scheduleWake(now());
      return;
    }
    let key: PushSigningKey | null;
    try {
      key = options.signingKey.read();
      warned.delete('key');
    } catch {
      // Fail closed: nothing is sent, the routes answer 503, and this is
      // logged once rather than on every flush.
      warnOnce(
        'key',
        'agent-activity: the push signing key file is unreadable or unsafe; not sending',
      );
      return;
    }
    if (!key) {
      warnOnce('no-key', 'agent-activity: registrations exist but no push key');
      return;
    }
    const at = now();
    refreshSnapshots(await options.listSessions(), at);
    const card = buildAgentActivityCard({
      sessions: [...snapshots.values()],
      stationId: devicePairing.environmentId(),
      now: at,
    });
    const due: Array<() => Promise<void>> = [];
    let updatedAt: number | undefined;
    for (const { deviceId, registration } of targets) {
      if (registration.stationKey !== key.thumbprint) {
        // The phone pinned a key this Station no longer holds; it would drop
        // every card. Forget it; the phone re-registers on its next launch.
        warnOnce(
          `stale-key:${deviceId}`,
          'agent-activity: dropped a registration pinned to a previous push key',
        );
        devices.delete(deviceId);
        try {
          devicePairing.clearNativePush(deviceId, registration.token);
        } catch {}
        continue;
      }
      const state = stateFor(deviceId, registration);
      const changed =
        state.cardKey !== card.contentKey ||
        card.alertables.some((entry) => !state.alerted.includes(entry.id));
      const refresh =
        state.deliveredActive === true &&
        state.deliveredExpiresAt !== undefined &&
        state.deliveredExpiresAt - at <= REFRESH_BEFORE_EXPIRY_MS;
      if (!changed && !refresh) continue;
      if (state.retryAt !== undefined && at < state.retryAt) continue;
      if (
        state.lastAttemptAt !== undefined &&
        at - state.lastAttemptAt < MIN_SEND_INTERVAL_MS
      ) {
        // Coalesced into a send once the interval has passed.
        state.retryAt = state.lastAttemptAt + MIN_SEND_INTERVAL_MS;
        continue;
      }
      // Monotonic per Station: the phone drops an update older than the last.
      updatedAt ??= Math.max(at, lastUpdatedAt + 1);
      lastUpdatedAt = updatedAt;
      const stamp = updatedAt;
      due.push(() =>
        deliver(deviceId, registration, state, card, key, at, stamp),
      );
    }
    await Promise.all(due.map((run) => run()));
    for (const deviceId of [...devices.keys()])
      if (!targets.some((target) => target.deviceId === deviceId))
        devices.delete(deviceId);
    scheduleWake(now());
  }

  const worker = new KeyedCoalescingWorker<string, undefined>(() => flush(), {
    windowMs: options.windowMs ?? COALESCE_WINDOW_MS,
    onError: (error) =>
      logger.warn('agent-activity: card flush failed', {
        error: errorMessage(error),
      }),
  });

  function requestFlush() {
    if (stopped) return;
    try {
      worker.enqueue(CARD_KEY, undefined);
    } catch (error) {
      logger.warn('agent-activity: could not queue a card flush', {
        error: errorMessage(error),
      });
    }
  }

  const unsubscribe = options.eventBus.subscribe((message) => {
    try {
      if (message.event !== SERVER_EVENTS.ORCHESTRATION_EVENT) return;
      const method = (message.data?.event as { method?: unknown } | undefined)
        ?.method;
      if (typeof method !== 'string' || !CARD_RELEVANT_METHODS.has(method))
        return;
      if (registrations().length === 0) return;
      requestFlush();
    } catch (error) {
      logger.warn('agent-activity: listener failed', {
        error: errorMessage(error),
      });
    }
  });

  // Boot: phones registered before a restart get a current card (or have a
  // stale one cleared) without waiting for the next lifecycle event. Delayed
  // so session recovery can re-attach runtimes first.
  timerAt = now() + BOOT_FLUSH_DELAY_MS;
  cancelTimer = setTimer(() => {
    cancelTimer = undefined;
    timerAt = undefined;
    if (registrations().length > 0) requestFlush();
  }, BOOT_FLUSH_DELAY_MS);

  return {
    requestFlush,
    drain: () => worker.drain(),
    stop: async () => {
      stopped = true;
      cancelTimer?.();
      cancelTimer = undefined;
      unsubscribe();
      await worker.dispose();
    },
  };
}
