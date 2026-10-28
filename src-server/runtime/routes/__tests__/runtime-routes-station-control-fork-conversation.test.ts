/**
 * `fork_conversation` at the REAL boundary: `configureRuntimeRoutes` with the
 * real runtime auth boundary, the real station-control guard, caller and
 * scope derivation over REAL session records (a real `EventStore` +
 * `OrchestrationService`), the real fork route and the real station-control
 * MCP server with really minted per-session tokens.
 *
 * Sessions (owner A, the Station operator, unless noted); each has a stored
 * conversation of the same id with one completed assistant turn:
 *  - Project 1: `a-caller`, `a-peer`;
 *  - Project 2: `a-other`;
 *  - the global space: `g-caller`;
 *  - `carol-p1`: Project 1, owned by another person.
 */
import { realpathSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { awaitSessionAttachmentSettled } from '../../../__test-utils__/session-runtime-barriers.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { FileMemoryAdapter } from '../../../adapters/file/memory-adapter.js';
import { FileStorageAdapter } from '../../../domain/file-storage-adapter.js';
import { ensureStationHomeSchemaSync } from '../../../domain/home-schema-gate.js';
import { __resetStationServerSelfAttestationForTests } from '../../../security/station-server-scope.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../../services/identity/principal-resolver.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
import { SESSION_LOCAL_PROJECT_ID_METADATA_KEY } from '../../../services/orchestration/session-project-identity.js';
import { ProjectManifestStore } from '../../../services/projects/project-manifest-store.js';
import { ProjectService } from '../../../services/projects/project-service.js';
import { TaskGraphService } from '../../../services/projects/task-graph-service.js';
import { createRuntimeSearch } from '../../../services/search/runtime-search.js';
import { createStationControlMcpServer } from '../../../tools/station-control-mcp-server.js';
import {
  __resetStationControlStdioEntryForTests,
  type StationControlCaller,
  stationControlCallerPrincipal,
  withStationControlCallerContext,
} from '../../../tools/station-control-shared.js';
import {
  __resetStationControlMcpTokensForTests,
  mintStationControlMcpToken,
  type StationControlMcpTokenChannel,
} from '../../mcp/station-control-mcp-token.js';
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

const OPERATOR_CREDENTIAL = 'test-only-operator-credential-fork';
const A = LOCAL_OPERATOR_PRINCIPAL_ID;
const CAROL = 'human:tailscale-serve:carol';
const AGENT = 'codex-agent';
const makeTempDir = trackTempDirs();
const BASE_TIME = Date.parse('2026-10-28T10:00:00.000Z');

type Caller = { session: string; channel: StationControlMcpTokenChannel };
const ASSURANCE = {
  'sdk-in-process': 'bound',
  'http-header-token': 'delegated-custody',
  'url-token': 'bearer-exposed',
} as const;
const bound = (session: string): Caller => ({
  session,
  channel: 'sdk-in-process',
});
const delegated = (session: string): Caller => ({
  session,
  channel: 'http-header-token',
});
const bearer = (session: string): Caller => ({
  session,
  channel: 'url-token',
});

const OWNER: Record<string, string> = {
  'a-caller': A,
  'a-peer': A,
  'a-other': A,
  'g-caller': A,
  'carol-p1': CAROL,
};

describe('station-control fork_conversation', () => {
  const closers: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    __resetStationControlMcpTokensForTests();
    __resetStationControlStdioEntryForTests();
    delete process.env.STATION_API_BASE;
    for (const close of closers.splice(0)) await close();
  });

  async function setup() {
    __resetStationServerSelfAttestationForTests();
    // The home-schema gate refuses a home that is not canonical (a macOS
    // temp dir is `/var`, really `/private/var`).
    const home = realpathSync(makeTempDir('station-control-fork-'));
    // Boot stamps the home's schema; the fork's Agent lookup reads the
    // registry, which refuses an unstamped home.
    ensureStationHomeSchemaSync(home);
    const storage = new FileStorageAdapter(home);
    const projects = new ProjectService(
      storage,
      new ProjectManifestStore(home, storage),
    );
    const p1 = await projects.createProject({ name: 'One', slug: 'project-1' });
    const p2 = await projects.createProject({ name: 'Two', slug: 'project-2' });

    const store = new EventStore(join(home, 'orchestration.sqlite'));
    let tick = 0;
    const at = () => new Date(BASE_TIME + tick++ * 1000).toISOString();
    const files = new FileMemoryAdapter({ projectHomeDir: home });

    const startSession = async (
      threadId: string,
      owner: string,
      project: { id: string; slug: string } | undefined,
    ) => {
      store.appendEvent({
        eventId: `${threadId}:start`,
        threadId,
        sessionId: threadId,
        provider: 'codex',
        method: 'session.started',
        createdAt: at(),
        metadata: {
          userId: owner,
          agentSlug: AGENT,
          ...(project
            ? {
                [SESSION_LOCAL_PROJECT_ID_METADATA_KEY]: project.id,
                projectSlug: project.slug,
              }
            : {}),
        },
      } as never);
      store.upsertSession({
        threadId,
        provider: 'codex',
        status: 'ready',
        createdAt: at(),
        updatedAt: at(),
      } as never);
      // The stored conversation the fork reads: one completed turn.
      await files.createConversation({
        id: threadId,
        resourceId: AGENT,
        userId: owner,
        title: `Conversation ${threadId}`,
        metadata: project ? { projectSlug: project.slug } : {},
      });
      await files.addMessages(
        [
          {
            id: `${threadId}-user`,
            role: 'user',
            parts: [{ type: 'text', text: `Question in ${threadId}` }],
          },
          {
            id: `${threadId}-answer`,
            role: 'assistant',
            parts: [{ type: 'text', text: `Answer in ${threadId}` }],
            metadata: { turnId: `${threadId}-turn`, answerEligible: true },
          },
        ],
        owner,
        threadId,
      );
    };

    await startSession('a-caller', A, p1);
    await startSession('a-peer', A, p1);
    await startSession('a-other', A, p2);
    await startSession('g-caller', A, undefined);
    await startSession('carol-p1', CAROL, p1);

    const orchestration = new OrchestrationService({
      eventStore: store,
      adoptionLedger: store.createAdoptionLedger(),
      eventBus: new EventBus(),
      adapterRegistry: { register() {}, get: () => undefined, list: () => [] },
      logger: { debug() {}, warn() {} },
    });
    orchestration.initialize();
    const taskGraph = new TaskGraphService(home, {
      projectService: { getProject: () => p1 },
    });
    const runtimeSearch = createRuntimeSearch({
      stationId: '66666666-6666-4666-8666-666666666666',
      tasks: taskGraph,
      transcripts: orchestration,
    });
    closers.push(async () => {
      await runtimeSearch.close();
      try {
        await orchestration.shutdown();
      } catch (error) {
        // Tolerated as in the Project activity suite (#3266).
        const causes =
          error instanceof AggregateError ? (error.errors as unknown[]) : [];
        if (
          causes.length === 0 ||
          !causes.every(
            (cause) =>
              cause instanceof Error &&
              cause.message.includes(
                'Transcript reader retirement is still pending',
              ),
          )
        )
          throw error;
      }
      await expect
        .poll(() => store.close().kind, { timeout: 15_000 })
        .toBe('closed');
    });
    await awaitSessionAttachmentSettled(orchestration);

    const app = new Hono();
    const context = deepStub({
      projectMembership: undefined,
      projectSharedTasks: undefined,
      deploymentAuthentication: undefined,
      localAccounts: undefined,
      applicationSessions: undefined,
      app,
      port: 4321,
      appConfig: {},
      eventBus: new EventBus(),
      configLoader: {
        getProjectHomeDir: () => home,
        loadAppConfig: () => ({}),
      },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      activeAgents: new Map(),
      agentService: {
        listAgents: async () => [{ slug: AGENT, name: 'Codex agent' }],
      },
      agentMetadataMap: new Map(),
      agentFixedTokens: new Map(),
      agentTools: new Map(),
      agentStats: new Map(),
      agentStatus: new Map(),
      memoryAdapters: new Map([
        ['default', files],
        [AGENT, files],
      ]),
      createMemoryAdapter: () => files,
      metricsLog: [],
      monitoringEvents: [],
      orchestrationEventStore: store,
      orchestrationService: orchestration,
      runtimeSearch,
      storageAdapter: storage,
      taskGraphService: taskGraph,
      projectService: projects,
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
        canSharePersonalConversation: () => false,
        personalConversationOwnerIds: (id: string) => [id],
        devicePairing: deepStub({ listDevices: () => [] }),
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
    process.env.STATION_API_BASE = base;
    const realFetch = globalThis.fetch;

    const mcp = createStationControlMcpServer();
    const sent: any[] = [];
    const transport: any = {
      start: async () => {},
      close: async () => {},
      send: async (message: unknown) => {
        sent.push(message);
      },
    };
    await mcp.connect(transport);
    let nextId = 1;
    const rpc = async (method: string, params: object): Promise<any> => {
      nextId += 1;
      const id = nextId;
      setImmediate(() =>
        transport.onmessage({ jsonrpc: '2.0', id, method, params }),
      );
      for (let i = 0; i < 1_000; i += 1) {
        const found = sent.find((message) => message.id === id);
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`no response for ${method}`);
    };
    await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'engine', version: '1' },
    });
    closers.unshift(() => mcp.close());

    /** A station-control tool call, as the engine's MCP client makes it. */
    async function fork(
      caller: Caller,
      args: Record<string, unknown>,
    ): Promise<{ isError: boolean; body: any }> {
      const { token } = mintStationControlMcpToken(
        caller.session,
        caller.channel,
      );
      const owner = OWNER[caller.session];
      const verified: StationControlCaller = owner
        ? {
            sessionId: caller.session,
            assurance: ASSURANCE[caller.channel],
            principal: stationControlCallerPrincipal(owner, 'session-owner'),
          }
        : { sessionId: caller.session, assurance: ASSURANCE[caller.channel] };
      const response = await withStationControlCallerContext(
        { token, resolve: () => verified },
        () =>
          rpc('tools/call', {
            name: 'fork_conversation',
            arguments: { agent: AGENT, ...args },
          }),
      );
      const text = response.result?.content?.[0]?.text as string | undefined;
      let body: unknown = text;
      try {
        body = text === undefined ? undefined : JSON.parse(text);
      } catch {
        // A validation refusal is plain text.
      }
      return { isError: response.result?.isError === true, body };
    }

    /** The person's own fork, through the same route with the operator's credential. */
    async function personFork(source: string, body: Record<string, unknown>) {
      const response = await realFetch(
        `${base}/agents/${AGENT}/conversations/${source}/fork`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${OPERATOR_CREDENTIAL}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ targetAgent: AGENT, ...body }),
        },
      );
      return { status: response.status, body: (await response.json()) as any };
    }

    /** Forks Station recorded from a source conversation. */
    const forksOf = (source: string) =>
      store.readConversationForkProvenance(source).forkedTo.length;

    return { fork, personFork, forksOf };
  }

  test('every caller kind forks a conversation in its own Project, into its own Project', async () => {
    const { fork, forksOf } = await setup();
    for (const [index, kind] of [bound, delegated, bearer].entries()) {
      const made = await fork(kind('a-caller'), {
        conversationId: 'a-peer',
        idempotencyKey: `same-project-${index}`,
      });
      expect([index, made.body?.success], JSON.stringify(made.body)).toEqual([
        index,
        true,
      ]);
      expect(made.body.data.conversationId).not.toBe('a-peer');
      expect(made.body.data.branchPointTurnId).toBe('a-peer-turn');
      expect(forksOf('a-peer')).toBe(index + 1);
    }
  });

  test("a caller that is not a bound operator cannot fork another Project's or another person's conversation, and nothing is written", async () => {
    const { fork, forksOf } = await setup();
    for (const kind of [delegated, bearer]) {
      const otherProject = await fork(kind('a-caller'), {
        conversationId: 'a-other',
      });
      expect(
        otherProject.body,
        JSON.stringify(otherProject.body),
      ).toMatchObject({
        success: false,
        code: 'station_control_out_of_scope',
      });
      const fromGlobal = await fork(kind('g-caller'), {
        conversationId: 'a-peer',
      });
      expect(fromGlobal.body, JSON.stringify(fromGlobal.body)).toMatchObject({
        success: false,
        code: 'station_control_out_of_scope',
      });
    }
    // Another person's Session in the same Project is not the owner's: only
    // a bound operator reaches it, so an operator-owned caller whose
    // credential could have been copied is refused before anything is read.
    for (const kind of [delegated, bearer]) {
      const carols = await fork(kind('a-caller'), {
        conversationId: 'carol-p1',
      });
      expect(carols.body, JSON.stringify(carols.body)).toMatchObject({
        success: false,
        code: 'station_control_assurance_insufficient',
      });
    }
    expect([
      forksOf('a-other'),
      forksOf('a-peer'),
      forksOf('carol-p1'),
    ]).toEqual([0, 0, 0]);
  });

  test('a fork never lands in a scope the caller could not otherwise reach', async () => {
    const { fork, forksOf } = await setup();
    for (const kind of [delegated, bearer]) {
      // Its own conversation, into another Project.
      const intoOther = await fork(kind('a-caller'), {
        conversationId: 'a-caller',
        targetProjectSlug: 'project-2',
      });
      expect(intoOther.body).toMatchObject({
        success: false,
        code: 'station_control_out_of_scope',
      });
      // From the global space, its own conversation into a Project.
      const globalIntoProject = await fork(kind('g-caller'), {
        conversationId: 'g-caller',
        targetProjectSlug: 'project-1',
      });
      expect(globalIntoProject.body).toMatchObject({
        success: false,
        code: 'station_control_out_of_scope',
      });
    }
    expect([forksOf('a-caller'), forksOf('g-caller')]).toEqual([0, 0]);
    // The same request into its own Project is admitted.
    const own = await fork(delegated('a-caller'), {
      conversationId: 'a-caller',
      targetProjectSlug: 'project-1',
    });
    expect(own.body?.success, JSON.stringify(own.body)).toBe(true);
    expect(forksOf('a-caller')).toBe(1);
  });

  test('replaying a fork key does not hand back a fork outside the caller scope', async () => {
    const { fork, forksOf } = await setup();
    const request = {
      conversationId: 'a-caller',
      targetProjectSlug: 'project-2',
      idempotencyKey: 'into-project-2',
    };
    // The bound operator may fork its own conversation into Project 2.
    const made = await fork(bound('a-caller'), request);
    expect(made.body?.success, JSON.stringify(made.body)).toBe(true);
    // The same owner's copied credential replays the same key: the saved
    // fork is in Project 2, which that caller could not reach.
    for (const kind of [delegated, bearer]) {
      const replayed = await fork(kind('a-caller'), request);
      expect(replayed.body, JSON.stringify(replayed.body)).toMatchObject({
        success: false,
        code: 'station_control_out_of_scope',
      });
    }
    expect(forksOf('a-caller')).toBe(1);
  });

  test("a bound operator keeps the operator's reach; a person's own fork is not scoped by this rule", async () => {
    const { fork, personFork, forksOf } = await setup();
    const operator = await fork(bound('a-caller'), {
      conversationId: 'a-other',
      targetProjectSlug: 'project-2',
    });
    expect(operator.body?.success, JSON.stringify(operator.body)).toBe(true);
    const person = await personFork('a-other', {
      targetProjectSlug: 'project-2',
    });
    expect(person.status, JSON.stringify(person.body)).toBe(200);
    expect(forksOf('a-other')).toBe(2);
  });
});
