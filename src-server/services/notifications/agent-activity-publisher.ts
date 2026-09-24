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
 *   the session read model, folds it into per-session snapshots, builds the
 *   card, and sends it to each registered device whose last delivered card
 *   differs;
 * - never throws into the bus (event-bus.ts keeps a throwing listener but
 *   warns on every emit) and never blocks it: all work is asynchronous and
 *   every failure is caught and logged without the token or payload.
 *
 * Gateway answers: 200 sent; 410 the token is dead — clear that device's
 * registration (only if it still holds that token); 503/429/network errors
 * are retried a bounded number of times; everything else (401 auth, 400/413/
 * 422 rejected) is logged and not retried.
 */
import type { OrchestrationSessionSummary } from '@kontourai/station-contracts/orchestration';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { errorMessage } from '../../utils/error-message.js';
import { KeyedCoalescingWorker } from '../infra/keyed-coalescing-worker.js';
import type { EventBus } from '../orchestration/event-bus.js';
import type { StoredNativePush } from '../ssh/device-pairing-service.js';
import {
  type AgentActivitySessionFacts,
  type AgentActivitySnapshot,
  agentActivityPhaseFor,
  buildAgentActivityCard,
} from './agent-activity-card.js';
import type { PushSigningKey } from './push-signing-key-store.js';

const DEFAULT_PUSH_GATEWAY_URL = 'https://push.kontourai.io';
const SEND_PATH = '/v1/fcm/send';
const COALESCE_WINDOW_MS = 1_000;
const REQUEST_TIMEOUT_MS = 10_000;
/** Waits between attempts: three attempts in all. */
const DEFAULT_RETRY_DELAYS_MS = [1_000, 4_000] as const;
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
 * `STATION_PUSH_GATEWAY_URL` (default the Kontour gateway). Only https is
 * accepted: the request carries the phone's FCM token. Returns null for an
 * invalid value, which disables publishing rather than sending elsewhere.
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
  if (url.protocol !== 'https:' || url.username || url.password) return null;
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
  /** ISO time of the session's latest event, used as a state's entry time. */
  lastEventAt?: string;
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

export interface AgentActivityDevicePairing {
  listNativePushRegistrations(): Array<{
    deviceId: string;
    registration: StoredNativePush;
  }>;
  clearNativePush(deviceId: string, expectedToken?: string): unknown;
  environmentId(): string;
}

interface AgentActivityLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface AgentActivityPublisherOptions {
  eventBus: EventBus;
  devicePairing: AgentActivityDevicePairing;
  signingKey: { read(): PushSigningKey | null };
  listSessions: () => Promise<AgentActivitySessionRow[]>;
  gateway: PushGatewayConfig;
  logger: AgentActivityLogger;
  /** Hosted mode: do not even subscribe. */
  enabled?: boolean;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  windowMs?: number;
  retryDelaysMs?: readonly number[];
}

export interface AgentActivityPublisher {
  /** Rebuild and send the card now (e.g. a phone just registered). */
  requestFlush(): void;
  /** Resolves once every queued or in-flight flush has finished. */
  drain(): Promise<void>;
  stop(): Promise<void>;
}

type SendOutcome =
  | 'sent'
  | 'unregistered'
  | 'retryable'
  | 'rejected'
  | 'auth_error';

function classify(status: number): SendOutcome {
  if (status >= 200 && status < 300) return 'sent';
  if (status === 410) return 'unregistered';
  if (status === 429 || status === 503 || status === 502 || status === 504)
    return 'retryable';
  if (status === 401) return 'auth_error';
  return 'rejected';
}

/**
 * When a session entered the phase it was just observed in. The latest event
 * is what moved it there; fall back to the observation time when that time is
 * missing, in the future, or older than the phase already known.
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

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });

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
  const sleep = options.sleep ?? defaultSleep;
  const retryDelays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const { logger, devicePairing } = options;

  const snapshots = new Map<string, AgentActivitySnapshot>();
  /**
   * Last card each device acknowledged, keyed by device id. The token and
   * registrationId are part of the identity: a re-registered phone (new
   * token, or a new registrationId after unregistering) has seen nothing.
   */
  const delivered = new Map<
    string,
    { token: string; registrationId: string; contentKey: string }
  >();
  let lastUpdatedAt = 0;
  let stopped = false;

  function registrations() {
    try {
      return devicePairing.listNativePushRegistrations();
    } catch (error) {
      logger.warn('agent-activity: failed to list registrations', {
        error: errorMessage(error),
      });
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
      const enteredAt =
        previous?.phase === phase
          ? previous.enteredAt
          : phaseEntryTime(row.lastEventAt, previous?.enteredAt, at);
      snapshots.set(row.sessionId, {
        sessionId: row.sessionId,
        title: row.title ?? '',
        project: row.project ?? '',
        phase,
        enteredAt,
      });
    }
    for (const sessionId of [...snapshots.keys()])
      if (!seen.has(sessionId)) snapshots.delete(sessionId);
  }

  async function send(
    body: Uint8Array,
    key: PushSigningKey,
  ): Promise<SendOutcome> {
    for (let attempt = 0; ; attempt += 1) {
      let outcome: SendOutcome;
      try {
        const authorization = `Station ${key.signRequest(body, {
          audience: options.gateway.audience,
          nowMs: now(),
        })}`;
        const response = await fetchImpl(options.gateway.sendUrl, {
          method: 'POST',
          headers: {
            authorization,
            'content-type': 'application/json',
          },
          body: Buffer.from(body),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        // Drain so the connection can be reused; the body is never needed.
        await response.arrayBuffer().catch(() => undefined);
        outcome = classify(response.status);
        if (outcome !== 'sent' && outcome !== 'retryable')
          logger.warn('agent-activity: gateway refused a card', {
            status: response.status,
          });
      } catch (error) {
        outcome = 'retryable';
        logger.warn('agent-activity: gateway request failed', {
          error: errorMessage(error),
        });
      }
      if (outcome !== 'retryable') return outcome;
      const delay = retryDelays[attempt];
      if (delay === undefined || stopped) return outcome;
      await sleep(delay);
    }
  }

  async function flush(): Promise<void> {
    const targets = registrations();
    if (targets.length === 0) {
      delivered.clear();
      return;
    }
    const key = options.signingKey.read();
    if (!key) {
      logger.warn('agent-activity: registrations exist but no push key');
      return;
    }
    const at = now();
    refreshSnapshots(await options.listSessions(), at);
    const stationId = devicePairing.environmentId();
    const card = buildAgentActivityCard({
      sessions: [...snapshots.values()],
      stationId,
      now: at,
    });
    const pending = targets.filter(({ deviceId, registration }) => {
      const last = delivered.get(deviceId);
      return (
        last?.token !== registration.token ||
        last.registrationId !== registration.registrationId ||
        last.contentKey !== card.contentKey
      );
    });
    if (pending.length === 0) return;
    // Monotonic per Station: the phone drops an update older than the last.
    const updatedAt = Math.max(at, lastUpdatedAt + 1);
    lastUpdatedAt = updatedAt;
    await Promise.all(
      pending.map(async ({ deviceId, registration }) => {
        const body = new TextEncoder().encode(
          JSON.stringify({
            token: registration.token,
            packageName: registration.packageName,
            data: {
              ...card.fields,
              device_id: registration.registrationId,
              updated_at: String(updatedAt),
            },
          }),
        );
        const outcome = await send(body, key);
        if (outcome === 'sent') {
          delivered.set(deviceId, {
            token: registration.token,
            registrationId: registration.registrationId,
            contentKey: card.contentKey,
          });
        } else if (outcome === 'unregistered') {
          delivered.delete(deviceId);
          try {
            devicePairing.clearNativePush(deviceId, registration.token);
          } catch (error) {
            logger.warn('agent-activity: failed to clear a dead registration', {
              error: errorMessage(error),
            });
          }
        }
      }),
    );
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

  return {
    requestFlush,
    drain: () => worker.drain(),
    stop: async () => {
      stopped = true;
      unsubscribe();
      await worker.dispose();
    },
  };
}
