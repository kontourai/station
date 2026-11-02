/** Real device automation, room binding, Git pins, SQLite and blobs; device hardware is doubled. */
import { EventEmitter } from 'node:events';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MobileDeviceInventory } from '@kontourai/station-contracts/mobile-device';
import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import { TASK_REVIEW_LIMITS } from '@kontourai/station-contracts/task-review';
import { Hono } from 'hono';
import { afterEach, expect, test, vi } from 'vitest';
import type WebSocket from 'ws';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { resolveStationControlCallerFromToken } from '../../runtime/mcp/station-control-caller.js';
import {
  mintStationControlMcpToken,
  revokeStationControlMcpToken,
} from '../../runtime/mcp/station-control-mcp-token.js';
import { createBrowserPrincipalAuthorizer } from '../../services/browser/browser-agent-authority.js';
import { DeviceAutomation } from '../../services/devices/device-automation.js';
import { DeviceSessionService } from '../../services/devices/device-session-service.js';
import {
  claimHumanControl,
  LiveSurfaceRegistry,
} from '../../services/live-surface/registry.js';
import { MobileDeviceHostError } from '../../services/mobile-device/mobile-device-host.js';
import { EventStore } from '../../services/orchestration/event-store.js';
import { ProjectTaskRoomRuntime } from '../../services/orchestration/project-task-room-runtime.js';
import { TaskReviewSend } from '../../services/orchestration/task-review-send.js';
import { TaskBrowserCapture } from '../../services/projects/task-browser-capture.js';
import type { TaskBrowserRecording } from '../../services/projects/task-browser-recording.js';
import { TaskCaptureBlobStore } from '../../services/projects/task-capture-blob-store.js';
import { TaskDeviceCapture } from '../../services/projects/task-device-capture.js';
import { TaskDeviceRecording } from '../../services/projects/task-device-recording.js';
import { TaskReviewModule } from '../../services/projects/task-review-module.js';
import { STATION_CONTROL_CALLER_TOKEN_HEADER } from '../../tools/station-control-shared.js';
import { execGit } from '../../utils/git-exec.js';
import { createDeviceAgentRoutes } from '../device-agent.js';
import { createTaskReviewRoutes } from '../orchestration/task-review.js';
import { createTaskReviewCaptureRoutes } from '../orchestration/task-review-captures.js';

const temporary = trackTempDirs();
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});
const OPERATOR = 'human:local:operator';
const PROJECT = 'bedbf164-242c-48c1-b1f2-ea1d9fddd20e';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=',
  'base64',
);
async function git(cwd: string, args: string[]) {
  return (
    await execGit(args, {
      cwd,
      windowsHide: true,
      timeout: 10000,
      env: {
        GIT_AUTHOR_NAME: 'Station test',
        GIT_AUTHOR_EMAIL: 'test@station.dev',
        GIT_COMMITTER_NAME: 'Station test',
        GIT_COMMITTER_EMAIL: 'test@station.dev',
        GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
      },
    })
  ).stdout.trim();
}

async function harness(
  options: {
    homeLimit?: number;
    unobservable?: boolean;
    oversized?: boolean;
  } = {},
) {
  const home = temporary('station-device-capture-home-');
  const workspace = temporary('station-device-capture-workspace-');
  await git(workspace, ['init']);
  writeFileSync(join(workspace, 'app.txt'), 'committed\n');
  await git(workspace, ['add', 'app.txt']);
  await git(workspace, ['commit', '-m', 'fixture']);
  const commit = await git(workspace, ['rev-parse', 'HEAD']);
  const task: TaskRecord = {
    id: 'task-a',
    projectId: PROJECT,
    title: 'Device capture',
    description: '',
    priority: 'normal',
    status: 'ready',
    createdBy: OPERATOR,
    agentId: 'claude',
    sessionId: 'agent-a',
    createdAt: '2026-10-25T00:00:00.000Z',
    updatedAt: '2026-10-25T00:00:00.000Z',
    workspaceBinding: options.unobservable
      ? {}
      : { availability: 'available', workingDirectory: workspace },
  };
  const tasks = new Map([
    [task.id, task],
    ['task-b', { ...task, id: 'task-b', sessionId: 'agent-b' }],
  ]);
  const taskGraph = {
    readTaskView: (id: string) => tasks.get(id) ?? null,
    readTaskForOpen: async (id: string) => tasks.get(id) ?? null,
  };
  const events = new EventStore(join(home, 'orchestration.sqlite'));
  const room = new ProjectTaskRoomRuntime({
    taskGraph,
    projectForId: (id) =>
      id === PROJECT ? { id, slug: 'capture-demo' } : undefined,
    history: (authority) => events.createProjectTaskRoomHistory(authority),
    working: events.createProjectTaskRoomWorkingState(),
    requestAuthority: {
      resolve: async () => ({
        kind: 'granted',
        operatorId: OPERATOR,
        deviceId: 'test',
        policyRevision: 'test',
      }),
      isCurrent: () => true,
    },
    readExecutionBinding: (sessionId) =>
      sessionId === 'agent-a' || sessionId === 'agent-b'
        ? {
            projectId: PROJECT,
            taskId: sessionId === 'agent-a' ? 'task-a' : 'task-b',
          }
        : undefined,
  });
  const store = events.taskReviewStore();
  const blobs = new TaskCaptureBlobStore({
    homeDir: home,
    forbiddenProjectRoots: [workspace],
    maxHomeBytes: options.homeLimit,
  });
  const captures = new TaskBrowserCapture({
    store,
    taskGraph,
    blobs: () => blobs,
    localProjectIdFor: (id) => (id === PROJECT ? PROJECT : undefined),
  });
  const surfaces = new LiveSurfaceRegistry();
  const device = {
    hostId: 'local',
    platform: 'android' as const,
    deviceId: 'emulator-5554',
    name: 'Test',
    runtime: 'Android 16',
    booted: true,
  };
  let shots = 0;
  let duringShot: (() => Promise<void> | void) | undefined;
  let enabled = true;
  let personDeviceAllowed = true;
  class Socket extends EventEmitter {
    readyState = 1;
    send(_data: string, callback: (error?: Error) => void) {
      callback();
    }
    close() {
      this.readyState = 3;
    }
  }
  const host = {
    inventory: async (): Promise<MobileDeviceInventory> => ({
      hostId: 'local',
      state: 'ready',
      observedAt: new Date().toISOString(),
      devices: [device],
    }),
    boot: async () => ({ deviceId: device.deviceId }),
    attachStream: async () => {},
    shutdown: async () => {},
    screenshot: async () => ({ png: PNG, width: 1, height: 1 }),
    connect: async () => ({
      ok: true as const,
      connection: {
        baseUrl: 'http://127.0.0.1:43871',
        request: async () => new Response(null),
        openWebSocket: () => {
          const socket = new Socket();
          queueMicrotask(() => socket.emit('open'));
          return socket as WebSocket;
        },
      },
    }),
    capture: async () => {
      shots++;
      if (options.oversized)
        throw new MobileDeviceHostError('response-too-large');
      await duringShot?.();
      return {
        captureId: 'frame',
        target: device,
        capturedAt: new Date().toISOString(),
        mimeType: 'image/png' as const,
        width: 1,
        height: 1,
        pngBase64: PNG.toString('base64'),
      };
    },
  };
  const sessions = new DeviceSessionService({
    host,
    endpoint: { onExit: () => () => {} },
    surfaces,
    access: {
      isOperator: async () => true,
      hasStanding: async () => true,
      mayAccessDevice: async () => true,
    },
  });
  const automation = new DeviceAutomation({
    host,
    sessions,
    surfaces,
    tools: {
      foreground: async () => {
        throw new Error('unexpected foreground request');
      },
      logs: async () => {
        throw new Error('unexpected log request');
      },
      accessibility: async () => ({
        space: { width: 1, height: 1 },
        elements: [],
        truncated: false,
        readAt: new Date().toISOString(),
      }),
    },
  });
  const tokenA = mintStationControlMcpToken('agent-a', 'sdk-in-process').token;
  const tokenB = mintStationControlMcpToken('agent-b', 'sdk-in-process').token;
  const unbound = mintStationControlMcpToken(
    'agent-unbound',
    'url-token',
  ).token;
  const record = () => ({
    principal: { id: OPERATOR, source: 'session-owner' as const },
    localProjectId: PROJECT,
    projectIdSource: 'session-record' as const,
  });
  const deviceRoutes = createDeviceAgentRoutes({
    isInternalRequest: (request) => request.headers.get('x-internal') === '1',
    resolveCaller: (request) =>
      resolveStationControlCallerFromToken(
        request.headers.get(STATION_CONTROL_CALLER_TOKEN_HEADER),
        record,
      ),
    agentAccessEnabled: () => enabled,
    authorizePrincipal: createBrowserPrincipalAuthorizer({
      isOperatorPrincipal: (id) => id === OPERATOR,
    }),
    shares: { list: () => [] },
    automation,
    taskCapture: () => ({
      runtime: room,
      captures,
      localProjectIdFor: (id) => (id === PROJECT ? PROJECT : undefined),
    }),
  });
  const app = new Hono();
  app.route('/api/device-agent', deviceRoutes);
  let recordingSourceSeen: string | undefined;
  let recordingReady!: () => void;
  const recordingStarted = new Promise<void>((resolve) => {
    recordingReady = resolve;
  });
  const recordingManager = new TaskDeviceRecording({
    recordSource: async (
      _access,
      input,
      resolveSource,
    ): ReturnType<TaskBrowserRecording['recordSource']> => {
      const source = await resolveSource();
      if (!(await source.authorize())) throw new Error('unauthorized');
      recordingSourceSeen = source.device?.hostId;
      input.onStarted?.();
      recordingReady();
      await new Promise<void>((resolve, reject) => {
        input.stopSignal?.addEventListener('abort', () => resolve(), {
          once: true,
        });
        input.signal?.addEventListener(
          'abort',
          () => reject(new Error('cancelled')),
          { once: true },
        );
      });
      throw new Error('injected recording failure');
    },
  });
  app.route(
    '/api/tasks',
    createTaskReviewCaptureRoutes({
      runtime: room,
      captures,
      deviceRecordings: {
        manager: recordingManager,
        surfaces,
        enabled: () => true,
        walkthroughPreview: { select: ({ enabled }) => enabled() },
      },
      devices: new TaskDeviceCapture({
        captures,
        access: {
          isOperator: async () => true,
          hasStanding: async () => true,
          mayAccessDevice: async () => personDeviceAllowed,
        },
        hostIds: () => ['local'],
        host: (hostId) => (hostId === 'local' ? { host, sessions } : undefined),
        hostRevision: (hostId) => (hostId === 'local' ? 1 : undefined),
        projectMatches: (request, id) =>
          id === PROJECT &&
          new URL(request.url).searchParams.get('projectSlug') ===
            'capture-demo',
        requestCurrent: () => true,
      }),
      registry: {
        getSession: () => undefined,
        listSessions: () => [],
        captureScreenshot: async () => {
          throw new Error('Browser must not be used');
        },
      },
      localProjectIdFor: (id) => (id === PROJECT ? PROJECT : undefined),
      authorizeProject: async () => ({ kind: 'operator' }),
      isStationInternalRequest: () => false,
      isRequestPrincipalCurrent: () => true,
      logger: { warn: () => {} },
    }),
  );
  const review = new TaskReviewModule({
    store,
    logger: { warn: () => {} },
    memory: { readSummary: () => undefined },
    outputs: {
      list: async () => [],
      read: async () => {
        throw new Error('Unexpected output read');
      },
      readContent: async () => {
        throw new Error('Unexpected output content');
      },
    },
    readPlan: async () => ({ kind: 'unavailable' }),
    freezePlan: async () => true,
    readAnswers: async () => [],
  });
  app.route(
    '/api/tasks',
    createTaskReviewRoutes({
      runtime: room,
      module: review,
      logger: { warn: () => {} },
      send: new TaskReviewSend({
        store,
        readTask: taskGraph.readTaskView,
        readLead: async () => undefined,
        conversationOf: (sessionId) => sessionId,
        inbox: undefined,
        logger: { warn: () => {} },
      }),
    }),
  );
  const post = (operation: string, body: unknown, token = tokenA) =>
    app.request(`/api/device-agent/${operation}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal': '1',
        [STATION_CONTROL_CALLER_TOKEN_HEADER]: token,
      },
      body: JSON.stringify(body),
    });
  closers.push(async () => {
    await recordingManager.dispose();
    for (const id of ['agent-a', 'agent-b', 'agent-unbound'])
      revokeStationControlMcpToken(id);
    await sessions.dispose();
    await surfaces.dispose();
    await room.close();
    events.close();
  });
  const opened = (await (await post('open', device)).json()) as {
    session: { sessionId: string };
  };
  expect(opened).toMatchObject({ ok: true });
  const id: string = opened.session.sessionId;
  const access = await room.sessionTaskReviewAccess('agent-a');
  if (access.kind !== 'granted')
    throw new Error('Fixture Task binding refused');
  return {
    app,
    home,
    workspace,
    commit,
    task,
    id,
    store,
    access,
    recordingStarted,
    recordingSourceSeen: () => recordingSourceSeen,
    shots: () => shots,
    capture: (body: Record<string, unknown> = {}, token = tokenA) =>
      post('capture-to-task', { deviceSessionId: id, ...body }, token),
    otherToken: tokenB,
    unbound,
    duringShot: (callback: () => Promise<void> | void) => {
      duringShot = callback;
    },
    disable: () => {
      enabled = false;
    },
    revokePerson: () => {
      personDeviceAllowed = false;
    },
    take: () =>
      claimHumanControl(surfaces.get(sessions.get(id)!.surfaceId)!, {
        kind: 'human',
        principal: OPERATOR,
        device: 'viewer',
      }),
    lease: () => surfaces.get(sessions.get(id)!.surfaceId)!.lease.snapshot(),
    list: async (taskId: string) =>
      (
        (await (await app.request(`/api/tasks/${taskId}/review`)).json()) as {
          data: { items: { kind: string }[] };
        }
      ).data.items.filter((item) => item.kind === 'capture'),
    blobFiles: () =>
      existsSync(join(home, 'task-captures', 'sha256'))
        ? readdirSync(join(home, 'task-captures', 'sha256'))
        : [],
  };
}

test('person selects and captures a host-qualified Device session in Review', async () => {
  const h = await harness();
  const listing = await h.app.request(
    '/api/tasks/task-a/review/device-capture-sessions?projectSlug=capture-demo',
  );
  expect(listing.status).toBe(200);
  expect(await listing.json()).toMatchObject({
    success: true,
    data: { sessions: [{ sourceSessionId: `local:${h.id}`, hostId: 'local' }] },
  });
  const result = await h.app.request(
    '/api/tasks/task-a/review/device-captures?projectSlug=capture-demo',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceKind: 'device',
        sourceSessionId: `local:${h.id}`,
        operationId: 'person-capture',
      }),
    },
  );
  expect(result.status).toBe(201);
  expect(h.store.listCaptures(h.access.write)).toMatchObject([
    {
      sourceKind: 'device',
      sourceSessionId: `local:${h.id}`,
      commit: h.commit,
    },
  ]);
  expect(
    (
      await h.app.request(
        '/api/tasks/task-a/review/device-capture-sessions?projectSlug=other',
      )
    ).status,
  ).toBe(403);
  h.revokePerson();
  const denied = await h.app.request(
    '/api/tasks/task-a/review/device-captures?projectSlug=capture-demo',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceKind: 'device',
        sourceSessionId: `local:${h.id}`,
        operationId: 'denied',
      }),
    },
  );
  expect(denied.status).toBe(503);
  expect(h.shots()).toBe(1);
});

test('a person recording job is Task-scoped and reports a recorder failure after stop', async () => {
  const h = await harness();
  const start = await h.app.request(
    '/api/tasks/task-a/review/device-recordings?projectSlug=capture-demo',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceSessionId: `local:${h.id}`,
        durationMs: 1000,
      }),
    },
  );
  expect(start.status).toBe(202);
  const started = await start.json();
  if (
    !started ||
    typeof started !== 'object' ||
    !('data' in started) ||
    !started.data ||
    typeof started.data !== 'object' ||
    !('id' in started.data) ||
    typeof started.data.id !== 'string'
  )
    throw new Error('Missing recording job');
  const jobId = started.data.id;
  await h.recordingStarted;
  expect(h.recordingSourceSeen()).toBe('local');
  const wrongTask = await h.app.request(
    `/api/tasks/task-b/review/device-recordings/${jobId}`,
  );
  expect(wrongTask.status).toBe(404);
  const stop = await h.app.request(
    `/api/tasks/task-a/review/device-recordings/${jobId}/stop`,
    { method: 'POST' },
  );
  expect(await stop.json()).toMatchObject({
    success: true,
    data: { state: 'stopping' },
  });
  await vi.waitFor(async () => {
    const status = await h.app.request(
      `/api/tasks/task-a/review/device-recordings/${jobId}`,
    );
    expect(await status.json()).toMatchObject({
      success: true,
      data: { state: 'failed', code: 'recording-unavailable' },
    });
  });
});

test('publishes a device Screen on only the bound Task and serves it through the authorized content route', async () => {
  const h = await harness();
  const result = (await (await h.capture({ label: 'Reproduced' })).json()) as {
    captureId: string;
  };
  expect(result).toMatchObject({
    ok: true,
    commit: h.commit,
    screenshot: { mimeType: 'image/png', data: PNG.toString('base64') },
  });
  const [capture] = h.store.listCaptures(h.access.write);
  expect(capture).toMatchObject({
    captureId: result.captureId,
    taskId: 'task-a',
    commit: h.commit,
    sourceKind: 'device',
    label: 'Reproduced',
  });
  expect(await h.list('task-a')).toHaveLength(1);
  expect(await h.list('task-b')).toEqual([]);
  const response = await h.app.request(
    `/api/tasks/task-a/review/captures/${result.captureId}/content`,
  );
  expect(response.status).toBe(200);
  expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG);
  expect(
    (
      await h.app.request(
        `/api/tasks/task-b/review/captures/${result.captureId}/content`,
      )
    ).status,
  ).toBe(404);
  expect(h.lease().holder).toBeNull();
});

test('refuses a dirty workspace before device observation or publication', async () => {
  const h = await harness();
  writeFileSync(join(h.workspace, 'untracked.txt'), 'uncommitted');
  expect(await (await h.capture()).json()).toMatchObject({
    ok: false,
    code: 'workspace-changed',
  });
  expect(h.shots()).toBe(0);
  expect(h.store.listCaptures(h.access.write)).toEqual([]);
  expect(h.blobFiles()).toEqual([]);
});

test('refuses commit-during-capture even when the resulting workspace is clean', async () => {
  const h = await harness();
  h.duringShot(async () => {
    writeFileSync(join(h.workspace, 'app.txt'), 'new commit\n');
    await git(h.workspace, ['add', 'app.txt']);
    await git(h.workspace, ['commit', '-m', 'during capture']);
  });
  expect(await (await h.capture()).json()).toMatchObject({
    ok: false,
    code: 'workspace-changed',
  });
  expect(h.shots()).toBe(1);
  expect(h.store.listCaptures(h.access.write)).toEqual([]);
  expect(h.blobFiles()).toEqual([]);
});

test('refuses another Task argument and derives the target from each caller’s binding', async () => {
  const h = await harness();
  expect(await (await h.capture({ taskId: 'task-b' })).json()).toMatchObject({
    ok: false,
    code: 'invalid-request',
  });
  expect(h.shots()).toBe(0);
  expect(await (await h.capture({}, h.otherToken)).json()).toMatchObject({
    ok: true,
  });
  expect(await h.list('task-a')).toEqual([]);
  expect(await h.list('task-b')).toHaveLength(1);
});

test('refuses the per-Task capacity limit before capturing another frame', async () => {
  const h = await harness();
  await h.capture();
  const first = h.store.listCaptures(h.access.write)[0]!;
  for (let i = 1; i < TASK_REVIEW_LIMITS.capturesPerTask; i++) {
    const seeded = h.store.createCapture({
      ...h.access.write,
      ...first,
      operationId: `seed-${i}`,
    });
    expect(seeded.success).toBe(true);
  }
  expect(await (await h.capture()).json()).toMatchObject({
    ok: false,
    code: 'capture-limit',
  });
  expect(h.shots()).toBe(1);
  expect(h.store.listCaptures(h.access.write)).toHaveLength(
    TASK_REVIEW_LIMITS.capturesPerTask,
  );
});

test('refuses home capacity before device observation', async () => {
  const h = await harness({ homeLimit: 0 });
  expect(await (await h.capture()).json()).toMatchObject({
    ok: false,
    code: 'capture-home-limit',
  });
  expect(h.shots()).toBe(0);
  expect(h.store.listCaptures(h.access.write)).toEqual([]);
});

test.each(['takeover', 'disabled'] as const)(
  'refuses %s during capture without publishing metadata or bytes',
  async (change) => {
    const h = await harness();
    h.duringShot(async () => {
      if (change === 'takeover')
        expect(await h.take()).toMatchObject({ ok: true });
      else h.disable();
    });
    expect(await (await h.capture()).json()).toMatchObject({
      ok: false,
      code: 'capture-unavailable',
    });
    expect(h.store.listCaptures(h.access.write)).toEqual([]);
    expect(h.blobFiles()).toEqual([]);
  },
);

test('refuses an unbound caller before observing a device', async () => {
  const h = await harness();
  expect(await (await h.capture({}, h.unbound)).json()).toMatchObject({
    ok: false,
    code: 'caller-not-bound',
  });
  expect(h.shots()).toBe(0);
});

test('refuses an unobservable workspace before observing the device', async () => {
  const h = await harness({ unobservable: true });
  expect(await (await h.capture()).json()).toMatchObject({
    ok: false,
    code: 'workspace-unobservable',
  });
  expect(h.shots()).toBe(0);
  expect(h.store.listCaptures(h.access.write)).toEqual([]);
});

test('reports an oversized device response as screenshot-too-large without publishing', async () => {
  const h = await harness({ oversized: true });
  expect(await (await h.capture()).json()).toMatchObject({
    ok: false,
    code: 'screenshot-too-large',
  });
  expect(h.shots()).toBe(1);
  expect(h.store.listCaptures(h.access.write)).toEqual([]);
  expect(h.blobFiles()).toEqual([]);
});
