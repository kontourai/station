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
import { mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { PROVIDER_MODEL_OPTION_SUPPORT } from '@kontourai/station-contracts/provider';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { z } from 'zod/v3';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { POSTURE_OPTION_KEYS } from '../../../routes/orchestration/dispatch-scope.js';
import {
  continueDelegatedTaskBodySchema,
  continueForegroundMessageSchema,
  conversationHandoffSchema,
  delegateTaskSchema,
  foregroundMessageObjectSchema,
} from '../../../routes/orchestration/orchestration.js';
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
  /** Projects with a working directory, for a folder's scope. */
  projectDirs: [] as { id: string; slug: string; workingDirectory: string }[],
  /** The working directory each session recorded. */
  cwds: new Map<string, string>(),
  /** Each conversation's lineage, oldest first (reserved sessions too). */
  lineage: new Map<string, string[]>(),
  /** The `cwd` each reached executor was handed (new sessions). */
  dispatchedCwds: [] as (string | undefined)[],
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
      const target = input.target as
        | { workspace?: { cwd?: string } }
        | undefined;
      support.dispatchedCwds.push(target?.workspace?.cwd);
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
    interruptDelegatedTask: record('task-interrupt', () => ({
      interruptRequested: true,
    })),
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
  if (threadId.endsWith('-n')) return 'project-n';
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
    support.projectDirs = [];
    support.cwds.clear();
    support.lineage.clear();
    support.dispatchedCwds.length = 0;
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
        conversationForSession: (threadId: string) => {
          for (const [conversationId, threads] of support.lineage)
            if (threads.includes(threadId)) return { conversationId };
          return undefined;
        },
        conversationSessions: (conversationId: string) =>
          (support.lineage.get(conversationId) ?? []).map((sessionId) => ({
            sessionId,
          })),
        readSessionByThread: (threadId: string) => {
          const cwd = support.cwds.get(threadId);
          return cwd ? { threadId, cwd } : undefined;
        },
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
        listProjects: () => support.projectDirs,
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
    // #2377 slice C3: stopping a task's turn is held like a follow-up to it.
    'POST /delegations/:taskId/interrupt': (aim) =>
      aim.kind === 'thread'
        ? {
            path: `/api/orchestration/delegations/${aim.threadId}/interrupt`,
            body: aim.remote ? { environmentId: 'env-peer' } : {},
          }
        : undefined,
  };

  const P = { kind: 'project', projectSlug: 'project-a-slug' };
  const Q = { kind: 'project', projectSlug: 'project-b-slug' };
  const UNREADABLE = { kind: 'project', projectSlug: 'no-such-slug' };
  // A folder that exists and lies in no Project: the global space.
  const FOLDER = { kind: 'directory', cwd: tmpdir() };
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

  // #2377 slice C3: the interrupt route was the one dispatch route that
  // decided only the remote verdict, so an agent could stop a turn of its
  // owner's session in another Project.
  test('interrupting a task: the raw token, and a bound caller acting for another person', async () => {
    const { base } = await setup();
    const interrupt = (taskId: string) =>
      ROUTES['POST /delegations/:taskId/interrupt']!({
        kind: 'thread',
        threadId: taskId,
      })!;
    const cases: Array<[string, () => Record<string, string>, string, string]> =
      [
        [
          'raw token',
          () => internal(),
          'op-thread-a',
          'station_control_caller_required',
        ],
        [
          'bound person, own other-Project task',
          as('bound', 'person-caller-a'),
          'person-thread-b',
          'reached',
        ],
        [
          'bound person, the operator’s task',
          as('bound', 'person-caller-a'),
          'op-thread-a',
          ROLE,
        ],
        [
          'bearer person, own other-Project task',
          as('bearer-exposed', 'person-caller-a'),
          'person-thread-b',
          ASSURANCE,
        ],
        [
          'no such task',
          as('bearer-exposed', 'op-caller-a'),
          'new-task',
          ASSURANCE,
        ],
      ];
    for (const [label, headers, taskId, expected] of cases) {
      const request = interrupt(taskId);
      expect([
        label,
        await outcome(base, request.path, headers(), request.body),
      ]).toEqual([label, expected]);
    }
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
      [
        'POST /delegations/:taskId/interrupt',
        { kind: 'thread', threadId: 'person-thread-b' },
      ],
      [
        'POST /delegations/:taskId/interrupt',
        { kind: 'thread', threadId: 'op-host-a' },
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

  // Owner decision: a global agent never reaches into a Project implicitly.
  // A plain folder's scope is the Project whose working directory contains
  // it (canonical paths, whole segments, the deepest Project), else global;
  // a folder Station cannot resolve refuses.
  test('a plain folder is scoped by the Project that contains it', async () => {
    const { base } = await setup();
    const root = realpathSync(makeTempDir('dispatch-folder-scope-'));
    const project = join(root, 'proj');
    const nested = join(project, 'inner');
    const sibling = join(root, 'proj-2');
    for (const dir of [join(project, 'sub'), join(nested, 'deep'), sibling])
      mkdirSync(dir, { recursive: true });
    symlinkSync(join(project, 'sub'), join(root, 'link'));
    support.projectDirs = [
      {
        id: 'project-a',
        slug: 'project-a-slug',
        workingDirectory: `${project}/`,
      },
      { id: 'project-n', slug: 'project-n-slug', workingDirectory: nested },
    ];
    const toFolder = (cwd: string) =>
      ROUTES['POST /chat']!({
        kind: 'new',
        workspace: { kind: 'directory', cwd },
      })!;
    const cases: Array<[string, string, string, string]> = [
      [
        'global caller → folder inside P',
        'op-caller-global',
        join(project, 'sub'),
        ASSURANCE,
      ],
      [
        'caller in P → folder inside P',
        'op-caller-a',
        join(project, 'sub'),
        'reached',
      ],
      ['caller in P → P’s own folder', 'op-caller-a', project, 'reached'],
      [
        'global caller → sibling-prefix folder',
        'op-caller-global',
        sibling,
        'reached',
      ],
      [
        'caller in P → sibling-prefix folder',
        'op-caller-a',
        sibling,
        ASSURANCE,
      ],
      [
        'global caller → symlink into P',
        'op-caller-global',
        join(root, 'link'),
        ASSURANCE,
      ],
      [
        'caller in P → symlink into P',
        'op-caller-a',
        join(root, 'link'),
        'reached',
      ],
      [
        'caller in P → nested Project',
        'op-caller-a',
        join(nested, 'deep'),
        ASSURANCE,
      ],
      [
        'caller in nested → nested Project',
        'op-caller-n',
        join(nested, 'deep'),
        'reached',
      ],
      [
        'caller in P → unresolvable folder',
        'op-caller-a',
        join(project, 'missing'),
        ROLE,
      ],
      [
        'global caller → unresolvable folder',
        'op-caller-global',
        join(root, 'missing'),
        ROLE,
      ],
    ];
    for (const [label, caller, cwd, expected] of cases) {
      const request = toFolder(cwd);
      expect([
        label,
        await outcome(
          base,
          request.path,
          as('bearer-exposed', caller)(),
          request.body,
        ),
      ]).toEqual([label, expected]);
    }
    // /delegations applies the same folder scope.
    const delegation = ROUTES['POST /delegations']!({
      kind: 'new',
      workspace: { kind: 'directory', cwd: join(project, 'sub') },
    })!;
    expect(
      await outcome(
        base,
        delegation.path,
        as('bearer-exposed', 'op-caller-global')(),
        delegation.body,
      ),
    ).toBe(ASSURANCE);
    // A follow-up to a session with no Project record that runs in P's
    // folder is P's, not the global space's.
    support.cwds.set('op-folder-global', join(project, 'sub'));
    const followUp = ROUTES['POST /chat/:conversationId/continue']!({
      kind: 'thread',
      threadId: 'op-folder-global',
    })!;
    expect(
      await outcome(
        base,
        followUp.path,
        as('bearer-exposed', 'op-caller-global')(),
        followUp.body,
      ),
    ).toBe(ASSURANCE);
    expect(
      await outcome(
        base,
        followUp.path,
        as('bearer-exposed', 'op-caller-a')(),
        followUp.body,
      ),
    ).toBe('reached');
  });

  // Review A1: a Project workspace's `cwd` must lie inside that Project.
  test('a Project workspace with a cwd in another Project’s folder is refused', async () => {
    const { base } = await setup();
    const root = realpathSync(makeTempDir('dispatch-project-cwd-'));
    const pa = join(root, 'pa');
    const pb = join(root, 'pb');
    for (const dir of [join(pa, 'sub'), pb])
      mkdirSync(dir, { recursive: true });
    support.projectDirs = [
      { id: 'project-a', slug: 'project-a-slug', workingDirectory: pa },
      { id: 'project-b', slug: 'project-b-slug', workingDirectory: pb },
    ];
    const caller = as('bearer-exposed', 'op-caller-a');
    for (const [route, cwd, expected] of [
      ['POST /chat', pb, ROLE],
      ['POST /delegations', pb, ROLE],
      ['POST /chat', join(pa, 'sub'), 'reached'],
      ['POST /delegations', join(pa, 'sub'), 'reached'],
    ] as const) {
      const request = ROUTES[route]!({
        kind: 'new',
        workspace: { kind: 'project', projectSlug: 'project-a-slug', cwd },
      })!;
      expect([
        route,
        cwd,
        await outcome(base, request.path, caller(), request.body),
      ]).toEqual([route, cwd, expected]);
    }
  });

  // Review A2: a conversation whose newest session is only reserved is a
  // follow-up, scoped by its newest STARTED session, and `host` covers every
  // session of it.
  test('a conversation with a reserved newest session is scoped by its newest started one', async () => {
    const { base } = await setup();
    const global = as('bearer-exposed', 'op-caller-global');
    const inA = as('bearer-exposed', 'op-caller-a');
    const follow = (conversationId: string) =>
      ROUTES['POST /chat']!({ kind: 'thread', threadId: conversationId })!;
    // Project b, newest reserved.
    support.lineage.set('conv-b', ['op-thread-b', 'new-reserved-b']);
    // Global, but a sibling runs host.
    support.hostThreads.add('op-host-global');
    support.lineage.set('conv-h', [
      'op-host-global',
      'op-thread-global',
      'new-reserved-h',
    ]);
    // Nothing started yet.
    support.lineage.set('new-conv-r', ['new-reserved-r']);
    const cases: Array<[string, () => Record<string, string>, string, string]> =
      [
        [
          'Project b, reserved newest, global caller',
          global,
          'conv-b',
          ASSURANCE,
        ],
        ['Project b, reserved newest, caller in a', inA, 'conv-b', ASSURANCE],
        ['host sibling, global caller', global, 'conv-h', ASSURANCE],
        ['only reserved sessions', global, 'new-conv-r', ASSURANCE],
      ];
    for (const [label, caller, conversationId, expected] of cases) {
      const request = follow(conversationId);
      expect([
        label,
        await outcome(base, request.path, caller(), request.body),
      ]).toEqual([label, expected]);
    }
    const cont = ROUTES['POST /chat/:conversationId/continue']!({
      kind: 'thread',
      threadId: 'conv-b',
    })!;
    expect(await outcome(base, cont.path, global(), cont.body)).toBe(ASSURANCE);
    // The control: a global conversation with nothing unconfined is the
    // global caller's.
    support.lineage.set('conv-g', ['op-thread-global', 'new-reserved-g']);
    const ok = follow('conv-g');
    expect(await outcome(base, ok.path, global(), ok.body)).toBe('reached');
  });

  // Review A4 (n1): `host` is read across the thread's whole conversation,
  // not only the thread the call names.
  test('a thread whose conversation has an unconfined sibling is host', async () => {
    const { base } = await setup();
    support.hostThreads.add('op-host-a');
    support.lineage.set('conv-sibling', ['op-host-a', 'op-thread-a']);
    const reply = {
      message: 'yes',
      conversationId: 'op-thread-a',
      target: { agent: 'writer', environment: { kind: 'current' } },
      expectedInputRequest: {
        threadId: 'op-thread-a',
        requestId: 'r',
        requestEventId: 'e',
      },
    };
    expect(
      await send(
        base,
        '/api/orchestration/chat',
        as('bearer-exposed', 'op-caller-a')(),
        reply,
      ),
    ).toEqual({ status: 403, code: ASSURANCE });
    // A task follow-up reads its conversation the same way.
    const task = ROUTES['POST /delegations/:taskId/continue']!({
      kind: 'thread',
      threadId: 'op-thread-a',
    })!;
    expect(
      await outcome(
        base,
        task.path,
        as('bearer-exposed', 'op-caller-a')(),
        task.body,
      ),
    ).toBe(ASSURANCE);
  });

  // Review A3: every route that takes an Environment refuses another
  // Station to a caller that is not a bound operator, before resolving it.
  test('task reads, events, interrupts and listings on another Station need a bound operator', async () => {
    const { base } = await setup();
    const request = async (
      method: 'GET' | 'POST',
      path: string,
      headers: Record<string, string>,
      body?: unknown,
    ) => {
      const response = await fetch(`${base}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        code?: string;
      };
      return response.status === 403 &&
        payload.code?.startsWith('station_control_')
        ? payload.code
        : 'passed';
    };
    const remote: Array<['GET' | 'POST', string, unknown]> = [
      [
        'GET',
        '/api/orchestration/delegations/op-thread-a?environmentId=env-peer',
        undefined,
      ],
      [
        'GET',
        '/api/orchestration/delegations/op-thread-a/events?environmentId=env-peer',
        undefined,
      ],
      [
        'POST',
        '/api/orchestration/delegations/op-thread-a/interrupt',
        { environmentId: 'env-peer' },
      ],
      // #2377 slice C2b: a tool's listing and target discovery on a saved
      // Environment go through these routes, which decide the same way.
      [
        'GET',
        '/api/orchestration/delegations?environmentId=env-peer',
        undefined,
      ],
    ];
    for (const [method, path, body] of remote) {
      expect([
        path,
        await request(
          method,
          path,
          as('bearer-exposed', 'op-caller-a')(),
          body,
        ),
      ]).toEqual([path, ASSURANCE]);
      expect([
        path,
        await request(
          method,
          path,
          as('delegated-custody', 'op-caller-a')(),
          body,
        ),
      ]).toEqual([path, ASSURANCE]);
      expect([
        path,
        await request(method, path, as('bound', 'person-caller-a')(), body),
      ]).toEqual([path, ROLE]);
      expect([
        path,
        await request(method, path, as('bound', 'op-caller-a')(), body),
      ]).toEqual([path, 'passed']);
    }
    // This Station's own task needs no Environment and is not refused here.
    for (const [method, path, body] of [
      ['GET', '/api/orchestration/delegations/op-thread-a', undefined],
      ['POST', '/api/orchestration/delegations/op-thread-a/interrupt', {}],
    ] as const)
      expect([
        path,
        await request(
          method,
          path,
          as('bearer-exposed', 'op-caller-a')(),
          body,
        ),
      ]).toEqual([path, 'passed']);
    // A portable Project workspace runs on the Station that offers it. (A
    // global caller, so only the remote verdict can refuse it.)
    for (const route of ['POST /chat', 'POST /delegations'] as const) {
      const portable = ROUTES[route]!({
        kind: 'new',
        workspace: {
          kind: 'project-portable',
          portableProjectId: 'portable-1',
          resourceId: 'resource-1',
        },
      })!;
      expect([
        route,
        await outcome(
          base,
          portable.path,
          as('bearer-exposed', 'op-caller-global')(),
          portable.body,
        ),
      ]).toEqual([route, ASSURANCE]);
    }
    // #2377 slice C2b: target discovery on a saved Environment is the
    // operator's (decision 1) at the table, and the route decides the remote
    // verdict before it connects or forwards anything.
    const options = [
      'POST',
      '/api/orchestration/delegations/options',
      { environmentId: 'env-peer' },
    ] as const;
    expect(
      await request(
        options[0],
        options[1],
        as('bearer-exposed', 'op-caller-a')(),
        options[2],
      ),
    ).toBe(ASSURANCE);
    expect(
      await request(
        options[0],
        options[1],
        as('bound', 'person-caller-a')(),
        options[2],
      ),
    ).toBe(ROLE);
    expect(
      await request(
        options[0],
        options[1],
        as('bound', 'op-caller-a')(),
        options[2],
      ),
    ).toBe('passed');
  });

  // Review A5: the route dispatches the canonical folder its check decided
  // on, so the session starts (and records) that path, not the link.
  test('a new session’s folder is dispatched as the canonical path the check resolved', async () => {
    const { base } = await setup();
    const root = realpathSync(makeTempDir('dispatch-canonical-cwd-'));
    mkdirSync(join(root, 'real', 'work'), { recursive: true });
    symlinkSync(join(root, 'real'), join(root, 'link'));
    const viaLink = `${join(root, 'link', 'work')}/`;
    for (const route of ['POST /chat', 'POST /delegations'] as const) {
      support.dispatchedCwds.length = 0;
      const request = ROUTES[route]!({
        kind: 'new',
        workspace: { kind: 'directory', cwd: viaLink },
      })!;
      expect(
        await outcome(
          base,
          request.path,
          as('bearer-exposed', 'op-caller-global')(),
          request.body,
        ),
      ).toBe('reached');
      expect([route, support.dispatchedCwds]).toEqual([
        route,
        [join(root, 'real', 'work')],
      ]);
    }
    // The operator's UI is not rewritten: its request is not scoped here.
    support.dispatchedCwds.length = 0;
    const ui = ROUTES['POST /chat']!({
      kind: 'new',
      workspace: { kind: 'directory', cwd: viaLink },
    })!;
    expect(await outcome(base, ui.path, operatorUi, ui.body)).toBe('reached');
    expect(support.dispatchedCwds).toEqual([viaLink]);
  });

  // Review A6: a session with no workspace starts in the default session
  // directory (the home directory), so its scope is that folder's.
  test('a dispatch with no workspace is scoped by the default session directory', async () => {
    const { base } = await setup();
    const noWorkspace = ROUTES['POST /chat']!({ kind: 'new' })!;
    // Home in no Project: the global space.
    expect(
      await outcome(
        base,
        noWorkspace.path,
        as('bearer-exposed', 'op-caller-global')(),
        noWorkspace.body,
      ),
    ).toBe('reached');
    // Home inside Project a: Project a's.
    support.projectDirs = [
      {
        id: 'project-a',
        slug: 'project-a-slug',
        workingDirectory: realpathSync(homedir()),
      },
    ];
    expect(
      await outcome(
        base,
        noWorkspace.path,
        as('bearer-exposed', 'op-caller-global')(),
        noWorkspace.body,
      ),
    ).toBe(ASSURANCE);
    expect(
      await outcome(
        base,
        noWorkspace.path,
        as('bearer-exposed', 'op-caller-a')(),
        noWorkspace.body,
      ),
    ).toBe('reached');
  });

  test('the SSH leaves are the bound operator’s alone; no tool reaches a peer credential', async () => {
    const { base } = await setup();
    const code = async (
      method: string,
      path: string,
      headers: Record<string, string>,
    ) => {
      const response = await fetch(`${base}${path}`, { method, headers });
      const body = (await response.json().catch(() => ({}))) as {
        code?: string;
      };
      return response.status === 403 &&
        body.code?.startsWith('station_control_')
        ? body.code
        : 'passed-guard';
    };
    for (const [method, path] of [
      ['GET', '/api/environments/ssh'],
      ['POST', '/api/environments/ssh/ssh-1/connect'],
    ] as const) {
      expect([
        path,
        await code(method, path, as('bearer-exposed', 'op-caller-a')()),
      ]).toEqual([path, ASSURANCE]);
      expect([
        path,
        await code(method, path, as('delegated-custody', 'op-caller-a')()),
      ]).toEqual([path, ASSURANCE]);
      expect([
        path,
        await code(method, path, as('bound', 'person-caller-a')()),
      ]).toEqual([path, ROLE]);
      expect([path, await code(method, path, internal())]).toEqual([
        path,
        'station_control_caller_required',
      ]);
      expect([
        path,
        await code(method, path, as('bound', 'op-caller-a')()),
      ]).toEqual([path, 'passed-guard']);
    }
    // #2377 slice C2b: the leaf that handed a tool the peer bearer is gone;
    // no tool entry names it, so even a bound operator's tool is refused
    // before any handler, and there is no handler left behind it.
    const leaf = '/api/environments/peers/env-peer/credential';
    for (const headers of [
      as('bound', 'op-caller-a')(),
      as('bearer-exposed', 'op-caller-a')(),
      internal(),
    ])
      expect(await code('GET', leaf, headers)).toBe(
        'station_control_route_unmapped',
      );
  });

  // ── #2377 slice C3b: an agent dispatches without an approval posture ────
  //
  // Owner decision (2026-10-03): a station-control dispatch or follow-up
  // from a caller that is not a bound operator may not carry an approval
  // mode; it is refused, never clamped, whatever the value (Station ranks
  // nothing, so `ask` is refused as surely as `auto`).

  const POSTURE = 'station_control_posture_not_allowed';
  /**
   * The option keys the matrix drives, written out rather than read from
   * `POSTURE_OPTION_KEYS`, so dropping a key from the source fails its row.
   */
  const POSTURE_OPTION_KEY_LITERALS = [
    'approvalMode',
    'mode',
    'permissionMode',
    'autoMode',
  ] as const;
  /** The posture each route's body can carry, by field path. */
  const withOptions = (key: string) =>
    ({
      approvalMode: 'auto',
      mode: 'acceptEdits',
      permissionMode: 'plan',
      autoMode: false,
    })[key];
  const optionVariants = (
    path: string,
    place: (options: Record<string, unknown>) => Record<string, unknown>,
  ): Record<string, Record<string, unknown>> =>
    Object.fromEntries([
      ...POSTURE_OPTION_KEY_LITERALS.map((key) => [
        `${path}.${key}`,
        place({ [key]: withOptions(key) }),
      ]),
      // A posture beside an ordinary option is still a posture.
      [
        `${path}.approvalMode (with effort)`,
        place({ effort: 'high', approvalMode: 'auto' }),
      ],
      [
        `${path}.autoMode (with effort)`,
        place({ effort: 'high', autoMode: false }),
      ],
    ]);
  const pickVariants = {
    'setApprovalMode (ask)': {
      setApprovalMode: 'ask',
      setApprovalModeBasedOn: null,
    },
    'setApprovalMode (connection-default)': {
      setApprovalMode: 'connection-default',
      setApprovalModeBasedOn: null,
    },
  };
  const NEW_IN_P = { agent: 'writer', workspace: P };
  const DELEGATION = {
    mode: 'isolated-child',
    depth: 1,
    maxDepth: 2,
    parentAgentSlug: 'writer',
    rootAgentSlug: 'writer',
  };
  const POSTURE_ROUTES: Record<
    string,
    {
      path: string;
      base: Record<string, unknown>;
      variants: Record<string, Record<string, unknown>>;
    }
  > = {
    'POST /chat': {
      path: '/api/orchestration/chat',
      base: { message: 'go', target: NEW_IN_P },
      variants: {
        ...pickVariants,
        ...optionVariants('target.model.options', (options) => ({
          target: { ...NEW_IN_P, model: { options } },
        })),
      },
    },
    'POST /chat/background': {
      path: '/api/orchestration/chat/background',
      base: { message: 'go', target: NEW_IN_P },
      variants: {
        ...pickVariants,
        ...optionVariants('target.model.options', (options) => ({
          target: { ...NEW_IN_P, model: { options } },
        })),
      },
    },
    'POST /chat/delegated': {
      path: '/api/orchestration/chat/delegated',
      base: { message: 'go', target: NEW_IN_P, delegation: DELEGATION },
      variants: {
        ...pickVariants,
        ...optionVariants('target.model.options', (options) => ({
          target: { ...NEW_IN_P, model: { options } },
        })),
      },
    },
    'POST /chat/:conversationId/continue': {
      path: '/api/orchestration/chat/op-thread-a/continue',
      base: { message: 'go' },
      variants: {
        ...pickVariants,
        ...optionVariants('model.options', (options) => ({
          model: { options },
        })),
      },
    },
    'POST /delegations': {
      path: '/api/orchestration/delegations',
      base: { prompt: 'go', target: NEW_IN_P },
      variants: optionVariants('target.model.options', (options) => ({
        target: { ...NEW_IN_P, model: { options } },
      })),
    },
    'POST /delegations/:taskId/continue': {
      path: '/api/orchestration/delegations/op-thread-a/continue',
      base: { message: 'go' },
      variants: optionVariants('modelOptions', (modelOptions) => ({
        modelOptions,
      })),
    },
  };

  test.each(Object.keys(POSTURE_ROUTES))(
    '%s: a posture is refused for every caller but a bound operator and the operator UI',
    async (route) => {
      const { base } = await setup();
      const { path, base: body, variants } = POSTURE_ROUTES[route]!;
      const callers: Array<[string, () => Record<string, string>, string]> = [
        ['bearer-exposed', as('bearer-exposed', 'op-caller-a'), POSTURE],
        ['delegated-custody', as('delegated-custody', 'op-caller-a'), POSTURE],
        ['bound, another person', as('bound', 'person-caller-a'), POSTURE],
        ['raw token', () => internal(), 'station_control_caller_required'],
        ['bound operator', as('bound', 'op-caller-a'), 'reached'],
        ['operator UI', () => operatorUi, 'reached'],
      ];
      const rows: string[][] = [];
      for (const [field, carried] of Object.entries(variants))
        for (const [label, headers, expected] of callers)
          rows.push([
            field,
            label,
            await outcome(base, path, headers(), { ...body, ...carried }),
            expected,
          ]);
      // Without a posture, nothing here refuses (the raw token is the
      // guard's: no dispatch for a caller-less request, decision 4).
      for (const [label, headers, expected] of [
        ['bearer-exposed', as('bearer-exposed', 'op-caller-a'), 'reached'],
        [
          'delegated-custody',
          as('delegated-custody', 'op-caller-a'),
          'reached',
        ],
        ['raw token', () => internal(), 'station_control_caller_required'],
        ['bound operator', as('bound', 'op-caller-a'), 'reached'],
        ['operator UI', () => operatorUi, 'reached'],
      ] as const)
        rows.push([
          'no posture',
          label,
          await outcome(base, path, headers(), body),
          expected,
        ]);
      for (const [field, label, actual, expected] of rows)
        expect([field, label, actual]).toEqual([field, label, expected]);
    },
  );

  /**
   * Fields of the dispatch bodies whose names speak of approvals or modes,
   * and every open option bag, must be a posture field the matrix above
   * refuses or a reviewed exception. A field added to these schemas later
   * fails here until it is classified.
   */
  test('every posture-like field of the dispatch bodies is refused or a reviewed exception', () => {
    // Case-sensitive on `Mode`, so `model` and `modelOptions` are not
    // mistaken for one; a bare `mode` field is.
    const SUSPECT =
      /approv|Approv|permission|Permission|posture|Posture|sandbox|Sandbox|bypass|Bypass|trust|Trust|autonom|Autonom|unattended|Unattended|yolo|unsafe|Unsafe|danger|Danger|^mode$|Mode/;
    const REVIEWED: Record<string, string> = {
      // The basis of a pick; meaningless without `setApprovalMode`.
      setApprovalModeBasedOn: 'basis only',
      // The delegation shape (`isolated-child`), not an approval mode.
      'delegation.mode': 'delegation shape',
      // Only tightens, and a verified caller's claimed delegation is not
      // read at all: it is rebuilt from the caller
      // (`createRequestDelegationResolver`, `deriveCallerChildDelegation`).
      'delegation.denyApprovals': 'tightens; attested claims only',
      // An execution-preparation requirement (#2875), not an approval mode:
      // it only narrows. The receiver refuses unless its own checkout is at
      // the named version, and any mode but `existing-realization` is a
      // typed refusal (`execution-preparation.ts`).
      'target.workspace.preparation.mode': 'preparation requirement; narrows',
    };
    // Open bags that no engine reads as an option. A bag listed here is
    // user data, never applied to the engine's settings.
    const REVIEWED_BAGS: Record<string, string> = {
      // Keyed by the selected skill's declared input ids (an undeclared key
      // is refused in `skill-experience-runtime.ts`) and embedded in the
      // prompt as "user data"; values are strings or attachment indices and
      // are never read as an approval mode or a model option.
      'skillExperience.inputs': 'skill input data, declared ids only',
      'skillExperience.attachmentInputs':
        'attachment indices, declared ids only',
    };
    const fieldsOf = (route: string): ReadonlySet<string> =>
      new Set(
        Object.keys(POSTURE_ROUTES[route]!.variants).map((field) =>
          field.replace(/ \(.*\)$/, ''),
        ),
      );
    const refused: Record<string, ReadonlySet<string>> = {
      foreground: fieldsOf('POST /chat'),
      continueForeground: fieldsOf('POST /chat/:conversationId/continue'),
      delegate: fieldsOf('POST /delegations'),
      continueDelegated: fieldsOf('POST /delegations/:taskId/continue'),
      // No tool reaches the handoff route; its check, on the same fields as
      // `/chat`, is driven in `handoff-posture.routes.test.ts`. Borrowing the
      // `/chat` fields relies on `conversationHandoffSchema` extending
      // `foregroundMessageObjectSchema` (the walk below still visits every
      // handoff field, so one it adds is checked).
      handoff: fieldsOf('POST /chat'),
    };
    const schemas: Record<string, z.ZodTypeAny> = {
      foreground: foregroundMessageObjectSchema,
      continueForeground: continueForegroundMessageSchema,
      delegate: delegateTaskSchema,
      continueDelegated: continueDelegatedTaskBodySchema,
      handoff: conversationHandoffSchema,
    };
    type Def = {
      typeName?: string;
      innerType?: z.ZodTypeAny;
      schema?: z.ZodTypeAny;
      type?: z.ZodTypeAny;
    };
    const defOf = (schema: z.ZodTypeAny) =>
      (schema as unknown as { _def: Def })._def;
    const collect = (
      schema: z.ZodTypeAny,
      path: string,
      out: { path: string; bag: boolean }[],
    ): void => {
      const def = defOf(schema);
      switch (def.typeName) {
        case 'ZodOptional':
        case 'ZodNullable':
        case 'ZodDefault':
          if (def.innerType) collect(def.innerType, path, out);
          return;
        case 'ZodEffects':
          if (def.schema) collect(def.schema, path, out);
          return;
        case 'ZodObject':
          for (const [key, value] of Object.entries(
            (schema as unknown as { shape: Record<string, z.ZodTypeAny> })
              .shape,
          )) {
            const child = path ? `${path}.${key}` : key;
            out.push({ path: child, bag: false });
            collect(value, child, out);
          }
          return;
        case 'ZodUnion':
        case 'ZodDiscriminatedUnion':
          for (const option of (
            schema as unknown as {
              options: z.ZodTypeAny[];
            }
          ).options)
            collect(option, path, out);
          return;
        case 'ZodArray':
          if (def.type) collect(def.type, `${path}[]`, out);
          return;
        case 'ZodRecord':
          out.push({ path, bag: true });
          return;
        default:
          return;
      }
    };
    const unclassified: string[] = [];
    for (const [name, schema] of Object.entries(schemas)) {
      const fields: { path: string; bag: boolean }[] = [];
      collect(schema, '', fields);
      expect([name, fields.length > 0]).toEqual([name, true]);
      const declared = refused[name]!;
      const bags = new Set(
        [...declared].map((field) => field.replace(/\.[^.]+$/, '')),
      );
      for (const { path, bag } of fields) {
        if (bag) {
          if (!bags.has(path) && !Object.hasOwn(REVIEWED_BAGS, path))
            unclassified.push(`${name}: open bag ${path}`);
          continue;
        }
        const leaf = path.split('.').at(-1)!;
        if (!SUSPECT.test(leaf) || Object.hasOwn(REVIEWED, path)) continue;
        if (!declared.has(path)) unclassified.push(`${name}: ${path}`);
      }
    }
    expect(unclassified).toEqual([]);

    // Every option key an engine applies is a refused posture key or a
    // reviewed non-posture one.
    const NOT_POSTURE = new Set([
      'effort',
      'reasoningEffort',
      'thinking',
      'fastMode',
    ]);
    const posture = new Set<string>(POSTURE_OPTION_KEYS);
    const optionKeys = new Set(
      Object.values(PROVIDER_MODEL_OPTION_SUPPORT).flat(),
    );
    expect(optionKeys.size).toBeGreaterThan(0);
    expect(
      [...optionKeys].filter(
        (key) => !posture.has(key) && !NOT_POSTURE.has(key),
      ),
    ).toEqual([]);
  });
});
