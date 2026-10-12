/**
 * #2873: a station-control dispatch's folder is decided again where its
 * engine is spawned, in the PRODUCTION composition: `configureRuntimeRoutes`
 * with the real credential pipeline and guard, the real dispatch routes and
 * scope rule, the real `delegateTask` / `executeExecutionTargetMessage`, and
 * a real `OrchestrationService` over a real `EventStore`. Only the engine is
 * a double: an ACP adapter that records each start it was asked for, picks
 * its working directory the way `acp-adapter.ts` does, and publishes the
 * start metadata it was handed.
 *
 * The caller's own session (`op-caller-global`, `op-caller-a`) is answered
 * from fixed records, as in the slice C2a composition test; every other
 * session is read from the real service and store.
 *
 * The filesystem is changed between the route's check and the spawn from two
 * seams the dispatch itself crosses: the Agent read the executor makes after
 * the route admitted the request (before the service prepares the start),
 * and the service's Agent resolution (after it prepared the start, the last
 * await before the engine start).
 */
import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import type {
  ProviderAdapterMetadata,
  ProviderAdapterShape,
  ProviderSession,
  ProviderSessionStartInput,
} from '../../../providers/adapter-shape.js';
import { acpConnectionDefaultCwd } from '../../../providers/adapters/acp-adapter.js';
import { AsyncEventQueue } from '../../../providers/sessions/async-event-queue.js';
import { __resetStationServerSelfAttestationForTests } from '../../../security/station-server-scope.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../../services/identity/principal-resolver.js';
import { NotificationService } from '../../../services/notifications/notification-service.js';
import {
  DISPATCH_CANONICAL_CWD_METADATA_KEY,
  DispatchCwdRefusedError,
} from '../../../services/orchestration/dispatch-cwd-admission.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
import { createSessionAgentResolver } from '../../../services/orchestration/session-agent-resolution.js';
import { SESSION_LOCAL_PROJECT_ID_METADATA_KEY } from '../../../services/orchestration/session-project-identity.js';
import { STATION_CONTROL_CALLER_TOKEN_HEADER } from '../../../tools/station-control-shared.js';
import {
  getInternalApiToken,
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_PROXY_CALLER_HEADER,
} from '../../../utils/internal-api-token.js';
import {
  __resetStationControlMcpTokensForTests,
  mintStationControlMcpHeaderAuth,
  mintStationControlMcpToken,
} from '../../mcp/station-control-mcp-token.js';
import { configureRuntimeRoutes } from '../runtime-routes.js';

const CURRENT_API = 'http://station-dispatch-spawn.test';
const OPERATOR_CREDENTIAL = 'test-only-operator-credential-dispatch-spawn';
const ASSURANCE = 'station_control_assurance_insufficient';
const ROLE = 'station_control_role_required';
const CONNECTION = 'writer-connection';

const support = vi.hoisted(() => ({
  notificationService: undefined as unknown,
  /** The real service the routes dispatch into (replaced by a "restart"). */
  service: undefined as unknown,
  /** Projects with a working directory, for a folder's scope. */
  projectDirs: [] as { id: string; slug: string; workingDirectory: string }[],
  /** The ACP connection's configured `cwd`, as the operator set it. */
  connectionCwd: undefined as string | undefined,
  /** Runs when the executor reads the Agent: after admission, before prepare. */
  afterAdmission: undefined as (() => void) | undefined,
  /** Runs in the service's Agent resolution: after prepare, before the spawn. */
  beforeSpawn: undefined as (() => void) | undefined,
  /** A composition that never wired the connection's default directory. */
  withoutConnectionReader: false,
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
function inert(): unknown {
  const proxy: unknown = new Proxy(() => undefined, {
    get: (_target, property) => (property === 'then' ? undefined : proxy),
  });
  return proxy;
}

function deepStub<T extends object>(overrides: T): T {
  return new Proxy(overrides, {
    get(target, property) {
      if (property in target) return Reflect.get(target, property);
      return inert();
    },
  }) as T;
}

/**
 * `overrides` first, then the real object `real()` names now (its methods
 * bound to it), then an inert stub for anything neither has.
 */
function overReal<T extends object>(real: () => object, overrides: T): T {
  return new Proxy(overrides, {
    get(target, property) {
      if (property in target) return Reflect.get(target, property);
      const actual = real();
      if (property in actual) {
        const value = Reflect.get(actual, property);
        return typeof value === 'function' ? value.bind(actual) : value;
      }
      return inert();
    },
  }) as T;
}

/** The caller's own session: fixed records, never a real session. */
const isCallerSession = (threadId: string) => threadId.startsWith('op-caller-');
const callerProject = (threadId: string) =>
  threadId.endsWith('-a') ? 'project-a' : undefined;

class RecordingAcpAdapter implements ProviderAdapterShape {
  readonly provider = 'acp' as const;
  readonly metadata: ProviderAdapterMetadata = {
    displayName: 'ACP Runtime',
    description: 'Recording ACP adapter (#2873)',
    capabilities: ['agent-runtime'],
    modelLaunch: {
      defaultAtStart: 'engine-selected',
      omissionAtResume: 'engine-selected',
      omissionPerTurn: 'engine-selected',
      overrideAtStart: false,
      overrideAtResume: false,
      overridePerTurn: false,
    },
  };
  readonly events = new AsyncEventQueue<CanonicalRuntimeEvent>();
  /** Every start this engine was asked for, with the directory it ran in. */
  readonly starts: { input: ProviderSessionStartInput; cwd?: string }[] = [];
  private readonly sessions = new Map<string, ProviderSession>();

  async startSession(
    input: ProviderSessionStartInput,
  ): Promise<ProviderSession> {
    // acp-adapter.ts's chain: the session's cwd, else the connection's.
    const cwd =
      input.cwd ||
      acpConnectionDefaultCwd({
        ...(support.connectionCwd ? { cwd: support.connectionCwd } : {}),
      });
    this.starts.push({ input, ...(cwd ? { cwd } : {}) });
    const now = new Date().toISOString();
    const session: ProviderSession = {
      provider: this.provider,
      threadId: input.threadId,
      status: 'ready',
      createdAt: now,
      updatedAt: now,
      ...(cwd ? { cwd } : {}),
    };
    this.sessions.set(input.threadId, session);
    for (const method of ['session.started', 'session.configured'] as const)
      this.events.push({
        eventId: randomUUID(),
        provider: this.provider,
        threadId: input.threadId,
        createdAt: now,
        method,
        sessionId: input.threadId,
        ...(method === 'session.started' ? { initialState: 'created' } : {}),
        metadata: { ...input.metadata, cwd, connectionId: CONNECTION },
      } as unknown as CanonicalRuntimeEvent);
    return session;
  }

  async sendTurn(input: { threadId: string }) {
    // Unique across a restart: a repeated turn id reads as a duplicate.
    const turnId = `acp-turn-${randomUUID()}`;
    // The turn ends at once, so a later follow-up finds no turn in flight.
    queueMicrotask(() =>
      this.events.push({
        eventId: randomUUID(),
        provider: this.provider,
        threadId: input.threadId,
        createdAt: new Date().toISOString(),
        method: 'turn.completed',
        turnId,
      } as unknown as CanonicalRuntimeEvent),
    );
    return { threadId: input.threadId, turnId };
  }

  /** The engine process ends: the session is over, its conversation is not. */
  exit(threadId: string): void {
    this.sessions.delete(threadId);
    this.events.push({
      eventId: randomUUID(),
      provider: this.provider,
      threadId,
      createdAt: new Date().toISOString(),
      method: 'session.exited',
      sessionId: threadId,
      exitCode: 0,
    } as unknown as CanonicalRuntimeEvent);
  }

  async interruptTurn() {
    return { outcome: 'no-active-turn' as const };
  }

  async respondToRequest(): Promise<void> {}

  async stopSession(threadId: string): Promise<void> {
    this.sessions.delete(threadId);
  }

  async listSessions(): Promise<ProviderSession[]> {
    return [...this.sessions.values()];
  }

  async hasSession(threadId: string): Promise<boolean> {
    return this.sessions.has(threadId);
  }

  async stopAll(): Promise<void> {
    this.sessions.clear();
  }

  streamEvents(options?: {
    signal?: AbortSignal;
  }): AsyncIterable<CanonicalRuntimeEvent> {
    return this.events.iterable(options);
  }
}

const makeTempDir = trackTempDirs();

/** Polls a persisted fact; the bound sits inside the suite's test timeout. */
async function waitFor<T>(
  read: () => T,
  matches: (value: T) => boolean,
  timeoutMs = 20_000,
  diagnostics: () => string = () => '',
): Promise<T> {
  const startedAt = Date.now();
  let observed: T | undefined;
  while (Date.now() - startedAt < timeoutMs) {
    const value = read();
    observed = value;
    if (matches(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Timed out waiting for test condition; observed=${JSON.stringify(observed)}; ${diagnostics()}`,
  );
}

describe('configureRuntimeRoutes: a station-control dispatch folder is decided again at the spawn (#2873)', () => {
  const closers: Array<() => Promise<void> | void> = [];
  const realFetch = globalThis.fetch;
  const previousApiBase = process.env.STATION_API_BASE;

  afterEach(async () => {
    __resetStationControlMcpTokensForTests();
    support.projectDirs = [];
    support.connectionCwd = undefined;
    support.afterAdmission = undefined;
    support.beforeSpawn = undefined;
    support.withoutConnectionReader = false;
    for (const close of closers.splice(0)) await close();
    vi.unstubAllGlobals();
    if (previousApiBase === undefined) delete process.env.STATION_API_BASE;
    else process.env.STATION_API_BASE = previousApiBase;
  });

  function json(data: unknown): Response {
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  function createService(eventStore: EventStore) {
    const adapter = new RecordingAcpAdapter();
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const adapters: ProviderAdapterShape[] = [adapter];
    const resolveAgent = createSessionAgentResolver({
      loadAgentSpec: async (slug) =>
        slug === 'writer' ? { name: 'Writer', prompt: '' } : null,
      resolveToolServer: async () => null,
      resolveSkillDir: async () => null,
    });
    const service = new OrchestrationService({
      adapterRegistry: {
        register() {},
        get: (provider: string) =>
          adapters.find((candidate) => candidate.provider === provider),
        list: () => adapters,
      },
      eventBus: new EventBus(),
      eventStore,
      adoptionLedger: eventStore.createAdoptionLedger(),
      listProjects: () => support.projectDirs,
      // What `runtime-initialize.ts` wires: the connection's own default.
      ...(support.withoutConnectionReader
        ? {}
        : {
            resolveConnectionDefaultCwd: async (provider: string) =>
              provider === 'acp'
                ? acpConnectionDefaultCwd({
                    ...(support.connectionCwd
                      ? { cwd: support.connectionCwd }
                      : {}),
                  })
                : undefined,
          }),
      resolveSessionAgent: async (input: ProviderSessionStartInput) => {
        const hook = support.beforeSpawn;
        support.beforeSpawn = undefined;
        hook?.();
        return resolveAgent(input);
      },
      logger,
    } as never);
    return { service, adapter, logger };
  }

  async function setup() {
    const homeDir = makeTempDir('station-dispatch-spawn-home-');
    const notifications = new NotificationService(
      new EventBus(),
      homeDir,
      999_999,
    );
    closers.push(() => notifications.shutdown());
    support.notificationService = notifications;
    __resetStationServerSelfAttestationForTests();

    const eventStore = new EventStore(join(homeDir, 'orchestration.sqlite'));
    closers.push(() => {
      eventStore.close();
    });
    const first = createService(eventStore);
    support.service = first.service;

    // The executor reads this Station's own API for the Agent and its
    // connection; everything else is a real request.
    process.env.STATION_API_BASE = CURRENT_API;
    vi.stubGlobal('fetch', (async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith(CURRENT_API)) return realFetch(input, init);
      if (url === `${CURRENT_API}/.well-known/station/v1`)
        return json({ environmentId: 'environment-current' });
      if (url === `${CURRENT_API}/api/agents/writer`) {
        const hook = support.afterAdmission;
        support.afterAdmission = undefined;
        hook?.();
        return json({
          success: true,
          data: {
            slug: 'writer',
            name: 'Writer',
            available: true,
            execution: { agentConnectionId: CONNECTION },
          },
        });
      }
      if (url === `${CURRENT_API}/api/connections/${CONNECTION}`)
        return json({
          success: true,
          data: {
            id: CONNECTION,
            kind: 'agent',
            type: 'acp',
            enabled: true,
            status: 'ready',
            capabilities: ['agent-runtime'],
            config: { provider: 'acp' },
          },
        });
      throw new Error(`Unexpected Station API read in test: ${url}`);
    }) as typeof fetch);

    const app = new Hono();
    const context = deepStub({
      projectSharedTasks: undefined,
      deploymentAuthentication: undefined,
      localAccounts: undefined,
      applicationSessions: undefined,
      projectMembership: undefined,
      app,
      port: 4321,
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
      orchestrationEventStore: eventStore,
      orchestrationService: overReal(() => support.service as object, {
        resolveSessionActingPrincipal: (threadId: string) =>
          isCallerSession(threadId)
            ? {
                id: LOCAL_OPERATOR_PRINCIPAL_ID,
                source: 'session-owner' as const,
              }
            : (
                support.service as OrchestrationService
              ).resolveSessionActingPrincipal(threadId),
        sessionRecordedOwnerId: (threadId: string) =>
          isCallerSession(threadId)
            ? LOCAL_OPERATOR_PRINCIPAL_ID
            : (support.service as OrchestrationService).sessionRecordedOwnerId(
                threadId,
              ),
        hasSessionStartRecord: (threadId: string) =>
          isCallerSession(threadId) ||
          (support.service as OrchestrationService).hasSessionStartRecord(
            threadId,
          ),
        firstStartedMetadataOfThread: (threadId: string) => {
          if (!isCallerSession(threadId))
            return (
              support.service as OrchestrationService
            ).firstStartedMetadataOfThread(threadId);
          // An adopted session: its delegation lineage is named by its
          // engine, with no Agent spec to read.
          const identity = { adoptedFromThreadId: 'attached' };
          const project = callerProject(threadId);
          return project
            ? { ...identity, [SESSION_LOCAL_PROJECT_ID_METADATA_KEY]: project }
            : identity;
        },
        firstStartedEngineOfThread: () => 'claude',
      }),
      storageAdapter: deepStub({
        getProject: (slug: string) => {
          const project = support.projectDirs.find(
            (entry) => entry.slug === slug,
          );
          if (!project) throw new Error('no project');
          return { id: project.id };
        },
      }),
      taskGraphService: { listTasks: () => [] },
      projectService: {
        listProjects: () => support.projectDirs,
        getProject: (slug: string) => ({ slug }),
      },
      environmentSecurityService: deepStub({
        verifyCredential: (credential: string) =>
          credential === OPERATOR_CREDENTIAL,
        authorizeCredential: (credential: string) =>
          credential === OPERATOR_CREDENTIAL,
        verifyOperatorCredential: (credential: string) =>
          credential === OPERATOR_CREDENTIAL,
        resolveGrantedScope: (credential: string) =>
          credential === OPERATOR_CREDENTIAL
            ? 'orchestration:read orchestration:operate'
            : undefined,
        identifyDevice: () => undefined,
        devicePairing: deepStub({}),
      }),
    });
    Reflect.set(context as object, 'buildRuntimeContext', () => context);
    const result = configureRuntimeRoutes(
      context as unknown as Parameters<typeof configureRuntimeRoutes>[0],
    );
    await result.kitLifecycleReady;
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
    const base = `http://127.0.0.1:${await listening}`;
    return {
      base,
      eventStore,
      adapter: first.adapter,
      logger: first.logger,
      /** A new process over the same store: no engine holds any session. */
      restart: () => {
        const next = createService(eventStore);
        support.service = next.service;
        return next.adapter;
      },
    };
  }

  const internal = (extra: Record<string, string> = {}) => ({
    'content-type': 'application/json',
    [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
    [INTERNAL_PROXY_CALLER_HEADER]: 'local',
    ...extra,
  });
  const operatorUi = {
    'content-type': 'application/json',
    authorization: `Bearer ${OPERATOR_CREDENTIAL}`,
  };
  /** A fresh caller credential per request: a new mint replaces the last. */
  const as = (
    channel: 'bound' | 'delegated-custody' | 'bearer-exposed',
    sessionId: string,
  ) =>
    internal({
      [STATION_CONTROL_CALLER_TOKEN_HEADER]:
        channel === 'bound'
          ? mintStationControlMcpToken(sessionId, 'sdk-in-process').token
          : channel === 'bearer-exposed'
            ? mintStationControlMcpToken(sessionId, 'url-token').token
            : mintStationControlMcpHeaderAuth(4321, sessionId).token,
    });

  async function post(
    base: string,
    path: string,
    headers: Record<string, string>,
    body: unknown,
  ): Promise<{
    status: number;
    code?: string;
    data?: Record<string, unknown>;
  }> {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let parsed: { code?: string; data?: Record<string, unknown> } = {};
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      parsed = {};
    }
    return {
      status: response.status,
      ...(parsed.code ? { code: parsed.code } : {}),
      ...(parsed.data ? { data: parsed.data } : {}),
    };
  }

  const DISPATCH = {
    'POST /delegations': (workspace?: Record<string, unknown>) => ({
      path: '/api/orchestration/delegations',
      body: {
        prompt: 'go',
        target: {
          environment: { kind: 'current' },
          agent: 'writer',
          ...(workspace ? { workspace } : {}),
        },
      },
    }),
    'POST /chat': (workspace?: Record<string, unknown>) => ({
      path: '/api/orchestration/chat',
      body: {
        message: 'go',
        target: {
          environment: { kind: 'current' },
          agent: 'writer',
          ...(workspace ? { workspace } : {}),
        },
      },
    }),
  } as const;
  const ROUTES = Object.keys(DISPATCH) as (keyof typeof DISPATCH)[];

  /**
   * A global workspace the agent can write, a Project beside it, and a
   * second folder in the global space:
   *   ws/x/sub      the folder the agent dispatches into
   *   ws/other/sub  another global folder
   *   proj/sub      a folder inside Project a
   */
  function layout() {
    const root = realpathSync(makeTempDir('station-dispatch-spawn-'));
    for (const path of ['ws/x/sub', 'ws/other/sub', 'proj/sub'])
      mkdirSync(join(root, path), { recursive: true });
    support.projectDirs = [
      {
        id: 'project-a',
        slug: 'project-a-slug',
        workingDirectory: join(root, 'proj'),
      },
    ];
    return {
      root,
      folder: join(root, 'ws', 'x', 'sub'),
      /** Replace the directory component `ws/x` with a link to `to`. */
      swapParent: (to: string) => {
        renameSync(join(root, 'ws', 'x'), join(root, 'ws', 'x-was'));
        symlinkSync(join(root, to), join(root, 'ws', 'x'));
      },
    };
  }

  test.each(ROUTES)(
    '%s: an in-scope folder spawns in the canonical path and records it',
    async (route) => {
      const { base, adapter, eventStore } = await setup();
      const { folder } = layout();
      const request = DISPATCH[route]({ kind: 'directory', cwd: folder });
      const response = await post(
        base,
        request.path,
        as('delegated-custody', 'op-caller-global'),
        request.body,
      );
      expect([response.status, response.code]).toEqual([200, undefined]);
      expect(adapter.starts.map((start) => start.cwd)).toEqual([folder]);
      expect(
        adapter.starts[0]!.input.metadata?.[
          DISPATCH_CANONICAL_CWD_METADATA_KEY
        ],
      ).toBe(folder);
      // The record is the session's own start record, read back by a respawn.
      const threadId = adapter.starts[0]!.input.threadId;
      await waitFor(
        () =>
          (
            eventStore.latestEventByMethod(threadId, 'session.started')
              ?.payload as { metadata?: Record<string, unknown> } | undefined
          )?.metadata?.[DISPATCH_CANONICAL_CWD_METADATA_KEY],
        (recorded) => recorded === folder,
      );
    },
  );

  test.each(ROUTES)(
    '%s: the operator UI is not a station-control caller: nothing is decided or recorded for it',
    async (route) => {
      const { base, adapter } = await setup();
      const { folder } = layout();
      const request = DISPATCH[route]({ kind: 'directory', cwd: folder });
      const response = await post(base, request.path, operatorUi, request.body);
      expect([response.status, response.code]).toEqual([200, undefined]);
      expect(adapter.starts.map((start) => start.cwd)).toEqual([folder]);
      expect(
        adapter.starts[0]!.input.metadata &&
          DISPATCH_CANONICAL_CWD_METADATA_KEY in
            adapter.starts[0]!.input.metadata,
      ).toBe(false);
    },
  );

  test.each(ROUTES)(
    '%s: a parent swapped for a link into a Project after admission is refused before the start is prepared',
    async (route) => {
      const { base, adapter } = await setup();
      const { folder, swapParent } = layout();
      let swapped = false;
      support.afterAdmission = () => {
        swapParent('proj');
        swapped = true;
      };
      const request = DISPATCH[route]({ kind: 'directory', cwd: folder });
      const response = await post(
        base,
        request.path,
        as('delegated-custody', 'op-caller-global'),
        request.body,
      );
      // The swap happened after the route admitted the request.
      expect(swapped).toBe(true);
      expect([response.status, response.code]).toEqual([403, ROLE]);
      expect(adapter.starts).toEqual([]);
    },
  );

  test.each(ROUTES)(
    '%s: the same swap after the start was prepared is refused at the spawn',
    async (route) => {
      const { base, adapter } = await setup();
      const { folder, swapParent } = layout();
      let swapped = false;
      support.beforeSpawn = () => {
        swapParent('proj');
        swapped = true;
      };
      const request = DISPATCH[route]({ kind: 'directory', cwd: folder });
      const response = await post(
        base,
        request.path,
        as('delegated-custody', 'op-caller-global'),
        request.body,
      );
      expect(swapped).toBe(true);
      expect([response.status, response.code]).toEqual([403, ROLE]);
      expect(adapter.starts).toEqual([]);
    },
  );

  // The link's target is in the caller's own scope, so the scope rule alone
  // would admit it: only the comparison with the admitted canonical path
  // refuses. Before the start is prepared, that comparison is the route
  // decision's; after it, the recorded path's.
  test.each([
    ['before the start is prepared', 'afterAdmission'],
    ['after the start was prepared', 'beforeSpawn'],
  ] as const)(
    'a parent swapped for a link to another folder in the SAME scope %s is still refused: the path is not the one admitted',
    async (_when, seam) => {
      const { base, adapter } = await setup();
      const { folder, swapParent } = layout();
      let swapped = false;
      support[seam] = () => {
        swapParent('ws/other');
        swapped = true;
      };
      const request = DISPATCH['POST /delegations']({
        kind: 'directory',
        cwd: folder,
      });
      const response = await post(
        base,
        request.path,
        as('delegated-custody', 'op-caller-global'),
        request.body,
      );
      expect(swapped).toBe(true);
      expect([response.status, response.code]).toEqual([403, ROLE]);
      expect(adapter.starts).toEqual([]);
    },
  );

  test('a folder that leaves the caller’s scope without moving (a Project now contains it) is refused at the spawn', async () => {
    const { base, adapter } = await setup();
    const { root, folder } = layout();
    support.beforeSpawn = () => {
      support.projectDirs = [
        ...support.projectDirs,
        {
          id: 'project-b',
          slug: 'project-b-slug',
          workingDirectory: join(root, 'ws'),
        },
      ];
    };
    const request = DISPATCH['POST /delegations']({
      kind: 'directory',
      cwd: folder,
    });
    const response = await post(
      base,
      request.path,
      as('delegated-custody', 'op-caller-global'),
      request.body,
    );
    expect([response.status, response.code]).toEqual([403, ASSURANCE]);
    expect(adapter.starts).toEqual([]);
  });

  test('a folder removed after admission is refused, not started somewhere else', async () => {
    const { base, adapter } = await setup();
    const { folder } = layout();
    support.beforeSpawn = () => rmSync(folder, { recursive: true });
    const request = DISPATCH['POST /delegations']({
      kind: 'directory',
      cwd: folder,
    });
    const response = await post(
      base,
      request.path,
      as('delegated-custody', 'op-caller-global'),
      request.body,
    );
    expect([response.status, response.code]).toEqual([403, ROLE]);
    expect(adapter.starts).toEqual([]);
  });

  test('a bound operator caller keeps the operator’s reach: the same swap is not decided for it', async () => {
    const { base, adapter } = await setup();
    const { root, folder, swapParent } = layout();
    support.beforeSpawn = () => swapParent('proj');
    const request = DISPATCH['POST /delegations']({
      kind: 'directory',
      cwd: folder,
    });
    const response = await post(
      base,
      request.path,
      as('bound', 'op-caller-global'),
      request.body,
    );
    expect([response.status, response.code]).toEqual([200, undefined]);
    expect(adapter.starts.map((start) => start.cwd)).toEqual([folder]);
    expect(realpathSync(folder)).toBe(join(root, 'proj', 'sub'));
  });

  test('a record supplied on a public start command is removed: only an admitted dispatch writes one', async () => {
    const { adapter } = await setup();
    const { folder } = layout();
    const started = await (
      support.service as OrchestrationService
    ).sessionCommands.execute(
      {
        type: 'start-session',
        input: {
          threadId: 'forged-record',
          provider: 'acp',
          cwd: folder,
          metadata: {
            agentSlug: 'writer',
            connectionId: CONNECTION,
            // Naming another path here would otherwise refuse every later
            // start; naming this one would claim an admission never made.
            [DISPATCH_CANONICAL_CWD_METADATA_KEY]: folder,
          },
        },
      },
      { userId: LOCAL_OPERATOR_PRINCIPAL_ID },
    );
    expect(started.status).toBe('accepted');
    expect(adapter.starts.map((start) => start.cwd)).toEqual([folder]);
    expect(
      adapter.starts[0]!.input.metadata &&
        DISPATCH_CANONICAL_CWD_METADATA_KEY in
          adapter.starts[0]!.input.metadata,
    ).toBe(false);
  });

  describe('a later engine start for the dispatched session', () => {
    async function dispatched() {
      const composed = await setup();
      const paths = layout();
      const request = DISPATCH['POST /delegations']({
        kind: 'directory',
        cwd: paths.folder,
      });
      const response = await post(
        composed.base,
        request.path,
        as('delegated-custody', 'op-caller-global'),
        request.body,
      );
      expect([response.status, response.code]).toEqual([200, undefined]);
      const taskId = String(response.data?.taskId);
      await waitFor(
        () =>
          composed.eventStore
            .listEvents(taskId)
            .map((event) => event.payload.method),
        (methods) =>
          methods.includes('session.configured') &&
          methods.includes('turn.completed'),
      );
      return { ...composed, ...paths, taskId };
    }

    const followUp = (base: string, taskId: string) =>
      post(
        base,
        `/api/orchestration/delegations/${encodeURIComponent(taskId)}/continue`,
        operatorUi,
        { message: 'and then' },
      );

    test('the operator’s follow-up respawns it in the recorded folder', async () => {
      const { base, folder, taskId, restart } = await dispatched();
      const respawned = restart();
      const response = await followUp(base, taskId);
      expect([response.status, response.code]).toEqual([200, undefined]);
      // The same session, started again: the restored row had no engine.
      expect(respawned.starts.map((start) => start.input.threadId)).toEqual([
        taskId,
      ]);
      expect(respawned.starts.map((start) => start.cwd)).toEqual([folder]);
      // The respawn's own start carries the record forward.
      expect(
        respawned.starts[0]!.input.metadata?.[
          DISPATCH_CANONICAL_CWD_METADATA_KEY
        ],
      ).toBe(folder);
    });

    /** The engine exited: the next follow-up starts a child session. */
    async function dispatchedAndExited() {
      const composed = await dispatched();
      composed.adapter.exit(composed.taskId);
      await waitFor(
        () =>
          composed.eventStore
            .listEvents(composed.taskId)
            .map((event) => event.payload.method),
        (methods) => methods.includes('session.exited'),
        20_000,
        () =>
          `event-consumer warnings=${JSON.stringify(composed.logger.warn.mock.calls)}`,
      );
      composed.adapter.starts.length = 0;
      return composed;
    }

    test('a child session that continues it in the same folder carries the record', async () => {
      const { base, folder, taskId, adapter } = await dispatchedAndExited();
      const response = await followUp(base, taskId);
      expect([response.status, response.code]).toEqual([200, undefined]);
      expect(
        adapter.starts.map((start) => [
          start.input.threadId === taskId,
          start.cwd,
          start.input.metadata?.[DISPATCH_CANONICAL_CWD_METADATA_KEY],
        ]),
      ).toEqual([[false, folder, folder]]);
    });

    test('after the swap, no child session starts there either', async () => {
      const { base, taskId, adapter, swapParent } = await dispatchedAndExited();
      swapParent('proj');
      const response = await followUp(base, taskId);
      expect(response.status).not.toBe(200);
      expect(adapter.starts).toEqual([]);
    });

    test('after the parent is swapped for a link into a Project, no one’s follow-up respawns it there', async () => {
      const { base, taskId, restart, swapParent, eventStore } =
        await dispatched();
      const respawned = restart();
      swapParent('proj');
      const response = await followUp(base, taskId);
      expect(response.status).not.toBe(200);
      expect(respawned.starts).toEqual([]);
      // The refusal is on the thread, where the operator reads it.
      const errors = eventStore
        .listEvents(taskId)
        .map((event) => event.payload)
        .filter((payload) => payload.method === 'runtime.error');
      expect(
        errors.some((payload) =>
          String((payload as { message?: string }).message).includes(
            'Station will not start this session',
          ),
        ),
      ).toBe(true);
    });
  });

  describe('a dispatch with no workspace on an ACP connection that sets a working directory', () => {
    test.each(ROUTES)(
      '%s: the connection’s directory inside a Project is that Project’s, not the global space',
      async (route) => {
        const { base, adapter } = await setup();
        const { root } = layout();
        support.connectionCwd = join(root, 'proj', 'sub');
        const request = DISPATCH[route]();
        const globalCaller = await post(
          base,
          request.path,
          as('delegated-custody', 'op-caller-global'),
          request.body,
        );
        expect([globalCaller.status, globalCaller.code]).toEqual([
          403,
          ASSURANCE,
        ]);
        expect(adapter.starts).toEqual([]);
        // The in-scope control is the global-space connection below: a
        // Project's own agent is refused a no-workspace dispatch at
        // admission, which still reads the default session directory.
      },
    );

    test('a composition that cannot read the connection’s directory refuses the dispatch', async () => {
      support.withoutConnectionReader = true;
      const { base, adapter } = await setup();
      layout();
      const request = DISPATCH['POST /delegations']();
      const response = await post(
        base,
        request.path,
        as('delegated-custody', 'op-caller-global'),
        request.body,
      );
      expect([response.status, response.code]).toEqual([403, ROLE]);
      expect(adapter.starts).toEqual([]);
      // The operator's own request is not decided, so it still starts.
      const ui = await post(base, request.path, operatorUi, request.body);
      expect([ui.status, ui.code]).toEqual([200, undefined]);
      expect(adapter.starts).toHaveLength(1);
    });

    // The routes refuse an empty `cwd`, but the start command does not, and
    // the ACP adapter reads `input.cwd || connection cwd`: an empty string
    // runs in the connection's directory, so it must be decided as one.
    test('an empty session cwd is decided on the connection’s directory, as the adapter runs it', async () => {
      const { adapter } = await setup();
      const { root } = layout();
      support.connectionCwd = join(root, 'proj', 'sub');
      const decided: [string | undefined, string][] = [];
      const started = await (
        support.service as OrchestrationService
      ).sessionCommands.execute(
        {
          type: 'start-session',
          input: {
            threadId: 'empty-cwd',
            provider: 'acp',
            cwd: '',
            metadata: { agentSlug: 'writer', connectionId: CONNECTION },
          },
        },
        {
          userId: LOCAL_OPERATOR_PRINCIPAL_ID,
          dispatchCwdAdmission: {
            recheck(directory, origin) {
              decided.push([directory, origin]);
              if (origin === 'connection' && directory?.startsWith(root))
                throw new DispatchCwdRefusedError(
                  'outside the caller scope',
                  ASSURANCE,
                );
              return undefined;
            },
          },
        },
      );
      expect(decided).toEqual([[join(root, 'proj', 'sub'), 'connection']]);
      expect([started.status, 'code' in started && started.code]).toEqual([
        'rejected',
        ASSURANCE,
      ]);
      expect(adapter.starts).toEqual([]);
    });

    test('a link into a Project is resolved before it is scoped', async () => {
      const { base, adapter } = await setup();
      const { root } = layout();
      symlinkSync(join(root, 'proj'), join(root, 'ws', 'elsewhere'));
      support.connectionCwd = join(root, 'ws', 'elsewhere', 'sub');
      const request = DISPATCH['POST /delegations']();
      const response = await post(
        base,
        request.path,
        as('delegated-custody', 'op-caller-global'),
        request.body,
      );
      expect([response.status, response.code]).toEqual([403, ASSURANCE]);
      expect(adapter.starts).toEqual([]);
    });

    test.each(ROUTES)(
      '%s: a connection directory in the global space, or none, starts for a global agent',
      async (route) => {
        const { base, adapter } = await setup();
        const { root } = layout();
        const request = DISPATCH[route]();
        support.connectionCwd = join(root, 'ws', 'other');
        const inGlobal = await post(
          base,
          request.path,
          as('delegated-custody', 'op-caller-global'),
          request.body,
        );
        expect([inGlobal.status, inGlobal.code]).toEqual([200, undefined]);
        support.connectionCwd = undefined;
        const none = await post(
          base,
          request.path,
          as('delegated-custody', 'op-caller-global'),
          request.body,
        );
        expect([none.status, none.code]).toEqual([200, undefined]);
        expect(adapter.starts.map((start) => start.cwd)).toEqual([
          join(root, 'ws', 'other'),
          undefined,
        ]);
      },
    );
  });
});
