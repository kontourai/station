/**
 * #3160: Station Control's Session tools at the REAL boundary — `send`,
 * `interrupt` and `wait` under `configureRuntimeRoutes` with the real
 * credential pipeline, guard, caller and target derivation
 * (`createStationControlDispatchScope`), real token mints, and a real request
 * key table. Only the services behind the routes are stubs: the dispatch
 * executor and the orchestration commands record that they were reached.
 *
 * Sessions are named for their records (as in the dispatch scope matrix):
 * owner `op-*` operator, `person-*` another person; Project `*-a`, `*-b`,
 * `*-global`; `new-*` has no start record; `support.hostThreads` run
 * unconfined.
 */

import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { __resetStationServerSelfAttestationForTests } from '../../../security/station-server-scope.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../../services/identity/principal-resolver.js';
import { NotificationService } from '../../../services/notifications/notification-service.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import {
  createSqliteSessionControlRequestKeys,
  SESSION_CONTROL_REQUEST_KEY_SCHEMA,
} from '../../../services/orchestration/session-control-request-keys.js';
import { SESSION_LOCAL_PROJECT_ID_METADATA_KEY } from '../../../services/orchestration/session-project-identity.js';
import { STATION_CONTROL_CALLER_TOKEN_HEADER } from '../../../tools/station-control-shared.js';
import {
  getInternalApiToken,
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_PROXY_CALLER_HEADER,
} from '../../../utils/internal-api-token.js';
import {
  __resetStationControlMcpTokensForTests,
  mintStationControlMcpHeaderAuth,
  mintStationControlMcpToken,
} from '../../mcp/station-control-mcp-token.js';
import { configureRuntimeRoutes } from '../runtime-routes.js';

const support = vi.hoisted(() => ({
  notificationService: undefined as unknown,
  /** Every `continueExecutionTargetMessage` input the real routes reached. */
  continued: [] as Record<string, unknown>[],
  /** Every orchestration command the routes dispatched. */
  commands: [] as Record<string, unknown>[],
  hostThreads: new Set<string>(),
  /** Sessions with a turn in flight (the coordinator's view). */
  busy: new Set<string>(),
  /** Each session's lifecycle fold events, oldest first. */
  fold: new Map<string, { sequence: number; payload: unknown }[]>(),
  /** What a steer answers (`SteerTurnResult.outcome`). */
  /** A session's conversation, and a conversation's current session. */
  conversations: new Map<string, string>(),
  current: new Map<string, string>(),
  steerOutcome: 'steered' as string,
  /** What an interrupt answers. */
  interruptOutcome: 'cooperative' as string,
  bus: undefined as unknown as { emit(event: string, data: unknown): void },
}));

vi.mock('../runtime-route-support.js', () => {
  const stub = new Proxy({}, { get: () => () => undefined });
  return {
    configureRuntimeSupportServices: () => ({
      schedulerService: stub,
      notificationService: support.notificationService,
      attentionProjection: stub,
      webPushService: stub,
      webPushEnabled: false,
    }),
    createRuntimeSystemRouteDeps: () => stub,
  };
});

vi.mock('../../../tools/station-control-delegation.js', async (original) => {
  const actual =
    await original<
      typeof import('../../../tools/station-control-delegation.js')
    >();
  return {
    ...actual,
    continueExecutionTargetMessage: async (input: Record<string, unknown>) => {
      support.continued.push(input);
      return {
        conversationId: String(input.conversationId),
        sessionId: `${String(input.conversationId)}`,
        providerTurnId: `turn-${support.continued.length}`,
        target: { kind: 'agent', id: 'writer' },
      };
    },
  };
});

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

function ownerOf(threadId: string): string | undefined {
  if (threadId.startsWith('op-')) return LOCAL_OPERATOR_PRINCIPAL_ID;
  if (threadId.startsWith('person-')) return 'human:local:someone-else';
  return undefined;
}
function projectOf(threadId: string): string | undefined {
  if (threadId.endsWith('-global')) return undefined;
  if (threadId.endsWith('-b')) return 'project-b';
  return 'project-a';
}

const OPERATOR_CREDENTIAL = 'test-only-operator-credential-session-control';
const makeTempDir = trackTempDirs();
const ASSURANCE = 'station_control_assurance_insufficient';
const CALLER_REQUIRED = 'station_control_caller_required';
const BASE_PATH = '/api/orchestration/session-control';

const event = (method: string, turnId: string, threadId: string) => ({
  method,
  turnId,
  threadId,
});
function appendFold(threadId: string, method: string, turnId: string) {
  const log = support.fold.get(threadId) ?? [];
  log.push({
    sequence: (log.at(-1)?.sequence ?? 0) + 1,
    payload: event(method, turnId, threadId),
  });
  support.fold.set(threadId, log);
  // The service publishes on the bus after the append.
  support.bus.emit('orchestration:event', {
    event: event(method, turnId, threadId),
  });
}

describe('configureRuntimeRoutes: Station Control Session tools (#3160)', () => {
  const closers: Array<() => Promise<void>> = [];
  const open: AbortController[] = [];

  afterEach(async () => {
    __resetStationControlMcpTokensForTests();
    for (const controller of open.splice(0)) controller.abort();
    support.continued.length = 0;
    support.commands.length = 0;
    support.hostThreads.clear();
    support.busy.clear();
    support.fold.clear();
    support.conversations.clear();
    support.current.clear();
    support.steerOutcome = 'steered';
    support.interruptOutcome = 'cooperative';
    for (const close of closers.splice(0)) await close();
  });

  async function setup() {
    const homeDir = makeTempDir('station-control-session-control-');
    const service = new NotificationService(new EventBus(), homeDir, 999_999);
    closers.push(() => service.shutdown());
    support.notificationService = service;
    __resetStationServerSelfAttestationForTests();
    const bus = new EventBus();
    support.bus = bus;
    // The REAL key table, over an in-memory database.
    const db = new DatabaseSync(':memory:');
    db.exec(SESSION_CONTROL_REQUEST_KEY_SCHEMA);
    const keys = createSqliteSessionControlRequestKeys(db);
    const app = new Hono();
    const context = deepStub({
      projectSharedTasks: undefined,
      deploymentAuthentication: undefined,
      localAccounts: undefined,
      applicationSessions: undefined,
      app,
      port: 4321,
      appConfig: {},
      eventBus: bus,
      configLoader: {
        getProjectHomeDir: () => homeDir,
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
      memoryAdapters: new Map(),
      metricsLog: [],
      monitoringEvents: [],
      orchestrationEventStore: deepStub({
        sessionTurnBoundaryAuthority: () => ({
          reconcile: () => ({ kind: 'available', interrupted: [] }),
        }),
        conversationForSession: (threadId: string) => {
          const conversationId = support.conversations.get(threadId);
          return conversationId ? { conversationId } : undefined;
        },
        conversationSessions: () => [],
        readSessionByThread: () => undefined,
        sessionControlRequestKeys: () => keys,
        listEventsByMethods: (threadId: string) =>
          support.fold.get(threadId) ?? [],
        readSessionInventoryHighWater: (threadId: string) =>
          support.fold.get(threadId)?.at(-1)?.sequence ?? 0,
      }),
      orchestrationService: deepStub({
        resolveSessionActingPrincipal: (threadId: string) => {
          const id = ownerOf(threadId);
          return id ? { id, source: 'session-owner' as const } : undefined;
        },
        sessionRecordedOwnerId: (threadId: string) => ownerOf(threadId),
        hasSessionStartRecord: (threadId: string) =>
          !threadId.startsWith('new-'),
        currentConversationSessionId: (conversationId: string) =>
          support.current.get(conversationId) ?? conversationId,
        // The owner reads only its own sessions.
        canUserReadSession: (threadId: string, authority: { userId: string }) =>
          ownerOf(threadId) !== undefined &&
          ownerOf(threadId) === authority.userId,
        hasActiveTurn: (threadId: string) => support.busy.has(threadId),
        dispatchWithReceipt: async (command: Record<string, unknown>) => {
          support.commands.push(command);
          if (command.type === 'steerTurn')
            return {
              result:
                support.steerOutcome === 'steered'
                  ? {
                      outcome: 'steered',
                      threadId: command.threadId,
                      turnId: 'live-turn',
                    }
                  : {
                      outcome: support.steerOutcome,
                      threadId: command.threadId,
                      clientInputId: command.clientInputId,
                    },
            };
          return {
            result: {
              outcome: support.interruptOutcome,
              threadId: command.threadId,
              turnId: 'live-turn',
            },
          };
        },
        firstStartedMetadataOfThread: (threadId: string) => {
          if (threadId.startsWith('new-')) return undefined;
          const identity = { adoptedFromThreadId: 'attached' };
          const project = projectOf(threadId);
          return project
            ? { ...identity, [SESSION_LOCAL_PROJECT_ID_METADATA_KEY]: project }
            : identity;
        },
        firstStartedEngineOfThread: () => 'claude',
        sessionRunsHost: (threadId: string) =>
          support.hostThreads.has(threadId),
      }),
      storageAdapter: deepStub({
        getProject: () => {
          throw new Error('no project');
        },
      }),
      projectMembership: deepStub({ admissionsForResolvedPrincipal: () => [] }),
      taskGraphService: { listTasks: () => [] },
      projectService: {
        listProjects: () => [],
        getProject: (slug: string) => ({ slug }),
      },
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
      () =>
        new Promise<void>((resolve) => {
          (
            server as unknown as { closeAllConnections?: () => void }
          ).closeAllConnections?.();
          server.close(() => resolve());
        }),
    );
    return { base: `http://127.0.0.1:${await listening}`, db };
  }

  const internal = (extra: Record<string, string> = {}) => ({
    'content-type': 'application/json',
    [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
    [INTERNAL_PROXY_CALLER_HEADER]: 'local',
    ...extra,
  });
  const operatorUi = {
    'content-type': 'application/json',
    authorization: `Bearer ${OPERATOR_CREDENTIAL}`,
  };
  type Channel = 'bound' | 'delegated-custody' | 'bearer-exposed';
  const as = (channel: Channel, sessionId: string) => () =>
    internal({
      [STATION_CONTROL_CALLER_TOKEN_HEADER]:
        channel === 'bound'
          ? mintStationControlMcpToken(sessionId, 'sdk-in-process').token
          : channel === 'bearer-exposed'
            ? mintStationControlMcpToken(sessionId, 'url-token').token
            : mintStationControlMcpHeaderAuth(4321, sessionId).token,
    });

  let keyCounter = 0;
  const nextKey = () => {
    keyCounter += 1;
    return `request-key-${String(keyCounter).padStart(6, '0')}`;
  };

  interface Answer {
    status: number;
    body: Record<string, any>;
  }
  async function post(
    base: string,
    leaf: 'send' | 'interrupt',
    headers: Record<string, string>,
    body: Record<string, unknown>,
  ): Promise<Answer> {
    const response = await fetch(`${base}${BASE_PATH}/${leaf}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      body: (await response.json()) as Record<string, any>,
    };
  }
  async function wait(
    base: string,
    sessionId: string,
    headers: Record<string, string>,
    query: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<Answer> {
    const response = await fetch(
      `${base}${BASE_PATH}/${encodeURIComponent(sessionId)}/wait?${new URLSearchParams(query)}`,
      { headers, ...(signal ? { signal } : {}) },
    );
    return {
      status: response.status,
      body: (await response.json()) as Record<string, any>,
    };
  }

  /** The verdict of one request: a typed refusal, 404, or `reached`. */
  const verdict = (answer: Answer, reached: boolean): string =>
    answer.status === 403 && answer.body.code?.startsWith('station_control_')
      ? answer.body.code
      : reached
        ? 'reached'
        : `not reached (${answer.status} ${answer.body.code ?? ''})`;

  const sendReq = (sessionId: string) => ({
    sessionId,
    text: 'please look at this',
    mode: 'auto',
    requestKey: nextKey(),
  });
  const interruptReq = (sessionId: string) => ({
    sessionId,
    requestKey: nextKey(),
  });

  /** Aims, as [label, caller session, target, expected for a non-bound caller, expected for a bound operator]. */
  const NOT_FOUND = 'not reached (404 session_not_found)';
  const MATRIX: ReadonlyArray<[string, string, string, string, string]> = [
    ['same Project', 'op-caller-a', 'op-thread-a', 'reached', 'reached'],
    ['other Project', 'op-caller-a', 'op-thread-b', ASSURANCE, 'reached'],
    ['global', 'op-caller-a', 'op-thread-global', ASSURANCE, 'reached'],
    ['host thread', 'op-caller-a', 'op-host-a', ASSURANCE, 'reached'],
    ['another owner', 'op-caller-a', 'person-thread-a', ASSURANCE, NOT_FOUND],
    // `new-*` has no start record here. This is NOT another Station: these
    // leaves carry no environment, so a remote target is unreachable through
    // the schema (an `environment` field is refused as an unknown key).
    ['unknown session', 'op-caller-a', 'new-thread-a', ASSURANCE, NOT_FOUND],
    [
      'global caller → global',
      'op-caller-global',
      'op-thread-global',
      'reached',
      'reached',
    ],
    [
      'global caller → Project',
      'op-caller-global',
      'op-thread-a',
      ASSURANCE,
      'reached',
    ],
  ];

  test.each(['send', 'interrupt'] as const)(
    '%s: caller class × target scope matrix; a refused request has no effect',
    async (leaf) => {
      const { base } = await setup();
      support.hostThreads.add('op-host-a');
      const reachedCount = () =>
        leaf === 'send' ? support.continued.length : support.commands.length;
      const rows: string[][] = [];
      for (const [label, caller, target, nonBound, bound] of MATRIX) {
        for (const channel of [
          'delegated-custody',
          'bearer-exposed',
        ] as const) {
          const before = reachedCount();
          const answer = await post(
            base,
            leaf,
            as(channel, caller)(),
            leaf === 'send' ? sendReq(target) : interruptReq(target),
          );
          rows.push([
            label,
            channel,
            verdict(answer, reachedCount() > before),
            nonBound,
          ]);
        }
        const before = reachedCount();
        const answer = await post(
          base,
          leaf,
          as('bound', caller)(),
          leaf === 'send' ? sendReq(target) : interruptReq(target),
        );
        rows.push([
          label,
          'bound (operator)',
          verdict(answer, reachedCount() > before),
          bound,
        ]);
      }
      for (const [label, channel, actual, expected] of rows)
        expect([label, channel, actual]).toEqual([label, channel, expected]);
    },
  );

  test('wait: owner-scoped, so any of the owner’s sessions, never another owner’s', async () => {
    const { base } = await setup();
    const rows: string[][] = [];
    for (const channel of [
      'bound',
      'delegated-custody',
      'bearer-exposed',
    ] as const)
      for (const [target, expected] of [
        ['op-thread-a', 'reached'],
        ['op-thread-b', 'reached'],
        ['op-thread-global', 'reached'],
        ['op-host-a', 'reached'],
        ['person-thread-a', NOT_FOUND],
        ['new-thread-a', NOT_FOUND],
      ] as const) {
        const answer = await wait(base, target, as(channel, 'op-caller-a')(), {
          until: 'idle',
        });
        rows.push([
          channel,
          target,
          verdict(answer, answer.status === 200),
          expected,
        ]);
      }
    for (const [channel, target, actual, expected] of rows)
      expect([channel, target, actual]).toEqual([channel, target, expected]);
  });

  test('a raw token, a pooled child and the operator UI are no caller: all three leaves refuse', async () => {
    const { base } = await setup();
    const pooled = () =>
      internal({ 'x-station-control-caller-binding': 'a'.repeat(43) });
    for (const [label, headers] of [
      ['raw token', internal],
      ['pooled child', pooled],
    ] as const) {
      for (const leaf of ['send', 'interrupt'] as const) {
        const answer = await post(
          base,
          leaf,
          headers(),
          leaf === 'send'
            ? sendReq('op-thread-a')
            : interruptReq('op-thread-a'),
        );
        expect([label, leaf, answer.status, answer.body.code]).toEqual([
          label,
          leaf,
          403,
          CALLER_REQUIRED,
        ]);
      }
      const waited = await wait(base, 'op-thread-a', headers(), {
        until: 'idle',
      });
      expect([label, waited.status, waited.body.code]).toEqual([
        label,
        403,
        CALLER_REQUIRED,
      ]);
    }
    for (const leaf of ['send', 'interrupt'] as const) {
      const answer = await post(
        base,
        leaf,
        operatorUi,
        leaf === 'send' ? sendReq('op-thread-a') : interruptReq('op-thread-a'),
      );
      expect([leaf, answer.status, answer.body.code]).toEqual([
        leaf,
        403,
        CALLER_REQUIRED,
      ]);
    }
    expect([support.continued.length, support.commands.length]).toEqual([0, 0]);
  });

  test('the request schema is strict: an approval mode, model or environment is refused, nothing runs', async () => {
    const { base } = await setup();
    const caller = as('bearer-exposed', 'op-caller-a');
    for (const extra of [
      { approvalMode: 'auto' },
      { setApprovalMode: 'auto', setApprovalModeBasedOn: null },
      { model: { override: 'x' } },
      { environment: { kind: 'saved', id: 'peer' } },
    ]) {
      const answer = await post(base, 'send', caller(), {
        ...sendReq('op-thread-a'),
        ...extra,
      });
      expect([Object.keys(extra)[0], answer.status]).toEqual([
        Object.keys(extra)[0],
        400,
      ]);
    }
    expect(
      (
        await post(base, 'interrupt', caller(), {
          ...interruptReq('op-thread-a'),
          approvalMode: 'auto',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await wait(base, 'op-thread-a', caller(), {
          until: 'idle',
          approvalMode: 'auto',
        })
      ).status,
    ).toBe(400);
    expect([support.continued.length, support.commands.length]).toEqual([0, 0]);
  });

  test('a start carries no approval mode, model or environment, and uses the key-derived clientTurnId', async () => {
    const { base } = await setup();
    const answer = await post(
      base,
      'send',
      as('bearer-exposed', 'op-caller-a')(),
      sendReq('op-thread-a'),
    );
    expect(answer.status).toBe(200);
    expect(answer.body.data).toMatchObject({
      outcome: 'started',
      sessionId: 'op-thread-a',
      eventCursor: 0,
    });
    const [input] = support.continued;
    expect(Object.keys(input!).sort()).toEqual(
      [
        'clientOrigin',
        'clientTurnId',
        'conversationId',
        'fullAccessGrant',
        'message',
        'ownerAttribution',
        'principal',
        'readAuthority',
        'userId',
      ].sort(),
    );
    expect(input).toMatchObject({
      conversationId: 'op-thread-a',
      message: 'please look at this',
      userId: LOCAL_OPERATOR_PRINCIPAL_ID,
      fullAccessGrant: null,
    });
    expect(String(input!.clientTurnId)).toMatch(/^sc-[0-9a-f]{40}$/);
  });

  describe('request keys', () => {
    test('the same send twice delivers once and replays the first answer', async () => {
      const { base } = await setup();
      const caller = as('bearer-exposed', 'op-caller-a');
      const body = sendReq('op-thread-a');
      const first = await post(base, 'send', caller(), body);
      const second = await post(base, 'send', caller(), body);
      expect(support.continued).toHaveLength(1);
      expect(first.body.data.replayed).toBeUndefined();
      expect(second.body.data).toEqual({ ...first.body.data, replayed: true });
    });

    test('a steer replays too: one steer command, same clientInputId', async () => {
      const { base } = await setup();
      support.busy.add('op-thread-a');
      appendFold('op-thread-a', 'turn.started', 'live-turn');
      const caller = as('bearer-exposed', 'op-caller-a');
      const body = sendReq('op-thread-a');
      const first = await post(base, 'send', caller(), body);
      const second = await post(base, 'send', caller(), body);
      expect(first.body.data).toMatchObject({
        outcome: 'steered',
        turnId: 'live-turn',
        eventCursor: 1,
      });
      expect(second.body.data.replayed).toBe(true);
      expect(support.commands).toHaveLength(1);
      expect(support.commands[0]).toMatchObject({
        type: 'steerTurn',
        input: 'please look at this',
      });
      expect(support.commands[0]!.clientInputId).toMatch(/^sc-[0-9a-f]{40}$/);
    });

    test('the same key with a different message is request_key_conflict and delivers nothing more', async () => {
      const { base } = await setup();
      const caller = as('bearer-exposed', 'op-caller-a');
      const body = sendReq('op-thread-a');
      await post(base, 'send', caller(), body);
      const conflict = await post(base, 'send', caller(), {
        ...body,
        text: 'something else',
      });
      expect([conflict.status, conflict.body.code]).toEqual([
        409,
        'request_key_conflict',
      ]);
      const otherTarget = await post(base, 'send', caller(), {
        ...body,
        sessionId: 'op-thread-a2',
      });
      expect(otherTarget.body.code).toBe('request_key_conflict');
      expect(support.continued).toHaveLength(1);
    });

    test('keys are per calling session: another caller using the same key delivers on its own', async () => {
      const { base } = await setup();
      const body = sendReq('op-thread-a');
      await post(base, 'send', as('bearer-exposed', 'op-caller-a')(), body);
      const other = await post(
        base,
        'send',
        as('bearer-exposed', 'op-other-a')(),
        body,
      );
      expect(other.body.data.replayed).toBeUndefined();
      expect(support.continued).toHaveLength(2);
    });

    test('an indeterminate steer re-drives under its pinned branch and clientInputId, never as a start', async () => {
      const { base } = await setup();
      support.busy.add('op-thread-a');
      appendFold('op-thread-a', 'turn.started', 'live-turn');
      support.steerOutcome = 'indeterminate';
      const caller = as('bearer-exposed', 'op-caller-a');
      const body = sendReq('op-thread-a');
      const first = await post(base, 'send', caller(), body);
      expect([first.status, first.body.code]).toEqual([
        409,
        'delivery_indeterminate',
      ]);
      // The turn ends and the engine now reports the steer delivered.
      support.busy.clear();
      appendFold('op-thread-a', 'turn.completed', 'live-turn');
      support.steerOutcome = 'steered';
      const again = await post(base, 'send', caller(), body);
      expect(again.body.data).toMatchObject({ outcome: 'steered' });
      expect(support.continued).toHaveLength(0);
      expect(support.commands).toHaveLength(2);
      expect(support.commands[1]!.clientInputId).toBe(
        support.commands[0]!.clientInputId,
      );
      // Now it is final.
      expect(
        (await post(base, 'send', caller(), body)).body.data.replayed,
      ).toBe(true);
      expect(support.commands).toHaveLength(2);
    });

    test('a refusal delivered nothing, so the same key runs again once the Session is ready', async () => {
      const { base } = await setup();
      const caller = as('bearer-exposed', 'op-caller-a');
      support.busy.add('op-thread-a');
      appendFold('op-thread-a', 'turn.started', 'live-turn');
      const busy = {
        ...sendReq('op-thread-a'),
        mode: 'start',
      };
      const refused = await post(base, 'send', caller(), busy);
      expect([refused.status, refused.body.code]).toEqual([
        409,
        'session_busy',
      ]);
      expect(refused.body.error).toContain('same requestKey may be reused');
      // The turn ends; the identical request now starts a turn, not a replay.
      support.busy.clear();
      appendFold('op-thread-a', 'turn.completed', 'live-turn');
      const started = await post(base, 'send', caller(), busy);
      expect(started.status).toBe(200);
      expect(started.body.data).toMatchObject({ outcome: 'started' });
      expect(started.body.data.replayed).toBeUndefined();
      expect(support.continued).toHaveLength(1);
      // The same holds for steer on an idle Session, and an unsupported steer.
      const idleSteer = { ...sendReq('op-thread-a'), mode: 'steer' };
      expect((await post(base, 'send', caller(), idleSteer)).body.code).toBe(
        'no_active_turn',
      );
      support.busy.add('op-thread-a');
      appendFold('op-thread-a', 'turn.started', 'turn-2');
      const again = await post(base, 'send', caller(), idleSteer);
      expect(again.body.data).toMatchObject({ outcome: 'steered' });
      expect(again.body.data.replayed).toBeUndefined();
    });

    test('a re-driven steer that is refused keeps its pinned branch: the next call never starts a turn', async () => {
      const { base } = await setup();
      const caller = as('bearer-exposed', 'op-caller-a');
      support.busy.add('op-thread-a');
      appendFold('op-thread-a', 'turn.started', 'live-turn');
      support.steerOutcome = 'indeterminate';
      const body = sendReq('op-thread-a');
      expect((await post(base, 'send', caller(), body)).body.code).toBe(
        'delivery_indeterminate',
      );
      // The turn ends. The re-drive is pinned to steer and the engine now
      // answers that there is no turn: a refusal, with nothing delivered.
      support.busy.clear();
      appendFold('op-thread-a', 'turn.completed', 'live-turn');
      support.steerOutcome = 'no-active-turn';
      const refused = await post(base, 'send', caller(), body);
      expect([refused.status, refused.body.code]).toEqual([
        409,
        'no_active_turn',
      ]);
      // The text must not send the agent to another mode or a plain retry:
      // both would meet request_key_conflict or the same pin.
      expect(refused.body.pinned).toBe(true);
      expect(refused.body.error).toContain('pinned to its first attempt');
      expect(refused.body.error).not.toContain('mode "auto"');
      expect(refused.body.error).not.toContain('may be reused');
      // A fresh refusal (not a re-drive) still says what to do.
      const fresh = await post(base, 'send', caller(), {
        ...sendReq('op-thread-a'),
        mode: 'steer',
      });
      expect(fresh.body.pinned).toBeUndefined();
      expect(fresh.body.error).toContain('same requestKey may be reused');
      // The same call again: still pinned to steer, so it must NOT start a
      // turn (the start's clientTurnId is not linked to the steer's input id).
      support.steerOutcome = 'steered';
      const third = await post(base, 'send', caller(), body);
      expect(third.body.data).toMatchObject({ outcome: 'steered' });
      expect(support.continued).toHaveLength(0);
      const ids = support.commands.map((command) => command.clientInputId);
      expect(new Set(ids).size).toBe(1);
      expect(support.commands).toHaveLength(3);
    });

    test('an interrupt with nothing running frees its key too', async () => {
      const { base } = await setup();
      const caller = as('bearer-exposed', 'op-caller-a');
      const body = interruptReq('op-thread-a');
      support.interruptOutcome = 'no-active-turn';
      const first = await post(base, 'interrupt', caller(), body);
      expect(first.body.data.outcome).toBe('no-active-turn');
      support.interruptOutcome = 'cooperative';
      const second = await post(base, 'interrupt', caller(), body);
      expect(second.body.data).toMatchObject({ outcome: 'cooperative' });
      expect(second.body.data.replayed).toBeUndefined();
      expect(support.commands).toHaveLength(2);
    });

    test('a re-driven attempt on a pinned Session that is no longer in scope is refused, nothing is steered', async () => {
      const { base } = await setup();
      const caller = as('bearer-exposed', 'op-caller-a');
      support.busy.add('op-thread-a');
      appendFold('op-thread-a', 'turn.started', 'live-turn');
      support.steerOutcome = 'indeterminate';
      const body = sendReq('op-thread-a');
      expect((await post(base, 'send', caller(), body)).body.code).toBe(
        'delivery_indeterminate',
      );
      expect(support.commands).toHaveLength(1);
      // The conversation moves on to a successor that is in scope; the pinned
      // Session now runs unconfined.
      support.current.set('op-thread-a', 'op-thread-a2');
      support.hostThreads.add('op-thread-a');
      const refused = await post(base, 'send', caller(), body);
      expect([refused.status, refused.body.code]).toEqual([403, ASSURANCE]);
      expect(support.commands).toHaveLength(1);
      expect(support.continued).toHaveLength(0);
    });

    test('interrupt replays: one interruptTurn command', async () => {
      const { base } = await setup();
      const caller = as('bearer-exposed', 'op-caller-a');
      const body = interruptReq('op-thread-a');
      const first = await post(base, 'interrupt', caller(), body);
      const second = await post(base, 'interrupt', caller(), body);
      expect(first.body.data).toEqual({
        outcome: 'cooperative',
        sessionId: 'op-thread-a',
        turnId: 'live-turn',
      });
      expect(second.body.data).toEqual({ ...first.body.data, replayed: true });
      expect(support.commands).toEqual([
        { type: 'interruptTurn', threadId: 'op-thread-a' },
      ]);
      const conflict = await post(base, 'interrupt', caller(), {
        ...body,
        turnId: 'other',
      });
      expect(conflict.body.code).toBe('request_key_conflict');
    });
  });

  describe('steer vs start vs session_busy (the engine capability matrix)', () => {
    const sendMode = async (base: string, mode: string) =>
      post(base, 'send', as('bearer-exposed', 'op-caller-a')(), {
        ...sendReq('op-thread-a'),
        mode,
      });

    test('idle: auto and start start a turn; steer has no turn to steer', async () => {
      const { base } = await setup();
      expect((await sendMode(base, 'auto')).body.data.outcome).toBe('started');
      expect((await sendMode(base, 'start')).body.data.outcome).toBe('started');
      const steer = await sendMode(base, 'steer');
      expect([steer.status, steer.body.code]).toEqual([409, 'no_active_turn']);
      expect(support.continued).toHaveLength(2);
      expect(support.commands).toEqual([]);
    });

    test('busy, engine can steer: auto and steer steer; start is session_busy and sends nothing', async () => {
      const { base } = await setup();
      support.busy.add('op-thread-a');
      appendFold('op-thread-a', 'turn.started', 'live-turn');
      expect((await sendMode(base, 'auto')).body.data).toMatchObject({
        outcome: 'steered',
        turnId: 'live-turn',
      });
      expect((await sendMode(base, 'steer')).body.data.outcome).toBe('steered');
      const start = await sendMode(base, 'start');
      expect([start.status, start.body.code, start.body.reason]).toEqual([
        409,
        'session_busy',
        'turn-active',
      ]);
      expect(support.commands).toHaveLength(2);
      expect(support.continued).toHaveLength(0);
    });

    test('busy, engine cannot steer: session_busy (steer-unsupported)', async () => {
      const { base } = await setup();
      support.busy.add('op-thread-a');
      appendFold('op-thread-a', 'turn.started', 'live-turn');
      support.steerOutcome = 'unsupported-engine';
      for (const mode of ['auto', 'steer']) {
        const answer = await sendMode(base, mode);
        expect([answer.status, answer.body.code, answer.body.reason]).toEqual([
          409,
          'session_busy',
          'steer-unsupported',
        ]);
      }
      expect(support.continued).toHaveLength(0);
    });

    test('a concurrent steer is session_busy (steer-in-flight)', async () => {
      const { base } = await setup();
      support.busy.add('op-thread-a');
      appendFold('op-thread-a', 'turn.started', 'live-turn');
      support.steerOutcome = 'concurrent-steer';
      const answer = await sendMode(base, 'auto');
      expect([answer.body.code, answer.body.reason]).toEqual([
        'session_busy',
        'steer-in-flight',
      ]);
    });
  });

  describe('wait', () => {
    test('a timeout leaves the Session running: no command, no interrupt, same state afterwards', async () => {
      const { base } = await setup();
      support.busy.add('op-thread-a');
      appendFold('op-thread-a', 'turn.started', 'live-turn');
      const answer = await wait(
        base,
        'op-thread-a',
        as('bearer-exposed', 'op-caller-a')(),
        {
          until: 'turn-settled',
          timeoutMs: '60',
        },
      );
      expect(answer.status).toBe(200);
      expect(answer.body.data).toMatchObject({
        sessionId: 'op-thread-a',
        settled: false,
        timedOut: true,
        state: 'running',
        openTurnId: 'live-turn',
      });
      expect(support.commands).toEqual([]);
      expect(support.continued).toEqual([]);
      expect(support.busy.has('op-thread-a')).toBe(true);
      expect(support.fold.get('op-thread-a')).toHaveLength(1);
    });

    test('a superseded Session says so and names the current one', async () => {
      const { base } = await setup();
      const caller = as('bearer-exposed', 'op-caller-a');
      support.current.set('op-thread-a', 'op-thread-a2');
      support.conversations.set('op-thread-a', 'op-thread-a');
      const old = await wait(base, 'op-thread-a', caller(), { until: 'idle' });
      expect(old.body.data).toMatchObject({
        sessionId: 'op-thread-a',
        superseded: true,
        currentSessionId: 'op-thread-a2',
        settled: true,
      });
      const current = await wait(base, 'op-thread-a2', caller(), {
        until: 'idle',
      });
      expect(current.body.data.superseded).toBeUndefined();
      expect(current.body.data.currentSessionId).toBeUndefined();
    });

    test('it wakes when the turn settles, and reports the outcome', async () => {
      const { base } = await setup();
      support.busy.add('op-thread-a');
      appendFold('op-thread-a', 'turn.started', 'live-turn');
      const pending = wait(
        base,
        'op-thread-a',
        as('bearer-exposed', 'op-caller-a')(),
        {
          until: 'turn-settled',
          timeoutMs: '20000',
          afterEventCursor: '0',
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      support.busy.clear();
      appendFold('op-thread-a', 'turn.completed', 'live-turn');
      const answer = await pending;
      expect(answer.body.data).toMatchObject({
        settled: true,
        timedOut: false,
        state: 'idle',
        settledTurn: { turnId: 'live-turn', outcome: 'completed', sequence: 2 },
        eventCursor: 2,
      });
    });

    test('send then wait with the returned cursor sees a turn that already finished', async () => {
      const { base } = await setup();
      const sent = await post(
        base,
        'send',
        as('bearer-exposed', 'op-caller-a')(),
        sendReq('op-thread-a'),
      );
      const cursor = sent.body.data.eventCursor as number;
      appendFold('op-thread-a', 'turn.started', 'turn-1');
      appendFold('op-thread-a', 'turn.completed', 'turn-1');
      const answer = await wait(
        base,
        'op-thread-a',
        as('bearer-exposed', 'op-caller-a')(),
        {
          until: 'turn-settled',
          afterEventCursor: String(cursor),
        },
      );
      expect(answer.body.data).toMatchObject({
        settled: true,
        settledTurn: { turnId: 'turn-1' },
      });
    });

    test('4 waits per session: the fifth is refused; cancelled requests free their slots', async () => {
      const { base } = await setup();
      support.busy.add('op-thread-a');
      appendFold('op-thread-a', 'turn.started', 'live-turn');
      const caller = as('bearer-exposed', 'op-caller-a');
      const controllers = Array.from(
        { length: 4 },
        () => new AbortController(),
      );
      open.push(...controllers);
      // One mint for all four: a new mint for a session replaces the last.
      const heldHeaders = caller();
      const held = controllers.map((controller) =>
        wait(
          base,
          'op-thread-a',
          heldHeaders,
          { until: 'idle', timeoutMs: '40000' },
          controller.signal,
        ).catch((error) => error),
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
      const fifth = await wait(base, 'op-thread-a', caller(), {
        until: 'idle',
        timeoutMs: '40',
      });
      expect([fifth.status, fifth.body.code]).toEqual([429, 'wait_capacity']);
      // A different calling session is unaffected.
      const other = await wait(
        base,
        'op-thread-a',
        as('bearer-exposed', 'op-caller-b')(),
        { until: 'idle', timeoutMs: '40' },
      );
      expect(other.status).toBe(200);
      for (const controller of controllers) controller.abort();
      await Promise.all(held);
      await new Promise((resolve) => setTimeout(resolve, 150));
      const again = await wait(base, 'op-thread-a', caller(), {
        until: 'idle',
        timeoutMs: '40',
      });
      expect(again.status).toBe(200);
    });

    test('afterEventCursor is refused with until=idle, and a timeout above 50 s is refused', async () => {
      const { base } = await setup();
      const caller = as('bearer-exposed', 'op-caller-a');
      expect(
        (
          await wait(base, 'op-thread-a', caller(), {
            until: 'idle',
            afterEventCursor: '1',
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await wait(base, 'op-thread-a', caller(), {
            until: 'idle',
            timeoutMs: '50001',
          })
        ).status,
      ).toBe(400);
    });
  });
});
