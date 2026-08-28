/**
 * SSE endpoint — single event stream for all real-time updates.
 * Replays current state on connect so clients don't miss events that fired before they subscribed.
 *
 * archive#1205 / archive#3525 / archive#3567: this route has NO user-identity
 * concept (`EventRouteDeps` carries none) and forwards `EventBus` events to
 * every connected client. `SERVER_EVENTS.ORCHESTRATION_EVENT` carries
 * per-session content (`request.opened` payloads with `requestId`/`title`,
 * etc.) that is ownership-scoped everywhere else it's read; `INTERNAL_STOP_
 * REDISPATCH_FAILED` carries `{threadId, turnId, provider}` for the same
 * reason; `OPERATIONAL_EVENT` wraps an arbitrary internal durable-work
 * event with no scoping of its own. Each reached this route once already —
 * `ORCHESTRATION_EVENT` at archive#1205, `INTERNAL_STOP_REDISPATCH_FAILED` at
 * archive#3525 — because the relay decision used to be a hand-maintained denylist
 * at this file: the default for anything NOT named here was broadcast, and
 * adding a new session-scoped `SERVER_EVENTS` member was, by itself, enough
 * to auto-enroll it in verbatim broadcast.
 *
 * archive#3567 inverted that default. The relay decision below reads
 * `SERVER_EVENT_BROADCAST_SAFETY` (defined alongside `SERVER_EVENTS` in
 * `@kontourai/station-contracts/runtime-events`) — a map TypeScript refuses
 * to compile unless every `SERVER_EVENTS` member has an explicit
 * `'broadcast' | 'scoped'` entry. Only `'broadcast'`-tagged channels relay
 * unconditionally; every `'scoped'` channel relays only through a
 * channel-specific identity gate this route recognizes by name (today: the
 * notification family via `canRelayNotificationEvent`, the approval family
 * via `canRelayApprovalEvent`, and `UI_NAVIGATE` via
 * `canRelayUiNavigateEvent`) and is otherwise denied — no route change
 * required when a new scoped channel is added, and no route change possible
 * that silently re-opens this hole for one. Clients that need orchestration
 * events must use the gated `/api/orchestration/events` route instead. If
 * you're adding a new per-user/per-session event type, tag it `'scoped'` at
 * its definition in `runtime-events.ts`; if it needs to reach this route,
 * add a dedicated identity gate for it here rather than tagging it
 * `'broadcast'`.
 */

import {
  SERVER_EVENT_BROADCAST_SAFETY,
  SERVER_EVENTS,
} from '@kontourai/station-contracts/runtime-events';
import {
  isHostedSessionReadAuthority,
  type SessionReadAuthority,
} from '@kontourai/station-contracts/tenancy';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { SSE_KEEPALIVE_INTERVAL_MS } from '../../constants.js';
import type { EventBus } from '../../services/orchestration/event-bus.js';
import type { ClientConnectionLease } from '../../services/ssh/client-connection-presence.js';
import { sseOps } from '../../telemetry/metrics.js';

export interface EventRouteDeps {
  eventBus: EventBus;
  getACPStatus: () => {
    connected: boolean;
    connections: Array<{ id: string; status: string }>;
  };
  logger: any;
  /** Request-scoped authority supplied by hosted runtime composition. */
  readAuthorityForRequest?: (request: Request) => SessionReadAuthority;
  /**
   * Classifies a notification frame through notification/session authority.
   * It receives the full frame because update/dismiss frames may carry only
   * an id and need a store lookup at composition time.
   */
  canReadNotificationEvent?: (
    event: string,
    data: unknown,
    authority: SessionReadAuthority,
  ) => boolean;
  /** Approval lifecycle frames are registry-backed and need their own binding. */
  canReadApprovalEvent?: (
    event: string,
    data: unknown,
    authority: SessionReadAuthority,
  ) => boolean;
  /** Exact answer-assessment updates carry a Session identity and need the same gate. */
  canReadAnswerAssessmentEvent?: (
    data: unknown,
    authority: SessionReadAuthority,
  ) => boolean;
  /** Exact answer-narrative updates have the same Session-only authority. */
  canReadAnswerNarrativeEvent?: (
    data: unknown,
    authority: SessionReadAuthority,
  ) => boolean;
  connectPairedDevice?: (request: Request) => ClientConnectionLease | undefined;
  isPairedDeviceConnectionCurrent?: (request: Request) => boolean;
  writeSse?: (
    stream: any,
    frame: { event: string; data: string },
  ) => Promise<void>;
}

export function createEventRoutes({
  eventBus,
  getACPStatus,
  logger,
  readAuthorityForRequest,
  canReadNotificationEvent,
  canReadApprovalEvent,
  canReadAnswerAssessmentEvent,
  canReadAnswerNarrativeEvent,
  connectPairedDevice,
  isPairedDeviceConnectionCurrent,
  writeSse,
}: EventRouteDeps) {
  const app = new Hono();

  app.get('/', (c) => {
    return streamSSE(c, async (stream) => {
      let clientLease: ClientConnectionLease | undefined;
      let settleUnauthorized: (() => void) | undefined;
      let authorizationSettled = false;
      let settleDisconnect: (() => void) | undefined;
      const disconnected = new Promise<void>((resolve) => {
        settleDisconnect = resolve;
      });
      stream.onAbort(() => settleDisconnect?.());
      c.req.raw.signal.addEventListener('abort', () => settleDisconnect?.(), {
        once: true,
      });
      if (
        (stream as unknown as { aborted?: boolean }).aborted ||
        c.req.raw.signal.aborted
      )
        return;
      const writeFrame = async (frame: { event: string; data: string }) => {
        if (isPairedDeviceConnectionCurrent?.(c.req.raw) === false) {
          if (!authorizationSettled) {
            authorizationSettled = true;
            clientLease?.release();
            settleUnauthorized?.();
            void stream.close();
          }
          return Promise.reject(new Error('unauthorized'));
        }
        await (writeSse?.(stream, frame) ?? stream.writeSSE(frame));
        if (
          (stream as unknown as { aborted?: boolean; closed?: boolean })
            .aborted ||
          (stream as unknown as { aborted?: boolean; closed?: boolean })
            .closed ||
          c.req.raw.signal.aborted
        ) {
          settleDisconnect?.();
          throw new Error('stream_closed');
        }
      };
      const authority = readAuthorityForRequest?.(c.req.raw);
      sseOps.add(1, { op: 'connect' });
      type BroadcastEvent = Parameters<Parameters<EventBus['subscribe']>[0]>[0];
      const pendingEvents: BroadcastEvent[] = [];
      let replayComplete = false;
      let writeChain = Promise.resolve();

      const writeBroadcast = (evt: BroadcastEvent) => {
        writeChain = writeChain
          .then(() =>
            writeFrame({
              event: evt.event,
              data: JSON.stringify(evt.data || {}),
            }),
          )
          .catch(() => {
            /* client gone */
          });
      };

      const relay = (evt: BroadcastEvent) => {
        if (!replayComplete) pendingEvents.push(evt);
        else writeBroadcast(evt);
      };

      let unsub: (() => void) | undefined;
      let keepAlive: ReturnType<typeof setInterval> | undefined;
      try {
        clientLease = connectPairedDevice?.(c.req.raw);
        if (c.req.raw.signal.aborted) return;
        // Subscribe before the first frame is written. Response headers therefore
        // cannot become browser-visible until this connection is ready to observe
        // live events. Events emitted while the initial snapshot is being built or
        // written are buffered and flushed immediately after that snapshot.
        unsub = eventBus.subscribe((evt) => {
          // archive#3567: the relay decision is an allow-list keyed off each
          // channel's declared `broadcastSafety` — see the file header. Only
          // `'broadcast'` relays unconditionally.
          if (SERVER_EVENT_BROADCAST_SAFETY[evt.event] === 'broadcast') {
            relay(evt);
            return;
          }
          // Everything else — every `'scoped'` channel — relays only through a
          // dedicated identity gate this route recognizes by name. No gate
          // recognized for a channel means it is denied, not broadcast; this
          // is what keeps a newly-added scoped channel safe by default without
          // any change to this file (archive#1205, archive#3525).
          if (isNotificationEvent(evt.event)) {
            if (
              canRelayNotificationEvent(
                evt.event,
                evt.data,
                authority,
                canReadNotificationEvent,
              )
            )
              relay(evt);
            return;
          }
          if (isApprovalEvent(evt.event)) {
            if (
              canRelayApprovalEvent(
                evt.event,
                evt.data,
                authority,
                canReadApprovalEvent,
              )
            )
              relay(evt);
            return;
          }
          if (isUiNavigateEvent(evt.event)) {
            if (canRelayUiNavigateEvent(authority)) relay(evt);
            return;
          }
          if (isAnswerAssessmentEvent(evt.event)) {
            if (
              canRelayAnswerAssessmentEvent(
                evt.data,
                authority,
                canReadAnswerAssessmentEvent,
              )
            )
              relay(evt);
            return;
          }
          if (isAnswerNarrativeEvent(evt.event)) {
            if (
              canRelayAnswerNarrativeEvent(
                evt.data,
                authority,
                canReadAnswerNarrativeEvent,
              )
            )
              relay(evt);
            return;
          }
        });

        // Replay current ACP state so clients that connect after startup get the truth
        const acpStatus = getACPStatus();
        await writeFrame({
          event: SERVER_EVENTS.ACP_STATUS,
          data: JSON.stringify(acpStatus),
        });
        for (const evt of pendingEvents) writeBroadcast(evt);
        pendingEvents.length = 0;
        replayComplete = true;

        keepAlive = setInterval(() => {
          writeFrame({ event: 'ping', data: '' })
            .then(() => clientLease?.touch())
            .catch(() => {});
        }, SSE_KEEPALIVE_INTERVAL_MS);

        try {
          settleUnauthorized = () => settleDisconnect?.();
          await disconnected;
        } catch (e) {
          logger.debug('SSE client disconnected', { error: e });
          /* client disconnected */
        }
      } finally {
        if (keepAlive) clearInterval(keepAlive);
        unsub?.();
        clientLease?.release();
        logger.debug('SSE client disconnected');
      }
    });
  });

  return app;
}

/**
 * Exported so `events.routes.test.ts`'s generic scoped-channel coverage can
 * derive "which scoped channels have a dedicated identity gate" from the
 * same set the route itself uses, instead of a second hand-maintained copy
 * that could silently drift from this one.
 */
export function isApprovalEvent(event: string): boolean {
  return (
    event === SERVER_EVENTS.APPROVAL_OPENED ||
    event === SERVER_EVENTS.APPROVAL_RESOLVED
  );
}

export function isNotificationEvent(event: string): boolean {
  return new Set<string>([
    SERVER_EVENTS.NOTIFICATION_DELIVERED,
    SERVER_EVENTS.NOTIFICATION_UPDATED,
    SERVER_EVENTS.NOTIFICATION_DISMISSED,
    SERVER_EVENTS.NOTIFICATION_CLEARED,
  ]).has(event);
}

/**
 * Exported for the same reason as {@link isApprovalEvent} /
 * {@link isNotificationEvent}: lets `events.routes.test.ts` derive "which
 * scoped channels have a dedicated identity gate" from the route's own
 * recognized set.
 */
export function isUiNavigateEvent(event: string): boolean {
  return event === SERVER_EVENTS.UI_NAVIGATE;
}

export function isAnswerAssessmentEvent(event: string): boolean {
  return event === SERVER_EVENTS.ANSWER_ASSESSMENT_UPDATED;
}

export function isAnswerNarrativeEvent(event: string): boolean {
  return event === SERVER_EVENTS.ANSWER_NARRATIVE_UPDATED;
}

function canRelayAnswerNarrativeEvent(
  data: unknown,
  authority: SessionReadAuthority | undefined,
  canReadAnswerNarrativeEvent:
    | ((data: unknown, authority: SessionReadAuthority) => boolean)
    | undefined,
): boolean {
  if (!authority) return false;
  const sessionId = (data as { sessionId?: unknown } | undefined)?.sessionId;
  return (
    typeof sessionId === 'string' &&
    canReadAnswerNarrativeEvent?.(data, authority) === true
  );
}

function canRelayAnswerAssessmentEvent(
  data: unknown,
  authority: SessionReadAuthority | undefined,
  canReadAnswerAssessmentEvent:
    | ((data: unknown, authority: SessionReadAuthority) => boolean)
    | undefined,
): boolean {
  if (!authority) return false;
  const sessionId = (data as { sessionId?: unknown } | undefined)?.sessionId;
  return (
    typeof sessionId === 'string' &&
    canReadAnswerAssessmentEvent?.(data, authority) === true
  );
}

function canRelayNotificationEvent(
  event: string,
  data: unknown,
  authority: SessionReadAuthority | undefined,
  canReadNotificationEvent:
    | ((
        event: string,
        data: unknown,
        authority: SessionReadAuthority,
      ) => boolean)
    | undefined,
): boolean {
  // Personal mode retains the existing broadcast contract. In hosted mode a
  // missing filter cannot become a notification-id/content disclosure.
  if (!authority) return canReadNotificationEvent === undefined;
  if (!isHostedSessionReadAuthority(authority)) return true;
  if (!authority.tenantExecutionContext) return false;
  return canReadNotificationEvent?.(event, data, authority) === true;
}

function canRelayApprovalEvent(
  event: string,
  data: unknown,
  authority: SessionReadAuthority | undefined,
  canReadApprovalEvent:
    | ((
        event: string,
        data: unknown,
        authority: SessionReadAuthority,
      ) => boolean)
    | undefined,
): boolean {
  // Personal mode keeps the current registry-event broadcast contract. A
  // hosted event without a request authority or registry predicate leaks an
  // approval id/status and must not enter either pending or live SSE paths.
  if (!authority) return canReadApprovalEvent === undefined;
  if (!isHostedSessionReadAuthority(authority)) return true;
  if (!authority.tenantExecutionContext) return false;
  return canReadApprovalEvent?.(event, data, authority) === true;
}

/**
 * `UI_NAVIGATE`'s payload (`{path}`) carries no destination identity at
 * all — unlike notifications/approvals, there is no id or session field a
 * predicate could compare against a caller's authority. So there is no
 * `canReadUiNavigateEvent` callback to invoke; the decision is entirely
 * personal-vs-hosted (archive#3567 fix round FIX 1):
 *
 * - Personal mode (a real `SessionReadAuthority` with `mode: 'personal'`):
 *   deliver. This route reaches only the single process-wide user's own
 *   tabs/devices in personal mode — `readAuthorityForRequest` mints
 *   `userId` from `getCachedUser().alias`, a process-wide singleton with no
 *   per-request input, so there is no second principal this connection
 *   could leak the command to.
 * - Hosted multi-tenant: deny. Nothing in the payload identifies which
 *   tenant's connections should receive it, so broadcasting would drive
 *   every connected client's UI regardless of who issued the command.
 * - `authority === undefined`: deny. archive#3567 second fix round FIX 2 —
 *   an earlier version of this function treated missing authority as
 *   clearance (`if (!authority) return true`), making it the only relay
 *   predicate on this route that read "unknown" as "safe" rather than as
 *   grounds for suspicion (`canRelayNotificationEvent`/
 *   `canRelayApprovalEvent` above both deny by default when their own
 *   `canRead*` callback is wired but authority is missing). Undefined
 *   authority means the caller genuinely does not know which mode applies —
 *   that is the one thing this branch cannot conclude — so it must not
 *   assume personal. In production `readAuthorityForRequest` is always
 *   wired (`runtime-routes.ts`) and always returns a real authority, so this
 *   case is test-harness-only; every test that needs delivery supplies a
 *   real personal-mode `SessionReadAuthority` instead of relying on this
 *   branch.
 *
 * This route and `ui-commands.ts`'s `isHostedDeployment` predicate derive
 * "is this deployment hosted" from two independent sources — this one from
 * `authority.mode`, the other from `hostedTenantRegistry` directly. They
 * agree today only because both close over the same `hostedTenantRegistry`
 * in `runtime-routes.ts`.
 */
function canRelayUiNavigateEvent(
  authority: SessionReadAuthority | undefined,
): boolean {
  return authority !== undefined && !isHostedSessionReadAuthority(authority);
}
