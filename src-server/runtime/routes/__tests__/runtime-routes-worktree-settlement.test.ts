/**
 * #4771: the worktree settlement route through the production runtime
 * composition (`configureRuntimeRoutes`: the credential pipeline, the
 * pairing scope table, the conversation authority binding and the mount),
 * over a real orchestration SQLite store, a real repository and the real
 * settlement service. Stand-ins: the support services, and an operator
 * credential whose granted scope the test chooses.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { __resetStationServerSelfAttestationForTests } from '../../../security/station-server-scope.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../../services/identity/principal-resolver.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
import { TaskGraphService } from '../../../services/projects/task-graph-service.js';
import { WorktreeOutputSettlementService } from '../../../services/projects/worktree-output-settlement-service.js';
import { WorktreeProvisioningService } from '../../../services/projects/worktree-provisioning-service.js';
import { configureRuntimeRoutes } from '../runtime-routes.js';

vi.mock('../runtime-route-support.js', () => {
  const stub = new Proxy({}, { get: () => () => undefined });
  return {
    configureRuntimeSupportServices: () => ({
      schedulerService: stub,
      notificationService: stub,
      attentionProjection: stub,
      webPushService: stub,
      webPushEnabled: false,
    }),
    createRuntimeSystemRouteDeps: () => stub,
  };
});

/** Answers every unlisted member with an inert, non-thenable proxy. */
function deepStub<T extends object>(overrides: T): T {
  return new Proxy(overrides, {
    get(target, property) {
      if (property in target) return Reflect.get(target, property);
      const proxy: unknown = new Proxy(() => undefined, {
        get: (_target, property) => (property === 'then' ? undefined : proxy),
      });
      return proxy;
    },
  }) as T;
}

const OPERATE = 'test-only-worktree-settlement-operate';
const READ_ONLY = 'test-only-worktree-settlement-read';
const makeTempDir = trackTempDirs();

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
  }).trim();
}

describe('worktree settlement through the runtime route composition (#4771)', () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
  });

  async function setup() {
    const homeDir = makeTempDir('runtime-worktree-settlement-');
    __resetStationServerSelfAttestationForTests();
    const store = new EventStore(join(homeDir, 'orchestration.sqlite'));
    closers.push(async () => {
      await store.close();
    });
    const orchestration = new OrchestrationService({
      adapterRegistry: {
        register() {},
        get: () => undefined,
        list: () => [],
      } as never,
      eventBus: new EventBus(),
      eventStore: store,
      logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn() } as never,
    });
    closers.unshift(async () => {
      await orchestration.shutdown();
    });
    const settlements = new WorktreeOutputSettlementService({
      store: store.worktreeOutputSettlementStore(),
      worktrees: new WorktreeProvisioningService(),
      pullRequestProviders: () => [],
    });

    const app = new Hono();
    let resolvePort!: (port: number) => void;
    const listening = new Promise<number>((resolve) => {
      resolvePort = resolve;
    });
    const server = serve(
      { fetch: app.fetch, hostname: '127.0.0.1', port: 0 },
      (info) => resolvePort((info as AddressInfo).port),
    );
    closers.unshift(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    const port = await listening;
    const projectService = {
      listProjects: () => [],
      getProject: () => {
        throw new Error('no project');
      },
    };
    const scopes: Record<string, string> = {
      [OPERATE]: 'orchestration:read orchestration:operate',
      [READ_ONLY]: 'orchestration:read',
    };
    const context = deepStub({
      projectSharedTasks: undefined,
      deploymentAuthentication: undefined,
      localAccounts: undefined,
      applicationSessions: undefined,
      app,
      port,
      appConfig: {},
      configLoader: {
        getProjectHomeDir: () => homeDir,
        loadAppConfig: () => ({}),
      },
      logger: { debug() {}, info() {}, warn: vi.fn(), error() {} },
      activeAgents: new Map(),
      agentService: { listAgents: () => [] },
      agentMetadataMap: new Map(),
      agentFixedTokens: new Map(),
      agentTools: new Map(),
      agentStats: new Map(),
      agentStatus: new Map(),
      memoryAdapters: new Map(),
      metricsLog: [],
      monitoringEvents: [],
      orchestrationEventStore: store,
      orchestrationService: orchestration,
      projectMembership: undefined,
      projectService,
      taskGraphService: new TaskGraphService(homeDir, {
        projectService: projectService as never,
      }),
      storageAdapter: deepStub({}),
      worktreeOutputSettlements: () => settlements,
      environmentSecurityService: deepStub({
        verifyCredential: (credential: string) => credential in scopes,
        authorizeCredential: (credential: string) => credential in scopes,
        verifyOperatorCredential: (credential: string) => credential in scopes,
        resolveGrantedScope: (credential: string) => scopes[credential],
        identifyDevice: () => undefined,
      }),
    });
    Reflect.set(context as object, 'buildRuntimeContext', () => context);
    const configured = configureRuntimeRoutes(
      context as unknown as Parameters<typeof configureRuntimeRoutes>[0],
    );
    closers.unshift(async () => {
      await configured.projectTaskRoomRuntime?.close();
    });
    await configured.kitLifecycleReady;

    const call = async (
      credential: string,
      method: string,
      path: string,
      body?: unknown,
    ) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${credential}`,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      let json: any;
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
      return { status: response.status, json };
    };
    return { store, orchestration, call };
  }

  test('the operator settles their Session; the read scope reads but cannot settle', async () => {
    const { store, orchestration, call } = await setup();
    const parent = realpathSync(
      makeTempDir('runtime-worktree-settlement-repo-'),
    );
    const repo = join(parent, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '--quiet', '--initial-branch=main');
    writeFileSync(join(repo, 'README.md'), 'project\n');
    git(repo, 'add', 'README.md');
    git(repo, 'commit', '--quiet', '-m', 'initial');
    const sessionId = 'route-session';
    const metadata = await new WorktreeProvisioningService().provision({
      repoPath: repo,
      threadId: sessionId,
      providerKind: 'codex',
      isolation: { mode: 'worktree', policy: { cleanupOnCompletion: false } },
    });
    if (!metadata) throw new Error('no worktree');
    orchestration.seedSessionRecord({
      threadId: sessionId,
      provider: 'codex',
      ownerUserId: LOCAL_OPERATOR_PRINCIPAL_ID,
    });
    store.appendEvent({
      eventId: 'route-session-worktree',
      threadId: sessionId,
      sessionId,
      provider: 'codex',
      method: 'session.started',
      createdAt: new Date().toISOString(),
      metadata: { worktree: metadata },
    } as never);
    const path = `/api/orchestration/sessions/${sessionId}/worktree-settlement`;
    const discard = { requestKey: 'discard-1', outcome: 'discarded' };

    expect(await call(READ_ONLY, 'GET', path)).toMatchObject({
      status: 200,
      json: { success: true, data: { settlement: null } },
    });
    const refused = await call(READ_ONLY, 'POST', path, discard);
    expect(refused.status).toBe(403);
    expect(existsSync(metadata.path)).toBe(true);

    expect(
      await call(OPERATE, 'POST', path, {
        ...discard,
        actor: { kind: 'person', id: 'someone-else' },
      }),
    ).toMatchObject({ status: 400 });
    const recorded = await call(OPERATE, 'POST', path, discard);
    expect(recorded).toMatchObject({
      status: 201,
      json: {
        data: {
          status: 'recorded',
          settlement: {
            outcome: 'discarded',
            actor: { kind: 'person', id: LOCAL_OPERATOR_PRINCIPAL_ID },
          },
        },
      },
    });
    expect(existsSync(metadata.path)).toBe(false);
    expect(await call(READ_ONLY, 'GET', path)).toMatchObject({
      status: 200,
      json: { data: { settlement: { outcome: 'discarded' } } },
    });
  });
});
