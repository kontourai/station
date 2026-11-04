/**
 * #4507: a Task dispatched on a worktree-isolated Project runs in that
 * Task's own worktree.
 *
 * Drives the real dispatch route, the real Dispatcher and TaskGraph
 * adapters, the real `resolveTaskDispatchAgentStart` resolver, the real
 * `WorktreeProvisioningService` against a real git repository, and a real
 * OrchestrationService (with its Project list, so a directory outside the
 * Project must be admitted) over a real EventStore. Only the engine is a
 * fake; it records the directory it was started in. The Station's own HTTP
 * reads are answered in the shapes the real routes return.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  engineConnectionId,
  engineId,
} from '@kontourai/station-contracts/agent-identity';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readJson } from '../../../__test-utils__/read-json.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import type {
  ProviderAdapterMetadata,
  ProviderAdapterShape,
  ProviderSendTurnInput,
  ProviderSessionStartInput,
} from '../../../providers/adapter-shape.js';
import { AsyncEventQueue } from '../../../providers/sessions/async-event-queue.js';
import { setRuntimeAuthenticatedRequestPrincipal } from '../../../security/runtime-request-security.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
import { createSessionAgentResolver } from '../../../services/orchestration/session-agent-resolution.js';
import { composeTaskDispatcher } from '../../../services/projects/task-dispatch-composition.js';
import { TaskGraphService } from '../../../services/projects/task-graph-service.js';
import { WorktreeProvisioningService } from '../../../services/projects/worktree-provisioning-service.js';
import {
  assertTaskDispatchAgentExists,
  resolveTaskDispatchAgentStart,
} from '../../../tools/station-control-delegation.js';
import { createTaskRoutes } from '../tasks.js';

const CURRENT_API = 'http://task-dispatch-worktree.test';
const ENVIRONMENT_ID = 'environment-current';
const OWNER = 'owner';

class FakeClaudeAdapter implements ProviderAdapterShape {
  readonly provider = 'claude' as const;
  private readonly events = new AsyncEventQueue<CanonicalRuntimeEvent>();
  private readonly sessions = new Map<string, { threadId: string }>();
  readonly startSession = vi.fn(async (input: ProviderSessionStartInput) => {
    const now = new Date().toISOString();
    const session = {
      provider: this.provider,
      threadId: input.threadId,
      status: 'ready' as const,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(input.threadId, session);
    this.events.push({
      eventId: crypto.randomUUID(),
      provider: this.provider,
      threadId: input.threadId,
      sessionId: input.threadId,
      method: 'session.started',
      initialState: 'created',
      createdAt: now,
      metadata: { ...input.metadata, cwd: input.cwd },
    } as CanonicalRuntimeEvent);
    return session;
  });
  readonly sendTurn = vi.fn(async (input: ProviderSendTurnInput) => ({
    threadId: input.threadId,
    turnId: `turn-${this.sendTurn.mock.calls.length}`,
  }));
  readonly interruptTurn = vi.fn(async () => ({
    outcome: 'no-active-turn' as const,
  }));
  readonly steerTurn = vi.fn(async () => undefined);
  readonly respondToRequest = vi.fn(async () => undefined);
  async listSessions() {
    return [];
  }
  async hasSession(threadId: string) {
    return this.sessions.has(threadId);
  }
  async discardSession(threadId: string) {
    this.sessions.delete(threadId);
  }
  async stopSession(threadId: string) {
    this.sessions.delete(threadId);
  }
  async stopAll() {
    this.sessions.clear();
  }
  async getPrerequisites() {
    return [];
  }
  streamEvents(options?: { signal?: AbortSignal }) {
    return this.events.iterable(options);
  }
  readonly metadata: ProviderAdapterMetadata = {
    displayName: 'Claude Runtime',
    description: 'claude adapter for tests',
    capabilities: ['agent-runtime'],
    engineId: engineId('claude'),
    builtin: true,
    modelLaunch: {
      defaultAtStart: 'engine-selected',
      omissionAtResume: 'engine-selected',
      omissionPerTurn: 'engine-selected',
      overrideAtStart: true,
      overrideAtResume: true,
      overridePerTurn: true,
    },
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function installCurrentStation(
  projectDirectory: string,
  isolation: 'shared' | 'worktree' | undefined,
) {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === `${CURRENT_API}/.well-known/station/v1`)
        return json({ environmentId: ENVIRONMENT_ID });
      if (url === `${CURRENT_API}/api/agents/task-lead`)
        return json({
          success: true,
          data: {
            slug: 'task-lead',
            name: 'Task lead',
            available: true,
            execution: { agentConnectionId: 'claude', modelId: 'haiku' },
          },
        });
      if (url === `${CURRENT_API}/api/connections/claude`)
        return json({
          success: true,
          data: {
            id: 'claude',
            kind: 'agent',
            type: 'claude',
            name: 'Claude Code',
            enabled: true,
            capabilities: ['agent-runtime'],
            config: { provider: 'claude' },
            status: 'ready',
            prerequisites: [],
          },
        });
      if (url === `${CURRENT_API}/api/projects/project-alpha`)
        return json({
          success: true,
          data: {
            id: 'project-alpha',
            slug: 'project-alpha',
            name: 'Project alpha',
            workingDirectory: projectDirectory,
            ...(isolation ? { defaultWorkspaceIsolation: isolation } : {}),
          },
        });
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Station Test',
      GIT_AUTHOR_EMAIL: 'test@station.invalid',
      GIT_COMMITTER_NAME: 'Station Test',
      GIT_COMMITTER_EMAIL: 'test@station.invalid',
    },
    windowsHide: true,
  });
}

/** The linked worktrees git has registered for `repo`, canonical paths. */
function linkedWorktrees(repo: string): { path: string; branch?: string }[] {
  const entries: { path: string; branch?: string }[] = [];
  for (const block of git(repo, 'worktree', 'list', '--porcelain')
    .trim()
    .split('\n\n')) {
    const lines = block.split('\n');
    const path = lines
      .find((line) => line.startsWith('worktree '))
      ?.slice('worktree '.length);
    const branch = lines
      .find((line) => line.startsWith('branch '))
      ?.slice('branch refs/heads/'.length);
    if (path && realpathSync(path) !== realpathSync(repo))
      entries.push({ path: realpathSync(path), ...(branch ? { branch } : {}) });
  }
  return entries;
}

describe('Task dispatch honours the Project worktree isolation (#4507)', () => {
  const makeTempDir = trackTempDirs();
  const services: OrchestrationService[] = [];
  const stores: EventStore[] = [];
  let home: string;
  let workspace: string;

  beforeEach(() => {
    process.env.STATION_API_BASE = CURRENT_API;
    process.env.STATION_INTERNAL_API_TOKEN = 'internal-test-token';
    home = makeTempDir('task-dispatch-wt-home-');
    // The repository sits inside its own temp parent, so the default
    // `<repo>-worktrees` sibling is cleaned up with it.
    const parent = realpathSync(makeTempDir('task-dispatch-wt-'));
    workspace = join(parent, 'repo');
    mkdirSync(workspace);
    git(workspace, 'init', '--quiet', '--initial-branch=main');
    writeFileSync(join(workspace, 'README.md'), 'project\n');
    git(workspace, 'add', 'README.md');
    git(workspace, 'commit', '--quiet', '-m', 'initial');
  });

  afterEach(async () => {
    try {
      for (const service of services.splice(0)) await service.shutdown();
    } finally {
      for (const store of stores.splice(0)) store.close();
      vi.unstubAllGlobals();
    }
  });

  function compose(
    worktreeProvisioning?: ConstructorParameters<
      typeof TaskGraphService
    >[1]['worktreeProvisioning'],
  ) {
    const eventStore = new EventStore(join(home, 'orchestration.sqlite'));
    stores.push(eventStore);
    const claude = new FakeClaudeAdapter();
    const service = new OrchestrationService({
      adapterRegistry: {
        register() {},
        get: (provider: string) =>
          provider === claude.provider ? claude : undefined,
        list: () => [claude],
      },
      eventBus: new EventBus(),
      eventStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
      // Production lists Projects, so a start outside the Project folder is
      // refused unless the server admitted that exact directory.
      listProjects: () => [
        { slug: 'project-alpha', id: 'project-alpha', workingDirectory: workspace },
      ],
      resolveSessionAgent: createSessionAgentResolver({
        loadAgentSpec: async (slug) =>
          slug === 'task-lead'
            ? {
                name: 'Task lead',
                prompt: 'You lead this Task.',
                execution: {
                  agentConnectionId: engineConnectionId('claude'),
                  modelId: 'haiku',
                },
              }
            : null,
        resolveToolServer: async () => null,
        resolveSkillDir: async () => null,
      }),
    });
    services.push(service);
    const graph = new TaskGraphService(home, {
      orchestrationService: service,
      projectService: {
        getProject: (slug: string) => {
          if (slug !== 'project-alpha') throw new Error('missing project');
          return {
            id: slug,
            slug,
            name: 'Project alpha',
            workingDirectory: workspace,
            createdAt: '2026-11-04T00:00:00.000Z',
            updatedAt: '2026-11-04T00:00:00.000Z',
          };
        },
      },
      ...(worktreeProvisioning ? { worktreeProvisioning } : {}),
    });
    const dispatcher = composeTaskDispatcher(graph, {
      resolveAgentStart: (input) =>
        resolveTaskDispatchAgentStart(input, service),
      assertAgentExists: (agentId) =>
        assertTaskDispatchAgentExists(agentId, service),
    });
    const routes = createTaskRoutes(graph, {
      taskDispatcher: dispatcher,
      readAuthorityForRequest: () =>
        sessionReadAuthorityFromRequest(OWNER, undefined, undefined),
      canReadSession: () => true,
      resolveProjectWorkspace: (projectId: string) =>
        projectId === 'project-alpha' ? workspace : undefined,
    });
    const app = new Hono();
    app.use('*', async (c, next) => {
      setRuntimeAuthenticatedRequestPrincipal(c.req.raw, {
        credential: 'operator-credential',
        authority: 'operator-credential',
        source: 'bearer',
      });
      await next();
    });
    app.route('/', routes);
    return { app, graph, claude, dispatcher };
  }

  async function createTask(app: Hono, title: string): Promise<string> {
    const created = await readJson(
      await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: 'project-alpha',
          title,
          agentId: 'task-lead',
        }),
      }),
    );
    expect(created.success).toBe(true);
    return created.data.id as string;
  }

  async function dispatch(app: Hono, taskId: string) {
    const response = await app.request(`/${taskId}/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'task-lead', sourceSurface: 'project-page' }),
    });
    const body = await readJson(response);
    expect(body.error).toBeUndefined();
    expect(body.data.dispatch).toMatchObject({ outcome: 'started' });
    return body.data.dispatch.sessionId as string;
  }

  function startOf(
    claude: FakeClaudeAdapter,
    sessionId: string,
  ): ProviderSessionStartInput {
    const start = claude.startSession.mock.calls
      .map(([input]) => input)
      .find((input) => input.threadId === sessionId);
    if (!start) throw new Error(`No engine start for ${sessionId}`);
    return start;
  }

  test('two concurrent dispatches of different Tasks get distinct checkouts', async () => {
    installCurrentStation(workspace, 'worktree');
    const { app, graph, claude } = compose();
    const first = await createTask(app, 'First Task');
    const second = await createTask(app, 'Second Task');

    const [firstSession, secondSession] = await Promise.all([
      dispatch(app, first),
      dispatch(app, second),
    ]);
    const firstCwd = startOf(claude, firstSession).cwd!;
    const secondCwd = startOf(claude, secondSession).cwd!;

    // Each Session runs in a checkout of its own, neither of them the
    // Project's shared checkout.
    expect(realpathSync(firstCwd)).not.toBe(workspace);
    expect(realpathSync(secondCwd)).not.toBe(workspace);
    expect(realpathSync(firstCwd)).not.toBe(realpathSync(secondCwd));
    const registered = linkedWorktrees(workspace);
    expect(registered.map((entry) => entry.path).sort()).toEqual(
      [realpathSync(firstCwd), realpathSync(secondCwd)].sort(),
    );

    // A file one Task writes is in its checkout only.
    writeFileSync(join(firstCwd, 'first-only.txt'), 'first\n');
    expect(existsSync(join(firstCwd, 'first-only.txt'))).toBe(true);
    expect(existsSync(join(secondCwd, 'first-only.txt'))).toBe(false);
    expect(existsSync(join(workspace, 'first-only.txt'))).toBe(false);
    expect(readFileSync(join(secondCwd, 'README.md'), 'utf8')).toBe(
      'project\n',
    );

    // The Task records its worktree, on a branch derived from the Task, and
    // the start records the real binding rather than `shared`.
    const firstTask = graph.readTaskView(first)!;
    expect(firstTask.taskWorktree).toMatchObject({
      mode: 'worktree',
      path: firstCwd,
      owner: { kind: 'task', taskId: first },
    });
    expect(firstTask.taskWorktree!.branch).toMatch(
      new RegExp(`^station/task/task-${first}-[0-9a-f]{32}$`),
    );
    expect(
      registered.find((entry) => entry.path === realpathSync(firstCwd))
        ?.branch,
    ).toBe(firstTask.taskWorktree!.branch);
    expect(startOf(claude, firstSession)).toMatchObject({
      workspaceIsolation: { mode: 'worktree' },
      metadata: expect.objectContaining({
        workspaceIsolation: { mode: 'worktree' },
        worktree: expect.objectContaining({ path: firstCwd }),
        projectSlug: 'project-alpha',
      }),
    });
    // The Project checkout binding is unchanged, so the Task view still
    // reads it as available.
    expect((await graph.readTaskForOpen(first))?.workspaceBinding).toMatchObject(
      { availability: 'available', workingDirectory: workspace },
    );
  });

  test('a second dispatch of the same Task reuses its worktree and branch; canceling preserves it', async () => {
    installCurrentStation(workspace, 'worktree');
    const { app, graph, claude } = compose();
    const taskId = await createTask(app, 'Reused Task');

    const firstSession = await dispatch(app, taskId);
    const firstCwd = startOf(claude, firstSession).cwd!;
    const recorded = graph.readTaskView(taskId)!.taskWorktree!;
    writeFileSync(join(firstCwd, 'progress.txt'), 'work so far\n');

    // Re-dispatch: the Task leaves in_progress through blocked.
    await graph.updateTaskStatus(taskId, 'blocked');
    const secondSession = await dispatch(app, taskId);
    expect(secondSession).not.toBe(firstSession);
    const secondCwd = startOf(claude, secondSession).cwd!;

    expect(secondCwd).toBe(firstCwd);
    expect(readFileSync(join(secondCwd, 'progress.txt'), 'utf8')).toBe(
      'work so far\n',
    );
    expect(graph.readTaskView(taskId)!.taskWorktree).toEqual(recorded);
    expect(linkedWorktrees(workspace)).toEqual([
      { path: realpathSync(firstCwd), branch: recorded.branch },
    ]);

    // A canceled Task did not complete: its worktree and branch are kept
    // (`preserveOnFailure` defaults to true), and so is the record.
    await graph.updateTaskStatus(taskId, 'canceled');
    expect(existsSync(join(firstCwd, 'progress.txt'))).toBe(true);
    expect(graph.readTaskView(taskId)!.taskWorktree).toEqual(recorded);
  });

  test('a shared Project dispatches in its shared checkout, unchanged', async () => {
    installCurrentStation(workspace, undefined);
    const { app, graph, claude } = compose();
    const taskId = await createTask(app, 'Shared Task');

    const sessionId = await dispatch(app, taskId);
    const start = startOf(claude, sessionId);

    expect(realpathSync(start.cwd!)).toBe(workspace);
    expect(start.workspaceIsolation).toEqual({ mode: 'shared' });
    expect(start.metadata).toMatchObject({
      workspaceIsolation: { mode: 'shared' },
    });
    expect(start.metadata?.worktree).toBeUndefined();
    expect(graph.readTaskView(taskId)!.taskWorktree).toBeUndefined();
    expect(linkedWorktrees(workspace)).toEqual([]);
  });

  test('a dispatch that times out during provisioning leaves no unowned worktree', async () => {
    installCurrentStation(workspace, 'worktree');
    const real = new WorktreeProvisioningService();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let provisioning: Promise<unknown> | undefined;
    const { app, graph, claude, dispatcher } = compose({
      // The real provisioning, held until the dispatch has stopped waiting.
      provisionForTask: (request) => {
        const pending = gate.then(() => real.provisionForTask(request));
        provisioning ??= pending;
        return pending;
      },
      finalizeForTask: (request) => real.finalizeForTask(request),
    });
    const taskId = await createTask(app, 'Slow Task');
    const before = graph.readTaskView(taskId)!;

    const outcome = await dispatcher.dispatch(taskId, {
      agentId: 'task-lead',
      ownerUserId: OWNER,
      fullAccessGrant: null,
      timeoutMs: 200,
    });

    // Nothing started and nothing about the dispatch was written.
    expect(outcome).toMatchObject({ kind: 'aborted', retryable: true });
    expect(claude.startSession).not.toHaveBeenCalled();
    expect(graph.readTaskView(taskId)).toMatchObject({
      status: before.status,
      updatedAt: before.updatedAt,
    });
    expect(graph.readTaskView(taskId)!.taskWorktree).toBeUndefined();

    // The checkout finishes after the dispatch gave up. It is owned: the
    // Task records it, and it is the only worktree git has.
    release();
    await provisioning;
    await vi.waitFor(() =>
      expect(graph.readTaskView(taskId)!.taskWorktree).toBeDefined(),
    );
    const late = graph.readTaskView(taskId)!.taskWorktree!;
    expect(late.owner).toEqual({ kind: 'task', taskId });
    expect(linkedWorktrees(workspace)).toEqual([
      { path: realpathSync(late.path), branch: late.branch },
    ]);

    // The next dispatch runs in that same checkout.
    const sessionId = await dispatch(app, taskId);
    expect(startOf(claude, sessionId).cwd).toBe(late.path);
    expect(linkedWorktrees(workspace)).toHaveLength(1);

    // And the Task finishing removes it (`cleanupOnCompletion` defaults to
    // true) and forgets it.
    await graph.updateTaskStatus(taskId, 'done');
    expect(existsSync(late.path)).toBe(false);
    expect(linkedWorktrees(workspace)).toEqual([]);
    expect(
      git(workspace, 'branch', '--list', late.branch).trim(),
    ).toBe('');
    expect(graph.readTaskView(taskId)!.taskWorktree).toBeUndefined();
  });
});
