/**
 * #3276: Agent audience enforcement through the PRODUCTION composition.
 *
 * `configureRuntimeRoutes` with the real runtime auth boundary, the real
 * station-control authority guard and caller re-derivation over real session
 * records, the real Project membership store, a real deployment-account
 * service, and a real `AgentService` over a real `ConfigLoader` reading the
 * Agents' `agent.json` files from a real Station home. Nothing below calls
 * the audience helpers directly.
 *
 * The two kinds of member caller that exist today:
 *  - a station-control tool call whose session is owned by B, a deployment
 *    account (#2377 slice B), made exactly as the tool makes it;
 *  - B's own request: an account session presented on a credential that is
 *    not account-bound (here the operator credential the browser also holds).
 * Account-bound collaborator Devices never reach an Agent path (their gate
 * forbids it before this one runs) and are covered by that gate's tests.
 *
 * The operator owns and shares `b-project`; B accepted a `contributor`
 * invitation (view, discuss, edit, execute). Agents:
 *  - `concierge`   b-project, audience: members holding `discuss`  -> admitted
 *  - `ops-only`    b-project, no audience (operator-only)         -> hidden
 *  - `viewers-desk` b-project, audience: role `viewer` only        -> hidden
 *  - `elsewhere`   a-project, audience: members holding `view`     -> hidden
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { AGENT_AUDIENCE_VERSION } from '@kontourai/station-contracts/agent';
import {
  DEPLOYMENT_AUTHENTICATION_VERSION,
  type DeploymentAuthenticationProvider,
} from '@kontourai/station-contracts/deployment-authentication';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { awaitSessionAttachmentSettled } from '../../../__test-utils__/session-runtime-barriers.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { ConfigLoader } from '../../../domain/config-loader.js';
import { FileStorageAdapter } from '../../../domain/file-storage-adapter.js';
import { __resetStationServerSelfAttestationForTests } from '../../../security/station-server-scope.js';
import { AgentService } from '../../../services/agents/agent-service.js';
import {
  ApprovalInboxNotificationProvider,
  wireApprovalInboxNotifications,
} from '../../../services/approvals/approval-inbox.js';
import { ApprovalRegistry } from '../../../services/approvals/approval-registry.js';
import {
  DeploymentAuthenticationService,
  deploymentAccountPrincipal,
} from '../../../services/identity/deployment-authentication-service.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../../services/identity/principal-resolver.js';
import { NotificationService } from '../../../services/notifications/notification-service.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
import { ProjectManifestStore } from '../../../services/projects/project-manifest-store.js';
import { createProjectMembershipRuntime } from '../../../services/projects/project-membership-runtime.js';
import { ProjectService } from '../../../services/projects/project-service.js';
import { TaskGraphService } from '../../../services/projects/task-graph-service.js';
import {
  __resetStationControlStdioEntryForTests,
  api,
  withStationControlCallerContext,
} from '../../../tools/station-control-shared.js';
import {
  agentCatalogForCaller,
  installAgentAudienceGate,
} from '../../bootstrap/agent-audience-gate.js';
import {
  __resetStationControlMcpTokensForTests,
  mintStationControlMcpToken,
} from '../../mcp/station-control-mcp-token.js';
import { configureRuntimeRoutes } from '../runtime-routes.js';

/** The real notification service and approval inbox each test composes. */
const support = vi.hoisted(() => ({
  notifications: undefined as Record<string, unknown> | undefined,
}));

vi.mock('../runtime-route-support.js', () => {
  const stub = new Proxy({}, { get: () => () => undefined });
  return {
    configureRuntimeSupportServices: () => ({
      schedulerService: stub,
      notificationService: stub,
      attentionProjection: stub,
      webPushService: stub,
      webPushEnabled: false,
      ...support.notifications,
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

const OPERATOR_CREDENTIAL = 'test-only-operator-credential-agent-audience';
const ISSUER = 'https://id.example.test';
const B_REF = deploymentAccountPrincipal(ISSUER, 'bob', 'Bob');
const A_REF = {
  id: LOCAL_OPERATOR_PRINCIPAL_ID,
  kind: 'human',
  display: 'Operator',
} as const;
const NOW = new Date().toISOString();
const ACCOUNT_COOKIE = 'test_account=present';
const OUTAGE_COOKIE = 'test_account=outage';
const makeTempDir = trackTempDirs();

const AGENTS = {
  concierge: {
    name: 'Concierge',
    prompt: 'CONCIERGE-PRIVATE-PROMPT',
    description: 'Answers client questions',
    project: 'b-project',
    audience: {
      version: AGENT_AUDIENCE_VERSION,
      kind: 'project-permission',
      permission: 'discuss',
    },
    tools: { mcpServers: ['private-crm'] },
  },
  'ops-only': {
    name: 'Ops only',
    prompt: 'OPS-PRIVATE-PROMPT',
    project: 'b-project',
  },
  'viewers-desk': {
    name: 'Viewers desk',
    prompt: 'VIEWERS-PRIVATE-PROMPT',
    project: 'b-project',
    audience: {
      version: AGENT_AUDIENCE_VERSION,
      kind: 'project-roles',
      roles: ['viewer'],
    },
  },
  elsewhere: {
    name: 'Elsewhere',
    prompt: 'ELSEWHERE-PRIVATE-PROMPT',
    project: 'a-project',
    audience: {
      version: AGENT_AUDIENCE_VERSION,
      kind: 'project-permission',
      permission: 'view',
    },
  },
} as const;
const HIDDEN = ['ops-only', 'viewers-desk', 'elsewhere', 'no-such-agent'];

describe('configureRuntimeRoutes: an Agent is listed and usable only by its audience (#3276)', () => {
  const closers: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    __resetStationControlMcpTokensForTests();
    __resetStationControlStdioEntryForTests();
    delete process.env.STATION_API_BASE;
    for (const close of closers.splice(0)) await close();
  });

  async function setup() {
    __resetStationServerSelfAttestationForTests();
    const home = makeTempDir('station-agent-audience-');

    // Real session records: each session's owner is its start record.
    const store = new EventStore(join(home, 'orchestration.sqlite'));
    for (const [threadId, userId] of [
      ['a-agent', LOCAL_OPERATOR_PRINCIPAL_ID],
      ['b-agent', B_REF.id],
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

    const storage = new FileStorageAdapter(home);
    const projects = new ProjectService(
      storage,
      new ProjectManifestStore(home, storage),
    );
    await projects.createProject({
      name: 'A private',
      slug: 'a-project',
      workingDirectory: home,
    });
    const bProject = await projects.createProject({
      name: 'B shared',
      slug: 'b-project',
      workingDirectory: home,
    });
    const membership = createProjectMembershipRuntime(
      home,
      'environment-local',
      storage,
    );
    closers.push(() => membership.close());
    // The operator shares b-project and B accepts a `contributor` invitation
    // (view, discuss, edit, execute) through the real membership owner.
    const asOperatorAuthority = {
      current: async () => ({ principal: A_REF, verifiedEmails: [] }),
      operator: async () => {},
    };
    const asBAuthority = {
      current: async () => ({ principal: B_REF, verifiedEmails: [] }),
      operator: async () => {
        throw new Error('B is not the operator');
      },
    };
    const enabled = await membership.service.enable(
      'b-project',
      bProject.id,
      asOperatorAuthority,
    );
    const { token } = await membership.service.invite(
      enabled.scope,
      {
        email: null,
        role: 'contributor',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      },
      asOperatorAuthority,
    );
    await membership.service.accept(token, asBAuthority);
    const revokeB = async () => {
      const current = await membership.service.administration(
        'b-project',
        asOperatorAuthority,
      );
      const member = current.members.find(
        (entry) => entry.principal.id === B_REF.id,
      )!;
      await membership.service.changeMember(
        current.scope,
        B_REF.id,
        member.revision,
        { role: 'contributor', status: 'revoked' },
        asOperatorAuthority,
      );
    };

    // The Agents, exactly as `agent.json` stores them.
    for (const [slug, spec] of Object.entries(AGENTS)) {
      const dir = join(home, 'agents', slug);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'agent.json'), JSON.stringify(spec));
    }
    const configLoader = new ConfigLoader({ projectHomeDir: home });
    const agentService = new AgentService(
      configLoader,
      { findLayoutsUsingAgent: () => [] } as never,
      new Map(),
      new Map(),
      new Map(),
      { info() {}, warn() {}, error() {}, debug() {} },
    );

    // B's account session: authenticated only when its cookie is presented.
    const provider: DeploymentAuthenticationProvider = {
      version: DEPLOYMENT_AUTHENTICATION_VERSION,
      issuer: ISSUER,
      displayName: 'Test accounts',
      sessionCookies: ['test_account'],
      endpoints: [{ path: '/logout', methods: ['POST'], operation: 'logout' }],
      authenticate: async ({ headers }) => {
        // A provider outage: the service answers `unavailable`.
        if (headers.get('cookie')?.includes(OUTAGE_COOKIE))
          throw new Error('provider unreachable');
        return {
          kind: 'authenticated',
          session: {
            subject: 'bob',
            displayName: 'Bob',
            sessionId: 'session-bob',
            authenticatedAt: new Date(Date.now() - 1000).toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            contacts: [],
          },
        };
      },
      handle: async () => new Response(null, { status: 204 }),
    };

    const quiet = { info() {}, warn() {}, error() {}, debug() {} };
    const eventBus = new EventBus();
    const approvalRegistry = new ApprovalRegistry(quiet, { eventBus });
    // The production notification service and approval inbox, wired to the
    // registry exactly as the runtime support composition wires them.
    const notificationService = new NotificationService(eventBus, home, 60_000);
    const approvalInbox = new ApprovalInboxNotificationProvider({
      approvalRegistry,
      orchestrationService: orchestration,
    });
    notificationService.addProvider(approvalInbox);
    closers.push(
      wireApprovalInboxNotifications(
        eventBus,
        approvalInbox,
        notificationService,
        quiet,
      ),
      () => notificationService.shutdown(),
    );
    support.notifications = {
      notificationService,
      approvalInboxProvider: approvalInbox,
    };
    const app = new Hono();
    const context = deepStub({
      approvalRegistry,
      projectMembership: membership.service,
      projectSharedTasks: membership.sharedTasks,
      deploymentAuthentication: {
        service: new DeploymentAuthenticationService(provider),
        publicOrigin: 'https://station.example.test',
      },
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
      agentService,
      getVoltAgent: () => ({ getAgents: async () => [] }),
      applyAgentConfigurationMutation: undefined,
      getLiveAppConfig: () => ({}),
      providerService: deepStub({ listProviderConnections: () => [] }),
      connectionService: deepStub({
        checkGatedModelConnectionIds: () => new Set<string>(),
      }),
      agentMetadataMap: new Map(),
      agentFixedTokens: new Map(),
      agentTools: new Map(),
      agentStats: new Map(),
      agentStatus: new Map(),
      memoryAdapters: new Map(),
      metricsLog: [],
      orchestrationEventStore: store,
      orchestrationService: orchestration,
      storageAdapter: storage,
      taskGraphService: new TaskGraphService(home, {
        projectService: { getProject: () => bProject },
      }),
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
    Reflect.set(context, 'port', Number(new URL(base).port));
    const result = configureRuntimeRoutes(
      context as unknown as Parameters<typeof configureRuntimeRoutes>[0],
    );
    await result.kitLifecycleReady;
    return {
      base,
      revokeB,
      home,
      approvalRegistry,
      bProject,
      notificationService,
    };
  }

  /** A request exactly as a station-control tool in `session` makes it. */
  async function asTool(
    session: string,
    path: string,
    init?: RequestInit,
  ): Promise<{ status: number; body: any }> {
    const token = mintStationControlMcpToken(session, 'sdk-in-process').token;
    // `api()` answers the parsed body; the status is read from the refusal
    // envelope the routes answer with.
    const body = await withStationControlCallerContext(
      { token, resolve: () => null },
      () => api(path, init),
    );
    return { status: 0, body };
  }

  /** B's own request: B's account session on a non-account-bound credential. */
  async function asAccount(
    base: string,
    path: string,
    init: RequestInit = {},
    cookie = ACCOUNT_COOKIE,
  ): Promise<{ status: number; body: any; cacheControl: string | null }> {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        authorization: `Bearer ${OPERATOR_CREDENTIAL}`,
        cookie,
      },
    });
    return {
      status: response.status,
      body: await response.json().catch(() => null),
      cacheControl: response.headers.get('cache-control'),
    };
  }

  async function asOperator(
    base: string,
    path: string,
    init: RequestInit = {},
  ): Promise<{ status: number; body: any }> {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        authorization: `Bearer ${OPERATOR_CREDENTIAL}`,
      },
    });
    return {
      status: response.status,
      body: await response.json().catch(() => null),
    };
  }

  const slugs = (body: any): string[] =>
    ((body?.data ?? []) as { slug: string }[]).map((agent) => agent.slug);

  const memberConcierge = {
    version: 'station.member-agent/v1',
    kind: 'member-agent',
    slug: 'concierge',
    name: 'Concierge',
    description: 'Answers client questions',
    project: 'b-project',
  };

  test('a member’s account request lists only the admitted Agent, as a member view', async () => {
    const { base } = await setup();
    for (const path of ['/api/agents', '/agents']) {
      const listed = await asAccount(base, path);
      expect([path, listed.status]).toEqual([path, 200]);
      expect(listed.body.data).toEqual([memberConcierge]);
      expect(listed.cacheControl).toBe('no-store');
      // Operator configuration never reaches the member.
      expect(JSON.stringify(listed.body)).not.toMatch(
        /PRIVATE-PROMPT|private-crm/,
      );
    }
  });

  test('a member’s account request reads an admitted Agent; every other slug is the uniform not-found', async () => {
    const { base } = await setup();
    const detail = await asAccount(base, '/api/agents/concierge');
    expect(detail.status).toBe(200);
    expect(detail.body.data).toEqual(memberConcierge);

    const unknown = await asAccount(base, '/api/agents/no-such-agent');
    expect(unknown.status).toBe(404);
    for (const slug of HIDDEN) {
      for (const path of [
        `/api/agents/${slug}`,
        `/api/agents/${slug}/binding`,
        `/agents/${slug}/tools`,
      ]) {
        const refused = await asAccount(base, path);
        // Byte-identical to an Agent that does not exist.
        expect([path, refused.status, refused.body]).toEqual([
          path,
          unknown.status,
          unknown.body,
        ]);
        expect(refused.cacheControl).toBe('no-store');
      }
    }
  });

  test('a member’s account request cannot invoke a hidden Agent (not-found) or start a turn on an admitted one yet (R2 lands with #3277)', async () => {
    const { base } = await setup();
    const json = (body: unknown): RequestInit => ({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    for (const slug of HIDDEN) {
      const invoke = await asAccount(
        base,
        `/agents/${slug}/invoke`,
        json({ input: 'hello' }),
      );
      expect([slug, invoke.status, invoke.body?.error]).toEqual([
        slug,
        404,
        'Agent not found',
      ]);
      const chat = await asAccount(
        base,
        '/api/orchestration/chat',
        json({
          target: { environment: { kind: 'current' }, agent: slug },
          input: 'hello',
        }),
      );
      expect([slug, chat.status, chat.body?.error]).toEqual([
        slug,
        404,
        'Agent not found',
      ]);
    }
    const invokeAdmitted = await asAccount(
      base,
      '/agents/concierge/invoke',
      json({ input: 'hello' }),
    );
    expect(invokeAdmitted.status).toBe(403);
    expect(invokeAdmitted.body.code).toBe('member_agent_turns_unavailable');
    const chatAdmitted = await asAccount(
      base,
      '/api/orchestration/delegations',
      json({
        target: { environment: { kind: 'current' }, agent: 'concierge' },
        input: 'hello',
      }),
    );
    expect(chatAdmitted.status).toBe(403);
    expect(chatAdmitted.body.code).toBe('member_agent_turns_unavailable');
  });

  test('a station-control call in a session B owns lists and reads only the admitted Agent', async () => {
    await setup();
    const listed = await asTool('b-agent', '/agents');
    expect(listed.body.data).toEqual([memberConcierge]);
    const enriched = await asTool('b-agent', '/api/agents');
    expect(enriched.body.data).toEqual([memberConcierge]);
    expect(
      (await asTool('b-agent', '/api/agents/concierge')).body.data,
    ).toEqual(memberConcierge);
    const unknown = (await asTool('b-agent', '/api/agents/no-such-agent')).body;
    expect(unknown).toEqual({ success: false, error: 'Agent not found' });
    for (const slug of HIDDEN)
      expect([
        slug,
        (await asTool('b-agent', `/api/agents/${slug}`)).body,
      ]).toEqual([slug, unknown]);
  });

  test('a station-control call in a session B owns cannot dispatch to a hidden Agent', async () => {
    await setup();
    for (const slug of HIDDEN) {
      const dispatched = await asTool(
        'b-agent',
        '/api/orchestration/delegations',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            target: {
              environment: { kind: 'current' },
              agent: slug,
              workspace: { kind: 'project', projectSlug: 'b-project' },
            },
            input: 'hello',
          }),
        },
      );
      expect([slug, dispatched.body]).toEqual([
        slug,
        { success: false, error: 'Agent not found' },
      ]);
    }
  });

  test('a station-control call that acts for no principal is admitted to no Agent (fail closed)', async () => {
    await setup();
    // The raw internal token with no verified caller: what a pooled child
    // reaches REST with. It resolves to no `PrincipalRef`.
    const listed = await api('/agents');
    expect(listed).toEqual({ success: true, data: [] });
    // `GET /api/agents/:id` is a dispatch route the guard already refuses to
    // a caller-less request, before this gate.
    expect(await api('/api/agents/concierge')).toMatchObject({
      success: false,
      code: 'station_control_caller_required',
    });
  });

  test('revoking the membership hides the Agent on the next request', async () => {
    const { base, revokeB } = await setup();
    expect(slugs((await asAccount(base, '/api/agents')).body)).toEqual([
      'concierge',
    ]);
    // The audience is read from CURRENT membership for every decision.
    await revokeB();
    expect(slugs((await asAccount(base, '/api/agents')).body)).toEqual([]);
    expect((await asAccount(base, '/api/agents/concierge')).status).toBe(404);
    expect(slugs((await asTool('b-agent', '/agents')).body)).toEqual([]);
  });

  test('the operator’s own requests are unchanged: every Agent, through the Agent routes', async () => {
    const { base } = await setup();
    const listed = await asOperator(base, '/agents');
    // The gate did not answer: the Agent route's own catalog shape, with the
    // operator configuration a member never receives.
    expect(
      listed.body?.data?.some?.((agent: any) => agent.kind === 'member-agent'),
    ).not.toBe(true);
    const operatorTool = await asTool('a-agent', '/api/agents/ops-only');
    expect(operatorTool.body).not.toEqual({
      success: false,
      error: 'Agent not found',
    });
  });

  test('#3284 MCP prompts: a member gets the uniform not-found for a hidden Agent and no list or run on an admitted one; the operator reaches the routes', async () => {
    // Only B's own account request: no station-control tool maps to these
    // routes, so a tool call is refused before this gate.
    const { base } = await setup();
    const run = (): RequestInit => ({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        serverId: 'private-crm',
        name: 'summarize',
        arguments: {},
      }),
    });
    const unknown = await asAccount(base, '/api/agents/no-such-agent');
    expect(unknown.status).toBe(404);
    for (const slug of HIDDEN) {
      for (const [path, init] of [
        [`/agents/${slug}/mcp-prompts`, {}],
        [`/agents/${slug}/mcp-prompts/run`, run()],
      ] as const) {
        const refused = await asAccount(base, path, init);
        // Byte-identical to an Agent that does not exist.
        expect([path, refused.status, refused.body]).toEqual([
          path,
          unknown.status,
          unknown.body,
        ]);
        expect(refused.cacheControl).toBe('no-store');
      }
    }
    // An admitted Agent: the prompt list names the Agent's MCP servers, which
    // a member never receives, and running a prompt reads it with the Agent's
    // server connection to feed a turn, so both follow the member-turn rule.
    for (const [path, init] of [
      ['/agents/concierge/mcp-prompts', {}],
      ['/agents/concierge/mcp-prompts/run', run()],
    ] as const) {
      const refused = await asAccount(base, path, init);
      expect([path, refused.status, refused.body?.code]).toEqual([
        path,
        403,
        'member_agent_turns_unavailable',
      ]);
      expect(JSON.stringify(refused.body)).not.toMatch(/private-crm/);
    }
    // The operator is not gated: the prompt routes themselves answer (this
    // composition activates no Agent, so their own "not active" refusal).
    for (const [path, init] of [
      ['/agents/ops-only/mcp-prompts', {}],
      ['/agents/ops-only/mcp-prompts/run', run()],
    ] as const) {
      const reached = await asOperator(base, path, init);
      expect([path, reached.status, reached.body]).toEqual([
        path,
        404,
        { success: false, error: "Agent 'ops-only' is not active." },
      ]);
    }
  });

  const send = (method: string, body?: unknown): RequestInit => ({
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const CREATE = {
    slug: 'member-made',
    name: 'Member made',
    prompt: 'MEMBER-MADE-PROMPT',
  };
  /** Every non-turn write an Agent path accepts, addressed to `slug`. */
  const addressedMutations = (slug: string): [string, string, unknown][] => [
    ['PUT', `/agents/${slug}`, { name: 'Renamed', prompt: 'x' }],
    ['DELETE', `/agents/${slug}`, undefined],
    ['POST', `/agents/${slug}/tools`, { serverId: 'private-crm' }],
    ['PUT', `/agents/${slug}/tools/allowed`, { allowed: [] }],
    ['DELETE', `/agents/${slug}/tools/private-crm`, undefined],
    ['POST', `/agents/${slug}/workflows`, { filename: 'w.md', content: 'x' }],
    ['PUT', `/agents/${slug}/workflows/w.md`, { content: 'x' }],
    ['DELETE', `/agents/${slug}/workflows/w.md`, undefined],
  ];

  test('a member cannot create, materialize, edit or delete an Agent: 403 on the collection and admitted Agents, the uniform not-found on hidden ones', async () => {
    const { base, home } = await setup();
    for (const [path, body] of [
      ['/agents', CREATE],
      ['/agents/', CREATE],
      ['/agents/materialize-engine', { engineId: 'claude' }],
    ] as const) {
      const refused = await asAccount(base, path, send('POST', body));
      expect([path, refused.status, refused.body?.code]).toEqual([
        path,
        403,
        'member_agent_catalog_read_only',
      ]);
      expect(refused.cacheControl).toBe('no-store');
      // A station-control call B's session makes is refused too — by the
      // station-control role guard, which answers a catalog write before
      // this gate runs.
      expect([
        path,
        (await asTool('b-agent', path, send('POST', body))).body?.success,
      ]).toEqual([path, false]);
    }
    for (const [method, path, body] of addressedMutations('concierge')) {
      const refused = await asAccount(base, path, send(method, body));
      expect([method, path, refused.status, refused.body?.code]).toEqual([
        method,
        path,
        403,
        'member_agent_catalog_read_only',
      ]);
    }
    const unknown = await asAccount(base, '/api/agents/no-such-agent');
    for (const slug of HIDDEN)
      for (const [method, path, body] of addressedMutations(slug)) {
        const refused = await asAccount(base, path, send(method, body));
        expect([method, path, refused.status, refused.body]).toEqual([
          method,
          path,
          unknown.status,
          unknown.body,
        ]);
      }
    // Nothing was written: no new Agent, and the admitted one is intact.
    expect(existsSync(join(home, 'agents', 'member-made'))).toBe(false);
    expect(
      JSON.parse(
        readFileSync(join(home, 'agents', 'concierge', 'agent.json'), 'utf8'),
      ),
    ).toEqual(AGENTS.concierge);
    expect(existsSync(join(home, 'agents', 'ops-only', 'agent.json'))).toBe(
      true,
    );
  });

  test('the operator still creates and deletes Agents through the Agent route', async () => {
    const { base, home } = await setup();
    const created = await asOperator(base, '/agents', send('POST', CREATE));
    expect(created.body?.code).not.toBe('member_agent_catalog_read_only');
    expect([created.status, created.body?.success]).toEqual([201, true]);
    expect(existsSync(join(home, 'agents', 'member-made', 'agent.json'))).toBe(
      true,
    );
    const deleted = await asOperator(base, '/agents/ops-only', send('DELETE'));
    expect([deleted.status, deleted.body?.success]).toEqual([200, true]);
    expect(existsSync(join(home, 'agents', 'ops-only', 'agent.json'))).toBe(
      false,
    );
  });

  test('a member’s /api/boot carries only member views; the operator’s boot carries the operator catalog', async () => {
    const { base } = await setup();
    const boot = await asAccount(base, '/api/boot');
    expect(boot.status).toBe(200);
    expect(boot.body.sections.agents).toEqual({
      data: { success: true, data: [memberConcierge] },
    });
    // No hidden Agent's name, and no Agent's prompt or tools, anywhere in it.
    expect(JSON.stringify(boot.body)).not.toMatch(
      /PRIVATE-PROMPT|private-crm|Ops only|Viewers desk|Elsewhere/,
    );

    const operator = await asOperator(base, '/api/boot');
    expect(operator.status).toBe(200);
    const catalog = operator.body.sections.agents.data.data as any[];
    expect(catalog.map((agent) => agent.slug).sort()).toEqual(
      ['concierge', 'elsewhere', 'ops-only', 'viewers-desk'].sort(),
    );
    expect(catalog.some((agent) => agent.kind === 'member-agent')).toBe(false);
  });

  test('a member’s /api/boot carries the member Project catalogue that GET /api/projects gives it; the operator’s boot is unchanged', async () => {
    const { base, home, bProject } = await setup();
    const listed = await asAccount(base, '/api/projects');
    expect(listed.status).toBe(200);
    const memberB = {
      version: 'station.member-project/v1',
      kind: 'member-project',
      id: bProject.id,
      slug: 'b-project',
      name: 'B shared',
      actions: ['view'],
    };
    expect(listed.body.data).toEqual([memberB]);

    const boot = await asAccount(base, '/api/boot');
    expect(boot.status).toBe(200);
    expect(boot.body.sections.projects).toEqual({
      data: { success: true, data: [memberB] },
    });
    // The other Project, and every field the member view excludes (local
    // paths, model, knowledge and layout metadata), appear nowhere.
    const projectsSection = JSON.stringify(boot.body.sections.projects);
    expect(projectsSection).not.toMatch(
      /workingDirectory|layoutCount|hasKnowledge|defaultModel|defaultProviderId|knowledgeNamespaces/,
    );
    expect(projectsSection).not.toContain(home);
    expect(JSON.stringify(boot.body)).not.toMatch(/A private|"a-project"/);

    const operator = await asOperator(base, '/api/boot');
    const operatorProjects = operator.body.sections.projects.data.data as any[];
    expect(operatorProjects.map((project) => project.slug).sort()).toEqual([
      'a-project',
      'b-project',
    ]);
    expect(
      operatorProjects.every((project) => project.workingDirectory === home),
    ).toBe(true);
  });

  test('a member cannot answer a pending approval through the registry route or a respond command; the operator still can', async () => {
    const { base, approvalRegistry } = await setup();
    const pending = approvalRegistry.register('operator-approval', 60_000);
    for (const [method, path, body] of [
      ['POST', '/tool-approval/operator-approval', { approved: true }],
      [
        'POST',
        '/api/orchestration/commands',
        {
          type: 'respondToRequest',
          threadId: 'a-agent',
          requestId: 'r1',
          decision: 'accept',
        },
      ],
    ] as const) {
      const refused = await asAccount(base, path, send(method, body));
      expect([method, path, refused.status, refused.body?.code]).toEqual([
        method,
        path,
        403,
        'member_agent_turns_unavailable',
      ]);
    }
    // The operator's tool call is still waiting on the operator.
    expect(approvalRegistry.has('operator-approval')).toBe(true);
    // Any other command is not an approval answer and keeps its own rules.
    const other = await asAccount(
      base,
      '/api/orchestration/commands',
      send('POST', { type: 'interruptTurn', threadId: 'a-agent' }),
    );
    expect(other.body?.code).not.toBe('member_agent_turns_unavailable');

    const answered = await asOperator(
      base,
      '/tool-approval/operator-approval',
      send('POST', { approved: true }),
    );
    expect([answered.status, answered.body]).toEqual([200, { success: true }]);
    await expect(pending).resolves.toBe(true);
  });

  test('notifications: a member acts on and dismisses ordinary rows, is refused a live approval, and bulk clear keeps it; the operator is unchanged', async () => {
    const { base, approvalRegistry, notificationService } = await setup();
    const ordinary = (title: string) =>
      notificationService.schedule('test-source', {
        category: 'activity',
        title,
        actions: [{ id: 'ack', label: 'Acknowledge' }],
      });
    const rows = async () =>
      Object.fromEntries(
        (await notificationService.list()).map((row) => [row.title, row]),
      );
    // A live approval, opened by the registry and carded by the inbox.
    void approvalRegistry.register('live-approval', 60_000);
    await expect
      .poll(async () => (await rows())['Approval needed']?.status)
      .toBe('delivered');
    const approval = (await rows())['Approval needed']!;
    const [acted, dismissed] = [
      await ordinary('Ordinary to act on'),
      await ordinary('Ordinary to dismiss'),
    ];

    const action = await asAccount(
      base,
      `/notifications/${acted.id}/action/ack`,
      send('POST'),
    );
    expect([action.status, action.body]).toEqual([200, { success: true }]);
    const dismiss = await asAccount(
      base,
      `/notifications/${dismissed.id}`,
      send('DELETE'),
    );
    expect([dismiss.status, dismiss.body]).toEqual([200, { success: true }]);

    for (const [method, path] of [
      ['POST', `/notifications/${approval.id}/action/accept`],
      ['DELETE', `/notifications/${approval.id}`],
    ] as const) {
      const refused = await asAccount(base, path, send(method));
      expect([method, refused.status, refused.body?.code]).toEqual([
        method,
        403,
        'member_agent_turns_unavailable',
      ]);
    }
    expect(approvalRegistry.has('live-approval')).toBe(true);

    // Bulk clear: ordinary rows go, the live approval stays.
    await ordinary('Ordinary to bulk clear');
    expect(Object.keys(await rows())).toContain('Ordinary to bulk clear');
    const cleared = await asAccount(base, '/notifications', send('DELETE'));
    expect([cleared.status, cleared.body]).toEqual([200, { success: true }]);
    const after = await rows();
    // Clearing removes a row from the store.
    expect(Object.keys(after)).not.toContain('Ordinary to bulk clear');
    expect(after['Approval needed']?.status).toBe('delivered');
    expect(approvalRegistry.has('live-approval')).toBe(true);

    // The operator still answers it through the inbox.
    const answered = await asOperator(
      base,
      `/notifications/${approval.id}/action/accept`,
      send('POST'),
    );
    expect([answered.status, answered.body]).toEqual([200, { success: true }]);
    expect(approvalRegistry.has('live-approval')).toBe(false);
  });

  test('an account whose authentication is unavailable is refused before boot or the Agent list answers', async () => {
    const { base } = await setup();
    // The deployment-authentication boundary answers a provider outage
    // itself, so neither surface ever sees an undecided caller from it.
    for (const path of ['/api/boot', '/api/agents'])
      expect([
        path,
        (await asAccount(base, path, {}, OUTAGE_COOKIE)).status,
      ]).toEqual([path, 503]);
  });
});

describe('agentCatalogForCaller: an undecided caller is an error for boot, an empty list for GET /api/agents (#3276)', () => {
  const deps = {
    // What the runtime composition answers when resolving the caller threw.
    caller: async () => ({ kind: 'none', unresolved: true }) as const,
    listAgents: async () => [
      {
        slug: 'concierge',
        name: 'Concierge',
        project: 'b-project',
        audience: AGENTS.concierge.audience,
      },
    ],
  };

  test('boot’s catalog read rejects, so the section reports an error', async () => {
    const app = new Hono();
    app.get('/catalog', async (c) =>
      c.json(await agentCatalogForCaller(deps, c)),
    );
    expect((await app.request('/catalog')).status).toBe(500);
    await expect(agentCatalogForCaller(deps, {} as never)).rejects.toThrow(
      'could not be resolved',
    );
  });

  test('the gate’s own list still answers an empty list', async () => {
    const app = new Hono();
    installAgentAudienceGate(app as never, deps);
    const listed = await app.request('/api/agents');
    expect([listed.status, await listed.json()]).toEqual([
      200,
      { success: true, data: [] },
    ]);
  });
});
