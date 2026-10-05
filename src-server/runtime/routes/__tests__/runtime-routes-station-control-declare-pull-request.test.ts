/**
 * #3161: `declare_pull_request`'s REST leaf in the PRODUCTION composition:
 * `configureRuntimeRoutes` with the real credential pipeline, the real
 * station-control authority guard, the real caller and scope derivation and
 * real token mints. Only the services behind the route are stubs: the
 * orchestration service records the declaration the route handed it.
 *
 * Sessions are named for their records, as in the dispatch-scope suite:
 * `op-*` is the operator's, `person-*` another person's; `*-a` is in
 * project-a, `*-global` in no Project, `*-slug` names a Project Station
 * cannot confirm; `host-*` runs unconfined.
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
import { StationControlPullRequestUnavailableError } from '../../../services/orchestration/station-control-pull-request-declarations.js';
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
  /** Every declaration the real route handed to the orchestration service. */
  declared: [] as Record<string, unknown>[],
  /** What the orchestration service answers. */
  answer: (() => 'declared') as () => string,
  hostThreads: new Set<string>(),
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

function ownerOf(threadId: string): string | undefined {
  if (threadId.startsWith('op-') || threadId.startsWith('host-'))
    return LOCAL_OPERATOR_PRINCIPAL_ID;
  if (threadId.startsWith('person-')) return 'human:local:someone-else';
  return undefined;
}

function projectOf(threadId: string): string | undefined {
  if (threadId.endsWith('-global')) return undefined;
  return 'project-a';
}

const OPERATOR_CREDENTIAL = 'test-only-operator-credential-declare-pr';
const PATH = '/api/orchestration/station-control/declare-pull-request';
const makeTempDir = trackTempDirs();

const IDENTITY = {
  provider: 'github',
  host: 'github.com',
  repository: { owner: 'owner', name: 'repo' },
  ref: '42',
};

describe('configureRuntimeRoutes: declare_pull_request', () => {
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    __resetStationControlMcpTokensForTests();
    support.declared.length = 0;
    support.answer = () => 'declared';
    support.hostThreads.clear();
    support.slugOnly.clear();
    for (const close of closers.splice(0)) await close();
  });

  async function setup() {
    const homeDir = makeTempDir('station-declare-pr-route-');
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
        conversationForSession: () => undefined,
        conversationSessions: () => [],
        readSessionByThread: () => undefined,
      }),
      orchestrationService: deepStub({
        resolveSessionActingPrincipal: (threadId: string) => {
          const id = ownerOf(threadId);
          return id ? { id, source: 'session-owner' as const } : undefined;
        },
        sessionRecordedOwnerId: (threadId: string) => ownerOf(threadId),
        hasSessionStartRecord: () => true,
        currentConversationSessionId: (conversationId: string) =>
          conversationId,
        canUserReadSession: () => true,
        firstStartedMetadataOfThread: (threadId: string) => {
          const identity = { adoptedFromThreadId: 'attached' };
          const slug = support.slugOnly.get(threadId);
          if (slug) return { ...identity, projectSlug: slug };
          const project = projectOf(threadId);
          return project
            ? { ...identity, [SESSION_LOCAL_PROJECT_ID_METADATA_KEY]: project }
            : identity;
        },
        firstStartedEngineOfThread: () => 'codex',
        sessionRunsHost: (threadId: string) =>
          support.hostThreads.has(threadId),
        declareStationControlPullRequest: async (
          input: Record<string, unknown>,
        ) => {
          support.declared.push(input);
          const status = support.answer();
          if (status === 'unavailable')
            throw new StationControlPullRequestUnavailableError(
              'unreadable-identity',
            );
          return status;
        },
      }),
      storageAdapter: deepStub({
        getProject: () => {
          throw new Error('no project');
        },
      }),
      projectMembership: deepStub({
        admissionsForResolvedPrincipal: () => [],
      }),
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
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    return { base: `http://127.0.0.1:${await listening}` };
  }

  const internal = (extra: Record<string, string> = {}) => ({
    'content-type': 'application/json',
    [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
    [INTERNAL_PROXY_CALLER_HEADER]: 'local',
    ...extra,
  });

  type Channel = 'bound' | 'delegated-custody' | 'bearer-exposed';
  /** A fresh caller credential per request: a new mint replaces the last. */
  const as = (channel: Channel, sessionId: string) =>
    internal({
      [STATION_CONTROL_CALLER_TOKEN_HEADER]:
        channel === 'bound'
          ? mintStationControlMcpToken(sessionId, 'sdk-in-process').token
          : channel === 'bearer-exposed'
            ? mintStationControlMcpToken(sessionId, 'url-token').token
            : mintStationControlMcpHeaderAuth(4321, sessionId).token,
    });

  async function post(
    base: string,
    headers: Record<string, string>,
    body: unknown,
  ) {
    const response = await fetch(`${base}${PATH}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      /* not JSON */
    }
    return { status: response.status, json };
  }

  const ASSURANCE = 'station_control_assurance_insufficient';
  const ROLE = 'station_control_role_required';

  test('hands the verified caller’s own session and the parsed identity to the declaration', async () => {
    const { base } = await setup();
    const response = await post(base, as('bound', 'op-caller-a'), {
      ...IDENTITY,
      host: 'GitHub.com',
      label: 'The fix',
    });
    expect(response).toMatchObject({
      status: 200,
      json: { status: 'declared' },
    });
    expect(support.declared).toEqual([
      {
        sessionId: 'op-caller-a',
        // Lowercased exactly as the link route does before it compares.
        pullRequest: {
          provider: 'github',
          host: 'github.com',
          owner: 'owner',
          repository: 'repo',
          ref: '42',
        },
        label: 'The fix',
      },
    ]);
  });

  test.each(['declared', 'already-declared', 'no-active-turn'])(
    'answers %s as the declaration did',
    async (status) => {
      const { base } = await setup();
      support.answer = () => status;
      const response = await post(base, as('bound', 'op-caller-a'), IDENTITY);
      expect(response).toMatchObject({ status: 200, json: { status } });
    },
  );

  test('answers 409 when the pull request cannot be read at that identity', async () => {
    const { base } = await setup();
    support.answer = () => 'unavailable';
    const response = await post(base, as('bound', 'op-caller-a'), IDENTITY);
    expect(response.status).toBe(409);
    // Fixed copy per reason: no internal text reaches the engine.
    expect(response.json).toEqual({
      success: false,
      error:
        'The pull request could not be read at that exact identity in this session workspace.',
    });
  });

  // The scope rule every session-aimed call answers (`refuseOutOfScopeDispatch`
  // with the caller's own thread).
  describe('scope', () => {
    test.each<[string, Channel, string, string | 'reached']>([
      ['bound, same Project', 'bound', 'op-caller-a', 'reached'],
      [
        'delegated-custody, same Project',
        'delegated-custody',
        'op-caller-a',
        'reached',
      ],
      [
        'bearer-exposed (Codex), same Project',
        'bearer-exposed',
        'op-caller-a',
        'reached',
      ],
      [
        'bearer-exposed, no Project',
        'bearer-exposed',
        'op-caller-global',
        'reached',
      ],
      // A copied credential never reaches a session that runs unconfined.
      ['bound, unconfined', 'bound', 'host-caller-a', 'reached'],
      [
        'bearer-exposed, unconfined',
        'bearer-exposed',
        'host-caller-a',
        ASSURANCE,
      ],
      [
        'delegated-custody, unconfined',
        'delegated-custody',
        'host-caller-a',
        ASSURANCE,
      ],
    ])('%s', async (_label, channel, session, expected) => {
      const { base } = await setup();
      support.hostThreads.add('host-caller-a');
      const response = await post(base, as(channel, session), IDENTITY);
      if (expected === 'reached') {
        expect(response.status).toBe(200);
        expect(support.declared).toHaveLength(1);
      } else {
        expect(response.status).toBe(403);
        expect(response.json.code).toBe(expected);
        expect(support.declared).toEqual([]);
      }
    });

    test('a session whose Project Station cannot confirm is refused unless bound', async () => {
      const { base } = await setup();
      support.slugOnly.set('op-caller-slug', 'some-slug');
      const notBound = await post(
        base,
        as('bearer-exposed', 'op-caller-slug'),
        IDENTITY,
      );
      expect(notBound.status).toBe(403);
      expect([ASSURANCE, ROLE]).toContain(notBound.json.code);
      expect(support.declared).toEqual([]);
    });

    test('a caller with no verified session is refused before the declaration', async () => {
      const { base } = await setup();
      const response = await post(base, internal(), IDENTITY);
      expect(response.status).toBe(403);
      expect(response.json.code).toBe('station_control_caller_required');
      expect(support.declared).toEqual([]);
    });

    test('a session with no recorded owner acts for no one and is refused', async () => {
      const { base } = await setup();
      const response = await post(base, as('bound', 'orphan-a'), IDENTITY);
      expect(response.status).toBe(403);
      expect(response.json.code).toBe(ROLE);
      expect(support.declared).toEqual([]);
    });

    test('the operator’s own credential is not an internal request: 404', async () => {
      const { base } = await setup();
      const response = await post(
        base,
        {
          'content-type': 'application/json',
          authorization: `Bearer ${OPERATOR_CREDENTIAL}`,
        },
        IDENTITY,
      );
      expect(response.status).toBe(404);
      expect(support.declared).toEqual([]);
    });
  });

  describe('the body names a pull request and nothing else', () => {
    // Each case changes one thing of an otherwise valid body.
    test.each<[string, Record<string, unknown>]>([
      ['a session id', { ...IDENTITY, sessionId: 'op-other-a' }],
      ['a thread id', { ...IDENTITY, threadId: 'op-other-a' }],
      ['a turn id', { ...IDENTITY, turnId: 'turn-9' }],
      ['a native id', { ...IDENTITY, nativeId: '42' }],
      ['a zero ref', { ...IDENTITY, ref: '0' }],
      ['a ref with a leading zero', { ...IDENTITY, ref: '042' }],
      ['a ref that is not a number', { ...IDENTITY, ref: '42abc' }],
      ['a numeric ref', { ...IDENTITY, ref: 42 }],
      ['a ref past 32 characters', { ...IDENTITY, ref: '1'.repeat(33) }],
      ['a repository as one string', { ...IDENTITY, repository: 'owner/repo' }],
      [
        'a repository with no name',
        { ...IDENTITY, repository: { owner: 'owner' } },
      ],

      ['an empty label', { ...IDENTITY, label: '' }],
      ['a label past 240 characters', { ...IDENTITY, label: 'x'.repeat(241) }],
      // The link store refuses an identity with a space in it; so does this.
      [
        'an owner the link store would refuse',
        { ...IDENTITY, repository: { owner: 'own er', name: 'repo' } },
      ],
      [
        'a provider the link store would refuse',
        { ...IDENTITY, provider: 'git hub' },
      ],
    ])('refuses %s', async (_label, body) => {
      const { base } = await setup();
      const response = await post(base, as('bound', 'op-caller-a'), body);
      expect(response.status).toBe(400);
      expect(support.declared).toEqual([]);
    });

    // The link routes parse the repository as {owner, name} and drop what
    // else it carries; so does this, and only those two reach the declaration.
    test('reads the repository as the link routes do: owner and name only', async () => {
      const { base } = await setup();
      const response = await post(base, as('bound', 'op-caller-a'), {
        ...IDENTITY,
        repository: { owner: 'owner', name: 'repo', url: 'https://x' },
      });
      expect(response.status).toBe(200);
      expect(support.declared).toMatchObject([
        { pullRequest: { owner: 'owner', repository: 'repo' } },
      ]);
      expect(JSON.stringify(support.declared)).not.toContain('https://x');
    });

    test('refuses a body that is not JSON', async () => {
      const { base } = await setup();
      const response = await fetch(`${base}${PATH}`, {
        method: 'POST',
        headers: as('bound', 'op-caller-a'),
        body: 'not json',
      });
      expect(response.status).toBe(400);
      expect(support.declared).toEqual([]);
    });
  });
});
