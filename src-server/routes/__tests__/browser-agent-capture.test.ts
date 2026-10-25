/** Real browser route/registry, room binding authority, Git pins, SQLite and blobs; only CDP is doubled. */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import * as lifecycle from '@kontourai/station-shared/lifecycle-events';
import { Hono } from 'hono';
import { afterEach, expect, test, vi } from 'vitest';
import { readJson } from '../../__test-utils__/read-json.js';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import {
  createStationControlCallerRecordResolver,
  resolveStationControlCallerFromToken,
} from '../../runtime/mcp/station-control-caller.js';
import {
  __resetStationControlMcpTokensForTests,
  mintStationControlMcpToken,
} from '../../runtime/mcp/station-control-mcp-token.js';
import type { BrowserProjectAuthorizer } from '../../services/browser/browser-access.js';
import { createBrowserPrincipalAuthorizer } from '../../services/browser/browser-agent-authority.js';
import { BrowserAutomation } from '../../services/browser/browser-automation.js';
import {
  type BrowserHost,
  type CdpTransport,
  createLocalBrowserHostResolver,
} from '../../services/browser/browser-host.js';
import { BrowserProjectSettingsStore } from '../../services/browser/browser-project-settings.js';
import {
  type BrowserSessionActor,
  BrowserSessionRegistry,
} from '../../services/browser/browser-session-registry.js';
import { EventStore } from '../../services/orchestration/event-store.js';
import { ProjectTaskRoomRuntime } from '../../services/orchestration/project-task-room-runtime.js';
import { SESSION_LOCAL_PROJECT_ID_METADATA_KEY } from '../../services/orchestration/session-project-identity.js';
import { TaskReviewSend } from '../../services/orchestration/task-review-send.js';
import { localProjectIdFor } from '../../services/projects/project-local-id.js';
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
  vi.restoreAllMocks();
  for (const close of closers.splice(0).reverse()) await close();
  __resetStationControlMcpTokensForTests();
});
const OPERATOR = 'human:local:operator';
const PROJECT_ID = 'bedbf164-242c-48c1-b1f2-ea1d9fddd20e';
const OTHER_PROJECT_ID = '542a89f0-cef2-48fc-8d80-1c0b8446f683';
const PROJECT_SLUG = 'review-demo';
const projects = {
  listProjects: () => [
    { id: PROJECT_ID, slug: PROJECT_SLUG },
    { id: OTHER_PROJECT_ID, slug: 'other-project' },
  ],
};
const projectIdFor = (identity: string) =>
  localProjectIdFor(projects, identity);
const people: Record<string, { id: string; actor: BrowserSessionActor }> = {
  person: { id: OPERATOR, actor: { kind: 'operator' } },
  'admin-a': {
    id: 'admin-a',
    actor: { kind: 'project-admin', principalId: 'admin-a' },
  },
  'admin-b': {
    id: 'admin-b',
    actor: { kind: 'project-admin', principalId: 'admin-b' },
  },
};
const personFor = (request: Request) =>
  people[request.headers.get('authorization')?.replace(/^Bearer /, '') ?? ''];
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
    unregisteredTaskProject?: boolean;
    oversized?: boolean;
    tildeWorkspace?: boolean;
    duringShot?: (workspace: string) => void | Promise<void>;
    callerProjectId?: string;
    screenshotBytes?: Buffer;
    maxHomeBytes?: number;
    storageInRepository?: boolean;
  } = {},
) {
  // Room authority can already be granted when the capture's local registry
  // no longer contains that Project. Keep the two authority reads independent.
  const captureProjectIdFor = (identity: string) =>
    localProjectIdFor(
      {
        listProjects: () =>
          options.unregisteredTaskProject ? [] : projects.listProjects(),
      },
      identity,
    );
  const home = temporary('station-capture-home-');
  const workspace = temporary('station-capture-workspace-');
  await git(workspace, ['init']);
  writeFileSync(join(workspace, 'file.txt'), 'committed\n');
  await git(workspace, ['add', 'file.txt']);
  await git(workspace, ['commit', '-m', 'fixture']);
  const commit = await git(workspace, ['rev-parse', 'HEAD']);
  const task: TaskRecord = {
    id: 'task-a',
    projectId: PROJECT_SLUG,
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
        await options.duringShot?.(workspace);
        return {
          data: (options.oversized
            ? Buffer.alloc(16 * 1024 * 1024 + 1)
            : (options.screenshotBytes ?? PNG)
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
    projectId: PROJECT_ID,
    projectSlug: PROJECT_SLUG,
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
      projectSlug: PROJECT_SLUG,
      [SESSION_LOCAL_PROJECT_ID_METADATA_KEY]:
        options.callerProjectId ?? PROJECT_ID,
    }),
    localProjectId: () => options.callerProjectId ?? PROJECT_ID,
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
  const warnings: { message: string; meta?: Record<string, unknown> }[] = [];
  const logger = {
    warn: (message: string, meta?: Record<string, unknown>) => {
      warnings.push({ message, meta });
    },
  };
  const blobs = new TaskCaptureBlobStore({
    logger,
    homeDir: home,
    forbiddenProjectRoots: options.storageInRepository
      ? [workspace, home]
      : [workspace],
    maxHomeBytes: options.maxHomeBytes,
  });
  const authorizeProject = vi.fn<BrowserProjectAuthorizer>(
    async (request, _projectId, purpose) => {
      expect(purpose).toBe('view');
      return personFor(request)?.actor;
    },
  );
  let events: EventStore;
  let room: ProjectTaskRoomRuntime;
  let app: Hono;
  function compose() {
    events = new EventStore(join(home, 'orchestration.sqlite'));
    room = new ProjectTaskRoomRuntime({
      taskGraph,
      projectForId: (id) =>
        projectIdFor(id) === PROJECT_ID
          ? { id, slug: PROJECT_SLUG }
          : undefined,
      history: (authority) => events.createProjectTaskRoomHistory(authority),
      working: events.createProjectTaskRoomWorkingState(),
      requestAuthority: {
        isCurrent: (request, principal) =>
          personFor(request)?.id === principal.operatorId,
        resolve: async (request) =>
          personFor(request)
            ? {
                kind: 'granted',
                operatorId: personFor(request)!.id,
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
      localProjectIdFor: captureProjectIdFor,
      store: events.taskReviewStore(),
      taskGraph,
      blobs: () => blobs,
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
        projectSlug: () => PROJECT_SLUG,
        surfaceIdFor: () => undefined,
        taskCapture: {
          logger,
          localProjectIdFor: captureProjectIdFor,
          runtime: room,
          captures,
          registry,
        },
      }),
    );
    app.route(
      '/api/tasks',
      createTaskReviewCaptureRoutes({
        localProjectIdFor: captureProjectIdFor,
        logger,
        runtime: room,
        captures,
        registry,
        authorizeProject,
        isStationInternalRequest: (request) =>
          request.headers.get('x-internal') === '1',
        isRequestPrincipalCurrent: (request) =>
          personFor(request) !== undefined,
      }),
    );
    app.route(
      '/api/tasks',
      createTaskReviewRoutes({
        runtime: room,
        send: new TaskReviewSend({
          store: events.taskReviewStore(),
          readTask: (id) => taskGraph.readTaskView(id),
          readLead: async () => undefined,
          conversationOf: (id) => id,
          inbox: undefined,
          logger: { warn() {} },
        }),
        module: new TaskReviewModule({
          logger,
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
    readJson(
      await app.request('/api/browser-agent/capture-to-task', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal': '1',
          [STATION_CONTROL_CALLER_TOKEN_HEADER]: token,
        },
        body: JSON.stringify(body),
      }),
    );
  const person = (path: string, body?: unknown, token = 'person') =>
    app.request(`/api/tasks/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return {
    home,
    workspace,
    warnings,
    authorizeProject,
    request: (path: string, init: RequestInit) => app.request(path, init),
    seedCaptures: async (count: number) => {
      const blob = await blobs.put(PNG, 'image/png');
      for (let i = 0; i < count; i++) {
        const store = events.taskReviewStore();
        const result = store.createCapture({
          projectId: task.projectId,
          taskId: task.id,
          taskCreatedAt: task.createdAt,
          author: { kind: 'person', principalId: OPERATOR },
          beforeCommit: () => true,
          ...blob,
          sourceKind: 'browser',
          sourceSessionId: browser.browserSessionId,
          commit,
          mediaType: 'image/png',
          operationId: `seed-${store.listCaptures({ taskId: task.id, taskCreatedAt: task.createdAt }).length}`,
        });
        expect(result.success).toBe(true);
      }
    },
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

test('bound Claude caller captures a slug-scoped Task from its canonical Project browser with commit and digest', async () => {
  const h = await harness();
  const result = await h.tool(h.bound, { label: 'After fix' });
  const captureId = h.captures()[0]?.captureId;
  expect(captureId).toEqual(expect.any(String));
  expect(result, JSON.stringify(result)).toMatchObject({
    ok: true,
    captureId,
    commit: h.commit,
    digest: digest(PNG),
    screenshot: { mimeType: 'image/png', data: PNG.toString('base64') },
  });
  expect(h.captures()).toEqual([
    expect.objectContaining({
      captureId,
      projectId: PROJECT_SLUG,
      commit: h.commit,
      digest: digest(PNG),
      author: { kind: 'session', sessionId: 'agent-a' },
      pageUrl: 'https://example.test/page',
      label: 'After fix',
    }),
  ]);
  expect(await (await h.person('task-a/review')).json()).toMatchObject({
    data: {
      items: expect.arrayContaining([
        expect.objectContaining({
          kind: 'capture',
          capture: expect.objectContaining({ captureId }),
        }),
      ]),
    },
  });
});
test('person capture refuses an unregistered Task Project before browser authorization or storage', async () => {
  const h = await harness({ unregisteredTaskProject: true });
  for (const [path, body] of [
    ['task-a/review/capture-sessions', undefined],
    [
      'task-a/review/captures',
      {
        sourceKind: 'browser',
        sourceSessionId: h.browser.browserSessionId,
      },
    ],
  ] as const) {
    const response = await h.person(path, body);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      success: false,
      code: 'not-found',
      error: 'Task Project not found.',
    });
  }
  expect(h.authorizeProject).not.toHaveBeenCalled();
  expect(h.shots()).toBe(0);
  expect(h.captures()).toEqual([]);
  expect(existsSync(join(h.home, 'task-captures'))).toBe(false);
});

test('agent capture refuses an unregistered Task Project as no_task_binding', async () => {
  const h = await harness({ unregisteredTaskProject: true });
  expect(await h.tool()).toEqual({
    ok: false,
    code: 'no_task_binding',
    message: 'This Session has no current Task binding.',
  });
  expect(h.shots()).toBe(0);
  expect(h.captures()).toEqual([]);
  expect(existsSync(join(h.home, 'task-captures'))).toBe(false);
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
test('person picker resolves the Task slug to its canonical Project browser sessions', async () => {
  const h = await harness();
  await h.registry.createSession({
    projectId: OTHER_PROJECT_ID,
    projectSlug: 'other-project',
    actor: { kind: 'operator' },
    url: 'https://example.test/other',
  });
  const response = await h.person('task-a/review/capture-sessions');
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    success: true,
    data: {
      sessions: [
        {
          browserSessionId: h.browser.browserSessionId,
          url: 'https://example.test/page',
          viewport: h.browser.viewport,
        },
      ],
    },
  });
});

test('person captures a slug-scoped Task from its canonical Project browser and reads Task-scoped content after restart', async () => {
  const h = await harness();
  const request = {
    sourceKind: 'browser',
    sourceSessionId: h.browser.browserSessionId,
    operationId: 'person-capture',
  };
  const response = await h.person('task-a/review/captures', request);
  expect(response.status).toBe(201);
  const capture = h.captures()[0]!;
  expect(await response.json()).toMatchObject({ data: { capture } });
  expect(capture).toMatchObject({
    projectId: PROJECT_SLUG,
    author: { kind: 'person', principalId: OPERATOR },
    commit: h.commit,
    digest: digest(PNG),
  });
  expect(
    await (await h.person('task-a/review/captures', request)).json(),
  ).toMatchObject({ data: { capture: { captureId: capture.captureId } } });
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
    revision: capture.commit,
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
});

test.each(['missing', 'tampered', 'directory'] as const)(
  '%s capture bytes return 503 and log a sanitized storage warning',
  async (failure) => {
    const h = await harness();
    expect(await h.tool()).toMatchObject({ ok: true });
    const capture = h.captures()[0]!;
    const path = join(
      h.home,
      'task-captures',
      'sha256',
      capture.digest.slice(7),
    );
    if (failure === 'tampered') {
      const tampered = Buffer.from(PNG);
      tampered[tampered.length - 1] ^= 1;
      writeFileSync(path, tampered);
    } else {
      unlinkSync(path);
      if (failure === 'directory') mkdirSync(path);
    }
    const response = await h.person(
      `task-a/review/captures/${capture.captureId}/content`,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      success: false,
      code: failure === 'tampered' ? 'capture-corrupt' : 'capture-unavailable',
      error: 'Capture storage is unavailable or its bytes failed verification.',
    });
    expect(h.warnings).toEqual([
      {
        message: 'task review capture request failed',
        meta: { taskId: 'task-a', errorName: 'TaskCaptureBlobStoreError' },
      },
    ]);
  },
);

test.each(['directory', 'repository', 'metadata'] as const)(
  '%s agent capture failure returns a sanitized refusal and logs its cause',
  async (failure) => {
    const h = await harness({ storageInRepository: failure === 'repository' });
    if (failure === 'directory') {
      writeFileSync(join(h.home, 'task-captures'), 'private storage details');
    } else if (failure === 'metadata') {
      vi.spyOn(h.registry, 'getSession').mockImplementationOnce(() => {
        throw new TypeError('private browser details');
      });
    }
    expect(await h.tool()).toEqual({
      ok: false,
      code: 'capture-unavailable',
      message:
        failure === 'metadata'
          ? 'The browser capture is unavailable.'
          : 'Capture storage is unavailable or its bytes failed verification.',
    });
    expect(h.warnings).toEqual([
      {
        message: 'task review agent capture failed',
        meta: {
          taskId: 'task-a',
          errorName:
            failure === 'metadata' ? 'TypeError' : 'TaskCaptureBlobStoreError',
        },
      },
    ]);
    expect(h.captures()).toEqual([]);
    expect(h.shots()).toBe(0);
  },
);

test('a committed capture returns success and logs a later lock release failure', async () => {
  const h = await harness();
  const acquire = lifecycle.acquireFileMutationLockAsync;
  vi.spyOn(lifecycle, 'acquireFileMutationLockAsync').mockImplementation(
    async (...args) => {
      const release = await acquire(...args);
      if (!args[0].endsWith('task-captures.mutation')) return release;
      return async () => {
        await release();
        throw new TypeError('private release failure details');
      };
    },
  );
  const response = await h.person('task-a/review/captures', {
    sourceKind: 'browser',
    sourceSessionId: h.browser.browserSessionId,
  });
  expect(response.status).toBe(201);
  const capture = h.captures()[0]!;
  expect(await response.json()).toMatchObject({ data: { capture } });
  expect(h.captures()).toHaveLength(1);
  expect(h.shots()).toBe(1);
  const content = await h.person(
    `task-a/review/captures/${capture.captureId}/content`,
  );
  expect(content.status).toBe(200);
  expect(Buffer.from(await content.arrayBuffer())).toEqual(PNG);
  expect(h.warnings).toEqual([
    {
      message: 'task capture blob lock release failed',
      meta: { errorName: 'TypeError' },
    },
  ]);
});

test('capture selectors cannot cross Project or agent profile boundaries', async () => {
  const h = await harness();
  const otherProject = await h.registry.createSession({
    projectId: OTHER_PROJECT_ID,
    projectSlug: 'other-project',
    actor: { kind: 'operator' },
    url: 'https://example.test',
  });
  const otherProfile = await h.registry.createSession({
    projectId: PROJECT_ID,
    projectSlug: PROJECT_SLUG,
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

test('a clean commit made during the screenshot is refused by the re-pin comparison', async () => {
  const h = await harness({
    duringShot: async (workspace) => {
      await git(workspace, [
        'commit',
        '--allow-empty',
        '-m',
        'commit during screenshot',
      ]);
    },
  });
  expect(await h.tool()).toMatchObject({
    ok: false,
    code: 'workspace-changed',
  });
  expect(h.shots()).toBe(1);
  expect(h.captures()).toEqual([]);
  expect(existsSync(join(h.home, 'task-captures'))).toBe(false);
});

test('a second Project admin cannot capture another admin profile but can capture their own', async () => {
  const h = await harness();
  const adminA = await h.registry.createSession({
    projectId: PROJECT_ID,
    projectSlug: PROJECT_SLUG,
    actor: people['admin-a']!.actor,
    url: 'https://example.test/admin-a',
  });
  const adminB = await h.registry.createSession({
    projectId: PROJECT_ID,
    projectSlug: PROJECT_SLUG,
    actor: people['admin-b']!.actor,
    url: 'https://example.test/admin-b',
  });
  const body = {
    sourceKind: 'browser',
    sourceSessionId: adminA.browserSessionId,
    operationId: 'admin-capture',
  };
  const refused = await h.person('task-a/review/captures', body, 'admin-b');
  expect(refused.status).toBe(404);
  expect(await refused.json()).toMatchObject({
    success: false,
    code: 'not-found',
  });
  expect(h.shots()).toBe(0);
  expect(h.captures()).toEqual([]);
  const allowed = await h.person(
    'task-a/review/captures',
    { ...body, sourceSessionId: adminB.browserSessionId },
    'admin-b',
  );
  expect(allowed.status).toBe(201);
  expect(await allowed.json()).toMatchObject({
    data: { capture: { author: { kind: 'person', principalId: 'admin-b' } } },
  });
  expect(h.shots()).toBe(1);
});

test('the agent recorded Project must match its granted Task binding Project', async () => {
  const h = await harness({ callerProjectId: OTHER_PROJECT_ID });
  expect(await h.tool()).toMatchObject({ ok: false, code: 'no_task_binding' });
  expect(h.shots()).toBe(0);
  expect(h.captures()).toEqual([]);
});

test('200 captures refuse the next capture before any screenshot or new file', async () => {
  const h = await harness();
  await h.seedCaptures(200);
  const root = join(h.home, 'task-captures', 'sha256');
  const before = readdirSync(root);
  expect(await h.tool()).toMatchObject({ ok: false, code: 'capture-limit' });
  expect(h.shots()).toBe(0);
  expect(h.captures()).toHaveLength(200);
  expect(readdirSync(root)).toEqual(before);
});

test('a full home refuses a screenshot before acquiring new image bytes', async () => {
  const h = await harness({ maxHomeBytes: 8192 });
  await h.seedCaptures(1);
  const root = join(h.home, 'task-captures', 'sha256');
  const before = readdirSync(root);
  expect(await h.tool()).toMatchObject({
    ok: false,
    code: 'capture-home-limit',
  });
  expect(h.shots()).toBe(0);
  expect(h.captures()).toHaveLength(1);
  expect(readdirSync(root)).toEqual(before);
});

test.each([false, true])(
  'a raced metadata refusal rolls back new bytes and preserves shared digests (shared=%s)',
  async (shared) => {
    const changed = Buffer.from(PNG);
    changed[changed.length - 1] ^= 1;
    const options: Parameters<typeof harness>[0] = {
      screenshotBytes: shared ? PNG : changed,
    };
    const h = await harness(options);
    await h.seedCaptures(199);
    options.duringShot = () => h.seedCaptures(1);
    const root = join(h.home, 'task-captures', 'sha256');
    const before = readdirSync(root);
    expect(await h.tool()).toMatchObject({ ok: false, code: 'capture-limit' });
    expect(h.shots()).toBe(1);
    expect(h.captures()).toHaveLength(200);
    expect(readdirSync(root)).toEqual(before);
    const capture = h.captures()[0]!;
    const content = await h.person(
      `task-a/review/captures/${capture.captureId}/content`,
    );
    expect(content.status).toBe(200);
    expect(Buffer.from(await content.arrayBuffer())).toEqual(PNG);
  },
);

test('non-http browser page URLs are omitted from persisted capture metadata', async () => {
  const h = await harness();
  h.registry.observeCommittedUrl(
    h.browser.browserSessionId,
    h.browser.generation,
    'about:blank',
  );
  expect(await h.tool()).toMatchObject({ ok: true });
  expect(h.captures()).toHaveLength(1);
  expect(h.captures()[0]!.pageUrl).toBeUndefined();
});

test('capture middleware refuses internal capture requests without intercepting review routes registered later', async () => {
  const h = await harness();
  const headers = { authorization: 'Bearer person', 'x-internal': '1' };
  expect(
    (await h.request('/api/tasks/task-a/review', { headers })).status,
  ).toBe(200);
  expect(
    (await h.request('/api/tasks/task-a/review/capture-sessions', { headers }))
      .status,
  ).toBe(404);
  expect(
    (
      await h.request('/api/tasks/task-a/review/captures', {
        method: 'POST',
        headers,
      })
    ).status,
  ).toBe(404);
});

test('unexpected capture failures log only their error name and Task identity', async () => {
  const h = await harness();
  vi.spyOn(h.registry, 'getSession').mockImplementationOnce(() => {
    throw new TypeError('private details');
  });
  const response = await h.person('task-a/review/captures', {
    sourceKind: 'browser',
    sourceSessionId: h.browser.browserSessionId,
  });
  expect(response.status).toBe(503);
  expect(h.warnings).toEqual([
    {
      message: 'task review capture request failed',
      meta: { taskId: 'task-a', errorName: 'TypeError' },
    },
  ]);
});
