/**
 * #4830: agent-proposed Automation sources and rules through the REAL
 * boundary: a listening server with the production runtime security
 * boundary, the production station-control guard, and the production
 * agent-schedule composition (its person gate, the proposal routes' scope
 * decision), over a real orchestration EventStore (its proposal table, room
 * execution bindings and turn records), a real AutomationStore on disk, and a
 * real untrusted-content ledger. Stubbed: who may read or send to a
 * conversation, the dispatch scope's records, and the operator gate.
 *
 * Session ids name what the server records for them: `op-` is owned by the
 * operator, `anon-` acts for no one (no recorded owner); each session's
 * conversation is `conv-<session id>`.
 */

import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import {
  createGateTestRegistry,
  GateTestAdapter,
} from '../../__test-utils__/orchestration-gate-test-harness.js';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { createAgentScheduleRoutes } from '../../routes/orchestration/agent-schedule.js';
import {
  AUTOMATION_PROPOSAL_COPY,
  createAutomationProposalRoutes,
} from '../../routes/orchestration/automation-proposals.js';
import { resolveDispatchActor } from '../../routes/orchestration/orchestration.js';
import { configureRuntimeHttp } from '../../runtime/bootstrap/runtime-http.js';
import {
  createAgentDispatchActorResolver,
  resolveStationControlCallerForRequest,
  type StationControlCallerRecordResolver,
} from '../../runtime/mcp/station-control-caller.js';
import type { StationControlDispatchScope } from '../../runtime/mcp/station-control-dispatch-scope.js';
import {
  __resetStationControlMcpTokensForTests,
  mintStationControlMcpHeaderAuth,
  mintStationControlMcpToken,
} from '../../runtime/mcp/station-control-mcp-token.js';
import { composeAgentSchedule } from '../../runtime/routes/agent-schedule-composition.js';
import { automationConfigurationFingerprint } from '../../services/automation/automation-intent.js';
import {
  AUTOMATION_PROPOSAL_UNTRUSTED_COPY,
  automationIdForProposal,
  proposingTurnId,
} from '../../services/automation/automation-proposals.js';
import { AutomationStore } from '../../services/automation/automation-store.js';
import {
  LOCAL_OPERATOR_PRINCIPAL_ID,
  principalForRecordedSessionOwner,
} from '../../services/identity/principal-resolver.js';
import { EventBus } from '../../services/orchestration/event-bus.js';
import { EventStore } from '../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../services/orchestration/orchestration-service.js';
import { UntrustedContentLedger } from '../../services/plugins/untrusted-content-policy.js';
import { STATION_CONTROL_CALLER_TOKEN_HEADER } from '../../tools/station-control-shared.js';
import {
  getInternalApiToken,
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_PROXY_CALLER_HEADER,
} from '../../utils/internal-api-token.js';
import type { Logger } from '../../utils/logger.js';
import { getRuntimeAuthenticatedRequestPrincipal } from '../runtime-request-security.js';
import { createStationControlAuthorityGuard } from '../station-control-authority-guard.js';
import { __resetStationServerSelfAttestationForTests } from '../station-server-scope.js';

const OPERATOR_CREDENTIAL =
  'test-only-operator-credential-automation-proposals';
const OPERATOR = principalForRecordedSessionOwner(LOCAL_OPERATOR_PRINCIPAL_ID);
const makeTempDir = trackTempDirs();

const resolveRecord: StationControlCallerRecordResolver = (sessionId) => ({
  ...(sessionId.startsWith('anon-')
    ? {}
    : {
        principal: {
          id: LOCAL_OPERATOR_PRINCIPAL_ID,
          source: 'session-owner' as const,
        },
      }),
  localProjectId: 'local-project-a',
  projectIdSource: 'session-record',
  projectSlug: 'project-a',
  conversationId: `conv-${sessionId}`,
});

function quietLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
    setLevel: vi.fn(),
    getLevel: vi.fn(() => 'info' as const),
  } as unknown as Logger;
}

const facts = {
  /** The operator gate answers for the person's request. */
  operator: true,
  /** Conversations the person may not send to. */
  mayNotSend: new Set<string>(),
  /** Runs on each operator check: before the claim, then inside each lock. */
  onOperatorCheck: undefined as (() => void) | undefined,
};

const PROJECTS = new Map([
  ['local-project-a', 'project-a'],
  ['local-project-b', 'project-b'],
]);
/** Each Agent's stored definition, as `AgentService.getAgent` reads it. */
const WRITER = { name: 'Writer', prompt: 'Write.', project: 'project-a' };
const AGENTS = new Map<
  string,
  { name: string; prompt: string; project?: string }
>([
  ['writer', WRITER],
  ['elsewhere', { name: 'Elsewhere', prompt: 'Work.', project: 'project-b' }],
]);

const scope: StationControlDispatchScope = {
  target: (ref) => {
    if (ref.kind === 'new' && ref.projectSlug !== undefined)
      return {
        ownerId: ref.ownerId,
        scope: {
          kind: 'project',
          id: ref.projectSlug === 'project-a' ? 'local-project-a' : 'other',
        },
        host: false,
        remote: false,
        ownerHoldsAction: true,
      };
    return undefined;
  },
  conversationExists: () => true,
  ownProjectSlug: () => undefined,
};

/**
 * A test engine whose turn emits its own `turn.started` and then, before its
 * send returns acceptance, runs `duringSend`: the window in which the
 * production propagation owner holds the start (#4830 verification).
 * `beforeStart` runs before the start is emitted, while the send is in
 * flight.
 */
class TimedTurnAdapter extends GateTestAdapter {
  beforeStart: (() => Promise<void>) | undefined;
  duringSend: (() => Promise<void>) | undefined;
  override async sendTurn(input: {
    threadId: string;
    input?: unknown;
    invocationId?: string;
  }) {
    const turnId = randomUUID();
    await this.beforeStart?.();
    this.events.push({
      eventId: randomUUID(),
      provider: this.provider,
      threadId: input.threadId,
      turnId,
      invocationId: input.invocationId,
      createdAt: new Date().toISOString(),
      method: 'turn.started',
      prompt: input.input,
    } as never);
    await this.duringSend?.();
    return { threadId: input.threadId, turnId };
  }
}
let adapter: TimedTurnAdapter;
let service: OrchestrationService;

let baseUrl: string;
let port: number;
let eventStore: EventStore;
let automations: AutomationStore;
let ledger: UntrustedContentLedger;
let refusals: string[];
let close: () => Promise<void>;

/** The production composition over this file's stores; again is a restart. */
function compose() {
  return composeAgentSchedule({
    store: eventStore.agentScheduleStore(),
    threadInbox: undefined,
    scope,
    orchestration: {
      canUserReadConversation: () => true,
      canUserMutateSession: (threadId) => !facts.mayNotSend.has(threadId),
      currentConversationSessionId: (conversationId) => conversationId,
      readUsageLimitRecovery: async () => undefined,
    },
    hosted: false,
    isInternalRequest: (request) =>
      getRuntimeAuthenticatedRequestPrincipal(request)?.kind === 'internal',
    isRequestPrincipalCurrent: (request) =>
      ['credential', 'internal'].includes(
        getRuntimeAuthenticatedRequestPrincipal(request)?.kind ?? '',
      ),
    requestUserId: () => LOCAL_OPERATOR_PRINCIPAL_ID,
    readAuthorityFor: () => ({ mode: 'personal' }) as never,
    tenantFor: () => undefined,
    dispatchActor: (c) =>
      resolveDispatchActor(
        {
          resolvePrincipal: () => OPERATOR,
          resolveAgentDispatchActor:
            createAgentDispatchActorResolver(resolveRecord),
        },
        c as never,
      ),
    agentProject: async (slug) => {
      const agent = AGENTS.get(slug);
      if (!agent) throw new Error('no such agent');
      return agent.project;
    },
    automationProposals: {
      store: eventStore.automationProposalStore(),
      automations,
      projectSlugForId: (id) => PROJECTS.get(id),
      projectName: (id) => (id === 'local-project-a' ? 'Project A' : undefined),
      agentDefinition: async (slug) => {
        const agent = AGENTS.get(slug);
        if (!agent) throw new Error('no such agent');
        return structuredClone(agent);
      },
      // As production wires it: the calling turn from a real orchestration
      // service over this file's store.
      proposingTurn: (sessionId) =>
        proposingTurnId(
          {
            callingTurn: (id) => service.stationControlCallingTurn(id),
            store: eventStore,
          },
          sessionId,
        ),
      untrustedContent: async (conversationId) =>
        (await ledger.conversationHasRead(conversationId)) ||
        ledger.hasDescendantRead(conversationId),
      operator: async (request) =>
        facts.operator &&
        getRuntimeAuthenticatedRequestPrincipal(request)?.authority ===
          'operator-credential'
          ? {
              id: 'operator',
              assertCurrent: async () => {
                facts.onOperatorCheck?.();
              },
            }
          : undefined,
    },
    logger: quietLogger(),
  });
}

beforeAll(async () => {
  __resetStationServerSelfAttestationForTests();
  const home = makeTempDir('station-automation-proposals-');
  eventStore = new EventStore(join(home, 'orchestration.sqlite'));
  automations = new AutomationStore(home);
  ledger = new UntrustedContentLedger();
  refusals = [];
  adapter = new TimedTurnAdapter();
  service = new OrchestrationService({
    adapterRegistry: createGateTestRegistry(adapter),
    eventBus: new EventBus(),
    eventStore,
    logger: { debug: vi.fn(), warn: vi.fn() },
  } as never);
  const composition = compose();
  const app = new Hono();
  configureRuntimeHttp({
    app: app as never,
    logger: quietLogger(),
    eventBus: { emit: vi.fn() } as unknown as EventBus,
    security: {
      verifyCredential: (candidate: string) =>
        candidate === OPERATOR_CREDENTIAL,
      resolveGrantedScope: () => 'orchestration:read orchestration:operate',
      resolveCredentialAuthority: () => 'operator-credential',
      now: () => Date.now(),
      maxFailures: 1_000,
      windowMs: 60_000,
      audit: () => {},
      allowedOrigins: [],
    },
  } as Parameters<typeof configureRuntimeHttp>[0]);
  app.use(
    '*',
    createStationControlAuthorityGuard({
      resolveCaller: (request) =>
        resolveStationControlCallerForRequest(request, resolveRecord),
      isOperatorPrincipal: (id) => id === LOCAL_OPERATOR_PRINCIPAL_ID,
      wakeUpConversation: composition.wakeUpConversation,
      onRefusal: (refusal) => refusals.push(refusal.code),
    }),
  );
  app.route(
    '/api/orchestration',
    createAgentScheduleRoutes(composition.routeDeps),
  );
  app.route(
    '/api/orchestration',
    createAutomationProposalRoutes(composition.automationProposalRouteDeps),
  );
  let resolvePort!: (value: number) => void;
  const listening = new Promise<number>((resolve) => {
    resolvePort = resolve;
  });
  const server = serve(
    { fetch: app.fetch, hostname: '127.0.0.1', port: 0 },
    (info) => resolvePort((info as AddressInfo).port),
  );
  port = await listening;
  baseUrl = `http://127.0.0.1:${port}`;
  close = async () => {
    await service.shutdown();
    adapter.events.close();
    eventStore.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
});

afterAll(async () => {
  await close();
  __resetStationServerSelfAttestationForTests();
});

beforeEach(() => {
  __resetStationControlMcpTokensForTests();
  refusals.length = 0;
  facts.operator = true;
  facts.mayNotSend.clear();
  facts.onOperatorCheck = undefined;
  AGENTS.set('writer', WRITER);
});

type Channel = 'bound' | 'delegated-custody';

let counter = 0;

const ORIGIN = (
  actor: Record<string, string>,
  surface = 'web',
  sender?: Record<string, string>,
) => ({
  version: 1,
  actor,
  reported: { version: 1, surface, build: null },
  ...(sender ? { sender } : {}),
});

/**
 * Each `turn.started` shape as Station's own writers stamp it (#4827's
 * `turn-authorship` table). Only the composer marks a turn
 * `authoredBy: 'person'`; every other entry point leaves the mark off.
 */
const TURN = {
  /** A person typed it into the web, desktop or mobile composer. */
  composer: {
    clientOrigin: ORIGIN({ kind: 'operator' }),
    dispatchOrigin: 'interactive',
    authoredBy: 'person',
  },
  /** The CLI or a background run on the operator's credential: no mark. */
  cli: {
    clientOrigin: ORIGIN({ kind: 'operator' }, 'cli'),
    dispatchOrigin: 'interactive',
  },
  /** An MCP prompt expansion, though sent from a composer. */
  mcpPrompt: {
    clientOrigin: ORIGIN({ kind: 'operator' }),
    dispatchOrigin: 'interactive',
    promptSource: 'mcp-prompt',
    authoredBy: 'person',
  },
  /** A peer Station's `/chat/delegated` send on its device grant. */
  peerDelegated: {
    clientOrigin: ORIGIN({ kind: 'device', deviceId: 'peer-grant' }),
    dispatchOrigin: 'unknown',
  },
  automation: {
    clientOrigin: ORIGIN({ kind: 'internal' }),
    dispatchOrigin: 'automation',
  },
  taskDispatch: {
    clientOrigin: ORIGIN({ kind: 'internal' }),
    dispatchOrigin: 'task-dispatch',
  },
  delegation: {
    clientOrigin: ORIGIN({ kind: 'internal' }),
    dispatchOrigin: 'delegation',
  },
  /** A turn recorded before the mark existed. */
  unmarked: {},
} as const;

function appendTurn(
  sessionId: string,
  shape: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): string {
  const turnId = `turn-${++counter}`;
  eventStore.appendEvent({
    eventId: `${sessionId}-${turnId}`,
    provider: 'claude',
    threadId: sessionId,
    createdAt: '2026-11-12T00:00:00.000Z',
    method: 'turn.started',
    turnId,
    prompt: 'Set up an automation.',
    ...shape,
    ...extra,
  } as never);
  return (extra.turnId as string | undefined) ?? turnId;
}

/**
 * A Session whose current turn a person typed into the composer: the only
 * turn that may propose. A test for another start appends a newer turn, or
 * uses {@link bareSession} (no turn at all).
 */
const nextSession = (prefix = 'op-') => {
  const sessionId = bareSession(prefix);
  appendTurn(sessionId, TURN.composer);
  return sessionId;
};
const bareSession = (prefix = 'op-') => `${prefix}${++counter}`;

async function agent(
  channel: Channel,
  sessionId: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const token =
    channel === 'bound'
      ? mintStationControlMcpToken(sessionId, 'sdk-in-process').token
      : mintStationControlMcpHeaderAuth(port, sessionId).token;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
      [INTERNAL_PROXY_CALLER_HEADER]: 'local',
      [STATION_CONTROL_CALLER_TOKEN_HEADER]: token,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

async function person(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${OPERATOR_CREDENTIAL}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

const SOURCES =
  '/api/orchestration/station-control/automation-proposals/sources';
const RULES = '/api/orchestration/station-control/automation-proposals/rules';
const LIST = '/api/orchestration/station-control/automation-proposals';
const schedule = (conversationId: string) =>
  `/api/orchestration/agent-schedule/${conversationId}`;
const answer = (
  conversationId: string,
  proposalId: string,
  verb: 'confirm' | 'decline',
) =>
  `/api/orchestration/agent-schedule/${conversationId}/automation-proposals/${proposalId}/${verb}`;

const SOURCE = {
  kind: 'github-poll',
  name: 'ci',
  repository: 'acme/widgets',
  grants: [
    {
      projectId: 'local-project-a',
      agentId: 'writer',
      actions: ['dispatch-task'],
    },
  ],
};

const action = (overrides: Record<string, unknown> = {}) => ({
  kind: 'dispatch-task',
  projectId: 'local-project-a',
  agentId: 'writer',
  instructions: 'Diagnose the failing run and report what broke.',
  budget: { maxTurns: 4, maxTokens: 200_000, maxWallRuntimeMs: 1_800_000 },
  ...overrides,
});

const rule = (source: Record<string, string>, overrides = {}) => ({
  name: 'ci failures',
  ...source,
  match: {
    type: 'github.workflow_run.completed',
    where: {
      'workflow.path': '.github/workflows/ci.yml',
      'run.conclusion': ['failure', 'timed_out'],
    },
  },
  action: action(),
  rateLimit: { maxStartsPerHour: 2 },
  ...overrides,
});

const configured = () => automations.read();

describe('an agent proposes; nothing exists until a person confirms', () => {
  test('a proposal with no confirmation creates no source and no rule', async () => {
    const sessionId = nextSession();
    const proposed = await agent('bound', sessionId, 'POST', SOURCES, SOURCE);
    expect(proposed.status).toBe(200);
    expect(proposed.body.data).toMatchObject({ state: 'open' });
    expect(proposed.body.message).toBe(AUTOMATION_PROPOSAL_COPY.waiting);
    // What the person reads, rendered by Station.
    expect(proposed.body.data.description).toMatchObject({
      watches: expect.stringContaining('acme/widgets'),
      wakes: 'Agent writer in Project A (local-project-a)',
      startsAs: expect.stringContaining('disabled'),
    });
    const ruleProposal = await agent(
      'bound',
      sessionId,
      'POST',
      RULES,
      rule({ sourceProposalId: proposed.body.data.id }),
    );
    expect(ruleProposal.status).toBe(200);
    expect(configured()).toMatchObject({ sources: [], rules: [] });
    // The person sees both in the chat, still waiting.
    const listed = await person('GET', schedule(`conv-${sessionId}`));
    expect(
      listed.body.data.automationProposals.map(
        (p: { kind: string; state: string }) => [p.kind, p.state],
      ),
    ).toEqual([
      ['source', 'open'],
      ['rule', 'open'],
    ]);
    // Declining creates nothing either.
    expect(
      (
        await person(
          'POST',
          answer(`conv-${sessionId}`, proposed.body.data.id, 'decline'),
        )
      ).body,
    ).toMatchObject({ data: { declined: true } });
    expect(configured()).toMatchObject({ sources: [], rules: [] });
  });

  test("a person's confirmation creates it in the default-deny posture", async () => {
    const sessionId = nextSession();
    const conversationId = `conv-${sessionId}`;
    const source = await agent('bound', sessionId, 'POST', SOURCES, SOURCE);
    const ruleProposal = await agent(
      'bound',
      sessionId,
      'POST',
      RULES,
      rule({ sourceProposalId: source.body.data.id }),
    );
    // The rule has nothing to attach to until its source exists.
    expect(
      (
        await person(
          'POST',
          answer(conversationId, ruleProposal.body.data.id, 'confirm'),
        )
      ).body,
    ).toMatchObject({ code: 'automation_proposal_source_pending' });
    expect(configured().rules).toEqual([]);

    const sourceConfirmed = await person(
      'POST',
      answer(conversationId, source.body.data.id, 'confirm'),
      {},
    );
    expect(sourceConfirmed.status).toBe(200);
    expect(sourceConfirmed.body.data).toMatchObject({ enabled: false });
    const created = configured().sources.find(
      ({ id }) => id === sourceConfirmed.body.data.createdId,
    );
    expect(created).toMatchObject({
      kind: 'github-poll',
      repository: 'acme/widgets',
      enabled: false,
    });

    const ruleConfirmed = await person(
      'POST',
      answer(conversationId, ruleProposal.body.data.id, 'confirm'),
    );
    expect(ruleConfirmed.status).toBe(200);
    expect(
      configured().rules.find(
        ({ id }) => id === ruleConfirmed.body.data.createdId,
      ),
    ).toMatchObject({ mode: 'observe', sourceId: created!.id });
    // The agent can read what became of them.
    const listed = await agent('bound', sessionId, 'GET', LIST);
    expect(listed.body.data.map((p: { state: string }) => p.state)).toEqual([
      'confirmed',
      'confirmed',
    ]);
  });

  test('enable in the same confirmation creates an enabled source and a live rule', async () => {
    const sessionId = nextSession();
    const conversationId = `conv-${sessionId}`;
    const source = await agent('bound', sessionId, 'POST', SOURCES, SOURCE);
    const sourceConfirmed = await person(
      'POST',
      answer(conversationId, source.body.data.id, 'confirm'),
      { enable: true },
    );
    expect(sourceConfirmed.body.data).toMatchObject({ enabled: true });
    const ruleProposal = await agent(
      'bound',
      sessionId,
      'POST',
      RULES,
      rule({ sourceId: sourceConfirmed.body.data.createdId }),
    );
    const ruleConfirmed = await person(
      'POST',
      answer(conversationId, ruleProposal.body.data.id, 'confirm'),
      { enable: true },
    );
    expect(
      configured().sources.find(
        ({ id }) => id === sourceConfirmed.body.data.createdId,
      ),
    ).toMatchObject({ enabled: true });
    expect(
      configured().rules.find(
        ({ id }) => id === ruleConfirmed.body.data.createdId,
      ),
    ).toMatchObject({ mode: 'live' });
  });

  test('an agent cannot confirm, and only the operator in person can', async () => {
    const sessionId = nextSession();
    const conversationId = `conv-${sessionId}`;
    const before = configured().sources.length;
    const source = await agent('bound', sessionId, 'POST', SOURCES, SOURCE);
    const byAgent = await agent(
      'bound',
      sessionId,
      'POST',
      answer(conversationId, source.body.data.id, 'confirm'),
      { enable: true },
    );
    expect(byAgent.status).toBe(403);
    facts.operator = false;
    const notOperator = await person(
      'POST',
      answer(conversationId, source.body.data.id, 'confirm'),
    );
    expect(notOperator).toMatchObject({
      status: 403,
      body: { code: 'automation_proposal_operator_required' },
    });
    facts.mayNotSend.add(conversationId);
    facts.operator = true;
    expect(
      (
        await person(
          'POST',
          answer(conversationId, source.body.data.id, 'confirm'),
        )
      ).status,
    ).toBe(404);
    expect(configured().sources).toHaveLength(before);
  });
});

describe('a proposal never grants more than the proposing chat holds', () => {
  const refusedAsEscalation = async (
    channel: Channel,
    path: string,
    body: unknown,
  ) => {
    const sessionId = nextSession();
    const before = configured();
    const response = await agent(channel, sessionId, 'POST', path, body);
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('automation_proposal_exceeds_authority');
    // Nothing recorded, nothing created.
    expect(
      eventStore
        .automationProposalStore()
        .recentProposals(`conv-${sessionId}`, 10),
    ).toEqual([]);
    expect(configured()).toEqual(before);
    return response;
  };

  test('a grant for a Project this chat cannot dispatch to is refused', async () => {
    await refusedAsEscalation('delegated-custody', SOURCES, {
      ...SOURCE,
      grants: [
        {
          projectId: 'local-project-b',
          agentId: 'elsewhere',
          actions: ['dispatch-task'],
        },
      ],
    });
  });

  test('a rule starting an Agent outside this chat’s scope is refused', async () => {
    await refusedAsEscalation(
      'delegated-custody',
      RULES,
      rule(
        { sourceId: 'any' },
        {
          action: action({
            projectId: 'local-project-b',
            agentId: 'elsewhere',
          }),
        },
      ),
    );
  });

  test('a grant naming an action no agent can take itself is refused', async () => {
    await refusedAsEscalation('bound', SOURCES, {
      ...SOURCE,
      grants: [
        {
          projectId: 'local-project-a',
          agentId: 'writer',
          actions: ['dispatch-task', 'publish-branch'],
        },
      ],
    });
  });

  test('auto approval, fullAccessGrant, a credential or a starting state are refused', async () => {
    await refusedAsEscalation(
      'bound',
      RULES,
      rule({ sourceId: 'any' }, { action: action({ approvalMode: 'auto' }) }),
    );
    const fullAccess = await refusedAsEscalation(
      'bound',
      RULES,
      rule(
        { sourceId: 'any' },
        { action: action({ fullAccessGrant: { scope: 'all' } }) },
      ),
    );
    expect(fullAccess.body.error).toContain('full access');
    await refusedAsEscalation('bound', SOURCES, {
      ...SOURCE,
      credentialSecretBinding: 'github-token',
    });
    await refusedAsEscalation('bound', SOURCES, { ...SOURCE, enabled: true });
    await refusedAsEscalation(
      'bound',
      RULES,
      rule({ sourceId: 'any' }, { mode: 'live' }),
    );
    await refusedAsEscalation(
      'bound',
      RULES,
      rule({ sourceId: 'any' }, { action: { kind: 'isolated-repair' } }),
    );
  });
});

describe('only a turn a person typed may propose (§5 Never; #4830 re-review clause A)', () => {
  const refused = async (
    sessionId: string,
    refusal: Record<string, string> = {
      code: 'automation_proposal_unattended',
      error: AUTOMATION_PROPOSAL_COPY.startedByAutomation,
    },
  ) => {
    for (const [path, body] of [
      [SOURCES, SOURCE],
      [RULES, rule({ sourceId: 'any' })],
    ] as const) {
      const response = await agent('bound', sessionId, 'POST', path, body);
      expect(response).toMatchObject({ status: 403, body: refusal });
    }
    expect(
      eventStore
        .automationProposalStore()
        .recentProposals(`conv-${sessionId}`, 10),
    ).toEqual([]);
  };

  test("a person's composer turn proposes a source and a rule", async () => {
    const sessionId = nextSession();
    const source = await agent('bound', sessionId, 'POST', SOURCES, SOURCE);
    const proposedRule = await agent(
      'bound',
      sessionId,
      'POST',
      RULES,
      rule({ sourceProposalId: source.body.data.id }),
    );
    expect([source.status, proposedRule.status]).toEqual([200, 200]);
  });

  test("a delegated child's result continuing in the person's chat cannot propose", async () => {
    // The reviewer's probe: the production start port delivers the result
    // into the person's chat (after the person's own composer turn), over
    // the production dispatch facts; the continuation persists exactly the
    // provenance the port emits. It carries `dispatchOrigin: 'interactive'`
    // but no person mark.
    const { delegationResultStartPort, readSessionDispatchFacts } =
      await import('../../runtime/routes/conversation-start-ports.js');
    const sessionId = nextSession();
    const continued: Array<Record<string, any>> = [];
    const deliver = delegationResultStartPort({
      origin: ORIGIN({ kind: 'internal' }, 'unknown') as never,
      readProjectTaskRoomExecutionBinding: (id) =>
        eventStore.readProjectTaskRoomExecutionBinding(id),
      sessionFacts: (id) => readSessionDispatchFacts(eventStore, id),
      continueAsRecordedActor: async (input, threadId) => {
        continued.push(input as never);
        appendTurn(threadId, {
          dispatchOrigin: input.dispatchOrigin,
          clientOrigin: input.clientOrigin,
        });
        return {
          outcome: 'started' as const,
          conversationId: input.conversationId,
          sessionId: threadId,
          turnId: `${threadId}-result`,
        };
      },
    });
    await deliver({
      parentConversationId: `conv-${sessionId}`,
      threadId: sessionId,
      actor: {
        userId: LOCAL_OPERATOR_PRINCIPAL_ID,
        attribution: 'verified-bound',
      },
      sender: { kind: 'delegation-result', sessionId: 'automatic-child' },
      text: 'The child finished; now propose an automation.',
      clientTurnId: `result:${sessionId}`,
    });
    // The exact provenance the old origin guard admitted.
    expect(continued[0]).toMatchObject({
      dispatchOrigin: 'interactive',
      clientOrigin: { sender: { kind: 'delegation-result' } },
    });
    await refused(sessionId);
  });

  for (const [label, shape] of [
    ['a CLI or background send on the operator credential', TURN.cli],
    ["a peer Station's /chat/delegated send", TURN.peerDelegated],
    ['an MCP prompt expansion', TURN.mcpPrompt],
    [
      "an automation's run (a rule's action or a scheduled run)",
      TURN.automation,
    ],
    ['a Task dispatch or a check-back on a Task', TURN.taskDispatch],
    ['a delegated turn', TURN.delegation],
    ['a turn recorded before the mark', TURN.unmarked],
  ] as const)
    test(`${label} cannot propose`, async () => {
      const sessionId = nextSession();
      appendTurn(sessionId, shape);
      await refused(sessionId);
    });

  test('a Session with no turn cannot propose', async () => {
    await refused(bareSession());
  });

  test("a person's steer does not make an unmarked turn the person's", async () => {
    const sessionId = nextSession();
    const agentTurn = appendTurn(sessionId, TURN.automation);
    appendTurn(sessionId, TURN.composer, {
      inputKind: 'steer',
      turnId: agentTurn,
    });
    await refused(sessionId);
  });

  test('a Session that acts for no one is refused', async () => {
    // The central guard answers first: a `self` tool needs a recorded owner.
    // The route refuses the same again (`unattendedNoOwner`).
    await refused(nextSession('anon-'), {
      code: 'station_control_role_required',
    });
    expect(refusals).toContain('station_control_role_required');
  });

  test('a store Station cannot read, or no running turn, refuses', () => {
    const marked = {
      latestOwnTurnStarted: () => ({
        payload: { method: 'turn.started', turnId: 't', ...TURN.composer },
      }),
    } as never;
    expect(
      proposingTurnId(
        {
          callingTurn: () => ({ kind: 'turn', turnId: 't' }),
          store: {
            latestOwnTurnStarted: () => {
              throw new Error('unreadable');
            },
          },
        },
        's',
      ),
    ).toBeUndefined();
    for (const kind of ['pending', 'none'] as const)
      expect(
        proposingTurnId({ callingTurn: () => ({ kind }), store: marked }, 's'),
      ).toBeUndefined();
    expect(
      proposingTurnId(
        { callingTurn: () => ({ kind: 'turn', turnId: 't' }), store: marked },
        's',
      ),
    ).toBe('t');
  });
});

describe('a proposal from a chat that read untrusted content says so', () => {
  test('the confirmation carries the label for a marked conversation only', async () => {
    const marked = nextSession();
    ledger.markConversation(`conv-${marked}`, Promise.resolve(true));
    const fromMarked = await agent('bound', marked, 'POST', SOURCES, SOURCE);
    expect(fromMarked.status).toBe(200);
    const listed = await person('GET', schedule(`conv-${marked}`));
    expect(listed.body.data.automationProposals[0]).toMatchObject({
      untrustedContent: true,
      description: { untrusted: AUTOMATION_PROPOSAL_UNTRUSTED_COPY },
    });

    const clean = nextSession();
    await agent('bound', clean, 'POST', SOURCES, SOURCE);
    const cleanListed = await person('GET', schedule(`conv-${clean}`));
    expect(cleanListed.body.data.automationProposals[0].untrustedContent).toBe(
      false,
    );
    expect(
      cleanListed.body.data.automationProposals[0].description.untrusted,
    ).toBeUndefined();
  });
});

// ── #4830 review, fix round 1 ─────────────────────────────────────────────

describe('Confirm rechecks what the proposing chat may do now (review P1)', () => {
  const refusedAtConfirm = async (
    proposalId: string,
    conversationId: string,
    body?: unknown,
  ) => {
    const before = configured();
    const response = await person(
      'POST',
      answer(conversationId, proposalId, 'confirm'),
      body,
    );
    expect(response).toMatchObject({
      status: 409,
      body: { code: 'automation_proposal_binding_changed' },
    });
    expect(configured()).toEqual(before);
    // Still open: the person can decline it.
    expect(
      eventStore.automationProposalStore().proposal(proposalId)?.state,
    ).toBe('open');
  };

  test('an Agent moved out of the chat’s scope cannot be confirmed or enabled', async () => {
    const sessionId = nextSession();
    const conversationId = `conv-${sessionId}`;
    const source = await agent(
      'delegated-custody',
      sessionId,
      'POST',
      SOURCES,
      SOURCE,
    );
    const ruleProposal = await agent(
      'delegated-custody',
      sessionId,
      'POST',
      RULES,
      rule({ sourceProposalId: source.body.data.id }),
    );
    expect([source.status, ruleProposal.status]).toEqual([200, 200]);
    AGENTS.set('writer', { ...WRITER, project: 'project-b' });
    // A fresh proposal is refused, and so is confirming the earlier one.
    expect(
      (await agent('delegated-custody', nextSession(), 'POST', SOURCES, SOURCE))
        .status,
    ).toBe(403);
    await refusedAtConfirm(source.body.data.id, conversationId, {
      enable: true,
    });
  });

  test('a bound operator chat is pinned to the Agent it named, not just its slug', async () => {
    // A bound operator reaches every Project, so only the binding tells.
    const sessionId = nextSession();
    const source = await agent('bound', sessionId, 'POST', SOURCES, SOURCE);
    expect(source.status).toBe(200);
    AGENTS.set('writer', { ...WRITER, project: 'project-b' });
    await refusedAtConfirm(source.body.data.id, `conv-${sessionId}`);
  });

  test('a deleted Agent cannot be confirmed', async () => {
    const sessionId = nextSession();
    const source = await agent('bound', sessionId, 'POST', SOURCES, SOURCE);
    AGENTS.delete('writer');
    await refusedAtConfirm(source.body.data.id, `conv-${sessionId}`);
  });

  test('a slug reused for a different Agent cannot be confirmed', async () => {
    const sessionId = nextSession();
    const source = await agent('bound', sessionId, 'POST', SOURCES, SOURCE);
    AGENTS.set('writer', { ...WRITER, prompt: 'Something else entirely.' });
    await refusedAtConfirm(source.body.data.id, `conv-${sessionId}`);
  });

  test('an Agent that changes inside the creation lock creates nothing', async () => {
    const sessionId = nextSession();
    const conversationId = `conv-${sessionId}`;
    const source = await agent('bound', sessionId, 'POST', SOURCES, SOURCE);
    // The first operator check is Confirm's own, before it claims; the
    // second runs inside the store's lock, after the Agent is replaced.
    let checks = 0;
    facts.onOperatorCheck = () => {
      checks += 1;
      if (checks === 2) AGENTS.delete('writer');
    };
    const before = configured();
    const response = await person(
      'POST',
      answer(conversationId, source.body.data.id, 'confirm'),
    );
    expect(response.body.code).toBe('automation_proposal_binding_changed');
    expect(checks).toBeGreaterThanOrEqual(2);
    expect(configured()).toEqual(before);
    expect(
      eventStore.automationProposalStore().proposal(source.body.data.id)?.state,
    ).toBe('open');
  });

  test('an Agent that changes inside the enabling lock is created but never enabled', async () => {
    const sessionId = nextSession();
    const conversationId = `conv-${sessionId}`;
    const source = await agent('bound', sessionId, 'POST', SOURCES, SOURCE);
    // Checks: before the claim, in the creation lock, then in the enabling
    // lock, where the Agent is gone.
    let checks = 0;
    facts.onOperatorCheck = () => {
      checks += 1;
      if (checks === 3) AGENTS.delete('writer');
    };
    const response = await person(
      'POST',
      answer(conversationId, source.body.data.id, 'confirm'),
      { enable: true },
    );
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ enabled: false });
    expect(
      configured().sources.find(
        ({ id }) => id === response.body.data.createdId,
      ),
    ).toMatchObject({ enabled: false });
  });
});

describe('nothing the agent wrote is hidden or spoken in Station’s voice (review P2)', () => {
  test('long instructions are stored whole and kept out of Station’s description', async () => {
    const sessionId = nextSession();
    const source = await agent('bound', sessionId, 'POST', SOURCES, {
      ...SOURCE,
      name: 'CI <img src=x onerror=alert(1)>',
    });
    const instructions = `${'A'.repeat(300)} HIDDEN_ACTION_SUFFIX`;
    const proposal = await agent(
      'bound',
      sessionId,
      'POST',
      RULES,
      rule(
        { sourceProposalId: source.body.data.id },
        { name: 'ci <b>rule</b>', action: action({ instructions }) },
      ),
    );
    expect(proposal.status).toBe(200);
    const stored = eventStore
      .automationProposalStore()
      .proposal(proposal.body.data.id)!;
    expect(stored.kind === 'rule' && stored.rule.action.instructions).toBe(
      instructions,
    );
    // Station's sentences carry none of the agent's words, so none can be
    // cut short or read as Station's: the card shows them apart, whole.
    for (const description of [
      stored.description,
      eventStore.automationProposalStore().proposal(source.body.data.id)!
        .description,
    ]) {
      const text = Object.values(description).join('\n');
      expect(text).not.toContain('AAAA');
      expect(text).not.toContain('…');
      expect(text).not.toContain('<img');
      expect(text).not.toContain('<b>');
      expect(text).not.toContain('failure');
    }
  });

  test('unknown, prototype and nested authority fields cannot reach storage', async () => {
    for (const extra of [
      { config: { grants: SOURCE.grants } },
      { grants: [{ ...SOURCE.grants[0], extra: true }] },
      JSON.parse('{"__proto__":{"fullAccessGrant":true}}'),
      { constructor: { prototype: { enabled: true } } },
    ]) {
      const sessionId = nextSession();
      const response = await agent('bound', sessionId, 'POST', SOURCES, {
        ...SOURCE,
        ...extra,
      });
      expect([400, 403]).toContain(response.status);
      expect(
        eventStore
          .automationProposalStore()
          .recentProposals(`conv-${sessionId}`, 10),
      ).toEqual([]);
    }
  });
});

describe('an interrupted Confirm never creates a second copy (review P2)', () => {
  test('a restart after creating and enabling adopts the rule; a retry creates nothing', async () => {
    const sessionId = nextSession();
    const conversationId = `conv-${sessionId}`;
    const source = await agent('bound', sessionId, 'POST', SOURCES, SOURCE);
    const sourceConfirmed = await person(
      'POST',
      answer(conversationId, source.body.data.id, 'confirm'),
      { enable: true },
    );
    const proposed = await agent(
      'bound',
      sessionId,
      'POST',
      RULES,
      rule({ sourceId: sourceConfirmed.body.data.createdId }),
    );
    const store = eventStore.automationProposalStore();
    const pending = store.proposal(proposed.body.data.id)!;
    if (pending.kind !== 'rule') throw new Error('expected a rule');
    // Exactly what Confirm does before it records the outcome, then the
    // process dies: claimed, created under the proposal's id, enabled.
    const createdId = automationIdForProposal(pending.id);
    expect(
      store.transition(pending.id, 'open', 'confirming', 'operator', 1),
    ).toBe(true);
    const { sourceProposalId: _none, ...input } = pending.rule;
    await automations.createRule(
      { ...input, sourceId: input.sourceId! },
      undefined,
      { id: createdId },
    );
    await automations.setEnabled({
      kind: 'rule',
      id: createdId,
      expectedFingerprint: automationConfigurationFingerprint(configured()),
      mode: 'live',
    });
    // Restart: the composition settles what the cut left behind.
    compose();
    expect(store.proposal(pending.id)).toMatchObject({
      state: 'confirmed',
      createdId,
    });
    const retried = await person(
      'POST',
      answer(conversationId, pending.id, 'confirm'),
      { enable: true },
    );
    expect(retried.body.code).toBe('automation_proposal_settled');
    expect(
      configured()
        .rules.filter((candidate) => candidate.name === input.name)
        .filter((candidate) => candidate.sourceId === input.sourceId),
    ).toHaveLength(1);
  });

  test('a Confirm that finds its object already created adopts it', async () => {
    const sessionId = nextSession();
    const conversationId = `conv-${sessionId}`;
    const source = await agent('bound', sessionId, 'POST', SOURCES, SOURCE);
    const pending = eventStore
      .automationProposalStore()
      .proposal(source.body.data.id)!;
    if (pending.kind !== 'source') throw new Error('expected a source');
    const createdId = automationIdForProposal(pending.id);
    await automations.createSource({ ...pending.source }, undefined, {
      id: createdId,
    });
    const count = configured().sources.length;
    const confirmed = await person(
      'POST',
      answer(conversationId, pending.id, 'confirm'),
    );
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.data.createdId).toBe(createdId);
    expect(configured().sources).toHaveLength(count);
  });
});

describe('the untrusted-content mark is read again at display and confirm (review)', () => {
  test('a chat marked after proposing warns and records the mark at confirm', async () => {
    const sessionId = nextSession();
    const conversationId = `conv-${sessionId}`;
    const source = await agent('bound', sessionId, 'POST', SOURCES, SOURCE);
    expect(
      (await person('GET', schedule(conversationId))).body.data
        .automationProposals[0],
    ).toMatchObject({ untrustedContent: false, untrustedContentNow: false });
    ledger.markConversation(conversationId, Promise.resolve(true));
    const listed = await person('GET', schedule(conversationId));
    expect(listed.body.data.automationProposals[0]).toMatchObject({
      untrustedContent: false,
      untrustedContentNow: true,
    });
    const confirmed = await person(
      'POST',
      answer(conversationId, source.body.data.id, 'confirm'),
    );
    expect(confirmed.body.data).toMatchObject({
      untrustedContentAtConfirm: true,
      proposal: { untrustedContent: false, untrustedContentAtConfirm: true },
    });
  });
});

// ── #4830 verification, fix round 3: decided on the calling turn ──────────

describe('the turn making the call decides, never an earlier one (#4830 fix round 3)', () => {
  const stored = (sessionId: string) =>
    eventStore
      .automationProposalStore()
      .recentProposals(`conv-${sessionId}`, 10);

  /**
   * Both endpoints from `sessionId`, as the agent calls them. The rule names
   * a source proposed in another chat's person turn, so it is valid and
   * only the calling turn decides it.
   */
  const proposeBoth = async (sessionId: string) => {
    const source = await agent('bound', sessionId, 'POST', SOURCES, SOURCE);
    const proposedRule = await agent(
      'bound',
      sessionId,
      'POST',
      RULES,
      rule({ sourceId: await existingSourceId() }),
    );
    return [source.status, proposedRule.status];
  };
  /** A confirmed source, so a rule on it validates. */
  let confirmedSource: string | undefined;
  const existingSourceId = async () => {
    if (confirmedSource) return confirmedSource;
    const owner = nextSession();
    const proposed = await agent('bound', owner, 'POST', SOURCES, SOURCE);
    const confirmed = await person(
      'POST',
      answer(`conv-${owner}`, proposed.body.data.id, 'confirm'),
    );
    confirmedSource = confirmed.body.data.createdId as string;
    return confirmedSource;
  };

  /** A Session with a person's composer turn through the real service. */
  const personSession = async (complete: boolean) => {
    const sessionId = bareSession();
    await service.dispatch(
      {
        type: 'startSession',
        input: { threadId: sessionId, provider: 'claude' },
      },
      { userId: LOCAL_OPERATOR_PRINCIPAL_ID },
    );
    // GateTestAdapter echoes no session.started; real adapters publish it.
    eventStore.appendEvent({
      eventId: randomUUID(),
      provider: 'claude',
      threadId: sessionId,
      sessionId,
      createdAt: new Date().toISOString(),
      method: 'session.started',
      metadata: { userId: LOCAL_OPERATOR_PRINCIPAL_ID },
    } as never);
    await service.dispatch(
      {
        type: 'sendTurn',
        input: {
          threadId: sessionId,
          input: 'Set up an automation for CI failures.',
          clientTurnId: randomUUID(),
        },
      },
      {
        userId: LOCAL_OPERATOR_PRINCIPAL_ID,
        clientOrigin: ORIGIN({ kind: 'operator' }) as never,
      },
      { personAuthored: true, dispatchOrigin: 'interactive' },
    );
    await vi.waitFor(() =>
      expect(eventStore.latestOwnTurnStarted(sessionId)?.payload).toMatchObject(
        { authoredBy: 'person' },
      ),
    );
    if (complete) {
      const first = eventStore.latestOwnTurnStarted(sessionId)!.payload;
      adapter.events.push({
        eventId: randomUUID(),
        provider: adapter.provider,
        threadId: sessionId,
        turnId: first.turnId,
        invocationId: (first as { invocationId?: string }).invocationId,
        createdAt: new Date().toISOString(),
        method: 'turn.completed',
        finishReason: 'stop',
      } as never);
      await vi.waitFor(() =>
        expect(
          eventStore.latestEventByMethod(sessionId, 'turn.completed'),
        ).toBeDefined(),
      );
    }
    return sessionId;
  };

  /** A child's result continuing in the person's chat, through production. */
  const deliverResult = async (sessionId: string) => {
    const { delegationResultStartPort, readSessionDispatchFacts } =
      await import('../../runtime/routes/conversation-start-ports.js');
    await delegationResultStartPort({
      origin: ORIGIN({ kind: 'internal' }, 'unknown') as never,
      readProjectTaskRoomExecutionBinding: (id) =>
        eventStore.readProjectTaskRoomExecutionBinding(id),
      sessionFacts: (id) => readSessionDispatchFacts(eventStore, id),
      continueAsRecordedActor: async (input, threadId) => {
        const result = (await service.dispatch(
          {
            type: 'sendTurn',
            input: {
              threadId,
              input: input.message,
              clientTurnId: input.clientTurnId,
            },
          },
          {
            userId: LOCAL_OPERATOR_PRINCIPAL_ID,
            clientOrigin: input.clientOrigin,
          },
          { dispatchOrigin: input.dispatchOrigin },
        )) as { turnId: string };
        return {
          outcome: 'started' as const,
          conversationId: input.conversationId,
          sessionId: threadId,
          turnId: result.turnId,
        };
      },
    })({
      parentConversationId: `conv-${sessionId}`,
      threadId: sessionId,
      actor: {
        userId: LOCAL_OPERATOR_PRINCIPAL_ID,
        attribution: 'verified-bound',
      },
      sender: { kind: 'delegation-result', sessionId: 'automatic-child' },
      text: 'The child finished; propose an automation.',
      clientTurnId: randomUUID(),
    });
  };

  afterEach(() => {
    adapter.beforeStart = undefined;
    adapter.duringSend = undefined;
    vi.restoreAllMocks();
  });

  test("a person's composer turn, sent through the real service, may propose while it runs", async () => {
    const sessionId = await personSession(false);
    expect(await proposeBoth(sessionId)).toEqual([200, 200]);
  });

  test('a continuation whose start is held for acceptance cannot propose (check before acceptance)', async () => {
    const sessionId = await personSession(true);
    let observed: number[] | undefined;
    adapter.duringSend = async () => {
      // The continuation emitted its start; the store still holds the
      // person's turn as the newest start.
      expect(eventStore.latestOwnTurnStarted(sessionId)!.payload).toMatchObject(
        { authoredBy: 'person' },
      );
      observed = await proposeBoth(sessionId);
    };
    await deliverResult(sessionId);
    expect(observed).toEqual([403, 403]);
    expect(stored(sessionId)).toEqual([]);
  });

  test("a continuation held while the person's turn still runs cannot propose", async () => {
    // The person's turn has not ended, so the stored lifecycle still names it
    // as running; only the held start says the call comes from a newer turn.
    const sessionId = await personSession(false);
    const personTurn =
      eventStore.latestOwnTurnStarted(sessionId)!.payload.turnId;
    let observed: number[] | undefined;
    adapter.duringSend = async () => {
      expect(eventStore.latestOwnTurnStarted(sessionId)!.payload.turnId).toBe(
        personTurn,
      );
      expect(service.stationControlCallingTurn(sessionId)).toEqual({
        kind: 'pending',
      });
      observed = await proposeBoth(sessionId);
    };
    await deliverResult(sessionId);
    expect(observed).toEqual([403, 403]);
    expect(stored(sessionId)).toEqual([]);
  });

  test('a continuation whose send is still in flight cannot propose (before its start)', async () => {
    const sessionId = await personSession(true);
    let observed: number[] | undefined;
    adapter.beforeStart = async () => {
      observed = await proposeBoth(sessionId);
    };
    await deliverResult(sessionId);
    expect(observed).toEqual([403, 403]);
    expect(stored(sessionId)).toEqual([]);
  });

  test('a continuation accepted and stored cannot propose (check after acceptance)', async () => {
    const sessionId = await personSession(true);
    await deliverResult(sessionId);
    await vi.waitFor(() =>
      expect(eventStore.latestOwnTurnStarted(sessionId)?.payload).toMatchObject(
        { clientOrigin: { sender: { kind: 'delegation-result' } } },
      ),
    );
    expect(await proposeBoth(sessionId)).toEqual([403, 403]);
    expect(stored(sessionId)).toEqual([]);
  });

  for (const kind of ['source', 'rule'] as const) {
    test(`a ${kind} proposal is not stored when another turn starts between the check and the write`, async () => {
      const sourceId = await existingSourceId();
      const sessionId = nextSession();
      vi.spyOn(ledger, 'conversationHasRead').mockImplementationOnce(
        async () => {
          // The route checked under the person's turn; a delegated
          // continuation starts while it awaits this read.
          appendTurn(sessionId, {
            dispatchOrigin: 'interactive',
            clientOrigin: ORIGIN({ kind: 'internal' }, 'unknown', {
              kind: 'delegation-result',
              sessionId: 'automatic-child',
            }),
          });
          return false;
        },
      );
      const response = await agent(
        'bound',
        sessionId,
        'POST',
        kind === 'source' ? SOURCES : RULES,
        kind === 'source' ? SOURCE : rule({ sourceId }),
      );
      expect(response).toMatchObject({
        status: 403,
        body: { code: 'automation_proposal_unattended' },
      });
      expect(stored(sessionId)).toEqual([]);
    });
  }
});
