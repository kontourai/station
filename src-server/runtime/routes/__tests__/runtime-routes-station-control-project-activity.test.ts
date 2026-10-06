/**
 * station#3413: `list_project_activity`, `get_session_digest` and
 * `read_conversation`'s `aroundMessageId` at the REAL boundary:
 * `configureRuntimeRoutes` with the real runtime auth boundary, the real
 * station-control guard, caller and scope derivation
 * (`createStationControlDispatchScope`) over REAL session records (a real
 * `EventStore` + `OrchestrationService`), the real unified-search service and
 * the real station-control MCP server with really minted per-session tokens.
 *
 * Every event is written through `EventStore.appendEvent`, the writer the
 * runtime uses (a declared pull request with its terminal-turn admission,
 * a paired-Station Activity record through
 * `recordPeerDelegationActivityDispatch`), never a hand-written row.
 *
 * Sessions (owner A, the Station operator, unless noted):
 *  - Project 1: `a-caller` (the caller), `a-peer` (the rich one), `a-running`,
 *    `a-failed`, `a-stopped`, `a-long`, `a-anchor`, `a-child-1` (delegated by
 *    `a-peer` during its turn 2);
 *  - Project 2: `a-other-project`, `a-child-p2` (also delegated by `a-peer`);
 *  - the global space: `g-caller`, `a-global`, and a paired-Station Activity
 *    record (another host's, in no Project);
 *  - `carol-p1`: Project 1, owned by another person.
 */
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { awaitSessionAttachmentSettled } from '../../../__test-utils__/session-runtime-barriers.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { FileMemoryAdapter } from '../../../adapters/file/memory-adapter.js';
import { FileStorageAdapter } from '../../../domain/file-storage-adapter.js';
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
import {
  createStationControlMcpServer,
  stationControlToolCatalog,
} from '../../../tools/station-control-mcp-server.js';
import {
  __resetStationControlStdioEntryForTests,
  api,
  type StationControlCaller,
  stationControlCallerPrincipal,
  withStationControlCallerContext,
} from '../../../tools/station-control-shared.js';
import {
  getInternalApiToken,
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_PROXY_CALLER_HEADER,
} from '../../../utils/internal-api-token.js';
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

const OPERATOR_CREDENTIAL = 'test-only-operator-credential-project-activity';
const A = LOCAL_OPERATOR_PRINCIPAL_ID;
const CAROL = 'human:tailscale-serve:carol';
const makeTempDir = trackTempDirs();
const BASE_TIME = Date.parse('2026-10-05T10:00:00.000Z');

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

/** The Project 1 Sessions a caller in Project 1 may list (as `a-caller`). */
const PROJECT_1_SESSIONS = [
  'a-anchor',
  'a-caller',
  'a-child-1',
  'a-failed',
  'a-long',
  'a-peer',
  'a-running',
  'a-stopped',
];

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

describe('station-control Project activity, digest and read anchor (#3413)', () => {
  const closers: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    __resetStationControlMcpTokensForTests();
    __resetStationControlStdioEntryForTests();
    delete process.env.STATION_API_BASE;
    for (const close of closers.splice(0)) await close();
  });

  async function setup(options: { filler?: number } = {}) {
    __resetStationServerSelfAttestationForTests();
    const home = makeTempDir('station-control-project-activity-');
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

    const startSession = (
      threadId: string,
      owner: string,
      project: { id: string; slug: string } | undefined,
      options: {
        status?: 'ready' | 'running' | 'closed';
        metadata?: Record<string, unknown>;
        worktree?: { path: string; branch: string };
      } = {},
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
          agentSlug: 'codex-agent',
          ...(project
            ? {
                [SESSION_LOCAL_PROJECT_ID_METADATA_KEY]: project.id,
                projectSlug: project.slug,
              }
            : {}),
          ...(options.worktree
            ? {
                // The stamp a worktree-isolated start records.
                worktree: {
                  mode: 'worktree',
                  repoPath: '/repo',
                  baseRef: 'origin/main',
                  cleanupPolicy: 'preserve',
                  preserveOnFailure: true,
                  createdAt: new Date(BASE_TIME).toISOString(),
                  ...options.worktree,
                },
              }
            : {}),
          ...options.metadata,
        },
      } as never);
      store.upsertSession({
        threadId,
        provider: 'codex',
        status: options.status ?? 'ready',
        createdAt: at(),
        updatedAt: at(),
        ...(options.worktree ? { cwd: options.worktree.path } : {}),
      } as never);
    };

    interface TurnOptions {
      prompt?: string;
      tools?: Array<{
        name: string;
        kind?: string;
        path?: string;
        status?: 'success' | 'error';
      }>;
      /** How the turn ends; `open` writes no terminal. */
      end: 'completed' | 'failed' | 'aborted' | 'cancelled' | 'open';
      answer?: string;
      pullRequests?: Array<{ owner: string; name: string; ref: string }>;
      /** A message steered into the running turn (the same turn id, `inputKind: 'steer'`). */
      steer?: string;
    }
    const writeTurn = (threadId: string, n: number, options: TurnOptions) => {
      const turnId = `${threadId}-turn-${n}`;
      const base = { threadId, turnId, provider: 'codex' } as const;
      store.appendEvent({
        ...base,
        eventId: `${turnId}:start`,
        method: 'turn.started',
        createdAt: at(),
        prompt: options.prompt ?? `${threadId} request ${n}`,
      } as never);
      if (options.steer !== undefined)
        store.appendEvent({
          ...base,
          eventId: `${turnId}:steer`,
          method: 'turn.started',
          createdAt: at(),
          inputKind: 'steer',
          prompt: options.steer,
        } as never);
      (options.tools ?? []).forEach((tool, index) => {
        const toolCallId = `${turnId}:call-${index}`;
        store.appendEvent({
          ...base,
          eventId: `${toolCallId}:started`,
          method: 'tool.started',
          createdAt: at(),
          itemId: toolCallId,
          toolCallId,
          toolName: tool.name,
          ...(tool.kind ? { toolKind: tool.kind } : {}),
          arguments: tool.path ? { path: tool.path } : { command: 'ls' },
        } as never);
        store.appendEvent({
          ...base,
          eventId: `${toolCallId}:completed`,
          method: 'tool.completed',
          createdAt: at(),
          itemId: toolCallId,
          toolCallId,
          toolName: tool.name,
          ...(tool.kind ? { toolKind: tool.kind } : {}),
          status: tool.status ?? 'success',
        } as never);
      });
      if (options.end === 'open') return;
      if (options.end === 'failed')
        store.appendEvent({
          ...base,
          eventId: `${turnId}:error`,
          method: 'runtime.error',
          createdAt: at(),
          severity: 'error',
          message: 'The engine failed',
        } as never);
      else if (options.end === 'aborted')
        store.appendEvent({
          ...base,
          eventId: `${turnId}:abort`,
          method: 'turn.aborted',
          createdAt: at(),
          reason: 'user-stop',
        } as never);
      else {
        const eventId = `${turnId}:done`;
        const declared = (options.pullRequests ?? []).map((pr, index) => ({
          handle: `${turnId}:handle-${index}`,
          declaration: {
            version: 'declared-output/v1' as const,
            declarationId: `${turnId}:declaration-${index}`,
            sessionId: threadId,
            eventId,
            turnId,
            toolCallId: `${turnId}:declare-${index}`,
            declaredAt: at(),
            descriptor: {
              kind: 'pull-request' as const,
              provider: 'github',
              host: 'github.com',
              repository: { owner: pr.owner, name: pr.name },
              ref: pr.ref,
              nativeId: `${pr.owner}/${pr.name}#${pr.ref}`,
            },
          },
        }));
        store.appendEvent(
          {
            ...base,
            eventId,
            method: 'turn.completed',
            createdAt: at(),
            finishReason: options.end === 'cancelled' ? 'cancelled' : 'stop',
            outputText: options.answer ?? `${threadId} answer ${n}`,
          } as never,
          declared,
        );
      }
    };

    // Sessions.
    startSession('a-caller', A, p1);
    startSession('a-peer', A, p1, {
      worktree: { path: '/work/a-peer', branch: 'feat/a-peer' },
    });
    startSession('a-running', A, p1, { status: 'running' });
    startSession('a-failed', A, p1);
    startSession('a-stopped', A, p1);
    startSession('a-long', A, p1);
    startSession('a-anchor', A, p1);
    // Runs unconfined: another Session's host is never a scoped caller's to read.
    startSession('a-host', A, p1, {
      metadata: { stationConfinement: 'host' },
    });
    startSession('a-other-project', A, p2);
    startSession('g-caller', A, undefined);
    startSession('a-global', A, undefined);
    startSession('carol-p1', CAROL, p1);
    // A Session whose Project cannot be confirmed (a slug with no recorded
    // Project id): its own scope is unreadable, so it matches nothing.
    startSession('u-caller', A, undefined, {
      metadata: { projectSlug: 'project-1' },
    });

    writeTurn('a-caller', 1, { end: 'completed', prompt: 'CALLER-WORK' });
    writeTurn('a-host', 1, { end: 'completed', prompt: 'HOST-SECRET' });
    writeTurn('a-running', 1, {
      end: 'open',
      prompt: 'RUNNING-WORK still going',
    });
    writeTurn('a-failed', 1, { end: 'failed', prompt: 'FAILED-WORK' });
    writeTurn('a-stopped', 1, { end: 'aborted', prompt: 'STOPPED-WORK' });
    writeTurn('a-other-project', 1, {
      end: 'completed',
      prompt: 'OTHER-PROJECT-SECRET',
    });
    writeTurn('a-global', 1, { end: 'completed', prompt: 'GLOBAL-SECRET' });
    writeTurn('g-caller', 1, { end: 'completed', prompt: 'G-CALLER-WORK' });
    writeTurn('carol-p1', 1, { end: 'completed', prompt: 'CAROL-SECRET' });
    // Filler: other Projects' Sessions (two turns each), for the scale checks.
    for (let n = 0; n < (options.filler ?? 0); n += 1) {
      startSession(`f-${n}`, A, p2);
      writeTurn(`f-${n}`, 1, { end: 'completed' });
      writeTurn(`f-${n}`, 2, { end: 'completed' });
    }

    // The rich Session: every kind of turn, in order.
    writeTurn('a-peer', 1, {
      end: 'completed',
      prompt: `${'  \n'}Fix the flaky retry test\nSecond line that is not the request`,
      tools: [
        { name: 'Bash' },
        { name: 'Bash' },
        { name: 'Bash' },
        { name: 'Read' },
        { name: 'Read' },
        { name: 'edit_file', kind: 'edit', path: 'src/retry.ts' },
        { name: 'edit_file', kind: 'edit', path: 'src/retry.ts' },
        { name: 'delete_file', kind: 'delete', path: 'src/old.ts' },
        // Not a recorded kind: a path in a tool's arguments alone is not a file touched.
        { name: 'search', path: 'src/never-listed.ts' },
        // A failed edit touched nothing.
        {
          name: 'edit_file',
          kind: 'edit',
          path: 'src/failed.ts',
          status: 'error',
        },
      ],
      pullRequests: [{ owner: 'kontourai', name: 'station', ref: '3413' }],
      steer: 'STEER-NOT-A-TURN please also check the docs',
    });
    // The turn during which two children are delegated (below).
    writeTurn('a-peer', 2, {
      end: 'failed',
      prompt: 'Second request',
      tools: [{ name: 'delegate_task' }],
    });
    // Delegated children, started after turn 2 began and before turn 3: the
    // metadata the delegation start stamps (`parentConversationId` with the
    // provenance stamp). Station-derived, in two Projects.
    for (const [threadId, project] of [
      ['a-child-1', p1],
      ['a-child-p2', p2],
    ] as const)
      startSession(threadId, A, project, {
        metadata: {
          taskId: `task:${threadId}`,
          delegation: { parentConversationId: 'a-peer' },
          stationDelegationProvenance: 'caller-derived',
        },
      });
    writeTurn('a-child-1', 1, { end: 'completed', prompt: 'CHILD-WORK' });
    writeTurn('a-child-p2', 1, { end: 'completed', prompt: 'CHILD-P2-WORK' });
    writeTurn('a-peer', 3, { end: 'aborted', prompt: 'Third request' });
    writeTurn('a-peer', 4, { end: 'cancelled', prompt: 'Fourth request' });
    writeTurn('a-peer', 5, { end: 'open', prompt: 'x'.repeat(5000) });

    // A long Session: sixty turns, each with a long multi-line request, many
    // distinct tools, many files and pull requests.
    for (let n = 1; n <= 60; n += 1)
      writeTurn('a-long', n, {
        end: 'completed',
        prompt: `Turn ${n} ${'long request \u001b'.repeat(400)}\nsecond\nthird`,
        tools: Array.from({ length: 14 }, (_, index) => ({
          name: `tool_${'x'.repeat(40)}_${index}`,
          kind: 'edit',
          path: `src/${'deep/'.repeat(30)}file-${n}-${index}.ts`,
        })),
        pullRequests: Array.from({ length: 7 }, (_, index) => ({
          owner: 'kontourai',
          name: 'station',
          ref: String(n * 10 + index),
        })),
      });

    // A transcript to search and read at a hit: sixty messages, the marker
    // in the user message of turn 17 and in the assistant message of turn 23.
    for (let n = 1; n <= 30; n += 1)
      writeTurn('a-anchor', n, {
        end: 'completed',
        prompt:
          n === 17 ? 'The zephyrquartz marker is here' : `Anchor question ${n}`,
        answer: n === 23 ? 'Answer holding quasarmarker' : `Anchor answer ${n}`,
      });

    const orchestration = new OrchestrationService({
      eventStore: store,
      adoptionLedger: store.createAdoptionLedger(),
      eventBus: new EventBus(),
      adapterRegistry: { register() {}, get: () => undefined, list: () => [] },
      logger: { debug() {}, warn() {} },
    });
    orchestration.initialize();
    // Another Station's Activity record (a paired-Station delegation), in no
    // Project, through the writer the delegation route uses.
    orchestration.recordPeerDelegationActivityDispatch({
      taskId: 'remote-task',
      conversationId: 'remote-conversation',
      prompt: 'REMOTE-SECRET work on another Station',
      userId: A,
      environment: { id: 'peer-env', name: 'Peer Station', kind: 'peer' },
      target: { kind: 'agent', id: 'remote-agent' },
    });
    const taskGraph = new TaskGraphService(home, {
      projectService: { getProject: () => p1 },
    });
    const runtimeSearch = createRuntimeSearch({
      stationId: '44444444-4444-4444-8444-444444444444',
      tasks: taskGraph,
      transcripts: orchestration,
    });
    closers.push(async () => {
      await runtimeSearch.close();
      try {
        await orchestration.shutdown();
      } catch (error) {
        // `shutdown` checks the transcript worker's phase right after its own
        // close window; only that exact pending-retirement report is
        // tolerated (tracked in #3266).
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
      agentService: { listAgents: () => [] },
      agentMetadataMap: new Map(),
      agentFixedTokens: new Map(),
      agentTools: new Map(),
      agentStats: new Map(),
      agentStatus: new Map(),
      memoryAdapters: new Map([
        ['default', new FileMemoryAdapter({ projectHomeDir: home })],
      ]),
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
    // The requests the tools send to Station's own routes: a refusal made by
    // a tool's own schema never sends one.
    const routeRequests: string[] = [];
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (
        url.startsWith(base) &&
        /\/api\/orchestration\/session-activity/.test(url)
      )
        routeRequests.push(new URL(url).pathname);
      return realFetch(input, init);
    });

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

    const OWNER: Record<string, string | undefined> = {
      'a-caller': A,
      'g-caller': A,
      'u-caller': A,
      'carol-p1': CAROL,
    };
    /** A station-control tool call, as the engine's MCP client makes it. */
    async function tool(
      caller: Caller,
      name: string,
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
        () => rpc('tools/call', { name, arguments: args }),
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

    /** A request exactly as a tool makes it, bypassing the tool's own schema. */
    async function asTool(caller: Caller, path: string): Promise<any> {
      const { token } = mintStationControlMcpToken(
        caller.session,
        caller.channel,
      );
      return withStationControlCallerContext(
        { token, resolve: () => null },
        () => api(path),
      );
    }

    /** A request with only the internal credential (a raw token, a pooled child). */
    async function rawRequest(
      path: string,
      extra: Record<string, string> = {},
    ) {
      const response = await realFetch(`${base}${path}`, {
        headers: {
          [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
          [INTERNAL_PROXY_CALLER_HEADER]: 'local',
          ...extra,
        },
      });
      return {
        status: response.status,
        body: (await response.json()) as any,
      };
    }

    return {
      store,
      orchestration,
      tool,
      asTool,
      rawRequest,
      routeRequests,
      appendTurn: writeTurn,
    };
  }

  const ids = (body: any): string[] =>
    ((body?.data?.sessions ?? []) as { sessionId: string }[])
      .map((row) => row.sessionId)
      .sort();

  describe('list_project_activity', () => {
    test('lists exactly the caller’s own Project, for every caller kind, and never another Project, owner or host', async () => {
      const { tool } = await setup();
      for (const caller of [
        bound('a-caller'),
        delegated('a-caller'),
        bearer('a-caller'),
      ]) {
        const listed = await tool(caller, 'list_project_activity', {});
        // A bound operator keeps the operator's reach to an unconfined
        // Session; a scoped caller never reaches one, and it reads as absent.
        const expected =
          caller.channel === 'sdk-in-process'
            ? [...PROJECT_1_SESSIONS, 'a-host'].sort()
            : [...PROJECT_1_SESSIONS];
        expect([caller.channel, listed.isError, ids(listed.body)]).toEqual([
          caller.channel,
          false,
          expected,
        ]);
        const text = JSON.stringify(listed.body);
        // Another Project, another person and another Station are absent,
        // not reported as hidden.
        for (const secret of [
          'a-other-project',
          'a-child-p2',
          'a-global',
          'g-caller',
          'carol-p1',
          'REMOTE-SECRET',
          'peer-delegation',
          'OTHER-PROJECT-SECRET',
          'CAROL-SECRET',
          ...(caller.channel === 'sdk-in-process'
            ? []
            : ['a-host', 'HOST-SECRET']),
        ])
          expect([caller.channel, secret, text.includes(secret)]).toEqual([
            caller.channel,
            secret,
            false,
          ]);
        // A claim is Part B: the field is not there, not even empty.
        expect(text).not.toMatch(/claim/i);
      }
    });

    test('a caller in the global space lists the global space only, and never another host', async () => {
      const { tool } = await setup();
      for (const caller of [
        bound('g-caller'),
        delegated('g-caller'),
        bearer('g-caller'),
      ]) {
        const listed = await tool(caller, 'list_project_activity', {});
        expect([caller.channel, ids(listed.body)]).toEqual([
          caller.channel,
          ['a-global', 'g-caller'],
        ]);
      }
    });

    test('another person lists only their own Sessions in the Project', async () => {
      const { tool } = await setup();
      const listed = await tool(
        bearer('carol-p1'),
        'list_project_activity',
        {},
      );
      // Carol's session has no recorded Project membership, so she may be
      // refused or see only her own; she never sees the operator's.
      expect(JSON.stringify(listed.body)).not.toMatch(/a-peer|CALLER-WORK/);
      // Her own Session is there: the check above is not vacuous.
      expect(ids(listed.body)).toEqual(['carol-p1']);
    });

    test('says what each Session is: the ladder word, whether a turn runs, engine, agent, activity, worktree and self', async () => {
      const { tool } = await setup();
      const listed = await tool(
        bearer('a-caller'),
        'list_project_activity',
        {},
      );
      const rows = new Map<string, any>(
        listed.body.data.sessions.map((row: any) => [row.sessionId, row]),
      );
      // The words are the status ladder's, written out independently here.
      expect(rows.get('a-running')).toMatchObject({
        status: 'Running',
        turnRunning: true,
      });
      expect(rows.get('a-failed')).toMatchObject({
        status: 'Failed',
        turnRunning: false,
      });
      expect(rows.get('a-stopped')).toMatchObject({
        status: 'Stopped',
        turnRunning: false,
      });
      expect(rows.get('a-anchor')).toMatchObject({
        status: 'Done',
        turnRunning: false,
      });
      expect(rows.get('a-caller')).toMatchObject({
        self: true,
        engine: 'codex',
        agent: 'codex-agent',
        title: expect.stringContaining('CALLER-WORK'),
      });
      expect(rows.get('a-peer')).toMatchObject({
        worktree: { path: '/work/a-peer', branch: 'feat/a-peer' },
      });
      expect(rows.get('a-peer').self).toBeUndefined();
      expect(rows.get('a-running').worktree).toBeUndefined();
      for (const row of rows.values())
        expect(Date.parse(row.lastActivityAt)).toBeGreaterThan(BASE_TIME - 1);
      // Newest activity first.
      const times = listed.body.data.sessions.map(
        (row: any) => row.lastActivityAt,
      );
      expect(times).toEqual([...times].sort().reverse());
    });

    test('pages cover every Session once, and a limit past the maximum is refused at the tool and at the route', async () => {
      const { tool, asTool, routeRequests } = await setup();
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await tool(bearer('a-caller'), 'list_project_activity', {
          limit: 3,
          ...(cursor ? { cursor } : {}),
        });
        expect(page.isError).toBe(false);
        expect(page.body.data.sessions.length).toBeLessThanOrEqual(3);
        seen.push(...page.body.data.sessions.map((row: any) => row.sessionId));
        cursor = page.body.data.nextCursor ?? undefined;
        pages += 1;
      } while (cursor && pages < 10);
      expect(pages).toBe(3);
      expect([...seen].sort()).toEqual([...PROJECT_1_SESSIONS]);
      expect(new Set(seen).size).toBe(PROJECT_1_SESSIONS.length);

      routeRequests.length = 0;
      const refused = await tool(bearer('a-caller'), 'list_project_activity', {
        limit: 51,
      });
      expect(refused.isError).toBe(true);
      expect(routeRequests).toEqual([]);
      const viaRoute = await asTool(
        bearer('a-caller'),
        '/api/orchestration/session-activity?limit=51',
      );
      expect(viaRoute).toMatchObject({
        success: false,
        code: 'project_activity_limit_out_of_range',
      });
      const atMaximum = await tool(
        bearer('a-caller'),
        'list_project_activity',
        {
          limit: 50,
        },
      );
      expect(atMaximum.isError).toBe(false);
      expect(ids(atMaximum.body)).toEqual([...PROJECT_1_SESSIONS]);
      const forged = await tool(bearer('a-caller'), 'list_project_activity', {
        cursor: 'bm90LWEtY3Vyc29y',
      });
      expect(forged).toMatchObject({
        isError: true,
        body: { code: 'project_activity_cursor_invalid' },
      });
    });

    test('a Project-narrowed call folds and walks only its own Project’s Sessions', async () => {
      const { tool, orchestration } = await setup({ filler: 150 });
      const fold = vi.spyOn(orchestration, 'listSessionReadModel');
      const listed = await tool(
        bearer('a-caller'),
        'list_project_activity',
        {},
      );
      expect(ids(listed.body)).toEqual([...PROJECT_1_SESSIONS]);
      // The read model was asked for the candidates of the caller's Project
      // only: none of the 150 other-Project Sessions was folded.
      const folded = fold.mock.calls.flatMap(
        ([, options]) => options?.threadIds ?? ['(whole inventory)'],
      );
      expect(folded.length).toBeGreaterThan(0);
      expect(folded.filter((id) => id.startsWith('f-'))).toEqual([]);
      expect(folded).not.toContain('(whole inventory)');
      // A global caller's candidates exclude every Project's Sessions too.
      fold.mockClear();
      const global = await tool(
        bearer('g-caller'),
        'list_project_activity',
        {},
      );
      expect(ids(global.body)).toEqual(['a-global', 'g-caller']);
      const globalFolded = fold.mock.calls.flatMap(
        ([, options]) => options?.threadIds ?? ['(whole inventory)'],
      );
      expect(globalFolded).not.toContain('(whole inventory)');
      expect(
        globalFolded.filter(
          (id) => id.startsWith('f-') || id.startsWith('a-p'),
        ),
      ).toEqual([]);
    });

    test('a raw token and a pooled child carry no caller: both leaves refuse', async () => {
      const { rawRequest } = await setup();
      const extras: Record<string, string>[] = [
        {},
        { 'x-station-control-caller-binding': 'a'.repeat(43) },
      ];
      for (const extra of extras)
        for (const path of [
          '/api/orchestration/session-activity',
          '/api/orchestration/session-activity/a-peer/digest',
        ]) {
          const answer = await rawRequest(path, extra);
          expect([path, answer.status, answer.body.code]).toEqual([
            path,
            403,
            expect.stringMatching(/^station_control_/),
          ]);
          expect(JSON.stringify(answer.body)).not.toContain('a-peer');
        }
    });
  });

  describe('get_session_digest', () => {
    const NOT_FOUND = { success: false, code: 'session_not_found' };

    test('caller kind × target: same Project reads, another Project, global, another owner, another host and an unknown id read as absent', async () => {
      const { tool } = await setup();
      for (const caller of [
        bound('a-caller'),
        delegated('a-caller'),
        bearer('a-caller'),
      ]) {
        const rows: Array<[string, boolean]> = [];
        for (const target of [
          'a-peer',
          'a-host',
          'a-other-project',
          'a-global',
          'carol-p1',
          'a-child-p2',
          'peer-delegation:x',
          'no-such-session',
        ]) {
          const digest = await tool(caller, 'get_session_digest', {
            sessionId: target,
          });
          rows.push([target, digest.isError === false]);
        }
        // A bound operator keeps the operator's reach across Projects and the
        // global space, as for `read_conversation`, but never another
        // person's Session or another host's.
        const expected: Array<[string, boolean]> =
          caller.channel === 'sdk-in-process'
            ? [
                ['a-peer', true],
                ['a-host', true],
                ['a-other-project', true],
                ['a-global', true],
                ['carol-p1', false],
                ['a-child-p2', true],
                ['peer-delegation:x', false],
                ['no-such-session', false],
              ]
            : [
                ['a-peer', true],
                ['a-host', false],
                ['a-other-project', false],
                ['a-global', false],
                ['carol-p1', false],
                ['a-child-p2', false],
                ['peer-delegation:x', false],
                ['no-such-session', false],
              ];
        expect([caller.channel, rows]).toEqual([caller.channel, expected]);
      }
    });

    test('another Project’s Session reads exactly like one that does not exist, with no detail', async () => {
      const { tool } = await setup();
      const other = await tool(bearer('a-caller'), 'get_session_digest', {
        sessionId: 'a-other-project',
      });
      const unknown = await tool(bearer('a-caller'), 'get_session_digest', {
        sessionId: 'a-unknown-project',
      });
      expect(other).toMatchObject({ isError: true, body: NOT_FOUND });
      expect(other.body).toEqual(unknown.body);
      expect(JSON.stringify(other.body)).not.toMatch(
        /OTHER-PROJECT-SECRET|project-2/,
      );
    });

    test('the remote host record is absent even from a bound operator in the global space', async () => {
      const { tool, store } = await setup();
      const remote = store
        .readSessions()
        .find((session) => session.threadId.startsWith('peer-delegation:'));
      expect(remote).toBeDefined();
      for (const caller of [bound('g-caller'), bearer('g-caller')]) {
        const digest = await tool(caller, 'get_session_digest', {
          sessionId: remote!.threadId,
        });
        expect([caller.channel, digest.isError, digest.body]).toMatchObject([
          caller.channel,
          true,
          NOT_FOUND,
        ]);
        expect(JSON.stringify(digest.body)).not.toContain('REMOTE-SECRET');
      }
    });

    test('is derived only from recorded events: every turn’s facts match the log, and a new event changes it', async () => {
      const { tool, store, appendTurn } = await setup();
      const first = await tool(bearer('a-caller'), 'get_session_digest', {
        sessionId: 'a-peer',
      });
      expect(first.isError).toBe(false);
      const { session, turns, page } = first.body.data;
      expect(session).toMatchObject({
        sessionId: 'a-peer',
        engine: 'codex',
        agent: 'codex-agent',
        projectSlug: 'project-1',
        turnCount: 5,
        worktree: { path: '/work/a-peer', branch: 'feat/a-peer' },
      });
      expect(session.title).toEqual(expect.any(String));
      // Newest first: 5, 4, 3, 2, 1.
      expect(turns.map((turn: any) => turn.turnId)).toEqual([
        'a-peer-turn-5',
        'a-peer-turn-4',
        'a-peer-turn-3',
        'a-peer-turn-2',
        'a-peer-turn-1',
      ]);
      // A steer into a running turn shares its turn id: it is not a turn, so
      // it neither adds one nor changes the request or the count.
      expect(JSON.stringify(first.body)).not.toContain('STEER-NOT-A-TURN');
      expect(
        store
          .listEvents('a-peer')
          .filter((event) => (event.payload as any).inputKind === 'steer'),
      ).toHaveLength(1);
      const byId = new Map<string, any>(
        turns.map((turn: any) => [turn.turnId, turn]),
      );
      // The outcome of each turn, from its recorded terminal event.
      expect(
        turns.map((turn: any) => [turn.turnId.slice(-1), turn.outcome]),
      ).toEqual([
        ['5', 'open'],
        ['4', 'interrupted'],
        ['3', 'interrupted'],
        ['2', 'failed'],
        ['1', 'completed'],
      ]);
      const one = byId.get('a-peer-turn-1');
      // The request's first non-empty line, and only that.
      expect(one.request).toBe('Fix the flaky retry test');
      expect(JSON.stringify(one)).not.toContain('Second line');
      expect(one.toolCalls).toEqual([
        { tool: 'Bash', calls: 3 },
        { tool: 'edit_file', calls: 3 },
        { tool: 'Read', calls: 2 },
        { tool: 'delete_file', calls: 1 },
        { tool: 'search', calls: 1 },
      ]);
      // Files only from a call whose engine reported an edit, delete or move
      // kind AND that succeeded; a path in a plain tool's arguments is not one.
      expect(one.files).toEqual(['src/retry.ts', 'src/old.ts']);
      expect(one.filesTotal).toBe(2);
      expect(one.pullRequests).toEqual([
        { host: 'github.com', repository: 'kontourai/station', ref: '3413' },
      ]);
      // A turn that had none says nothing: no empty placeholders.
      const two = byId.get('a-peer-turn-2');
      // A turn that called tools none of which carried an engine tool kind says
      // so: an absent `files` there is unknown, not none. A turn whose engine
      // did report kinds, and a turn with no tool calls, carry no marker.
      expect(two.filesReported).toBe(false);
      expect(one.filesReported).toBeUndefined();
      expect(byId.get('a-peer-turn-3').filesReported).toBeUndefined();
      expect(two.files).toBeUndefined();
      expect(two.pullRequests).toBeUndefined();
      // A long single line is clipped, and says so.
      const five = byId.get('a-peer-turn-5');
      expect(five.requestClipped).toBe(true);
      expect(five.request.length).toBeLessThan(300);
      // Delegated children: Station-derived, visible, in the turn they started.
      expect(two.delegatedChildren).toEqual([
        {
          sessionId: 'a-child-1',
          title: expect.stringContaining('CHILD-WORK'),
        },
      ]);
      expect(
        turns
          .filter((turn: any) => turn.turnId !== 'a-peer-turn-2')
          .every((turn: any) => turn.delegatedChildren === undefined),
      ).toBe(true);
      // Nothing is named that nothing computes: no summary, no model, no claim.
      expect(Object.keys(first.body.data).sort()).toEqual([
        'nextCursor',
        'page',
        'session',
        'turns',
      ]);
      expect(JSON.stringify(first.body)).not.toMatch(/summary|claim/i);
      expect(page).toMatchObject({ maxBytes: 8192, order: 'newest-first' });

      // Independent recomputation from the stored events, not from the tool.
      const events = store
        .listEvents('a-peer')
        .map((event) => event.payload as any);
      for (const turn of turns) {
        const own = events.filter((event) => event.turnId === turn.turnId);
        const started = own.filter((event) => event.method === 'tool.started');
        const total = turn.toolCalls.reduce(
          (sum: number, entry: any) => sum + entry.calls,
          0,
        );
        expect([turn.turnId, total]).toEqual([turn.turnId, started.length]);
      }

      // A recorded fact appears; a model summary could not have.
      appendTurn('a-peer', 6, {
        end: 'completed',
        prompt: 'A brand new request',
        tools: [{ name: 'NewTool' }],
      });
      const second = await tool(bearer('a-caller'), 'get_session_digest', {
        sessionId: 'a-peer',
      });
      expect(second.body.data.session.turnCount).toBe(6);
      expect(second.body.data.turns[0]).toMatchObject({
        turnId: 'a-peer-turn-6',
        request: 'A brand new request',
        toolCalls: [{ tool: 'NewTool', calls: 1 }],
        outcome: 'completed',
      });
    });

    test('a caller whose own scope cannot be read still reads its OWN digest, and nothing else', async () => {
      const { tool } = await setup();
      for (const caller of [bearer('u-caller'), delegated('u-caller')]) {
        const own = await tool(caller, 'get_session_digest', {
          sessionId: 'u-caller',
        });
        expect([
          caller.channel,
          own.isError,
          own.body.data?.session?.sessionId,
        ]).toEqual([caller.channel, false, 'u-caller']);
        // The rule refuses every other Session to it: absent, and an empty list.
        for (const target of ['a-peer', 'a-global', 'g-caller']) {
          const other = await tool(caller, 'get_session_digest', {
            sessionId: target,
          });
          expect([caller.channel, target, other.body.code]).toEqual([
            caller.channel,
            target,
            'session_not_found',
          ]);
        }
        const listed = await tool(caller, 'list_project_activity', {});
        expect([caller.channel, ids(listed.body)]).toEqual([
          caller.channel,
          [],
        ]);
      }
    });

    test('a bound operator also sees a delegated child in another Project; a scoped caller does not', async () => {
      const { tool } = await setup();
      const scoped = await tool(bearer('a-caller'), 'get_session_digest', {
        sessionId: 'a-peer',
      });
      const wide = await tool(bound('a-caller'), 'get_session_digest', {
        sessionId: 'a-peer',
      });
      const childrenOf = (answer: any) =>
        answer.body.data.turns
          .flatMap((turn: any) => turn.delegatedChildren ?? [])
          .map((child: any) => child.sessionId)
          .sort();
      expect(childrenOf(scoped)).toEqual(['a-child-1']);
      expect(childrenOf(wide)).toEqual(['a-child-1', 'a-child-p2']);
      expect(JSON.stringify(scoped.body)).not.toContain('CHILD-P2-WORK');
    });

    test('a long Session stays under its cap on every page, and paging loses no turn', async () => {
      const { tool, asTool } = await setup();
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await tool(bearer('a-caller'), 'get_session_digest', {
          sessionId: 'a-long',
          turnLimit: 25,
          ...(cursor ? { cursor } : {}),
        });
        expect(page.isError).toBe(false);
        // The cap is a literal here, not read from the constant under test.
        expect(bytes(page.body.data.turns)).toBeLessThanOrEqual(8192);
        expect(page.body.data.page.bytes).toBeLessThanOrEqual(8192);
        expect(page.body.data.session.turnCount).toBe(60);
        seen.push(...page.body.data.turns.map((turn: any) => turn.turnId));
        cursor = page.body.data.nextCursor ?? undefined;
        pages += 1;
      } while (cursor && pages < 100);
      // Twenty-five turns of this size cannot fit 8 KiB, so the byte cap, not
      // the turn window, ended pages; and every turn arrived once, in order.
      expect(pages).toBeGreaterThan(3);
      expect(seen).toEqual(
        Array.from({ length: 60 }, (_, index) => `a-long-turn-${60 - index}`),
      );

      // Past the bound is refused, never cut to it.
      const over = await tool(bearer('a-caller'), 'get_session_digest', {
        sessionId: 'a-long',
        turnLimit: 26,
      });
      expect(over.isError).toBe(true);
      const viaRoute = await asTool(
        bearer('a-caller'),
        '/api/orchestration/session-activity/a-long/digest?turnLimit=26',
      );
      expect(viaRoute).toMatchObject({
        success: false,
        code: 'session_digest_limit_out_of_range',
      });
      // A cursor from another Session is refused, after scope is decided.
      const first = await tool(bearer('a-caller'), 'get_session_digest', {
        sessionId: 'a-long',
        turnLimit: 2,
      });
      const foreign = await tool(bearer('a-caller'), 'get_session_digest', {
        sessionId: 'a-peer',
        cursor: first.body.data.nextCursor,
      });
      expect(foreign).toMatchObject({
        isError: true,
        body: { code: 'session_digest_cursor_invalid' },
      });
      const probe = await tool(bearer('a-caller'), 'get_session_digest', {
        sessionId: 'a-other-project',
        cursor: first.body.data.nextCursor,
      });
      expect(probe.body).toMatchObject({ code: 'session_not_found' });
    });
  });

  describe('read_conversation aroundMessageId', () => {
    const textOf = (page: any) =>
      JSON.stringify(page.body.data.messages.map((m: any) => m.text));

    test('a search, then a read at the hit, reaches the matched message on the first page, with cursors both ways', async () => {
      const { tool } = await setup();
      for (const [phrase, marker, role] of [
        ['zephyrquartz', 'The zephyrquartz marker is here', 'user'],
        ['quasarmarker', 'Answer holding quasarmarker', 'assistant'],
      ] as const) {
        const found = await tool(bearer('a-caller'), 'search_sessions', {
          query: phrase,
        });
        expect(found.isError).toBe(false);
        const hit = found.body.data.results.find(
          (result: any) => result.sessionId === 'a-anchor',
        );
        expect(hit?.messageId).toEqual(expect.any(String));

        const page = await tool(bearer('a-caller'), 'read_conversation', {
          sessionId: hit.sessionId,
          aroundMessageId: hit.messageId,
          limit: 10,
        });
        expect(JSON.stringify(page.body).slice(0, 400)).toMatch(
          /"success":true/,
        );
        const messages = page.body.data.messages;
        // The matched message, on this first page, and with its neighbours.
        const matched = messages.find((m: any) => m.id === hit.messageId);
        expect([phrase, matched?.role, matched?.text]).toEqual([
          phrase,
          role,
          marker,
        ]);
        expect(messages.length).toBeLessThanOrEqual(10);
        expect(messages.length).toBeGreaterThan(1);
        expect(messages[0].id).not.toBe(hit.messageId);
        expect(page.body.data.prevCursor).toEqual(expect.any(String));
        expect(page.body.data.nextCursor).toEqual(expect.any(String));
        // The same read, from the start, would not have reached it on page one.
        const firstPage = await tool(bearer('a-caller'), 'read_conversation', {
          sessionId: 'a-anchor',
          limit: 10,
        });
        expect(textOf(firstPage)).not.toContain(marker);
      }
    });

    test('walking prevCursor and nextCursor from an anchor covers the transcript once, in order', async () => {
      const { tool } = await setup();
      const around = await tool(bearer('a-caller'), 'read_conversation', {
        sessionId: 'a-anchor',
        aroundMessageId: 'a-anchor-turn-17:start:user',
        limit: 7,
      });
      expect(JSON.stringify(around.body).slice(0, 400)).toMatch(
        /"success":true/,
      );
      const indexes = (page: any) =>
        page.body.data.messages.map((m: any) => m.index);
      const collected = new Map<number, string>();
      const record = (page: any) => {
        for (const message of page.body.data.messages)
          collected.set(message.index, message.id);
      };
      record(around);
      let backward = around;
      let steps = 0;
      while (backward.body.data.prevCursor && steps < 20) {
        backward = await tool(bearer('a-caller'), 'read_conversation', {
          sessionId: 'a-anchor',
          cursor: backward.body.data.prevCursor,
          limit: 7,
        });
        expect(backward.isError).toBe(false);
        // Each older page ends exactly where the last one began.
        record(backward);
        steps += 1;
      }
      let forward = around;
      while (forward.body.data.nextCursor && steps < 40) {
        forward = await tool(bearer('a-caller'), 'read_conversation', {
          sessionId: 'a-anchor',
          cursor: forward.body.data.nextCursor,
          limit: 7,
        });
        expect(forward.isError).toBe(false);
        record(forward);
        steps += 1;
      }
      expect([...collected.keys()].sort((a, b) => a - b)).toEqual(
        Array.from({ length: 60 }, (_, index) => index),
      );
      expect(new Set(collected.values()).size).toBe(60);
      // The anchor was the 33rd message (turn 17's user message).
      expect(indexes(around)).toContain(32);
      expect(backward.body.data.prevCursor).toBeNull();
      expect(forward.body.data.nextCursor).toBeNull();
    });

    test('a stale or foreign message id is refused, never answered with page one, and a cursor beside it is refused', async () => {
      const { tool, asTool } = await setup();
      const stale = await tool(bearer('a-caller'), 'read_conversation', {
        sessionId: 'a-anchor',
        aroundMessageId: 'a-anchor-turn-99:start:user',
      });
      expect(stale).toMatchObject({
        isError: true,
        body: { success: false, code: 'conversation_read_anchor_not_found' },
      });
      expect(stale.body.data).toBeUndefined();
      // A real message id, but of another conversation in the same Project.
      const foreign = await tool(bearer('a-caller'), 'read_conversation', {
        sessionId: 'a-anchor',
        aroundMessageId: 'a-peer-turn-1:start:user',
      });
      expect(foreign).toMatchObject({
        isError: true,
        body: { code: 'conversation_read_anchor_not_found' },
      });
      expect(JSON.stringify(foreign.body)).not.toContain('Fix the flaky');
      const both = await tool(bearer('a-caller'), 'read_conversation', {
        sessionId: 'a-anchor',
        aroundMessageId: 'a-anchor-turn-17:start:user',
        cursor: 'bm90LWEtY3Vyc29y',
      });
      expect(both).toMatchObject({
        isError: true,
        body: { code: 'conversation_read_anchor_with_cursor' },
      });
      const tooLong = await asTool(
        bearer('a-caller'),
        `/api/conversations/a-anchor/read?aroundMessageId=${'x'.repeat(513)}`,
      );
      expect(tooLong).toMatchObject({
        success: false,
        code: 'conversation_read_anchor_invalid',
      });
    });

    test('an anchor never widens what may be read: another Project and another owner are refused as before', async () => {
      const { tool } = await setup();
      const otherProject = await tool(bearer('a-caller'), 'read_conversation', {
        sessionId: 'a-other-project',
        aroundMessageId: 'a-other-project-turn-1:start:user',
      });
      expect(otherProject).toMatchObject({
        isError: true,
        body: { code: 'conversation_out_of_scope' },
      });
      const otherOwner = await tool(bearer('a-caller'), 'read_conversation', {
        sessionId: 'carol-p1',
        aroundMessageId: 'carol-p1-turn-1:start:user',
      });
      expect(otherOwner).toMatchObject({
        isError: true,
        body: { code: 'conversation_not_found' },
      });
      expect(JSON.stringify([otherProject.body, otherOwner.body])).not.toMatch(
        /OTHER-PROJECT-SECRET|CAROL-SECRET/,
      );
    });
  });

  describe('the tools in the catalog', () => {
    test('both are read-only and grouped with Chats', () => {
      const catalog = stationControlToolCatalog();
      for (const name of ['list_project_activity', 'get_session_digest']) {
        const entry = catalog.find((tool) => tool.name === name);
        expect([name, entry?.group, entry?.readOnly]).toEqual([
          name,
          'Chats',
          true,
        ]);
      }
    });
  });
});
