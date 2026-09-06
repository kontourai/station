import type {
  HomeTransferRoomIdentityObservation,
  HomeTransferRoomSealObservation,
} from '@kontourai/station-contracts/cloud-move';
import { Hono } from 'hono';
import { createPersonalRuntimeRequestGuard } from '../../runtime/bootstrap/runtime-tenant-context.js';
import { readBoundedRequestBody } from '../../security/bounded-request-body.js';
import { currentHomeTransferDevice } from '../../security/home-transfer-request.js';
import type { ProjectTaskRoomRuntime } from '../../services/orchestration/project-task-room-runtime.js';
import type { EnvironmentSecurityService } from '../../services/ssh/environment-security-service.js';

async function readInput(
  request: Request,
  keys: string[],
): Promise<
  | { kind: 'input'; value: Record<string, string> }
  | { kind: 'invalid'; status: 400 | 413 }
> {
  const read = await readBoundedRequestBody(request, 2048);
  if (read.status !== 'ok')
    return { kind: 'invalid', status: read.status === 'too-large' ? 413 : 400 };
  try {
    const value: unknown = JSON.parse(read.body);
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== [...keys].sort().join(',')
    )
      return { kind: 'invalid', status: 400 };
    const input = value as Record<string, unknown>;
    if (
      !keys.every((key) => {
        const text = input[key];
        return (
          typeof text === 'string' &&
          text.length > 0 &&
          Buffer.byteLength(text) <= 256 &&
          !Array.from(text).some((character) => {
            const code = character.charCodeAt(0);
            return code < 32 || code === 127;
          })
        );
      })
    )
      return { kind: 'invalid', status: 400 };
    return { kind: 'input', value: input as Record<string, string> };
  } catch {
    return { kind: 'invalid', status: 400 };
  }
}

/** Read-only binding and checkpoint probes; never source closure or activation. */
export function createHomeTransferRoomRoutes(options: {
  security: Pick<
    EnvironmentSecurityService,
    'identifyDevice' | 'getPublicHandshake'
  >;
  roomRuntime?: Pick<ProjectTaskRoomRuntime, 'inspectTransferRoom'> &
    Partial<Pick<ProjectTaskRoomRuntime, 'readTransferSourceSeal'>>;
}) {
  const app = new Hono();
  const personal = createPersonalRuntimeRequestGuard();
  const { security, roomRuntime } = options;
  const inspect = roomRuntime?.inspectTransferRoom.bind(roomRuntime);
  const readSeal = roomRuntime?.readTransferSourceSeal?.bind(roomRuntime);
  const current = (request: Request, deviceId: string) =>
    personal(request) &&
    currentHomeTransferDevice(request, security)?.id === deviceId;
  app.post('/:taskId/identity', async (c) => {
    c.header('Cache-Control', 'no-store');
    if (!personal(c.req.raw)) return c.json({ kind: 'denied' }, 403);
    try {
      const device = currentHomeTransferDevice(c.req.raw, security);
      if (!device) return c.json({ kind: 'denied' }, 403);
      if (!inspect) return c.json({ kind: 'unavailable' }, 503);
      const parsed = await readInput(c.req.raw, ['channelId', 'nonce']);
      if (parsed.kind !== 'input')
        return c.json({ kind: 'invalid-request' }, parsed.status);
      const input = parsed.value;
      const environment = await security.getPublicHandshake();
      const inspected = await inspect({
        taskId: c.req.param('taskId'),
        request: c.req.raw,
      });
      if (!current(c.req.raw, device.id))
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
        nonce: input.nonce,
        executionAuthorityTransferred: false,
        executionResumeAvailable: false,
      };
      return c.json(result);
    } catch {
      return c.json({ kind: 'unavailable' }, 503);
    }
  });
  app.post('/:taskId/seal-observation', async (c) => {
    c.header('Cache-Control', 'no-store');
    if (!personal(c.req.raw)) return c.json({ kind: 'denied' }, 403);
    try {
      const device = currentHomeTransferDevice(c.req.raw, security);
      if (!device) return c.json({ kind: 'denied' }, 403);
      if (!readSeal) return c.json({ kind: 'unavailable' }, 503);
      const parsed = await readInput(c.req.raw, [
        'channelId',
        'nonce',
        'operationId',
        'sourceHomeRef',
        'targetHomeRef',
      ]);
      if (parsed.kind !== 'input')
        return c.json({ kind: 'invalid-request' }, parsed.status);
      const input = parsed.value;
      if (input.sourceHomeRef === input.targetHomeRef)
        return c.json({ kind: 'invalid-request' }, 400);
      const environment = await security.getPublicHandshake();
      const observed = await readSeal({
        taskId: c.req.param('taskId'),
        request: c.req.raw,
        channelId: input.channelId,
        operationId: input.operationId,
        sourceHomeRef: input.sourceHomeRef,
        targetHomeRef: input.targetHomeRef,
      });
      if (!current(c.req.raw, device.id))
        return c.json({ kind: 'denied' }, 403);
      if (observed.kind !== 'sealed' && observed.kind !== 'unsealed')
        return c.json(
          observed,
          observed.kind === 'not-found'
            ? 404
            : observed.kind === 'denied'
              ? 403
              : observed.kind === 'conflict'
                ? 409
                : 503,
        );
      const common = {
        schemaVersion: 'station.home-transfer-room-seal/v1' as const,
        environmentId: environment.environmentId,
        pairedDeviceId: device.id,
        taskId: c.req.param('taskId'),
        channelId: input.channelId,
        nonce: input.nonce,
        executionAuthorityTransferred: false as const,
        executionResumeAvailable: false as const,
      };
      const result: HomeTransferRoomSealObservation =
        observed.kind === 'sealed'
          ? { ...common, kind: 'sealed', seal: observed.seal }
          : { ...common, kind: 'unsealed' };
      return c.json(result);
    } catch {
      return c.json({ kind: 'unavailable' }, 503);
    }
  });
  return app;
}
