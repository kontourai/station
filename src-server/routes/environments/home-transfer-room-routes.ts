import type { HomeTransferRoomIdentityObservation } from '@kontourai/station-contracts/cloud-move';
import { Hono } from 'hono';
import { createPersonalRuntimeRequestGuard } from '../../runtime/bootstrap/runtime-tenant-context.js';
import { readBoundedRequestBody } from '../../security/bounded-request-body.js';
import { currentHomeTransferDevice } from '../../security/home-transfer-request.js';
import type { ProjectTaskRoomRuntime } from '../../services/orchestration/project-task-room-runtime.js';
import type { EnvironmentSecurityService } from '../../services/ssh/environment-security-service.js';

/** Read-only room binding probe. Source closure and target activation stay private. */
export function createHomeTransferRoomRoutes(options: {
  security: Pick<
    EnvironmentSecurityService,
    'identifyDevice' | 'getPublicHandshake'
  >;
  roomRuntime?: Pick<ProjectTaskRoomRuntime, 'inspectTransferRoom'>;
}) {
  const app = new Hono();
  const personal = createPersonalRuntimeRequestGuard();
  const { security, roomRuntime } = options;
  app.post('/:taskId/identity', async (c) => {
    c.header('Cache-Control', 'no-store');
    if (!personal(c.req.raw)) return c.json({ kind: 'denied' }, 403);
    try {
      const device = currentHomeTransferDevice(c.req.raw, security);
      if (!device) return c.json({ kind: 'denied' }, 403);
      if (!roomRuntime) return c.json({ kind: 'unavailable' }, 503);
      const read = await readBoundedRequestBody(c.req.raw, 2048);
      if (read.status !== 'ok')
        return c.json(
          { kind: 'invalid-request' },
          read.status === 'too-large' ? 413 : 400,
        );
      let body: unknown;
      try {
        body = JSON.parse(read.body);
      } catch {
        return c.json({ kind: 'invalid-request' }, 400);
      }
      if (
        !body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        Object.keys(body).sort().join(',') !== 'channelId,nonce'
      )
        return c.json({ kind: 'invalid-request' }, 400);
      const input = body as { channelId: unknown; nonce: unknown };
      if (
        ![input.channelId, input.nonce].every(
          (value) =>
            typeof value === 'string' &&
            value.length > 0 &&
            Buffer.byteLength(value) <= 256 &&
            !Array.from(value).some((character) => {
              const code = character.charCodeAt(0);
              return code < 32 || code === 127;
            }),
        )
      )
        return c.json({ kind: 'invalid-request' }, 400);
      const environment = await security.getPublicHandshake();
      const inspected = await roomRuntime.inspectTransferRoom({
        taskId: c.req.param('taskId'),
        request: c.req.raw,
      });
      if (
        !personal(c.req.raw) ||
        currentHomeTransferDevice(c.req.raw, security)?.id !== device.id
      )
        return c.json({ kind: 'denied' }, 403);
      if (inspected.kind !== 'available')
        return c.json(
          inspected,
          inspected.kind === 'not-found'
            ? 404
            : inspected.kind === 'denied'
              ? 403
              : 503,
        );
      if (
        inspected.channelId !== input.channelId ||
        inspected.taskId !== c.req.param('taskId')
      )
        return c.json({ kind: 'conflict' }, 409);
      const result: HomeTransferRoomIdentityObservation = {
        schemaVersion: 'station.home-transfer-room-identity/v1',
        environmentId: environment.environmentId,
        pairedDeviceId: device.id,
        taskId: inspected.taskId,
        channelId: inspected.channelId,
        nonce: input.nonce as string,
        executionAuthorityTransferred: false,
        executionResumeAvailable: false,
      };
      return c.json(result);
    } catch {
      return c.json({ kind: 'unavailable' }, 503);
    }
  });
  return app;
}
