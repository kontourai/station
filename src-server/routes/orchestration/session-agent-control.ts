/**
 * #3160 (epic #3167): the REST side of Station Control's Session tools —
 * `send_to_session`, `interrupt_session` and `wait_session`. An agent can wait
 * on, message and interrupt another Session in its Project.
 *
 * These leaves are agent-only. Each acts as the VERIFIED station-control
 * caller (never as anything the request body names), and answers
 * `station_control_caller_required` to a request that carries none, so the
 * operator's UI, a paired device and Station's own server code, which have
 * their own routes, have nothing to do here.
 *
 * The guard at the auth boundary has already held the caller to the table's
 * policy (`tools/station-control-policy.ts`: a recorded owner, the Project
 * `execute` action for the mutating two). What it cannot know is which Session
 * the body names, so each mutating leaf decides the target's scope itself,
 * before any effect, with the one rule every dispatch route applies
 * (`refuseOutOfScopeDispatch`): same owner, same Project (or both global),
 * never a `host` thread, never another Station, unless the caller is a bound
 * operator. The wait is an owner-scoped read (decision 2): it reads what the
 * owner may read and changes nothing.
 *
 * The request schemas are strict and carry no approval mode, model or
 * environment. A message delivered here runs under the target Agent's saved
 * defaults, so nothing a caller sends can widen what the callee may do.
 *
 * Every mutating call carries a `requestKey`. The key table
 * (`session-control-request-keys.ts`) makes a retry deliver once, and the
 * delivery seam (`session-message-delivery.ts`) decides whether the message
 * starts a turn or steers the running one.
 */
import type { PrincipalRef } from '@kontourai/station-contracts/principal';
import {
  type HostedTenantRegistry,
  sessionReadAuthorityFromRequest,
} from '@kontourai/station-contracts/tenancy';
import { type Context, Hono } from 'hono';
import { z } from 'zod/v3';
import { CHAT_INPUT_MAX_CHARS } from '../../../src-shared/chat-input-limits.js';
import {
  getTenantRequestContext,
  tenantExecutionContextForRequest,
} from '../../runtime/bootstrap/runtime-tenant-context.js';
import type { StationControlDispatchScope } from '../../runtime/mcp/station-control-dispatch-scope.js';
import type { FullAccessGrant } from '../../security/coding-authority.js';
import { resolveClientOriginForRequest } from '../../security/runtime-request-security.js';
import { stationControlRequestAuthority } from '../../security/station-control-request-authority.js';
import type { EventStore } from '../../services/orchestration/event-store.js';
import type { OrchestrationService } from '../../services/orchestration/orchestration-service.js';
import {
  runWithSessionControlKey,
  type SessionControlAttempt,
  sessionControlDeliveryId,
  sessionControlRequestDigest,
} from '../../services/orchestration/session-control-request-keys.js';
import { ACTIVE_TURN_FOLD_METHODS } from '../../services/orchestration/session-lifecycle-service.js';
import {
  deliverSessionMessage,
  type SessionDeliveryBranch,
  type SessionMessageDelivery,
  type SessionMessageDeliveryPorts,
  type SessionSendMode,
} from '../../services/orchestration/session-message-delivery.js';
import type { StartOwnerAttribution } from '../../services/orchestration/session-owner-attribution.js';
import {
  evaluateSessionWait,
  SESSION_WAIT_MAX_TIMEOUT_MS,
  SessionTurnWaiter,
  type SessionTurnWaitPorts,
} from '../../services/orchestration/session-turn-wait.js';
import {
  stationControlRefusal,
  stationControlRefusalBody,
} from '../../tools/station-control-policy.js';
import type { StationControlCaller } from '../../tools/station-control-shared.js';
import { errorMessage, getBody, validate } from '../schemas/schemas.js';
import { refuseOutOfScopeDispatch } from './dispatch-scope.js';
import {
  isForegroundDispatchHandle,
  isForegroundIndeterminateShape,
  type PrincipalResolutionContext,
  resolveActorPrincipal,
  resolveDispatchActor,
} from './orchestration.js';

/** The longest JSON a send can be: every character escaped to six bytes. */
const SEND_BODY_MAX_BYTES = CHAT_INPUT_MAX_CHARS * 6 + 4096;
const SMALL_BODY_MAX_BYTES = 8192;

const sessionIdSchema = z.string().min(1).max(512);
const requestKeySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

const sendToSessionBodySchema = z
  .object({
    sessionId: sessionIdSchema,
    text: z.string().trim().min(1).max(CHAT_INPUT_MAX_CHARS),
    mode: z.enum(['auto', 'start', 'steer']),
    requestKey: requestKeySchema,
  })
  .strict();

const interruptSessionBodySchema = z
  .object({
    sessionId: sessionIdSchema,
    turnId: z.string().min(1).max(512).optional(),
    requestKey: requestKeySchema,
  })
  .strict();

const waitSessionQuerySchema = z
  .object({
    until: z.enum(['turn-settled', 'idle']),
    timeoutMs: z.coerce
      .number()
      .int()
      .min(1)
      .max(SESSION_WAIT_MAX_TIMEOUT_MS)
      .default(30_000),
    afterEventCursor: z.coerce.number().int().min(0).optional(),
  })
  .strict()
  .refine(
    (query) =>
      query.until === 'turn-settled' || query.afterEventCursor === undefined,
    {
      message: 'afterEventCursor applies only to until=turn-settled',
      path: ['afterEventCursor'],
    },
  );

/** What `send_to_session` stores and returns for one request. */
export type SendToSessionResult =
  | {
      readonly outcome: 'started' | 'steered';
      readonly sessionId: string;
      readonly turnId: string;
      readonly conversationId?: string;
      /** Pass to `wait_session` as `afterEventCursor`. */
      readonly eventCursor: number;
    }
  | {
      readonly outcome: 'session_busy';
      readonly reason: 'turn-active' | 'steer-unsupported' | 'steer-in-flight';
      readonly sessionId: string;
      readonly eventCursor: number;
      /** A re-drive of an earlier attempt: its key is pinned to that attempt. */
      readonly pinned?: true;
    }
  | {
      readonly outcome: 'no_active_turn';
      readonly sessionId: string;
      readonly eventCursor: number;
      readonly pinned?: true;
    }
  | { readonly outcome: 'indeterminate'; readonly sessionId: string };

/** A request the route refused or could not run; never stored. */
interface RequestFailure {
  readonly outcome: 'failed';
  readonly detail: string;
}

/** What `interrupt_session` stores and returns for one request. */
export interface InterruptSessionResult {
  readonly outcome:
    | 'cooperative'
    | 'forced'
    | 'turn-completed'
    | 'pending-turn-start'
    | 'no-active-turn';
  readonly sessionId: string;
  readonly turnId?: string;
}

export interface SessionAgentControlDeps {
  orchestrationService: Pick<
    OrchestrationService,
    | 'canUserReadSession'
    | 'currentConversationSessionId'
    | 'dispatchWithReceipt'
    | 'hasActiveTurn'
  >;
  eventStore: Pick<
    EventStore,
    | 'conversationForSession'
    | 'listEventsByMethods'
    | 'readSessionInventoryHighWater'
    | 'sessionControlRequestKeys'
  >;
  /** Server events; an appended orchestration event wakes a wait. */
  eventBus: {
    subscribe(
      listener: (event: {
        event: string;
        data?: Record<string, unknown>;
      }) => void,
    ): () => void;
  };
  stationControlDispatchScope?: StationControlDispatchScope;
  resolvePrincipal?: (c: PrincipalResolutionContext) => PrincipalRef;
  resolveAgentDispatchActor?: Parameters<
    typeof resolveDispatchActor
  >[0]['resolveAgentDispatchActor'];
  hostedTenantRegistry?: HostedTenantRegistry;
  /**
   * Starts a turn on an existing conversation: the same entry the
   * conversation continue route uses (server scope included). It is handed
   * no approval mode, model or environment: the session's own binding and
   * saved posture govern the turn.
   */
  continueForegroundMessage: (input: {
    conversationId: string;
    message: string;
    clientTurnId: string;
    userId: string;
    principal: PrincipalRef | undefined;
    ownerAttribution: StartOwnerAttribution | undefined;
    fullAccessGrant: FullAccessGrant | null;
    clientOrigin: ReturnType<typeof resolveClientOriginForRequest>;
  }) => Promise<unknown>;
  /** The Session wait; one per Station so its caps are Station-wide. */
  waiter?: SessionTurnWaiter;
}

/** The wait's reads, over the same durable fold the steer path uses. */
function sessionTurnWaitPorts(
  deps: Pick<
    SessionAgentControlDeps,
    'eventStore' | 'eventBus' | 'orchestrationService'
  >,
): SessionTurnWaitPorts {
  return {
    foldEvents: (threadId) =>
      deps.eventStore
        .listEventsByMethods(threadId, ACTIVE_TURN_FOLD_METHODS)
        .map((stored) => ({
          sequence: stored.sequence,
          event: stored.payload,
        })),
    // The newest event's per-Session sequence (named for the first reader
    // that needed it; it is exactly `MAX(sequence)` for the thread).
    headSequence: (threadId) =>
      deps.eventStore.readSessionInventoryHighWater(threadId),
    coordinatorBusy: (threadId) =>
      deps.orchestrationService.hasActiveTurn(threadId),
    subscribe: (threadId, listener) =>
      deps.eventBus.subscribe((frame) => {
        if (frame.event !== 'orchestration:event') return;
        const inner = (
          frame.data as { event?: { threadId?: string } } | undefined
        )?.event;
        if (inner?.threadId === threadId) listener();
      }),
  };
}

function callerOf(c: Context): StationControlCaller | Response {
  const authority = stationControlRequestAuthority(c.req.raw);
  if (authority?.kind === 'caller') return authority.caller;
  return c.json(
    stationControlRefusalBody(
      stationControlRefusal('station_control_caller_required'),
    ),
    403,
  );
}

function keyRefusal(
  c: Context,
  outcome:
    | { kind: 'conflict' | 'in-progress' }
    | { kind: 'capacity'; scope: 'caller' | 'station' },
): Response {
  switch (outcome.kind) {
    case 'conflict':
      return c.json(
        {
          success: false,
          code: 'request_key_conflict',
          error:
            'This requestKey was already used for a different request. Use a new requestKey for a new request, or repeat the original request exactly to replay its result.',
        },
        409,
      );
    case 'in-progress':
      return c.json(
        {
          success: false,
          code: 'request_in_progress',
          error:
            'This request is still running. Repeat it with the same requestKey shortly to read its result; do not start a new one.',
        },
        409,
      );
    case 'capacity':
      return outcome.scope === 'caller'
        ? c.json(
            {
              success: false,
              code: 'request_key_caller_capacity',
              error:
                'This session has too many requests still unresolved (indeterminate). Repeat those calls with their original requestKeys to resolve them before sending more.',
            },
            429,
          )
        : c.json(
            {
              success: false,
              code: 'request_key_capacity',
              error: 'Station is holding too many unexpired request keys.',
            },
            429,
          );
  }
}

const notFound = (c: Context) =>
  c.json(
    { success: false, code: 'session_not_found', error: 'Session not found' },
    404,
  );

/** `start:<threadId>` / `steer:<threadId>`: the branch an attempt pinned. */
function parseDecision(
  decision: string | undefined,
): { branch: SessionDeliveryBranch; threadId: string } | undefined {
  if (!decision) return undefined;
  const split = decision.indexOf(':');
  const branch = decision.slice(0, split);
  if (split < 1 || (branch !== 'start' && branch !== 'steer')) return undefined;
  return { branch, threadId: decision.slice(split + 1) };
}

type SendAttempt = SessionControlAttempt<SendToSessionResult | RequestFailure>;

/** What the key table does with a delivery's outcome. */
function settleSend(
  delivery: SessionMessageDelivery,
  threadId: string,
  cursorBefore: number,
  /** The attempt re-drove an earlier one and so keeps its claim and branch. */
  pinned: boolean,
): SendAttempt {
  switch (delivery.outcome) {
    case 'started':
      return {
        settle: 'final',
        result: {
          outcome: 'started',
          sessionId: delivery.sessionId,
          conversationId: delivery.conversationId,
          turnId: delivery.turnId,
          // A start that moved to a new Session has no earlier events there.
          eventCursor: delivery.sessionId === threadId ? cursorBefore : 0,
        },
      };
    case 'steered':
      return {
        settle: 'final',
        result: {
          outcome: 'steered',
          sessionId: delivery.sessionId,
          turnId: delivery.turnId,
          eventCursor: cursorBefore,
        },
      };
    // A refusal delivered nothing: a fresh claim is freed so the same request
    // can run again once the Session is ready, rather than replaying the
    // refusal. A re-driven claim is kept (the key table decides), so its
    // result says it is pinned and the text must not offer another mode.
    case 'session_busy':
      return {
        settle: 'release',
        result: {
          outcome: 'session_busy',
          reason: delivery.reason,
          sessionId: threadId,
          eventCursor: cursorBefore,
          ...(pinned ? { pinned: true as const } : {}),
        },
      };
    case 'no_active_turn':
      return {
        settle: 'release',
        result: {
          outcome: 'no_active_turn',
          sessionId: threadId,
          eventCursor: cursorBefore,
          ...(pinned ? { pinned: true as const } : {}),
        },
      };
    case 'indeterminate':
      return {
        settle: 'pending',
        result: { outcome: 'indeterminate', sessionId: threadId },
      };
  }
}

function sendResponse(
  c: Context,
  result: SendToSessionResult | RequestFailure,
  replayed: boolean,
) {
  const replay = replayed ? { replayed: true } : {};
  if (
    (result.outcome === 'session_busy' ||
      result.outcome === 'no_active_turn') &&
    result.pinned
  )
    // A re-drive keeps the first attempt's branch, and the mode is part of the
    // request's digest, so offering another mode or a retry here would only
    // meet `request_key_conflict`.
    return c.json(
      {
        success: false,
        code: result.outcome,
        error:
          'This requestKey is pinned to its first attempt, which may have been delivered. Wait for a running turn, or read the Session and use a new requestKey only if the text was not delivered.',
        ...result,
        ...replay,
      },
      409,
    );
  switch (result.outcome) {
    case 'started':
    case 'steered':
      return c.json({ success: true, data: { ...result, ...replay } });
    case 'session_busy':
      return c.json(
        {
          success: false,
          code: 'session_busy',
          error:
            result.reason === 'turn-active'
              ? 'The Session is running a turn, so a start was refused. Use mode "auto" or "steer" to add to it, or call wait_session until it is idle. Nothing was sent; the same requestKey may be reused.'
              : result.reason === 'steer-unsupported'
                ? 'The Session is running a turn and its engine cannot take a message mid-turn. Nothing was sent. Call wait_session until it is idle, then send again (the same requestKey may be reused).'
                : 'Another steer to this Session is still settling. Nothing was sent; send again shortly (the same requestKey may be reused).',
          ...result,
          ...replay,
        },
        409,
      );
    case 'no_active_turn':
      return c.json(
        {
          success: false,
          code: 'no_active_turn',
          error:
            'The Session has no running turn to steer. Nothing was sent; use mode "auto" or "start" to start one (the same requestKey may be reused).',
          ...result,
          ...replay,
        },
        409,
      );
    case 'indeterminate':
      return c.json(
        {
          success: false,
          code: 'delivery_indeterminate',
          error:
            'The message may have been delivered. Do not send it again under a new requestKey; repeat this same call to re-check, or read the Session.',
          ...result,
          ...replay,
        },
        409,
      );
    case 'failed':
      return c.json({ success: false, error: result.detail }, 400);
  }
}

export function createSessionAgentControlRoutes(deps: SessionAgentControlDeps) {
  const app = new Hono();
  const keys = () => deps.eventStore.sessionControlRequestKeys();
  const waitPorts = sessionTurnWaitPorts(deps);
  const waiter = deps.waiter ?? new SessionTurnWaiter(waitPorts);

  const readAuthorityFor = (c: Context) =>
    sessionReadAuthorityFromRequest(
      resolveActorPrincipal(deps, c).userId,
      getTenantRequestContext(c.req.raw),
      deps.hostedTenantRegistry,
    );

  /** A turn is open in the log, or the coordinator holds one in flight. */
  const isBusy = (threadId: string) =>
    !evaluateSessionWait(waitPorts, threadId, 'idle', 0).satisfied;

  /**
   * The Session a send or interrupt acts on: the conversation's CURRENT
   * Session, whichever of its ids the caller named. An older child of a
   * conversation has no live turn to steer; the conversation's own does.
   */
  const actingSession = (sessionId: string) => {
    const conversationId =
      deps.eventStore.conversationForSession(sessionId)?.conversationId ??
      sessionId;
    return {
      conversationId,
      threadId:
        deps.orchestrationService.currentConversationSessionId(conversationId),
    };
  };

  /** Scope, then read authority: the two refusals before any effect. */
  const authorizeTarget = (
    c: Context,
    target: { threadId: string },
  ): Response | undefined => {
    const scopeRefused = refuseOutOfScopeDispatch(
      c,
      deps.stationControlDispatchScope,
      () => ({ kind: 'thread', threadId: target.threadId, remote: false }),
    );
    if (scopeRefused) return scopeRefused;
    return deps.orchestrationService.canUserReadSession(
      target.threadId,
      readAuthorityFor(c),
    )
      ? undefined
      : notFound(c);
  };

  app.post(
    '/send',
    validate(sendToSessionBodySchema, { maxBodyBytes: SEND_BODY_MAX_BYTES }),
    async (c) => {
      const caller = callerOf(c);
      if (caller instanceof Response) return caller;
      const body = getBody(c) as z.infer<typeof sendToSessionBodySchema>;
      const target = actingSession(body.sessionId);
      const refused = authorizeTarget(c, target);
      if (refused) return refused;

      const id = {
        callerSessionId: caller.sessionId,
        tool: 'send_to_session',
        key: body.requestKey,
      };
      const actor = resolveDispatchActor(deps, c);
      const context = {
        userId: actor.userId,
        ...(actor.ownerAttribution
          ? { ownerAttribution: actor.ownerAttribution }
          : {}),
        principal: actor.principal,
        tenantExecutionContext: tenantExecutionContextForRequest(c.req.raw),
        clientOrigin: resolveClientOriginForRequest(c.req.raw),
      };
      let refusedPinned: Response | undefined;
      const outcome = await runWithSessionControlKey<
        SendToSessionResult | RequestFailure
      >(
        keys(),
        id,
        sessionControlRequestDigest([body.sessionId, body.mode, body.text]),
        async (resume): Promise<SendAttempt> => {
          // A re-driven attempt acts on the Session its first attempt chose.
          const pinned = parseDecision(resume.decision);
          const threadId = pinned?.threadId ?? target.threadId;
          // The pinned Session may no longer be the current one the scope
          // check ran on: it must pass the same checks before it is acted on.
          if (pinned && pinned.threadId !== target.threadId) {
            const pinnedRefused = authorizeTarget(c, pinned);
            if (pinnedRefused) {
              refusedPinned = pinnedRefused;
              // Nothing was done; the claim stays for a later re-drive.
              return {
                settle: 'pending',
                result: { outcome: 'failed', detail: 'Refused.' },
              };
            }
          }
          const cursorBefore =
            deps.eventStore.readSessionInventoryHighWater(threadId);
          const ports: SessionMessageDeliveryPorts = {
            isBusy,
            start: async ({ text, clientTurnId }) => {
              try {
                const handle = await deps.continueForegroundMessage({
                  conversationId: target.conversationId,
                  message: text,
                  clientTurnId,
                  userId: actor.userId,
                  principal: actor.principal,
                  ownerAttribution: actor.ownerAttribution,
                  fullAccessGrant: actor.fullAccessGrant,
                  clientOrigin: context.clientOrigin,
                });
                if (!isForegroundDispatchHandle(handle))
                  return { outcome: 'indeterminate' };
                const started = handle as { sessionId?: unknown };
                return {
                  outcome: 'started',
                  conversationId: handle.conversationId,
                  sessionId:
                    typeof started.sessionId === 'string'
                      ? started.sessionId
                      : threadId,
                  turnId: handle.providerTurnId,
                };
              } catch (error) {
                if (isForegroundIndeterminateShape(error))
                  return { outcome: 'indeterminate' };
                throw error;
              }
            },
            steer: async ({ threadId: thread, text, clientInputId }) => {
              const dispatched =
                await deps.orchestrationService.dispatchWithReceipt(
                  {
                    type: 'steerTurn',
                    threadId: thread,
                    input: text,
                    clientInputId,
                  },
                  context,
                );
              const result = dispatched.result as
                | { outcome?: string; turnId?: string }
                | undefined;
              switch (result?.outcome) {
                case 'steered':
                  return { outcome: 'steered', turnId: result.turnId ?? '' };
                case 'no-active-turn':
                case 'unsupported-engine':
                case 'concurrent-steer':
                  return { outcome: result.outcome };
                default:
                  return { outcome: 'indeterminate' };
              }
            },
          };
          try {
            const delivery = await deliverSessionMessage(ports, {
              threadId,
              text: body.text,
              mode: body.mode as SessionSendMode,
              deliveryId: sessionControlDeliveryId(id),
              ...(pinned ? { decided: pinned.branch } : {}),
              recordDecision: (branch) =>
                resume.recordDecision(`${branch}:${threadId}`),
            });
            return settleSend(
              delivery,
              threadId,
              cursorBefore,
              pinned !== undefined,
            );
          } catch (error) {
            // A refused delivery that did not report itself indeterminate had
            // no effect: free the key so the caller's retry runs afresh.
            return {
              settle: 'release',
              result: { outcome: 'failed', detail: errorMessage(error) },
            };
          }
        },
      );
      if (refusedPinned) return refusedPinned;
      if (outcome.kind !== 'executed' && outcome.kind !== 'replayed')
        return keyRefusal(c, outcome);
      return sendResponse(c, outcome.result, outcome.kind === 'replayed');
    },
  );

  app.post(
    '/interrupt',
    validate(interruptSessionBodySchema, {
      maxBodyBytes: SMALL_BODY_MAX_BYTES,
    }),
    async (c) => {
      const caller = callerOf(c);
      if (caller instanceof Response) return caller;
      const body = getBody(c) as z.infer<typeof interruptSessionBodySchema>;
      const target = actingSession(body.sessionId);
      const refused = authorizeTarget(c, target);
      if (refused) return refused;
      const id = {
        callerSessionId: caller.sessionId,
        tool: 'interrupt_session',
        key: body.requestKey,
      };
      const actor = resolveDispatchActor(deps, c);
      const outcome = await runWithSessionControlKey<
        InterruptSessionResult | RequestFailure
      >(
        keys(),
        id,
        sessionControlRequestDigest([body.sessionId, body.turnId ?? null]),
        async (): Promise<
          SessionControlAttempt<InterruptSessionResult | RequestFailure>
        > => {
          try {
            const dispatched =
              await deps.orchestrationService.dispatchWithReceipt(
                {
                  type: 'interruptTurn',
                  threadId: target.threadId,
                  ...(body.turnId ? { turnId: body.turnId } : {}),
                },
                {
                  userId: actor.userId,
                  principal: actor.principal,
                  tenantExecutionContext: tenantExecutionContextForRequest(
                    c.req.raw,
                  ),
                  clientOrigin: resolveClientOriginForRequest(c.req.raw),
                },
              );
            const result = dispatched.result as
              | {
                  outcome: InterruptSessionResult['outcome'];
                  turnId?: string;
                }
              | undefined;
            if (!result)
              return {
                settle: 'release',
                result: {
                  outcome: 'failed',
                  detail: 'The interrupt did not report an outcome.',
                },
              };
            return {
              // Nothing to interrupt had no effect: free the key, as a refused
              // send does, so the same request can run when a turn is running.
              settle: result.outcome === 'no-active-turn' ? 'release' : 'final',
              result: {
                outcome: result.outcome,
                sessionId: target.threadId,
                ...(result.turnId ? { turnId: result.turnId } : {}),
              },
            };
          } catch (error) {
            return {
              settle: 'release',
              result: { outcome: 'failed', detail: errorMessage(error) },
            };
          }
        },
      );
      if (outcome.kind !== 'executed' && outcome.kind !== 'replayed')
        return keyRefusal(c, outcome);
      if (outcome.result.outcome === 'failed')
        return c.json({ success: false, error: outcome.result.detail }, 400);
      return c.json({
        success: true,
        data: {
          ...outcome.result,
          ...(outcome.kind === 'replayed' ? { replayed: true } : {}),
        },
      });
    },
  );

  app.get('/:sessionId/wait', async (c) => {
    const caller = callerOf(c);
    if (caller instanceof Response) return caller;
    const sessionId = c.req.param('sessionId');
    const parsed = waitSessionQuerySchema.safeParse(c.req.query());
    if (!parsed.success)
      return c.json(
        {
          success: false,
          code: 'invalid_request',
          error: 'Validation failed',
          details: parsed.error.flatten(),
        },
        400,
      );
    // A wait reads: it needs only that the owner may read the Session. It
    // watches exactly the Session named (a returned `sessionId`), because its
    // cursor counts that Session's events.
    if (
      !deps.orchestrationService.canUserReadSession(
        sessionId,
        readAuthorityFor(c),
      )
    )
      return notFound(c);
    const result = await waiter.wait({
      callerSessionId: caller.sessionId,
      threadId: sessionId,
      until: parsed.data.until,
      timeoutMs: parsed.data.timeoutMs,
      ...(parsed.data.afterEventCursor !== undefined
        ? { afterEventCursor: parsed.data.afterEventCursor }
        : {}),
      signal: c.req.raw.signal,
    });
    if (result.kind === 'capacity')
      return c.json(
        {
          success: false,
          code: 'wait_capacity',
          error:
            result.scope === 'caller'
              ? 'This session already has the most waits Station allows at once. Let one finish, then wait again.'
              : 'Station is serving the most waits it allows at once. Wait again shortly.',
        },
        429,
      );
    if (result.kind === 'aborted')
      return c.json(
        {
          success: false,
          code: 'wait_aborted',
          error: 'The wait was cancelled.',
        },
        408,
      );
    const { kind, ...state } = result;
    // The wait watched exactly the Session named. When a successor now serves
    // the conversation, say so: the named Session will not see its turns.
    const current = actingSession(sessionId).threadId;
    return c.json({
      success: true,
      data: {
        sessionId,
        settled: kind === 'settled',
        timedOut: kind === 'timeout',
        ...(current !== sessionId
          ? { superseded: true, currentSessionId: current }
          : {}),
        ...state,
      },
    });
  });

  return app;
}
