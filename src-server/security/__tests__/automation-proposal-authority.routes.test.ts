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

import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
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
import {
  AUTOMATION_PROPOSAL_UNTRUSTED_COPY,
  automationStartedReads,
  sessionStartedByAutomation,
} from '../../services/automation/automation-proposals.js';
import { AutomationStore } from '../../services/automation/automation-store.js';
import {
  LOCAL_OPERATOR_PRINCIPAL_ID,
  principalForRecordedSessionOwner,
} from '../../services/identity/principal-resolver.js';
import type { EventBus } from '../../services/orchestration/event-bus.js';
import { EventStore } from '../../services/orchestration/event-store.js';
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
  /** Tasks the stubbed Task graph reads, by id. */
  tasks: new Map<string, { createdBy: string }>(),
};

const PROJECTS = new Map([
  ['local-project-a', 'project-a'],
  ['local-project-b', 'project-b'],
]);
const AGENTS = new Map<string, string | null>([
  ['writer', 'project-a'],
  ['elsewhere', 'project-b'],
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

let baseUrl: string;
let port: number;
let eventStore: EventStore;
let automations: AutomationStore;
let ledger: UntrustedContentLedger;
let refusals: string[];
let close: () => Promise<void>;

beforeAll(async () => {
  __resetStationServerSelfAttestationForTests();
  const home = makeTempDir('station-automation-proposals-');
  eventStore = new EventStore(join(home, 'orchestration.sqlite'));
  automations = new AutomationStore(home);
  ledger = new UntrustedContentLedger();
  refusals = [];
  const composition = composeAgentSchedule({
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
      if (!AGENTS.has(slug)) throw new Error('no such agent');
      return AGENTS.get(slug) ?? undefined;
    },
    automationProposals: {
      store: eventStore.automationProposalStore(),
      automations,
      projectSlugForId: (id) => PROJECTS.get(id),
      projectName: (id) => (id === 'local-project-a' ? 'Project A' : undefined),
      startedByAutomation: (sessionId) =>
        sessionStartedByAutomation(
          automationStartedReads(
            eventStore,
            (taskId) => facts.tasks.get(taskId) ?? null,
          ),
          sessionId,
        ),
      untrustedContent: async (conversationId) =>
        (await ledger.conversationHasRead(conversationId)) ||
        ledger.hasDescendantRead(conversationId),
      operator: async (request) =>
        facts.operator &&
        getRuntimeAuthenticatedRequestPrincipal(request)?.authority ===
          'operator-credential'
          ? { id: 'operator', assertCurrent: async () => {} }
          : undefined,
    },
    logger: quietLogger(),
  });
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
  facts.tasks.clear();
});

type Channel = 'bound' | 'delegated-custody';

let counter = 0;
const nextSession = (prefix = 'op-') => `${prefix}${++counter}`;

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

describe('work an automation started cannot propose automations (§5 Never)', () => {
  const refusedAsUnattended = async (
    sessionId: string,
    refusal: Record<string, string>,
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

  test("a turn an automation sent (a rule's action or a scheduled run) is refused", async () => {
    const sessionId = nextSession();
    eventStore.appendEvent({
      eventId: `${sessionId}-turn`,
      provider: 'claude',
      threadId: sessionId,
      createdAt: '2026-11-12T00:00:00.000Z',
      method: 'turn.started',
      turnId: 'turn-1',
      dispatchOrigin: 'automation',
    } as never);
    await refusedAsUnattended(sessionId, {
      code: 'automation_proposal_unattended',
      error: AUTOMATION_PROPOSAL_COPY.startedByAutomation,
    });
  });

  test("a Session bound to an automation rule's Task is refused, whatever its turn", async () => {
    const sessionId = nextSession();
    facts.tasks.set('task-auto', { createdBy: 'automation-rule' });
    expect(
      await eventStore.bindProjectTaskRoomExecution({
        projectId: 'local-project-a',
        taskId: 'task-auto',
        sessionId,
      }),
    ).toEqual({ kind: 'bound' });
    // A later check-back it scheduled for itself is Task-dispatch work.
    eventStore.appendEvent({
      eventId: `${sessionId}-turn`,
      provider: 'claude',
      threadId: sessionId,
      createdAt: '2026-11-12T00:00:00.000Z',
      method: 'turn.started',
      turnId: 'turn-2',
      dispatchOrigin: 'task-dispatch',
    } as never);
    await refusedAsUnattended(sessionId, {
      code: 'automation_proposal_unattended',
      error: AUTOMATION_PROPOSAL_COPY.startedByAutomation,
    });
  });

  test('a Session that acts for no one is refused', async () => {
    // The central guard answers first: a `self` tool needs a recorded owner.
    // The route refuses the same again (`unattendedNoOwner`).
    await refusedAsUnattended(nextSession('anon-'), {
      code: 'station_control_role_required',
    });
    expect(refusals).toContain('station_control_role_required');
  });

  test("a person's own turn in a Task they dispatched may propose", async () => {
    const sessionId = nextSession();
    facts.tasks.set('task-person', { createdBy: 'user' });
    await eventStore.bindProjectTaskRoomExecution({
      projectId: 'local-project-a',
      taskId: 'task-person',
      sessionId,
    });
    eventStore.appendEvent({
      eventId: `${sessionId}-turn`,
      provider: 'claude',
      threadId: sessionId,
      createdAt: '2026-11-12T00:00:00.000Z',
      method: 'turn.started',
      turnId: 'turn-1',
      dispatchOrigin: 'interactive',
    } as never);
    expect(
      (await agent('bound', sessionId, 'POST', SOURCES, SOURCE)).status,
    ).toBe(200);
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
