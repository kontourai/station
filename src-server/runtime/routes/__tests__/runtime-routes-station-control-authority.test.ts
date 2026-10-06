/**
 * #2377 slice A: the station-control authority guard in the PRODUCTION
 * composition — `configureRuntimeRoutes` with the real credential pipeline,
 * the real caller re-derivation (`resolveStationControlCallerForRequest` over
 * the production record resolver, reading the session owner from
 * `resolveSessionActingPrincipal`) and real token mints. What is proved is
 * the wiring in `runtime-routes.ts`: the guard sits between the auth boundary
 * and every route, reads the real runtime principal stamp, and leaves the
 * operator's credential, Station's own server code and the carve-outs alone.
 * The runtime services behind the routes are inert stubs, so "passed the
 * guard" is read as "not a station_control refusal".
 */
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { orchestrationCommandSchema } from '../../../routes/orchestration/orchestration.js';
import {
  __resetStationServerSelfAttestationForTests,
  runAsStationServer,
} from '../../../security/station-server-scope.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../../services/identity/principal-resolver.js';
import { NotificationService } from '../../../services/notifications/notification-service.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { SESSION_LOCAL_PROJECT_ID_METADATA_KEY } from '../../../services/orchestration/session-project-identity.js';
import {
  __resetStationControlStdioEntryForTests,
  api,
  STATION_CONTROL_CALLER_TOKEN_HEADER,
} from '../../../tools/station-control-shared.js';
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
  /** Every command the real `/commands` route handed to the service. */
  dispatched: [] as string[],
  /** What `configLoader.loadAppConfig` answers. */
  appConfig: {} as Record<string, unknown>,
  /**
   * The session-record Project each session started in; `null` for none.
   * Unlisted sessions started in `project-a`.
   */
  projects: new Map<string, string | null>(),
  /** Sessions that run unconfined (`host`). */
  hostThreads: new Set<string>(),
  /**
   * Sessions that started before the Project id stamp: only a slug, which
   * resolves now (`slug-lookup`) and so grants no Project authority.
   */
  slugOnly: new Map<string, string>(),
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

const HOSTED_ENV = 'STATION_HOSTED_TENANT_REGISTRY_FILE';
/** The `/commands` commands held to the caller's scope (slices C1 and C3). */
const SCOPED_COMMANDS = [
  'steerTurn',
  'steerTurnOnce',
  'inspectSteerInput',
  'adoptSession',
  'interruptTurn',
  'stopSession',
  'discardDraft',
] as const;
type ScopedCommand = (typeof SCOPED_COMMANDS)[number];
const OPERATOR_CREDENTIAL = 'test-only-operator-credential-authority-guard';
const makeTempDir = trackTempDirs();

describe('configureRuntimeRoutes: the station-control authority guard', () => {
  const closers: Array<() => Promise<void>> = [];
  const originalHosted = process.env[HOSTED_ENV];

  afterEach(async () => {
    if (originalHosted === undefined) delete process.env[HOSTED_ENV];
    else process.env[HOSTED_ENV] = originalHosted;
    __resetStationControlMcpTokensForTests();
    support.dispatched.length = 0;
    support.appConfig = {};
    support.projects.clear();
    support.hostThreads.clear();
    support.slugOnly.clear();
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
      projectMembership: undefined,
      projectSharedTasks: undefined,
      deploymentAuthentication: undefined,
      localAccounts: undefined,
      applicationSessions: undefined,
      app,
      port: 4321,
      appConfig: {},
      configLoader: {
        getProjectHomeDir: () => homeDir,
        loadAppConfig: () => support.appConfig,
      },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      activeAgents: new Map(),
      agentService: {
        listAgents: () => [],
        getAgent: async (slug: string) => ({
          slug,
          name: slug,
          execution: { approvalMode: 'ask' },
        }),
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
        resolveSessionActingPrincipal: (threadId: string) =>
          threadId.startsWith('op-')
            ? {
                id: LOCAL_OPERATOR_PRINCIPAL_ID,
                source: 'session-owner' as const,
              }
            : threadId.startsWith('person-')
              ? {
                  id: 'human:local:someone-else',
                  source: 'session-owner' as const,
                }
              : undefined,
        // The owner each session's start recorded (slice C2a reads it).
        sessionRecordedOwnerId: (threadId: string) =>
          threadId.startsWith('op-')
            ? LOCAL_OPERATOR_PRINCIPAL_ID
            : threadId.startsWith('person-')
              ? 'human:local:someone-else'
              : undefined,
        hasSessionStartRecord: () => true,
        currentConversationSessionId: (conversationId: string) =>
          conversationId,
        canUserReadSession: () => true,
        // The real `/commands` route's hand-off: "reached the service".
        dispatchWithReceipt: async (command: {
          type: string;
          threadId?: string;
          sourceThreadId?: string;
        }) => {
          support.dispatched.push(
            `${command.type} ${command.threadId ?? command.sourceThreadId}`,
          );
          return { receipt: { commandId: 'c', status: 'accepted' } };
        },
        // The start record of the calling session: its agent, and a
        // model-written delegation root that must choose nothing.
        firstStartedMetadataOfThread: (threadId: string) => {
          const slug = support.slugOnly.get(threadId);
          if (slug) return { projectSlug: slug };
          const project = support.projects.has(threadId)
            ? support.projects.get(threadId)
            : 'project-a';
          return project
            ? { [SESSION_LOCAL_PROJECT_ID_METADATA_KEY]: project }
            : {};
        },
        sessionRunsHost: (threadId: string) =>
          support.hostThreads.has(threadId),
      }),
      storageAdapter: deepStub({
        // The slug a pre-stamp session recorded still names project-a now.
        getProject: (slug: string) => {
          if (slug === 'project-a-slug') return { id: 'project-a' };
          throw new Error('no project');
        },
      }),
      taskGraphService: { listTasks: () => [] },
      projectService: { listProjects: () => [] },
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

  async function outcome(
    base: string,
    method: string,
    path: string,
    headers: Record<string, string>,
    body?: unknown,
  ): Promise<string> {
    const response = await fetch(`${base}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let code: unknown;
    try {
      code = (JSON.parse(text) as { code?: unknown }).code;
    } catch {
      code = undefined;
    }
    return response.status === 403 &&
      typeof code === 'string' &&
      code.startsWith('station_control_')
      ? code
      : 'passed-guard';
  }

  const callerFor = (
    sessionId: string,
    channel: 'sdk-in-process' | 'url-token',
  ) =>
    internal({
      [STATION_CONTROL_CALLER_TOKEN_HEADER]: mintStationControlMcpToken(
        sessionId,
        channel,
      ).token,
    });

  test('an internal request is decided from the table with the real caller derivation', async () => {
    const { base } = await setup();
    const update = { theme: 'dark' };
    expect(await outcome(base, 'PUT', '/config/app', internal(), update)).toBe(
      'station_control_caller_required',
    );
    expect(
      await outcome(
        base,
        'PUT',
        '/config/app',
        callerFor('op-claude', 'sdk-in-process'),
        update,
      ),
    ).toBe('passed-guard');
    expect(
      await outcome(
        base,
        'PUT',
        '/config/app',
        callerFor('person-claude', 'sdk-in-process'),
        update,
      ),
    ).toBe('station_control_role_required');
    expect(
      await outcome(
        base,
        'PUT',
        '/config/app',
        callerFor('op-codex', 'url-token'),
        update,
      ),
    ).toBe('station_control_assurance_insufficient');
    expect(
      await outcome(
        base,
        'POST',
        '/api/providers',
        callerFor('op-x', 'sdk-in-process'),
        {},
      ),
    ).toBe('station_control_person_only');
    // A read stays open to a caller-less request (decision 4).
    expect(await outcome(base, 'GET', '/config/app', internal())).toBe(
      'passed-guard',
    );
    // A route no tool reaches fails closed.
    expect(
      await outcome(base, 'GET', '/api/operator/accounts', internal()),
    ).toBe('station_control_route_unmapped');
  });

  test('the operator credential, Station’s own server code and the readiness carve-outs pass; the relay path does not', async () => {
    const { base } = await setup();
    expect(
      await outcome(
        base,
        'PUT',
        '/config/app',
        {
          'content-type': 'application/json',
          authorization: `Bearer ${OPERATOR_CREDENTIAL}`,
        },
        { theme: 'dark' },
      ),
    ).toBe('passed-guard');
    for (const path of ['/api/system/identity', '/api/system/instance'])
      expect(await outcome(base, 'GET', path, internal())).toBe('passed-guard');
    // M2: the agent relay path is no longer carved out; only the relay
    // itself (server code) passes.
    expect(
      await outcome(base, 'POST', '/api/agents/default/chat', internal(), {
        input: 'hi',
      }),
    ).toBe('station_control_route_unmapped');
    // Station's own server code: an explicit server scope, in the process the
    // composition minted the server attestation in. The same request without
    // the scope is refused (the control).
    expect(
      await outcome(base, 'PUT', '/config/app', internal(), { theme: 'dark' }),
    ).toBe('station_control_caller_required');
    __resetStationControlStdioEntryForTests();
    process.env.STATION_API_BASE = base;
    try {
      const response = (await runAsStationServer(() =>
        api('/config/app', {
          method: 'PUT',
          body: JSON.stringify({ theme: 'dark' }),
        }),
      )) as { code?: string };
      expect(response?.code ?? 'passed-guard').not.toMatch(/^station_control_/);
    } finally {
      delete process.env.STATION_API_BASE;
    }
  });

  // #2377 slice C1 (owner decision recorded on the issue): `steerTurn` and
  // `adoptSession` on `/commands` reach only threads in the caller's scope,
  // read by the production composition from the same records as the
  // caller's own session: owner (`op-` threads are the operator's, `person-`
  // another person's, anything else has none), session-record Project
  // (`support.projects`, default `project-a`) and confinement
  // (`support.hostThreads`).
  test('slice C1: steer and adopt stay in the caller’s owner, Project and confinement', async () => {
    const { base } = await setup();
    support.projects.set('op-thread-b', 'project-b');
    support.projects.set('op-thread-none', null);
    support.hostThreads.add('op-thread-host');
    support.hostThreads.add('person-thread-host');
    support.slugOnly.set('op-thread-slug', 'project-a-slug');
    const bodyFor = (type: ScopedCommand, threadId: string) =>
      type === 'steerTurn' ||
      type === 'steerTurnOnce' ||
      type === 'inspectSteerInput'
        ? { type, threadId, input: 'also check the tests', clientInputId: 'i' }
        : type === 'adoptSession'
          ? { type, sourceThreadId: threadId }
          : { type, threadId };
    const bearer = () => callerFor('op-codex', 'url-token');
    const delegated = () =>
      internal({
        [STATION_CONTROL_CALLER_TOKEN_HEADER]: mintStationControlMcpHeaderAuth(
          4321,
          'op-acp',
        ).token,
      });
    const cases: Array<[string, () => Record<string, string>, string, string]> =
      [
        // Same owner, same Project: allowed at every assurance.
        ['bearer own', bearer, 'op-thread', 'passed-guard'],
        ['delegated own', delegated, 'op-thread', 'passed-guard'],
        [
          'bound person own',
          () => callerFor('person-claude', 'sdk-in-process'),
          'person-thread',
          'passed-guard',
        ],
        // Same owner, another Project, or a Project that is no session record.
        [
          'bearer other Project',
          bearer,
          'op-thread-b',
          'station_control_assurance_insufficient',
        ],
        [
          'bearer no Project',
          bearer,
          'op-thread-none',
          'station_control_assurance_insufficient',
        ],
        // Its slug names the caller's Project now, but a slug lookup is not
        // the record Station stamped at its start.
        // Slice C2a: an unreadable Project proves no `execute` held there,
        // so no credential would admit it.
        [
          'bearer slug-lookup Project',
          bearer,
          'op-thread-slug',
          'station_control_role_required',
        ],
        // A host thread needs a bound caller.
        [
          'bearer host',
          bearer,
          'op-thread-host',
          'station_control_assurance_insufficient',
        ],
        [
          'delegated host',
          delegated,
          'op-thread-host',
          'station_control_assurance_insufficient',
        ],
        [
          'bound person host',
          () => callerFor('person-claude', 'sdk-in-process'),
          'person-thread-host',
          'passed-guard',
        ],
        // Another owner's thread, or one with no recorded owner.
        [
          'bearer other owner',
          bearer,
          'person-thread',
          'station_control_assurance_insufficient',
        ],
        [
          'bearer ownerless',
          bearer,
          'x-thread',
          'station_control_assurance_insufficient',
        ],
        [
          'bound person other owner',
          () => callerFor('person-claude', 'sdk-in-process'),
          'op-thread',
          'station_control_role_required',
        ],
        [
          'bearer person other owner',
          () => callerFor('person-codex', 'url-token'),
          'op-thread',
          'station_control_role_required',
        ],
        // The bound operator keeps the operator's reach (decision 3).
        [
          'bound op other owner, host',
          () => callerFor('op-claude', 'sdk-in-process'),
          'person-thread-host',
          'passed-guard',
        ],
        // No caller at all.
        [
          'raw token',
          () => internal(),
          'op-thread',
          'station_control_caller_required',
        ],
      ];
    for (const type of SCOPED_COMMANDS) {
      support.dispatched.length = 0;
      // Minted per request: a new mint for a session replaces its last token.
      for (const [label, headers, threadId, expected] of cases)
        expect([
          type,
          label,
          await outcome(
            base,
            'POST',
            '/api/orchestration/commands',
            headers(),
            bodyFor(type, threadId),
          ),
        ]).toEqual([type, label, expected]);
      // The admitted commands reached the service through the real route
      // (which hands a receipted steer on as a steer); the refused ones
      // never did.
      const handedOn = type === 'steerTurnOnce' ? 'steerTurn' : type;
      expect(support.dispatched).toEqual(
        cases
          .filter(([, , , expected]) => expected === 'passed-guard')
          .map(([, , threadId]) => `${handedOn} ${threadId}`),
      );
    }

    // The operator's UI is never an internal request: it steers, stops and
    // interrupts any thread, host and other Project included, and the route
    // hands it on.
    for (const type of ['steerTurn', 'interruptTurn', 'stopSession'] as const) {
      support.dispatched.length = 0;
      for (const threadId of ['op-thread-host', 'person-thread', 'op-thread-b'])
        expect(
          await outcome(
            base,
            'POST',
            '/api/orchestration/commands',
            {
              'content-type': 'application/json',
              authorization: `Bearer ${OPERATOR_CREDENTIAL}`,
            },
            bodyFor(type, threadId),
          ),
        ).toBe('passed-guard');
      expect(support.dispatched).toEqual([
        `${type} op-thread-host`,
        `${type} person-thread`,
        `${type} op-thread-b`,
      ]);
    }
  });

  // #2377 slice C3: every command `/commands` accepts is either an approval
  // command (a bound operator's) or held to the caller's scope, so a command
  // added to the route's schema cannot reach another Project's session by
  // default. Read from the route's own schema, not restated.
  test('slice C3: no /commands command reaches an other-Project session for a caller that is not bound', async () => {
    const { base } = await setup();
    support.projects.set('op-thread-b', 'project-b');
    const types = orchestrationCommandSchema.options.map(
      (option) => option.shape.type.value,
    );
    expect(types.length).toBeGreaterThan(0);
    for (const type of types) {
      const thread = (threadId: string) =>
        type === 'adoptSession'
          ? { sourceThreadId: threadId }
          : { threadId: threadId };
      expect([
        type,
        await outcome(
          base,
          'POST',
          '/api/orchestration/commands',
          callerFor('op-codex', 'url-token'),
          { type, ...thread('op-thread-b') },
        ),
      ]).toEqual([type, 'station_control_assurance_insufficient']);
    }
  });

  // #2377 slice C1: the production composition hands the Agent routes this
  // Station's default, so clearing an Agent's own default over a Station
  // default of `never` needs the full-access grant, which no agent holds.
  test('slice C1: an Agent write that falls through to a Station default of never is refused without the grant', async () => {
    const { base } = await setup();
    const clear = async () => {
      const response = await fetch(`${base}/agents/builder`, {
        method: 'PUT',
        headers: callerFor('op-claude', 'sdk-in-process'),
        body: JSON.stringify({ execution: {} }),
      });
      return {
        status: response.status,
        code: ((await response.json()) as { code?: string }).code,
      };
    };
    support.appConfig = { defaultApprovalMode: 'never' };
    expect(await clear()).toEqual({
      status: 403,
      code: 'approval-full-access-not-granted',
    });
    support.appConfig = { defaultApprovalMode: 'ask' };
    expect((await clear()).code).not.toBe('approval-full-access-not-granted');
  });
});
