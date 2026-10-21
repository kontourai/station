/**
 * station#3413 part B: `claim_work`, `renew_claim` and `release_claim`, and
 * the claims `list_project_activity` and the Station UI show, at the REAL
 * boundary: `configureRuntimeRoutes` with the real runtime auth boundary, the
 * real station-control guard, caller and scope derivation over REAL session
 * records (a real `EventStore` + `OrchestrationService`) and the real
 * station-control MCP server with really minted per-session tokens.
 *
 * Sessions (owner A, the Station operator, unless noted):
 *  - Project 1: `a-caller`, `a-peer`, `a-ended` (closed after it claims),
 *    `a-task` (dispatched for Task `task-1`), `a-host` (runs unconfined);
 *  - Project 2: `a-other`;
 *  - the global space: `g-caller`;
 *  - `u-caller`: a Project slug with no recorded Project id (unreadable);
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
import { composeActiveWorkClaimReader } from '../../../services/orchestration/work-claims.js';
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

const OPERATOR_CREDENTIAL = 'test-only-operator-credential-work-claims';
const A = LOCAL_OPERATOR_PRINCIPAL_ID;
const CAROL = 'human:tailscale-serve:carol';
const makeTempDir = trackTempDirs();
const BASE_TIME = Date.parse('2026-10-21T10:00:00.000Z');

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
const CALLER_KINDS = [bound, delegated, bearer];

const OWNER: Record<string, string> = {
  'a-caller': A,
  'a-peer': A,
  'a-ended': A,
  'a-task': A,
  'a-host': A,
  'a-other': A,
  'g-caller': A,
  'u-caller': A,
  'x-move': A,
  'carol-p1': CAROL,
};

describe('station-control work claims (#3413 B)', () => {
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
    const home = makeTempDir('station-control-work-claims-');
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
      metadata: Record<string, unknown> = {},
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
          ...metadata,
        },
      } as never);
      store.upsertSession({
        threadId,
        provider: 'codex',
        status: 'ready',
        createdAt: at(),
        updatedAt: at(),
      } as never);
    };

    startSession('a-caller', A, p1);
    startSession('a-peer', A, p1);
    startSession('a-ended', A, p1);
    startSession('a-task', A, p1);
    startSession('a-host', A, p1, { stationConfinement: 'host' });
    startSession('a-other', A, p2);
    startSession('g-caller', A, undefined);
    startSession('u-caller', A, undefined, { projectSlug: 'project-1' });
    startSession('carol-p1', CAROL, p1);
    // `a-task` was dispatched for Task `task-1` of Project 1: the immutable
    // binding dispatch records (`bindProjectTaskRoomExecution`).
    expect(
      (
        await store.bindProjectTaskRoomExecution({
          projectId: p1.id,
          taskId: 'task-1',
          sessionId: 'a-task',
        })
      ).kind,
    ).toBe('bound');

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
      stationId: '55555555-5555-4555-8555-555555555555',
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
    async function asTool(
      caller: Caller,
      path: string,
      body?: unknown,
    ): Promise<any> {
      const { token } = mintStationControlMcpToken(
        caller.session,
        caller.channel,
      );
      return withStationControlCallerContext(
        { token, resolve: () => null },
        () =>
          api(
            path,
            body === undefined
              ? undefined
              : { method: 'POST', body: JSON.stringify(body) },
          ),
      );
    }

    /** A request with only the internal credential (a raw token, a pooled child). */
    async function rawRequest(
      method: 'GET' | 'POST',
      path: string,
      extra: Record<string, string> = {},
    ) {
      const response = await realFetch(`${base}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
          [INTERNAL_PROXY_CALLER_HEADER]: 'local',
          ...extra,
        },
        ...(method === 'POST'
          ? { body: JSON.stringify({ workItemRef: '#raw' }) }
          : {}),
      });
      return { status: response.status, body: (await response.json()) as any };
    }

    /** The Station UI's read, as the operator. */
    async function uiClaims() {
      const response = await realFetch(
        `${base}/api/orchestration/work-claims`,
        {
          headers: { authorization: `Bearer ${OPERATOR_CREDENTIAL}` },
        },
      );
      return { status: response.status, body: (await response.json()) as any };
    }

    return {
      store,
      startSession,
      orchestration,
      tool,
      asTool,
      rawRequest,
      uiClaims,
      at,
      p1,
      p2,
    };
  }

  type Setup = Awaited<ReturnType<typeof setup>>;

  /** What each listed Session claims, by Session: `[sessionId, refs]`. */
  async function claimsListedTo(
    tool: Setup['tool'],
    caller: Caller,
  ): Promise<Record<string, string[]>> {
    const listed = await tool(caller, 'list_project_activity', {});
    expect(listed.isError).toBe(false);
    const out: Record<string, string[]> = {};
    for (const row of listed.body.data.sessions as any[])
      if (row.claims)
        out[row.sessionId] = (row.claims as any[]).map(
          (claim) => claim.workItemRef ?? claim.paths.join(','),
        );
    return out;
  }

  async function claim(
    tool: Setup['tool'],
    caller: Caller,
    args: Record<string, unknown>,
  ) {
    const made = await tool(caller, 'claim_work', args);
    expect([caller.session, made.isError, made.body?.success]).toEqual([
      caller.session,
      false,
      true,
    ]);
    return made.body.data.claim as {
      claimId: string;
      sessionId: string;
      scope: unknown;
      taskId?: string;
      expiresAt: string;
    };
  }

  describe('claim_work and list_project_activity', () => {
    test('every caller kind claims as its own Session; same-Project peers see it, another Project, the global space and another person do not', async () => {
      const { tool, p1 } = await setup();
      for (const [index, kind] of CALLER_KINDS.entries()) {
        const made = await claim(tool, kind('a-caller'), {
          workItemRef: `kontourai/station#${index + 1}`,
          note: `kind ${index}`,
        });
        expect(made).toMatchObject({
          sessionId: 'a-caller',
          scope: { kind: 'project', id: p1.id },
        });
      }
      const refs = [
        'kontourai/station#1',
        'kontourai/station#2',
        'kontourai/station#3',
      ];
      for (const kind of CALLER_KINDS) {
        // Its own row and a same-Project peer's view, at every assurance.
        expect(
          (await claimsListedTo(tool, kind('a-caller')))['a-caller']?.sort(),
        ).toEqual(refs);
        expect(
          (await claimsListedTo(tool, kind('a-peer')))['a-caller']?.sort(),
        ).toEqual(refs);
        // Absent, not hidden, to every other scope and owner.
        for (const other of ['a-other', 'g-caller', 'carol-p1', 'u-caller']) {
          const listed = await tool(kind(other), 'list_project_activity', {});
          expect([
            other,
            JSON.stringify(listed.body).includes('kontourai/station#'),
          ]).toEqual([other, false]);
        }
      }
    });

    test('claims made in another Project or the global space never reach a Project 1 caller', async () => {
      const { tool, p2 } = await setup();
      const other = await claim(tool, bound('a-other'), {
        workItemRef: 'OTHER-PROJECT-CLAIM',
      });
      expect(other.scope).toEqual({ kind: 'project', id: p2.id });
      const global = await claim(tool, bound('g-caller'), {
        workItemRef: 'GLOBAL-CLAIM',
      });
      expect(global.scope).toEqual({ kind: 'global' });
      for (const kind of CALLER_KINDS) {
        const listed = await tool(
          kind('a-caller'),
          'list_project_activity',
          {},
        );
        const text = JSON.stringify(listed.body);
        expect([
          text.includes('OTHER-PROJECT-CLAIM'),
          text.includes('GLOBAL-CLAIM'),
        ]).toEqual([false, false]);
      }
      // Each sees its own, in its own scope.
      expect((await claimsListedTo(tool, bound('a-other')))['a-other']).toEqual(
        ['OTHER-PROJECT-CLAIM'],
      );
      expect(
        (await claimsListedTo(tool, bound('g-caller')))['g-caller'],
      ).toEqual(['GLOBAL-CLAIM']);
    });

    test('a conversation that continued in another Project does not carry its old Project’s claims there', async () => {
      const { tool, store, startSession, at, p1, p2 } = await setup();
      // `x-move` ran in Project 2; its conversation continued in
      // `x-move-next`, a Session in Project 1 (the handoff writer the runtime
      // uses, then the successor's start record).
      startSession('x-move', A, p2);
      store.reserveConversationHandoff({
        conversationId: 'x-move',
        predecessorSessionId: 'x-move',
        sessionId: 'x-move-next',
        idempotencyKey: 'x-move-switch',
        messageDigest: 'x-move-digest',
        targetAgentId: 'codex-agent',
        targetEnvironmentId: 'this-station',
        createdAt: at(),
      });
      startSession('x-move-next', A, p1);
      const moved = await claim(tool, bound('x-move'), {
        workItemRef: 'MOVED-PROJECT-2-CLAIM',
      });
      expect(moved).toMatchObject({
        conversationId: 'x-move',
        scope: { kind: 'project', id: p2.id },
      });
      for (const kind of CALLER_KINDS) {
        const listed = await tool(
          kind('a-caller'),
          'list_project_activity',
          {},
        );
        const rows = listed.body.data.sessions as any[];
        // The conversation's Project 1 Session is listed, without the claim
        // its Project 2 Session made.
        expect([
          kind('a-caller').channel,
          rows.some((row) => row.sessionId === 'x-move-next'),
          JSON.stringify(rows).includes('MOVED-PROJECT-2-CLAIM'),
        ]).toEqual([kind('a-caller').channel, true, false]);
      }
    });

    test('a claim names paths, a work item, or both; a claim naming neither, or another Session, is an MCP error', async () => {
      const { tool, asTool } = await setup();
      const paths = await claim(tool, delegated('a-caller'), {
        paths: ['src/a.ts', 'src/a.ts', 'docs/'],
        note: 'touching the store',
      });
      expect(paths).toMatchObject({ paths: ['src/a.ts', 'docs/'] });
      expect((await claimsListedTo(tool, bound('a-peer')))['a-caller']).toEqual(
        ['src/a.ts,docs/'],
      );

      const neither = await tool(bound('a-caller'), 'claim_work', {
        note: 'x',
      });
      expect([neither.isError, neither.body.code]).toEqual([
        true,
        'work_claim_subject_required',
      ]);
      // The tool's strict schema refuses another Session's id before any request…
      for (const field of ['sessionId', 'conversationId', 'projectId']) {
        const named = await tool(bound('a-caller'), 'claim_work', {
          workItemRef: '#1',
          [field]: 'a-peer',
        });
        expect([field, named.isError]).toEqual([field, true]);
      }
      // …and the route refuses it from a caller that skips the schema.
      const skipped = await asTool(
        bound('a-caller'),
        '/api/orchestration/work-claims',
        {
          workItemRef: '#1',
          sessionId: 'a-peer',
        },
      );
      expect([skipped.success, skipped.code]).toEqual([
        false,
        'invalid_request',
      ]);
      // Bounds are refusals, never cuts.
      const longTtl = await tool(bound('a-caller'), 'claim_work', {
        workItemRef: '#1',
        ttlSeconds: 4 * 60 * 60 + 1,
      });
      expect(longTtl.isError).toBe(true);
      const routeTtl = await asTool(
        bound('a-caller'),
        '/api/orchestration/work-claims',
        {
          workItemRef: '#1',
          ttlSeconds: 4 * 60 * 60 + 1,
        },
      );
      expect([routeTtl.success, routeTtl.code]).toEqual([
        false,
        'invalid_request',
      ]);
      const manyPaths = await asTool(
        bound('a-caller'),
        '/api/orchestration/work-claims',
        {
          paths: Array.from({ length: 21 }, (_, index) => `p${index}`),
        },
      );
      expect(manyPaths.code).toBe('work_claim_too_many_paths');
      // Nothing refused was recorded.
      expect(
        (await claimsListedTo(tool, bound('a-caller')))['a-caller'],
      ).toEqual(['src/a.ts,docs/']);
    });

    test('a caller whose Project cannot be confirmed claims nothing; an unconfined Session is held to the scope rule', async () => {
      const { tool } = await setup();
      // A bound operator passes the scope rule and is refused for the scope it
      // cannot confirm; a scoped caller is already out of scope.
      for (const kind of CALLER_KINDS) {
        const refused = await tool(kind('u-caller'), 'claim_work', {
          workItemRef: '#1',
        });
        const channel = kind('u-caller').channel;
        expect([channel, refused.isError, refused.body.code]).toEqual([
          channel,
          true,
          channel === 'sdk-in-process'
            ? 'work_claim_scope_unreadable'
            : 'station_control_out_of_scope',
        ]);
      }
      expect(await claimsListedTo(tool, bound('u-caller'))).toEqual({});
      // A scoped caller in a Session that runs `host` is out of scope; a
      // bound operator keeps the operator's reach, as for every
      // session-aimed call.
      const scoped = await tool(delegated('a-host'), 'claim_work', {
        workItemRef: '#1',
      });
      expect([scoped.isError, scoped.body.code]).toEqual([
        true,
        'station_control_out_of_scope',
      ]);
      const operator = await tool(bound('a-host'), 'claim_work', {
        workItemRef: '#1',
      });
      expect(operator.isError).toBe(false);
    });

    test('a raw token and a pooled child carry no caller: every claim leaf refuses and records nothing', async () => {
      const { rawRequest, tool } = await setup();
      const extras: Record<string, string>[] = [
        {},
        { 'x-station-control-caller-binding': 'a'.repeat(43) },
      ];
      for (const extra of extras)
        for (const path of [
          '/api/orchestration/work-claims',
          '/api/orchestration/work-claims/claim_x/renew',
          '/api/orchestration/work-claims/claim_x/release',
        ]) {
          const answer = await rawRequest('POST', path, extra);
          expect([path, answer.status, answer.body.code]).toEqual([
            path,
            403,
            expect.stringMatching(/^station_control_/),
          ]);
        }
      expect(await claimsListedTo(tool, bound('a-caller'))).toEqual({});
    });
  });

  describe('renew_claim and release_claim', () => {
    test('only the claimant renews or releases; another Session’s claim id reads as not found, at every assurance', async () => {
      const { tool } = await setup();
      const made = await claim(tool, bound('a-caller'), {
        workItemRef: '#7',
        ttlSeconds: 600,
      });
      for (const kind of CALLER_KINDS)
        for (const other of ['a-peer', 'a-other', 'g-caller', 'carol-p1']) {
          for (const name of ['renew_claim', 'release_claim']) {
            const answer = await tool(kind(other), name, {
              claimId: made.claimId,
            });
            expect([other, name, answer.isError, answer.body.code]).toEqual([
              other,
              name,
              true,
              'claim_not_found',
            ]);
            expect(JSON.stringify(answer.body)).not.toContain('#7');
          }
        }
      expect((await claimsListedTo(tool, bound('a-peer')))['a-caller']).toEqual(
        ['#7'],
      );
      const renewed = await tool(bearer('a-caller'), 'renew_claim', {
        claimId: made.claimId,
        ttlSeconds: 3600,
      });
      expect(renewed.isError).toBe(false);
      expect(
        Date.parse(renewed.body.data.claim.expiresAt) >
          Date.parse(made.expiresAt),
      ).toBe(true);
      const released = await tool(delegated('a-caller'), 'release_claim', {
        claimId: made.claimId,
        note: 'done; PR is up',
      });
      expect(released.body.data.claim).toMatchObject({
        releaseNote: 'done; PR is up',
        releasedAt: expect.any(String),
      });
      expect(await claimsListedTo(tool, bound('a-peer'))).toEqual({});
      // Released is final: a renewal or a second release is refused.
      for (const name of ['renew_claim', 'release_claim']) {
        const again = await tool(bound('a-caller'), name, {
          claimId: made.claimId,
        });
        expect([name, again.isError, again.body.code]).toEqual([
          name,
          true,
          'claim_not_active',
        ]);
      }
    });

    test('a claim expires at its TTL: it stops showing and a renewal is refused; a renewal before then keeps it', async () => {
      const { tool } = await setup();
      const realNow = Date.now.bind(Date);
      let offset = 0;
      vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
      const short = await claim(tool, bound('a-caller'), {
        workItemRef: '#short',
        ttlSeconds: 60,
      });
      const kept = await claim(tool, bound('a-caller'), {
        workItemRef: '#kept',
        ttlSeconds: 60,
      });
      offset = 50_000;
      expect(
        (
          await tool(bound('a-caller'), 'renew_claim', {
            claimId: kept.claimId,
            ttlSeconds: 120,
          })
        ).isError,
      ).toBe(false);
      offset = 61_000;
      expect((await claimsListedTo(tool, bound('a-peer')))['a-caller']).toEqual(
        ['#kept'],
      );
      const late = await tool(bound('a-caller'), 'renew_claim', {
        claimId: short.claimId,
      });
      expect([late.isError, late.body.code]).toEqual([
        true,
        'claim_not_active',
      ]);
      offset = 171_000;
      expect(await claimsListedTo(tool, bound('a-peer'))).toEqual({});
    });
  });

  describe('Session end, Task scope and the UI read', () => {
    test('a claim from a Session that has ended no longer shows as active, in the list, the read API or the UI', async () => {
      const { tool, store, orchestration, p1, uiClaims, at } = await setup();
      await claim(tool, bound('a-ended'), { workItemRef: '#ended' });
      await claim(tool, bound('a-peer'), { workItemRef: '#live' });
      const reader = composeActiveWorkClaimReader({
        store: store.createWorkClaimStore({ maxActivePerClaimant: 10 }),
        orchestrationService: orchestration,
      });
      const refs = async () =>
        (await reader.listActiveClaims({ projectId: p1.id }))
          .map((claim) => claim.workItemRef)
          .sort();
      expect(await refs()).toEqual(['#ended', '#live']);
      expect(
        (await claimsListedTo(tool, bound('a-caller')))['a-ended'],
      ).toEqual(['#ended']);
      // The Session closes.
      store.upsertSession({
        threadId: 'a-ended',
        provider: 'codex',
        status: 'closed',
        createdAt: at(),
        updatedAt: at(),
      } as never);
      expect(await refs()).toEqual(['#live']);
      expect(await claimsListedTo(tool, bound('a-caller'))).toEqual({
        'a-peer': ['#live'],
      });
      const ui = await uiClaims();
      expect([
        ui.status,
        (ui.body.data.claims as any[]).map((claim) => claim.workItemRef),
      ]).toEqual([200, ['#live']]);
    });

    test('a Session dispatched for a Task carries its taskId, and listActiveClaims answers by Task', async () => {
      const { tool, store, orchestration, p1, p2 } = await setup();
      const onTask = await claim(tool, delegated('a-task'), {
        workItemRef: 'kontourai/station#4003',
      });
      expect(onTask.taskId).toBe('task-1');
      const free = await claim(tool, delegated('a-caller'), {
        workItemRef: '#free',
      });
      expect(free.taskId).toBeUndefined();
      const listed = await tool(bound('a-peer'), 'list_project_activity', {});
      const row = (listed.body.data.sessions as any[]).find(
        (entry) => entry.sessionId === 'a-task',
      );
      expect(row.claims).toEqual([
        expect.objectContaining({
          workItemRef: 'kontourai/station#4003',
          taskId: 'task-1',
        }),
      ]);
      const reader = composeActiveWorkClaimReader({
        store: store.createWorkClaimStore({ maxActivePerClaimant: 10 }),
        orchestrationService: orchestration,
      });
      expect(
        (
          await reader.listActiveClaims({ projectId: p1.id, taskId: 'task-1' })
        ).map((claim) => [claim.sessionId, claim.taskId]),
      ).toEqual([['a-task', 'task-1']]);
      expect(
        await reader.listActiveClaims({ projectId: p2.id, taskId: 'task-1' }),
      ).toEqual([]);
    });

    test("other people's and unknown Sessions' claims never push a person's UI read past its bound (review F7)", async () => {
      const { tool, store, p1, uiClaims } = await setup();
      await claim(tool, bound('a-caller'), { workItemRef: '#mine' });
      // More than WORK_CLAIM_LIST_MAX (500) unexpired claims this person may
      // not see: another person's live Session, and a Session Station has no
      // record of.
      const raw = store.createWorkClaimStore({ maxActivePerClaimant: 1000 });
      for (const sessionId of ['carol-p1', 'session-nobody-knows'])
        for (let i = 0; i < 501; i += 1)
          expect(
            raw.claim({
              claimant: { sessionId },
              scope: { kind: 'project', id: p1.id },
              workItemRef: `#${sessionId}-${i}`,
              paths: [],
              ttlSeconds: 600,
            }).kind,
          ).toBe('claimed');
      const ui = await uiClaims();
      expect([
        ui.status,
        (ui.body.data?.claims as any[] | undefined)?.map(
          (claim) => claim.workItemRef,
        ),
      ]).toEqual([200, ['#mine']]);
    });

    test('the UI read answers a person with the claims of Sessions they may read, and no agent', async () => {
      const { tool, uiClaims, asTool, rawRequest } = await setup();
      await claim(tool, bound('a-caller'), { workItemRef: '#mine' });
      await claim(tool, bound('carol-p1'), { workItemRef: '#carol' });
      const ui = await uiClaims();
      expect([
        ui.status,
        (ui.body.data.claims as any[]).map((claim) => claim.workItemRef),
      ]).toEqual([200, ['#mine']]);
      // A tool cannot reach it: the guard names no tool for the leaf.
      const fromTool = await asTool(
        bound('a-caller'),
        '/api/orchestration/work-claims',
      );
      expect(fromTool.code).toBe('station_control_route_unmapped');
      const raw = await rawRequest('GET', '/api/orchestration/work-claims', {
        'x-station-control-caller-binding': 'a'.repeat(43),
      });
      expect(raw.status).toBe(403);
    });
  });

  test('the tools are in the catalog with Chats, and none is read-only', () => {
    const catalog = stationControlToolCatalog();
    for (const name of ['claim_work', 'renew_claim', 'release_claim']) {
      const entry = catalog.find((tool) => tool.name === name);
      expect([name, entry?.group, entry?.readOnly]).toEqual([
        name,
        'Chats',
        false,
      ]);
    }
  });
});
