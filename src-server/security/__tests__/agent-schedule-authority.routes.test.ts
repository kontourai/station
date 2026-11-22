/**
 * Agent wake-ups and job proposals through the REAL boundary: a listening
 * server with the production runtime security boundary, the production
 * station-control guard, and the production agent-schedule composition
 * (`composeAgentSchedule`: its person gate, fire-time scope decision,
 * routes and the scheduler's proposal approval) over a real SQLite store,
 * handing due wake-ups to a REAL thread inbox (its own refusals and
 * capacity) on a real SQLite inbox store. The production HTTP MCP route
 * serves the real tool registrations, with real token mints per delivery
 * channel. Stubbed: the orchestration reads (who may read or send to a
 * conversation, set per test), the dispatch scope's records, the inbox's
 * turn starts (every conversation reads busy, so nothing is started), and
 * the scheduler service.
 *
 * Session ids name what the server records for them: `op-` is owned by the
 * operator, `host-` runs unconfined; each session's conversation is
 * `conv-<session id>`.
 */

import { writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { serve } from '@hono/node-server';
import {
  AGENT_JOB_PROPOSAL_MAX_CREATED_PER_WINDOW,
  AGENT_SCHEDULE_RATE_WINDOW_MS,
  AGENT_WAKE_UP_MAX_CREATED_PER_WINDOW,
  AGENT_WAKE_UP_MAX_HORIZON_MS,
  AGENT_WAKE_UP_MAX_PENDING_PER_CONVERSATION,
  AGENT_WAKE_UP_NOTE_MAX_CHARS,
} from '@kontourai/station-contracts/agent-schedule';
import type { SchedulerAutomationTarget } from '@kontourai/station-contracts/scheduler';
import {
  getRun as sdkGetRun,
  listJobs as sdkListJobs,
  listRuns as sdkListRuns,
  getJobLogs as sdkLogs,
  previewSchedule as sdkPreview,
  getSchedulerStats as sdkStats,
  getSchedulerStatus as sdkStatus,
} from '@kontourai/station-sdk/client';
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
import { FileStorageAdapter } from '../../domain/file-storage-adapter.js';
import { createUnattendedGrantRoutes } from '../../routes/agents/unattended-grants-routes.js';
import { createStationControlMcpRoutes } from '../../routes/mcp/station-control-mcp-route.js';
import { createNotificationRoutes } from '../../routes/operations/notifications.js';
import {
  createSchedulerReadProjection,
  createSchedulerRoutes,
} from '../../routes/operations/scheduler.js';
import {
  createAgentScheduleRoutes,
  WAKE_UP_NEEDS_APPROVAL_COPY,
} from '../../routes/orchestration/agent-schedule.js';
import { createCoordinatorRoutes } from '../../routes/orchestration/coordinator.js';
import { resolveDispatchActor } from '../../routes/orchestration/orchestration.js';
import { createRunRoutes } from '../../routes/orchestration/runs.js';
import { createDiagnosticsRoutes } from '../../routes/system/diagnostics.js';
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
import {
  type AgentScheduleComposition,
  admitWakeUpAtFire,
  composeAgentSchedule,
} from '../../runtime/routes/agent-schedule-composition.js';
import { UnattendedGrantStore } from '../../services/agents/unattended-grant-store.js';
import { deploymentAccountPrincipal } from '../../services/identity/deployment-authentication-service.js';
import {
  LOCAL_OPERATOR_PRINCIPAL_ID,
  principalForRecordedSessionOwner,
} from '../../services/identity/principal-resolver.js';
import { createServerLogReader } from '../../services/infra/server-log-reader.js';
import {
  installServerLogSink,
  resetServerLogSinkForTests,
} from '../../services/infra/server-log-store.js';
import { NotificationService } from '../../services/notifications/notification-service.js';
import {
  type AgentScheduleStore,
  AgentWakeUpDelivery,
  createSqliteAgentScheduleStore,
  wakeUpClientTurnId,
  wakeUpMessage,
} from '../../services/orchestration/agent-schedule.js';
import { createSqliteCoordinatorStore } from '../../services/orchestration/coordinator-session.js';
import { EventBus } from '../../services/orchestration/event-bus.js';
import { RunService } from '../../services/orchestration/run-service.js';
import {
  createSqliteThreadInboxStore,
  ThreadInboxDelivery,
  type ThreadInboxStore,
} from '../../services/orchestration/thread-inbox.js';
import { ProjectManifestStore } from '../../services/projects/project-manifest-store.js';
import {
  type ProjectMembershipAuthority,
  ProjectMembershipService,
} from '../../services/projects/project-membership-service.js';
import { ProjectMembershipStore } from '../../services/projects/project-membership-store.js';
import { createProjectPrincipalPermission } from '../../services/projects/project-principal-permission.js';
import { ProjectService } from '../../services/projects/project-service.js';
import type { ScheduledConversationRunInput } from '../../services/scheduling/scheduled-conversation-runs.js';
import { conversationAutomationsFrom } from '../../services/scheduling/scheduled-conversation-runs.js';
import { createSchedulerLedger } from '../../services/scheduling/scheduler-ledger.js';
import { SchedulerService } from '../../services/scheduling/scheduler-service.js';
import { stationControlScopeRefusal } from '../../tools/station-control-policy.js';
import { STATION_CONTROL_CALLER_TOKEN_HEADER } from '../../tools/station-control-shared.js';
import {
  getInternalApiToken,
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_PROXY_CALLER_HEADER,
} from '../../utils/internal-api-token.js';
import type { Logger } from '../../utils/logger.js';
import { createLogger } from '../../utils/logger.js';
import { getRuntimeAuthenticatedRequestPrincipal } from '../runtime-request-security.js';
import { createStationControlAuthorityGuard } from '../station-control-authority-guard.js';
import { __resetStationServerSelfAttestationForTests } from '../station-server-scope.js';

const OPERATOR_CREDENTIAL = 'test-only-operator-credential-agent-schedule';
const OPERATOR = principalForRecordedSessionOwner(LOCAL_OPERATOR_PRINCIPAL_ID);

const resolveRecord: StationControlCallerRecordResolver = (sessionId) => ({
  principal: {
    id: LOCAL_OPERATOR_PRINCIPAL_ID,
    source: 'session-owner' as const,
  },
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

/** Facts the stubbed records answer, set per test. */
const facts = {
  /** Conversations whose sessions run unconfined now (beyond `host-` ids). */
  hostNow: new Set<string>(),
  /** Conversations the person may not send to (or act on). */
  mayNotSend: new Set<string>(),
  /** Conversations the person may not read as a whole. */
  mayNotRead: new Set<string>(),
  /** What the scheduler lists as targeting each conversation. */
  automations: new Map<string, string[]>(),
  /** Agents and their Project slug (`null`: global); absent: no such agent. */
  agents: new Map<string, string | null>([
    ['writer', 'project-a'],
    ['global-writer', null],
    ['elsewhere', 'project-b'],
  ]),
};

const sessionOf = (conversationId: string) =>
  conversationId.startsWith('conv-')
    ? conversationId.slice('conv-'.length)
    : conversationId;

/** The dispatch scope's records, as the stubbed sessions read. */
const scope: StationControlDispatchScope = {
  target: (ref) => {
    const thread =
      ref.kind === 'thread'
        ? ref.threadId
        : ref.kind === 'conversation'
          ? sessionOf(ref.conversationId)
          : undefined;
    if (thread !== undefined)
      return {
        ownerId: LOCAL_OPERATOR_PRINCIPAL_ID,
        scope: { kind: 'project', id: 'local-project-a' },
        host: thread.startsWith('host-') || facts.hostNow.has(`conv-${thread}`),
        remote: false,
        ownerHoldsAction: true,
      };
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

const clock = { now: 1_800_000_000_000 };

interface World {
  baseUrl: string;
  port: number;
  store: AgentScheduleStore;
  inboxStore: ThreadInboxStore;
  inbox: ThreadInboxDelivery;
  composition: AgentScheduleComposition;
  pictureStore: ReturnType<typeof createSqliteCoordinatorStore>;
  refusals: string[];
  /** Every hand-off to the inbox, with the inbox's own answer. */
  submitted: Array<{
    conversationId: string;
    clientTurnId: string;
    payload: any;
    outcome: string;
  }>;
  addJob: ReturnType<typeof vi.fn>;
  close(): Promise<void>;
}

async function boot(options: {
  hosted: boolean;
  /** A real scheduler instead of the create-only stub. */
  scheduler?: SchedulerService;
  projectAccess?: Pick<
    Parameters<typeof composeAgentSchedule>[0],
    'projectExists' | 'principalMayInProject'
  >;
  notifications?: NotificationService;
  logDirectory?: string;
  diagnosticGrantStore?: UnattendedGrantStore;
  /**
   * The guard's grant-store answer. Production answers false for a job that
   * holds no unattended grants (conversation runs need none); absent, the
   * guard fails closed.
   */
  retargetsGrantedJob?: () => boolean;
  /** Who a person's request resolves to; default the operator. */
  requestUserId?: () => string;
  /**
   * How the auth boundary classifies a person's credential; default the
   * operator's own credential. A paired device (another person's, or one
   * without owner standing) is a `device-credential`.
   */
  credentialAuthority?: 'operator-credential' | 'device-credential';
  /** The pairing store's answer: this device has owner-device standing. */
  ownerStanding?: boolean;
}): Promise<World> {
  const store = createSqliteAgentScheduleStore(new DatabaseSync(':memory:'));
  const pictureDb = new DatabaseSync(':memory:');
  const pictureStore = createSqliteCoordinatorStore(pictureDb as never);
  const inboxStore = createSqliteThreadInboxStore(
    new DatabaseSync(':memory:') as never,
  );
  const inbox = new ThreadInboxDelivery({
    store: inboxStore,
    foldEvents: () => [],
    headSequence: () => 0,
    // Every conversation is busy: entries wait, nothing is started.
    coordinatorBusy: () => true,
    conversationOf: (id) => id,
    currentSessionId: (id) => id,
    mayContinue: (conversationId) => !facts.mayNotSend.has(conversationId),
    inspectDelivery: () => ({ outcome: 'not-received' }),
    start: () => Promise.reject(new Error('no starts in this test')),
    subscribe: () => () => {},
    logger: quietLogger(),
    retryDelaysMs: [3_600_000],
    maxRetries: 0,
    now: () => clock.now,
  });
  const refusals: string[] = [];
  const submitted: World['submitted'] = [];
  const addJob = vi.fn(
    async (opts: { name: string }) => `Job '${opts.name}' created`,
  );
  const composition: AgentScheduleComposition = composeAgentSchedule({
    store,
    threadInbox: options.hosted
      ? undefined
      : {
          submit: (input) => {
            const result = inbox.submit(input);
            submitted.push({ ...input, outcome: result.outcome });
            return result;
          },
        },
    scope,
    orchestration: {
      canUserReadConversation: (conversationId) =>
        !facts.mayNotRead.has(conversationId),
      canUserMutateSession: (threadId) => !facts.mayNotSend.has(threadId),
      currentConversationSessionId: (conversationId) => conversationId,
      readUsageLimitRecovery: async () => undefined,
    },
    hosted: options.hosted,
    isInternalRequest: (request) =>
      getRuntimeAuthenticatedRequestPrincipal(request)?.kind === 'internal',
    // A person's credential request is current; nothing else is a person.
    isRequestPrincipalCurrent: (request) =>
      ['credential', 'internal'].includes(
        getRuntimeAuthenticatedRequestPrincipal(request)?.kind ?? '',
      ),
    requestUserId: options.requestUserId ?? (() => LOCAL_OPERATOR_PRINCIPAL_ID),
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
    ...options.projectAccess,
    agentProject: async (slug) => {
      if (!facts.agents.has(slug)) throw new Error('no such agent');
      return facts.agents.get(slug) ?? undefined;
    },
    conversationAutomations: async (conversationId, c) =>
      options.scheduler
        ? conversationAutomationsFrom(
            await createSchedulerReadProjection(
              options.scheduler,
              composition,
            ).visibleJobs(c),
            conversationId,
          )
        : (facts.automations.get(conversationId) ?? []).map((name) => ({
            name,
            enabled: true,
            consecutiveFailures: 0,
          })),
    logger: quietLogger(),
    now: () => clock.now,
  });
  const app = new Hono();
  configureRuntimeHttp({
    app: app as never,
    logger: quietLogger(),
    eventBus: { emit: vi.fn() } as unknown as EventBus,
    security: {
      verifyCredential: (candidate: string) =>
        candidate === OPERATOR_CREDENTIAL,
      resolveGrantedScope: () =>
        options.diagnosticGrantStore
          ? 'orchestration:read orchestration:operate access:manage'
          : 'orchestration:read orchestration:operate',
      resolveCredentialAuthority: () =>
        options.credentialAuthority ?? 'operator-credential',
      ...(options.ownerStanding
        ? { resolveCredentialOwnerStanding: () => true }
        : {}),
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
      // The composition's own read, as production wires it.
      wakeUpConversation: composition.wakeUpConversation,
      ...(options.retargetsGrantedJob
        ? { retargetsGrantedJob: options.retargetsGrantedJob }
        : {}),
      onRefusal: (refusal) => refusals.push(refusal.code),
    }),
  );
  let resolvePort!: (value: number) => void;
  const listening = new Promise<number>((resolve) => {
    resolvePort = resolve;
  });
  const server = serve(
    { fetch: app.fetch, hostname: '127.0.0.1', port: 0 },
    (info) => resolvePort((info as AddressInfo).port),
  );
  const port = await listening;
  const baseUrl = `http://127.0.0.1:${port}`;
  app.route(
    '',
    createStationControlMcpRoutes({ port, resolveCallerRecord: resolveRecord }),
  );
  app.route(
    '/api/orchestration',
    createAgentScheduleRoutes(composition.routeDeps),
  );
  app.route(
    '/api/orchestration',
    createCoordinatorRoutes({
      store: options.hosted ? undefined : pictureStore,
      preview: { select: ({ enabled }) => enabled() },
      person: composition.person,
      dispatchActor: () => ({ userId: LOCAL_OPERATOR_PRINCIPAL_ID }),
      picturePreview: { select: ({ enabled }) => enabled() },
      isInternalRequest: (request) =>
        getRuntimeAuthenticatedRequestPrincipal(request)?.kind === 'internal',
      resolvePictureCaller: (request) =>
        resolveStationControlCallerForRequest(request, resolveRecord),
      agentMayRead: (caller, conversationId) =>
        !stationControlScopeRefusal(
          caller,
          scope.target(
            { kind: 'conversation', conversationId, remote: false },
            'view',
          ),
          (id) => id === LOCAL_OPERATOR_PRINCIPAL_ID,
        ),
      now: () => clock.now,
    }),
  );
  app.route(
    '/scheduler',
    createSchedulerRoutes(
      options.scheduler ??
        ({ addJob, listJobs: async () => [] } as unknown as SchedulerService),
      quietLogger(),
      {
        jobProposals: composition.jobProposals,
        admitAutomationTarget: composition.admitAutomationTarget,
        admitAutomationJob: composition.admitAutomationJob,
        mayReadAutomationJob: composition.mayReadAutomationJob,
        mayReadAutomationRun: composition.mayReadAutomationRun,
        jobOwner: composition.jobOwner,
        ...(options.projectAccess
          ? { maySetProjectJob: composition.maySetProjectJob }
          : {}),
      },
    ),
  );
  if (options.logDirectory)
    app.route(
      '/api/diagnostics',
      createDiagnosticsRoutes(
        { generateBundle: async () => ({}) } as never,
        quietLogger(),
        createServerLogReader({ directory: options.logDirectory }),
        {
          agentGrant: (sessionId) =>
            options.diagnosticGrantStore?.isGranted(
              JSON.stringify({ kind: 'diagnostics-session', sessionId }),
              'station-control:read_logs',
            ) ?? false,
        },
      ),
    );
  if (options.diagnosticGrantStore)
    app.route(
      '/api/agents/unattended-grants',
      createUnattendedGrantRoutes(options.diagnosticGrantStore, {
        operatorIdentityForRequest: (c) =>
          getRuntimeAuthenticatedRequestPrincipal(c.req.raw)?.authority ===
          'operator-credential'
            ? LOCAL_OPERATOR_PRINCIPAL_ID
            : undefined,
      }),
    );
  if (options.notifications)
    app.route(
      '/notifications',
      createNotificationRoutes(options.notifications, {
        readAuthorityForRequest: () =>
          ({ mode: 'personal', userId: LOCAL_OPERATOR_PRINCIPAL_ID }) as never,
        canReadSession: (sessionId) => !facts.mayNotRead.has(sessionId),
      }),
    );
  if (options.scheduler) {
    const runService = new RunService(
      {
        listAgentRuns: async () => [],
        readAgentRun: async () => null,
      } as never,
      options.scheduler,
      { list: () => ({ kind: 'available', runs: [] }) } as never,
      { list: () => ({ kind: 'available', runs: [] }) } as never,
    );
    app.route(
      '/api/runs',
      createRunRoutes(
        runService,
        quietLogger(),
        () => ({ mode: 'personal' }) as never,
        async (c) =>
          composition.scheduleRunReadFilter(
            c,
            await options.scheduler!.listJobs(),
          ),
      ),
    );
  }
  return {
    baseUrl,
    port,
    store,
    inboxStore,
    inbox,
    composition,
    pictureStore,
    refusals,
    submitted,
    addJob,
    close: async () => {
      composition.delivery?.stop();
      pictureDb.close();
      inbox.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

let world: World;
let store: AgentScheduleStore;
let delivery: AgentWakeUpDelivery;
let baseUrl: string;
let port: number;
let refusals: string[];
let submitted: World['submitted'];
let addJob: World['addJob'];

/** Another delivery over the same store and inbox: a restart. */
function newDelivery(now: () => number) {
  return new AgentWakeUpDelivery({
    store,
    admit: (record) => admitWakeUpAtFire(scope, record),
    submit: (input) => {
      const result = world.inbox.submit(input);
      submitted.push({ ...input, outcome: result.outcome });
      return result;
    },
    logger: quietLogger(),
    now,
  });
}

beforeAll(async () => {
  __resetStationServerSelfAttestationForTests();
  world = await boot({ hosted: false });
  ({ store, baseUrl, port, refusals, submitted, addJob } = world);
  delivery = world.composition.delivery!;
  process.env.STATION_API_BASE = baseUrl;
});

afterAll(async () => {
  await world.close();
  delete process.env.STATION_API_BASE;
  __resetStationServerSelfAttestationForTests();
});

beforeEach(() => {
  __resetStationControlMcpTokensForTests();
  refusals.length = 0;
  submitted.length = 0;
  addJob.mockClear();
  facts.hostNow.clear();
  facts.mayNotSend.clear();
  facts.mayNotRead.clear();
  facts.automations.clear();
});

type Channel = 'bound' | 'delegated-custody' | 'bearer-exposed';

/** The credential a tool of this channel forwards on its REST calls. */
function forwardedCaller(
  channel: Channel,
  sessionId: string,
  atPort = port,
): string {
  switch (channel) {
    case 'bound':
      return mintStationControlMcpToken(sessionId, 'sdk-in-process').token;
    case 'delegated-custody':
      return mintStationControlMcpHeaderAuth(atPort, sessionId).token;
    case 'bearer-exposed':
      return mintStationControlMcpToken(sessionId, 'url-token').token;
  }
}

let counter = 0;
const nextSession = (prefix = 'op-') => `${prefix}${++counter}`;

async function agent(
  channel: Channel,
  sessionId: string,
  method: string,
  path: string,
  body?: unknown,
  at: { baseUrl: string; port: number } = { baseUrl, port },
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${at.baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
      [INTERNAL_PROXY_CALLER_HEADER]: 'local',
      [STATION_CONTROL_CALLER_TOKEN_HEADER]: forwardedCaller(
        channel,
        sessionId,
        at.port,
      ),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

async function personRequest(
  method: string,
  path: string,
  body?: unknown,
  at = baseUrl,
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${at}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${OPERATOR_CREDENTIAL}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

const WAKE_UPS = '/api/orchestration/station-control/wake-ups';
const PROPOSALS = '/api/orchestration/station-control/job-proposals';
const FIVE_MINUTES = 5 * 60_000;
const schedulePath = (conversationId: string) =>
  `/api/orchestration/agent-schedule/${conversationId}`;

describe('coordinator working picture authority', () => {
  test('only the bound designated caller writes, and a revoked source disappears', async () => {
    const sessionId = nextSession();
    world.pictureStore.designate({
      conversationId: `conv-${sessionId}`,
      actor: { userId: LOCAL_OPERATOR_PRINCIPAL_ID },
      replace: true,
      now: clock.now,
    });
    const path = '/api/orchestration/station-control/coordinator-picture';
    const entry = {
      conversationId: 'conv-work',
      status: 'waiting',
      summary: 'Needs review',
    };
    expect(
      (await agent('bearer-exposed', sessionId, 'POST', path, entry)).status,
    ).not.toBe(200);
    expect(
      (await agent('bound', nextSession(), 'POST', path, entry)).status,
    ).toBe(404);
    expect((await agent('bound', sessionId, 'POST', path, entry)).status).toBe(
      200,
    );
    expect(
      (await personRequest('GET', '/api/orchestration/coordinator/picture'))
        .body,
    ).toMatchObject({ data: { items: [{ summary: 'Needs review' }] } });
    facts.mayNotRead.add('conv-work');
    expect((await agent('bound', sessionId, 'GET', path)).body).toMatchObject({
      data: { items: [] },
    });
    expect(
      (await personRequest('GET', '/api/orchestration/coordinator/picture'))
        .body,
    ).toMatchObject({ data: { items: [] } });
  });
});

describe('schedule_wake_up: the caller’s own chat, bounded', () => {
  for (const channel of [
    'bound',
    'delegated-custody',
    'bearer-exposed',
  ] as const)
    test(`a ${channel} caller schedules one into its own conversation`, async () => {
      const sessionId = nextSession();
      const response = await agent(channel, sessionId, 'POST', WAKE_UPS, {
        delayMs: FIVE_MINUTES,
        note: 'check the build',
      });
      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({
        conversationId: `conv-${sessionId}`,
        state: 'pending',
        note: 'check the build',
        dueAt: new Date(clock.now + FIVE_MINUTES).toISOString(),
      });
      // The sender is never returned.
      expect(response.body.data.actor).toBeUndefined();
    });

  test('a body naming another conversation is refused by the guard, before the route', async () => {
    const sessionId = nextSession();
    const response = await agent(
      'delegated-custody',
      sessionId,
      'POST',
      WAKE_UPS,
      {
        delayMs: FIVE_MINUTES,
        note: 'x',
        conversationId: 'conv-someone-else',
      },
    );
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      code: 'station_control_out_of_scope',
      reason: 'other-conversation',
    });
    // The guard answered (its refusal hook ran); nothing was recorded.
    expect(refusals).toEqual(['station_control_out_of_scope']);
    expect(store.pendingWakeUps(`conv-${sessionId}`)).toEqual([]);
    expect(store.pendingWakeUps('conv-someone-else')).toEqual([]);
  });

  test('a body naming its own conversation is fine', async () => {
    const sessionId = nextSession();
    const response = await agent(
      'delegated-custody',
      sessionId,
      'POST',
      WAKE_UPS,
      {
        delayMs: FIVE_MINUTES,
        note: 'x',
        conversationId: `conv-${sessionId}`,
      },
    );
    expect(response.status).toBe(200);
  });

  test('cancelling another conversation’s wake-up is refused by the guard, and it stays pending', async () => {
    const owner = nextSession();
    const created = await agent('bound', owner, 'POST', WAKE_UPS, {
      delayMs: FIVE_MINUTES,
      note: 'mine',
    });
    const id = created.body.data.id as string;
    for (const channel of ['bound', 'delegated-custody'] as const) {
      refusals.length = 0;
      const response = await agent(
        channel,
        nextSession(),
        'DELETE',
        `${WAKE_UPS}/${id}`,
      );
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({
        code: 'station_control_out_of_scope',
        reason: 'other-conversation',
      });
      expect(refusals).toEqual(['station_control_out_of_scope']);
    }
    expect(store.wakeUp(id)?.state).toBe('pending');
    // An id that names nothing reads exactly the same.
    const unknown = await agent('bound', owner, 'DELETE', `${WAKE_UPS}/nope`);
    expect(unknown.body).toMatchObject({ reason: 'other-conversation' });
    // Its own conversation cancels it.
    const own = await agent(
      'delegated-custody',
      owner,
      'DELETE',
      `${WAKE_UPS}/${id}`,
    );
    expect(own).toEqual({
      status: 200,
      body: { success: true, data: { canceled: true } },
    });
    expect(store.wakeUp(id)).toMatchObject({
      state: 'canceled',
      canceledBy: 'agent',
    });
  });

  test('the horizon: exactly the maximum is accepted, one millisecond more is refused', async () => {
    const sessionId = nextSession();
    const over = await agent('delegated-custody', sessionId, 'POST', WAKE_UPS, {
      delayMs: AGENT_WAKE_UP_MAX_HORIZON_MS + 1,
      note: 'x',
    });
    expect(over.status).toBe(409);
    expect(over.body.code).toBe('wake_up_too_far');
    expect(store.pendingWakeUps(`conv-${sessionId}`)).toEqual([]);
    const at = await agent('delegated-custody', sessionId, 'POST', WAKE_UPS, {
      delayMs: AGENT_WAKE_UP_MAX_HORIZON_MS,
      note: 'x',
    });
    expect(at.status).toBe(200);
    // Literal pins beside the constant.
    expect(AGENT_WAKE_UP_MAX_HORIZON_MS).toBe(86_400_000);
  });

  test('too soon is refused, never moved later', async () => {
    const response = await agent('bound', nextSession(), 'POST', WAKE_UPS, {
      delayMs: 59_999,
      note: 'x',
    });
    expect(response.body.code).toBe('wake_up_too_soon');
  });

  test('the cap: the conversation’s limit is accepted, one more is refused', async () => {
    const sessionId = nextSession();
    expect(AGENT_WAKE_UP_MAX_PENDING_PER_CONVERSATION).toBe(3);
    for (let i = 0; i < AGENT_WAKE_UP_MAX_PENDING_PER_CONVERSATION; i += 1)
      expect(
        (
          await agent('delegated-custody', sessionId, 'POST', WAKE_UPS, {
            delayMs: FIVE_MINUTES,
            note: `n${i}`,
          })
        ).status,
      ).toBe(200);
    const over = await agent('delegated-custody', sessionId, 'POST', WAKE_UPS, {
      delayMs: FIVE_MINUTES,
      note: 'one too many',
    });
    expect(over.status).toBe(409);
    expect(over.body.code).toBe('wake_up_limit_reached');
    expect(store.pendingWakeUps(`conv-${sessionId}`)).toHaveLength(3);
    // Another conversation has its own room.
    expect(
      (
        await agent('delegated-custody', nextSession(), 'POST', WAKE_UPS, {
          delayMs: FIVE_MINUTES,
          note: 'x',
        })
      ).status,
    ).toBe(200);
  });

  test('a note one character over the limit is refused, not cut short', async () => {
    const sessionId = nextSession();
    const over = await agent('bound', sessionId, 'POST', WAKE_UPS, {
      delayMs: FIVE_MINUTES,
      note: 'x'.repeat(AGENT_WAKE_UP_NOTE_MAX_CHARS + 1),
    });
    expect(over.body.code).toBe('wake_up_note_too_long');
    const at = await agent('bound', sessionId, 'POST', WAKE_UPS, {
      delayMs: FIVE_MINUTES,
      note: 'x'.repeat(AGENT_WAKE_UP_NOTE_MAX_CHARS),
    });
    expect(at.body.data.note).toHaveLength(AGENT_WAKE_UP_NOTE_MAX_CHARS);
  });

  test('a caller that is not bound asks the person before scheduling into its own unconfined session', async () => {
    const response = await agent(
      'delegated-custody',
      nextSession('host-'),
      'POST',
      WAKE_UPS,
      {
        delayMs: FIVE_MINUTES,
        note: 'x',
      },
    );
    expect(response.status).toBe(200);
    expect(response.body.data.state).toBe('needs_approval');
    expect(response.body.message).toBe(WAKE_UP_NEEDS_APPROVAL_COPY);
    // A bound caller keeps its own session, armed at once.
    const bound = await agent('bound', nextSession('host-'), 'POST', WAKE_UPS, {
      delayMs: FIVE_MINUTES,
      note: 'x',
    });
    expect(bound.status).toBe(200);
    expect(bound.body.data.state).toBe('pending');
    expect(bound.body.message).toBeUndefined();
  });

  test('list_wake_ups answers only the caller’s own conversation', async () => {
    const mine = nextSession();
    await agent('delegated-custody', mine, 'POST', WAKE_UPS, {
      delayMs: FIVE_MINUTES,
      note: 'a',
    });
    await agent('delegated-custody', nextSession(), 'POST', WAKE_UPS, {
      delayMs: FIVE_MINUTES,
      note: 'b',
    });
    const listed = await agent('delegated-custody', mine, 'GET', WAKE_UPS);
    expect(listed.body.data.map((w: { note: string }) => w.note)).toEqual([
      'a',
    ]);
  });
});

describe('a due wake-up goes to the caller’s own conversation, as its recorded sender', () => {
  test('it is handed to that conversation’s inbox with no stronger sender and an internal origin', async () => {
    const sessionId = nextSession();
    const created = await agent(
      'delegated-custody',
      sessionId,
      'POST',
      WAKE_UPS,
      {
        delayMs: FIVE_MINUTES,
        note: 'check CI',
      },
    );
    const id = created.body.data.id as string;
    delivery.fire(id);
    expect(submitted).toEqual([
      {
        conversationId: `conv-${sessionId}`,
        clientTurnId: wakeUpClientTurnId(id),
        payload: {
          message: wakeUpMessage('check CI'),
          // A copyable credential never launders its owner: the same
          // attribution its own dispatch would carry.
          actor: expect.objectContaining({
            ownerAttribution: 'unattributed-agent',
          }),
          clientOrigin: expect.objectContaining({
            actor: { kind: 'internal' },
          }),
        },
        outcome: 'queued',
      },
    ]);
    expect(store.wakeUp(id)?.state).toBe('sent');
    // A second fire (a timer racing a restart) sends nothing more.
    delivery.fire(id);
    expect(submitted).toHaveLength(1);
  });

  test('a bound caller’s wake-up replays as verified-bound', async () => {
    const created = await agent('bound', nextSession(), 'POST', WAKE_UPS, {
      delayMs: FIVE_MINUTES,
      note: 'x',
    });
    delivery.fire(created.body.data.id);
    expect(submitted[0]?.payload.actor).toMatchObject({
      userId: LOCAL_OPERATOR_PRINCIPAL_ID,
      ownerAttribution: 'verified-bound',
    });
  });

  test('a canceled wake-up never fires', async () => {
    const sessionId = nextSession();
    const created = await agent('bound', sessionId, 'POST', WAKE_UPS, {
      delayMs: FIVE_MINUTES,
      note: 'x',
    });
    await agent(
      'bound',
      sessionId,
      'DELETE',
      `${WAKE_UPS}/${created.body.data.id}`,
    );
    delivery.fire(created.body.data.id);
    expect(submitted).toEqual([]);
  });

  test('durable across restart: a new delivery re-arms what is pending, and a due one goes once', async () => {
    const sessionId = nextSession();
    const created = await agent('bound', sessionId, 'POST', WAKE_UPS, {
      delayMs: FIVE_MINUTES,
      note: 'after restart',
    });
    const id = created.body.data.id as string;
    const restarted = newDelivery(() => clock.now + FIVE_MINUTES + 1);
    try {
      restarted.reconcile();
      await vi.waitFor(() =>
        expect(submitted.map((entry) => entry.clientTurnId)).toContain(
          wakeUpClientTurnId(id),
        ),
      );
      expect(store.wakeUp(id)?.state).toBe('sent');
    } finally {
      restarted.stop();
    }
  });

  test('a restart on a clock a month behind does not send a pending one early', async () => {
    const created = await agent('bound', nextSession(), 'POST', WAKE_UPS, {
      delayMs: FIVE_MINUTES,
      note: 'not yet',
    });
    const id = created.body.data.id as string;
    const behind = newDelivery(() => clock.now - 30 * 24 * 60 * 60_000);
    try {
      behind.reconcile();
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(submitted).toEqual([]);
      expect(store.wakeUp(id)?.state).toBe('pending');
    } finally {
      behind.stop();
    }
  });

  test('a step of the timer maximum that ends before the due time arms again, then sends at due', async () => {
    const created = await agent('bound', nextSession(), 'POST', WAKE_UPS, {
      delayMs: FIVE_MINUTES,
      note: 'stepped',
    });
    const id = created.body.data.id as string;
    const dueAtMs = store.wakeUp(id)!.dueAtMs;
    const maxStep = 2 ** 31 - 1; // setTimeout's maximum delay
    const rest = 10 * 60_000;
    let now = dueAtMs - maxStep - rest;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const stepped = newDelivery(() => now);
    // Reconcile re-arms every pending wake-up in the store; read only this one.
    const sent = () =>
      submitted.filter(
        (entry) => entry.clientTurnId === wakeUpClientTurnId(id),
      );
    try {
      stepped.reconcile();
      now += maxStep;
      vi.advanceTimersByTime(maxStep);
      // The first step ended 10 minutes early: nothing sent. It armed
      // again, or nothing would send at due below.
      expect(sent()).toEqual([]);
      expect(store.wakeUp(id)?.state).toBe('pending');
      now += rest - 1;
      vi.advanceTimersByTime(rest - 1);
      expect(sent()).toEqual([]);
      now += 1;
      vi.advanceTimersByTime(1);
      expect(sent()).toHaveLength(1);
      expect(store.wakeUp(id)?.state).toBe('sent');
    } finally {
      stepped.stop();
      vi.useRealTimers();
    }
  });

  test('one more than a day late after a restart is expired, not sent', async () => {
    const created = await agent('bound', nextSession(), 'POST', WAKE_UPS, {
      delayMs: FIVE_MINUTES,
      note: 'x',
    });
    const id = created.body.data.id as string;
    const late = newDelivery(
      () => clock.now + FIVE_MINUTES + AGENT_WAKE_UP_MAX_HORIZON_MS + 1,
    );
    try {
      late.fire(id);
      expect(submitted).toEqual([]);
      expect(store.wakeUp(id)).toMatchObject({
        state: 'failed',
        reasonCode: 'expired',
      });
    } finally {
      late.stop();
    }
  });
});

describe('the person’s view and Cancel', () => {
  test('the person reads the chat’s wake-ups and cancels one', async () => {
    const sessionId = nextSession();
    const created = await agent('bound', sessionId, 'POST', WAKE_UPS, {
      delayMs: FIVE_MINUTES,
      note: 'x',
    });
    const read = await personRequest(
      'GET',
      `/api/orchestration/agent-schedule/conv-${sessionId}`,
    );
    expect(read.body.data.wakeUps.map((w: { id: string }) => w.id)).toEqual([
      created.body.data.id,
    ]);
    const canceled = await personRequest(
      'POST',
      `/api/orchestration/agent-schedule/conv-${sessionId}/wake-ups/${created.body.data.id}/cancel`,
    );
    expect(canceled.body.data).toEqual({ canceled: true });
    expect(store.wakeUp(created.body.data.id)).toMatchObject({
      canceledBy: 'person',
    });
  });

  test('an agent cannot make a usage-limit banner choice either', async () => {
    for (const action of ['resume-at-reset', 'hold']) {
      const response = await agent(
        'bound',
        nextSession(),
        'POST',
        `/api/orchestration/sessions/op-limited/usage-limit/${action}`,
      );
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('station_control_route_unmapped');
    }
  });

  test('an agent may read only its own conversation schedule', async () => {
    const sessionId = nextSession();
    const own = await agent(
      'bound',
      sessionId,
      'GET',
      `/api/orchestration/agent-schedule/conv-${sessionId}`,
    );
    expect(own.status).toBe(200);
    const other = await agent(
      'bound',
      sessionId,
      'GET',
      '/api/orchestration/agent-schedule/conv-victim',
    );
    expect(other.status).toBe(403);
  });
});

const PROPOSED = {
  name: 'nightly-digest',
  schedule: { kind: 'cron', expr: '0 9 * * *', timezone: 'Europe/Berlin' },
  prompt: 'Summarize yesterday.',
  agent: 'writer',
};

/** The job a proposal from this session records: it runs in that chat. */
const proposedFor = (sessionId: string) => ({
  ...PROPOSED,
  target: { kind: 'conversation', conversationId: `conv-${sessionId}` },
});

describe('propose_job: a person approves under their own credential, or declines', () => {
  async function propose(channel: Channel = 'delegated-custody') {
    const sessionId = nextSession();
    const response = await agent(channel, sessionId, 'POST', PROPOSALS, {
      ...PROPOSED,
      rationale: 'You asked for a daily digest.',
    });
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      id: expect.any(String),
      state: 'open',
    });
    return { sessionId, id: response.body.data.id as string };
  }

  test('the agent learns only the id and state, and the person sees the card', async () => {
    const { sessionId, id } = await propose();
    const read = await personRequest(
      'GET',
      `/api/orchestration/agent-schedule/conv-${sessionId}`,
    );
    expect(read.body.data.jobProposals).toEqual([
      expect.objectContaining({
        id,
        job: proposedFor(sessionId),
        state: 'open',
      }),
    ]);
    expect(addJob).not.toHaveBeenCalled();
  });

  test('a proposal that trusts every tool is refused by the guard as a person’s step', async () => {
    const response = await agent(
      'delegated-custody',
      nextSession(),
      'POST',
      PROPOSALS,
      {
        ...PROPOSED,
        trustAllTools: true,
      },
    );
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('station_control_person_only');
    expect(refusals).toEqual(['station_control_person_only']);
  });

  test('Approve: the person’s scheduler create, naming the proposal, creates exactly that job and records it approved', async () => {
    const { sessionId: proposer, id } = await propose();
    const response = await personRequest('POST', '/scheduler/jobs', {
      ...proposedFor(proposer),
      proposalId: id,
    });
    expect(response.status).toBe(200);
    expect(addJob).toHaveBeenCalledTimes(1);
    // The proposal id is the route's, never the scheduler's. The job runs in
    // the proposing chat (any engine), acting as the approving person.
    expect(addJob.mock.calls[0]?.[0]).toEqual({
      ...proposedFor(proposer),
      createdBy: { userId: LOCAL_OPERATOR_PRINCIPAL_ID },
    });
    expect(store.jobProposal(id)).toMatchObject({ state: 'approved' });
    // The chat lists the job it now has, and no longer the open card.
    const { sessionId } = {
      sessionId: store.jobProposal(id)!.conversationId.slice('conv-'.length),
    };
    const read = await personRequest(
      'GET',
      `/api/orchestration/agent-schedule/conv-${sessionId}`,
    );
    expect(read.body.data.jobs).toEqual([
      { proposalId: id, name: PROPOSED.name },
    ]);
    expect(read.body.data.jobProposals).toEqual([]);
    // Approving twice creates nothing more.
    const again = await personRequest('POST', '/scheduler/jobs', {
      ...proposedFor(proposer),
      proposalId: id,
    });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('job_proposal_settled');
    expect(addJob).toHaveBeenCalledTimes(1);
  });

  test('an Approve whose body is not the proposed job creates nothing', async () => {
    const { sessionId: proposer, id } = await propose();
    const proposed = proposedFor(proposer);
    for (const body of [
      { ...proposed, prompt: 'Something else.' },
      { ...proposed, trustAllTools: true },
      { ...proposed, schedule: { kind: 'every', everyMs: 60_000 } },
      // Its runs land where it was proposed, nowhere else.
      {
        ...proposed,
        target: { kind: 'conversation', conversationId: 'conv-elsewhere' },
      },
      PROPOSED,
    ]) {
      const response = await personRequest('POST', '/scheduler/jobs', {
        ...body,
        proposalId: id,
      });
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('job_proposal_mismatch');
    }
    expect(addJob).not.toHaveBeenCalled();
    expect(store.jobProposal(id)?.state).toBe('open');
  });

  test('an agent cannot approve, even a bound operator whose add_job the guard admits', async () => {
    const { id } = await propose('bound');
    const response = await agent(
      'bound',
      nextSession(),
      'POST',
      '/scheduler/jobs',
      {
        ...PROPOSED,
        proposalId: id,
      },
    );
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('person-approval-required');
    expect(addJob).not.toHaveBeenCalled();
    expect(store.jobProposal(id)?.state).toBe('open');
  });

  test('Decline records it, creates nothing, and a later Approve is refused', async () => {
    const { sessionId, id } = await propose();
    const declined = await personRequest(
      'POST',
      `/api/orchestration/agent-schedule/conv-${sessionId}/job-proposals/${id}/decline`,
    );
    expect(declined.body.data).toEqual({ declined: true });
    expect(store.jobProposal(id)?.state).toBe('declined');
    const approve = await personRequest('POST', '/scheduler/jobs', {
      ...PROPOSED,
      proposalId: id,
    });
    expect(approve.body.code).toBe('job_proposal_settled');
    expect(addJob).not.toHaveBeenCalled();
  });

  test('an agent cannot decline', async () => {
    const { sessionId, id } = await propose();
    const response = await agent(
      'bound',
      sessionId,
      'POST',
      `/api/orchestration/agent-schedule/conv-${sessionId}/job-proposals/${id}/decline`,
    );
    expect(response.body.code).toBe('station_control_route_unmapped');
    expect(store.jobProposal(id)?.state).toBe('open');
  });
});

describe('add_job’s refusal names what the agent can do instead', () => {
  test('a delegated-custody caller is pointed at schedule_wake_up and propose_job', async () => {
    const response = await agent(
      'delegated-custody',
      nextSession(),
      'POST',
      '/scheduler/jobs',
      {
        name: 'j',
        prompt: 'p',
      },
    );
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('station_control_assurance_insufficient');
    expect(response.body.error).toContain('schedule_wake_up');
    expect(response.body.error).toContain('propose_job');
    expect(addJob).not.toHaveBeenCalled();
  });
});

describe('automation targets: an agent runs one only in its own chat', () => {
  const JOB = {
    name: 'repo-digest',
    schedule: { kind: 'every', everyMs: 3_600_000 },
    prompt: 'Summarize the repository.',
  };

  test('a bound operator’s add_job naming another conversation is refused by the guard', async () => {
    const response = await agent(
      'bound',
      nextSession(),
      'POST',
      '/scheduler/jobs',
      {
        ...JOB,
        target: { kind: 'conversation', conversationId: 'conv-someone-else' },
      },
    );
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ reason: 'other-conversation' });
    expect(refusals).toEqual(['station_control_out_of_scope']);
    expect(addJob).not.toHaveBeenCalled();
  });

  test('a dedicated conversation is a person’s choice, not an agent’s', async () => {
    const response = await agent(
      'bound',
      nextSession(),
      'POST',
      '/scheduler/jobs',
      {
        ...JOB,
        target: { kind: 'dedicated', agent: 'writer' },
      },
    );
    expect(response.status).toBe(403);
    expect(addJob).not.toHaveBeenCalled();
  });

  test('its own conversation is admitted and runs as its dispatch actor', async () => {
    const sessionId = nextSession();
    const target = {
      kind: 'conversation',
      conversationId: `conv-${sessionId}`,
    };
    const response = await agent(
      'bound',
      sessionId,
      'POST',
      '/scheduler/jobs',
      {
        ...JOB,
        target,
      },
    );
    expect(response.status).toBe(200);
    expect(addJob).toHaveBeenCalledWith(
      expect.objectContaining({
        target,
        createdBy: expect.objectContaining({
          userId: LOCAL_OPERATOR_PRINCIPAL_ID,
        }),
      }),
    );
  });

  test('an update cannot retarget a job to another conversation either', async () => {
    const response = await agent(
      'bound',
      nextSession(),
      'PUT',
      '/scheduler/jobs/repo-digest',
      { target: { kind: 'conversation', conversationId: 'conv-someone-else' } },
    );
    // Changing a job's target changes whose conversation its runs act in,
    // so the guard refuses it before it reaches the route, whatever rule
    // answers first (a retarget fails closed as a person's step).
    expect(response.status).toBe(403);
    expect([
      'station_control_person_only',
      'station_control_out_of_scope',
    ]).toContain(response.body.code);
  });

  test('a person may target only a conversation they may send to', async () => {
    facts.mayNotSend.add('conv-closed');
    const refused = await personRequest('POST', '/scheduler/jobs', {
      ...JOB,
      target: { kind: 'conversation', conversationId: 'conv-closed' },
    });
    expect(refused.status).toBe(404);
    expect(refused.body.code).toBe('automation_target_not_found');
    expect(addJob).not.toHaveBeenCalled();
    const admitted = await personRequest('POST', '/scheduler/jobs', {
      ...JOB,
      target: { kind: 'conversation', conversationId: 'conv-open' },
    });
    expect(admitted.status).toBe(200);
    expect(addJob.mock.calls[0]?.[0]).toMatchObject({
      createdBy: { userId: LOCAL_OPERATOR_PRINCIPAL_ID },
    });
  });

  test('a body cannot choose who the runs act as', async () => {
    await personRequest('POST', '/scheduler/jobs', {
      ...JOB,
      target: { kind: 'conversation', conversationId: 'conv-open' },
      createdBy: { userId: 'someone-else' },
    });
    expect(addJob.mock.calls[0]?.[0]).toMatchObject({
      createdBy: { userId: LOCAL_OPERATOR_PRINCIPAL_ID },
    });
  });

  test('the chat’s read lists automations targeting it beside its check-backs', async () => {
    const sessionId = nextSession();
    facts.automations.set(`conv-${sessionId}`, ['repo-digest']);
    const read = await personRequest('GET', schedulePath(`conv-${sessionId}`));
    expect(read.status).toBe(200);
    expect(read.body.data.automations).toEqual([
      { name: 'repo-digest', enabled: true, consecutiveFailures: 0 },
    ]);
  });
});

/** A check-back the agent of an unconfined session asked for. */
async function hostCheckBack(note = 'check the deploy') {
  const sessionId = nextSession('host-');
  const created = await agent(
    'delegated-custody',
    sessionId,
    'POST',
    WAKE_UPS,
    {
      delayMs: FIVE_MINUTES,
      note,
    },
  );
  expect(created.status).toBe(200);
  expect(created.body.data.state).toBe('needs_approval');
  return {
    sessionId,
    conversationId: `conv-${sessionId}`,
    id: created.body.data.id as string,
  };
}

const wakeUpAction = (conversationId: string, id: string, action: string) =>
  `${schedulePath(conversationId)}/wake-ups/${id}/${action}`;

describe('owner decision: a check-back in an unconfined session waits for one click', () => {
  test('the person sees it waiting, with its note, and nothing is armed to send', async () => {
    const { conversationId, id } = await hostCheckBack('look at the logs');
    const read = await personRequest('GET', schedulePath(conversationId));
    expect(read.body.data.wakeUps).toEqual([
      expect.objectContaining({
        id,
        state: 'needs_approval',
        note: 'look at the logs',
      }),
    ]);
    // Due without an approval: never sent.
    const late = newDelivery(() => clock.now + FIVE_MINUTES);
    try {
      late.fire(id);
    } finally {
      late.stop();
    }
    expect(submitted).toEqual([]);
    expect(store.wakeUp(id)).toMatchObject({
      state: 'failed',
      reasonCode: 'not_approved',
    });
  });

  test('Approve arms it; when due it is sent, admitted by that approval', async () => {
    const { conversationId, id } = await hostCheckBack();
    const approved = await personRequest(
      'POST',
      wakeUpAction(conversationId, id, 'approve'),
    );
    expect(approved.status).toBe(200);
    expect(approved.body.data).toMatchObject({
      id,
      state: 'pending',
      approved: true,
    });
    delivery.fire(id);
    expect(submitted.map((entry) => entry.outcome)).toEqual(['queued']);
    expect(store.wakeUp(id)?.state).toBe('sent');
  });

  test('without the approval, the same wake-up made pending is refused at fire time', async () => {
    const { id } = await hostCheckBack();
    // The same row armed with no person's approval behind it: the
    // fire-time scope decision refuses it.
    expect(
      store.approveWakeUp(id, LOCAL_OPERATOR_PRINCIPAL_ID, clock.now),
    ).toBe(true);
    const record = store.wakeUp(id)!;
    expect(admitWakeUpAtFire(scope, record)).toBe(true);
    expect(admitWakeUpAtFire(scope, { ...record, approvedBy: undefined })).toBe(
      false,
    );
  });

  test('Decline cancels it; a later Approve is refused and arms nothing', async () => {
    const { conversationId, id } = await hostCheckBack();
    const declined = await personRequest(
      'POST',
      wakeUpAction(conversationId, id, 'decline'),
    );
    expect(declined.body.data).toEqual({ canceled: true });
    expect(store.wakeUp(id)).toMatchObject({
      state: 'canceled',
      canceledBy: 'person',
    });
    const approve = await personRequest(
      'POST',
      wakeUpAction(conversationId, id, 'approve'),
    );
    expect(approve.status).toBe(409);
    expect(approve.body.code).toBe('wake_up_settled');
    delivery.fire(id);
    expect(submitted).toEqual([]);
  });

  test('an Approve after it came due is refused', async () => {
    const { conversationId, id } = await hostCheckBack();
    const saved = clock.now;
    clock.now += FIVE_MINUTES;
    try {
      const approve = await personRequest(
        'POST',
        wakeUpAction(conversationId, id, 'approve'),
      );
      expect(approve.status).toBe(409);
      expect(approve.body.error).toBe('Its time has passed.');
      expect(store.wakeUp(id)?.state).toBe('needs_approval');
    } finally {
      clock.now = saved;
    }
  });

  test('a timer that fires before it is due waits again, then settles when due', async () => {
    const { conversationId, id } = await hostCheckBack();
    const dueAtMs = store.wakeUp(id)!.dueAtMs;
    let at = dueAtMs - 1;
    const early = newDelivery(() => at);
    try {
      // setTimeout may fire a millisecond early, or the clock stepped back.
      early.fire(id);
      expect(store.wakeUp(id)?.state).toBe('needs_approval');
      at = dueAtMs;
      // Re-armed: it settles on its own once due, nothing is sent.
      await vi.waitFor(() =>
        expect(store.wakeUp(id)).toMatchObject({
          state: 'failed',
          reasonCode: 'not_approved',
        }),
      );
      expect(submitted).toEqual([]);
      const approve = await personRequest(
        'POST',
        wakeUpAction(conversationId, id, 'approve'),
      );
      expect(approve.status).toBe(409);
      expect(approve.body.error).toBe('Its time has passed.');
    } finally {
      early.stop();
    }
  });

  test('a clock a month behind its due time waits, without spinning or settling', async () => {
    const { id } = await hostCheckBack();
    const dueAtMs = store.wakeUp(id)!.dueAtMs;
    let reads = 0;
    // Past setTimeout's 2^31-1 ms maximum, which Node runs after 1ms.
    const behind = newDelivery(() => {
      reads += 1;
      return dueAtMs - 30 * 24 * 60 * 60_000;
    });
    try {
      behind.fire(id);
      await new Promise((resolve) => setTimeout(resolve, 60));
      // One read to decide it is early, one to arm: nothing re-fired.
      expect(reads).toBe(2);
      expect(store.wakeUp(id)?.state).toBe('needs_approval');
    } finally {
      behind.stop();
    }
  });

  test('a stopped delivery answers unavailable, not that its time has passed', async () => {
    const { id } = await hostCheckBack();
    const stopped = newDelivery(() => clock.now);
    stopped.stop();
    expect(stopped.approve(id, LOCAL_OPERATOR_PRINCIPAL_ID)).toEqual({
      outcome: 'unavailable',
    });
    expect(store.wakeUp(id)?.state).toBe('needs_approval');
  });

  test('an agent cannot approve or decline, not even a bound operator', async () => {
    const { sessionId, conversationId, id } = await hostCheckBack();
    for (const action of ['approve', 'decline'])
      for (const channel of ['bound', 'delegated-custody'] as const) {
        const response = await agent(
          channel,
          sessionId,
          'POST',
          wakeUpAction(conversationId, id, action),
        );
        expect(response.status).toBe(403);
        expect(response.body.code).toBe('station_control_route_unmapped');
      }
    expect(store.wakeUp(id)?.state).toBe('needs_approval');
  });

  test('a person who may not send to the chat cannot approve or decline it: it reads as missing', async () => {
    const { conversationId, id } = await hostCheckBack();
    facts.mayNotSend.add(conversationId);
    for (const action of ['approve', 'decline', 'cancel']) {
      const response = await personRequest(
        'POST',
        wakeUpAction(conversationId, id, action),
      );
      expect(response.status).toBe(404);
    }
    expect(store.wakeUp(id)?.state).toBe('needs_approval');
  });

  test('a waiting check-back counts toward the chat’s cap', async () => {
    const sessionId = nextSession('host-');
    for (let i = 0; i < AGENT_WAKE_UP_MAX_PENDING_PER_CONVERSATION; i += 1)
      expect(
        (
          await agent('delegated-custody', sessionId, 'POST', WAKE_UPS, {
            delayMs: FIVE_MINUTES,
            note: `n${i}`,
          })
        ).status,
      ).toBe(200);
    const over = await agent('delegated-custody', sessionId, 'POST', WAKE_UPS, {
      delayMs: FIVE_MINUTES,
      note: 'x',
    });
    expect(over.body.code).toBe('wake_up_limit_reached');
  });
});

describe('the scope rule is decided again when a wake-up fires', () => {
  test('a confined chat that now runs unconfined: its wake-up is not sent', async () => {
    const sessionId = nextSession();
    const created = await agent(
      'delegated-custody',
      sessionId,
      'POST',
      WAKE_UPS,
      {
        delayMs: FIVE_MINUTES,
        note: 'x',
      },
    );
    expect(created.body.data.state).toBe('pending');
    facts.hostNow.add(`conv-${sessionId}`);
    delivery.fire(created.body.data.id);
    expect(submitted).toEqual([]);
    expect(store.wakeUp(created.body.data.id)).toMatchObject({
      state: 'failed',
      reasonCode: 'not_permitted',
    });
  });

  test('a bound caller’s wake-up is still admitted', async () => {
    const sessionId = nextSession();
    const created = await agent('bound', sessionId, 'POST', WAKE_UPS, {
      delayMs: FIVE_MINUTES,
      note: 'x',
    });
    facts.hostNow.add(`conv-${sessionId}`);
    delivery.fire(created.body.data.id);
    expect(store.wakeUp(created.body.data.id)?.state).toBe('sent');
  });
});

describe('the inbox decides placement: its own refusals settle the wake-up', () => {
  test('a sender who may no longer send: not_permitted, nothing queued', async () => {
    const sessionId = nextSession();
    const created = await agent('bound', sessionId, 'POST', WAKE_UPS, {
      delayMs: FIVE_MINUTES,
      note: 'x',
    });
    facts.mayNotSend.add(`conv-${sessionId}`);
    delivery.fire(created.body.data.id);
    expect(submitted.map((entry) => entry.outcome)).toEqual(['not-permitted']);
    expect(world.inboxStore.list(`conv-${sessionId}`)).toEqual([]);
    expect(store.wakeUp(created.body.data.id)).toMatchObject({
      state: 'failed',
      reasonCode: 'not_permitted',
    });
  });

  test('a full inbox: capacity', async () => {
    const sessionId = nextSession();
    const conversationId = `conv-${sessionId}`;
    for (let i = 0; i < 50; i += 1)
      expect(
        world.inbox.submit({
          conversationId,
          clientTurnId: `filler-${i}`,
          payload: {
            message: `m${i}`,
            actor: { userId: LOCAL_OPERATOR_PRINCIPAL_ID },
          },
        }).outcome,
      ).toBe('queued');
    const created = await agent('bound', sessionId, 'POST', WAKE_UPS, {
      delayMs: FIVE_MINUTES,
      note: 'x',
    });
    delivery.fire(created.body.data.id);
    expect(submitted.at(-1)?.outcome).toBe('capacity');
    expect(store.wakeUp(created.body.data.id)).toMatchObject({
      state: 'failed',
      reasonCode: 'capacity',
    });
  });

  test('what is queued carries the message, the recorded sender and the origin: no grant or posture', async () => {
    const sessionId = nextSession();
    const created = await agent('bound', sessionId, 'POST', WAKE_UPS, {
      delayMs: FIVE_MINUTES,
      note: 'x',
    });
    delivery.fire(created.body.data.id);
    const [entry] = world.inboxStore.list(`conv-${sessionId}`);
    expect(entry?.key).toBe(wakeUpClientTurnId(created.body.data.id));
    expect(Object.keys(JSON.parse(entry!.payload)).sort()).toEqual([
      'actor',
      'clientOrigin',
      'message',
    ]);
  });
});

describe('the person’s read covers the whole conversation', () => {
  test('a conversation the person may not read as a whole reads as missing', async () => {
    const sessionId = nextSession();
    facts.mayNotRead.add(`conv-${sessionId}`);
    const response = await personRequest(
      'GET',
      schedulePath(`conv-${sessionId}`),
    );
    expect(response.status).toBe(404);
  });
});

describe('Approve claims the proposal before the job is created', () => {
  async function proposeOne() {
    const sessionId = nextSession();
    const response = await agent(
      'delegated-custody',
      sessionId,
      'POST',
      PROPOSALS,
      PROPOSED,
    );
    expect(response.status).toBe(200);
    return {
      conversationId: `conv-${sessionId}`,
      id: response.body.data.id as string,
    };
  }

  test('a Decline while the job is being created changes nothing; the Approve completes', async () => {
    const { conversationId, id } = await proposeOne();
    let release!: () => void;
    addJob.mockImplementationOnce(
      (opts: { name: string }) =>
        new Promise((resolve) => {
          release = () => resolve(`Job '${opts.name}' created`);
        }),
    );
    const approving = personRequest('POST', '/scheduler/jobs', {
      ...store.jobProposal(id)!.job,
      proposalId: id,
    });
    await vi.waitFor(() => expect(addJob).toHaveBeenCalledTimes(1));
    const declined = await personRequest(
      'POST',
      `${schedulePath(conversationId)}/job-proposals/${id}/decline`,
    );
    expect(declined.body.data).toEqual({ declined: false });
    // A second Approve meanwhile is refused too.
    const twice = await personRequest('POST', '/scheduler/jobs', {
      ...store.jobProposal(id)!.job,
      proposalId: id,
    });
    expect(twice.body.code).toBe('job_proposal_settled');
    release();
    expect((await approving).status).toBe(200);
    expect(store.jobProposal(id)?.state).toBe('approved');
    expect(addJob).toHaveBeenCalledTimes(1);
  });

  test('a failed create gives the proposal back', async () => {
    const { id } = await proposeOne();
    addJob.mockImplementationOnce(async () => {
      throw new Error('scheduler unavailable');
    });
    const response = await personRequest('POST', '/scheduler/jobs', {
      ...store.jobProposal(id)!.job,
      proposalId: id,
    });
    expect(response.status).toBe(500);
    // Raw state: an Approve in flight also reads `open` to the chat.
    expect(store.jobProposalState(id)).toBe('open');
    // So the person can try again.
    const again = await personRequest('POST', '/scheduler/jobs', {
      ...store.jobProposal(id)!.job,
      proposalId: id,
    });
    expect(again.status).toBe(200);
    expect(store.jobProposalState(id)).toBe('approved');
  });
});

describe('startup reopens only Approves an earlier process claimed', () => {
  async function proposeOne() {
    const sessionId = nextSession();
    const response = await agent(
      'delegated-custody',
      sessionId,
      'POST',
      PROPOSALS,
      PROPOSED,
    );
    expect(response.status).toBe(200);
    return response.body.data.id as string;
  }

  /** A restart's composition over the same store, with no inbox at all. */
  function restartAt(startedAt: number) {
    return composeAgentSchedule({
      store,
      threadInbox: undefined,
      scope,
      orchestration: {} as never,
      hosted: false,
      isInternalRequest: () => false,
      isRequestPrincipalCurrent: () => false,
      requestUserId: () => LOCAL_OPERATOR_PRINCIPAL_ID,
      readAuthorityFor: () => ({ mode: 'personal' }) as never,
      tenantFor: () => undefined,
      dispatchActor: () => ({}) as never,
      agentProject: async () => undefined,
      logger: quietLogger(),
      now: () => startedAt,
    });
  }

  test('the store reopens claims strictly before the cutoff', () => {
    return proposeOne().then((id) => {
      const claimedAt = clock.now;
      expect(
        store.transitionJobProposal(
          id,
          'open',
          'approving',
          LOCAL_OPERATOR_PRINCIPAL_ID,
          claimedAt,
        ),
      ).toBe(true);
      expect(store.reopenInterruptedApprovals(claimedAt, claimedAt)).toBe(0);
      expect(store.jobProposalState(id)).toBe('approving');
      expect(
        store.reopenInterruptedApprovals(claimedAt + 1, claimedAt + 1),
      ).toBe(1);
      expect(store.jobProposalState(id)).toBe('open');
    });
  });

  test('a restart without an inbox reopens a claim the old process left', async () => {
    const id = await proposeOne();
    store.transitionJobProposal(
      id,
      'open',
      'approving',
      LOCAL_OPERATOR_PRINCIPAL_ID,
      clock.now,
    );
    const restarted = restartAt(clock.now + 1);
    expect(restarted.delivery).toBeUndefined();
    expect(store.jobProposalState(id)).toBe('open');
  });

  test('a claim made after this process started is left to its Approve', async () => {
    const id = await proposeOne();
    store.transitionJobProposal(
      id,
      'open',
      'approving',
      LOCAL_OPERATOR_PRINCIPAL_ID,
      clock.now,
    );
    restartAt(clock.now);
    expect(store.jobProposalState(id)).toBe('approving');
  });

  test('an Approve whose claim was reopened underneath it is still recorded approved', async () => {
    const id = await proposeOne();
    let release!: () => void;
    addJob.mockImplementationOnce(
      (opts: { name: string }) =>
        new Promise((resolve) => {
          release = () => resolve(`Job '${opts.name}' created`);
        }),
    );
    const approving = personRequest('POST', '/scheduler/jobs', {
      ...store.jobProposal(id)!.job,
      proposalId: id,
    });
    await vi.waitFor(() => expect(addJob).toHaveBeenCalledTimes(1));
    // Another process starting later reopens this in-flight claim.
    restartAt(clock.now + 1);
    expect(store.jobProposalState(id)).toBe('open');
    release();
    expect((await approving).status).toBe(200);
    expect(store.jobProposalState(id)).toBe('approved');
  });
});

describe('a proposed job’s Agent is in the chat’s scope', () => {
  for (const [agentSlug, why] of [
    ['elsewhere', 'another Project'],
    ['global-writer', 'the global space'],
    ['nope', 'an Agent Station cannot read'],
  ] as const)
    test(`an Agent in ${why} is refused`, async () => {
      const response = await agent(
        'delegated-custody',
        nextSession(),
        'POST',
        PROPOSALS,
        {
          ...PROPOSED,
          agent: agentSlug,
        },
      );
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('job_proposal_agent_out_of_scope');
    });

  test('the chat’s own Project’s Agent, or none, is fine', async () => {
    for (const body of [PROPOSED, { ...PROPOSED, agent: undefined }])
      expect(
        (
          await agent(
            'delegated-custody',
            nextSession(),
            'POST',
            PROPOSALS,
            body,
          )
        ).status,
      ).toBe(200);
  });
});

describe('creating is rate limited per chat, and settled rows are pruned', () => {
  test('schedule-and-cancel churn: the window’s limit is accepted, one more is refused', async () => {
    expect(AGENT_WAKE_UP_MAX_CREATED_PER_WINDOW).toBe(20);
    expect(AGENT_SCHEDULE_RATE_WINDOW_MS).toBe(3_600_000);
    const sessionId = nextSession();
    const ids: string[] = [];
    for (let i = 0; i < AGENT_WAKE_UP_MAX_CREATED_PER_WINDOW; i += 1) {
      const created = await agent('bound', sessionId, 'POST', WAKE_UPS, {
        delayMs: FIVE_MINUTES,
        note: `n${i}`,
      });
      expect(created.status).toBe(200);
      ids.push(created.body.data.id);
      await agent(
        'bound',
        sessionId,
        'DELETE',
        `${WAKE_UPS}/${created.body.data.id}`,
      );
    }
    const over = await agent('bound', sessionId, 'POST', WAKE_UPS, {
      delayMs: FIVE_MINUTES,
      note: 'one more',
    });
    expect(over.status).toBe(409);
    expect(over.body.code).toBe('wake_up_rate_limited');
    const saved = clock.now;
    clock.now += AGENT_SCHEDULE_RATE_WINDOW_MS;
    try {
      const later = await agent('bound', sessionId, 'POST', WAKE_UPS, {
        delayMs: FIVE_MINUTES,
        note: 'later',
      });
      expect(later.status).toBe(200);
      // The canceled rows from the last window are gone.
      expect(ids.map((id) => store.wakeUp(id))).toEqual(
        ids.map(() => undefined),
      );
    } finally {
      clock.now = saved;
    }
  });

  test('proposals: the window’s limit is accepted, one more is refused', async () => {
    expect(AGENT_JOB_PROPOSAL_MAX_CREATED_PER_WINDOW).toBe(10);
    const sessionId = nextSession();
    for (let i = 0; i < AGENT_JOB_PROPOSAL_MAX_CREATED_PER_WINDOW; i += 1) {
      const proposed = await agent(
        'delegated-custody',
        sessionId,
        'POST',
        PROPOSALS,
        {
          ...PROPOSED,
          name: `job-${i}`,
        },
      );
      expect(proposed.status).toBe(200);
      await personRequest(
        'POST',
        `${schedulePath(`conv-${sessionId}`)}/job-proposals/${proposed.body.data.id}/decline`,
      );
    }
    const over = await agent(
      'delegated-custody',
      sessionId,
      'POST',
      PROPOSALS,
      PROPOSED,
    );
    expect(over.status).toBe(409);
    expect(over.body.code).toBe('job_proposal_rate_limited');
  });
});

describe('a malformed wake-up id', () => {
  test('is refused as naming nothing, not a server error', async () => {
    const response = await agent(
      'bound',
      nextSession(),
      'DELETE',
      `${WAKE_UPS}/%E0%A4%A`,
    );
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ reason: 'other-conversation' });
  });
});

describe('hosted: nothing to approve with, so nothing is offered', () => {
  let hosted: World;
  beforeAll(async () => {
    hosted = await boot({ hosted: true });
  });
  afterAll(async () => {
    await hosted.close();
  });

  test('propose_job and schedule_wake_up are unavailable; Approve finds nothing', async () => {
    const at = { baseUrl: hosted.baseUrl, port: hosted.port };
    const sessionId = nextSession();
    const proposed = await agent(
      'delegated-custody',
      sessionId,
      'POST',
      PROPOSALS,
      PROPOSED,
      at,
    );
    expect(proposed.status).toBe(503);
    expect(proposed.body.code).toBe('job_proposal_unavailable');
    const wakeUp = await agent(
      'delegated-custody',
      nextSession('host-'),
      'POST',
      WAKE_UPS,
      {
        delayMs: FIVE_MINUTES,
        note: 'x',
      },
      at,
    );
    expect(wakeUp.status).toBe(503);
    expect(wakeUp.body.code).toBe('wake_up_unavailable');
    // Even a proposal already on file is not approvable there.
    const filed = hosted.store.insertJobProposal({
      conversationId: `conv-${sessionId}`,
      sessionId,
      job: PROPOSED as never,
      now: clock.now,
    });
    expect(filed.outcome).toBe('proposed');
    const approve = await personRequest(
      'POST',
      '/scheduler/jobs',
      {
        ...PROPOSED,
        proposalId: (filed as { proposal: { id: string } }).proposal.id,
      },
      hosted.baseUrl,
    );
    expect(approve.status).toBe(404);
    expect(hosted.addJob).not.toHaveBeenCalled();
  });
});

/**
 * Fix round P1: every action on an existing automation that runs in a
 * conversation is admitted against its STORED target and creator, whatever
 * the body names. Real boundary, guard, composition, scheduler routes,
 * BuiltinScheduler and SQLite ledger; only the conversation runner and the
 * orchestration permission facts are scripted. The guard is given the
 * production answer for an ungranted job (`retargetsGrantedJob: false`), so
 * the route's own admission is what decides.
 */
describe('acting on an automation is admitted against its stored target', () => {
  const makeTempDir = trackTempDirs();

  async function realWorld() {
    const runs: ScheduledConversationRunInput[] = [];
    const directory = makeTempDir('automation-authority-');
    const scheduler = new SchedulerService({
      logger: quietLogger(),
      builtin: {
        ledger: createSchedulerLedger({ directory }),
        turnAdapter: { invoke: vi.fn() },
        conversationRuns: {
          run: async (input) => {
            runs.push(input);
            return {
              kind: 'completed',
              output: '{}',
              conversationId: 'conv-victim',
            };
          },
        },
      },
    });
    const served = await boot({
      hosted: false,
      scheduler,
      retargetsGrantedJob: () => false,
    });
    await scheduler.addJob({
      name: 'victim-job',
      schedule: { kind: 'every', everyMs: 60_000 },
      prompt: 'Original',
      target: { kind: 'conversation', conversationId: 'conv-victim' },
      createdBy: { userId: 'victim-person' },
    });
    return {
      scheduler,
      runs,
      directory,
      at: { baseUrl: served.baseUrl, port: served.port },
      close: async () => {
        await served.close();
        await scheduler.stop();
      },
    };
  }

  test('another chat’s agent cannot rewrite the prompt by leaving target out (the reported injection)', async () => {
    const world = await realWorld();
    try {
      const response = await agent(
        'bound',
        nextSession(),
        'PUT',
        '/scheduler/jobs/victim-job',
        { prompt: 'Injected instructions' },
        world.at,
      );
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('automation_target_out_of_scope');
      await world.scheduler.runJob('victim-job');
      expect(world.runs[0]).toMatchObject({
        prompt: 'Original',
        createdBy: { userId: 'victim-person' },
      });
    } finally {
      await world.close();
    }
  });

  test.each([
    ['PUT', '/scheduler/jobs/victim-job/enable'],
    ['PUT', '/scheduler/jobs/victim-job/disable'],
    ['POST', '/scheduler/jobs/victim-job/run'],
    ['DELETE', '/scheduler/jobs/victim-job'],
  ])('another chat’s agent cannot %s %s', async (method, path) => {
    const world = await realWorld();
    try {
      const response = await agent(
        'bound',
        nextSession(),
        method,
        path,
        undefined,
        world.at,
      );
      expect(response.status).toBe(403);
      expect(world.runs).toHaveLength(0);
      expect((await world.scheduler.listJobs()).map((job) => job.name)).toEqual(
        ['victim-job'],
      );
    } finally {
      await world.close();
    }
  });

  test('the agent of the target chat may edit and run it, and the creator stays', async () => {
    const world = await realWorld();
    try {
      // `conv-victim` is the conversation of session `victim`.
      const edited = await agent(
        'bound',
        'victim',
        'PUT',
        '/scheduler/jobs/victim-job',
        { prompt: 'Revised' },
        world.at,
      );
      expect(edited.status).toBe(200);
      const ran = await agent(
        'bound',
        'victim',
        'POST',
        '/scheduler/jobs/victim-job/run',
        undefined,
        world.at,
      );
      expect(ran.status).toBe(200);
      expect(world.runs[0]).toMatchObject({
        prompt: 'Revised',
        createdBy: { userId: 'victim-person' },
      });
    } finally {
      await world.close();
    }
  });

  test('a person who may not send to the target chat cannot edit or run it', async () => {
    const world = await realWorld();
    facts.mayNotSend.add('conv-victim');
    try {
      const edited = await personRequest(
        'PUT',
        '/scheduler/jobs/victim-job',
        { prompt: 'Injected instructions' },
        world.at.baseUrl,
      );
      expect(edited.status).toBe(404);
      expect(edited.body.code).toBe('automation_not_found');
      const ran = await personRequest(
        'POST',
        '/scheduler/jobs/victim-job/run',
        undefined,
        world.at.baseUrl,
      );
      expect(ran.status).toBe(404);
      expect(world.runs).toHaveLength(0);
    } finally {
      await world.close();
    }
  });

  test('a person’s save of the same target keeps the stored creator', async () => {
    const world = await realWorld();
    try {
      const saved = await personRequest(
        'PUT',
        '/scheduler/jobs/victim-job',
        { target: { kind: 'conversation', conversationId: 'conv-victim' } },
        world.at.baseUrl,
      );
      expect(saved.status).toBe(200);
      expect((await world.scheduler.listJobs())[0]!.createdBy).toEqual({
        userId: 'victim-person',
      });
    } finally {
      await world.close();
    }
  });

  test.each(['bound', 'delegated-custody', 'bearer-exposed'] as const)(
    '%s list must not disclose an unreadable chat prompt',
    async (channel) => {
      const world = await realWorld();
      facts.mayNotRead.add('conv-victim');
      facts.mayNotSend.add('conv-victim');
      try {
        const response = await agent(
          channel,
          nextSession(),
          'GET',
          '/scheduler/jobs',
          undefined,
          world.at,
        );
        expect(response.status).toBe(200);
        expect(
          response.body.data.filter((job: any) => job.name === 'victim-job'),
        ).toEqual([]);
      } finally {
        await world.close();
      }
    },
  );

  test('real HTTP MCP list_jobs must not disclose another chat prompt', async () => {
    const world = await realWorld();
    await world.scheduler.runJob('victim-job');
    expect(await world.scheduler.getJobLogs('victim-job')).toMatchObject([
      { runTarget: { kind: 'conversation', conversationId: 'conv-victim' } },
    ]);
    facts.mayNotRead.add('conv-victim');
    facts.mayNotSend.add('conv-victim');
    try {
      const token = mintStationControlMcpHeaderAuth(
        world.at.port,
        nextSession(),
      ).token;
      const call = async (id: number, method: string, params: object) => {
        const response = await fetch(
          `${world.at.baseUrl}/mcp/station-control`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              accept: 'application/json, text/event-stream',
              authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
          },
        );
        expect(response.status).toBe(200);
        const body = await response.text();
        const data = body.split('\n').find((line) => line.startsWith('data: '));
        return JSON.parse(data ? data.slice(6) : body);
      };
      await call(1, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'delta-review', version: '1' },
      });
      const result = await call(2, 'tools/call', {
        name: 'list_jobs',
        arguments: {},
      });
      expect(result.result?.isError).not.toBe(true);
      expect(JSON.stringify(result)).not.toContain('Original');
      for (const [id, name, args] of [
        [3, 'get_scheduler_stats', {}],
        [4, 'get_scheduler_status', {}],
        [5, 'get_job_logs', { name: 'victim-job' }],
        [6, 'preview_schedule', { cron: '* * * * *' }],
      ] as const) {
        const answer = await call(id, 'tools/call', { name, arguments: args });
        expect(JSON.stringify(answer)).not.toContain('Original');
        if (name === 'get_scheduler_stats')
          expect(JSON.stringify(answer)).not.toContain('victim-job');
        if (name === 'get_scheduler_status') {
          const payload = JSON.parse(answer.result.content[0].text);
          expect(payload.data.providers['built-in'].jobCount).toBe(0);
        }
        if (name === 'get_job_logs') {
          const payload = JSON.parse(answer.result.content[0].text);
          expect(payload.success).toBe(false);
        }
        if (name === 'preview_schedule')
          expect(answer.result?.isError).not.toBe(true);
      }
    } finally {
      await world.close();
    }
  });

  test.each(['bound', 'delegated-custody', 'bearer-exposed'] as const)(
    '%s agent reads its own run logs',
    async (channel) => {
      const world = await realWorld();
      try {
        await world.scheduler.runJob('victim-job');
        const response = await agent(
          channel,
          'victim',
          'GET',
          '/scheduler/jobs/victim-job/logs',
          undefined,
          world.at,
        );
        expect(response.status).toBe(200);
        expect(response.body.data).toHaveLength(1);
      } finally {
        await world.close();
      }
    },
  );

  test('SDK and HTTP run detail and output use the target of that run after retarget', async () => {
    const world = await realWorld();
    try {
      await world.scheduler.runJob('victim-job');
      const run = (await world.scheduler.listRunSummaries())[0]!;
      if (!run.outputRef) throw new Error('expected persisted output');
      await world.scheduler.editJob('victim-job', {
        target: { kind: 'conversation', conversationId: 'conv-new' },
      });
      const headers = (session: string) => ({
        [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
        [INTERNAL_PROXY_CALLER_HEADER]: 'local',
        [STATION_CONTROL_CALLER_TOKEN_HEADER]: forwardedCaller(
          'bound',
          session,
          world.at.port,
        ),
      });
      const old = { headers: headers('victim') };
      const newer = { headers: headers('new') };
      expect(await sdkListJobs(world.at.baseUrl, old)).toEqual([]);
      expect((await sdkStats(world.at.baseUrl, old)).summary.totalJobs).toBe(0);
      expect(
        (await sdkStatus(world.at.baseUrl, old)).providers['built-in']!
          .jobCount,
      ).toBe(0);
      expect(
        await sdkLogs(world.at.baseUrl, 'victim-job', {}, old),
      ).toHaveLength(1);
      expect(
        await sdkPreview(world.at.baseUrl, '* * * * *', 1, old),
      ).toHaveLength(1);
      expect(await sdkListRuns(world.at.baseUrl, old)).toHaveLength(1);
      expect(await sdkGetRun(world.at.baseUrl, run.runId, old)).toMatchObject({
        runId: run.runId,
      });
      expect(await sdkListRuns(world.at.baseUrl, newer)).toEqual([]);
      await expect(
        sdkGetRun(world.at.baseUrl, run.runId, newer),
      ).rejects.toThrow();
      const allowed = await agent(
        'bound',
        'victim',
        'POST',
        '/api/runs/output',
        run.outputRef,
        world.at,
      );
      expect(allowed.status).toBe(200);
      expect(allowed.body.data.content).toBe('{}');
      const denied = await agent(
        'bound',
        'new',
        'POST',
        '/api/runs/output',
        run.outputRef,
        world.at,
      );
      expect(denied.status).toBe(404);
      const personAllowed = await personRequest(
        'POST',
        '/api/runs/output',
        run.outputRef,
        world.at.baseUrl,
      );
      expect(personAllowed.status).toBe(200);
      facts.mayNotRead.add('conv-victim');
      expect(
        (
          await personRequest(
            'POST',
            '/api/runs/output',
            run.outputRef,
            world.at.baseUrl,
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await personRequest(
            'GET',
            `/api/runs/${encodeURIComponent(run.runId)}`,
            undefined,
            world.at.baseUrl,
          )
        ).status,
      ).toBe(404);
    } finally {
      await world.close();
    }
  });

  test('a pre-change run is visible only to the creator who reads the current target', async () => {
    const world = await realWorld();
    try {
      await world.scheduler.addJob({
        name: 'old-run',
        schedule: { kind: 'every', everyMs: 60_000 },
        prompt: 'x',
        target: { kind: 'conversation', conversationId: 'conv-victim' },
        createdBy: { userId: LOCAL_OPERATOR_PRINCIPAL_ID },
      });
      await world.scheduler.runJob('old-run');
      const db = new DatabaseSync(join(world.directory, 'scheduler.sqlite'));
      db.prepare(
        "UPDATE scheduler_logs SET data = json_remove(data, '$.runTarget') WHERE job_name = ?",
      ).run('old-run');
      db.close();
      const agentRead = await agent(
        'bound',
        'victim',
        'GET',
        '/scheduler/jobs/old-run/logs',
        undefined,
        world.at,
      );
      expect(agentRead.status).toBe(200);
      expect(agentRead.body.data).toEqual([]);
      const personRead = await personRequest(
        'GET',
        '/scheduler/jobs/old-run/logs',
        undefined,
        world.at.baseUrl,
      );
      expect(personRead.body.data).toHaveLength(1);
      facts.mayNotRead.add('conv-victim');
      const denied = await personRequest(
        'GET',
        '/scheduler/jobs/old-run/logs',
        undefined,
        world.at.baseUrl,
      );
      expect(denied.status).toBe(404);
      facts.mayNotRead.delete('conv-victim');
      await world.scheduler.runJob('victim-job');
      const db2 = new DatabaseSync(join(world.directory, 'scheduler.sqlite'));
      db2
        .prepare(
          "UPDATE scheduler_logs SET data = json_remove(data, '$.runTarget') WHERE job_name = ?",
        )
        .run('victim-job');
      db2.close();
      const notCreator = await personRequest(
        'GET',
        '/scheduler/jobs/victim-job/logs',
        undefined,
        world.at.baseUrl,
      );
      expect(notCreator.body.data).toEqual([]);
    } finally {
      await world.close();
    }
  });

  test('run logs follow the target captured at claim after retargeting', async () => {
    const world = await realWorld();
    try {
      await world.scheduler.runJob('victim-job');
      await world.scheduler.editJob('victim-job', {
        target: { kind: 'conversation', conversationId: 'conv-new' },
      });
      const oldChat = await agent(
        'bound',
        'victim',
        'GET',
        '/scheduler/jobs/victim-job/logs',
        undefined,
        world.at,
      );
      expect(oldChat.status).toBe(200);
      expect(oldChat.body.data).toHaveLength(1);
      expect(oldChat.body.data[0].runTarget).toEqual({
        kind: 'conversation',
        conversationId: 'conv-victim',
      });
      const newChat = await agent(
        'bound',
        'new',
        'GET',
        '/scheduler/jobs/victim-job/logs',
        undefined,
        world.at,
      );
      expect(newChat.status).toBe(200);
      expect(newChat.body.data).toEqual([]);
      const newStats = await agent(
        'bound',
        'new',
        'GET',
        '/scheduler/stats',
        undefined,
        world.at,
      );
      expect(newStats.body.data.summary.totalRuns).toBe(0);
      const newList = await agent(
        'bound',
        'new',
        'GET',
        '/scheduler/jobs',
        undefined,
        world.at,
      );
      expect(newList.body.data[0]).not.toHaveProperty('lastRun');
      expect(newList.body.data[0]).not.toHaveProperty('lastSuccessAt');
      expect(newList.body.data[0]).not.toHaveProperty('consecutiveFailures');
      facts.mayNotRead.add('conv-victim');
      const person = await personRequest(
        'GET',
        '/scheduler/jobs/victim-job/logs',
        undefined,
        world.at.baseUrl,
      );
      expect(person.status).toBe(200);
      expect(person.body.data).toEqual([]);
    } finally {
      await world.close();
    }
  });

  test.each(['agent', 'person'] as const)(
    '%s reads expose only accessible jobs and their logs',
    async (caller) => {
      const world = await realWorld();
      facts.mayNotRead.add('conv-victim');
      const session = nextSession();
      const request = (path: string) =>
        caller === 'agent'
          ? agent('bound', session, 'GET', path, undefined, world.at)
          : personRequest('GET', path, undefined, world.at.baseUrl);
      try {
        const list = await request('/scheduler/jobs');
        expect(list.status).toBe(200);
        expect(list.body.data).toEqual([]);
        const stats = await request('/scheduler/stats');
        expect(stats.status).toBe(200);
        expect(stats.body.data.summary.totalJobs).toBe(0);
        const status = await request('/scheduler/status');
        expect(status.status).toBe(200);
        expect(status.body.data.providers['built-in'].jobCount).toBe(0);
        const logs = await request('/scheduler/jobs/victim-job/logs');
        expect(logs.status).toBe(404);
        const preview = await request(
          '/scheduler/jobs/preview-schedule?cron=*%20*%20*%20*%20*',
        );
        expect(preview.status).toBe(200);
        facts.mayNotRead.delete('conv-victim');
        const allowed =
          caller === 'agent'
            ? await agent(
                'bound',
                'victim',
                'GET',
                '/scheduler/jobs',
                undefined,
                world.at,
              )
            : await request('/scheduler/jobs');
        expect(
          allowed.body.data.map((job: { name: string }) => job.name),
        ).toContain('victim-job');
        const allowedLogs =
          caller === 'agent'
            ? await agent(
                'bound',
                'victim',
                'GET',
                '/scheduler/jobs/victim-job/logs',
                undefined,
                world.at,
              )
            : await request('/scheduler/jobs/victim-job/logs');
        expect(allowedLogs.status).toBe(200);
      } finally {
        await world.close();
      }
    },
  );
  test('inaccessible targeted failure must not leak through notifications', async () => {
    const directory = makeTempDir('round2-notifications-');
    const bus = new EventBus();
    const frames: unknown[] = [];
    bus.subscribe((frame) => frames.push(frame));
    const notifications = new NotificationService(bus, directory, 999_999);
    const scheduler = new SchedulerService({
      logger: quietLogger(),
      builtin: {
        ledger: createSchedulerLedger({ directory }),
        turnAdapter: { invoke: vi.fn() },
        notificationService: notifications,
        conversationRuns: {
          run: async () => ({
            kind: 'failed',
            error: 'private prompt marker round2-secret',
            conversationId: 'conv-victim',
          }),
        },
      },
    });
    const served = await boot({
      hosted: false,
      scheduler,
      notifications,
      retargetsGrantedJob: () => false,
    });
    try {
      await scheduler.addJob({
        name: 'private-job-name',
        schedule: { kind: 'every', everyMs: 60_000 },
        prompt: 'private prompt marker round2-secret',
        target: { kind: 'conversation', conversationId: 'conv-victim' },
        createdBy: { userId: 'victim-person' },
      });
      for (let index = 0; index < 5; index++)
        await scheduler.runJob('private-job-name');
      await notifications.schedule('scheduler', {
        category: 'external-monitor',
        title: 'private-job-name monitor',
        body: 'round2-secret',
        dedupeTag: 'monitor:private-job-name',
        metadata: { jobName: 'private-job-name' },
      });
      facts.mayNotRead.add('conv-victim');
      expect(
        (
          await personRequest(
            'GET',
            '/scheduler/jobs',
            undefined,
            served.baseUrl,
          )
        ).body.data,
      ).toEqual([]);
      expect(
        (await personRequest('GET', '/api/runs', undefined, served.baseUrl))
          .body.data,
      ).toEqual([]);
      const result = await personRequest(
        'GET',
        '/notifications',
        undefined,
        served.baseUrl,
      );
      expect(result.status).toBe(200);
      expect(result.body.data.length).toBeGreaterThanOrEqual(7);
      for (const projected of [result.body, frames]) {
        expect(JSON.stringify(projected)).not.toContain('round2-secret');
        expect(JSON.stringify(projected)).not.toContain('private-job-name');
      }
      expect(
        result.body.data.map(
          (notification: { title: string }) => notification.title,
        ),
      ).toContain('An automation failed');
      expect(
        result.body.data.map(
          (notification: { title: string }) => notification.title,
        ),
      ).toContain('An automation monitor needs attention');
    } finally {
      await served.close();
      await scheduler.stop();
      await notifications.shutdown();
    }
  });

  test('retargeted conversation schedule must not expose old chat run fields', async () => {
    const world = await realWorld();
    try {
      await world.scheduler.runJob('victim-job');
      await world.scheduler.editJob('victim-job', {
        target: { kind: 'conversation', conversationId: 'conv-new' },
      });
      const filtered = await agent(
        'bound',
        'new',
        'GET',
        '/scheduler/jobs',
        undefined,
        world.at,
      );
      expect(filtered.body.data[0]).not.toHaveProperty('lastSuccessAt');
      expect(filtered.body.data[0]).not.toHaveProperty('lastRunMs');
      const result = await agent(
        'bound',
        'new',
        'GET',
        '/api/orchestration/agent-schedule/conv-new',
        undefined,
        world.at,
      );
      expect(result.status).toBe(200);
      expect(result.body.data.automations[0]).not.toHaveProperty(
        'lastSuccessAt',
      );
      expect(result.body.data.automations[0]).not.toHaveProperty(
        'consecutiveFailures',
      );
      facts.mayNotRead.add('conv-victim');
      const person = await personRequest(
        'GET',
        '/api/orchestration/agent-schedule/conv-new',
        undefined,
        world.at.baseUrl,
      );
      expect(person.status).toBe(200);
      expect(person.body.data.automations[0]).not.toHaveProperty(
        'lastSuccessAt',
      );
      expect(person.body.data.automations[0]).not.toHaveProperty(
        'consecutiveFailures',
      );
    } finally {
      await world.close();
    }
  });

  test('creatorless legacy job remains inspectable by the operator', async () => {
    const world = await realWorld();
    try {
      await world.scheduler.addJob({
        name: 'legacy',
        schedule: { kind: 'every', everyMs: 60_000 },
        prompt: 'legacy operator prompt',
      });
      await world.scheduler.runJob('legacy');
      const db = new DatabaseSync(join(world.directory, 'scheduler.sqlite'));
      db.prepare(
        "UPDATE scheduler_logs SET data = json_remove(data, '$.runTarget') WHERE job_name = ?",
      ).run('legacy');
      db.close();
      expect((await world.scheduler.getJobLogs('legacy')).length).toBe(1);
      const jobs = await personRequest(
        'GET',
        '/scheduler/jobs',
        undefined,
        world.at.baseUrl,
      );
      expect(
        jobs.body.data.find((job: any) => job.name === 'legacy').prompt,
      ).toBe('legacy operator prompt');
      const agentJobs = await agent(
        'bound',
        'victim',
        'GET',
        '/scheduler/jobs',
        undefined,
        world.at,
      );
      expect(
        agentJobs.body.data.some((job: any) => job.name === 'legacy'),
      ).toBe(false);
      const result = await personRequest(
        'GET',
        '/scheduler/jobs/legacy/logs',
        undefined,
        world.at.baseUrl,
      );
      expect(result.status).toBe(200);
      expect(result.body.data).toHaveLength(1);
      const runs = await personRequest(
        'GET',
        '/api/runs?source=schedule',
        undefined,
        world.at.baseUrl,
      );
      const legacy = runs.body.data.find(
        (run: { sourceId: string }) => run.sourceId === 'legacy',
      );
      expect(legacy).toBeDefined();
      expect(
        (
          await personRequest(
            'GET',
            `/api/runs/${encodeURIComponent(legacy.runId)}`,
            undefined,
            world.at.baseUrl,
          )
        ).status,
      ).toBe(200);
      expect(legacy.outputRef).toBeDefined();
      expect(
        (
          await personRequest(
            'POST',
            '/api/runs/output',
            legacy.outputRef,
            world.at.baseUrl,
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await agent(
            'bound',
            'victim',
            'GET',
            `/api/runs/${encodeURIComponent(legacy.runId)}`,
            undefined,
            world.at,
          )
        ).status,
      ).toBe(404);
    } finally {
      await world.close();
    }
  });
});

describe('round3 independent reviewer probes', () => {
  const makeTempDir = trackTempDirs();

  test('a different conversation agent must not read the hidden job through diagnostic logs', async () => {
    const directory = makeTempDir('round3-log-probe-');
    const logDirectory = join(directory, 'logs');
    installServerLogSink({ directory: logDirectory });
    const bus = new EventBus();
    const notifications = new NotificationService(bus, directory, 999_999);
    const scheduler = new SchedulerService({
      logger: createLogger({ name: 'round3-scheduler', level: 'info' }),
      builtin: {
        ledger: createSchedulerLedger({ directory }),
        notificationService: notifications,
        turnAdapter: { invoke: vi.fn() },
        conversationRuns: {
          run: async () => ({
            kind: 'failed',
            error: 'round3-private-answer-marker',
            conversationId: 'conv-victim',
          }),
        },
      },
    });
    const served = await boot({
      hosted: false,
      scheduler,
      notifications,
      logDirectory,
      retargetsGrantedJob: () => false,
    });
    try {
      await scheduler.addJob({
        name: 'round3-private-job',
        schedule: { kind: 'every', everyMs: 60_000 },
        prompt: 'round4-private-prompt',
        target: { kind: 'conversation', conversationId: 'conv-victim' },
        createdBy: { userId: 'victim-person' },
      });
      for (let index = 0; index < 5; index++)
        await scheduler.runJob('round3-private-job');
      const at = { baseUrl: served.baseUrl, port: served.port };
      const listed = await agent(
        'bound',
        'other',
        'GET',
        '/scheduler/jobs',
        undefined,
        at,
      );
      expect(listed.status).toBe(200);
      expect(listed.body.data).toEqual([]);
      const logs = await agent(
        'bound',
        'other',
        'GET',
        '/scheduler/jobs/round3-private-job/logs',
        undefined,
        at,
      );
      expect(logs.status).toBe(404);
      const bell = await notifications.list();
      expect(JSON.stringify(bell)).not.toContain('round3-private');
      const direct = await createServerLogReader({
        directory: logDirectory,
      }).query({});
      expect(direct.entries.length).toBeGreaterThanOrEqual(10);
      expect(JSON.stringify(direct)).not.toContain('round3-private');
      expect(JSON.stringify(direct)).not.toContain('round4-private-prompt');
      expect(
        direct.entries.some(
          (entry) =>
            entry.msg === 'Scheduler job failed' &&
            entry.errorClass === 'SchedulerRunFailure' &&
            entry['station.scheduler.target_kind'] === 'conversation',
        ),
      ).toBe(true);
      expect(
        direct.entries.some(
          (entry) =>
            entry.msg === 'Automation disabled after repeated failures' &&
            entry.targetKind === 'conversation' &&
            entry.errorClass === 'SchedulerFatigue',
        ),
      ).toBe(true);
      expect(
        (await scheduler.getJobLogs('round3-private-job'))[0]!.error,
      ).toContain('round3-private-answer-marker');
      const diagnostics = await agent(
        'bound',
        'other',
        'GET',
        '/api/diagnostics/logs?q=round3-private',
        undefined,
        at,
      );
      expect(diagnostics.status).toBe(403);
      expect(JSON.stringify(diagnostics.body)).not.toContain('round3-private');
    } finally {
      await served.close();
      await scheduler.stop();
      await notifications.shutdown();
      resetServerLogSinkForTests();
    }
  });
});

describe('diagnostics agent authority', () => {
  const makeTempDir = trackTempDirs();
  test('an agent cannot read diagnostics without an explicit operator grant', async () => {
    const served = await boot({
      hosted: false,
      logDirectory: makeTempDir('diagnostics-agent-'),
    });
    try {
      for (const channel of [
        'bound',
        'delegated-custody',
        'bearer-exposed',
      ] as const) {
        const response = await agent(
          channel,
          'victim',
          'GET',
          '/api/diagnostics/logs',
          undefined,
          served,
        );
        expect(response.status).toBe(403);
      }
      const person = await personRequest(
        'GET',
        '/api/diagnostics/logs',
        undefined,
        served.baseUrl,
      );
      expect(person.status).toBe(200);
    } finally {
      await served.close();
    }
  });

  test('an operator can grant and revoke diagnostics for one bound agent session', async () => {
    const root = makeTempDir('diagnostics-grant-');
    const directory = makeTempDir('diagnostics-grant-logs-');
    writeFileSync(
      join(directory, 'server-2026-10-29.ndjson'),
      JSON.stringify({
        level: 'info',
        timestamp: '2026-10-29T00:00:00.000Z',
        msg: 'private conversation marker',
      }) + '\n',
    );
    const store = new UnattendedGrantStore(root);
    const served = await boot({
      hosted: false,
      logDirectory: directory,
      diagnosticGrantStore: store,
    });
    const grant = {
      principalKey: JSON.stringify({
        kind: 'diagnostics-session',
        sessionId: 'victim',
      }),
      toolName: 'station-control:read_logs',
    };
    try {
      const denied = await agent(
        'bound',
        'victim',
        'GET',
        '/api/diagnostics/logs',
        undefined,
        served,
      );
      expect(denied.status).toBe(403);
      const attempted = await agent(
        'bound',
        'victim',
        'POST',
        '/api/agents/unattended-grants',
        grant,
        served,
      );
      expect(attempted.status).toBeGreaterThanOrEqual(400);
      const granted = await personRequest(
        'POST',
        '/api/agents/unattended-grants',
        grant,
        served.baseUrl,
      );
      expect(granted.status, JSON.stringify(granted.body)).toBe(200);
      const allowed = await agent(
        'bound',
        'victim',
        'GET',
        '/api/diagnostics/logs',
        undefined,
        served,
      );
      expect(allowed.status).toBe(200);
      expect(JSON.stringify(allowed.body)).toContain(
        'private conversation marker',
      );
      expect(
        (
          await agent(
            'bound',
            'other',
            'GET',
            '/api/diagnostics/logs',
            undefined,
            served,
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await agent(
            'bearer-exposed',
            'victim',
            'GET',
            '/api/diagnostics/logs',
            undefined,
            served,
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await personRequest(
            'POST',
            '/api/agents/unattended-grants/revoke',
            grant,
            served.baseUrl,
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await agent(
            'bound',
            'victim',
            'GET',
            '/api/diagnostics/logs',
            undefined,
            served,
          )
        ).status,
      ).toBe(403);
    } finally {
      await served.close();
    }
  });
});

describe('legacy scheduler diagnostics privacy', () => {
  const makeTempDir = trackTempDirs();
  test('an agent refused untargeted run history must not receive it from read_logs', async () => {
    const directory = makeTempDir('pr4289-r4-legacy-');
    const logDirectory = join(directory, 'logs');
    installServerLogSink({ directory: logDirectory });
    const scheduler = new SchedulerService({
      logger: createLogger({
        name: 'round4-independent-legacy',
        level: 'info',
      }),
      builtin: {
        ledger: createSchedulerLedger({ directory }),
        turnAdapter: {
          invoke: async () => ({
            kind: 'failed',
            error: 'round4-legacy-private-engine-answer',
          }),
        },
      },
    });
    const served = await boot({
      hosted: false,
      scheduler,
      logDirectory,
      retargetsGrantedJob: () => false,
    });
    try {
      await scheduler.addJob({
        name: 'round4-legacy-private-job',
        schedule: { kind: 'every', everyMs: 3_600_000 },
        prompt: 'round4-legacy-private-prompt',
      });
      await scheduler.runJob('round4-legacy-private-job');
      const at = { baseUrl: served.baseUrl, port: served.port };
      const listed = await agent(
        'bound',
        'other',
        'GET',
        '/scheduler/jobs',
        undefined,
        at,
      );
      expect(listed.status).toBe(200);
      expect(listed.body.data).toEqual([]);
      const protectedLogs = await agent(
        'bound',
        'other',
        'GET',
        '/scheduler/jobs/round4-legacy-private-job/logs',
        undefined,
        at,
      );
      expect(protectedLogs.status).toBe(404);
      const raw = await scheduler.getJobLogs('round4-legacy-private-job');
      expect(raw[0]!.runTarget).toBeNull();
      expect(raw[0]!.error).toContain('round4-legacy-private-engine-answer');
      const allLogs = await createServerLogReader({
        directory: logDirectory,
      }).query({});
      expect(
        allLogs.entries.some(
          (entry) =>
            entry.msg === 'Scheduler job failed' &&
            entry['station.scheduler.target_kind'] === 'untargeted' &&
            entry.errorClass === 'SchedulerRunFailure' &&
            typeof entry['station.scheduler.job_id'] === 'string' &&
            typeof entry['station.scheduler.job_run_id'] === 'string',
        ),
      ).toBe(true);
      expect(JSON.stringify(allLogs)).not.toContain('round4-legacy-private');
      const diagnostics = await agent(
        'bound',
        'other',
        'GET',
        '/api/diagnostics/logs?q=round4-legacy-private',
        undefined,
        at,
      );
      expect(diagnostics.status).toBe(403);
      expect(JSON.stringify(diagnostics.body)).not.toContain(
        'round4-legacy-private',
      );
    } finally {
      await served.close();
      await scheduler.stop();
      resetServerLogSinkForTests();
    }
  });
});

/**
 * #2377 slice D review (HIGH B): an untargeted job's runs act as its recorded
 * owner, so editing, running, enabling, disabling or deleting it is admitted
 * against that owner, for people and for the agent tools (`update_job`,
 * `run_job`), the same way a targeted automation is. Real boundary, guard,
 * composition, scheduler routes, BuiltinScheduler and SQLite ledger.
 */
describe('acting on an untargeted job is admitted against its owner', () => {
  const makeTempDir = trackTempDirs();
  const turns: string[] = [];
  const runOwners: Array<string | undefined> = [];
  const projectRuns: string[] = [];

  async function ownedWorld(
    owner: string,
    requestUserId?: () => string,
    credentialAuthority?: 'operator-credential' | 'device-credential',
    extra: {
      ownerStanding?: boolean;
      target?: SchedulerAutomationTarget;
      /** A Project job (#5070), whose runs go to the Project runner. */
      projectId?: string;
    } = {},
  ) {
    const scheduler = new SchedulerService({
      logger: quietLogger(),
      builtin: {
        ledger: createSchedulerLedger({
          directory: makeTempDir('untargeted-owner-'),
        }),
        turnAdapter: {
          invoke: async (input) => {
            turns.push(input.prompt);
            // Who the run's Station tools act for (`createdBy`).
            runOwners.push(input.receipt.job.createdBy?.userId);
            return { kind: 'completed', output: '' };
          },
        },
        ...(extra.projectId
          ? {
              projectRuns: {
                invoke: async (input: {
                  prompt: string;
                  createdBy?: { userId: string };
                }) => {
                  projectRuns.push(input.prompt);
                  // #5126: who the Project run's Task acts as.
                  runOwners.push(input.createdBy?.userId);
                  return { kind: 'completed' as const, output: '' };
                },
              },
              projectHold: {
                heldProjectIds: () => new Set<string>(),
                heldProjectSlugs: () => new Set<string>(),
                projectExists: (id: string) => id === extra.projectId,
              },
            }
          : {}),
      },
    });
    const served = await boot({
      hosted: false,
      scheduler,
      retargetsGrantedJob: () => false,
      ...(requestUserId ? { requestUserId } : {}),
      ...(credentialAuthority ? { credentialAuthority } : {}),
      ...(extra.ownerStanding ? { ownerStanding: true } : {}),
      ...(extra.projectId
        ? {
            projectAccess: {
              projectExists: (id) => id === extra.projectId,
              principalMayInProject:
                createProjectPrincipalPermission(undefined),
            },
          }
        : {}),
    });
    await scheduler.addJob({
      name: 'owned-job',
      schedule: { kind: 'every', everyMs: 60_000 },
      prompt: 'Original',
      createdBy: { userId: owner },
      ...(extra.target ? { target: extra.target } : {}),
      ...(extra.projectId ? { projectId: extra.projectId } : {}),
    });
    return {
      scheduler,
      at: { baseUrl: served.baseUrl, port: served.port },
      close: async () => {
        await served.close();
        await scheduler.stop();
      },
    };
  }

  afterEach(() => {
    turns.length = 0;
    runOwners.length = 0;
    projectRuns.length = 0;
  });

  test.each([
    ['DELETE', '/scheduler/jobs/owned-job'],
    ['PUT', '/scheduler/jobs/owned-job/enable'],
    ['PUT', '/scheduler/jobs/owned-job/disable'],
  ])('another person cannot %s %s', async (method, path) => {
    const world = await ownedWorld(
      'human:local:person-a',
      () => 'human:local:person-b',
      'device-credential',
    );
    try {
      const response = await personRequest(
        method,
        path,
        undefined,
        world.at.baseUrl,
      );
      expect([response.status, response.body.code]).toEqual([
        404,
        'automation_not_found',
      ]);
      const [job] = await world.scheduler.listJobs();
      expect(job?.name).toBe('owned-job');
      expect(job?.enabled).toBe(true);
    } finally {
      await world.close();
    }
  });

  // Owner decision 2026-11-16: the operator in person may manage any owned
  // untargeted job; its runs still act as the job's owner.
  test('the operator in person may edit, disable and delete a job a device owns', async () => {
    const world = await ownedWorld('device:local:phone');
    try {
      const edited = await personRequest(
        'PUT',
        '/scheduler/jobs/owned-job',
        { prompt: 'Revised by the operator' },
        world.at.baseUrl,
      );
      expect(edited.status).toBe(200);
      const disabled = await personRequest(
        'PUT',
        '/scheduler/jobs/owned-job/disable',
        undefined,
        world.at.baseUrl,
      );
      expect(disabled.status).toBe(200);
      expect((await world.scheduler.listJobs())[0]).toMatchObject({
        prompt: 'Revised by the operator',
        enabled: false,
        // Editing never changes who it runs as.
        createdBy: { userId: 'device:local:phone' },
      });
      const deleted = await personRequest(
        'DELETE',
        '/scheduler/jobs/owned-job',
        undefined,
        world.at.baseUrl,
      );
      expect(deleted.status).toBe(200);
      expect(await world.scheduler.listJobs()).toEqual([]);
    } finally {
      await world.close();
    }
  });

  test('a run the operator triggers still acts as the device that owns the job', async () => {
    const world = await ownedWorld('device:local:phone');
    try {
      const ran = await personRequest(
        'POST',
        '/scheduler/jobs/owned-job/run',
        undefined,
        world.at.baseUrl,
      );
      expect(ran.status).toBe(200);
      await vi.waitFor(() => expect(runOwners).toEqual(['device:local:phone']));
    } finally {
      await world.close();
    }
  });

  test('the operator in person cannot point a job a device owns at a conversation', async () => {
    const world = await ownedWorld('device:local:phone');
    try {
      for (const target of [
        { kind: 'dedicated', agent: 'helper' },
        { kind: 'conversation', conversationId: 'conversation-of-operator' },
      ]) {
        const edited = await personRequest(
          'PUT',
          '/scheduler/jobs/owned-job',
          { prompt: 'Retargeted', target },
          world.at.baseUrl,
        );
        expect([edited.status, edited.body.code]).toEqual([
          403,
          'automation_target_owner_only',
        ]);
      }
      const [job] = await world.scheduler.listJobs();
      expect(job).toMatchObject({
        prompt: 'Original',
        createdBy: { userId: 'device:local:phone' },
      });
      expect(job?.target).toBeUndefined();
      // The control: an edit that leaves the target alone is still admitted.
      const untouched = await personRequest(
        'PUT',
        '/scheduler/jobs/owned-job',
        { prompt: 'Revised', target: null },
        world.at.baseUrl,
      );
      expect(untouched.status).toBe(200);
    } finally {
      await world.close();
    }
  });

  test('the override reaches only untargeted jobs: a not-yet-started dedicated job another person owns stays theirs', async () => {
    const world = await ownedWorld(
      'human:local:person-a',
      undefined,
      undefined,
      { target: { kind: 'dedicated', agent: 'helper' } },
    );
    try {
      const [stored] = await world.scheduler.listJobs();
      // The control: the job has a target but no conversation yet.
      expect(stored?.target).toEqual({ kind: 'dedicated', agent: 'helper' });
      for (const [method, path, body] of [
        ['PUT', '/scheduler/jobs/owned-job', { prompt: 'Injected' }],
        ['PUT', '/scheduler/jobs/owned-job/disable', undefined],
        ['POST', '/scheduler/jobs/owned-job/run', undefined],
        ['DELETE', '/scheduler/jobs/owned-job', undefined],
      ] as const) {
        const response = await personRequest(
          method,
          path,
          body,
          world.at.baseUrl,
        );
        expect([method, path, response.status]).toEqual([method, path, 404]);
      }
      expect(turns).toEqual([]);
      expect((await world.scheduler.listJobs())[0]).toMatchObject({
        prompt: 'Original',
        enabled: true,
      });
    } finally {
      await world.close();
    }
  });

  test('an owner device signed in as someone else gets no override', async () => {
    // One of the owner's paired devices (owner-device standing), whose
    // requests resolve to a different user than the job's owner.
    const world = await ownedWorld(
      'device:local:phone',
      () => 'device:local:tablet',
      'device-credential',
      { ownerStanding: true },
    );
    try {
      const edited = await personRequest(
        'PUT',
        '/scheduler/jobs/owned-job',
        { prompt: 'Injected' },
        world.at.baseUrl,
      );
      expect([edited.status, edited.body.code]).toEqual([
        404,
        'automation_not_found',
      ]);
      const deleted = await personRequest(
        'DELETE',
        '/scheduler/jobs/owned-job',
        undefined,
        world.at.baseUrl,
      );
      expect(deleted.status).toBe(404);
      expect((await world.scheduler.listJobs())[0]?.prompt).toBe('Original');
    } finally {
      await world.close();
    }
  });

  // Owner decision 2026-11-16 (#5126): a Project job is gated on its
  // creator like any untargeted job, and its run acts as that creator.
  test('a Project job is gated on its creator, and the operator in person may still manage it', async () => {
    const other = await ownedWorld(
      'human:local:person-a',
      () => 'human:local:person-b',
      'device-credential',
      { projectId: 'project-1' },
    );
    try {
      // The control: the job really is a Project job.
      expect((await other.scheduler.listJobs())[0]?.projectId).toBe(
        'project-1',
      );
      const edited = await personRequest(
        'PUT',
        '/scheduler/jobs/owned-job',
        { prompt: 'Injected' },
        other.at.baseUrl,
      );
      expect([edited.status, edited.body.code]).toEqual([
        404,
        'automation_not_found',
      ]);
      const ran = await personRequest(
        'POST',
        '/scheduler/jobs/owned-job/run',
        undefined,
        other.at.baseUrl,
      );
      expect(ran.status).toBe(404);
      expect(projectRuns).toEqual([]);
    } finally {
      await other.close();
    }
    const operator = await ownedWorld(
      'human:local:person-a',
      undefined,
      undefined,
      {
        projectId: 'project-1',
      },
    );
    try {
      const edited = await personRequest(
        'PUT',
        '/scheduler/jobs/owned-job',
        { prompt: 'Revised by the operator' },
        operator.at.baseUrl,
      );
      expect(edited.status).toBe(200);
      const ran = await personRequest(
        'POST',
        '/scheduler/jobs/owned-job/run',
        undefined,
        operator.at.baseUrl,
      );
      expect(ran.status).toBe(200);
      await vi.waitFor(() =>
        expect(projectRuns).toEqual(['Revised by the operator']),
      );
      // The operator in person ran it, but the run acts as its owner.
      expect(runOwners).toEqual(['human:local:person-a']);
    } finally {
      await operator.close();
    }
  });

  test('an agent acting for the operator gets no override on a job a device owns', async () => {
    const world = await ownedWorld('device:local:phone');
    try {
      const edited = await agent(
        'bound',
        nextSession(),
        'PUT',
        '/scheduler/jobs/owned-job',
        { prompt: 'Injected' },
        world.at,
      );
      expect(edited.status).toBe(403);
      expect((await world.scheduler.listJobs())[0]?.prompt).toBe('Original');
    } finally {
      await world.close();
    }
  });

  test('another person (a second local account) cannot update or run it', async () => {
    // Person B signs in on their own device: a device credential.
    const world = await ownedWorld(
      'human:local:person-a',
      () => 'human:local:person-b',
      'device-credential',
    );
    try {
      const edited = await personRequest(
        'PUT',
        '/scheduler/jobs/owned-job',
        { prompt: 'Injected' },
        world.at.baseUrl,
      );
      expect([edited.status, edited.body.code]).toEqual([
        404,
        'automation_not_found',
      ]);
      const ran = await personRequest(
        'POST',
        '/scheduler/jobs/owned-job/run',
        undefined,
        world.at.baseUrl,
      );
      expect(ran.status).toBe(404);
      expect(turns).toEqual([]);
      expect((await world.scheduler.listJobs())[0]?.prompt).toBe('Original');
    } finally {
      await world.close();
    }
  });

  test('a paired device without owner standing cannot edit a job owned by the operator', async () => {
    // Such a device's requests resolve to the device itself, not the operator.
    const world = await ownedWorld(
      LOCAL_OPERATOR_PRINCIPAL_ID,
      () => 'device:local:phone',
      'device-credential',
    );
    try {
      const edited = await personRequest(
        'PUT',
        '/scheduler/jobs/owned-job',
        { prompt: 'Injected' },
        world.at.baseUrl,
      );
      expect(edited.status).toBe(404);
      expect((await world.scheduler.listJobs())[0]?.prompt).toBe('Original');
    } finally {
      await world.close();
    }
  });

  test('its owner may update and run it', async () => {
    const world = await ownedWorld(LOCAL_OPERATOR_PRINCIPAL_ID);
    try {
      const edited = await personRequest(
        'PUT',
        '/scheduler/jobs/owned-job',
        { prompt: 'Revised' },
        world.at.baseUrl,
      );
      expect(edited.status).toBe(200);
      const ran = await personRequest(
        'POST',
        '/scheduler/jobs/owned-job/run',
        undefined,
        world.at.baseUrl,
      );
      expect(ran.status).toBe(200);
      await vi.waitFor(() => expect(turns).toEqual(['Revised']));
    } finally {
      await world.close();
    }
  });

  test('update_job and run_job: an agent acting for another person cannot touch it', async () => {
    const world = await ownedWorld('human:local:person-a');
    try {
      const edited = await agent(
        'bound',
        nextSession(),
        'PUT',
        '/scheduler/jobs/owned-job',
        { prompt: 'Injected' },
        world.at,
      );
      expect(edited.status).toBe(403);
      const ran = await agent(
        'bound',
        nextSession(),
        'POST',
        '/scheduler/jobs/owned-job/run',
        undefined,
        world.at,
      );
      expect(ran.status).toBe(403);
      expect(turns).toEqual([]);
    } finally {
      await world.close();
    }
  });

  test('update_job and run_job: an agent acting for the owner may', async () => {
    const world = await ownedWorld(LOCAL_OPERATOR_PRINCIPAL_ID);
    try {
      const edited = await agent(
        'bound',
        nextSession(),
        'PUT',
        '/scheduler/jobs/owned-job',
        { prompt: 'Revised' },
        world.at,
      );
      expect(edited.status).toBe(200);
      const ran = await agent(
        'bound',
        nextSession(),
        'POST',
        '/scheduler/jobs/owned-job/run',
        undefined,
        world.at,
      );
      expect(ran.status).toBe(200);
    } finally {
      await world.close();
    }
  });
});

describe('Project schedule membership', () => {
  const makeTempDir = trackTempDirs();

  async function projectWorld() {
    const home = makeTempDir('project-schedule-membership-');
    const storage = new FileStorageAdapter(home);
    const manifests = new ProjectManifestStore(home, storage);
    const projects = new ProjectService(storage, manifests);
    const project = await projects.createProject({
      name: 'Atlas',
      slug: 'atlas',
    });
    const db = new DatabaseSync(':memory:');
    const membership = new ProjectMembershipService(
      'station-one',
      storage,
      manifests,
      new ProjectMembershipStore(db, 'station-one'),
    );
    const owner = deploymentAccountPrincipal('issuer', 'owner', 'Owner');
    const member = deploymentAccountPrincipal('issuer', 'member', 'Member');
    const outsider = deploymentAccountPrincipal(
      'issuer',
      'outsider',
      'Outsider',
    );
    let actor = owner;
    const access: ProjectMembershipAuthority = {
      current: async () => ({
        principal: actor,
        verifiedEmails: actor.id === member.id ? ['member@example.test'] : [],
      }),
      operator: async () => undefined,
    };
    const view = await membership.enable(project.slug, project.id, access);
    const invitation = await membership.invite(
      view.scope,
      {
        email: 'member@example.test',
        role: 'contributor',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
      access,
    );
    actor = member;
    await membership.accept(invitation.token, access);
    actor = outsider;
    const projectExists = (id: string) =>
      projects.listProjects().some((candidate) => candidate.id === id);
    const scheduler = new SchedulerService({
      logger: quietLogger(),
      builtin: {
        ledger: createSchedulerLedger({ directory: home }),
        turnAdapter: { invoke: vi.fn() },
        projectRuns: {
          invoke: async () => ({ kind: 'completed', output: '' }),
        },
        projectHold: {
          heldProjectIds: () => new Set(),
          heldProjectSlugs: () => new Set(),
          projectExists,
        },
      },
    });
    const served = await boot({
      hosted: false,
      scheduler,
      credentialAuthority: 'device-credential',
      requestUserId: () => actor.id,
      retargetsGrantedJob: () => false,
      projectAccess: {
        projectExists,
        principalMayInProject: createProjectPrincipalPermission(membership),
      },
    });
    const job = {
      name: 'atlas-digest',
      schedule: { kind: 'every', everyMs: 3_600_000 } as const,
      prompt: 'Summarize Atlas activity',
      projectId: project.id,
    };
    return {
      job,
      member,
      scheduler,
      request: (method: string, path: string, body?: unknown) =>
        personRequest(method, path, body, served.baseUrl),
      signInAsMember: () => {
        actor = member;
      },
      demoteMember: async () => {
        actor = owner;
        await membership.changeMember(
          view.scope,
          member.id,
          1,
          { role: 'viewer', status: 'active' },
          access,
        );
        actor = member;
      },
      close: async () => {
        await served.close();
        await scheduler.stop();
        db.close();
      },
    };
  }

  test('a non-member cannot read a Project job or its runs, while a member can', async () => {
    const { job, member, scheduler, request, signInAsMember, close } =
      await projectWorld();
    try {
      await scheduler.addJob({ ...job, createdBy: { userId: member.id } });
      expect((await scheduler.runJob(job.name)).outcome).toBe('completed');
      const logs = `/scheduler/jobs/${job.name}/logs`;
      expect((await request('GET', '/scheduler/jobs')).body.data).toEqual([]);
      expect((await request('GET', logs)).status).toBe(404);
      for (const [path, body] of [
        ['restart', undefined],
        ['resolve', { triggerId: 'test-trigger', action: 'resolve' }],
      ] as const) {
        for (const name of [job.name, 'missing']) {
          const response = await request(
            'POST',
            `/scheduler/jobs/${name}/monitor/${path}`,
            body,
          );
          expect(response).toEqual({
            status: 404,
            body: { success: false, error: 'Job not found' },
          });
        }
      }
      signInAsMember();
      expect((await request('GET', '/scheduler/jobs')).body.data).toEqual([
        expect.objectContaining({
          name: job.name,
          prompt: job.prompt,
          projectId: job.projectId,
          createdBy: { userId: member.id },
        }),
      ]);
      expect((await request('GET', logs)).body.data).toEqual([
        expect.objectContaining({ job: job.name, success: true }),
      ]);
    } finally {
      await close();
    }
  });

  test('only a member with execute may create a job in an existing Project', async () => {
    const { job, member, scheduler, request, signInAsMember, close } =
      await projectWorld();
    try {
      const jobs = '/scheduler/jobs';
      expect((await request('POST', jobs, job)).status).toBe(404);
      expect(await scheduler.listJobs()).toEqual([]);
      signInAsMember();
      expect(
        (await request('POST', jobs, { ...job, projectId: 'missing-project' }))
          .status,
      ).toBe(404);
      expect((await request('POST', jobs, job)).status).toBe(200);
      expect(await scheduler.listJobs()).toEqual([
        expect.objectContaining({
          name: job.name,
          projectId: job.projectId,
          createdBy: { userId: member.id },
        }),
      ]);
    } finally {
      await close();
    }
  });

  test('a demoted creator can read and clean up the job but cannot edit, enable, or run it', async () => {
    const { job, scheduler, request, signInAsMember, demoteMember, close } =
      await projectWorld();
    try {
      const path = `/scheduler/jobs/${job.name}`;
      signInAsMember();
      expect((await request('POST', '/scheduler/jobs', job)).status).toBe(200);
      expect((await request('PUT', path, { prompt: 'Revised' })).status).toBe(
        200,
      );
      await demoteMember();
      expect((await request('GET', '/scheduler/jobs')).body.data).toEqual([
        expect.objectContaining({ name: job.name, prompt: 'Revised' }),
      ]);
      expect((await request('PUT', path, { prompt: 'Denied' })).status).toBe(
        404,
      );
      expect((await request('POST', `${path}/run`)).status).toBe(404);
      expect((await request('PUT', `${path}/disable`)).status).toBe(200);
      expect((await request('PUT', `${path}/enable`)).status).toBe(404);
      expect(await scheduler.listJobs()).toEqual([
        expect.objectContaining({
          name: job.name,
          prompt: 'Revised',
          enabled: false,
        }),
      ]);
      expect((await request('DELETE', path)).status).toBe(200);
      expect(await scheduler.listJobs()).toEqual([]);
    } finally {
      await close();
    }
  });
});
