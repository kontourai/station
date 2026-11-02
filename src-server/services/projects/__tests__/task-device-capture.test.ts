import { expect, test, vi } from 'vitest';
import type { DeviceAccess } from '../../devices/device-access.js';
import type { DeviceSessionService } from '../../devices/device-session-service.js';
import { LiveSurfaceRegistry } from '../../live-surface/registry.js';
import type { LocalMobileDeviceHost } from '../../mobile-device/mobile-device-host.js';
import type { TaskReviewAccess } from '../../orchestration/project-task-room-runtime.js';
import type { TaskBrowserCapture } from '../task-browser-capture.js';
import { TaskDeviceCapture } from '../task-device-capture.js';

const session = {
  hostId: 'ssh-123456abcdef',
  platform: 'ios' as const,
  deviceId: 'device',
  sessionId: 'session',
  surfaceId: 'surface',
  name: 'iPhone',
  runtime: 'iOS',
  openedAt: '2026-01-01T00:00:00Z',
};
const input = {
  sourceKind: 'device' as const,
  sourceSessionId: 'ssh-123456abcdef:session',
  operationId: 'operation',
};
const request = new Request(
  'https://station.test/api/tasks/t/review/device-captures?projectSlug=project',
);
const access = {
  write: { projectId: 'p', beforeCommit: () => true },
} as unknown as TaskReviewAccess;

function fixture() {
  let allowed = true;
  let revision = 1;
  const capture = vi.fn(async () => ({
    pngBase64: 'aGVsbG8=',
    mimeType: 'image/png' as const,
  }));
  const host = { capture } as unknown as Pick<LocalMobileDeviceHost, 'capture'>;
  const list = vi.fn(() => [session]);
  const sessions = {
    list,
    get: (id: string) => (id === 'session' ? session : undefined),
  } as unknown as Pick<DeviceSessionService, 'list' | 'get'>;
  const deviceAccess = {
    mayAccessDevice: async (_request, _platform, _id, _purpose, hostId) =>
      allowed && hostId === session.hostId,
  } as DeviceAccess;
  const publish = vi.fn(async (_access, _input, source) => {
    const shot = await source.screenshot();
    if (!(await source.isCurrent()) || !source.isFenceCurrent())
      throw new Error('interrupted');
    return { capture: { captureId: 'capture' }, screenshot: shot };
  });
  const service = new TaskDeviceCapture({
    captures: { captureSource: publish } as unknown as Pick<
      TaskBrowserCapture,
      'captureSource'
    >,
    access: deviceAccess,
    hostIds: () => [session.hostId],
    host: (id) => (id === session.hostId ? { host, sessions } : undefined),
    hostRevision: () => revision,
    projectMatches: (_request, id) => id === 'p',
    requestCurrent: () => true,
  });
  return {
    service,
    list,
    capture,
    publish,
    revoke: () => {
      allowed = false;
    },
    retarget: () => {
      revision += 1;
    },
  };
}

test('captures only the selected host-qualified session', async () => {
  const f = fixture();
  expect((await f.service.list(request, access))[0]?.sourceSessionId).toBe(
    input.sourceSessionId,
  );
  await f.service.capture(request, access, input);
  expect(f.capture).toHaveBeenCalledWith(session);
  await expect(
    f.service.capture(request, access, {
      ...input,
      sourceSessionId: 'local:session',
    }),
  ).rejects.toThrow();
  expect(f.capture).toHaveBeenCalledTimes(1);
});

test('refuses an oversized session listing rather than silently truncating it', async () => {
  const f = fixture();
  f.list.mockReturnValue(Array.from({ length: 201 }, () => session));
  await expect(f.service.list(request, access)).rejects.toThrow(
    'Too many Device sessions',
  );
});

test('refuses publication when device access or host revision changes during capture', async () => {
  for (const change of ['revoke', 'retarget'] as const) {
    const f = fixture();
    f.capture.mockImplementationOnce(async () => {
      f[change]();
      return { pngBase64: 'aGVsbG8=', mimeType: 'image/png' };
    });
    await expect(f.service.capture(request, access, input)).rejects.toThrow(
      'interrupted',
    );
  }
});

test('a recording source follows the selected host and loses authorization on revocation', async () => {
  const f = fixture();
  const surfaces = new LiveSurfaceRegistry();
  surfaces.register({
    surfaceId: session.surfaceId,
    capabilities: { codecs: ['jpeg'], input: [] },
    start: async () => {},
    stop: async () => {},
    ack: () => {},
    dispatch: async () => {},
  });
  try {
    const source = await f.service.recordingSource(
      request,
      access,
      input.sourceSessionId,
      surfaces,
      () => true,
    );
    expect(source.device).toMatchObject({
      hostId: session.hostId,
      deviceId: session.deviceId,
      appId: null,
      appObservedAt: null,
    });
    expect(await source.authorize()).toBe(true);
    f.revoke();
    expect(await source.authorize()).toBe(false);
  } finally {
    await surfaces.dispose();
  }
});
