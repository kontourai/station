/**
 * Agent wake-ups and job proposals through the REAL boundary: a listening
 * server with the production runtime security boundary, the production
 * station-control guard, the production agent-schedule and scheduler
 * routes over a real SQLite store, the production HTTP MCP route serving
 * the real tool registrations, and real token mints per delivery channel.
 * Only the thread inbox the wake-up is handed to and the scheduler service
 * are recording stubs.
 *
 * Session ids name what the server records for them: `op-` is owned by the
 * operator, `host-` runs unconfined; each session's conversation is
 * `conv-<session id>`.
 */
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { serve } from '@hono/node-server';
import {
  AGENT_WAKE_UP_MAX_HORIZON_MS,
  AGENT_WAKE_UP_MAX_PENDING_PER_CONVERSATION,
  AGENT_WAKE_UP_NOTE_MAX_CHARS,
} from '@kontourai/station-contracts/agent-schedule';
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
import { createStationControlMcpRoutes } from '../../routes/mcp/station-control-mcp-route.js';
import { createSchedulerRoutes } from '../../routes/operations/scheduler.js';
import {
  createAgentScheduleRoutes,
  createJobProposalApproval,
} from '../../routes/orchestration/agent-schedule.js';
import { resolveDispatchActor } from '../../routes/orchestration/orchestration.js';
import { configureRuntimeHttp } from '../../runtime/bootstrap/runtime-http.js';
import {
  createAgentDispatchActorResolver,
  resolveStationControlCallerForRequest,
  type StationControlCallerRecordResolver,
} from '../../runtime/mcp/station-control-caller.js';
import {
  __resetStationControlMcpTokensForTests,
  mintStationControlMcpHeaderAuth,
  mintStationControlMcpToken,
} from '../../runtime/mcp/station-control-mcp-token.js';
import {
  LOCAL_OPERATOR_PRINCIPAL_ID,
  principalForRecordedSessionOwner,
} from '../../services/identity/principal-resolver.js';
import {
  type AgentScheduleStore,
  AgentWakeUpDelivery,
  createSqliteAgentScheduleStore,
  wakeUpClientTurnId,
} from '../../services/orchestration/agent-schedule.js';
import type { EventBus } from '../../services/orchestration/event-bus.js';
import type { SchedulerService } from '../../services/scheduling/scheduler-service.js';
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

let server: ReturnType<typeof serve>;
let baseUrl: string;
let port: number;
let store: AgentScheduleStore;
let delivery: AgentWakeUpDelivery;
const clock = { now: 1_800_000_000_000 };
const refusals: string[] = [];
const submitted: Array<{
  conversationId: string;
  clientTurnId: string;
  payload: any;
}> = [];
const addJob = vi.fn(
  async (opts: { name: string }) => `Job '${opts.name}' created`,
);

function newDelivery(now: () => number) {
  return new AgentWakeUpDelivery({
    store,
    submit: (input) => {
      submitted.push(input);
      return {
        outcome: 'queued',
        entry: {
          conversationId: input.conversationId,
          clientTurnId: input.clientTurnId,
          kind: 'follow-up',
          state: 'queued',
          message: input.payload.message,
          createdAt: '',
          updatedAt: '',
        },
      } as never;
    },
    logger: quietLogger(),
    now,
  });
}

/** The person behind a credential request; never an internal one. */
const person = (c: any) =>
  getRuntimeAuthenticatedRequestPrincipal(c.req.raw)?.kind === 'credential'
    ? {
        userId: LOCAL_OPERATOR_PRINCIPAL_ID,
        mayRead: () => true,
        mayMutate: () => true,
      }
    : undefined;

beforeAll(async () => {
  __resetStationServerSelfAttestationForTests();
  store = createSqliteAgentScheduleStore(new DatabaseSync(':memory:'));
  delivery = newDelivery(() => clock.now);
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
      // The production composition's read.
      wakeUpConversation: (wakeUpId) => store.wakeUp(wakeUpId)?.conversationId,
      onRefusal: (refusal) => refusals.push(refusal.code),
    }),
  );
  let resolvePort!: (value: number) => void;
  const listening = new Promise<number>((resolve) => {
    resolvePort = resolve;
  });
  server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, (info) =>
    resolvePort((info as AddressInfo).port),
  );
  port = await listening;
  baseUrl = `http://127.0.0.1:${port}`;
  process.env.STATION_API_BASE = baseUrl;
  app.route(
    '',
    createStationControlMcpRoutes({ port, resolveCallerRecord: resolveRecord }),
  );
  const resolveAgentDispatchActor =
    createAgentDispatchActorResolver(resolveRecord);
  app.route(
    '/api/orchestration',
    createAgentScheduleRoutes({
      isInternalRequest: (request) =>
        getRuntimeAuthenticatedRequestPrincipal(request)?.kind === 'internal',
      scope: {
        target: (ref) =>
          ref.kind === 'thread'
            ? {
                ownerId: LOCAL_OPERATOR_PRINCIPAL_ID,
                scope: { kind: 'project', id: 'local-project-a' },
                host: ref.threadId.startsWith('host-'),
                remote: false,
                ownerHoldsAction: true,
              }
            : undefined,
        conversationExists: () => true,
        ownProjectSlug: () => undefined,
      },
      store,
      delivery,
      dispatchActor: (c) =>
        resolveDispatchActor(
          { resolvePrincipal: () => OPERATOR, resolveAgentDispatchActor },
          c as never,
        ),
      person,
      now: () => clock.now,
    }),
  );
  app.route(
    '/scheduler',
    createSchedulerRoutes(
      { addJob } as unknown as SchedulerService,
      quietLogger(),
      {
        jobProposals: createJobProposalApproval({
          store,
          person,
          now: () => clock.now,
        }),
      },
    ),
  );
});

afterAll(async () => {
  delivery.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.STATION_API_BASE;
  __resetStationServerSelfAttestationForTests();
});

beforeEach(() => {
  __resetStationControlMcpTokensForTests();
  refusals.length = 0;
  submitted.length = 0;
  addJob.mockClear();
});

type Channel = 'bound' | 'delegated-custody' | 'bearer-exposed';

/** The credential a tool of this channel forwards on its REST calls. */
function forwardedCaller(channel: Channel, sessionId: string): string {
  switch (channel) {
    case 'bound':
      return mintStationControlMcpToken(sessionId, 'sdk-in-process').token;
    case 'delegated-custody':
      return mintStationControlMcpHeaderAuth(port, sessionId).token;
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
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
      [INTERNAL_PROXY_CALLER_HEADER]: 'local',
      [STATION_CONTROL_CALLER_TOKEN_HEADER]: forwardedCaller(
        channel,
        sessionId,
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

const WAKE_UPS = '/api/orchestration/station-control/wake-ups';
const PROPOSALS = '/api/orchestration/station-control/job-proposals';
const FIVE_MINUTES = 5 * 60_000;

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

  test('a caller that is not bound does not schedule into its own unconfined session', async () => {
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
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      code: 'station_control_out_of_scope',
      reason: 'host',
    });
    // A bound caller keeps its own session.
    expect(
      (
        await agent('bound', nextSession('host-'), 'POST', WAKE_UPS, {
          delayMs: FIVE_MINUTES,
          note: 'x',
        })
      ).status,
    ).toBe(200);
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
          message: 'Scheduled check-back: check CI',
          // A copyable credential never launders its owner: the same
          // attribution its own dispatch would carry.
          actor: expect.objectContaining({
            ownerAttribution: 'unattributed-agent',
          }),
          clientOrigin: expect.objectContaining({
            actor: { kind: 'internal' },
          }),
        },
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

  test('an agent cannot reach the person’s leaves at all', async () => {
    const sessionId = nextSession();
    const response = await agent(
      'bound',
      sessionId,
      'GET',
      `/api/orchestration/agent-schedule/conv-${sessionId}`,
    );
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('station_control_route_unmapped');
  });
});

const PROPOSED = {
  name: 'nightly-digest',
  schedule: { kind: 'cron', expr: '0 9 * * *', timezone: 'Europe/Berlin' },
  prompt: 'Summarize yesterday.',
  agent: 'writer',
};

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
      expect.objectContaining({ id, job: PROPOSED, state: 'open' }),
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
    const { id } = await propose();
    const response = await personRequest('POST', '/scheduler/jobs', {
      ...PROPOSED,
      proposalId: id,
    });
    expect(response.status).toBe(200);
    expect(addJob).toHaveBeenCalledTimes(1);
    // The proposal id is the route's, never the scheduler's.
    expect(addJob.mock.calls[0]?.[0]).toEqual(PROPOSED);
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
      ...PROPOSED,
      proposalId: id,
    });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('job_proposal_settled');
    expect(addJob).toHaveBeenCalledTimes(1);
  });

  test('an Approve whose body is not the proposed job creates nothing', async () => {
    const { id } = await propose();
    for (const body of [
      { ...PROPOSED, prompt: 'Something else.' },
      { ...PROPOSED, trustAllTools: true },
      { ...PROPOSED, schedule: { kind: 'every', everyMs: 60_000 } },
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
