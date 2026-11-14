/**
 * Remote task engine routes, mounted under `/remote-task-engines`
 * (docs/decisions/remote-task-engines.md). Every route is behind the
 * `remote-task-engines` Feature Preview, which the service reads at each call;
 * an off preview answers 404 `feature_preview_disabled` before any feature
 * state is read or written. Removing a connection, clearing its credential
 * and withdrawing its acknowledgement stay available with the preview off.
 *
 * Who may call (scopes in `pairing-route-scopes.ts`): reads are
 * `orchestration:read`, changes `orchestration:operate`, and setting a token
 * `engine:login`. A request that may be an agent's is refused on every route:
 * a remote task sends prompts and code off this computer, so only a person
 * may start one or read what came back.
 */
import type { Context } from 'hono';
import { Hono } from 'hono';
import { requestMayBeAnAgent } from '../../security/coding-authority.js';
import { getRuntimeAuthenticatedRequestPrincipal } from '../../security/runtime-request-security.js';
import { FeaturePreviewDisabledError } from '../../services/feature-previews/feature-preview-refusal.js';
import { RemoteTaskError } from '../../services/remote-task-engines/remote-task-error.js';
import type { RemoteTaskEngineService } from '../../services/remote-task-engines/service.js';
import type { RemoteTaskTracker } from '../../services/remote-task-engines/tracker.js';
import type { Logger } from '../../utils/logger.js';

export interface RemoteTaskEngineRoutesOptions {
  readonly service: RemoteTaskEngineService;
  readonly tracker: RemoteTaskTracker;
  readonly logger: Logger;
  /**
   * Whether this request is a person's (not an agent's) and authenticated.
   * The runtime auth boundary has already applied the route's scope.
   */
  readonly isPersonRequest?: (request: Request) => boolean;
}

function defaultIsPersonRequest(request: Request): boolean {
  return (
    !!getRuntimeAuthenticatedRequestPrincipal(request) &&
    !requestMayBeAnAgent(request)
  );
}

const NOT_GRANTED = {
  success: false as const,
  code: 'remote-task-not-granted' as const,
  error:
    'Remote tasks are started and read by a person, not by an agent or an unauthenticated request.',
};

function param(c: Context, name: 'id' | 'taskId'): string {
  return c.req.param(name) ?? '';
}

async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json();
    return typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  } catch {
    throw new RemoteTaskError(
      'remote-task-invalid',
      'The request body must be JSON.',
      400,
    );
  }
}

export function createRemoteTaskEngineRoutes(
  options: RemoteTaskEngineRoutesOptions,
): Hono {
  const { service, tracker, logger } = options;
  const isPerson = options.isPersonRequest ?? defaultIsPersonRequest;
  const app = new Hono();

  const refusal = (c: Context, error: unknown) => {
    if (error instanceof FeaturePreviewDisabledError)
      return c.json(error.refusal, 404);
    if (!(error instanceof RemoteTaskError)) {
      // Never forward an unexpected error's text: it may carry vendor detail.
      logger.error('Remote task engine request failed', {
        name: error instanceof Error ? error.name : typeof error,
      });
      return c.json(
        { success: false, error: 'The remote task request failed.' },
        500,
      );
    }
    if (error.details.retryAfterMs !== undefined)
      c.header(
        'Retry-After',
        String(Math.max(1, Math.ceil(error.details.retryAfterMs / 1000))),
      );
    return c.json(
      {
        success: false,
        error: error.message,
        code: error.code,
        ...(error.details.retryAfterMs !== undefined
          ? { retryAfterMs: error.details.retryAfterMs }
          : {}),
        ...(error.details.vendorStatus !== undefined
          ? { vendorStatus: error.details.vendorStatus }
          : {}),
        ...(error.details.vendorCode !== undefined
          ? { vendorCode: error.details.vendorCode }
          : {}),
      },
      error.status as 400,
    );
  };

  /** A person's request, run through the service; refusals mapped once. */
  const handle =
    (work: (c: Context) => Promise<unknown> | unknown, status = 200) =>
    async (c: Context) => {
      if (!isPerson(c.req.raw)) return c.json(NOT_GRANTED, 403);
      try {
        const data = await work(c);
        return c.json({ success: true, data: data ?? null }, status as 200);
      } catch (error) {
        return refusal(c, error);
      }
    };

  app.get(
    '/connections',
    handle(() => service.listConnections()),
  );
  app.post(
    '/connections',
    handle(async (c) => service.createConnection(await jsonBody(c)), 201),
  );
  app.get(
    '/connections/:id',
    handle((c) => service.getConnection(param(c, 'id'))),
  );
  app.patch(
    '/connections/:id',
    handle(async (c) =>
      service.updateConnection(param(c, 'id'), await jsonBody(c)),
    ),
  );
  app.delete(
    '/connections/:id',
    handle(async (c) => {
      await service.deleteConnection(param(c, 'id'));
    }),
  );
  app.post(
    '/connections/:id/acknowledgement',
    handle(async (c) =>
      service.acknowledge(param(c, 'id'), (await jsonBody(c)).statement),
    ),
  );
  app.delete(
    '/connections/:id/acknowledgement',
    handle(async (c) => {
      await service.revokeAcknowledgement(param(c, 'id'));
    }),
  );
  app.put(
    '/connections/:id/credential',
    handle(async (c) => {
      await service.setCredential(param(c, 'id'), (await jsonBody(c)).token);
      // Never echo the token: the answer is only whether one is set.
      return { credential: 'set' };
    }),
  );
  app.delete(
    '/connections/:id/credential',
    handle(async (c) => {
      await service.clearCredential(param(c, 'id'));
      return { credential: 'missing' };
    }),
  );

  app.get(
    '/connections/:id/tasks',
    handle((c) =>
      service.listTasks(param(c, 'id'), c.req.query('cursor') ?? null),
    ),
  );
  app.post(
    '/connections/:id/tasks',
    handle(async (c) => {
      const id = param(c, 'id');
      const task = await service.createTask(id, await jsonBody(c));
      tracker.noteInterest(id, task.taskId);
      return task;
    }, 201),
  );
  app.get(
    '/connections/:id/tasks/:taskId',
    handle(async (c) => {
      const id = param(c, 'id');
      const taskId = param(c, 'taskId');
      const task = await service.getTask(id, taskId);
      tracker.noteInterest(id, taskId);
      return task;
    }),
  );
  app.post(
    '/connections/:id/tasks/:taskId/messages',
    handle(async (c) => {
      const id = param(c, 'id');
      const taskId = param(c, 'taskId');
      const result = await service.sendMessage(
        id,
        taskId,
        (await jsonBody(c)).text,
      );
      tracker.noteInterest(id, taskId);
      return result;
    }),
  );
  app.post(
    '/connections/:id/tasks/:taskId/cancel',
    handle(async (c) => {
      const id = param(c, 'id');
      const taskId = param(c, 'taskId');
      await service.cancelTask(id, taskId);
      tracker.noteInterest(id, taskId);
    }),
  );
  app.post(
    '/connections/:id/tasks/:taskId/sync',
    handle(async (c) => {
      const id = param(c, 'id');
      const taskId = param(c, 'taskId');
      const result = await service.syncTask(id, taskId);
      tracker.noteInterest(id, taskId);
      return result;
    }),
  );
  /**
   * Stored messages after Station's own sequence. `after` (or a
   * `Last-Event-ID` header, the orchestration stream's resume cursor) is the
   * last sequence the client holds; a reconnecting client sends it back and
   * receives only what followed. Reading keeps the task polled for the
   * tracker's interest window: nothing is polled that nobody reads.
   */
  app.get(
    '/connections/:id/tasks/:taskId/events',
    handle((c) => {
      const raw = c.req.query('after') ?? c.req.header('last-event-id') ?? '0';
      if (!/^\d{1,15}$/.test(raw))
        throw new RemoteTaskError(
          'remote-task-invalid',
          'after must be a sequence number',
          400,
        );
      const id = param(c, 'id');
      const taskId = param(c, 'taskId');
      const read = service.readEvents(id, taskId, Number(raw));
      tracker.noteInterest(id, taskId);
      return read;
    }),
  );

  return app;
}
