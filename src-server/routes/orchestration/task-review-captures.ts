import { randomUUID } from 'node:crypto';
import { parseTaskReviewCreateCaptureRequest } from '@kontourai/station-contracts/task-review';
import type { Walkthrough } from '@kontourai/station-contracts/walkthrough';
import { type Context, Hono } from 'hono';
import { readBoundedRequestBody } from '../../security/bounded-request-body.js';
import type { BrowserProjectAuthorizer } from '../../services/browser/browser-access.js';
import {
  actorOwnsSessionProfile,
  redactBrowserUrl,
} from '../../services/browser/browser-session-registry.js';
import {
  FeaturePreviewDisabledError,
  requireFeaturePreview,
} from '../../services/feature-previews/feature-preview-refusal.js';
import type { FeaturePreviewSelector } from '../../services/feature-previews/feature-preview-registry.js';
import type { LiveSurfaceRegistry } from '../../services/live-surface/registry.js';
import type {
  ProjectTaskRoomRuntime,
  TaskReviewAccess,
} from '../../services/orchestration/project-task-room-runtime.js';
import {
  type TaskBrowserCapture,
  TaskBrowserCaptureError,
  type TaskCaptureBrowserRegistry,
} from '../../services/projects/task-browser-capture.js';
import type { TaskDeviceCapture } from '../../services/projects/task-device-capture.js';
import type { TaskDeviceRecording } from '../../services/projects/task-device-recording.js';
import type { TaskWalkthroughStore } from '../../services/walkthroughs/task-walkthrough-store.js';
import { BROWSER_RECORD_MAX_DURATION_MS } from '../../tools/station-browser-policy.js';

export function createTaskReviewCaptureRoutes(deps: {
  logger: { warn(message: string, meta?: Record<string, unknown>): void };
  runtime: Pick<ProjectTaskRoomRuntime, 'personTaskReviewAccess'>;
  captures: TaskBrowserCapture;
  devices?: TaskDeviceCapture;
  deviceRecordings?: {
    manager: TaskDeviceRecording;
    surfaces: Pick<LiveSurfaceRegistry, 'get'>;
    enabled(): boolean;
    walkthroughPreview: FeaturePreviewSelector;
  };
  walkthroughs?: {
    store: TaskWalkthroughStore;
    preview: FeaturePreviewSelector;
  };
  registry: TaskCaptureBrowserRegistry;
  localProjectIdFor(identity: string): string | undefined;
  authorizeProject: BrowserProjectAuthorizer;
  isStationInternalRequest(request: Request): boolean;
  isRequestPrincipalCurrent(request: Request): boolean;
}) {
  const app = new Hono();
  const presentWalkthrough = (
    item: Walkthrough,
    includeDevice: boolean,
  ): Walkthrough => {
    if (includeDevice || !item.source.device) return item;
    const { device: _device, ...source } = item.source;
    return { ...item, source };
  };
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
  app.use('/:taskId/review/device-capture-sessions', captureBoundary);
  app.use('/:taskId/review/device-captures', captureBoundary);
  app.use('/:taskId/review/device-recordings', captureBoundary);
  app.use('/:taskId/review/device-recordings/*', captureBoundary);
  app.use('/:taskId/review/captures', captureBoundary);
  app.use('/:taskId/review/captures/*', captureBoundary);
  app.use('/:taskId/review/walkthroughs', captureBoundary);
  app.use('/:taskId/review/walkthroughs/*', captureBoundary);
  app.onError((error, c) => {
    if (error instanceof FeaturePreviewDisabledError)
      return c.json(error.refusal, 404);
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
    const projectId = deps.localProjectIdFor(access.write.projectId);
    if (!projectId)
      throw new TaskBrowserCaptureError('not-found', 'Task Project not found.');
    const actor = await deps.authorizeProject(c.req.raw, projectId, 'view');
    if (!actor || !deps.isRequestPrincipalCurrent(c.req.raw))
      throw new TaskBrowserCaptureError(
        'forbidden',
        'Browser view access is required.',
      );
    return { actor, projectId };
  };
  app.get('/:taskId/review/capture-sessions', async (c) => {
    const access = await accessFor(c);
    const { actor, projectId } = await browserAccess(c, access);
    const sessions = deps.registry
      .listSessions(
        (session) =>
          session.projectId === projectId &&
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
  app.get('/:taskId/review/device-capture-sessions', async (c) => {
    const access = await accessFor(c);
    if (!deps.devices)
      throw new TaskBrowserCaptureError(
        'capture-unavailable',
        'Device capture is unavailable.',
      );
    const sessions = await deps.devices.list(c.req.raw, access);
    return c.json({ success: true, data: { sessions } });
  });
  app.post('/:taskId/review/captures', async (c) => {
    const access = await accessFor(c);
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
    if (!input)
      throw new TaskBrowserCaptureError(
        'invalid-request',
        'Give a valid source and session.',
      );
    if (input.sourceKind !== 'browser')
      throw new TaskBrowserCaptureError(
        'invalid-request',
        'Give a Browser source.',
      );
    const { actor } = await browserAccess(c, access);
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
  app.post('/:taskId/review/device-captures', async (c) => {
    const access = await accessFor(c);
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
    if (!input || input.sourceKind !== 'device')
      throw new TaskBrowserCaptureError(
        'invalid-request',
        'Give a valid Device source.',
      );
    if (!deps.devices)
      throw new TaskBrowserCaptureError(
        'capture-unavailable',
        'Device capture is unavailable.',
      );
    const result = await deps.devices.capture(c.req.raw, access, input);
    return c.json({ success: true, data: { capture: result.capture } }, 201);
  });

  app.post('/:taskId/review/device-recordings', async (c) => {
    const access = await accessFor(c);
    const recording = deps.deviceRecordings;
    if (!recording || !deps.devices)
      throw new TaskBrowserCaptureError(
        'capture-unavailable',
        'Device recording is unavailable.',
      );
    requireFeaturePreview(
      recording.walkthroughPreview,
      'walkthroughs',
      'Walkthroughs',
    );
    if (!recording.enabled())
      return c.json(
        {
          success: false,
          error: 'Enable Device developer loop in Feature previews.',
          code: 'feature_preview_disabled',
          previewId: 'device-developer-loop',
          settingsPath:
            '/settings?view=feature-previews&highlight=feature-previews',
        },
        404,
      );
    const body = await readBoundedRequestBody(c.req.raw, 8192);
    let value: unknown;
    try {
      value = body.status === 'ok' ? JSON.parse(body.body) : null;
    } catch {
      value = null;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new TaskBrowserCaptureError(
        'invalid-request',
        'Give a valid recording request.',
      );
    const input = value as Record<string, unknown>;
    if (
      Object.keys(input).some(
        (key) => !['sourceSessionId', 'durationMs', 'label'].includes(key),
      ) ||
      typeof input.sourceSessionId !== 'string' ||
      !Number.isSafeInteger(input.durationMs) ||
      (input.durationMs as number) < 1 ||
      (input.durationMs as number) > BROWSER_RECORD_MAX_DURATION_MS
    )
      throw new TaskBrowserCaptureError(
        'invalid-request',
        'Give a valid recording request.',
      );
    const parsed = parseTaskReviewCreateCaptureRequest({
      sourceKind: 'device',
      sourceSessionId: input.sourceSessionId,
      label: input.label,
      operationId: randomUUID(),
    });
    if (!parsed)
      throw new TaskBrowserCaptureError(
        'invalid-request',
        'Give a valid Device source.',
      );
    const devices = deps.devices;
    const job = recording.manager.start(
      access,
      {
        durationMs: input.durationMs as number,
        ...(parsed.label ? { label: parsed.label } : {}),
      },
      () =>
        devices.recordingSource(
          c.req.raw,
          access,
          parsed.sourceSessionId,
          recording.surfaces,
          recording.enabled,
        ),
    );
    return c.json({ success: true, data: job }, 202);
  });
  app.get('/:taskId/review/device-recordings/:jobId', async (c) => {
    const access = await accessFor(c);
    if (!deps.deviceRecordings)
      throw new TaskBrowserCaptureError(
        'capture-unavailable',
        'Device recording is unavailable.',
      );
    return c.json({
      success: true,
      data: deps.deviceRecordings.manager.status(access, c.req.param('jobId')),
    });
  });
  app.post('/:taskId/review/device-recordings/:jobId/stop', async (c) => {
    const access = await accessFor(c);
    if (!deps.deviceRecordings)
      throw new TaskBrowserCaptureError(
        'capture-unavailable',
        'Device recording is unavailable.',
      );
    return c.json({
      success: true,
      data: await deps.deviceRecordings.manager.stop(
        access,
        c.req.param('jobId'),
      ),
    });
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
  const walkthroughs = () => {
    if (!deps.walkthroughs)
      throw new TaskBrowserCaptureError(
        'not-found',
        'Task Walkthroughs unavailable.',
      );
    requireFeaturePreview(
      deps.walkthroughs.preview,
      'walkthroughs',
      'Walkthroughs',
    );
    return deps.walkthroughs.store;
  };
  app.get('/:taskId/review/walkthroughs', async (c) => {
    const store = walkthroughs();
    const access = await accessFor(c);
    const rawLimit = c.req.query('limit');
    const cursor = c.req.query('cursor');
    const page = await store.list(
      access,
      rawLimit === undefined
        ? undefined
        : /^\d+$/.test(rawLimit)
          ? Number(rawLimit)
          : NaN,
      cursor,
    );
    walkthroughs();
    if (!deps.isRequestPrincipalCurrent(c.req.raw))
      throw new TaskBrowserCaptureError('not-found', 'Task not found.');
    return c.json({
      success: true,
      data: {
        ...page,
        items: page.items.map((item) =>
          presentWalkthrough(item, c.req.query('deviceIdentity') === '1'),
        ),
      },
    });
  });
  app.get('/:taskId/review/walkthroughs/:walkthroughId', async (c) => {
    const store = walkthroughs();
    const access = await accessFor(c);
    const item = await store.get(access, c.req.param('walkthroughId'));
    walkthroughs();
    if (!item || !deps.isRequestPrincipalCurrent(c.req.raw))
      throw new TaskBrowserCaptureError(
        'not-found',
        'Task Walkthrough not found.',
      );
    return c.json({
      success: true,
      data: {
        walkthrough: presentWalkthrough(
          item,
          c.req.query('deviceIdentity') === '1',
        ),
      },
    });
  });
  app.get('/:taskId/review/walkthroughs/:walkthroughId/video', async (c) => {
    const store = walkthroughs();
    const access = await accessFor(c);
    const bytes = await store.video(access, c.req.param('walkthroughId'));
    walkthroughs();
    if (!bytes || !deps.isRequestPrincipalCurrent(c.req.raw))
      throw new TaskBrowserCaptureError(
        'not-found',
        'Task Walkthrough not found.',
      );
    c.header('X-Content-Type-Options', 'nosniff');
    return c.body(new Uint8Array(bytes), 200, { 'Content-Type': 'video/webm' });
  });
  app.get(
    '/:taskId/review/walkthroughs/:walkthroughId/frames/:frameId',
    async (c) => {
      const store = walkthroughs();
      const access = await accessFor(c);
      const bytes = await store.frame(
        access,
        c.req.param('walkthroughId'),
        c.req.param('frameId'),
      );
      walkthroughs();
      if (!bytes || !deps.isRequestPrincipalCurrent(c.req.raw))
        throw new TaskBrowserCaptureError(
          'not-found',
          'Task Walkthrough frame not found.',
        );
      c.header('X-Content-Type-Options', 'nosniff');
      return c.body(new Uint8Array(bytes), 200, {
        'Content-Type': 'image/jpeg',
      });
    },
  );
  return app;
}
