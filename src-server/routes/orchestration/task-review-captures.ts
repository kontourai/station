import { randomUUID } from 'node:crypto';
import { parseTaskReviewCreateCaptureRequest } from '@kontourai/station-contracts/task-review';
import { type Context, Hono } from 'hono';
import { readBoundedRequestBody } from '../../security/bounded-request-body.js';
import type { BrowserProjectAuthorizer } from '../../services/browser/browser-access.js';
import {
  actorOwnsSessionProfile,
  redactBrowserUrl,
} from '../../services/browser/browser-session-registry.js';
import type {
  ProjectTaskRoomRuntime,
  TaskReviewAccess,
} from '../../services/orchestration/project-task-room-runtime.js';
import {
  type TaskBrowserCapture,
  TaskBrowserCaptureError,
  type TaskCaptureBrowserRegistry,
} from '../../services/projects/task-browser-capture.js';

export function createTaskReviewCaptureRoutes(deps: {
  logger: { warn(message: string, meta?: Record<string, unknown>): void };
  runtime: Pick<ProjectTaskRoomRuntime, 'personTaskReviewAccess'>;
  captures: TaskBrowserCapture;
  registry: TaskCaptureBrowserRegistry;
  authorizeProject: BrowserProjectAuthorizer;
  isStationInternalRequest(request: Request): boolean;
  isRequestPrincipalCurrent(request: Request): boolean;
}) {
  const app = new Hono();
  const captureBoundary = async (c: Context, next: () => Promise<void>) => {
    c.header('Cache-Control', 'no-store');
    if (deps.isStationInternalRequest(c.req.raw))
      return c.json(
        { success: false, code: 'not-found', error: 'Not found.' },
        404,
      );
    await next();
  };
  app.use('/:taskId/review/capture-sessions', captureBoundary);
  app.use('/:taskId/review/captures', captureBoundary);
  app.use('/:taskId/review/captures/*', captureBoundary);
  app.onError((error, c) => {
    if (
      !(error instanceof TaskBrowserCaptureError) ||
      error.cause !== undefined
    ) {
      const unexpected =
        error instanceof TaskBrowserCaptureError ? error.cause : error;
      deps.logger.warn('task review capture request failed', {
        taskId: c.req.param('taskId'),
        errorName:
          unexpected instanceof Error ? unexpected.name : typeof unexpected,
      });
    }
    const code =
      error instanceof TaskBrowserCaptureError
        ? error.code
        : 'capture-unavailable';
    const status =
      code === 'not-found'
        ? 404
        : code === 'forbidden'
          ? 403
          : code === 'invalid-request'
            ? 400
            : code === 'capture-unavailable' || code === 'capture-corrupt'
              ? 503
              : 409;
    return c.json(
      error instanceof TaskBrowserCaptureError
        ? error.response
        : { success: false, code, error: 'Capture unavailable.' },
      status,
    );
  });
  const accessFor = async (c: Context): Promise<TaskReviewAccess> => {
    const access = await deps.runtime.personTaskReviewAccess({
      taskId: c.req.param('taskId')!,
      request: c.req.raw,
    });
    if (access.kind !== 'granted' || !deps.isRequestPrincipalCurrent(c.req.raw))
      throw new TaskBrowserCaptureError('not-found', 'Task not found.');
    return {
      ...access,
      write: {
        ...access.write,
        beforeCommit: () =>
          access.write.beforeCommit() &&
          deps.isRequestPrincipalCurrent(c.req.raw),
      },
    };
  };
  const browserAccess = async (c: Context, access: TaskReviewAccess) => {
    const actor = await deps.authorizeProject(
      c.req.raw,
      access.write.projectId,
      'view',
    );
    if (!actor || !deps.isRequestPrincipalCurrent(c.req.raw))
      throw new TaskBrowserCaptureError(
        'forbidden',
        'Browser view access is required.',
      );
    return actor;
  };
  app.get('/:taskId/review/capture-sessions', async (c) => {
    const access = await accessFor(c);
    const actor = await browserAccess(c, access);
    const sessions = deps.registry
      .listSessions(
        (session) =>
          session.projectId === access.write.projectId &&
          session.state === 'live' &&
          actorOwnsSessionProfile(session, actor),
      )
      .map((session) => ({
        browserSessionId: session.browserSessionId,
        url: redactBrowserUrl(session.url),
        viewport: session.viewport,
      }));
    if (
      !access.write.beforeCommit() ||
      !deps.isRequestPrincipalCurrent(c.req.raw)
    )
      throw new TaskBrowserCaptureError('not-found', 'Task not found.');
    return c.json({ success: true, data: { sessions } });
  });
  app.post('/:taskId/review/captures', async (c) => {
    const access = await accessFor(c);
    const actor = await browserAccess(c, access);
    const body = await readBoundedRequestBody(c.req.raw, 8192);
    let value: unknown;
    try {
      value = body.status === 'ok' ? JSON.parse(body.body) : null;
    } catch {
      value = null;
    }
    const input =
      value && typeof value === 'object' && !Array.isArray(value)
        ? parseTaskReviewCreateCaptureRequest({
            operationId: randomUUID(),
            ...value,
          })
        : null;
    if (input?.sourceKind !== 'browser')
      throw new TaskBrowserCaptureError(
        'invalid-request',
        'Give sourceKind browser and sourceSessionId.',
      );
    const result = await deps.captures.capture(
      access,
      input,
      deps.registry,
      (session) =>
        deps.isRequestPrincipalCurrent(c.req.raw) &&
        actorOwnsSessionProfile(session, actor),
    );
    return c.json({ success: true, data: { capture: result.capture } }, 201);
  });
  app.get('/:taskId/review/captures/:captureId/content', async (c) => {
    const access = await accessFor(c);
    const capture = deps.captures.metadata(access, c.req.param('captureId'));
    const bytes = await deps.captures.content(access, capture.captureId);
    if (!deps.isRequestPrincipalCurrent(c.req.raw))
      throw new TaskBrowserCaptureError('not-found', 'Task not found.');
    c.header('X-Content-Type-Options', 'nosniff');
    return c.body(new Uint8Array(bytes), 200, {
      'Content-Type': capture.mediaType,
    });
  });
  return app;
}
