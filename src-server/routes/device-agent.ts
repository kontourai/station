import { randomUUID } from 'node:crypto';
import { parseLiveSurfaceInputBatch } from '@kontourai/station-contracts/live-surface';
import { isMobileDeviceHostId } from '@kontourai/station-contracts/mobile-device';
import { parseTaskReviewCreateCaptureRequest } from '@kontourai/station-contracts/task-review';
import { Hono } from 'hono';
import { readBoundedRequestBody } from '../security/bounded-request-body.js';
import {
  authorizeDeviceAgentCaller,
  type DeviceAgentAccessDeps,
} from '../services/devices/device-agent-authority.js';
import type { DeviceAutomation } from '../services/devices/device-automation.js';
import { DeviceSessionError } from '../services/devices/device-session-service.js';
import { DeviceHostBusyError } from '../services/devices/device-shares.js';
import { isDeviceAppId } from '../services/devices/device-tools.js';
import { isValidMobileDeviceId } from '../services/mobile-device/mobile-device-host.js';
import type { ProjectTaskRoomRuntime } from '../services/orchestration/project-task-room-runtime.js';
import {
  type TaskBrowserCapture,
  TaskBrowserCaptureError,
} from '../services/projects/task-browser-capture.js';
import {
  type TaskBrowserRecording,
  TaskBrowserRecordingError,
} from '../services/projects/task-browser-recording.js';
import {
  BROWSER_RECORD_MAX_DURATION_MS,
  BROWSER_RECORD_MAX_ENCODED_BYTES,
} from '../tools/station-browser-policy.js';
import type { StationControlCaller } from '../tools/station-control-shared.js';

export interface DeviceAgentRoutesDeps
  extends Omit<DeviceAgentAccessDeps, 'resolveCaller'> {
  isInternalRequest(request: Request): boolean;
  resolveCaller(request: Request): StationControlCaller | null;
  automation: DeviceAutomation;
  deviceLoopEnabled?: () => boolean;
  taskCapture?():
    | {
        runtime: Pick<ProjectTaskRoomRuntime, 'sessionTaskReviewAccess'>;
        captures: TaskBrowserCapture;
        recordings?: TaskBrowserRecording;
        localProjectIdFor(identity: string): string | undefined;
      }
    | undefined;
}

export function createDeviceAgentRoutes(deps: DeviceAgentRoutesDeps) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (!deps.isInternalRequest(c.req.raw))
      return c.json({ error: { code: 'not_found' } }, 404);
    await next();
  });
  app.onError((error, c) =>
    c.json({
      ok: false,
      code:
        error instanceof DeviceSessionError
          ? error.code
          : error instanceof DeviceHostBusyError
            ? 'device-host-busy'
            : 'device-error',
    }),
  );
  app.post('/:operation', async (c) => {
    const access = {
      ...deps,
      resolveCaller: () => deps.resolveCaller(c.req.raw),
    };
    const decided = await authorizeDeviceAgentCaller(access);
    if (!decided.ok) return c.json(decided);
    const read = await readBoundedRequestBody(c.req.raw, 16 * 1024);
    let body: Record<string, unknown>;
    try {
      const value: unknown =
        read.status === 'ok' ? JSON.parse(read.body || '{}') : null;
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error();
      body = value as Record<string, unknown>;
    } catch {
      return c.json({ ok: false, code: 'invalid-request' });
    }
    const authority = decided.authority;
    const operation = c.req.param('operation');
    if (operation === 'list')
      return c.json(await deps.automation.list(access, authority));
    if (operation === 'open') {
      if (
        (body.reveal !== undefined && typeof body.reveal !== 'boolean') ||
        (body.hostId !== undefined && !isMobileDeviceHostId(body.hostId)) ||
        (body.platform !== 'ios' && body.platform !== 'android') ||
        typeof body.deviceId !== 'string' ||
        !isValidMobileDeviceId(body.platform, body.deviceId)
      )
        return c.json({ ok: false, code: 'invalid-target' });
      return c.json(
        await deps.automation.open(
          access,
          authority,
          {
            hostId: typeof body.hostId === 'string' ? body.hostId : 'local',
            platform: body.platform,
            deviceId: body.deviceId,
          },
          body.reveal !== false,
        ),
      );
    }
    const id = body.deviceSessionId;
    if (typeof id !== 'string' || !id || id.length > 80)
      return c.json({ ok: false, code: 'invalid-request' });
    if (operation === 'record-to-task') {
      if (!deps.deviceLoopEnabled?.())
        return c.json({
          ok: false,
          code: 'feature_preview_disabled',
          previewId: 'device-developer-loop',
          settingsPath:
            '/settings?view=feature-previews&highlight=feature-previews',
        });
      if (
        Object.keys(body).some(
          (key) =>
            !['deviceSessionId', 'label', 'durationMs', 'maxBytes'].includes(
              key,
            ),
        ) ||
        !Number.isSafeInteger(body.durationMs) ||
        (body.durationMs as number) < 1 ||
        (body.durationMs as number) > BROWSER_RECORD_MAX_DURATION_MS ||
        (body.maxBytes !== undefined &&
          (!Number.isSafeInteger(body.maxBytes) ||
            (body.maxBytes as number) < 1 ||
            (body.maxBytes as number) > BROWSER_RECORD_MAX_ENCODED_BYTES))
      )
        return c.json({ ok: false, code: 'invalid-request' });
      const parsed = parseTaskReviewCreateCaptureRequest({
        sourceKind: 'device',
        sourceSessionId: id,
        label: body.label,
        operationId: randomUUID(),
      });
      if (!parsed) return c.json({ ok: false, code: 'invalid-request' });
      const capture = deps.taskCapture?.();
      if (!capture?.recordings)
        return c.json({ ok: false, code: 'recording-unavailable' });
      const taskAccess = await capture.runtime.sessionTaskReviewAccess(
        authority.sessionId,
      );
      if (
        taskAccess.kind !== 'granted' ||
        capture.localProjectIdFor(taskAccess.write.projectId) !==
          authority.projectId
      )
        return c.json({ ok: false, code: 'no_task_binding' });
      try {
        const result = await deps.automation.recordToTask(
          access,
          authority,
          id,
          () => deps.deviceLoopEnabled?.() === true,
          async (source) => {
            const manifest = await capture.recordings!.recordSource(
              taskAccess,
              {
                durationMs: body.durationMs as number,
                ...(body.maxBytes !== undefined
                  ? { maxBytes: body.maxBytes as number }
                  : {}),
                ...(parsed.label ? { label: parsed.label } : {}),
                signal: c.req.raw.signal,
              },
              async () => source,
            );
            return {
              walkthroughId: manifest.id,
              commit: manifest.source.commit,
              recording: manifest.source.recording,
            };
          },
        );
        return c.json(result);
      } catch (error) {
        if (
          error instanceof TaskBrowserRecordingError ||
          error instanceof TaskBrowserCaptureError
        )
          return c.json({
            ok: false,
            code: error.code,
            message: error.response.error,
          });
        throw error;
      }
    }
    if (operation === 'logs') {
      if (!deps.deviceLoopEnabled?.())
        return c.json({
          ok: false,
          code: 'feature_preview_disabled',
          previewId: 'device-developer-loop',
          settingsPath:
            '/settings?view=feature-previews&highlight=feature-previews',
        });
      if (
        Object.keys(body).some(
          (key) => key !== 'deviceSessionId' && key !== 'appId',
        ) ||
        !isDeviceAppId(body.appId)
      )
        return c.json({ ok: false, code: 'invalid-request' });
      return c.json(
        await deps.automation.logs(
          access,
          authority,
          id,
          body.appId,
          () => deps.deviceLoopEnabled?.() === true,
        ),
      );
    }
    if (operation === 'capture-to-task') {
      if (
        Object.keys(body).some(
          (key) => key !== 'deviceSessionId' && key !== 'label',
        )
      )
        return c.json({ ok: false, code: 'invalid-request' });
      const input = parseTaskReviewCreateCaptureRequest({
        sourceKind: 'device',
        sourceSessionId: id,
        label: body.label,
        operationId: randomUUID(),
      });
      if (!input) return c.json({ ok: false, code: 'invalid-request' });
      const capture = deps.taskCapture?.();
      if (!capture) return c.json({ ok: false, code: 'capture-unavailable' });
      const taskAccess = await capture.runtime.sessionTaskReviewAccess(
        authority.sessionId,
      );
      if (
        taskAccess.kind !== 'granted' ||
        capture.localProjectIdFor(taskAccess.write.projectId) !==
          authority.projectId
      )
        return c.json({ ok: false, code: 'no_task_binding' });
      try {
        const result = await deps.automation.captureToTask(
          access,
          authority,
          id,
          (source) => capture.captures.captureSource(taskAccess, input, source),
        );
        if (!result.ok) return c.json(result);
        return c.json({
          ok: true,
          captureId: result.capture.captureId,
          commit: result.capture.commit,
          digest: result.capture.digest,
          screenshot: result.screenshot,
        });
      } catch (error) {
        if (error instanceof TaskBrowserCaptureError)
          return c.json({
            ok: false,
            code: error.code,
            message: error.response.error,
          });
        throw error;
      }
    }
    if (operation === 'input') {
      const batch = parseLiveSurfaceInputBatch({
        epoch: 0,
        events: body.events,
      });
      if (!batch) return c.json({ ok: false, code: 'invalid-request' });
      return c.json(
        await deps.automation.input(access, authority, id, batch.events),
      );
    }
    if (operation === 'screenshot' || operation === 'snapshot')
      return c.json(
        await deps.automation.observe(
          access,
          authority,
          id,
          operation === 'screenshot',
        ),
      );
    if (operation === 'close')
      return c.json(await deps.automation.close(access, authority, id));
    return c.json({ ok: false, code: 'invalid-request' });
  });
  return app;
}
