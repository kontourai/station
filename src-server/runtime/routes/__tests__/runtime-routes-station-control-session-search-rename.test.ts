/**
 * #176: `search_sessions` and `rename_session`, through the PRODUCTION
 * composition: `configureRuntimeRoutes` with the real runtime auth boundary,
 * the real station-control authority guard and caller re-derivation, the real
 * unified-search service over a real event store, and the real memory store.
 * Each tool call goes through the real station-control MCP server (its input
 * validation, its tool-side authority check, then HTTP into those routes) with
 * a really minted per-session token.
 *
 * People and sessions:
 *  - A: the Station operator (`a-agent`, searchable transcript `a-chat`);
 *  - C: Carol, a tailnet person. `carol-global` runs in no Project,
 *    `carol-p1` in Project `p1`; `carol-chat` is her searchable transcript;
 *  - D: Dave, another tailnet person (`dave-agent`, `dave-chat`).
 *
 * Callers are exactly the channels the product delivers a token through:
 * `sdk-in-process` is bound, `http-header-token` delegated-custody and
 * `url-token` bearer-exposed.
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

const OPERATOR_CREDENTIAL = 'test-only-operator-credential-session-search';
const A = LOCAL_OPERATOR_PRINCIPAL_ID;
const C = 'human:tailscale-serve:carol';
const D = 'human:tailscale-serve:dave';
const NOW = new Date().toISOString();
const makeTempDir = trackTempDirs();

type Caller = { session: string; channel: StationControlMcpTokenChannel };
const ASSURANCE = {
  'sdk-in-process': 'bound',
  'http-header-token': 'delegated-custody',
  'url-token': 'bearer-exposed',
} as const;
const OWNER: Record<string, string | undefined> = {
  'a-agent': A,
  'carol-global': C,
  'carol-p1': C,
  'dave-agent': D,
};

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

describe('station-control session search and rename (#176)', () => {
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
    const home = makeTempDir('station-control-session-search-');

    const storage = new FileStorageAdapter(home);
    const projects = new ProjectService(
      storage,
      new ProjectManifestStore(home, storage),
    );
    const p1 = await projects.createProject({ name: 'P1', slug: 'p1' });
    await projects.createProject({ name: 'P2', slug: 'p2' });

    const store = new EventStore(join(home, 'orchestration.sqlite'));
    // Agent sessions: the owner (and Project) of each is its start record.
    for (const [threadId, userId, project] of [
      ['a-agent', A, undefined],
      ['carol-global', C, undefined],
      ['carol-p1', C, p1],
      ['dave-agent', D, undefined],
    ] as const) {
      store.appendEvent({
        eventId: `${threadId}:start`,
        threadId,
        sessionId: threadId,
        provider: 'claude',
        method: 'session.started',
        createdAt: NOW,
        metadata: {
          userId,
          ...(project
            ? { projectSlug: project.slug, localProjectId: project.id }
            : {}),
        },
      });
    }
    // One searchable transcript per person, each with its own marker.
    for (const [threadId, userId, marker] of [
      ['a-chat', A, 'cobalt OPERATOR-MARKER'],
      ['carol-chat', C, 'cobalt CAROL-MARKER'],
      ['dave-chat', D, 'cobalt DAVE-MARKER'],
    ] as const) {
      store.upsertSession({
        threadId,
        provider: 'claude',
        status: 'closed',
        createdAt: NOW,
        updatedAt: NOW,
      });
      store.appendEvent({
        eventId: `${threadId}:start`,
        threadId,
        sessionId: threadId,
        provider: 'claude',
        method: 'session.started',
        createdAt: NOW,
        metadata: { userId, agentSlug: 'claude' },
      });
      store.appendEvent({
        eventId: `${threadId}:turn`,
        threadId,
        turnId: `${threadId}:turn`,
        provider: 'claude',
        method: 'turn.started',
        createdAt: NOW,
        prompt: marker,
      });
    }
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
    // A Task whose title matches the search phrase: the tool must not return
    // it, because it asks for session and message hits only.
    await taskGraph.createTask({
      projectId: p1.id,
      title: 'cobalt TASK-MARKER',
    });
    const runtimeSearch = createRuntimeSearch({
      stationId: '33333333-3333-4333-8333-333333333333',
      tasks: taskGraph,
      transcripts: orchestration,
    });
    closers.push(async () => {
      await runtimeSearch.close();
      try {
        await orchestration.shutdown();
      } catch (error) {
        // `shutdown` checks the transcript worker's phase right after its own
        // 100 ms close window. On a loaded host `worker.terminate()` outlasts
        // that window and the check reports the retirement as still pending
        // while the termination carries on. Only that exact report, with no
        // other cleanup failure alongside it, is tolerated; anything else
        // still fails the test. Tracked in #3266.
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

    // Store conversations, one title source each.
    const memory = new FileMemoryAdapter({ projectHomeDir: home });
    for (const [id, userId, metadata] of [
      ['carol-global-conv', C, { titleSource: 'prompt' }],
      ['carol-p1-conv', C, { titleSource: 'prompt', projectSlug: 'p1' }],
      ['carol-p2-conv', C, { titleSource: 'prompt', projectSlug: 'p2' }],
      ['carol-person-conv', C, { titleSource: 'user' }],
      ['dave-conv', D, { titleSource: 'prompt' }],
    ] as const) {
      await memory.createConversation({
        id,
        resourceId: 'default',
        userId,
        title: `${id} original`,
        metadata: { ...metadata },
      });
    }

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
      memoryAdapters: new Map([['default', memory]]),
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
    process.env.STATION_API_BASE = base;
    // The requests the tools send to Station's own routes. A refusal made by a
    // tool's own schema never sends one.
    const routeRequests: string[] = [];
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith(base) && /\/api\/(search|conversations)/.test(url))
        routeRequests.push(new URL(url).pathname);
      return realFetch(input, init);
    });

    // The real MCP server, over an in-memory transport.
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
      const verified: StationControlCaller | null = owner
        ? {
            sessionId: caller.session,
            assurance: ASSURANCE[caller.channel],
            principal: stationControlCallerPrincipal(owner, 'session-owner'),
          }
        : {
            sessionId: caller.session,
            assurance: ASSURANCE[caller.channel],
          };
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
      init?: RequestInit,
    ): Promise<any> {
      const { token } = mintStationControlMcpToken(
        caller.session,
        caller.channel,
      );
      return withStationControlCallerContext(
        { token, resolve: () => null },
        () => api(path, init),
      );
    }

    /** The person renaming in Station's UI: `PATCH`, which stamps `user`. */
    const personRenames = (id: string, title: string) =>
      fetch(`${base}/agents/station/conversations/${id}`, {
        method: 'PATCH',
        headers: {
          authorization: `Bearer ${OPERATOR_CREDENTIAL}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ title }),
      });

    const stored = async (id: string) => {
      const conversation = await memory.getConversation(id);
      return {
        title: conversation?.title,
        titleSource: (conversation?.metadata as any)?.titleSource,
      };
    };

    return { base, memory, tool, asTool, personRenames, stored, routeRequests };
  }

  const sessionIds = (body: any): string[] =>
    [
      ...new Set(
        ((body?.data?.results ?? []) as { sessionId: string }[]).map(
          (hit) => hit.sessionId,
        ),
      ),
    ].sort();

  describe('search_sessions', () => {
    test('returns only the calling session owner’s transcripts, never another person’s and never a Task', async () => {
      const { tool } = await setup();
      for (const caller of [
        bound('carol-global'),
        delegated('carol-global'),
        bearer('carol-global'),
      ]) {
        const found = await tool(caller, 'search_sessions', {
          query: 'cobalt',
        });
        expect(
          [caller.channel, found.isError, sessionIds(found.body)],
          `search_sessions ${caller.channel}: ${JSON.stringify(found.body)}`,
        ).toEqual([caller.channel, false, ['carol-chat']]);
        expect(JSON.stringify(found.body)).not.toMatch(
          /DAVE-MARKER|OPERATOR-MARKER|TASK-MARKER/,
        );
        // Every hit is a message hit, and says where it is.
        for (const hit of found.body.data.results) {
          expect(hit).toMatchObject({
            kind: 'message',
            sessionId: 'carol-chat',
          });
          expect(hit.snippet).toContain('CAROL-MARKER');
        }
      }
      // Another person sees only their own, and a bound operator only the
      // operator's: a bound caller is not widened to every transcript.
      expect(
        sessionIds(
          (
            await tool(bearer('dave-agent'), 'search_sessions', {
              query: 'cobalt',
            })
          ).body,
        ),
      ).toEqual(['dave-chat']);
      expect(
        sessionIds(
          (
            await tool(bound('a-agent'), 'search_sessions', {
              query: 'cobalt',
            })
          ).body,
        ),
      ).toEqual(['a-chat']);
    });

    test('a caller with no recorded owner and a bare token are refused as MCP errors', async () => {
      const { tool } = await setup();
      const noOwner = await tool(bound('no-record'), 'search_sessions', {
        query: 'cobalt',
      });
      expect(noOwner.isError).toBe(true);
      expect(noOwner.body).toMatchObject({
        success: false,
        code: 'station_control_role_required',
      });
      // The pooled child's bare token carries no caller: the guard refuses.
      const bare = await api('/api/search', {
        method: 'POST',
        body: JSON.stringify({
          version: 'station.unified-search/v1',
          query: 'cobalt',
        }),
      });
      expect(bare.code).toBe('station_control_caller_required');
    });

    test('the tool schema refuses a query of 1 or 257 characters itself, before any request is sent', async () => {
      const { tool, routeRequests } = await setup();
      for (const query of ['c', 'c'.repeat(257)]) {
        routeRequests.length = 0;
        const refused = await tool(bearer('carol-global'), 'search_sessions', {
          query,
        });
        expect([query.length, refused.isError]).toEqual([query.length, true]);
        expect(String(refused.body)).toMatch(/Input validation error/);
        expect([query.length, routeRequests]).toEqual([query.length, []]);
      }
      // The bounds themselves are admitted.
      for (const query of ['co', `cobalt${'x'.repeat(250)}`]) {
        expect(
          (await tool(bearer('carol-global'), 'search_sessions', { query }))
            .isError,
        ).toBe(false);
      }
    });

    test('the search route refuses a query of 1 or 257 characters itself, for a caller that skips the tool', async () => {
      const { asTool } = await setup();
      for (const query of ['c', 'c'.repeat(257)]) {
        const direct = await asTool(bearer('carol-global'), '/api/search', {
          method: 'POST',
          body: JSON.stringify({
            version: 'station.unified-search/v1',
            query,
            filters: { kinds: ['session', 'message'] },
          }),
        });
        // The route's own validation, not the search service's later refusal.
        expect([query.length, direct]).toMatchObject([
          query.length,
          { success: false, error: 'Validation failed' },
        ]);
      }
    });

    test('a continuation the tool did not issue is refused, and a well-formed one reaches the service', async () => {
      const { tool } = await setup();
      const forged = await tool(bearer('carol-global'), 'search_sessions', {
        query: 'cobalt',
        continuation: 'not-a-continuation',
      });
      expect(forged.isError).toBe(true);
      expect(forged.body).toMatchObject({ code: 'invalid_continuation' });
      // Well-formed but never issued: the service refuses it, and the tool
      // says the source could not answer instead of returning an empty list.
      const continuation = Buffer.from(
        JSON.stringify([{ providerId: 'station.messages', token: 'x' }]),
      ).toString('base64url');
      const stale = await tool(bearer('carol-global'), 'search_sessions', {
        query: 'cobalt',
        continuation,
      });
      expect(stale.isError).toBe(false);
      expect(stale.body.data.incompleteSources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: 'station.messages',
            reason: 'continuation-invalid',
          }),
        ]),
      );
    });
  });

  describe('rename_session', () => {
    test('an agent renames its owner’s conversation, stamps `agent`, and the next agent rename overwrites it', async () => {
      const { tool, stored } = await setup();
      const first = await tool(bearer('carol-global'), 'rename_session', {
        conversationId: 'carol-global-conv',
        title: 'First agent title',
      });
      expect(first).toMatchObject({
        isError: false,
        body: {
          success: true,
          data: {
            conversationId: 'carol-global-conv',
            title: 'First agent title',
            titleSource: 'agent',
          },
        },
      });
      expect(await stored('carol-global-conv')).toEqual({
        title: 'First agent title',
        titleSource: 'agent',
      });
      const second = await tool(bound('carol-global'), 'rename_session', {
        conversationId: 'carol-global-conv',
        title: 'Second agent title',
      });
      expect(second.isError).toBe(false);
      expect(await stored('carol-global-conv')).toEqual({
        title: 'Second agent title',
        titleSource: 'agent',
      });
    });

    test('a title a person set is refused with person_title and left unchanged', async () => {
      const { tool, stored } = await setup();
      for (const caller of [
        bound('carol-global'),
        delegated('carol-global'),
        bearer('carol-global'),
      ]) {
        const refused = await tool(caller, 'rename_session', {
          conversationId: 'carol-person-conv',
          title: 'Agent wants this',
        });
        expect([caller.channel, refused.isError, refused.body.code]).toEqual([
          caller.channel,
          true,
          'person_title',
        ]);
        expect(await stored('carol-person-conv')).toEqual({
          title: 'carol-person-conv original',
          titleSource: 'user',
        });
      }
    });

    test('a person’s rename after an agent rename wins, and the agent can no longer replace it', async () => {
      const { tool, stored, personRenames } = await setup();
      await tool(bearer('carol-global'), 'rename_session', {
        conversationId: 'carol-global-conv',
        title: 'Agent title',
      });
      expect(
        (await personRenames('carol-global-conv', 'Person title')).status,
      ).toBe(200);
      expect(await stored('carol-global-conv')).toEqual({
        title: 'Person title',
        titleSource: 'user',
      });
      const again = await tool(bearer('carol-global'), 'rename_session', {
        conversationId: 'carol-global-conv',
        title: 'Agent again',
      });
      expect(again).toMatchObject({
        isError: true,
        body: { code: 'person_title' },
      });
      expect(await stored('carol-global-conv')).toEqual({
        title: 'Person title',
        titleSource: 'user',
      });
    });

    test('a person’s rename that lands between the agent’s decision and its write is not overwritten', async () => {
      const { tool, stored, memory } = await setup();
      // The person's `PATCH` write is committed at the instant the agent's
      // rename reaches the store: after the route has read the conversation
      // and before the agent's write is applied.
      const update = memory.updateConversation.bind(memory);
      let raced = false;
      vi.spyOn(memory, 'updateConversation').mockImplementation(
        async (id, updates) => {
          if (!raced) {
            raced = true;
            await update(id, {
              title: 'Person title',
              metadata: { titleSource: 'user', projectSlug: undefined },
            });
          }
          return update(id, updates);
        },
      );
      const refused = await tool(bearer('carol-global'), 'rename_session', {
        conversationId: 'carol-global-conv',
        title: 'Agent title',
      });
      expect(raced).toBe(true);
      expect(refused).toMatchObject({
        isError: true,
        body: { code: 'person_title' },
      });
      expect((await stored('carol-global-conv')).title).toBe('Person title');
      expect((await stored('carol-global-conv')).titleSource).toBe('user');
    });

    // Over the bound, empty, a line or paragraph separator, a bidi override and
    // a zero-width space: each is refused by the tool schema and by the route.
    const REFUSED_TITLES: [string, string][] = [
      ['81 characters', 'x'.repeat(81)],
      ['81 multi-byte characters', 'あ'.repeat(81)],
      ['empty', ''],
      ['newline', 'a\nb'],
      ['line separator U+2028', 'a\u2028b'],
      ['paragraph separator U+2029', 'a\u2029b'],
      ['bidi override U+202E', 'a\u202Eb'],
      ['bidi isolate U+2066', 'a\u2066b'],
      ['zero-width space U+200B', 'a\u200Bb'],
      ['byte-order mark U+FEFF', 'a\uFEFFb'],
      ['trailing line separator', 'ab\u2028'],
    ];

    test.each(REFUSED_TITLES)(
      'the tool schema refuses a title with %s itself, before any request is sent',
      async (_label, title) => {
        const { tool, stored, routeRequests } = await setup();
        const original = await stored('carol-global-conv');
        const refused = await tool(bearer('carol-global'), 'rename_session', {
          conversationId: 'carol-global-conv',
          title,
        });
        expect(refused.isError).toBe(true);
        expect(String(refused.body)).toMatch(/Input validation error/);
        expect(routeRequests).toEqual([]);
        expect(await stored('carol-global-conv')).toEqual(original);
      },
    );

    test.each([...REFUSED_TITLES, ['only spaces', '   '] as [string, string]])(
      'the route refuses a title with %s itself, for a caller that skips the tool',
      async (_label, title) => {
        const { asTool, stored } = await setup();
        const original = await stored('carol-global-conv');
        const direct = await asTool(
          bearer('carol-global'),
          '/api/conversations/carol-global-conv/agent-title',
          { method: 'POST', body: JSON.stringify({ title }) },
        );
        expect(direct).toMatchObject({
          success: false,
          error: 'Validation failed',
        });
        expect(await stored('carol-global-conv')).toEqual(original);
      },
    );

    test('titles at the bound, and ones using joiners that build emoji and scripts, are accepted', async () => {
      const { tool, stored } = await setup();
      for (const title of [
        'あ'.repeat(80),
        // A family emoji is four emoji joined by U+200D.
        '👨\u200D👩\u200D👧\u200D👦 plans',
        // Persian uses U+200C (zero-width non-joiner) inside words.
        'می\u200Cخواهم',
      ]) {
        const accepted = await tool(bearer('carol-global'), 'rename_session', {
          conversationId: 'carol-global-conv',
          title,
        });
        expect([title, accepted.isError]).toEqual([title, false]);
        expect((await stored('carol-global-conv')).title).toBe(title);
      }
    });

    test('a native runtime conversation is refused with runtime_title_unsupported', async () => {
      const { tool } = await setup();
      const refused = await tool(bearer('carol-global'), 'rename_session', {
        conversationId: 'carol-chat',
        title: 'Runtime title',
      });
      expect(refused).toMatchObject({
        isError: true,
        body: { code: 'runtime_title_unsupported' },
      });
    });

    test('another person’s conversation reads as absent and is unchanged; a caller without an owner is refused', async () => {
      const { tool, stored } = await setup();
      const other = await tool(bearer('carol-global'), 'rename_session', {
        conversationId: 'dave-conv',
        title: 'Carol renames Dave',
      });
      expect(other).toMatchObject({
        isError: true,
        body: { success: false, error: 'Conversation not found' },
      });
      expect(await stored('dave-conv')).toEqual({
        title: 'dave-conv original',
        titleSource: 'prompt',
      });
      const unowned = await tool(bound('no-record'), 'rename_session', {
        conversationId: 'carol-global-conv',
        title: 'No owner',
      });
      expect(unowned).toMatchObject({
        isError: true,
        body: { code: 'station_control_role_required' },
      });
      expect((await stored('carol-global-conv')).title).toBe(
        'carol-global-conv original',
      );
    });

    test('a bound operator caller is not limited to one owner’s conversations, but still never replaces a person’s title', async () => {
      const { tool, stored } = await setup();
      // The operator's bound agent renames Dave's conversation (the
      // `delete_conversation` precedent); a delegated-custody operator is not
      // bound, so it is held to the owner check like everyone else.
      const renamed = await tool(bound('a-agent'), 'rename_session', {
        conversationId: 'dave-conv',
        title: 'Operator title',
      });
      expect(renamed).toMatchObject({
        isError: false,
        body: { success: true, data: { titleSource: 'agent' } },
      });
      expect(await stored('dave-conv')).toEqual({
        title: 'Operator title',
        titleSource: 'agent',
      });
      const notBound = await tool(delegated('a-agent'), 'rename_session', {
        conversationId: 'carol-global-conv',
        title: 'Delegated operator',
      });
      expect(notBound.isError).toBe(true);
      expect((await stored('carol-global-conv')).title).toBe(
        'carol-global-conv original',
      );
      const person = await tool(bound('a-agent'), 'rename_session', {
        conversationId: 'carol-person-conv',
        title: 'Operator wants this',
      });
      expect(person).toMatchObject({
        isError: true,
        body: { code: 'person_title' },
      });
    });

    test('a caller that is not bound stays in its own session’s Project scope; a bound caller keeps its owner’s reach', async () => {
      const { tool, stored } = await setup();
      const rename = (caller: Caller, conversationId: string) =>
        tool(caller, 'rename_session', { conversationId, title: 'Scoped' });
      // A global session reaches its owner's global conversation only.
      expect(
        (await rename(bearer('carol-global'), 'carol-global-conv')).isError,
      ).toBe(false);
      for (const target of ['carol-p1-conv', 'carol-p2-conv']) {
        const refused = await rename(bearer('carol-global'), target);
        expect([target, refused.isError, refused.body.code]).toEqual([
          target,
          true,
          'station_control_assurance_insufficient',
        ]);
        expect((await stored(target)).titleSource).toBe('prompt');
      }
      // A Project session reaches its own Project's conversation and no
      // other, global included.
      expect(
        (await rename(delegated('carol-p1'), 'carol-p1-conv')).isError,
      ).toBe(false);
      for (const target of ['carol-p2-conv', 'carol-person-conv']) {
        const refused = await rename(delegated('carol-p1'), target);
        expect([target, refused.isError, refused.body.code]).toEqual([
          target,
          true,
          'station_control_assurance_insufficient',
        ]);
      }
      expect((await stored('carol-p2-conv')).titleSource).toBe('prompt');
      // A bound caller acting for the same person is not confined to one
      // Project.
      expect(
        (await rename(bound('carol-global'), 'carol-p2-conv')).isError,
      ).toBe(false);
      expect((await stored('carol-p2-conv')).titleSource).toBe('agent');
    });

    test('only a station-control tool call reaches the leaf: a bare token and the operator’s own UI are refused and change nothing', async () => {
      const { base, stored } = await setup();
      const bare = await api(
        '/api/conversations/carol-global-conv/agent-title',
        { method: 'POST', body: JSON.stringify({ title: 'Bare token' }) },
      );
      expect(bare.code).toBe('station_control_caller_required');
      const ui = await fetch(
        `${base}/api/conversations/carol-global-conv/agent-title`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${OPERATOR_CREDENTIAL}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ title: 'From the UI' }),
        },
      );
      expect(ui.status).toBe(403);
      expect(((await ui.json()) as { code?: string }).code).toBe(
        'station_control_caller_required',
      );
      expect(await stored('carol-global-conv')).toEqual({
        title: 'carol-global-conv original',
        titleSource: 'prompt',
      });
    });
  });

  test('both tools are in the Chats group', () => {
    const groups = Object.fromEntries(
      stationControlToolCatalog().map((entry) => [entry.name, entry.group]),
    );
    expect(groups.search_sessions).toBe('Chats');
    expect(groups.rename_session).toBe('Chats');
  });
});
