/**
 * #2377 slice C2a: dispatch scope at the dispatch ROUTES, in the PRODUCTION
 * composition — `configureRuntimeRoutes` with the real credential pipeline,
 * the real guard, the real caller and target derivation
 * (`createStationControlDispatchScope` over the production record
 * resolver), and real token mints. Only the services behind the routes are
 * stubs: the dispatch executors record that they were reached.
 *
 * Sessions are named for their records:
 * - owner: `op-*` the operator, `person-*` another person, `acct-*` an
 *   account member (`ACCOUNT`), anything else none;
 * - Project: `*-a` project-a, `*-b` project-b, `*-acct` project-acct,
 *   `*-global` no Project (the global space), `*-slug` a pre-stamp slug
 *   only (unreadable); anything else project-a;
 * - `new-*` has no session yet; `support.hostThreads` run unconfined.
 */
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { __resetStationServerSelfAttestationForTests } from '../../../security/station-server-scope.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../../services/identity/principal-resolver.js';
import { NotificationService } from '../../../services/notifications/notification-service.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
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

const ACCOUNT = 'human:deployment:issuer:member';

const support = vi.hoisted(() => ({
  notificationService: undefined as unknown,
  /** Every dispatch executor the real routes reached. */
  dispatched: [] as string[],
  hostThreads: new Set<string>(),
  slugOnly: new Map<string, string>(),
  /** The account member's actions in project-acct. */
  accountActions: ['view', 'discuss', 'edit', 'execute'] as string[],
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

// The dispatch executors the routes hand off to: reaching one is the proof
// the route's scope check let the request through.
vi.mock('../../../tools/station-control-delegation.js', async (original) => {
  const actual =
    await original<
      typeof import('../../../tools/station-control-delegation.js')
    >();
  const record =
    (name: string, answer: (input: Record<string, unknown>) => unknown) =>
    async (input: Record<string, unknown>) => {
      support.dispatched.push(
        `${name} ${String(input.conversationId ?? input.taskId ?? 'new')}`,
      );
      return answer(input);
    };
  const handle = () => ({
    conversationId: 'c',
    sessionId: 's',
    providerTurnId: 't',
    target: { kind: 'agent', id: 'writer' },
  });
  return {
    ...actual,
    executeExecutionTargetMessage: record('chat', handle),
    handoffExecutionTargetMessage: record('handoff', handle),
    continueExecutionTargetMessage: record('continue', handle),
    delegateTask: record('delegate', () => ({ taskId: 'task:x' })),
    continueDelegatedTask: record('task-continue', () => ({})),
    respondToDelegatedTaskRequest: record('respond', () => ({})),
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

function ownerOf(threadId: string): string | undefined {
  if (threadId.startsWith('op-')) return LOCAL_OPERATOR_PRINCIPAL_ID;
  if (threadId.startsWith('person-')) return 'human:local:someone-else';
  if (threadId.startsWith('acct-')) return ACCOUNT;
  return undefined;
}

function projectOf(threadId: string): string | undefined {
  if (threadId.endsWith('-global')) return undefined;
  if (threadId.endsWith('-b')) return 'project-b';
  if (threadId.endsWith('-acct')) return 'project-acct';
  return 'project-a';
}

const OPERATOR_CREDENTIAL = 'test-only-operator-credential-dispatch-scope';
const makeTempDir = trackTempDirs();

describe('configureRuntimeRoutes: station-control dispatch stays in scope (slice C2a)', () => {
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    __resetStationControlMcpTokensForTests();
    support.dispatched.length = 0;
    support.hostThreads.clear();
    support.slugOnly.clear();
    support.accountActions = ['view', 'discuss', 'edit', 'execute'];
    for (const close of closers.splice(0)) await close();
  });

  async function setup() {
    const homeDir = makeTempDir('station-control-authority-');
    const service = new NotificationService(new EventBus(), homeDir, 999_999);
    closers.push(() => service.shutdown());
    support.notificationService = service;
    __resetStationServerSelfAttestationForTests();
    const app = new Hono();
    const context = deepStub({
      projectSharedTasks: undefined,
      deploymentAuthentication: undefined,
      localAccounts: undefined,
      applicationSessions: undefined,
      app,
      port: 4321,
      appConfig: {},
      configLoader: {
        getProjectHomeDir: () => homeDir,
        loadAppConfig: () => ({}),
      },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      activeAgents: new Map(),
      agentService: {
        listAgents: () => [],
      },
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
        conversationForSession: () => undefined,
      }),
      orchestrationService: deepStub({
        // The production caller derivation reads the session's owner here.
        resolveSessionActingPrincipal: (threadId: string) => {
          const id = ownerOf(threadId);
          return id ? { id, source: 'session-owner' as const } : undefined;
        },
        sessionRecordedOwnerId: (threadId: string) => ownerOf(threadId),
        hasSessionStartRecord: (threadId: string) =>
          !threadId.startsWith('new-'),
        currentConversationSessionId: (conversationId: string) =>
          conversationId,
        canUserReadSession: () => true,
        firstStartedMetadataOfThread: (threadId: string) => {
          if (threadId.startsWith('new-')) return undefined;
          // An adopted session: its delegation lineage is named by its
          // engine, with no Agent spec to read.
          const identity = { adoptedFromThreadId: 'attached' };
          const slug = support.slugOnly.get(threadId);
          if (slug) return { ...identity, projectSlug: slug };
          const project = projectOf(threadId);
          return project
            ? { ...identity, [SESSION_LOCAL_PROJECT_ID_METADATA_KEY]: project }
            : identity;
        },
        firstStartedEngineOfThread: () => 'claude',
        sessionRunsHost: (threadId: string) =>
          support.hostThreads.has(threadId),
        // An input reply's own check, after the scope: never open here.
        inspectInputReplyContext: () => ({ state: 'changed' }),
      }),
      storageAdapter: deepStub({
        getProject: (slug: string) => {
          if (slug === 'project-a-slug') return { id: 'project-a' };
          if (slug === 'project-b-slug') return { id: 'project-b' };
          if (slug === 'account-slug') return { id: 'project-acct' };
          throw new Error('no project');
        },
      }),
      // One account member: `contributor` (execute) in project-acct only.
      projectMembership: deepStub({
        admissionsForResolvedPrincipal: (principalId: string) =>
          principalId === ACCOUNT
            ? [
                {
                  scope: {
                    localProjectId: 'project-acct',
                    localProjectSlug: 'account-slug',
                  },
                  member: {
                    status: 'active',
                    actions: support.accountActions,
                  },
                },
              ]
            : [],
      }),
      taskGraphService: { listTasks: () => [] },
      // No Project names a default Environment: a Project dispatch stays on
      // this Station unless the body names one.
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
    // A real loopback listener, so the runtime boundary sees a real peer.
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
    return { service, base };
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
  /** A fresh caller credential per request: a new mint replaces the last. */
  const as = (channel: Channel, sessionId: string) => () =>
    internal({
      [STATION_CONTROL_CALLER_TOKEN_HEADER]:
        channel === 'bound'
          ? mintStationControlMcpToken(sessionId, 'sdk-in-process').token
          : channel === 'bearer-exposed'
            ? mintStationControlMcpToken(sessionId, 'url-token').token
            : mintStationControlMcpHeaderAuth(4321, sessionId).token,
    });

  async function send(
    base: string,
    path: string,
    headers: Record<string, string>,
    body: unknown,
  ): Promise<{ status: number; code?: string }> {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let code: string | undefined;
    try {
      code = (JSON.parse(text) as { code?: string }).code;
    } catch {
      code = undefined;
    }
    return { status: response.status, ...(code ? { code } : {}) };
  }

  /**
   * The outcome a request reached: the typed refusal, or `reached` when the
   * route handed it to its dispatch executor.
   */
  async function outcome(
    base: string,
    path: string,
    headers: Record<string, string>,
    body: unknown,
  ): Promise<string> {
    const before = support.dispatched.length;
    const response = await send(base, path, headers, body);
    if (
      response.status === 403 &&
      response.code?.startsWith('station_control_')
    )
      return response.code;
    return support.dispatched.length > before
      ? 'reached'
      : `not reached (${response.status} ${response.code ?? ''})`;
  }

  // ── the routes, one request shape each ─────────────────────────────────
  type Aim =
    | { kind: 'new'; workspace?: Record<string, unknown>; remote?: boolean }
    | { kind: 'thread'; threadId: string; remote?: boolean };
  const target = (aim: Aim) => ({
    agent: 'writer',
    ...(aim.kind === 'new' && aim.workspace
      ? { workspace: aim.workspace }
      : {}),
    ...(aim.remote ? { environment: { kind: 'saved', id: 'env-peer' } } : {}),
  });
  const ROUTES: Record<
    string,
    (aim: Aim) => { path: string; body: unknown } | undefined
  > = {
    'POST /chat': (aim) => ({
      path: '/api/orchestration/chat',
      body: {
        message: 'go',
        target: target(aim),
        ...(aim.kind === 'thread' ? { conversationId: aim.threadId } : {}),
      },
    }),
    'POST /delegations': (aim) =>
      aim.kind === 'new'
        ? {
            path: '/api/orchestration/delegations',
            body: { prompt: 'go', target: target(aim) },
          }
        : undefined,
    'POST /chat/:conversationId/continue': (aim) =>
      aim.kind === 'thread'
        ? {
            path: `/api/orchestration/chat/${aim.threadId}/continue`,
            body: {
              message: 'go',
              ...(aim.remote
                ? { environment: { kind: 'saved', id: 'env-peer' } }
                : {}),
            },
          }
        : undefined,
    'POST /delegations/:taskId/continue': (aim) =>
      aim.kind === 'thread'
        ? {
            path: `/api/orchestration/delegations/${aim.threadId}/continue`,
            body: {
              message: 'go',
              ...(aim.remote ? { environmentId: 'env-peer' } : {}),
            },
          }
        : undefined,
  };

  const P = { kind: 'project', projectSlug: 'project-a-slug' };
  const Q = { kind: 'project', projectSlug: 'project-b-slug' };
  const UNREADABLE = { kind: 'project', projectSlug: 'no-such-slug' };
  const FOLDER = { kind: 'directory', cwd: '/tmp/somewhere' };
  const ASSURANCE = 'station_control_assurance_insufficient';
  const ROLE = 'station_control_role_required';

  /**
   * [label, caller session, aim, outcome for a caller that is not bound].
   * A bound caller acting for the operator reaches every row (it keeps the
   * operator's reach), except where the target cannot be read at all.
   */
  const MATRIX: ReadonlyArray<[string, string, Aim, string]> = [
    [
      'Project → same Project (new)',
      'op-caller-a',
      { kind: 'new', workspace: P },
      'reached',
    ],
    [
      'Project → other Project (new)',
      'op-caller-a',
      { kind: 'new', workspace: Q },
      ASSURANCE,
    ],
    [
      'Project → global folder (new)',
      'op-caller-a',
      { kind: 'new', workspace: FOLDER },
      ASSURANCE,
    ],
    [
      'Project → global, no workspace (new)',
      'op-caller-a',
      { kind: 'new' },
      ASSURANCE,
    ],
    [
      'global → global folder (new)',
      'op-caller-global',
      { kind: 'new', workspace: FOLDER },
      'reached',
    ],
    [
      'global → Project (new)',
      'op-caller-global',
      { kind: 'new', workspace: P },
      ASSURANCE,
    ],
    [
      'Project → unreadable Project (new)',
      'op-caller-a',
      { kind: 'new', workspace: UNREADABLE },
      ROLE,
    ],
    [
      'Project → remote (new)',
      'op-caller-a',
      { kind: 'new', workspace: P, remote: true },
      ASSURANCE,
    ],
    [
      'Project → same-Project thread',
      'op-caller-a',
      { kind: 'thread', threadId: 'op-thread-a' },
      'reached',
    ],
    [
      'Project → other-Project thread',
      'op-caller-a',
      { kind: 'thread', threadId: 'op-thread-b' },
      ASSURANCE,
    ],
    [
      'Project → global thread',
      'op-caller-a',
      { kind: 'thread', threadId: 'op-thread-global' },
      ASSURANCE,
    ],
    [
      'global → global thread',
      'op-caller-global',
      { kind: 'thread', threadId: 'op-thread-global' },
      'reached',
    ],
    [
      'global → Project thread',
      'op-caller-global',
      { kind: 'thread', threadId: 'op-thread-a' },
      ASSURANCE,
    ],
    [
      'Project → host thread',
      'op-caller-a',
      { kind: 'thread', threadId: 'op-host-a' },
      ASSURANCE,
    ],
    [
      'Project → remote thread',
      'op-caller-a',
      { kind: 'thread', threadId: 'op-thread-a', remote: true },
      ASSURANCE,
    ],
    [
      'Project → unreadable-Project thread',
      'op-caller-a',
      { kind: 'thread', threadId: 'op-thread-slug' },
      ROLE,
    ],
    [
      'unreadable caller → Project thread',
      'op-caller-slug',
      { kind: 'thread', threadId: 'op-thread-a' },
      ASSURANCE,
    ],
    [
      'another owner’s thread',
      'op-caller-a',
      { kind: 'thread', threadId: 'person-thread-a' },
      ASSURANCE,
    ],
  ];

  test.each(Object.keys(ROUTES))(
    '%s: the caller class × scope matrix',
    async (route) => {
      const { base } = await setup();
      support.hostThreads.add('op-host-a');
      support.slugOnly.set('op-thread-slug', 'project-a-slug');
      support.slugOnly.set('op-caller-slug', 'project-a-slug');
      const rows: string[][] = [];
      for (const [label, caller, aim, nonBound] of MATRIX) {
        const request = ROUTES[route]!(aim);
        if (!request) continue;
        for (const channel of [
          'delegated-custody',
          'bearer-exposed',
        ] as const) {
          rows.push([
            label,
            channel,
            await outcome(
              base,
              request.path,
              as(channel, caller)(),
              request.body,
            ),
            nonBound,
          ]);
        }
        rows.push([
          label,
          'bound (operator)',
          await outcome(
            base,
            request.path,
            as('bound', caller)(),
            request.body,
          ),
          'reached',
        ]);
      }
      for (const [label, channel, actual, expected] of rows)
        expect([label, channel, actual]).toEqual([label, channel, expected]);
    },
  );

  test('a bound caller acting for another person: own sessions anywhere local, never another owner’s, never remote', async () => {
    const { base } = await setup();
    support.hostThreads.add('person-host-b');
    const bound = as('bound', 'person-caller-a');
    const chat = (aim: Aim) => ROUTES['POST /chat']!(aim)!;
    const cases: Array<[string, Aim, string]> = [
      [
        'own other-Project thread',
        { kind: 'thread', threadId: 'person-thread-b' },
        'reached',
      ],
      [
        'own host thread',
        { kind: 'thread', threadId: 'person-host-b' },
        'reached',
      ],
      [
        'own global thread',
        { kind: 'thread', threadId: 'person-thread-global' },
        'reached',
      ],
      ['new in another Project', { kind: 'new', workspace: Q }, 'reached'],
      [
        'the operator’s thread',
        { kind: 'thread', threadId: 'op-thread-a' },
        ROLE,
      ],
      ['remote', { kind: 'new', workspace: P, remote: true }, ROLE],
      ['an ownerless thread', { kind: 'thread', threadId: 'x-thread-a' }, ROLE],
    ];
    for (const [label, aim, expected] of cases) {
      const request = chat(aim);
      expect([
        label,
        await outcome(base, request.path, bound(), request.body),
      ]).toEqual([label, expected]);
    }
  });

  test('the Project execute action: an account member dispatches only where it may execute', async () => {
    const { base } = await setup();
    const member = as('bearer-exposed', 'acct-caller-acct');
    const chat = ROUTES['POST /chat']!;
    const inOwnProject = chat({
      kind: 'new',
      workspace: { kind: 'project', projectSlug: 'account-slug' },
    })!;
    expect(
      await outcome(base, inOwnProject.path, member(), inOwnProject.body),
    ).toBe('reached');
    // A viewer may not execute there.
    support.accountActions = ['view'];
    expect(
      await outcome(base, inOwnProject.path, member(), inOwnProject.body),
    ).toBe(ROLE);
    const followUp = chat({ kind: 'thread', threadId: 'acct-thread-acct' })!;
    expect(await outcome(base, followUp.path, member(), followUp.body)).toBe(
      ROLE,
    );
    // Nor may a bound member.
    const boundMember = as('bound', 'acct-caller-acct');
    expect(
      await outcome(base, followUp.path, boundMember(), followUp.body),
    ).toBe(ROLE);
  });

  test('an input reply, and a follow-up to a conversation that has no session yet', async () => {
    const { base } = await setup();
    const reply = (threadId: string, conversationId = threadId) => ({
      message: 'yes',
      conversationId,
      target: { agent: 'writer', environment: { kind: 'current' } },
      expectedInputRequest: { threadId, requestId: 'r', requestEventId: 'e' },
    });
    // In scope: the route's own input-request check answers (not reached:
    // the stub never reports an open request).
    expect(
      await send(
        base,
        '/api/orchestration/chat',
        as('bearer-exposed', 'op-caller-a')(),
        reply('op-thread-a'),
      ),
    ).toEqual({ status: 409, code: 'input_request_changed' });
    expect(
      await send(
        base,
        '/api/orchestration/chat',
        as('bearer-exposed', 'op-caller-a')(),
        reply('op-thread-b'),
      ),
    ).toEqual({ status: 403, code: ASSURANCE });
    // The reply's own thread decides, not the conversation the body names.
    expect(
      await send(
        base,
        '/api/orchestration/chat',
        as('bearer-exposed', 'op-caller-a')(),
        reply('op-thread-b', 'op-thread-a'),
      ),
    ).toEqual({ status: 403, code: ASSURANCE });
    // A conversation id with no session is a new session, in the scope the
    // body names.
    const fresh = ROUTES['POST /chat']!({
      kind: 'thread',
      threadId: 'new-conversation',
    })!;
    expect(
      await outcome(
        base,
        fresh.path,
        as('bearer-exposed', 'op-caller-global')(),
        fresh.body,
      ),
    ).toBe('reached');
    expect(
      await outcome(
        base,
        fresh.path,
        as('bearer-exposed', 'op-caller-a')(),
        fresh.body,
      ),
    ).toBe(ASSURANCE);
  });

  test('answering a worker’s request: a bound caller whose owner holds approve; in the global space, the operator', async () => {
    const { base } = await setup();
    const respond = (taskId: string) => ({
      path: `/api/orchestration/delegations/${taskId}/respond`,
      body: { requestId: 'r', decision: 'accept' },
    });
    const cases: Array<[string, () => Record<string, string>, string, string]> =
      [
        [
          'bound operator, own task',
          as('bound', 'op-caller-a'),
          'op-task-a',
          'reached',
        ],
        [
          'bound operator, another owner’s global task',
          as('bound', 'op-caller-a'),
          'person-task-global',
          'reached',
        ],
        [
          'bearer operator',
          as('bearer-exposed', 'op-caller-a'),
          'op-task-a',
          ASSURANCE,
        ],
        [
          'delegated operator',
          as('delegated-custody', 'op-caller-a'),
          'op-task-a',
          ASSURANCE,
        ],
        [
          'bound person, own Project task',
          as('bound', 'person-caller-a'),
          'person-task-a',
          ROLE,
        ],
        [
          'bound person, own global task',
          as('bound', 'person-caller-a'),
          'person-task-global',
          ROLE,
        ],
        [
          'bound member, own task (contributor)',
          as('bound', 'acct-caller-acct'),
          'acct-task-acct',
          ROLE,
        ],
        [
          'raw token',
          () => internal(),
          'op-task-a',
          'station_control_caller_required',
        ],
      ];
    for (const [label, headers, taskId, expected] of cases) {
      const request = respond(taskId);
      expect([
        label,
        await outcome(base, request.path, headers(), request.body),
      ]).toEqual([label, expected]);
    }
    // An admin holds approve.
    support.accountActions = ['view', 'discuss', 'edit', 'execute', 'approve'];
    const request = respond('acct-task-acct');
    expect(
      await outcome(
        base,
        request.path,
        as('bound', 'acct-caller-acct')(),
        request.body,
      ),
    ).toBe('reached');
    // The operator's UI answers as before.
    expect(await outcome(base, request.path, operatorUi, request.body)).toBe(
      'reached',
    );
  });

  test('the operator UI is not a station-control caller: it dispatches anywhere, remote included', async () => {
    const { base } = await setup();
    support.hostThreads.add('op-host-a');
    for (const [route, aim] of [
      ['POST /chat', { kind: 'new', workspace: Q, remote: true }],
      ['POST /delegations', { kind: 'new', workspace: UNREADABLE }],
      [
        'POST /chat/:conversationId/continue',
        { kind: 'thread', threadId: 'op-host-a' },
      ],
      [
        'POST /delegations/:taskId/continue',
        { kind: 'thread', threadId: 'person-thread-b' },
      ],
    ] as const) {
      const request = ROUTES[route]!(aim as Aim)!;
      expect([
        route,
        await outcome(base, request.path, operatorUi, request.body),
      ]).toEqual([route, 'reached']);
    }
  });

  test('no station-control tool reaches the conversation handoff route', async () => {
    const { base } = await setup();
    const body = {
      message: 'go',
      idempotencyKey: 'k',
      target: { agent: 'writer' },
    };
    for (const headers of [
      as('bound', 'op-caller-a'),
      as('delegated-custody', 'op-caller-a'),
      as('bearer-exposed', 'op-caller-a'),
    ])
      expect(
        await outcome(
          base,
          '/api/orchestration/conversations/op-thread-a/handoff',
          headers(),
          body,
        ),
      ).toBe('station_control_route_unmapped');
  });

  test('the remote-target leaves are the bound operator’s alone', async () => {
    const { base } = await setup();
    const leaves: Array<[string, string]> = [
      ['GET', '/api/environments/ssh'],
      ['POST', '/api/environments/ssh/ssh-1/connect'],
      ['GET', '/api/environments/peers/env-peer/credential'],
    ];
    for (const [method, path] of leaves) {
      const code = async (headers: Record<string, string>) => {
        const response = await fetch(`${base}${path}`, { method, headers });
        const body = (await response.json().catch(() => ({}))) as {
          code?: string;
        };
        return response.status === 403 &&
          body.code?.startsWith('station_control_')
          ? body.code
          : 'passed-guard';
      };
      expect([path, await code(as('bearer-exposed', 'op-caller-a')())]).toEqual(
        [path, ASSURANCE],
      );
      expect([
        path,
        await code(as('delegated-custody', 'op-caller-a')()),
      ]).toEqual([path, ASSURANCE]);
      expect([path, await code(as('bound', 'person-caller-a')())]).toEqual([
        path,
        ROLE,
      ]);
      expect([path, await code(internal())]).toEqual([
        path,
        'station_control_caller_required',
      ]);
      expect([path, await code(as('bound', 'op-caller-a')())]).toEqual([
        path,
        'passed-guard',
      ]);
    }
  });
});
