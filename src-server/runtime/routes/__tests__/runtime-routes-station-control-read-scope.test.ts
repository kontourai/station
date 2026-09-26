/**
 * #2377 slice B (decision 2) through the PRODUCTION composition:
 * `configureRuntimeRoutes` with the real runtime auth boundary, the real
 * station-control authority guard, the real caller re-derivation over REAL
 * session records (a real `EventStore` + `OrchestrationService`: each
 * session's owner is its `session.started` record), and the real read routes
 * and stores behind them — the memory store's conversations, the board, the
 * Project membership store, the server log store and the monitoring event
 * log. Requests are made the way a station-control tool makes them (`api()`
 * inside the tool's caller context, carrying a really minted per-session
 * token), so the principal stamp is the one the auth boundary really binds.
 *
 * Principals:
 *  - A: the Station operator (`human:local:operator`);
 *  - B: another person, a deployment account (its own requests are admitted
 *    to Projects by membership), owner of `b-project`;
 *  - C: another person who is not an account (a tailnet identity), whose own
 *    requests see every Project on a personal Station.
 *
 * Callers: bound (in-process), delegated-custody (ACP header token) and
 * bearer-exposed (Codex URL token) callers for B's session; a bound operator;
 * a delegated-custody operator; a caller whose session records no owner; the
 * raw internal token (what a pooled child reaches REST with: no caller). The
 * operator's own UI (an operator credential, never `kind:'internal'`) is the
 * control that must not move.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { awaitSessionAttachmentSettled } from '../../../__test-utils__/session-runtime-barriers.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { FileMemoryAdapter } from '../../../adapters/file/memory-adapter.js';
import { FileStorageAdapter } from '../../../domain/file-storage-adapter.js';
import { KnowledgeStoreProvider } from '../../../knowledge-store/knowledge-store-provider.js';
import { UI_NAVIGATE_AUDIENCE_FIELD } from '../../../routes/projects/ui-commands.js';
import { deploymentAccountPrincipal } from '../../../services/identity/deployment-authentication-service.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../../services/identity/principal-resolver.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
import { PluginVisibilityService } from '../../../services/plugins/plugin-visibility-service.js';
import { ProjectManifestStore } from '../../../services/projects/project-manifest-store.js';
import { createProjectMembershipRuntime } from '../../../services/projects/project-membership-runtime.js';
import { ProjectService } from '../../../services/projects/project-service.js';
import { TaskGraphService } from '../../../services/projects/task-graph-service.js';
import {
  __resetStationControlStdioCallerCredentialForTests,
  api,
  withStationControlCallerContext,
} from '../../../tools/station-control-shared.js';
import { __resetStationServerSelfAttestationForTests } from '../../../utils/internal-api-token.js';
import { RuntimeEventLog } from '../../conversation/runtime-event-log.js';
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

const OPERATOR_CREDENTIAL = 'test-only-operator-credential-read-scope';
const A = LOCAL_OPERATOR_PRINCIPAL_ID;
const B_REF = deploymentAccountPrincipal(
  'https://id.example.test',
  'bob',
  'Bob',
);
const B = B_REF.id;
const C = 'human:tailscale-serve:carol';
const LOG_SECRET = 'sk-live-abcdefghijklmnopqrstuvwxyz01';
const NOW = new Date().toISOString();
const TODAY = NOW.slice(0, 10);
const makeTempDir = trackTempDirs();

describe('configureRuntimeRoutes: station-control reads act for the calling session’s owner', () => {
  const closers: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    __resetStationControlMcpTokensForTests();
    __resetStationControlStdioCallerCredentialForTests();
    delete process.env.STATION_API_BASE;
    for (const close of closers.splice(0)) await close();
  });

  async function setup() {
    __resetStationServerSelfAttestationForTests();
    const home = makeTempDir('station-control-read-scope-');

    // Real session records: each session's owner is its start record.
    const store = new EventStore(join(home, 'orchestration.sqlite'));
    for (const [threadId, userId] of [
      ['a-agent', A],
      ['a-chat', A],
      ['b-agent', B],
      ['b-chat', B],
      ['c-agent', C],
    ] as const) {
      store.appendEvent({
        eventId: `${threadId}:start`,
        threadId,
        sessionId: threadId,
        provider: 'claude',
        method: 'session.started',
        createdAt: NOW,
        metadata: { userId },
      });
    }
    // One answered turn in each person's chat, so a Basis read has a real
    // answer to find.
    for (const threadId of ['a-chat', 'b-chat']) {
      store.upsertSession({
        threadId,
        provider: 'claude',
        status: 'closed',
        createdAt: NOW,
        updatedAt: NOW,
      });
      store.appendEvent({
        eventId: `${threadId}:turn-start`,
        threadId,
        turnId: `${threadId}-turn`,
        provider: 'claude',
        method: 'turn.started',
        createdAt: NOW,
        prompt: 'question',
      });
      store.appendEvent({
        eventId: `${threadId}:turn-done`,
        threadId,
        turnId: `${threadId}-turn`,
        provider: 'claude',
        method: 'turn.completed',
        createdAt: NOW,
        finishReason: 'stop',
        outputText: 'An exact public answer.',
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
    closers.push(async () => {
      await orchestration.shutdown();
      await expect.poll(() => store.close().kind).toBe('closed');
    });
    await awaitSessionAttachmentSettled(orchestration);

    // Projects: A's private Project, and B's shared one (B owns it).
    const storage = new FileStorageAdapter(home);
    const projects = new ProjectService(
      storage,
      new ProjectManifestStore(home, storage),
    );
    const aProject = await projects.createProject({
      name: 'A private',
      slug: 'a-project',
    });
    const bProject = await projects.createProject({
      name: 'B shared',
      slug: 'b-project',
    });
    const membership = createProjectMembershipRuntime(
      home,
      'environment-local',
      storage,
    );
    closers.push(() => membership.close());
    await membership.service.enable('b-project', bProject.id, {
      current: async () => ({ principal: B_REF, verifiedEmails: [] }),
      operator: async () => {},
    });
    const taskGraph = new TaskGraphService(home, {
      projectService: {
        getProject: (slug: string) =>
          slug === bProject.slug || slug === bProject.id ? bProject : aProject,
      },
    });
    const aTask = await taskGraph.createTask({
      projectId: aProject.id,
      title: 'A task',
    });
    const bTask = await taskGraph.createTask({
      projectId: bProject.id,
      title: 'B task',
    });

    // The memory store's conversations, one per person.
    const memory = new FileMemoryAdapter({ projectHomeDir: home });
    for (const [id, userId, text] of [
      ['a-conv', A, 'A-PRIVATE-TRANSCRIPT'],
      ['b-conv', B, 'B-OWN-TRANSCRIPT'],
    ] as const) {
      await memory.createConversation({
        id,
        resourceId: 'default',
        userId,
        title: `${id} title`,
        metadata: {},
      });
      await memory.addMessage(
        { id: `${id}-m1`, role: 'user', parts: [{ type: 'text', text }] },
        'agent:default',
        id,
      );
    }

    // The server log store, with a secret-named field.
    const logs = join(home, 'logs', 'server');
    mkdirSync(logs, { recursive: true });
    writeFileSync(
      join(logs, `server-${TODAY}.ndjson`),
      `${JSON.stringify({
        level: 'info',
        timestamp: NOW,
        msg: 'config loaded',
        pid: 1,
        config: { apiKey: LOG_SECRET },
      })}\n`,
    );

    // The monitoring event log: one row per person.
    const eventLogPath = join(home, 'monitoring');
    mkdirSync(eventLogPath, { recursive: true });
    writeFileSync(
      join(eventLogPath, `events-${TODAY}.ndjson`),
      `${[A, B]
        .map((userId) =>
          JSON.stringify({
            timestamp: NOW,
            'timestamp.ms': Date.parse(NOW),
            'span.kind': 'log',
            userId,
          }),
        )
        .join('\n')}\n`,
    );
    const eventLog = new RuntimeEventLog(eventLogPath, {
      debug() {},
      info() {},
      warn() {},
      error() {},
    } as never);

    // Installed plugins: B has been granted sight of one of them.
    for (const name of ['alpha-plugin', 'beta-plugin']) {
      const dir = join(home, 'plugins', name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'plugin.json'),
        JSON.stringify({ name, version: '1.0.0', displayName: name }),
      );
    }
    await new PluginVisibilityService(home).grant(B, 'beta-plugin');

    // Knowledge roots: A's Project, B's Project and the personal store, each
    // with one record, all in the one Station-wide index.
    const knowledge = new KnowledgeStoreProvider(new FileStorageAdapter(home));
    for (const [scope, marker] of [
      [{ kind: 'project', projectSlug: 'a-project' }, 'A-PROJECT-NOTE'],
      [{ kind: 'project', projectSlug: 'b-project' }, 'B-PROJECT-NOTE'],
      [{ kind: 'personal' }, 'OPERATOR-PERSONAL-NOTE'],
    ] as const) {
      const storeRoot = join(home, 'knowledge', marker);
      mkdirSync(storeRoot, { recursive: true });
      const root = await knowledge.createRoot({
        scope,
        adapterId: 'kit-default-store',
        storeRoot,
        displayName: marker,
      });
      await (await knowledge.adapterFor(root.id)).create({
        type: 'raw',
        title: marker,
        body: `${marker} knowledge body`,
        category: 'reference',
        provenance: { agent: 'read-scope-test' },
      });
    }

    const eventBus = new EventBus();
    const app = new Hono();
    const context = deepStub({
      projectMembership: membership.service,
      projectSharedTasks: membership.sharedTasks,
      deploymentAuthentication: undefined,
      localAccounts: undefined,
      applicationSessions: undefined,
      app,
      port: 4321,
      appConfig: {},
      eventBus,
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
      knowledgeStoreProvider: knowledge,
      resolveEmbeddingProvider: () => ({
        id: 'stub-embedder',
        displayName: 'Stub embedder',
        dimensions: () => 4,
        embed: async (texts: string[]) => texts.map(() => [1, 0, 0, 0]),
      }),
      metricsLog: [],
      monitoringEvents: [],
      queryEventsFromDisk: (start: number, end: number, userId: string) =>
        eventLog.queryEvents(start, end, userId),
      orchestrationEventStore: store,
      orchestrationService: orchestration,
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
    return { base, eventBus, memory, aProject, bProject, aTask, bTask };
  }

  type Caller =
    | { session: string; channel: StationControlMcpTokenChannel }
    | 'raw-token';

  /** A request exactly as a station-control tool makes it. */
  async function asTool(
    caller: Caller,
    path: string,
    init?: RequestInit,
  ): Promise<any> {
    if (caller === 'raw-token') return api(path, init);
    const token = mintStationControlMcpToken(
      caller.session,
      caller.channel,
    ).token;
    return withStationControlCallerContext({ token, resolve: () => null }, () =>
      api(path, init),
    );
  }

  const B_CALLERS: Record<string, Caller> = {
    'bound B': { session: 'b-agent', channel: 'sdk-in-process' },
    'delegated-custody B': { session: 'b-agent', channel: 'http-header-token' },
    'bearer-exposed B': { session: 'b-agent', channel: 'url-token' },
  };
  const BOUND_OPERATOR: Caller = {
    session: 'a-agent',
    channel: 'sdk-in-process',
  };
  const DELEGATED_OPERATOR: Caller = {
    session: 'a-agent',
    channel: 'http-header-token',
  };
  const NO_OWNER: Caller = { session: 'no-record', channel: 'sdk-in-process' };
  const C_BEARER: Caller = { session: 'c-agent', channel: 'url-token' };

  async function asOperatorUi(base: string, path: string): Promise<any> {
    const response = await fetch(`${base}${path}`, {
      headers: { authorization: `Bearer ${OPERATOR_CREDENTIAL}` },
    });
    return response.json();
  }

  const conversationIds = (body: any): string[] =>
    ((body?.data?.items ?? []) as { id: string }[]).map((item) => item.id);
  const transcript = (body: any): string => JSON.stringify(body?.data ?? null);

  test('conversations: B’s callers see B’s, never A’s; a bound operator sees A’s; the raw token none', async () => {
    const { base } = await setup();
    for (const [label, caller] of Object.entries(B_CALLERS)) {
      expect([
        label,
        conversationIds(await asTool(caller, '/agents/station/conversations')),
      ]).toEqual([label, ['b-conv']]);
      expect([
        label,
        transcript(
          await asTool(caller, '/agents/station/conversations/b-conv/messages'),
        ).includes('B-OWN-TRANSCRIPT'),
        transcript(
          await asTool(caller, '/agents/station/conversations/a-conv/messages'),
        ).includes('A-PRIVATE-TRANSCRIPT'),
      ]).toEqual([label, true, false]);
    }
    expect(
      conversationIds(
        await asTool(BOUND_OPERATOR, '/agents/station/conversations'),
      ),
    ).toEqual(['a-conv']);
    expect(
      (await asTool('raw-token', '/agents/station/conversations')).code,
    ).toBe('station_control_caller_required');
    expect((await asTool(NO_OWNER, '/agents/station/conversations')).code).toBe(
      'station_control_role_required',
    );
    // The operator's own UI is unchanged: its own conversations.
    expect(
      conversationIds(
        await asOperatorUi(base, '/agents/station/conversations'),
      ),
    ).toEqual(['a-conv']);
  });

  test('delete_conversation: B’s agent cannot delete A’s conversation; its own it can', async () => {
    const { memory } = await setup();
    const refused = await asTool(
      B_CALLERS['bearer-exposed B']!,
      '/agents/station/conversations/a-conv',
      { method: 'DELETE' },
    );
    expect(refused).toMatchObject({
      success: false,
      error: 'Conversation not found',
    });
    expect(await memory.getConversation('a-conv')).not.toBeNull();
    const own = await asTool(
      B_CALLERS['bearer-exposed B']!,
      '/agents/station/conversations/b-conv',
      { method: 'DELETE' },
    );
    expect(own).toMatchObject({ success: true });
    expect(await memory.getConversation('b-conv')).toBeNull();
  });

  test('the board: a session face is the owner’s; an account owner’s Task faces follow its Project membership', async () => {
    const { aProject, bProject, aTask, bTask } = await setup();
    const board = (caller: Caller, query: string) =>
      asTool(caller, `/api/board?${query}`);
    for (const [label, caller] of Object.entries(B_CALLERS)) {
      expect([
        label,
        (await board(caller, 'kind=session&id=b-chat')).success,
        (await board(caller, 'kind=session&id=a-chat')).code,
        (
          await board(
            caller,
            `kind=task&id=${bTask.id}&projectId=${bProject.id}`,
          )
        ).success,
        (
          await board(
            caller,
            `kind=task&id=${aTask.id}&projectId=${aProject.id}`,
          )
        ).code,
      ]).toEqual([
        label,
        true,
        'board_reference_unresolvable',
        true,
        'board_reference_unresolvable',
      ]);
    }
    // Changing A's session face is refused like reading it; B's own face
    // reaches the store (which then reports there is no such widget).
    const unpin = (id: string) =>
      asTool(B_CALLERS['bound B']!, '/api/board/unpin', {
        method: 'POST',
        body: JSON.stringify({
          reference: { kind: 'session', id },
          name: 'no-such-widget',
        }),
      });
    expect((await unpin('a-chat')).code).toBe('board_reference_unresolvable');
    expect((await unpin('b-chat')).code).not.toBe(
      'board_reference_unresolvable',
    );
    // C is not an account: its own requests reach every Task, and so does
    // its agent.
    expect(
      (
        await board(
          C_BEARER,
          `kind=task&id=${aTask.id}&projectId=${aProject.id}`,
        )
      ).success,
    ).toBe(true);
    expect(
      (await board(BOUND_OPERATOR, 'kind=session&id=a-chat')).success,
    ).toBe(true);
    expect((await board(BOUND_OPERATOR, 'kind=session&id=b-chat')).code).toBe(
      'board_reference_unresolvable',
    );
  });

  test('Projects: an account owner’s agent sees exactly its member Projects; the operator and a non-account owner see them all', async () => {
    const { base } = await setup();
    const slugs = (body: any) =>
      ((body?.data ?? []) as { slug: string }[]).map((p) => p.slug).sort();
    for (const [label, caller] of Object.entries(B_CALLERS)) {
      expect([label, slugs(await asTool(caller, '/api/projects'))]).toEqual([
        label,
        ['b-project'],
      ]);
      expect([
        label,
        (await asTool(caller, '/api/projects/b-project')).success,
        (await asTool(caller, '/api/projects/a-project')).success,
        (await asTool(caller, '/api/projects/a-project/layouts')).success,
      ]).toEqual([label, true, false, false]);
    }
    expect(slugs(await asTool(BOUND_OPERATOR, '/api/projects'))).toEqual([
      'a-project',
      'b-project',
    ]);
    expect(slugs(await asTool(DELEGATED_OPERATOR, '/api/projects'))).toEqual([
      'a-project',
      'b-project',
    ]);
    expect(slugs(await asTool(C_BEARER, '/api/projects'))).toEqual([
      'a-project',
      'b-project',
    ]);
    expect((await asTool('raw-token', '/api/projects')).code).toBe(
      'station_control_caller_required',
    );
    expect(slugs(await asOperatorUi(base, '/api/projects'))).toEqual([
      'a-project',
      'b-project',
    ]);
  });

  test('read_logs: redacted for every caller but a bound operator', async () => {
    const { base } = await setup();
    const apiKeys = (body: any) =>
      ((body?.entries ?? []) as { config?: { apiKey?: string } }[]).map(
        (entry) => entry.config?.apiKey,
      );
    for (const [label, caller] of Object.entries({
      ...B_CALLERS,
      'delegated-custody operator': DELEGATED_OPERATOR,
      'raw token': 'raw-token' as const,
    })) {
      expect([
        label,
        apiKeys(await asTool(caller, '/api/diagnostics/logs')),
      ]).toEqual([label, ['[REDACTED]']]);
    }
    expect(
      apiKeys(await asTool(BOUND_OPERATOR, '/api/diagnostics/logs')),
    ).toEqual([LOG_SECRET]);
    // The operator credential carries no home-possession: redacted, as before.
    expect(apiKeys(await asOperatorUi(base, '/api/diagnostics/logs'))).toEqual([
      '[REDACTED]',
    ]);
  });

  test('monitoring: an agent reads its owner’s rows; another person’s rows need a bound operator', async () => {
    const { base } = await setup();
    const owners = (body: any) =>
      ((body?.data ?? []) as { userId?: string }[]).map((row) => row.userId);
    for (const [label, caller] of Object.entries(B_CALLERS)) {
      expect([
        label,
        owners(await asTool(caller, '/monitoring/events?start=0')),
        (await asTool(caller, `/monitoring/events?start=0&userId=${A}`)).code,
      ]).toEqual([label, [B], 'station_control_role_required']);
    }
    expect(
      (
        await asTool(
          DELEGATED_OPERATOR,
          `/monitoring/events?start=0&userId=${encodeURIComponent(B)}`,
        )
      ).code,
    ).toBe('station_control_role_required');
    expect(
      owners(
        await asTool(
          BOUND_OPERATOR,
          `/monitoring/events?start=0&userId=${encodeURIComponent(B)}`,
        ),
      ),
    ).toEqual([B]);
    expect((await asTool('raw-token', '/monitoring/events?start=0')).code).toBe(
      'station_control_caller_required',
    );
    // The operator's UI still names the user it reads.
    expect(
      owners(
        await asOperatorUi(
          base,
          `/monitoring/events?start=0&userId=${encodeURIComponent(B)}`,
        ),
      ),
    ).toEqual([B]);
  });

  test('navigate_to moves only the owner’s Station clients', async () => {
    const { base, eventBus } = await setup();
    const navigations: Record<string, unknown>[] = [];
    const unsubscribe = eventBus.subscribe(({ event, data }) => {
      if (event === SERVER_EVENTS.UI_NAVIGATE) navigations.push(data ?? {});
    });
    closers.push(unsubscribe);
    const navigate = {
      method: 'POST',
      body: JSON.stringify({
        command: 'navigate',
        payload: { path: '/agents' },
      }),
    };
    expect(
      (await asTool(B_CALLERS['bearer-exposed B']!, '/api/ui', navigate))
        .success,
    ).toBe(true);
    expect((await asTool('raw-token', '/api/ui', navigate)).code).toBe(
      'station_control_caller_required',
    );
    await fetch(`${base}/api/ui`, {
      ...navigate,
      headers: {
        authorization: `Bearer ${OPERATOR_CREDENTIAL}`,
        'content-type': 'application/json',
      },
    });
    expect(navigations).toEqual([
      { path: '/agents', [UI_NAVIGATE_AUDIENCE_FIELD]: B },
      { path: '/agents' },
    ]);
  });

  test('operator-wide reads (job logs, achievements, SSH environments) need a bound operator caller', async () => {
    await setup();
    for (const path of [
      '/scheduler/jobs/nightly/logs',
      '/api/analytics/achievements',
      '/api/environments/ssh/env-1',
    ]) {
      expect([
        path,
        (await asTool(B_CALLERS['bound B']!, path)).code,
        (await asTool(DELEGATED_OPERATOR, path)).code,
        (await asTool('raw-token', path)).code,
      ]).toEqual([
        path,
        'station_control_role_required',
        'station_control_assurance_insufficient',
        'station_control_caller_required',
      ]);
      expect([
        path,
        String((await asTool(BOUND_OPERATOR, path))?.code ?? ''),
      ]).not.toEqual([path, expect.stringMatching(/^station_control_/)]);
    }
  });

  // ── slice B review: every owner-scoped read, EXECUTED ─────────────────

  test('get_basis: B’s callers find the answer basis of B’s turn, never of A’s', async () => {
    await setup();
    const basis = (caller: Caller, chat: string) =>
      asTool(
        caller,
        `/api/orchestration/sessions/${chat}/turns/${chat}-turn/basis`,
      );
    for (const [label, caller] of Object.entries(B_CALLERS)) {
      const own = await basis(caller, 'b-chat');
      const other = await basis(caller, 'a-chat');
      expect([label, own.success, other.success, other.error]).toEqual([
        label,
        true,
        false,
        'Basis not found',
      ]);
    }
    expect((await basis(BOUND_OPERATOR, 'a-chat')).success).toBe(true);
  });

  test('search_knowledge: B’s agent finds only roots B may read; the personal store is the operator’s', async () => {
    const { base } = await setup();
    // Station's indexer builds the one shared index from every root.
    const rebuilt = await fetch(`${base}/api/knowledge/index/rebuild`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${OPERATOR_CREDENTIAL}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    expect(rebuilt.status, await rebuilt.clone().text()).toBe(200);
    const titles = async (caller: Caller) => {
      const body = await asTool(caller, '/api/knowledge/index/search', {
        method: 'POST',
        body: JSON.stringify({ query: 'knowledge body', topK: 20 }),
      });
      expect(body.success, JSON.stringify(body)).toBe(true);
      return ((body.data ?? []) as { title: string }[])
        .map((hit) => hit.title)
        .sort();
    };
    for (const [label, caller] of Object.entries(B_CALLERS))
      expect([label, await titles(caller)]).toEqual([
        label,
        ['B-PROJECT-NOTE'],
      ]);
    // C is not an account: every Project root, as in its own requests; not
    // the operator's personal store.
    expect(await titles(C_BEARER)).toEqual([
      'A-PROJECT-NOTE',
      'B-PROJECT-NOTE',
    ]);
    const everything = [
      'A-PROJECT-NOTE',
      'B-PROJECT-NOTE',
      'OPERATOR-PERSONAL-NOTE',
    ];
    expect(await titles(DELEGATED_OPERATOR)).toEqual(everything);
    expect(await titles(BOUND_OPERATOR)).toEqual(everything);
  });

  test('list_plugins: B’s callers see the plugins B was granted, never the rest', async () => {
    await setup();
    for (const [label, caller] of Object.entries(B_CALLERS)) {
      const listed = JSON.stringify(await asTool(caller, '/api/plugins'));
      expect([
        label,
        listed.includes('beta-plugin'),
        listed.includes('alpha-plugin'),
      ]).toEqual([label, true, false]);
    }
    const operatorList = JSON.stringify(
      await asTool(BOUND_OPERATOR, '/api/plugins'),
    );
    expect(operatorList).toContain('alpha-plugin');
  });

  test('update_plugin / remove_plugin: B’s agent can name only a plugin B can see', async () => {
    await setup();
    const propose = (pluginName: string) =>
      asTool(B_CALLERS['bearer-exposed B']!, '/api/plugin-proposals', {
        method: 'POST',
        body: JSON.stringify({
          kind: 'update',
          pluginName,
          rationale: 'a newer version is out',
        }),
      });
    expect(await propose('alpha-plugin')).toMatchObject({
      success: false,
      code: 'plugin-not-installed',
    });
    expect(await propose('beta-plugin')).toMatchObject({ success: true });
  });

  test('review reads: B’s callers read reviews only in Projects B may view', async () => {
    await setup();
    for (const [label, caller] of Object.entries(B_CALLERS)) {
      const other = await asTool(caller, '/api/projects/a-project/reviews');
      const own = await asTool(caller, '/api/projects/b-project/reviews');
      expect([label, own, other]).toEqual([
        label,
        { success: true, data: [] },
        { success: false, error: 'Project not found' },
      ]);
    }
  });

  test('L2: an owner-less session on a dispatch read gets a typed refusal, not an internal error', async () => {
    await setup();
    expect(
      await asTool(NO_OWNER, '/api/orchestration/sessions/read-model'),
    ).toMatchObject({ success: false, code: 'station_control_role_required' });
  });

  test('get_usage, check_plugin_updates and the SSH environment list are operator-wide reads', async () => {
    await setup();
    for (const path of ['/api/analytics/usage', '/api/plugins/check-updates']) {
      expect([
        path,
        (await asTool(B_CALLERS['bound B']!, path)).code,
        (await asTool(DELEGATED_OPERATOR, path)).code,
        (await asTool('raw-token', path)).code,
      ]).toEqual([
        path,
        'station_control_role_required',
        'station_control_assurance_insufficient',
        'station_control_caller_required',
      ]);
    }
    // M2: the list leaf is shared with dispatch (slice C), which reaches it
    // with any verified caller; only a caller-less request is refused there.
    expect((await asTool('raw-token', '/api/environments/ssh')).code).toBe(
      'station_control_caller_required',
    );
  });

  test('a caller-less request still reads what belongs to no person', async () => {
    await setup();
    expect((await asTool('raw-token', '/agents')).code).toBeUndefined();
    expect((await asTool('raw-token', '/config/app')).code).toBeUndefined();
  });
});
