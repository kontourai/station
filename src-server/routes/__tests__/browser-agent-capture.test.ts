/** Real browser route/registry, room binding authority, Git pins, SQLite and blobs; only CDP is doubled. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import { parseWalkthrough } from '@kontourai/station-contracts/walkthrough';
import * as lifecycle from '@kontourai/station-shared/lifecycle-events';
import { Hono } from 'hono';
import { afterEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { ProjectFileTransactions } from '../../domain/project-file-transactions.js';
import { StationRuntime } from '../../runtime/bootstrap/station-runtime.js';
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
import { BrowserLiveSurfaces } from '../../services/browser/browser-live-surfaces.js';
import { BrowserProjectSettingsStore } from '../../services/browser/browser-project-settings.js';
import {
  type BrowserSessionActor,
  BrowserSessionRegistry,
} from '../../services/browser/browser-session-registry.js';
import {
  locateExecutable,
  runBoundedToolCapture,
} from '../../services/devices/device-host-tools.js';
import { LiveSurfaceRegistry } from '../../services/live-surface/registry.js';
import {
  ActionOperationService,
  FileActionOperationStore,
} from '../../services/operations/action-operation-service.js';
import { EventStore } from '../../services/orchestration/event-store.js';
import { ProjectTaskRoomRuntime } from '../../services/orchestration/project-task-room-runtime.js';
import { SESSION_LOCAL_PROJECT_ID_METADATA_KEY } from '../../services/orchestration/session-project-identity.js';
import { TaskReviewSend } from '../../services/orchestration/task-review-send.js';
import { localProjectIdFor } from '../../services/projects/project-local-id.js';
import { TaskBrowserCapture } from '../../services/projects/task-browser-capture.js';
import { TaskBrowserRecording } from '../../services/projects/task-browser-recording.js';
import { TaskCaptureBlobStore } from '../../services/projects/task-capture-blob-store.js';
import { TaskReviewModule } from '../../services/projects/task-review-module.js';
import { TaskWalkthroughStore } from '../../services/walkthroughs/task-walkthrough-store.js';
import { WalkthroughService } from '../../services/walkthroughs/walkthrough-service.js';
import {
  BROWSER_RECORD_MAX_DURATION_MS,
  BROWSER_RECORD_MAX_ENCODED_BYTES,
} from '../../tools/station-browser-policy.js';
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
const FRAME_RED = Buffer.from(
  '/9j/4AAQSkZJRgABAgAAAQABAAD//gAPTGF2YzYzLjEuMTAyAP/bAEMACAQEBAQEBQUFBQUFBgYGBgYGBgYGBgYGBgcHBwgICAcHBwYGBwcICAgICQkJCAgICAkJCgoKDAwLCw4ODhERFP/EAE0AAQEAAAAAAAAAAAAAAAAAAAAGAQEBAQAAAAAAAAAAAAAAAAAABgcQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCABAAEADASIAAhEAAxEA/9oADAMBAAIRAxEAPwCLASbfwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH/2Q==',
  'base64',
);
const FRAME_BLUE = Buffer.from(
  '/9j/4AAQSkZJRgABAgAAAQABAAD//gAPTGF2YzYzLjEuMTAyAP/bAEMACAQEBAQEBQUFBQUFBgYGBgYGBgYGBgYGBgcHBwgICAcHBwYGBwcICAgICQkJCAgICAkJCgoKDAwLCw4ODhERFP/EAE0AAQEAAAAAAAAAAAAAAAAAAAAHAQEBAQAAAAAAAAAAAAAAAAAABQcQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCABAAEADASIAAhEAAxEA/9oADAMBAAIRAxEAPwCOAN/SgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH/2Q==',
  'base64',
);
const mediaOverride = process.env.STATION_WALKTHROUGH_TEST_FFMPEG_DIR;
const ffmpeg = mediaOverride
  ? join(mediaOverride, 'ffmpeg')
  : await locateExecutable('ffmpeg', []);
const ffprobe = mediaOverride
  ? join(mediaOverride, 'ffprobe')
  : await locateExecutable('ffprobe', []);
const mediaReady =
  !!ffmpeg && !!ffprobe && existsSync(ffmpeg) && existsSync(ffprobe);
if (!mediaReady)
  console.warn('SKIP real Task Walkthrough encoding: ffmpeg/ffprobe absent.');
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
    recording?: boolean;
    recordingPreview?: boolean;
    continuousFrames?: boolean;
    encoderPath?: string;
    beforeResolveFfmpeg?: () => Promise<void>;
    duringFrame?: (workspace: string) => void;
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
  const projectFiles = new ProjectFileTransactions(home);
  if (options.recording)
    await projectFiles.createProject(PROJECT_SLUG, {
      id: PROJECT_ID,
      slug: PROJECT_SLUG,
    });
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
  const listeners = new Map<
    string,
    Set<(params: unknown, sessionId?: string) => void>
  >();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let streams = 0;
  let notifyStreamStarted!: () => void;
  const streamStarted = new Promise<void>((resolve) => {
    notifyStreamStarted = resolve;
  });
  const cdp: CdpTransport = {
    send: async <R>(method: string, _params?: object, sessionId?: string) => {
      if (method === 'Page.startScreencast' && options.recording) {
        streams++;
        notifyStreamStarted();
        const frames = options.continuousFrames
          ? Array.from({ length: 8 }, (_, i) =>
              i % 2 === 0 ? FRAME_RED : FRAME_BLUE,
            )
          : [FRAME_RED, FRAME_BLUE];
        for (const [i, frame] of frames.entries()) {
          const timer = setTimeout(
            () => {
              timers.delete(timer);
              if (i === 0) options.duringFrame?.(workspace);
              for (const callback of listeners.get('Page.screencastFrame') ??
                [])
                callback(
                  {
                    data: frame.toString('base64'),
                    sessionId: i + 1,
                    metadata: { deviceWidth: 64, deviceHeight: 64 },
                  },
                  sessionId,
                );
            },
            30 + i * (options.continuousFrames ? 450 : 120),
          );
          timers.add(timer);
        }
      }
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
    on: (event, callback) => {
      const callbacks = listeners.get(event) ?? new Set();
      callbacks.add(callback);
      listeners.set(event, callbacks);
      return () => callbacks.delete(callback);
    },
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
  const surfaces = new LiveSurfaceRegistry();
  const live = options.recording
    ? new BrowserLiveSurfaces({
        sessions: registry,
        surfaces,
        authorizeProject,
      })
    : undefined;
  const preview = {
    select: <T>(branches: { enabled: () => T; disabled: () => T }) =>
      options.recordingPreview === false
        ? branches.disabled()
        : branches.enabled(),
  };
  const taskWalkthroughs = options.recording
    ? new TaskWalkthroughStore({
        files: () => projectFiles,
        forbiddenRoots: () =>
          options.storageInRepository ? [home] : [workspace],
        projectSlugFor: (identity) =>
          projectIdFor(identity) === PROJECT_ID ? PROJECT_SLUG : undefined,
      })
    : undefined;
  let events: EventStore;
  let room: ProjectTaskRoomRuntime;
  let app: Hono;
  let recordings: TaskBrowserRecording | undefined;
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
    recordings =
      live && taskWalkthroughs
        ? new TaskBrowserRecording({
            captures,
            registry,
            surfaces,
            surfaceIdFor: (id) => live.surfaceIdFor(id),
            resolver: {
              resolveFfmpeg: async () => {
                await options.beforeResolveFfmpeg?.();
                return mediaReady || options.encoderPath
                  ? {
                      status: 'ready',
                      origin: 'host',
                      paths: {
                        ffmpeg: options.encoderPath ?? ffmpeg!,
                        ffprobe: ffprobe ?? join(home, 'unused-ffprobe'),
                      },
                    }
                  : { status: 'unsupported-platform', platform: 'test' };
              },
            },
            preview,
            store: taskWalkthroughs,
          })
        : undefined;
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
          ...(recordings ? { recordings } : {}),
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
        ...(taskWalkthroughs
          ? { walkthroughs: { store: taskWalkthroughs, preview } }
          : {}),
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
          readTask: taskGraph.readTaskView,
          readLead: async () => undefined,
          conversationOf: (sessionId) => sessionId,
          inbox: undefined,
          logger,
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
          freezePlan: async () => true,
          readPlan: async () => ({ kind: 'unavailable' }),
          readAnswers: async () => [],
        }),
        logger: { warn() {} },
      }),
    );
  }
  compose();
  closers.push(async () => {
    await recordings?.dispose();
    await room.close();
    events.close();
    await live?.dispose();
    await surfaces.dispose();
    for (const timer of timers) clearTimeout(timer);
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
  const person = (path: string, body?: unknown, token = 'person') =>
    app.request(`/api/tasks/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const record = async (token = bound, body: unknown = { durationMs: 400 }) =>
    (
      await app.request('/api/browser-agent/record-to-task', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal': '1',
          [STATION_CONTROL_CALLER_TOKEN_HEADER]: token,
        },
        body: JSON.stringify(body),
      })
    ).json();
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
    record,
    streamStarted,
    streams: () => streams,
    stopBrowser: () => live!.dispose(),
    stopRuntime: (configurationDrain: Promise<void> = Promise.resolve()) => {
      // The real shutdown sequence runs over the live recorder and surfaces;
      // unrelated runtime services are inert lifecycle doubles.
      const runtime = Object.create(StationRuntime.prototype) as StationRuntime;
      Object.assign(runtime, {
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        timers: [],
        nativeEngineAdoptionAbort: new AbortController(),
        enginePrerequisitePrimingAbort: new AbortController(),
        agentConfigurationPersistenceQueue: Promise.resolve(),
        agentConfigurationMutationQueue: configurationDrain,
        configurationSourceUnsubscribers: [],
        mcpConfigs: new Map(),
        activeAgents: new Map(),
        acpBridge: { shutdown: async () => {} },
        feedbackService: { stop: () => {} },
        voiceService: { stop: async () => {} },
        terminalWsServer: { stop: () => {} },
        terminalService: { dispose: async () => {} },
        configLoader: {
          getProjectHomeDir: () => home,
          dispose: async () => {},
        },
        pluginOperationalEventSubscriptions: {
          close: async () => ({ kind: 'closed' }),
        },
        orchestrationEventStore: { close: () => ({ kind: 'closed' }) },
        taskRecordings: recordings,
        browserService: {
          shutdown: async () => {
            await live?.dispose();
            await registry.shutdown();
          },
        },
        liveSurfaceRegistry: surfaces,
      });
      return runtime.shutdown();
    },
    watch: () => {
      const id = live?.surfaceIdFor(browser.browserSessionId);
      const entry = id ? surfaces.get(id) : undefined;
      if (!entry) throw new Error('missing Browser surface');
      return {
        viewer: entry.hub.attach({
          maxFps: 10,
          quality: 70,
          maxWidth: 1280,
          maxHeight: 1280,
        }),
        count: () => entry.hub.viewerCount,
      };
    },
    projectWalkthroughs: new WalkthroughService({
      files: projectFiles,
      operations: new ActionOperationService(
        new FileActionOperationStore(home),
      ),
      resolver: {
        resolveFfmpeg: async () => ({
          status: 'unsupported-platform',
          platform: 'test',
        }),
      },
      transcriber: {
        transcribeFile: async () => ({
          status: 'unavailable',
          reason: 'unsupported-platform',
          platform: 'test',
        }),
      },
      diagnostic: () => {},
    }),
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

test('recording requires a bound Task caller and rejects dirty or over-limit requests before starting the stream', async () => {
  const h = await harness({ recording: true });
  expect(await h.record(h.unbound)).toMatchObject({
    ok: false,
    code: 'caller-not-bound',
  });
  expect(
    (
      await h.request('/api/browser-agent/record-to-task', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [STATION_CONTROL_CALLER_TOKEN_HEADER]: h.bound,
        },
        body: JSON.stringify({ durationMs: 400 }),
      })
    ).status,
  ).toBe(404);
  expect(await h.record(h.noTask)).toMatchObject({
    ok: false,
    code: 'no_task_binding',
  });
  expect(
    await h.record(h.bound, { durationMs: 400, taskId: 'task-b' }),
  ).toMatchObject({ ok: false, code: 'invalid-request' });
  expect(
    await h.record(h.bound, { durationMs: BROWSER_RECORD_MAX_DURATION_MS + 1 }),
  ).toMatchObject({ ok: false, code: 'invalid-request' });
  expect(
    await h.record(h.bound, {
      durationMs: 400,
      maxBytes: BROWSER_RECORD_MAX_ENCODED_BYTES + 1,
    }),
  ).toMatchObject({ ok: false, code: 'invalid-request' });
  writeFileSync(join(h.workspace, 'untracked.txt'), 'untracked\n');
  expect(await h.record()).toMatchObject({
    ok: false,
    code: 'workspace-changed',
  });
  unlinkSync(join(h.workspace, 'untracked.txt'));
  writeFileSync(join(h.workspace, 'file.txt'), 'dirty\n');
  expect(await h.record()).toMatchObject({
    ok: false,
    code: 'workspace-changed',
  });
  expect(h.streams()).toBe(0);
  expect(
    existsSync(join(h.home, 'projects', PROJECT_SLUG, 'walkthroughs')),
  ).toBe(false);
});

test('recording and Task reads are refused while the Walkthrough preview is disabled', async () => {
  const h = await harness({ recording: true, recordingPreview: false });
  expect(await h.record()).toMatchObject({
    ok: false,
    code: 'feature_preview_disabled',
  });
  expect((await h.person('task-a/review/walkthroughs')).status).toBe(404);
  expect(h.streams()).toBe(0);
});

test.skipIf(!mediaReady)(
  'real encoder stores a commit-pinned Walkthrough and isolates its list, document, and video by Task',
  async () => {
    const h = await harness({ recording: true });
    const pending = h.record(h.bound, {
      durationMs: 500,
      label: 'Browser clip',
    });
    await h.streamStarted;
    const watching = h.watch();
    const result = await pending;
    expect(result, JSON.stringify(result)).toMatchObject({
      ok: true,
      commit: h.commit,
      walkthroughId: expect.any(String),
      recording: { mediaType: 'video/webm', file: 'recording.webm' },
    });
    expect(h.streams()).toBe(1);
    expect(watching.viewer.closed).toBe(false);
    expect(watching.count()).toBe(1);
    watching.viewer.close();
    if (
      !result ||
      typeof result !== 'object' ||
      !('walkthroughId' in result) ||
      typeof result.walkthroughId !== 'string'
    )
      throw new Error('Recording did not return a Walkthrough id');
    const id = result.walkthroughId;
    const listA = await (await h.person('task-a/review/walkthroughs')).json();
    const listB = await (await h.person('task-b/review/walkthroughs')).json();
    expect(listA).toMatchObject({ success: true, data: { items: [{ id }] } });
    expect(listB).toEqual({ success: true, data: { items: [] } });
    const get = await h.person(`task-a/review/walkthroughs/${id}`);
    expect(get.status).toBe(200);
    const body = await get.json();
    if (
      !body ||
      typeof body !== 'object' ||
      !('data' in body) ||
      !body.data ||
      typeof body.data !== 'object' ||
      !('walkthrough' in body.data)
    )
      throw new Error('Task Walkthrough response has no document');
    const manifest = parseWalkthrough(body.data.walkthrough);
    expect(manifest).toMatchObject({
      schema: 'station.walkthrough/v1',
      id,
      title: 'Browser clip',
      source: { commit: h.commit },
      coverage: { frames: 'present', transcript: 'absent' },
    });
    expect(
      manifest.events.filter((event) => event.kind === 'frame').length,
    ).toBeGreaterThanOrEqual(2);
    const root = join(
      h.home,
      'projects',
      PROJECT_SLUG,
      'walkthroughs',
      '.task-clips',
    );
    const scopes = readdirSync(root).filter((name) =>
      /^[a-f0-9]{64}$/.test(name),
    );
    expect(scopes).toHaveLength(1);
    const stored = JSON.parse(
      readFileSync(join(root, scopes[0]!, id, 'manifest.json'), 'utf8'),
    );
    expect(parseWalkthrough(stored)).toEqual(manifest);
    expect(
      existsSync(join(h.home, 'projects', PROJECT_SLUG, 'walkthroughs', id)),
    ).toBe(false);
    expect((await h.projectWalkthroughs.list(PROJECT_SLUG)).items).toEqual([]);
    expect(await h.projectWalkthroughs.get(PROJECT_SLUG, id)).toBeNull();
    expect(
      await git(h.workspace, ['cat-file', '-t', manifest.source.commit!]),
    ).toBe('commit');
    const video = await h.person(`task-a/review/walkthroughs/${id}/video`);
    expect(video.status).toBe(200);
    expect(video.headers.get('content-type')).toBe('video/webm');
    const bytes = Buffer.from(await video.arrayBuffer());
    expect(bytes.subarray(0, 4).toString('hex')).toBe('1a45dfa3');
    const probe = JSON.parse(
      await runBoundedToolCapture(
        ffprobe!,
        [
          '-v',
          'error',
          '-show_entries',
          'stream=codec_name,width,height',
          '-of',
          'json',
          join(root, scopes[0]!, id, 'recording.webm'),
        ],
        { timeoutMs: 15_000 },
      ),
    );
    expect(probe.streams[0]).toMatchObject({
      codec_name: 'vp8',
      width: 64,
      height: 64,
    });
    const hashes = await runBoundedToolCapture(
      ffmpeg!,
      [
        '-nostdin',
        '-v',
        'error',
        '-i',
        join(root, scopes[0]!, id, 'recording.webm'),
        '-f',
        'framehash',
        '-hash',
        'sha256',
        '-',
      ],
      { timeoutMs: 15_000 },
    );
    const frameHashes = hashes
      .split('\n')
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => line.split(',').at(-1)?.trim());
    expect(new Set(frameHashes).size).toBeGreaterThanOrEqual(2);
    expect(manifest.source.recording).toMatchObject({
      byteLength: bytes.length,
      digest: digest(bytes),
    });
    const frame = await h.person(
      `task-a/review/walkthroughs/${id}/frames/frame-0`,
    );
    expect(frame.status).toBe(200);
    expect(Buffer.from(await frame.arrayBuffer()).equals(FRAME_RED)).toBe(true);
    expect((await h.person(`task-b/review/walkthroughs/${id}`)).status).toBe(
      404,
    );
    expect(
      (await h.person(`task-b/review/walkthroughs/${id}/video`)).status,
    ).toBe(404);
    expect(
      (await h.person(`task-b/review/walkthroughs/${id}/frames/frame-0`))
        .status,
    ).toBe(404);
    expect((await h.person('task-a/review/walkthroughs?limit=51')).status).toBe(
      400,
    );
    expect(readdirSync(root).some((name) => name.startsWith('.pending-'))).toBe(
      false,
    );
  },
);

test.skipIf(!mediaReady)(
  'real encoder aborts an over-byte recording and removes all temporary files',
  async () => {
    const h = await harness({ recording: true });
    const result = await h.record(h.bound, { durationMs: 500, maxBytes: 128 });
    expect(result).toMatchObject({
      ok: false,
      code: 'recording-too-large',
      message: 'Encoded recording exceeds the byte limit.',
    });
    const root = join(
      h.home,
      'projects',
      PROJECT_SLUG,
      'walkthroughs',
      '.task-clips',
    );
    expect(readdirSync(root)).toEqual([]);
    expect(await (await h.person('task-a/review/walkthroughs')).json()).toEqual(
      { success: true, data: { items: [] } },
    );
  },
);

test.skipIf(!mediaReady)(
  'a workspace changed during recording is refused and the staged clip is removed',
  async () => {
    const h = await harness({
      recording: true,
      duringFrame: (workspace) =>
        writeFileSync(
          join(workspace, 'file.txt'),
          'changed during recording\n',
        ),
    });
    expect(await h.record()).toMatchObject({
      ok: false,
      code: 'workspace-changed',
    });
    const root = join(
      h.home,
      'projects',
      PROJECT_SLUG,
      'walkthroughs',
      '.task-clips',
    );
    expect(readdirSync(root)).toEqual([]);
  },
);

test('recording refuses storage inside a registered Project workspace before streaming', async () => {
  const h = await harness({
    recording: true,
    storageInRepository: true,
    // Storage admission must refuse before any stream or encoder is opened.
    encoderPath: join(temporary('station-unused-encoder-'), 'ffmpeg'),
  });
  const result = await h.record();
  expect(result).toMatchObject({
    ok: false,
    code: 'capture-unavailable',
    message: 'Task Walkthrough storage is inside a Project workspace.',
  });
  expect(h.streams()).toBe(0);
  expect(
    existsSync(join(h.home, 'projects', PROJECT_SLUG, 'walkthroughs')),
  ).toBe(false);
});

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

function probeProcesses(home: string) {
  return execFileSync('/bin/ps', ['-axo', 'pid,ppid,command'], {
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  })
    .split('\n')
    .filter((line) => line.includes(home) && line.includes('ffmpeg'));
}

function probeRoot(home: string) {
  return join(home, 'projects', PROJECT_SLUG, 'walkthroughs', '.task-clips');
}

async function probeRequest(
  h: Awaited<ReturnType<typeof harness>>,
  signal: AbortSignal,
  durationMs: number,
) {
  return (
    await h.request('/api/browser-agent/record-to-task', {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        'x-internal': '1',
        [STATION_CONTROL_CALLER_TOKEN_HEADER]: h.bound,
      },
      body: JSON.stringify({ durationMs }),
    })
  ).json();
}

async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('recording cleanup timed out')),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function expectNoClip(h: Awaited<ReturnType<typeof harness>>) {
  expect(
    readdirSync(probeRoot(h.home)).filter((name) =>
      name.startsWith('.pending-'),
    ),
  ).toEqual([]);
  expect(await (await h.person('task-a/review/walkthroughs')).json()).toEqual({
    success: true,
    data: { items: [] },
  });
}

test.skipIf(!mediaReady)(
  'request abort during capture releases the recorder and publishes no clip',
  async () => {
    const h = await harness({ recording: true });
    const controller = new AbortController();
    const pending = probeRequest(h, controller.signal, 700);
    await h.streamStarted;
    const watcher = h.watch();
    await vi.waitFor(() => {
      const stage = readdirSync(probeRoot(h.home)).find((name) =>
        name.startsWith('.pending-'),
      );
      expect(stage).toBeDefined();
      expect(readdirSync(join(probeRoot(h.home), stage!))).toContain(
        'frame-0000.jpg',
      );
    });
    controller.abort();
    const result = await within(pending, 2500);
    const viewersAfterAbort = watcher.count() - 1;
    watcher.viewer.close();
    const list = await (await h.person('task-a/review/walkthroughs')).json();
    expect(result).toMatchObject({ ok: false, code: 'cancelled' });
    expect(viewersAfterAbort).toBe(0);
    expect(list).toEqual({ success: true, data: { items: [] } });
    await expectNoClip(h);
  },
);

test
  .skipIf(!mediaReady || process.platform === 'win32')
  .each(['request', 'browser', 'runtime'] as const)(
  '%s disposal during encoding joins real ffmpeg and removes staging',
  async (cause) => {
    const dir = temporary('station-recording-encoder-');
    const pidPath = join(dir, 'pid');
    const wrapper = join(dir, 'ffmpeg');
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    writeFileSync(
      wrapper,
      `#!/bin/sh\nprintf '%s' "$$" > ${quote(pidPath)}\nexec ${quote(ffmpeg!)} -readrate 0.5 "$@"\n`,
      { mode: 0o700 },
    );
    const h = await harness({
      recording: true,
      continuousFrames: true,
      encoderPath: wrapper,
    });
    const controller = new AbortController();
    const pending = probeRequest(h, controller.signal, 4000);
    await h.streamStarted;
    const watcher = h.watch();
    await vi.waitFor(
      () => {
        expect(existsSync(pidPath)).toBe(true);
        expect(probeProcesses(h.home)).toHaveLength(1);
      },
      { timeout: 8000, interval: 40 },
    );
    const pid = Number(readFileSync(pidPath, 'utf8'));
    let stopped: Promise<void> = Promise.resolve();
    if (cause === 'request') controller.abort();
    else if (cause === 'browser') stopped = h.stopBrowser();
    else stopped = h.stopRuntime();
    const [, result] = await within(
      Promise.all([stopped, pending]),
      1800,
    ).catch((error: unknown) => {
      if (
        !(error instanceof Error) ||
        error.message !== 'recording cleanup timed out'
      )
        throw error;
      const running = probeProcesses(h.home);
      const staging = readdirSync(probeRoot(h.home)).filter((name) =>
        name.startsWith('.pending-'),
      );
      throw new Error(
        `recording cleanup timed out: ffmpeg=${JSON.stringify(running)}, staging=${JSON.stringify(staging)}`,
        { cause: error },
      );
    });
    expect(result).toMatchObject({ ok: false, code: 'cancelled' });
    if (cause === 'request') expect(watcher.count()).toBe(1);
    else expect(watcher.viewer.closed).toBe(true);
    watcher.viewer.close();
    expect(() => process.kill(pid, 0)).toThrow();
    expect(probeProcesses(h.home)).toEqual([]);
    await expectNoClip(h);
  },
  15000,
);

test.skipIf(!mediaReady)(
  'runtime disposal owns recordings even before a Browser surface is selected',
  async () => {
    let entered!: () => void;
    let release!: () => void;
    const resolving = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = await harness({
      recording: true,
      beforeResolveFfmpeg: async () => {
        entered();
        await gate;
      },
    });
    const pending = h.record(h.bound, { durationMs: 700 });
    await resolving;
    let disposing!: () => void;
    const disposeStarted = new Promise<void>((resolve) => {
      disposing = resolve;
    });
    const dispose = TaskBrowserRecording.prototype.dispose;
    vi.spyOn(TaskBrowserRecording.prototype, 'dispose').mockImplementation(
      function (this: TaskBrowserRecording) {
        disposing();
        return dispose.call(this);
      },
    );
    const stopped = h.stopRuntime();
    await within(disposeStarted, 2500);
    release();
    const [, result] = await within(Promise.all([stopped, pending]), 2500);
    expect(result).toMatchObject({ ok: false, code: 'cancelled' });
    expect(existsSync(probeRoot(h.home))).toBe(false);
  },
);

test.skipIf(!mediaReady)(
  'runtime shutdown cancels capture before waiting for configuration work',
  async () => {
    let release!: () => void;
    const configurationDrain = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = await harness({ recording: true });
    const controller = new AbortController();
    const pending = probeRequest(h, controller.signal, 700);
    await h.streamStarted;
    const watcher = h.watch();
    const stopped = h.stopRuntime(configurationDrain);
    try {
      expect(await within(pending, 2500)).toMatchObject({
        ok: false,
        code: 'cancelled',
      });
      expect(watcher.count()).toBe(1);
      await expectNoClip(h);
    } finally {
      watcher.viewer.close();
      release();
      await stopped;
    }
  },
);

test.skipIf(!mediaReady)(
  'request abort during the final publication check leaves no clip',
  async () => {
    let entered!: () => void;
    let release!: () => void;
    const checking = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const publish = TaskWalkthroughStore.prototype.publish;
    vi.spyOn(TaskWalkthroughStore.prototype, 'publish').mockImplementation(
      async function (
        this: TaskWalkthroughStore,
        access,
        stage,
        manifest,
        authorize,
        signal,
      ) {
        return publish.call(
          this,
          access,
          stage,
          manifest,
          async () => {
            entered();
            await gate;
            return authorize();
          },
          signal,
        );
      },
    );
    const h = await harness({ recording: true });
    const controller = new AbortController();
    const pending = probeRequest(h, controller.signal, 500);
    await checking;
    controller.abort();
    release();
    expect(await within(pending, 2500)).toMatchObject({
      ok: false,
      code: 'cancelled',
    });
    await expectNoClip(h);
  },
);

test.skipIf(!mediaReady || process.platform === 'win32')(
  'byte overflow closes the recorder subscription, process, and staging',
  async () => {
    const h = await harness({ recording: true });
    const pending = h.record(h.bound, { durationMs: 500, maxBytes: 128 });
    await h.streamStarted;
    const watcher = h.watch();
    const result = await pending;
    expect(result).toMatchObject({ ok: false, code: 'recording-too-large' });
    expect(watcher.count() - 1).toBe(0);
    watcher.viewer.close();
    expect(probeProcesses(h.home)).toEqual([]);
    await expectNoClip(h);
  },
);
