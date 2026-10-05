/**
 * #3161, end to end: a pull request an EXTERNAL engine declares reaches the
 * Task, and a Task a person opted in closes when that pull request merges.
 *
 * Everything between the engine and the Task is real: the engine's own
 * station-control MCP connection (`/mcp/station-control` with the URL token a
 * Codex session is given), the tool, the production runtime composition
 * (`configureRuntimeRoutes`: credential pipeline, authority guard, caller and
 * scope derivation, the declare route), the real `OrchestrationService` over a
 * real SQLite event store, the real declaration operation and exact-identity
 * resolver, the real session-outputs and Task keep routes, the real
 * `TaskGraphService` and its close-out. The stand-ins are the engine itself
 * (a fake Codex adapter whose turn events the test publishes), the forge (a
 * fake provider that reports each pull request's state) and the repository
 * the workspace is.
 */
import { mkdirSync, realpathSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import type {
  PullRequest,
  PullRequestRepositoryIdentityContext,
  PullRequestResult,
} from '@kontourai/station-contracts/pull-request-provider';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { registerPullRequestProvider } from '../../../providers/registries/registry.js';
import { AsyncEventQueue } from '../../../providers/sessions/async-event-queue.js';
import { __resetStationServerSelfAttestationForTests } from '../../../security/station-server-scope.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../../services/identity/principal-resolver.js';
import { NotificationService } from '../../../services/notifications/notification-service.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
import { SESSION_LOCAL_PROJECT_ID_METADATA_KEY } from '../../../services/orchestration/session-project-identity.js';
import { TaskGraphService } from '../../../services/projects/task-graph-service.js';
import { NativeDeclaredPullRequestResolver } from '../../../services/pull-requests/native-declared-pull-request-resolver.js';
import type { PullRequestRepositoryContextResolver } from '../../../services/pull-requests/pull-request-repository-context-resolver.js';
import { DevicePairingService } from '../../../services/ssh/device-pairing-service.js';
import {
  getInternalApiToken,
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_PROXY_CALLER_HEADER,
} from '../../../utils/internal-api-token.js';
import {
  __resetStationControlMcpTokensForTests,
  mintStationControlMcpToken,
} from '../../mcp/station-control-mcp-token.js';
import { configureRuntimeRoutes } from '../runtime-routes.js';

const support = vi.hoisted(() => ({
  notificationService: undefined as unknown,
}));

vi.mock('../runtime-route-support.js', () => {
  const stub = new Proxy({}, { get: () => () => undefined });
  return {
    configureRuntimeSupportServices: () => ({
      schedulerService: stub,
      notificationService: support.notificationService,
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

/**
 * The forge: pull requests of the workspace's repository, by state. The
 * provider registry keeps one provider per id for the life of the worker, so
 * the forge is one object and each test starts it empty.
 */
const states: Record<string, string> = {};
const forge = {
  id: 'testforge',
  canServeHost: (host: string) => host === 'forge.test',
  getHost: () => 'forge.test',
  getPullRequestByIdentity: async (
    context: PullRequestRepositoryIdentityContext,
    ref: string,
  ): Promise<PullRequestResult<PullRequest>> => {
    const state =
      states[`${context.repository.owner}/${context.repository.name}#${ref}`];
    if (!state) return { available: false, reason: 'not found' } as never;
    return {
      available: true,
      data: {
        provider: 'testforge',
        host: context.host,
        repository: context.repository,
        ref,
        nativeId: `native-${ref}`,
        url: 'https://forge.test/kontourai/station/pull/7',
        title: 'The fix',
        body: null,
        state,
        author: { login: 'codex' },
        sourceBranch: 'fix',
        targetBranch: 'main',
        commits: 1,
        reviewStatus: 'NONE',
        comments: 0,
        mergeability: 'unknown',
      },
    } as never;
  },
};

const OPERATOR_CREDENTIAL = 'test-only-operator-credential-declare-engine';
const THREAD = 'codex-session-1';
const PROJECT = 'project-alpha';
const AT = '2026-10-04T00:00:00.000Z';
const makeTempDir = trackTempDirs();

describe('an external engine declares a pull request: the Task shows it, a merge closes the Task', () => {
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    __resetStationControlMcpTokensForTests();
    for (const close of closers.splice(0)) await close();
  });

  async function setup() {
    const homeDir = makeTempDir('station-declare-engine-');
    const workspace = realpathSync(makeTempDir('station-declare-engine-ws-'));
    mkdirSync(workspace, { recursive: true });
    const notifications = new NotificationService(
      new EventBus(),
      homeDir,
      999_999,
    );
    closers.push(() => notifications.shutdown());
    support.notificationService = notifications;
    __resetStationServerSelfAttestationForTests();

    for (const key of Object.keys(states)) delete states[key];
    // The workspace is the repository `kontourai/station`.
    const contexts = {
      readExactIdentity: async <T>(
        _input: { workingDirectory?: string },
        read: (identity: PullRequestRepositoryIdentityContext) => Promise<T>,
      ) => {
        const identity: PullRequestRepositoryIdentityContext = {
          host: 'forge.test',
          repository: { owner: 'kontourai', name: 'station' },
        };
        return {
          available: true as const,
          identity,
          value: await read(identity),
        };
      },
    } satisfies Pick<PullRequestRepositoryContextResolver, 'readExactIdentity'>;

    // ── Station's own state: real store, service, Task graph ──────────────
    const store = new EventStore(join(homeDir, 'orchestration.sqlite'));
    closers.push(async () => {
      await store.close();
    });
    // Station reads an engine's events from `streamEvents`; this one has
    // none to say, since the test publishes the turn's events itself.
    const engineEvents = new AsyncEventQueue<CanonicalRuntimeEvent>();
    const adapter = {
      provider: 'codex',
      metadata: { displayName: 'Codex' },
      stopAll: async () => {},
      streamEvents: (options?: { signal?: AbortSignal }) =>
        engineEvents.iterable(options),
    };
    const orchestration = new OrchestrationService({
      adapterRegistry: {
        register() {},
        get: (id: string) => (id === 'codex' ? adapter : undefined),
        list: () => [adapter],
      } as never,
      eventBus: new EventBus(),
      eventStore: store,
      logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn() } as never,
      nativeDeclaredPullRequestResolver: new NativeDeclaredPullRequestResolver({
        providers: () => [forge as never],
        contexts,
      }),
    });
    closers.unshift(async () => {
      await orchestration.shutdown();
    });
    // Teardown runs the newest first: the engine's event stream ends before
    // the service shuts down (its shutdown marks sessions closed in the
    // store), and the store closes last.
    closers.unshift(async () => engineEvents.close());
    const projectService = {
      listProjects: () => [
        { id: PROJECT, slug: PROJECT, workingDirectory: workspace },
      ],
      getProject: (slug: string) => {
        if (slug !== PROJECT) throw new Error('missing project');
        return {
          id: PROJECT,
          slug: PROJECT,
          name: 'Project alpha',
          workingDirectory: workspace,
          createdAt: AT,
          updatedAt: AT,
        };
      },
    };
    const taskGraph = new TaskGraphService(homeDir, {
      projectService: projectService as never,
    });

    // The engine's session: Codex, owned by the operator, in project-alpha,
    // running a turn.
    (orchestration as any).sessionAdapters.set(THREAD, adapter);
    let eventNumber = 0;
    const emit = (event: Record<string, unknown>) => {
      eventNumber += 1;
      const eventId = `event-${eventNumber}`;
      (orchestration as any).projectAndPublishEvent({
        eventId,
        provider: 'codex',
        threadId: THREAD,
        createdAt: AT,
        ...event,
      } as CanonicalRuntimeEvent);
      return eventId;
    };
    emit({
      method: 'session.started',
      sessionId: THREAD,
      metadata: {
        userId: LOCAL_OPERATOR_PRINCIPAL_ID,
        [SESSION_LOCAL_PROJECT_ID_METADATA_KEY]: PROJECT,
      },
    });
    emit({ method: 'turn.started', turnId: 'turn-1', prompt: 'open a PR' });
    // The session the adapter started names the workspace it runs in.
    const started = (orchestration as any).sessionReadModel.get(THREAD);
    started.cwd = workspace;
    store.upsertSession({ ...started, cwd: workspace });

    // ── the runtime, listening ────────────────────────────────────────────
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
    // A real paired device on this host holding the read tier only
    // (local-grant, so it acts for the person; its scope is what is under test).
    const pairingHome = join(homeDir, 'pairing');
    mkdirSync(join(pairingHome, 'security'), { recursive: true, mode: 0o700 });
    const pairing = new DevicePairingService({
      homeDir: pairingHome,
      environmentId: '22222222-2222-4222-8222-222222222222',
    });
    const offer = pairing.createOffer({
      endpoint: 'https://station.example.test',
      scope: 'orchestration:read',
    });
    const pairRequest = pairing.requestPairing({
      requesterPosition: 'off-box',
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: 'Read-only device',
    });
    pairing.confirmRequest(pairRequest.requestId, { kind: 'local-grant' });
    const readerCredential = pairing.exchange({
      offerId: offer.offerId,
      proof: offer.challenge,
      requestId: pairRequest.requestId,
      locality: 'home-possession',
      mintKind: 'local-grant',
    }).credential;
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
      logger: { debug() {}, info() {}, warn() {}, error() {} },
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
      storageAdapter: deepStub({
        getProject: (slug: string) => {
          if (slug !== PROJECT) throw new Error('no project');
          return { id: PROJECT };
        },
      }),
      projectMembership: undefined,
      taskGraphService: taskGraph,
      projectService,
      environmentSecurityService: deepStub({
        verifyCredential: (credential: string) =>
          credential === OPERATOR_CREDENTIAL ||
          pairing.verifyCredential(credential),
        authorizeCredential: (credential: string) =>
          credential === OPERATOR_CREDENTIAL ||
          pairing.verifyCredential(credential),
        verifyOperatorCredential: (credential: string) =>
          credential === OPERATOR_CREDENTIAL,
        resolveGrantedScope: (credential: string) =>
          credential === OPERATOR_CREDENTIAL
            ? 'orchestration:read orchestration:operate'
            : pairing.identifyDevice(credential)?.scope,
        identifyDevice: (credential: string) =>
          pairing.identifyDevice(credential),
        credentialLocality: (credential: string) =>
          pairing.credentialLocality(credential),
        credentialMintKind: (credential: string) =>
          pairing.credentialMintKind(credential),
        devicePairing: pairing,
      }),
    });
    Reflect.set(context as object, 'buildRuntimeContext', () => context);
    const configured = configureRuntimeRoutes(
      context as unknown as Parameters<typeof configureRuntimeRoutes>[0],
    );
    await configured.kitLifecycleReady;
    // `configureRuntimeRoutes` registers the real forge CLIs (`github`,
    // `gitlab`); this fake is a provider of its own.
    registerPullRequestProvider(forge as never);
    const base = `http://127.0.0.1:${port}`;

    const operator = {
      'content-type': 'application/json',
      authorization: `Bearer ${OPERATOR_CREDENTIAL}`,
    };
    const asCredential = async (
      credential: string,
      method: string,
      path: string,
      body?: unknown,
    ): Promise<{ status: number; json: any }> => {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { ...operator, authorization: `Bearer ${credential}` },
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
    const asOperator = (method: string, path: string, body?: unknown) =>
      asCredential(OPERATOR_CREDENTIAL, method, path, body);
    const asReader = (method: string, path: string, body?: unknown) =>
      asCredential(readerCredential, method, path, body);

    /**
     * The engine's own station-control MCP connection: the URL-token
     * channel Codex is given (`bearer-exposed`), over streamable HTTP.
     */
    const mcpToken = mintStationControlMcpToken(THREAD, 'url-token').token;
    const mcp = async (id: number, method: string, params: object) => {
      const response = await fetch(
        `${base}/mcp/station-control?token=${mcpToken}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        },
      );
      const text = await response.text();
      const data = text
        .split('\n')
        .find((line) => line.startsWith('data: '))
        ?.slice('data: '.length);
      return JSON.parse(data ?? text);
    };
    await mcp(1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'codex', version: '0' },
    });
    const declare = async (
      args: Record<string, unknown>,
    ): Promise<{ isError: boolean; body: any }> => {
      const reply = await mcp(2, 'tools/call', {
        name: 'declare_pull_request',
        arguments: args,
      });
      const result = reply.result;
      const text = result?.content?.[0]?.text;
      return {
        isError: result?.isError === true || reply.error !== undefined,
        body: text ? JSON.parse(text) : reply,
      };
    };

    return {
      store,
      taskGraph,
      states,
      emit,
      declare,
      asOperator,
      asReader,
      workspace,
      base,
    };
  }

  const PR = {
    provider: 'testforge',
    host: 'forge.test',
    repository: { owner: 'kontourai', name: 'station' },
    ref: '7',
  };

  test('declared through the engine’s MCP connection, listed after the turn, kept onto the Task', async () => {
    const e = await setup();
    e.states['kontourai/station#7'] = 'OPEN';

    const declared = await e.declare({ ...PR, label: 'The fix' });
    expect(declared).toEqual({ isError: false, body: { status: 'declared' } });
    // The same call again is a repeat, not a second declaration.
    await expect(e.declare(PR)).resolves.toEqual({
      isError: false,
      body: { status: 'already-declared' },
    });

    // Nothing is listed until the turn completes.
    const before = await e.asOperator(
      'GET',
      `/api/orchestration/sessions/${THREAD}/outputs`,
    );
    expect(before.status).toBe(200);
    expect(before.json.data.items).toEqual([]);

    const eventId = e.emit({
      method: 'turn.completed',
      turnId: 'turn-1',
      finishReason: 'stop',
    });
    const listed = await e.asOperator(
      'GET',
      `/api/orchestration/sessions/${THREAD}/outputs`,
    );
    expect(listed.json.data.items).toEqual([
      expect.objectContaining({
        ref: { sessionId: THREAD, eventId },
        turnId: 'turn-1',
        label: 'The fix',
        descriptor: expect.objectContaining({
          kind: 'pull-request',
          provider: 'testforge',
          host: 'forge.test',
          repository: { owner: 'kontourai', name: 'station' },
          ref: '7',
          nativeId: 'native-7',
        }),
      }),
    ]);

    // A person keeps it onto the Task: the Task now shows the pull request.
    const task = await e.taskGraph.createTask({
      projectId: PROJECT,
      title: 'Ship the fix',
    });
    const kept = await e.asOperator(
      'POST',
      `/api/tasks/${task.id}/declared-outputs/${THREAD}/${eventId}/keep`,
      { operationId: 'keep-1' },
    );
    expect(kept.status).toBe(201);
    expect(kept.json.data).toMatchObject({
      status: 'kept',
      kind: 'pull-request',
      outcome: 'kept',
    });
    expect(
      e.taskGraph.listKeptDeclaredPullRequestsForSession(task.id, THREAD),
    ).toMatchObject([
      {
        provider: 'testforge',
        repository: { owner: 'kontourai', name: 'station' },
        ref: '7',
        provenance: { sessionId: THREAD, eventId },
      },
    ]);
  });

  test('a session whose turn is over is told so, and records nothing', async () => {
    const e = await setup();
    e.states['kontourai/station#7'] = 'OPEN';
    e.emit({
      method: 'turn.completed',
      turnId: 'turn-1',
      finishReason: 'stop',
    });
    await expect(e.declare(PR)).resolves.toEqual({
      isError: false,
      body: { status: 'no-active-turn' },
    });
  });

  test('a pull request outside the session’s own repository is refused as a tool error', async () => {
    const e = await setup();
    e.states['kontourai/station-2#7'] = 'OPEN';
    const refused = await e.declare({
      ...PR,
      repository: { owner: 'kontourai', name: 'station-2' },
    });
    expect(refused.isError).toBe(true);
  });

  async function declaredAndKept(e: Awaited<ReturnType<typeof setup>>) {
    await e.declare(PR);
    const eventId = e.emit({
      method: 'turn.completed',
      turnId: 'turn-1',
      finishReason: 'stop',
    });
    const task = await e.taskGraph.createTask({
      projectId: PROJECT,
      title: 'Ship the fix',
    });
    await e.taskGraph.updateTaskStatus(task.id, 'in_progress');
    await e.asOperator(
      'POST',
      `/api/tasks/${task.id}/declared-outputs/${THREAD}/${eventId}/keep`,
      { operationId: 'keep-1' },
    );
    return task;
  }

  test('a Task a person opted in is done after the pull request merges and the conversation refreshes', async () => {
    const e = await setup();
    e.states['kontourai/station#7'] = 'OPEN';
    const task = await declaredAndKept(e);
    const optIn = await e.asOperator(
      'PUT',
      `/api/tasks/${task.id}/close-on-merge`,
      {
        enabled: true,
      },
    );
    expect(optIn.status).toBe(200);
    expect(optIn.json.data.closeOnMerge).toBe(true);

    // Still open at the provider: the refresh leaves the Task alone.
    const open = await e.asOperator(
      'GET',
      `/api/conversation-pull-requests/${THREAD}`,
    );
    expect(open.json.data.links).toMatchObject([
      {
        source: 'task-declared',
        status: { state: 'current', pullRequestState: 'OPEN' },
      },
    ]);
    expect(e.taskGraph.readTask(task.id)?.status).toBe('in_progress');

    e.states['kontourai/station#7'] = 'MERGED';
    await e.asOperator('GET', `/api/conversation-pull-requests/${THREAD}`);
    await vi.waitFor(() =>
      expect(e.taskGraph.readTask(task.id)?.status).toBe('done'),
    );
  });

  // A refresh is an `orchestration:read` call; moving a Task to done needs the
  // tier `PATCH /api/tasks/:id/status` needs.
  test('a read-only paired device refreshing does not close the Task; an operate-tier viewer does', async () => {
    const e = await setup();
    e.states['kontourai/station#7'] = 'OPEN';
    const task = await declaredAndKept(e);
    await e.asOperator('PUT', `/api/tasks/${task.id}/close-on-merge`, {
      enabled: true,
    });
    e.states['kontourai/station#7'] = 'MERGED';

    const read = await e.asReader(
      'GET',
      `/api/conversation-pull-requests/${THREAD}`,
    );
    // The device may read the refresh, and it sees the merge...
    expect(read.status, JSON.stringify(read.json)).toBe(200);
    expect(read.json.data.links).toMatchObject([
      { status: { pullRequestState: 'MERGED' } },
    ]);
    // ...but it does not move the Task.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(e.taskGraph.readTask(task.id)?.status).toBe('in_progress');

    await e.asOperator('GET', `/api/conversation-pull-requests/${THREAD}`);
    await vi.waitFor(() =>
      expect(e.taskGraph.readTask(task.id)?.status).toBe('done'),
    );
  });

  test('a pull request closed without merging leaves the Task open', async () => {
    const e = await setup();
    e.states['kontourai/station#7'] = 'OPEN';
    const task = await declaredAndKept(e);
    await e.asOperator('PUT', `/api/tasks/${task.id}/close-on-merge`, {
      enabled: true,
    });
    e.states['kontourai/station#7'] = 'CLOSED';
    const refreshed = await e.asOperator(
      'GET',
      `/api/conversation-pull-requests/${THREAD}`,
    );
    expect(refreshed.json.data.links).toMatchObject([
      { status: { pullRequestState: 'CLOSED' } },
    ]);
    // Give a (wrongly) detached close every chance to land.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(e.taskGraph.readTask(task.id)?.status).toBe('in_progress');
  });

  test('a Task nobody opted in stays as it is when its pull request merges', async () => {
    const e = await setup();
    e.states['kontourai/station#7'] = 'OPEN';
    const task = await declaredAndKept(e);
    e.states['kontourai/station#7'] = 'MERGED';
    await e.asOperator('GET', `/api/conversation-pull-requests/${THREAD}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(e.taskGraph.readTask(task.id)?.status).toBe('in_progress');
  });

  // The refresh route is named by no station-control tool, so the guard refuses
  // a tool's request to it before it can reach the close-out observer.
  test('a station-control tool request to the refresh route is refused and closes nothing', async () => {
    const e = await setup();
    e.states['kontourai/station#7'] = 'OPEN';
    const task = await declaredAndKept(e);
    await e.asOperator('PUT', `/api/tasks/${task.id}/close-on-merge`, {
      enabled: true,
    });
    e.states['kontourai/station#7'] = 'MERGED';
    const response = await fetch(
      `${e.base}/api/conversation-pull-requests/${THREAD}`,
      {
        headers: {
          [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
          [INTERNAL_PROXY_CALLER_HEADER]: 'local',
          'x-station-control-caller-token': mintStationControlMcpToken(
            THREAD,
            'sdk-in-process',
          ).token,
        },
      },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: 'station_control_route_unmapped',
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(e.taskGraph.readTask(task.id)?.status).toBe('in_progress');
  });

  test('an agent cannot opt a Task in: the authority guard names no tool for the route', async () => {
    const e = await setup();
    const task = await e.taskGraph.createTask({
      projectId: PROJECT,
      title: 'Not for an agent to close',
    });
    // The agent's own station-control credential, as the tool sends it.
    const response = await fetch(
      `${e.base}/api/tasks/${task.id}/close-on-merge`,
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
          [INTERNAL_PROXY_CALLER_HEADER]: 'local',
          'x-station-control-caller-token': mintStationControlMcpToken(
            THREAD,
            'sdk-in-process',
          ).token,
        },
        body: JSON.stringify({ enabled: true }),
      },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: 'station_control_route_unmapped',
    });
    expect(e.taskGraph.readTask(task.id)?.closeOnMerge).toBeUndefined();
  });
});
