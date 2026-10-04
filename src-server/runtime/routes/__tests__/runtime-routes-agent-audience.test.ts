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
import { mkdirSync, writeFileSync } from 'node:fs';
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
  DeploymentAuthenticationService,
  deploymentAccountPrincipal,
} from '../../../services/identity/deployment-authentication-service.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../../services/identity/principal-resolver.js';
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
  __resetStationControlMcpTokensForTests,
  mintStationControlMcpToken,
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
    await projects.createProject({ name: 'A private', slug: 'a-project' });
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
      authenticate: async () => ({
        kind: 'authenticated',
        session: {
          subject: 'bob',
          displayName: 'Bob',
          sessionId: 'session-bob',
          authenticatedAt: new Date(Date.now() - 1000).toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          contacts: [],
        },
      }),
      handle: async () => new Response(null, { status: 204 }),
    };

    const app = new Hono();
    const context = deepStub({
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
      eventBus: new EventBus(),
      configLoader: {
        getProjectHomeDir: () => home,
        loadAppConfig: () => ({}),
      },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      activeAgents: new Map(),
      agentService,
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
    return { base, revokeB };
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
  ): Promise<{ status: number; body: any; cacheControl: string | null }> {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        authorization: `Bearer ${OPERATOR_CREDENTIAL}`,
        cookie: ACCOUNT_COOKIE,
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
  ): Promise<{ status: number; body: any }> {
    const response = await fetch(`${base}${path}`, {
      headers: { authorization: `Bearer ${OPERATOR_CREDENTIAL}` },
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
});
