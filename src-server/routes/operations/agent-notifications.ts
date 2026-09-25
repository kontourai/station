/**
 * The `notify_user` tool's REST side (#2584), mounted at
 * `/api/notifications/agent`.
 *
 * Only Station's own station-control tool code calls this. A request the
 * runtime boundary did not accept as Station's internal principal gets a
 * 404, so a paired device or operator credential learns nothing here. Every
 * request re-derives the VERIFIED caller from the credential the tool
 * forwarded (`resolveStationControlCallerForRequest`); the tool's own check
 * is only an early answer, this is the enforcement. A body never names the
 * session, project or agent.
 *
 * Answers are a `NotifyUserResult` the tool hands to the model as-is.
 */
import type { NotifyUserResult } from '@kontourai/station-contracts/notification';
import { Hono } from 'hono';
import { readBoundedRequestBody } from '../../security/bounded-request-body.js';
import {
  type AgentNotificationGate,
  parseNotifyUserRequest,
  recordAgentNotification,
} from '../../services/notifications/agent-notification-gate.js';
import type { StationControlCaller } from '../../tools/station-control-shared.js';

export const AGENT_NOTIFICATION_API_PATH = '/api/notifications/agent';

const MAX_BODY_BYTES = 8 * 1024;

export interface AgentNotificationRoutesDeps {
  /** True only for Station's own internal principal. */
  isInternalRequest(request: Request): boolean;
  /** The verified station-control caller the request's credential names. */
  resolveCaller(request: Request): StationControlCaller | null;
  gate: Pick<AgentNotificationGate, 'notify'>;
}

export function createAgentNotificationRoutes(
  deps: AgentNotificationRoutesDeps,
) {
  const app = new Hono();

  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (!deps.isInternalRequest(c.req.raw))
      return c.json({ error: { code: 'not_found' } }, 404);
    await next();
  });

  app.post('/', async (c) => {
    const caller = deps.resolveCaller(c.req.raw);
    if (!caller) {
      recordAgentNotification('caller-required', 'unknown');
      return c.json(
        { status: 'caller-required' } satisfies NotifyUserResult,
        403,
      );
    }
    const read = await readBoundedRequestBody(c.req.raw, MAX_BODY_BYTES);
    let parsed: unknown;
    try {
      parsed = read.status === 'ok' ? JSON.parse(read.body) : undefined;
    } catch {
      parsed = undefined;
    }
    const request = parseNotifyUserRequest(parsed);
    if (!request)
      return c.json(
        {
          error: {
            code: 'invalid_request',
            message:
              'notify_user needs a title (1-80 characters) and optional body (≤300), urgency, dedupeKey and relative link.',
          },
        },
        400,
      );
    const result = await deps.gate.notify(caller, request);
    return c.json(result satisfies NotifyUserResult, 200);
  });

  return app;
}
