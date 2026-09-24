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
 *   the session read model per reading principal — each phone sees exactly
 *   the sessions its own paired device may read — builds that card, and
 *   seals it separately to each registered phone that has not received it;
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
 * errors — and 401, which can be transient — wait for the timer with
 * backoff; 400/413/422 are logged and the card is not retried.
 *
 * iOS phones get the same sealed card as a Live Activity instead of an FCM
 * data message: `live-activity-planner.ts` decides start, update or end, and
 * the requests go to `/v1/apns/live-activity`. The gateway creates one
 * broadcast channel per activity inside its start and answers the channel's
 * id and `channelAuth`, which every update and end carries; once an ended
 * activity's dismissal time has passed its channel is deleted through
 * `/v1/apns/channels` (queued in the registration file, so a restart still
 * deletes it). Coalescing, the per-phone send interval, backoff, alert
 * bookkeeping and the per-principal read are shared with Android. A 410
 * `unregistered` clears the registration; a 410 `channel-gone` or 403
 * `channel-unauthorized` forgets the activity, and the next flush starts a
 * new one.
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
import {
  buildApnsChannelDeleteRequest,
  buildLiveActivityGatewayRequest,
} from './apns-gateway-request.js';
import {
  type LiveActivityStep,
  liveActivityRolloverAt,
  planLiveActivity,
} from './live-activity-planner.js';
import {
  APNS_CHANNEL_AUTH_PATTERN,
  APNS_CHANNEL_ID_PATTERN,
  type NativePushAndroidRegistration,
  type NativePushChannelDelete,
  type NativePushIosRegistration,
  type NativePushLiveActivityRecord,
  type NativePushLiveActivityUpdate,
  type NativePushRegistration,
  newLiveActivityRunId,
} from './native-push-registration-store.js';
import type { PushSigningKey } from './push-signing-key-store.js';

const DEFAULT_PUSH_GATEWAY_URL = 'https://push.kontourai.io';
const SEND_PATH = '/v1/fcm/send';
const LIVE_ACTIVITY_PATH = '/v1/apns/live-activity';
const CHANNELS_PATH = '/v1/apns/channels';
/** Enough for the gateway's small JSON answers; anything longer is ignored. */
const MAX_ANSWER_CHARS = 4096;
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
/** Earliest re-check after a flush that could not reach the devices. */
const STALLED_FLUSH_RETRY_MS = 60_000;
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
  /** Absolute URL of the iOS Live Activity endpoint. */
  liveActivityUrl: string;
  /** Absolute URL of the iOS broadcast channel (deletion) endpoint. */
  channelsUrl: string;
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
    liveActivityUrl: new URL(LIVE_ACTIVITY_PATH, url.origin).toString(),
    channelsUrl: new URL(CHANNELS_PATH, url.origin).toString(),
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

/** Events the lifecycle fold turns into `completed` (session-lifecycle-service.ts). */
function endsCompleted(event: CanonicalRuntimeEvent): boolean {
  if (event.method === 'turn.completed')
    return event.finishReason !== 'cancelled';
  if (event.method === 'session.exited') return event.exitCode === 0;
  if (event.method === 'session.state-changed')
    return event.to === 'completed' || event.sessionState === 'completed';
  return false;
}

/** Events the lifecycle fold turns into `failed`. */
function endsFailed(event: CanonicalRuntimeEvent): boolean {
  if (event.method === 'runtime.error') return true;
  if (event.method === 'session.exited')
    return event.exitCode !== undefined && event.exitCode !== 0;
  if (event.method === 'session.state-changed')
    return event.to === 'errored' || event.sessionState === 'failed';
  return false;
}

/**
 * Which entry into `phase` the session is in, from its lifecycle event log
 * (the same projection events the read model folds): the open request for a
 * waiting session, the turn for a live one, the terminal event for a
 * finished one. Two approvals on one session are two entries, even when
 * nothing observed the session between them.
 */
function phaseEntryFromEvents(
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
  } else if (phase === 'completed' || phase === 'failed') {
    // Only a terminal event of THIS run counts: one that predates the latest
    // turn.started belongs to an earlier outcome, and reusing it would both
    // repeat that outcome's alert id and date this one outside the window.
    const turnStarted = latestOf(events, ['turn.started']);
    const since = turnStarted ? Date.parse(turnStarted.createdAt) : -Infinity;
    event = latestOf(
      events.filter(
        (candidate) =>
          Date.parse(candidate.createdAt) >= since &&
          (phase === 'completed'
            ? endsCompleted(candidate)
            : endsFailed(candidate)),
      ),
      [
        'turn.completed',
        'runtime.error',
        'session.exited',
        'session.state-changed',
      ],
    );
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
  recordNativePushAlerts(
    deviceId: string,
    registrationId: string,
    alertIds: readonly string[],
  ): void;
  /** Persists an iOS registration's activity and queued channel deletions. */
  updateNativePushLiveActivity(
    deviceId: string,
    registrationId: string,
    update: NativePushLiveActivityUpdate,
  ): unknown;
  environmentId(): string;
}

interface AgentActivityLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

type Cancel = () => void;

export interface AgentActivitySessionReader {
  principalId: string;
  listSessions(): Promise<AgentActivitySessionRow[]>;
}

export interface AgentActivityPublisherOptions {
  eventBus: EventBus;
  devicePairing: AgentActivityDevicePairing;
  signingKey: { read(): PushSigningKey | null };
  /**
   * Who a registered device reads as, and how to read the sessions it may
   * see — the same read authority that device's own requests carry. Null
   * when the device is no longer a readable paired device. Devices resolving
   * to the same principal share one read per flush.
   */
  sessionReaderFor: (deviceId: string) => AgentActivitySessionReader | null;
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
/**
 * iOS adds `channel-gone`: the activity's broadcast channel no longer exists,
 * or the gateway no longer accepts its `channelAuth`.
 */
type ApnsOutcome = SendOutcome | 'channel-gone';
/** complete: every phone examined; partial: some principals' reads failed; stalled: nothing examined. */
type FlushOutcome = 'complete' | 'partial' | 'stalled';

function classify(status: number): SendOutcome {
  if (status >= 200 && status < 300) return 'sent';
  if (status === 410) return 'unregistered';
  // 401 can be transient (clock skew, a key the gateway has not seen yet):
  // retried on the timer like 429/5xx, and bounded the same way.
  if (status === 401 || status === 429 || status >= 500) return 'retryable';
  return 'rejected';
}

/**
 * A 410 from an iOS route says which thing is gone in its body. One that
 * says neither is retried with backoff rather than guessed at: guessing
 * `unregistered` would erase a registration, guessing `channel-gone` would
 * start activities (and so create channels). A 403 `channel-unauthorized` is
 * a channel this Station can no longer address: handled as gone.
 */
function classifyApns(status: number, answer: unknown): ApnsOutcome {
  const result = (answer as { result?: unknown } | null)?.result;
  if (status === 403 && result === 'channel-unauthorized')
    return 'channel-gone';
  if (status !== 410) return classify(status);
  if (result === 'unregistered') return 'unregistered';
  if (result === 'channel-gone') return 'channel-gone';
  return 'retryable';
}

type ChannelToDelete = Omit<NativePushChannelDelete, 'deleteAt'>;

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
  /** iOS: the last Live Activity `timestamp` (s); strictly increasing. */
  lastTimestamp?: number;
  /** iOS: when the stored activity started, for its rollover wake. */
  activityStartedAt?: number;
  /** iOS: every channel to delete if the registration disappears. */
  channels?: ChannelToDelete[];
  /** iOS: the earliest queued channel deletion still waiting. */
  nextDeleteAt?: number;
  deleteFailures?: number;
  deleteRetryAt?: number;
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

  /** Per reading principal: what that principal's sessions were last seen as. */
  const snapshotsByPrincipal = new Map<
    string,
    Map<string, AgentActivitySnapshot>
  >();
  const devices = new Map<string, DeviceState>();
  const warned = new Set<string>();
  let lastUpdatedAt = 0;
  let stopped = false;
  let cancelTimer: Cancel | undefined;
  /** Set when a flush could not examine something: look again then. */
  let stalledWakeAt: number | undefined;
  let timerAt: number | undefined;

  function warnOnce(key: string, message: string) {
    if (warned.has(key)) return;
    warned.add(key);
    logger.warn(message);
  }

  /**
   * The registrations, or null when they could not be read. A failed read is
   * not "nobody is registered": it must not discard per-device delivery
   * state.
   */
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
      return null;
    }
  }

  function refreshSnapshots(
    snapshots: Map<string, AgentActivitySnapshot>,
    rows: AgentActivitySessionRow[],
    at: number,
  ) {
    const seen = new Set<string>();
    for (const row of rows) {
      const phase = agentActivityPhaseFor(row);
      if (!phase) continue;
      seen.add(row.sessionId);
      const previous = snapshots.get(row.sessionId);
      let enteredAt: number;
      let entryKey: string;
      // An entry event older than the phase this publisher already saw the
      // session leave for is stale evidence, the same rule phaseEntryTime
      // applies to the fallback time.
      const staleEntry =
        row.entry !== undefined &&
        previous !== undefined &&
        previous.phase !== phase &&
        row.entry.at < previous.enteredAt;
      if (row.entry && !staleEntry) {
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

  function alreadyAlerted(
    registration: NativePushRegistration,
    state: DeviceState,
  ): Set<string> {
    return new Set([...(registration.alerted ?? []), ...state.alerted]);
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
      // Per registration: a token rotation keeps the registrationId, and
      // the phone orders by this whatever token delivered it.
      ...(current?.lastTimestamp !== undefined &&
      current.registrationId === registration.registrationId
        ? { lastTimestamp: current.lastTimestamp }
        : {}),
    };
    devices.set(deviceId, fresh);
    return fresh;
  }

  async function send(body: string, key: PushSigningKey): Promise<SendOutcome> {
    const bytes = Buffer.from(body, 'utf8');
    try {
      const response = await post(options.gateway.sendUrl, bytes, key);
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

  /** One signed request to the gateway. Throws on a network failure. */
  function post(url: string, bytes: Buffer, key: PushSigningKey) {
    const authorization = `Station ${key.signRequest(bytes, {
      audience: options.gateway.audience,
      nowMs: now(),
    })}`;
    return fetchImpl(url, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: bytes,
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  /** An iOS gateway request: its outcome and (small) JSON answer. */
  async function sendApns(
    url: string,
    body: object,
    key: PushSigningKey,
  ): Promise<{ outcome: ApnsOutcome; answer: unknown }> {
    try {
      const response = await post(
        url,
        Buffer.from(JSON.stringify(body), 'utf8'),
        key,
      );
      const text = await response.text().catch(() => '');
      let answer: unknown = null;
      if (text.length <= MAX_ANSWER_CHARS)
        try {
          answer = JSON.parse(text);
        } catch {}
      const outcome = classifyApns(response.status, answer);
      if (outcome !== 'sent')
        logger.warn('agent-activity: gateway did not accept a live activity', {
          status: response.status,
        });
      return { outcome, answer };
    } catch (error) {
      logger.warn('agent-activity: gateway request failed', {
        error: errorMessage(error),
      });
      return { outcome: 'retryable', answer: null };
    }
  }

  /**
   * Best effort: a channel nobody will use again counts against the app's
   * quota. Done when deleted, already gone, or refused for good.
   */
  async function deleteChannel(
    channel: ChannelToDelete,
    key: PushSigningKey,
  ): Promise<'done' | 'retry'> {
    const { outcome } = await sendApns(
      options.gateway.channelsUrl,
      buildApnsChannelDeleteRequest(channel),
      key,
    );
    return outcome === 'retryable' ? 'retry' : 'done';
  }

  /**
   * Deletes the phone's queued channels whose dismissal time has passed,
   * oldest first, stopping at the first that must be retried (with its own
   * backoff, so a failing delete never holds back the phone's cards).
   */
  async function drainChannelDeletes(
    deviceId: string,
    registration: NativePushIosRegistration,
    state: DeviceState,
    key: PushSigningKey,
    at: number,
  ) {
    let queued = [...(registration.channelDeletes ?? [])];
    if (state.deleteRetryAt === undefined || at >= state.deleteRetryAt)
      for (const entry of queued.filter(
        (candidate) => candidate.deleteAt <= at,
      )) {
        const { deleteAt: _deleteAt, ...channel } = entry;
        const result = await deleteChannel(channel, key);
        if (result === 'retry') {
          state.deleteFailures = (state.deleteFailures ?? 0) + 1;
          if (state.deleteFailures <= MAX_TIMED_RETRIES) {
            state.deleteRetryAt =
              at +
              Math.min(
                RETRY_BASE_MS * 3 ** (state.deleteFailures - 1),
                RETRY_MAX_MS,
              );
            break;
          }
          // Bounded effort: give this channel up rather than retry forever.
          logger.warn(
            'agent-activity: gave up deleting a live activity channel',
          );
        }
        state.deleteFailures = 0;
        delete state.deleteRetryAt;
        persistLiveActivity(deviceId, registration.registrationId, {
          dropChannelDelete: entry.channelId,
        });
        queued = queued.filter((candidate) => candidate !== entry);
      }
    const activity = registration.activity;
    state.channels = [
      ...(activity
        ? [
            {
              bundleId: registration.packageName,
              environment: registration.apnsEnvironment,
              channelId: activity.channelId,
              channelAuth: activity.channelAuth,
            },
          ]
        : []),
      ...queued.map(({ deleteAt: _deleteAt, ...channel }) => channel),
    ];
    if (queued.length > 0)
      state.nextDeleteAt = Math.min(...queued.map((entry) => entry.deleteAt));
    else delete state.nextDeleteAt;
  }

  function scheduleWake(at: number, floorMs = 1) {
    if (stopped) return;
    const wakes: number[] = [];
    // Independent of any device state: even a first flush that could read
    // nothing is looked at again.
    if (stalledWakeAt !== undefined) wakes.push(stalledWakeAt);
    for (const state of devices.values()) {
      if (state.retryAt !== undefined) wakes.push(state.retryAt);
      if (
        state.deliveredActive &&
        state.deliveredExpiresAt !== undefined &&
        state.retryAt === undefined
      )
        wakes.push(state.deliveredExpiresAt - REFRESH_BEFORE_EXPIRY_MS);
      // A live activity is rolled over before Apple's 8 h cap even when
      // nothing on it changes.
      if (
        state.deliveredActive &&
        state.activityStartedAt !== undefined &&
        state.retryAt === undefined
      )
        wakes.push(liveActivityRolloverAt(state.activityStartedAt));
      if (state.nextDeleteAt !== undefined)
        wakes.push(Math.max(state.nextDeleteAt, state.deleteRetryAt ?? 0));
    }
    const next = wakes.length
      ? Math.max(Math.min(...wakes), at + floorMs)
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

  function backOff(state: DeviceState, at: number) {
    state.failures += 1;
    delete state.retryAt;
    if (state.failures <= MAX_TIMED_RETRIES)
      state.retryAt =
        at + Math.min(RETRY_BASE_MS * 3 ** (state.failures - 1), RETRY_MAX_MS);
  }

  /** Durable, so a restart or token rotation cannot re-raise a group. */
  function recordAlerts(
    deviceId: string,
    registrationId: string,
    state: DeviceState,
    alertIds: string[],
  ) {
    state.alerted = [...state.alerted, ...alertIds].slice(-ALERTED_MEMORY);
    if (alertIds.length === 0) return;
    try {
      devicePairing.recordNativePushAlerts(deviceId, registrationId, alertIds);
    } catch (error) {
      logger.warn('agent-activity: could not record delivered alerts', {
        error: errorMessage(error),
      });
    }
  }

  function clearDeadRegistration(
    deviceId: string,
    registration: NativePushRegistration,
  ) {
    devices.delete(deviceId);
    try {
      devicePairing.clearNativePush(deviceId, registration.token);
    } catch (error) {
      logger.warn('agent-activity: failed to clear a dead registration', {
        error: errorMessage(error),
      });
    }
  }

  function persistLiveActivity(
    deviceId: string,
    registrationId: string,
    update: NativePushLiveActivityUpdate,
  ) {
    try {
      devicePairing.updateNativePushLiveActivity(
        deviceId,
        registrationId,
        update,
      );
    } catch (error) {
      logger.warn('agent-activity: could not record a live activity', {
        error: errorMessage(error),
      });
    }
  }

  /** `timestamp` for the next iOS request: seconds, strictly increasing. */
  function nextTimestamp(state: DeviceState, at: number): number {
    const timestamp = Math.max(
      Math.ceil(at / 1000),
      (state.lastTimestamp ?? 0) + 1,
    );
    state.lastTimestamp = timestamp;
    return timestamp;
  }

  function sealFor(
    registration: NativePushRegistration,
    card: AgentActivityCard,
    pendingAlerts: AgentActivityCard['alertables'],
    updatedAt: number,
  ) {
    return sealAgentActivityCard({
      plaintext: composeAgentActivityPlaintext(
        card,
        agentActivityAlertFields(pendingAlerts),
        updatedAt,
      ),
      payloadKey: registration.payloadKey,
      registrationId: registration.registrationId,
    });
  }

  /** A `channelAuth` from a gateway answer, when it carries a valid one. */
  function answeredChannelAuth(answer: unknown): string | undefined {
    const value = (answer as { channelAuth?: unknown } | null)?.channelAuth;
    return typeof value === 'string' && APNS_CHANNEL_AUTH_PATTERN.test(value)
      ? value
      : undefined;
  }

  /**
   * Runs the planned steps for one iOS phone, in order, stopping at the
   * first that fails. What each accepted step changes (the activity and its
   * channel, a channel to delete) is persisted as it happens, so a restart
   * resumes rather than repeats.
   */
  async function deliverIos(
    deviceId: string,
    registration: NativePushIosRegistration,
    state: DeviceState,
    card: AgentActivityCard,
    steps: LiveActivityStep[],
    pendingAlerts: AgentActivityCard['alertables'],
    key: PushSigningKey,
    at: number,
    updatedAt: number,
  ) {
    state.lastAttemptAt = at;
    const topic = {
      bundleId: registration.packageName,
      environment: registration.apnsEnvironment,
    };
    const { registrationId } = registration;
    const sealed = sealFor(registration, card, pendingAlerts, updatedAt);
    let activity: NativePushLiveActivityRecord | undefined =
      registration.activity;
    let alerted = false;
    const forgetActivity = () => {
      // Its channel is gone or no longer ours: nothing to delete. The next
      // flush starts a new activity (and with it a new channel).
      if (activity)
        persistLiveActivity(deviceId, registrationId, {
          activity: null,
          expectedRunId: activity.runId,
        });
      activity = undefined;
      delete state.cardKey;
      delete state.activityStartedAt;
      state.deliveredActive = false;
    };
    for (const step of steps) {
      const timestamp = nextTimestamp(state, at);
      const routed = { registrationId, sealed, alert: step.alert, timestamp };
      let body: ReturnType<typeof buildLiveActivityGatewayRequest>;
      if (step.event === 'start') {
        // No channel: the gateway creates the activity's channel itself.
        body = buildLiveActivityGatewayRequest({
          ...topic,
          event: 'start',
          pushToStartToken: registration.token,
          ...routed,
          staleAt: Math.floor(step.staleAtMs / 1000),
        });
      } else {
        if (!activity) break;
        const channel = {
          channelId: activity.channelId,
          channelAuth: activity.channelAuth,
        };
        body =
          step.event === 'update'
            ? buildLiveActivityGatewayRequest({
                ...topic,
                event: 'update',
                ...channel,
                ...routed,
                staleAt: Math.floor(step.staleAtMs / 1000),
              })
            : buildLiveActivityGatewayRequest({
                ...topic,
                event: 'end',
                ...channel,
                ...routed,
                // Never before this request's own timestamp.
                dismissAt: Math.max(
                  timestamp,
                  Math.floor(step.dismissAtMs / 1000),
                ),
              });
      }
      const { outcome, answer } = await sendApns(
        options.gateway.liveActivityUrl,
        body,
        key,
      );
      if (outcome === 'unregistered') {
        // At a start the gateway has already deleted the channel it made.
        // Anywhere else the activity's channel is deleted now, best effort.
        const stranded = activity
          ? {
              ...topic,
              channelId: activity.channelId,
              channelAuth: activity.channelAuth,
            }
          : undefined;
        clearDeadRegistration(deviceId, registration);
        if (stranded && step.event !== 'start')
          await deleteChannel(stranded, key);
        return;
      }
      if (outcome === 'channel-gone' && step.event !== 'start') {
        forgetActivity();
        backOff(state, at);
        return;
      }
      if (outcome !== 'sent' && outcome !== 'rejected') {
        backOff(state, at);
        return;
      }
      alerted ||= step.alert;
      if (step.event === 'start' && outcome === 'sent') {
        const channelId = (answer as { channelId?: unknown } | null)?.channelId;
        const channelAuth = answeredChannelAuth(answer);
        if (
          typeof channelId === 'string' &&
          APNS_CHANNEL_ID_PATTERN.test(channelId) &&
          channelAuth
        ) {
          activity = {
            startedAt: at,
            runId: newLiveActivityRunId(),
            channelId,
            channelAuth,
          };
          persistLiveActivity(deviceId, registrationId, { activity });
        } else {
          logger.warn(
            'agent-activity: the gateway started a live activity without naming its channel',
          );
        }
      }
      if (step.event === 'update' && outcome === 'sent' && activity) {
        // The gateway rotated its channel secret: keep the fresh proof.
        const rotated = answeredChannelAuth(answer);
        if (rotated && rotated !== activity.channelAuth) {
          const previous = activity.runId;
          activity = { ...activity, channelAuth: rotated };
          persistLiveActivity(deviceId, registrationId, {
            activity,
            expectedRunId: previous,
          });
        }
      }
      if (step.event === 'end' && activity && body.event === 'end') {
        // A refused end is not repeated either: the activity goes stale.
        // Either way its channel is deleted once the dismissal has passed.
        const channelAuth = answeredChannelAuth(answer) ?? activity.channelAuth;
        const queued: NativePushChannelDelete = {
          ...topic,
          channelId: activity.channelId,
          channelAuth,
          deleteAt: body.dismissAt * 1000,
        };
        persistLiveActivity(deviceId, registrationId, {
          activity: null,
          expectedRunId: activity.runId,
          queueChannelDelete: queued,
        });
        activity = undefined;
      }
    }
    // Every step taken (or refused for good): this card is done with.
    state.failures = 0;
    delete state.retryAt;
    state.cardKey = card.contentKey;
    recordAlerts(
      deviceId,
      registrationId,
      state,
      alerted ? pendingAlerts.map((entry) => entry.id) : [],
    );
    state.deliveredActive = activity !== undefined && card.active;
    state.deliveredExpiresAt = card.expiresAt;
    if (activity) state.activityStartedAt = activity.startedAt;
    else delete state.activityStartedAt;
  }

  async function deliver(
    deviceId: string,
    registration: NativePushAndroidRegistration,
    state: DeviceState,
    card: AgentActivityCard,
    key: PushSigningKey,
    at: number,
    updatedAt: number,
  ) {
    const pendingAlerts = card.alertables.filter(
      (entry) => !alreadyAlerted(registration, state).has(entry.id),
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
    const alertIds = pendingAlerts.map((entry) => entry.id);
    state.alerted = [...state.alerted, ...alertIds].slice(-ALERTED_MEMORY);
    if (alertIds.length > 0) {
      // Durable, so a restart or token rotation cannot re-raise a group.
      try {
        devicePairing.recordNativePushAlerts(
          deviceId,
          registration.registrationId,
          alertIds,
        );
      } catch (error) {
        logger.warn('agent-activity: could not record delivered alerts', {
          error: errorMessage(error),
        });
      }
    }
    state.deliveredActive = outcome === 'sent' && card.active;
    state.deliveredExpiresAt = card.expiresAt;
  }

  async function flush(): Promise<void> {
    let outcome: FlushOutcome = 'stalled';
    try {
      outcome = await flushOnce();
    } finally {
      // Always re-arm, even when a read threw: a live card's refresh must
      // not be lost to one failed read. A flush that could not examine the
      // devices at all waits at least a minute for everything — any wake
      // already due would otherwise fire again at once and spin; a failure
      // confined to some principals has already pushed their phones' wakes
      // out by the same minute.
      const at = now();
      stalledWakeAt =
        outcome === 'complete' ? undefined : at + STALLED_FLUSH_RETRY_MS;
      scheduleWake(at, outcome === 'stalled' ? STALLED_FLUSH_RETRY_MS : 1);
    }
  }

  /**
   * Phones this publisher was tracking that are no longer registered: their
   * channels are deleted (best effort) and their state dropped.
   */
  async function forgetUnregistered(
    targets: ReadonlyArray<{ deviceId: string }>,
    key: PushSigningKey | null,
  ) {
    const orphans: ChannelToDelete[] = [];
    for (const [deviceId, state] of [...devices])
      if (!targets.some((target) => target.deviceId === deviceId)) {
        devices.delete(deviceId);
        orphans.push(...(state.channels ?? []));
      }
    if (key)
      await Promise.all(orphans.map((channel) => deleteChannel(channel, key)));
  }

  /**
   * After this flush's cards: every iOS phone's due channel deletions, read
   * afresh (the cards may just have queued some), whether or not the phone
   * had a card to send.
   */
  async function drainAllChannelDeletes(key: PushSigningKey, at: number) {
    const current = registrations() ?? [];
    await Promise.all(
      current.map(async ({ deviceId, registration }) => {
        if (
          registration.platform !== 'ios' ||
          registration.stationKey !== key.thumbprint
        )
          return;
        const state = stateFor(deviceId, registration);
        await drainChannelDeletes(deviceId, registration, state, key, at);
      }),
    );
  }

  function readKeyQuietly(): PushSigningKey | null {
    try {
      return options.signingKey.read();
    } catch {
      return null;
    }
  }

  async function flushOnce(): Promise<FlushOutcome> {
    const targets = registrations();
    if (targets === null) return 'stalled';
    if (targets.length === 0) {
      const tracked = [...devices.values()].some(
        (state) => (state.channels?.length ?? 0) > 0,
      );
      await forgetUnregistered(targets, tracked ? readKeyQuietly() : null);
      return 'complete';
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
      return 'stalled';
    }
    if (!key) {
      warnOnce('no-key', 'agent-activity: registrations exist but no push key');
      return 'stalled';
    }
    const at = now();
    const stationId = devicePairing.environmentId();
    // One card per reading principal: a phone's card holds exactly the
    // sessions its own device may read. Devices sharing a principal share
    // the read.
    const cards = new Map<string, AgentActivityCard>();
    const principalOf = new Map<string, string>();
    const failedPrincipals = new Set<string>();
    // Devices whose reader could not even be built: isolated like a failed
    // read, so one bad device record never stalls every other phone.
    const failedDevices = new Set<string>();
    for (const { deviceId, registration } of targets) {
      if (registration.stationKey !== key.thumbprint) continue;
      let reader: AgentActivitySessionReader | null;
      try {
        reader = options.sessionReaderFor(deviceId);
      } catch (error) {
        failedDevices.add(deviceId);
        if (!warned.has(`reader:${deviceId}`)) {
          warned.add(`reader:${deviceId}`);
          logger.warn('agent-activity: could not resolve a device reader', {
            error: errorMessage(error),
          });
        }
        continue;
      }
      warned.delete(`reader:${deviceId}`);
      if (!reader) continue;
      principalOf.set(deviceId, reader.principalId);
      if (
        cards.has(reader.principalId) ||
        failedPrincipals.has(reader.principalId)
      )
        continue;
      let rows: AgentActivitySessionRow[];
      try {
        rows = await reader.listSessions();
      } catch (error) {
        // Isolated: only this principal's phones wait for the retry.
        failedPrincipals.add(reader.principalId);
        // Once per failure spell, not on every retry.
        if (!warned.has(`read:${reader.principalId}`)) {
          warned.add(`read:${reader.principalId}`);
          logger.warn('agent-activity: session read failed', {
            error: errorMessage(error),
          });
        }
        continue;
      }
      warned.delete(`read:${reader.principalId}`);
      let snapshots = snapshotsByPrincipal.get(reader.principalId);
      if (!snapshots) {
        snapshots = new Map();
        snapshotsByPrincipal.set(reader.principalId, snapshots);
      }
      refreshSnapshots(snapshots, rows, at);
      cards.set(
        reader.principalId,
        buildAgentActivityCard({
          sessions: [...snapshots.values()],
          stationId,
          now: at,
        }),
      );
    }
    for (const principalId of [...snapshotsByPrincipal.keys()])
      if (!cards.has(principalId) && !failedPrincipals.has(principalId))
        snapshotsByPrincipal.delete(principalId);
    // What a phone that may no longer read is sent, once: an empty card,
    // which clears the last one instead of leaving it until it expires.
    const retiredCard = buildAgentActivityCard({
      sessions: [],
      stationId,
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
        const channels = devices.get(deviceId)?.channels ?? [];
        devices.delete(deviceId);
        try {
          devicePairing.clearNativePush(deviceId, registration.token);
        } catch {}
        for (const channel of channels)
          due.push(async () => {
            await deleteChannel(channel, key);
          });
        continue;
      }
      const principalId = principalOf.get(deviceId);
      if (
        failedDevices.has(deviceId) ||
        (principalId !== undefined && failedPrincipals.has(principalId))
      ) {
        // Its read failed: nothing about this phone is known this time. Try
        // it again with the stalled-read retry, not at once — but never
        // sooner than a longer backoff it already has, and never revive
        // timed retries it has used up.
        const waiting = devices.get(deviceId);
        if (waiting && waiting.failures <= MAX_TIMED_RETRIES) {
          waiting.retryAt = Math.max(
            waiting.retryAt ?? 0,
            at + STALLED_FLUSH_RETRY_MS,
          );
        }
        continue;
      }
      let card = principalId ? cards.get(principalId) : undefined;
      const readable = card !== undefined;
      if (!card) {
        // Not (or no longer) a device that may read sessions. A phone that
        // was shown a card gets one final empty card; nothing after that.
        // An iPhone whose activity is still up (even from before a restart)
        // has it ended at once.
        warnOnce(
          `unreadable:${deviceId}`,
          'agent-activity: a registered device may not read sessions; sending it no activity',
        );
        const previous = devices.get(deviceId);
        const liveActivity =
          registration.platform === 'ios' &&
          registration.activity !== undefined;
        if (previous?.cardKey === undefined && !liveActivity) {
          devices.delete(deviceId);
          continue;
        }
        card = retiredCard;
      }
      const state = stateFor(deviceId, registration);
      const alerted = alreadyAlerted(registration, state);
      const pendingAlerts = card.alertables.filter(
        (entry) => !alerted.has(entry.id),
      );
      let steps: LiveActivityStep[] | undefined;
      let pending: boolean;
      if (registration.platform === 'ios') {
        if (registration.activity)
          state.activityStartedAt = registration.activity.startedAt;
        else delete state.activityStartedAt;
        steps = planLiveActivity({
          now: at,
          ...(registration.activity ? { activity: registration.activity } : {}),
          card,
          readable,
          ...(state.cardKey !== undefined &&
          state.deliveredExpiresAt !== undefined
            ? {
                lastSent: {
                  contentKey: state.cardKey,
                  expiresAt: state.deliveredExpiresAt,
                },
              }
            : {}),
          pendingAlert: pendingAlerts.length > 0,
        });
        pending = steps.length > 0;
        if (!pending) {
          // Nothing to show (no activity for a finished card): its alerts
          // are old news by the time an activity could start.
          state.cardKey = card.contentKey;
          state.alerted = [
            ...state.alerted,
            ...pendingAlerts.map((entry) => entry.id),
          ].slice(-ALERTED_MEMORY);
        }
      } else {
        const changed =
          state.cardKey !== card.contentKey || pendingAlerts.length > 0;
        const refresh =
          state.deliveredActive === true &&
          state.deliveredExpiresAt !== undefined &&
          state.deliveredExpiresAt - at <= REFRESH_BEFORE_EXPIRY_MS;
        pending = changed || refresh;
      }
      if (!pending) {
        // Nothing is pending for this phone (a change inside the send
        // interval may have reverted): nothing to retry, so no timer.
        delete state.retryAt;
        state.failures = 0;
        continue;
      }
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
      const planned = card;
      if (registration.platform === 'ios' && steps)
        due.push(() =>
          deliverIos(
            deviceId,
            registration,
            state,
            planned,
            steps,
            pendingAlerts,
            key,
            at,
            stamp,
          ),
        );
      else if (registration.platform === 'android')
        due.push(() =>
          deliver(deviceId, registration, state, planned, key, at, stamp),
        );
    }
    await Promise.all(due.map((run) => run()));
    await drainAllChannelDeletes(key, now());
    await forgetUnregistered(targets, key);
    return failedPrincipals.size > 0 ? 'partial' : 'complete';
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
      if (!registrations()?.length) return;
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
    if (registrations()?.length) requestFlush();
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
