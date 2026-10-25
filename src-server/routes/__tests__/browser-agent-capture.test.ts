/** Real browser route/registry, room binding authority, Git pins, SQLite and blobs; only CDP is doubled. */
import { createHash } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import { Hono } from 'hono';
import { afterEach, expect, test } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import {
  createStationControlCallerRecordResolver,
  resolveStationControlCallerFromToken,
} from '../../runtime/mcp/station-control-caller.js';
import {
  __resetStationControlMcpTokensForTests,
  mintStationControlMcpToken,
} from '../../runtime/mcp/station-control-mcp-token.js';
import { createBrowserPrincipalAuthorizer } from '../../services/browser/browser-agent-authority.js';
import { BrowserAutomation } from '../../services/browser/browser-automation.js';
import {
  type BrowserHost,
  type CdpTransport,
  createLocalBrowserHostResolver,
} from '../../services/browser/browser-host.js';
import { BrowserProjectSettingsStore } from '../../services/browser/browser-project-settings.js';
import { BrowserSessionRegistry } from '../../services/browser/browser-session-registry.js';
import { EventStore } from '../../services/orchestration/event-store.js';
import { ProjectTaskRoomRuntime } from '../../services/orchestration/project-task-room-runtime.js';
import { SESSION_LOCAL_PROJECT_ID_METADATA_KEY } from '../../services/orchestration/session-project-identity.js';
import { TaskBrowserCapture } from '../../services/projects/task-browser-capture.js';
import { TaskCaptureBlobStore } from '../../services/projects/task-capture-blob-store.js';
import { TaskReviewModule } from '../../services/projects/task-review-module.js';
import { STATION_CONTROL_CALLER_TOKEN_HEADER } from '../../tools/station-control-shared.js';
import { execGit } from '../../utils/git-exec.js';
import { createBrowserAgentRoutes } from '../browser-agent.js';
import { createTaskReviewRoutes } from '../orchestration/task-review.js';
import { createTaskReviewCaptureRoutes } from '../orchestration/task-review-captures.js';

const temporary = trackTempDirs();
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  __resetStationControlMcpTokensForTests();
});
const OPERATOR = 'human:local:operator';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=',
  'base64',
);
const digest = (bytes: Buffer) =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
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
    oversized?: boolean;
    tildeWorkspace?: boolean;
    duringShot?: (workspace: string) => void;
  } = {},
) {
  const home = temporary('station-capture-home-');
  const workspace = temporary('station-capture-workspace-');
  await git(workspace, ['init']);
  writeFileSync(join(workspace, 'file.txt'), 'committed\n');
  await git(workspace, ['add', 'file.txt']);
  await git(workspace, ['commit', '-m', 'fixture']);
  const commit = await git(workspace, ['rev-parse', 'HEAD']);
  const task: TaskRecord = {
    id: 'task-a',
    projectId: 'p-alpha',
    title: 'Capture',
    description: '',
    priority: 'normal',
    status: 'ready',
    createdBy: OPERATOR,
    createdAt: '2026-10-25T00:00:00.000Z',
    updatedAt: '2026-10-25T00:00:00.000Z',
    agentId: 'claude',
    sessionId: 'agent-a',
    workspaceBinding: {
      availability: 'available',
      workingDirectory: options.tildeWorkspace
        ? `~/${relative(homedir(), workspace)}`
        : workspace,
    },
  };
  const tasks = new Map([
    ['task-a', task],
    ['task-b', { ...task, id: 'task-b', sessionId: undefined }],
  ]);
  const taskGraph = {
    readTaskView: (id: string) => tasks.get(id) ?? null,
    readTaskForOpen: async (id: string) => tasks.get(id) ?? null,
  };
  let shots = 0;
  const cdp: CdpTransport = {
    send: async <R>(method: string) => {
      if (method === 'Page.captureScreenshot') {
        shots++;
        options.duringShot?.(workspace);
        return {
          data: (options.oversized
            ? Buffer.alloc(16 * 1024 * 1024 + 1)
            : PNG
          ).toString('base64'),
        } as R;
      }
      return {} as R;
    },
    on: () => () => {},
    close: async () => {},
    closed: new Promise(() => {}),
  };
  let target = 0;
  const host: BrowserHost = {
    kind: 'server-chromium',
    shutdown: async () => {},
    openTarget: async () => ({
      targetId: `T${++target}`,
      cdpSessionId: `S${target}`,
    }),
    cdp: () => cdp,
    closeTarget: async () => {},
    onExit: () => () => {},
  };
  const registry = new BrowserSessionRegistry({
    stationHome: home,
    hostResolver: createLocalBrowserHostResolver(() => host),
  });
  const browser = await registry.createSession({
    projectId: task.projectId,
    projectSlug: 'alpha',
    actor: { kind: 'operator' },
    url: 'https://example.test/page?secret=value#private',
  });
  const settings = new BrowserProjectSettingsStore(home);
  const automation = new BrowserAutomation({
    sessions: registry,
    surfaces: { get: () => undefined },
    surfaceIdFor: () => undefined,
    settings,
    locatorEngine: async () => undefined,
  });
  const callerRecord = createStationControlCallerRecordResolver({
    actingPrincipal: () => ({ id: OPERATOR, source: 'session-owner' }),
    startedMetadata: () => ({
      projectSlug: 'alpha',
      [SESSION_LOCAL_PROJECT_ID_METADATA_KEY]: task.projectId,
    }),
    localProjectId: () => task.projectId,
    conversationId: () => undefined,
  });
  const bound = mintStationControlMcpToken('agent-a', 'sdk-in-process').token;
  const unbound = mintStationControlMcpToken(
    'agent-exposed',
    'url-token',
  ).token;
  const noTask = mintStationControlMcpToken(
    'agent-no-task',
    'sdk-in-process',
  ).token;
  let events: EventStore;
  let room: ProjectTaskRoomRuntime;
  let app: Hono;
  function compose() {
    events = new EventStore(join(home, 'orchestration.sqlite'));
    room = new ProjectTaskRoomRuntime({
      taskGraph,
      projectForId: (id) =>
        id === task.projectId ? { id, slug: 'alpha' } : undefined,
      history: (authority) => events.createProjectTaskRoomHistory(authority),
      working: events.createProjectTaskRoomWorkingState(),
      requestAuthority: {
        isCurrent: (request) =>
          request.headers.get('authorization') === 'Bearer person',
        resolve: async (request) =>
          request.headers.get('authorization') === 'Bearer person'
            ? {
                kind: 'granted',
                operatorId: OPERATOR,
                deviceId: 'test',
                policyRevision: 'test',
              }
            : { kind: 'revoked' },
      },
      readExecutionBinding: (sessionId) =>
        sessionId === 'agent-a'
          ? { projectId: task.projectId, taskId: task.id }
          : undefined,
    });
    const captures = new TaskBrowserCapture({
      store: events.taskReviewStore(),
      taskGraph,
      blobs: () =>
        new TaskCaptureBlobStore({
          homeDir: home,
          forbiddenProjectRoots: [workspace],
        }),
    });
    app = new Hono();
    app.route(
      '/api/browser-agent',
      createBrowserAgentRoutes({
        isInternalRequest: (request) =>
          request.headers.get('x-internal') === '1',
        resolveCaller: (request) =>
          resolveStationControlCallerFromToken(
            request.headers.get(STATION_CONTROL_CALLER_TOKEN_HEADER),
            callerRecord,
          ),
        authorizePrincipal: createBrowserPrincipalAuthorizer({
          isOperatorPrincipal: (id) => id === OPERATOR,
        }),
        automation,
        settings,
        browserReady: () => true,
        projectSlug: () => 'alpha',
        surfaceIdFor: () => undefined,
        taskCapture: { runtime: room, captures, registry },
      }),
    );
    app.route(
      '/api/tasks',
      createTaskReviewCaptureRoutes({
        runtime: room,
        captures,
        registry,
        authorizeProject: async (request, _projectId, purpose) => {
          expect(purpose).toBe('view');
          return request.headers.get('authorization') === 'Bearer person'
            ? { kind: 'operator' }
            : undefined;
        },
        isStationInternalRequest: (request) =>
          request.headers.get('x-internal') === '1',
        isRequestPrincipalCurrent: (request) =>
          request.headers.get('authorization') === 'Bearer person',
      }),
    );
    app.route(
      '/api/tasks',
      createTaskReviewRoutes({
        runtime: room,
        module: new TaskReviewModule({
          logger: { warn() {} },
          store: events.taskReviewStore(),
          memory: events.taskMemoryStore(),
          outputs: {
            list: async () => [],
            read: async () => {
              throw new Error('not a kept output');
            },
            readContent: async () => {
              throw new Error('not a kept output');
            },
          },
          readPlan: async () => ({ kind: 'unavailable' }),
          readAnswers: async () => [],
        }),
        logger: { warn() {} },
      }),
    );
  }
  compose();
  closers.push(async () => {
    await room.close();
    events.close();
    await registry.shutdown();
  });
  const tool = async (
    token = bound,
    body: unknown = { browserSessionId: browser.browserSessionId },
  ) =>
    (
      await app.request('/api/browser-agent/capture-to-task', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal': '1',
          [STATION_CONTROL_CALLER_TOKEN_HEADER]: token,
        },
        body: JSON.stringify(body),
      })
    ).json();
  const person = (path: string, body?: unknown) =>
    app.request(`/api/tasks/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: 'Bearer person',
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return {
    home,
    workspace,
    commit,
    browser,
    tool,
    bound,
    unbound,
    noTask,
    registry,
    person,
    shots: () => shots,
    captures: () =>
      events
        .taskReviewStore()
        .listCaptures({ taskId: task.id, taskCreatedAt: task.createdAt }),
    restart: async () => {
      await room.close();
      events.close();
      compose();
    },
  };
}

test('bound Claude caller stores the Task capture with its clean commit and matching digest', async () => {
  const h = await harness();
  const result = await h.tool(h.bound, { label: 'After fix' });
  expect(result, JSON.stringify(result)).toMatchObject({
    ok: true,
    commit: h.commit,
    digest: digest(PNG),
    screenshot: { mimeType: 'image/png', data: PNG.toString('base64') },
  });
  expect(h.captures()).toEqual([
    expect.objectContaining({
      captureId: result.captureId,
      commit: h.commit,
      digest: digest(PNG),
      author: { kind: 'session', sessionId: 'agent-a' },
      pageUrl: 'https://example.test/page',
      label: 'After fix',
    }),
  ]);
  expect(
    (await (await h.person('task-a/review')).json()).data.items,
  ).toContainEqual(
    expect.objectContaining({
      kind: 'capture',
      capture: expect.objectContaining({ captureId: result.captureId }),
    }),
  );
});
test('dirty workspace gets workspace-changed and writes no capture or blob', async () => {
  const h = await harness();
  writeFileSync(join(h.workspace, 'file.txt'), 'dirty\n');
  expect(await h.tool()).toMatchObject({
    ok: false,
    code: 'workspace-changed',
  });
  expect(h.captures()).toEqual([]);
  expect(h.shots()).toBe(0);
  expect(existsSync(join(h.home, 'task-captures'))).toBe(false);
});
test('a workspace containing an unobserved submodule is refused', async () => {
  const h = await harness();
  await git(h.workspace, [
    'update-index',
    '--add',
    '--cacheinfo',
    `160000,${h.commit},child`,
  ]);
  await git(h.workspace, ['commit', '-m', 'gitlink']);
  expect(await h.tool()).toMatchObject({
    ok: false,
    code: 'workspace-unobservable',
  });
  expect(h.captures()).toEqual([]);
  expect(h.shots()).toBe(0);
});
test.each([
  ['unbound', 'caller-not-bound'],
  ['noTask', 'no_task_binding'],
] as const)('%s caller is refused before capture', async (who, code) => {
  const h = await harness();
  expect(await h.tool(h[who])).toMatchObject({ ok: false, code });
  expect(h.captures()).toEqual([]);
  expect(h.shots()).toBe(0);
});
test('over the screenshot byte limit is refused without storage', async () => {
  const h = await harness({ oversized: true });
  expect(await h.tool()).toMatchObject({
    ok: false,
    code: 'screenshot-too-large',
  });
  expect(h.captures()).toEqual([]);
  expect(h.shots()).toBe(2);
  expect(existsSync(join(h.home, 'task-captures'))).toBe(false);
});
test('a workspace edited while CDP captures is refused before storage', async () => {
  const h = await harness({
    duringShot: (workspace) =>
      writeFileSync(join(workspace, 'file.txt'), 'changed during screenshot'),
  });
  expect(await h.tool()).toMatchObject({
    ok: false,
    code: 'workspace-changed',
  });
  expect(h.captures()).toEqual([]);
  expect(existsSync(join(h.home, 'task-captures'))).toBe(false);
});
test('person captures at view standing, content is Task scoped, verified and durable after restart', async () => {
  const h = await harness();
  expect(
    (await (await h.person('task-a/review/capture-sessions')).json()).data
      .sessions,
  ).toEqual([
    expect.objectContaining({
      browserSessionId: h.browser.browserSessionId,
      url: 'https://example.test/page',
    }),
  ]);
  const request = {
    sourceKind: 'browser',
    sourceSessionId: h.browser.browserSessionId,
    operationId: 'person-capture',
  };
  const response = await h.person('task-a/review/captures', request);
  expect(response.status).toBe(201);
  const capture = (await response.json()).data.capture;
  expect(capture).toMatchObject({
    author: { kind: 'person', principalId: OPERATOR },
    commit: h.commit,
    digest: digest(PNG),
  });
  expect(
    (await (await h.person('task-a/review/captures', request)).json()).data
      .capture.captureId,
  ).toBe(capture.captureId);
  expect(h.shots()).toBe(1);
  const contentPath = `review/captures/${capture.captureId}/content`;
  expect((await h.person(`task-b/${contentPath}`)).status).toBe(404);
  await h.restart();
  const content = await h.person(`task-a/${contentPath}`);
  expect(content.status).toBe(200);
  expect(content.headers.get('content-type')).toBe('image/png');
  expect(content.headers.get('x-content-type-options')).toBe('nosniff');
  const bytes = Buffer.from(await content.arrayBuffer());
  expect(bytes).toEqual(PNG);
  expect(digest(bytes)).toBe(capture.digest);
  const ref = {
    kind: 'capture',
    id: capture.captureId,
    revision: capture.digest,
    digest: capture.digest,
  };
  const valid = await h.person('task-a/review/threads', {
    artifact: ref,
    anchor: { kind: 'region', x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
    body: 'Fix this region',
    operationId: 'region',
  });
  expect(valid.status).toBe(200);
  const invalid = await h.person('task-a/review/threads', {
    artifact: ref,
    anchor: { kind: 'region', x: 0.9, y: 0, w: 0.3, h: 1 },
    body: 'Outside image',
    operationId: 'invalid-region',
  });
  expect(invalid.status).toBe(400);
  const tampered = Buffer.from(bytes);
  tampered[tampered.length - 1] ^= 1;
  writeFileSync(
    join(h.home, 'task-captures', 'sha256', capture.digest.slice(7)),
    tampered,
  );
  const corrupt = await h.person(`task-a/${contentPath}`);
  expect(corrupt.status).toBe(503);
  expect(await corrupt.json()).toMatchObject({
    success: false,
    code: 'capture-corrupt',
  });
});

test('capture selectors cannot cross Project or agent profile boundaries', async () => {
  const h = await harness();
  const otherProject = await h.registry.createSession({
    projectId: 'p-beta',
    projectSlug: 'beta',
    actor: { kind: 'operator' },
    url: 'https://example.test',
  });
  const otherProfile = await h.registry.createSession({
    projectId: 'p-alpha',
    projectSlug: 'alpha',
    actor: { kind: 'project-admin', principalId: 'other-person' },
    url: 'https://example.test',
  });
  for (const session of [otherProject, otherProfile])
    expect(
      await h.tool(h.bound, { browserSessionId: session.browserSessionId }),
    ).toMatchObject({ ok: false, code: 'not-found' });
  const response = await h.person('task-a/review/captures', {
    sourceKind: 'browser',
    sourceSessionId: otherProject.browserSessionId,
  });
  expect(response.status).toBe(404);
  expect(h.captures()).toEqual([]);
  expect(h.shots()).toBe(0);
});

test('capture expands a stored tilde workspace path before pinning', async () => {
  const h = await harness({ tildeWorkspace: true });
  expect(await h.tool()).toMatchObject({
    ok: true,
    commit: h.commit,
    digest: digest(PNG),
  });
  expect(h.captures()).toHaveLength(1);
});
