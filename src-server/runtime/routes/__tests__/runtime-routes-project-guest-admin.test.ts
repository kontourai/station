/**
 * #488 backend slice through the PRODUCTION composition.
 *
 * Drives the REAL `configureRuntimeRoutes` (real `configureRuntimeHttp`
 * pairing-scope enforcement, the REAL extracted account-bound device gate,
 * the REAL pairing host routes including the operator rescope endpoint, the
 * REAL membership + project routes) over real credentials: a real
 * `EnvironmentSecurityService` device registry on an isolated home, real
 * operator credential, real account-bound device pairing, and real account
 * sessions through the same provider-module loader production uses (the
 * only fixture is the provider module itself, exactly as
 * `authority-observation.routes.test.ts` establishes).
 *
 * Proves, per account-bound guest admin device with a successful
 * prerequisite Project read:
 *
 * - Project read 200, then `GET .../access` 200 and the four exact admin
 *   POST leaves 200 (`invitations`, `invitations/:id/revoke`, `members`,
 *   `transfer` as owner) — the allowlist, the pairing scopes
 *   (`orchestration:read` / `orchestration:operate`), and the membership
 *   predicates composing, with `enable-sharing` still operator-only;
 * - the guest grant is exactly `read+operate` rescoped via the existing
 *   operator HTTP endpoint — never `standard` (no `terminal:operate`) and
 *   never `access:manage`: read-only shows GET-yes/POST-no, terminal /
 *   pairing-management / inference-adjacent / private / nested-admin
 *   surfaces stay denied, and generic Project mutation stays banned;
 * - viewer/contributor are denied administration despite holding
 *   `orchestration:operate`; downgrade and revocation take effect on the
 *   very next request; owner transfer stays owner-only; stale revisions
 *   and wrong-Project scopes conflict;
 * - credential revocation (device), account revocation (logout), and
 *   member revocation each fail closed independently.
 *
 * No paid models, no mail: invitations are single-use links (`email:
 * null`), acceptance travels the real `accept-invitation` route.
 */
import crypto from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { S3Client } from '@aws-sdk/client-s3';
import { engineConnectionId } from '@kontourai/station-contracts/agent-identity';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import type { ProjectMembershipScope } from '@kontourai/station-contracts/project-membership';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import { resolveStationRoot } from '@kontourai/station-shared/runtime-path-resolver';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  createGateTestRegistry,
  GateTestAdapter,
} from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { readJson } from '../../../__test-utils__/read-json.js';
import { readStreamUntil } from '../../../__test-utils__/sse-helpers.js';
import { FileStorageAdapter } from '../../../domain/file-storage-adapter.js';
import { KnowledgeStoreProvider } from '../../../knowledge-store/knowledge-store-provider.js';
import { createApplicationSessionRuntime } from '../../../services/identity/application-session-runtime.js';
import { loadDeploymentAuthentication } from '../../../services/identity/deployment-authentication-loader.js';
import { deploymentAccountPrincipal } from '../../../services/identity/deployment-authentication-service.js';
import { loadLocalAccounts } from '../../../services/identity/local-account-runtime.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
import { createSessionAgentResolver } from '../../../services/orchestration/session-agent-resolution.js';
import { ProjectManifestStore } from '../../../services/projects/project-manifest-store.js';
import { createProjectMembershipRuntime } from '../../../services/projects/project-membership-runtime.js';
import { ProjectService } from '../../../services/projects/project-service.js';
import { TaskGraphService } from '../../../services/projects/task-graph-service.js';
import { DevicePairingError } from '../../../services/ssh/device-pairing-service.js';
import { EnvironmentSecurityService } from '../../../services/ssh/environment-security-service.js';
import {
  configureRuntimeRoutes as configureRuntimeRoutesProduction,
  isProjectMemberDraftLease,
  isProjectMemberPluginScaffold,
} from '../runtime-routes.js';

vi.mock('../runtime-route-support.js', () => {
  const runtimeSupportStub = new Proxy({}, { get: () => () => undefined });
  return {
    configureRuntimeSupportServices: () => ({
      schedulerService: runtimeSupportStub,
      notificationService: runtimeSupportStub,
      attentionProjection: runtimeSupportStub,
      webPushService: runtimeSupportStub,
      webPushEnabled: false,
    }),
    createRuntimeSystemRouteDeps: () => runtimeSupportStub,
  };
});

function deepCallable(): unknown {
  return new Proxy(() => undefined, {
    get: (_target, property) =>
      property === 'then' ? undefined : deepCallable(),
    apply: () => deepCallable(),
  });
}

function deepStub<T extends object>(overrides: T): T {
  return new Proxy(overrides, {
    get(target, property) {
      if (property in target) return Reflect.get(target, property);
      return deepCallable();
    },
  }) as T;
}

const ORIGIN = 'https://station.example.test';
const STATION_ID = 'guest-admin-fixture';
const PROVIDER_ISSUER = `urn:station:${STATION_ID}`;
const GUEST_SUBJECT = 'guest-person';
const PEER_SUBJECT = 'peer-person';
const GUEST_GRANT = 'orchestration:read orchestration:operate';
const operatorApproval = { kind: 'presented-credential' } as const;

function ownedTempRoot(prefix: string): string {
  const ambientRoot = resolveStationRoot();
  const base = resolve(tmpdir());
  const insideSharedRoot =
    ambientRoot === base ||
    base.startsWith(
      ambientRoot.endsWith(sep) ? ambientRoot : ambientRoot + sep,
    );
  return mkdtempSync(
    join(insideSharedRoot ? dirname(ambientRoot) : base, prefix),
  );
}

function writeProviderModule(homeDirectory: string): string {
  const modulePath = join(homeDirectory, 'fixture-provider.mjs');
  writeFileSync(
    modulePath,
    `
const revoked = new Set();
function subjectOf(request) {
  const cookie = request.headers.get('cookie') ?? '';
  const match = cookie.match(/fixture_account=(owner|guest|peer)/);
  return match ? match[1] + '-person' : null;
}
export async function createStationAuthenticationProvider(host) {
  return {
    version: 'station.authentication/v1',
    issuer: 'urn:station:' + host.stationId,
    displayName: 'Disposable two-account test provider',
    sessionCookies: ['fixture_account'],
    endpoints: [
      {path:'/login',methods:['POST'],operation:'begin-login'},
      {path:'/logout',methods:['POST'],operation:'logout'}
    ],
    async authenticate(request) {
      const cookie = request.headers.get('cookie') ?? '';
      if (cookie.includes('fixture_account=outage')) throw new Error('PRIVATE_PROVIDER_FAILURE');
      const subject = subjectOf(request);
      if (!subject || revoked.has(subject)) return {kind:'invalid',reason:'revoked'};
      return {kind:'authenticated',session:{
        subject,displayName:subject,sessionId:'session-' + subject,
        authenticatedAt:new Date(Date.now()-1000).toISOString(),
        expiresAt:new Date(Date.now()+60000).toISOString(),contacts:[]
      }};
    },
    sessionReferences: {
      async verify(sessionId) {
        const subject = sessionId.slice('session-'.length);
        if (!sessionId.startsWith('session-') || revoked.has(subject))
          return {kind:'invalid',reason:'revoked'};
        return {kind:'authenticated',session:{
          subject,displayName:subject,sessionId,
          authenticatedAt:new Date(Date.now()-1000).toISOString(),
          expiresAt:new Date(Date.now()+60000).toISOString(),contacts:[]
        }};
      },
      async revoke(sessionId) { revoked.add(sessionId.slice('session-'.length)); }
    },
    async handle(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith('/logout')) {
        const subject = subjectOf(request);
        if (subject) revoked.add(subject);
      }
      return Response.json({accepted:true});
    }
  };
}
`,
  );
  return modulePath;
}

/**
 * Read a guarded body to completion WITHOUT treating a read failure as
 * success: the caller must assert the returned error IS the canonical
 * delivery denial AND that zero bytes arrived. A revocation landing after
 * the 200 Response was returned cannot change its status, so the stream
 * error is the expected denial signal — never a 500, never a swallowed
 * failure.
 */
async function drainGuardedBody(response: Response) {
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let error: unknown = null;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (next.value) chunks.push(next.value);
    }
  } catch (caught) {
    error = caught;
  } finally {
    reader.releaseLock();
  }
  return {
    bytes: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
    error,
  };
}

function expectDeliveryDenied(drained: { bytes: Buffer; error: unknown }) {
  expect(String(drained.error)).toContain(
    'Project authorization ended before response delivery.',
  );
  expect(drained.bytes.length).toBe(0);
}

describe('project guest administration over the production composition', () => {
  const directories: string[] = [];
  const ambientHome = process.env.STATION_HOME;
  const ambientRoot = process.env.STATION_ROOT;
  const ambientOrigins = process.env.ALLOWED_ORIGINS;
  beforeEach(() => {
    const owned = ownedTempRoot('station-guest-admin-');
    directories.push(owned);
    mkdirSync(join(owned, 'home'));
    mkdirSync(join(owned, 'root'));
    mkdirSync(join(owned, 'data'));
    process.env.STATION_HOME = join(owned, 'home');
    process.env.STATION_ROOT = join(owned, 'root');
    process.env.ALLOWED_ORIGINS = ORIGIN;
  });
  const roomClosers: (() => Promise<void>)[] = [];
  const agentClosers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const close of roomClosers.splice(0)) await close();
    for (const close of agentClosers.splice(0)) await close();
    if (ambientHome === undefined) delete process.env.STATION_HOME;
    else process.env.STATION_HOME = ambientHome;
    if (ambientRoot === undefined) delete process.env.STATION_ROOT;
    else process.env.STATION_ROOT = ambientRoot;
    if (ambientOrigins === undefined) delete process.env.ALLOWED_ORIGINS;
    else process.env.ALLOWED_ORIGINS = ambientOrigins;
    vi.restoreAllMocks();
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  async function setup(withAgent = false, useLocalAccounts = false) {
    const owned = directories[directories.length - 1];
    const homeDir = join(owned, 'data');
    mkdirSync(join(homeDir, 'security'), { mode: 0o700, recursive: true });
    const security = new EnvironmentSecurityService({ homeDir });
    const { credential: operatorCredential } = await security.initialize();
    const modulePath = writeProviderModule(homeDir);
    const authentication = await loadDeploymentAuthentication(
      { modulePath, publicOrigin: ORIGIN },
      { stationId: STATION_ID, homeDirectory: homeDir },
    );
    if (!authentication) throw new Error('fixture provider failed to load');

    const storage = new FileStorageAdapter(homeDir);
    const knowledgeStoreProvider = new KnowledgeStoreProvider(storage);
    const manifests = new ProjectManifestStore(homeDir, storage);
    const projectService = new ProjectService(storage, manifests);
    const membership = createProjectMembershipRuntime(
      homeDir,
      STATION_ID,
      storage,
    );
    const localAccounts = await loadLocalAccounts(
      { publicOrigin: useLocalAccounts ? ORIGIN : 'http://localhost:4321' },
      { stationId: STATION_ID, homeDirectory: homeDir },
      membership.service,
    );
    const applicationSessions = createApplicationSessionRuntime(
      homeDir,
      STATION_ID,
      localAccounts,
      (value: string) => security.devicePairing.identifyDevice(value),
    );

    let appConfig: Record<string, unknown> = {};
    const app = new Hono();
    // A real bus, so /events relays through the production gates.
    const eventBus = new EventBus();
    const adapter = new GateTestAdapter();
    const start = vi.spyOn(adapter, 'startSession');
    const send = vi.spyOn(adapter, 'sendTurn');
    let sessions: OrchestrationService | undefined;
    let beforeSessionResolve: (() => Promise<void>) | undefined;
    if (withAgent) {
      const events = new EventStore(
        join(homeDir, 'room-provider-events.sqlite'),
      );
      const live = new Set<string>();
      vi.spyOn(adapter, 'hasSession').mockImplementation(
        async (id?: string) => id !== undefined && live.has(id),
      );
      start.mockImplementation(async (input) => {
        live.add(input.threadId);
        const session = {
          provider: 'claude' as const,
          threadId: input.threadId,
          status: 'ready' as const,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          metadata: input.metadata,
          cwd: input.cwd,
        };
        adapter.events.push({
          eventId: crypto.randomUUID(),
          provider: 'claude',
          threadId: input.threadId,
          method: 'session.started',
          sessionId: input.threadId,
          createdAt: session.createdAt,
          metadata: input.metadata,
        });
        await vi.waitFor(() =>
          expect(events.findSessionOwnerUserId(input.threadId)).toBe(
            input.metadata?.userId,
          ),
        );
        return session;
      });
      sessions = new OrchestrationService({
        adapterRegistry: createGateTestRegistry(adapter),
        eventBus,
        eventStore: events,
        adoptionLedger: events.createAdoptionLedger(),
        resolveSessionAgent: async (input) => {
          const before = beforeSessionResolve;
          beforeSessionResolve = undefined;
          await before?.();
          return createSessionAgentResolver({
            loadAgentSpec: async () => ({ name: 'Room Agent', prompt: '' }),
            resolveToolServer: async () => null,
            resolveSkillDir: async () => null,
          })(input);
        },
        logger: { debug() {}, warn() {} },
      });
      agentClosers.push(async () => {
        await sessions!.shutdown();
        events.close();
      });
    }

    const graph = new TaskGraphService(homeDir, {
      resolveProjectWorkspace: () => undefined,
    });
    const context = deepStub({
      projectMembership: membership.service,
      projectSharedTasks:
        useLocalAccounts || withAgent ? membership.sharedTasks : undefined,
      deploymentAuthentication: useLocalAccounts
        ? localAccounts
        : authentication,
      localAccounts,
      applicationSessions,
      storageAdapter: storage,
      knowledgeStoreProvider,
      projectService,
      app,
      port: 4321,
      host: '127.0.0.1',
      appConfig: {},
      configLoader: {
        getProjectHomeDir: () => homeDir,
        loadAppConfig: async () => ({ ...appConfig }),
        mutateAppConfig: async (
          mutate: (current: Record<string, unknown>) => Record<string, unknown>,
        ) => {
          appConfig = { ...appConfig, ...mutate({ ...appConfig }) };
          return { ...appConfig };
        },
      },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      activeAgents: new Map(),
      agentService: {
        listAgents: () => [],
        ...(withAgent
          ? {
              getAgent: async () => ({
                name: 'Room Agent',
                prompt: '',
                execution: { agentConnectionId: engineConnectionId('claude') },
              }),
            }
          : {}),
      },
      ...(sessions
        ? {
            orchestrationService: sessions,
            getLiveAppConfig: () => ({}),
            providerService: { listProviderConnections: () => [] },
            connectionService: {
              checkGatedModelConnectionIds: () => new Map(),
              getConnection: async () => ({
                id: 'claude',
                name: 'Claude',
                kind: 'agent',
                type: 'claude',
                enabled: true,
                status: 'ready',
                capabilities: ['agent-runtime'],
                config: { provider: 'claude' },
                prerequisites: [],
              }),
            },
          }
        : {}),
      agentMetadataMap: new Map(),
      agentFixedTokens: new Map(),
      agentTools: new Map(),
      agentStats: new Map(),
      agentStatus: new Map(),
      memoryAdapters: new Map(),
      metricsLog: [],
      monitoringEvents: [],
      orchestrationEventStore: new Proxy(
        {
          sessionTurnBoundaryAuthority: () => ({
            reconcile: () => ({ kind: 'available', interrupted: [] }),
          }),
        },
        {
          get(target, property) {
            if (property in target) return Reflect.get(target, property);
            return deepCallable();
          },
        },
      ),
      environmentSecurityService: security,
      eventBus,
      taskGraphService: graph,
    });
    const result = configureRuntimeRoutesProduction(
      context as unknown as Parameters<
        typeof configureRuntimeRoutesProduction
      >[0],
    );
    await result.kitLifecycleReady;
    roomClosers.push(() => result.projectRoomRuntime.close());

    const request = (path: string, init: RequestInit = {}) =>
      app.request(`${ORIGIN}${path}`, init);
    const ownerHeaders = (extra?: RequestInit) => ({
      ...extra,
      headers: {
        ...(extra?.headers ?? {}),
        Authorization: `Bearer ${operatorCredential}`,
        Cookie: 'fixture_account=owner',
      },
    });
    const operatorHeaders = (extra?: RequestInit) => ({
      ...extra,
      headers: {
        ...(extra?.headers ?? {}),
        Authorization: `Bearer ${operatorCredential}`,
      },
    });

    /** Pair an account-bound device with an EXPLICIT scope string. */
    const pairAccountBound = (
      name: string,
      scope: string,
      subject: string = GUEST_SUBJECT,
    ) => {
      const pairing = security.devicePairing;
      const offer = pairing.createOffer({ endpoint: ORIGIN, scope });
      const pending = pairing.requestPairing({
        offerId: offer.offerId,
        proof: offer.challenge,
        deviceName: name,
        requesterPosition: 'unproven',
        source: 'same-origin',
        accountCandidate: {
          issuer: useLocalAccounts
            ? localAccounts.service.describe().issuer
            : PROVIDER_ISSUER,
          subject,
          displayName: 'Guest Person',
        },
        accountCandidateSessionId: 'candidate-proof',
        requireAccountBinding: true,
      });
      pairing.confirmRequest(
        pending.requestId,
        { ...operatorApproval },
        {
          principalId: deploymentAccountPrincipal(
            useLocalAccounts
              ? localAccounts.service.describe().issuer
              : PROVIDER_ISSUER,
            subject,
            'Guest Person',
          ).id,
          kind: 'account',
        },
      );
      return pairing.exchange({
        offerId: offer.offerId,
        proof: offer.challenge,
        requestId: pending.requestId,
      });
    };
    const guestHeaders =
      (credential: string, accountCookie = 'fixture_account=guest') =>
      (extra?: RequestInit) => ({
        ...extra,
        headers: {
          ...(extra?.headers ?? {}),
          Authorization: `Bearer ${credential}`,
          Cookie: accountCookie,
          // Cookie-authenticated mutations require a trusted origin.
          Origin: ORIGIN,
        },
      });

    /**
     * Owner (local operator console) enables sharing and invites the
     * guest account as admin; the guest joins over the real
     * accept-invitation route with its bound device credential.
     */
    const shareWithGuestAdmin = async (
      slug: string,
      name: string,
      workingDirectory?: string,
    ) => {
      const project = await projectService.createProject({
        name,
        slug,
        ...(workingDirectory ? { workingDirectory } : {}),
      });
      const enabled = await request(
        `/api/projects/${slug}/access/enable`,
        ownerHeaders({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ localProjectId: project.id }),
        }),
      );
      expect(enabled.status, await enabled.clone().text()).toBe(200);
      const scope = (
        await readJson<{ data: { scope: ProjectMembershipScope } }>(enabled)
      ).data.scope;
      const invited = await request(
        `/api/projects/${slug}/access/invitations`,
        ownerHeaders({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            scope,
            email: null,
            role: 'admin',
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          }),
        }),
      );
      expect(invited.status, await invited.clone().text()).toBe(200);
      const token = (await readJson<{ data: { token: string } }>(invited)).data
        .token;
      const { credential } = pairAccountBound(`${slug}-kiosk`, GUEST_GRANT);
      const guest = guestHeaders(credential);
      const accepted = await request(
        '/api/account-auth/accept-invitation',
        guest({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        }),
      );
      expect(accepted.status, await accepted.clone().text()).toBe(200);
      return { project, scope, credential, guest };
    };

    return {
      app,
      graph,
      eventBus,
      homeDir,
      beforeSessionResolve: (effect: () => Promise<void>) => {
        beforeSessionResolve = effect;
      },
      adapter,
      start,
      send,
      sessions,
      request,
      security,
      authentication,
      operatorCredential,
      projectService,
      knowledgeStoreProvider,
      membership,
      localAccounts,
      storage,
      ownerHeaders,
      operatorHeaders,
      pairAccountBound,
      guestHeaders,
      shareWithGuestAdmin,
    };
  }

  test('real local accounts read only individually shared children through exact Device leaves', async () => {
    const h = await setup(false, true);
    const project = await h.projectService.createProject({
      name: 'Local relationships',
      slug: 'local-relationships',
    });
    const bootstrap = {
      current: async () => ({
        principal: humanPrincipal('fixture', 'operator', 'Operator'),
        verifiedEmails: [],
      }),
      operator: async () => {},
    };
    const enabled = await h.membership.service.enable(
      project.slug,
      project.id,
      bootstrap,
    );
    const people: {
      cookie: string;
      paired: ReturnType<typeof h.pairAccountBound>;
      authenticated: Extract<
        Awaited<ReturnType<typeof h.localAccounts.service.authenticate>>,
        { kind: 'authenticated' }
      >;
    }[] = [];
    for (const username of ['relationalice', 'relationbob']) {
      const invitation = await h.membership.service.invite(
        enabled.scope,
        {
          email: null,
          role: 'viewer',
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        },
        bootstrap,
      );
      const response = await h.localAccounts.service.handle(
        new Request(`${ORIGIN}/api/account-auth/sign-up/username`, {
          method: 'POST',
          headers: {
            Origin: ORIGIN,
            'Content-Type': 'application/json',
            'x-station-invitation': invitation.token,
          },
          body: JSON.stringify({
            username,
            password: 'Relationship password 12345',
            name: username,
          }),
        }),
        '/sign-up/username',
      );
      expect(response.status, await response.clone().text()).toBe(200);
      const login = await h.localAccounts.service.handle(
        new Request(`${ORIGIN}/api/account-auth/sign-in/username`, {
          method: 'POST',
          headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username,
            password: 'Relationship password 12345',
          }),
        }),
        '/sign-in/username',
      );
      expect(login.status, await login.clone().text()).toBe(200);
      const cookie = login.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; ');
      const authenticated = await h.localAccounts.service.authenticate(
        new Request(ORIGIN, { headers: { Cookie: cookie } }),
      );
      if (authenticated.kind !== 'authenticated')
        throw new Error(`real local login failed: ${authenticated.kind}`);
      expect(
        h.localAccounts.service.captureCurrentSession(new Request(ORIGIN))(),
      ).toBe(false);
      const verifiedRequest = new Request(ORIGIN, {
        headers: { Cookie: cookie },
      });
      await h.localAccounts.service.authenticate(verifiedRequest);
      expect(
        h.localAccounts.service.captureCurrentSession(verifiedRequest)(),
        JSON.stringify(authenticated.session),
      ).toBe(true);
      await h.membership.service.accept(invitation.token, {
        current: async () => ({
          principal: authenticated.principal,
          verifiedEmails: [],
        }),
        operator: async () => {},
      });
      const paired = h.pairAccountBound(
        username,
        GUEST_GRANT,
        authenticated.session.subject,
      );
      people.push({ cookie, authenticated, paired });
    }
    const parent = await h.graph.createTask({
      projectId: project.id,
      title: 'Shared parent',
    });
    const child = await h.graph.createTask({
      projectId: project.id,
      title: 'Private child title',
    });
    const access = {
      expectedProject: { id: project.id, createdAt: project.createdAt },
      canonicalProject: () => project,
      canReadTask: () => true,
      canMutateTask: () => true,
      canReadConversation: () => false,
    };
    await h.graph.setTaskParent(
      {
        operationId: 'seed-parent',
        child: { taskId: child.id, taskCreatedAt: child.createdAt },
        parent: { taskId: parent.id, taskCreatedAt: parent.createdAt },
        expectedRevision: 0,
      },
      access,
    );
    const share = (task: typeof parent) =>
      h.membership.sharedTasks.share({
        scope: enabled.scope,
        taskId: task.id,
        taskCreatedAt: task.createdAt,
        sharedBy: humanPrincipal('fixture', 'operator', 'Operator').id,
      });
    share(parent);
    const url = `/api/tasks/${parent.id}/children?taskCreatedAt=${encodeURIComponent(parent.createdAt)}`;
    const read = (index: number, withCookie = true) =>
      h.request(url, {
        headers: {
          Authorization: `Bearer ${people[index]!.paired.credential}`,
          ...(withCookie ? { Cookie: people[index]!.cookie } : {}),
        },
      });
    for (const index of [0, 1]) {
      const response = await read(index);
      expect(response.status, await response.clone().text()).toBe(200);
      expect(
        (await readJson<{ data: { children: unknown[] } }>(response)).data
          .children,
      ).toEqual([]);
    }
    share(child);
    expect(
      (
        await readJson<{ data: { children: { title: string }[] } }>(
          await read(0),
        )
      ).data.children.map((t) => t.title),
    ).toEqual(['Private child title']);
    const listChildren = h.graph.listTaskChildren.bind(h.graph);
    vi.spyOn(h.graph, 'listTaskChildren').mockImplementationOnce((...args) => {
      const children = listChildren(...args);
      const previous = h.membership.sharedTasks.admission(child.id)!;
      h.membership.sharedTasks.unshare(child.id, previous.shareId);
      share(child);
      return children;
    });
    const turnover = await read(0);
    expect(turnover.status).toBe(200);
    expect(
      (await readJson<{ data: { children: unknown[] } }>(turnover)).data
        .children,
    ).toEqual([]);
    expect(
      (await readJson<{ data: { children: unknown[] } }>(await read(0))).data
        .children,
    ).toHaveLength(1);
    // A Device without a cookie composes its exact approved account and live standing.
    expect((await read(1, false)).status).toBe(200);
    const mismatch = await h.request(url, {
      headers: {
        Authorization: `Bearer ${people[0]!.paired.credential}`,
        Cookie: people[1]!.cookie,
      },
    });
    expect(mismatch.status).toBe(401);
    const denied = await h.request(`/api/tasks/${parent.id}/children`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${people[0]!.paired.credential}`,
        Cookie: people[0]!.cookie,
        Origin: ORIGIN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        operationId: 'member-cannot-edit',
        parent: { taskId: parent.id, taskCreatedAt: parent.createdAt },
        task: { projectId: project.id, title: 'Denied child' },
      }),
    });
    expect(denied.status).toBe(404);
    expect(
      (
        await h.request(`/api/tasks/${parent.id}/dispatch`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${people[0]!.paired.credential}`,
            Cookie: people[0]!.cookie,
            Origin: ORIGIN,
          },
        })
      ).status,
    ).toBe(403);
    const operatorAccountEdit = await h.request(
      `/api/tasks/${parent.id}/children`,
      h.operatorHeaders({
        method: 'POST',
        headers: {
          Cookie: people[0]!.cookie,
          Origin: ORIGIN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          operationId: 'account-with-independent-operator',
          parent: { taskId: parent.id, taskCreatedAt: parent.createdAt },
          task: { projectId: project.id, title: 'Operator-authorized child' },
        }),
      }),
    );
    expect(
      operatorAccountEdit.status,
      await operatorAccountEdit.clone().text(),
    ).toBe(200);
    h.localAccounts.administration.setDisabled(
      people[1]!.authenticated.session.subject,
      true,
    );
    expect((await read(1, false)).status).not.toBe(200);
    const originalProject = h.storage.getProject(project.slug);
    vi.spyOn(h.graph, 'listTaskChildren').mockImplementationOnce((...args) => {
      const children = listChildren(...args);
      vi.spyOn(h.storage, 'getProject').mockImplementation((slug) =>
        slug === project.slug
          ? { ...originalProject, createdAt: '2001-01-01T00:00:00.000Z' }
          : originalProject,
      );
      return children;
    });
    expect((await read(0)).status).toBe(404);
    vi.restoreAllMocks();
    const graphPath = join(h.homeDir, 'task-graph.json');
    const beforeLockWait = readFileSync(graphPath, 'utf8');
    const release = await acquireFileMutationLockAsync(`${graphPath}.mutation`);
    let prepared = false;
    const createChild = h.graph.createChildTask.bind(h.graph);
    vi.spyOn(h.graph, 'createChildTask').mockImplementationOnce((...args) => {
      prepared = true;
      return createChild(...args);
    });
    const pending = h.request(
      `/api/tasks/${parent.id}/children`,
      h.operatorHeaders({
        method: 'POST',
        headers: {
          Cookie: people[0]!.cookie,
          Origin: ORIGIN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          operationId: 'revoked-during-runtime-lock-wait',
          parent: { taskId: parent.id, taskCreatedAt: parent.createdAt },
          task: { projectId: project.id, title: 'Must never commit' },
        }),
      }),
    );
    try {
      await vi.waitFor(() => expect(prepared).toBe(true));
      await h.localAccounts.service.revokeSessionReference(
        people[0]!.authenticated.session.sessionId,
        new AbortController().signal,
      );
    } finally {
      await release();
    }
    expect((await pending).status).toBe(404);
    expect(readFileSync(graphPath, 'utf8')).toBe(beforeLockWait);
    expect((await read(0)).status).not.toBe(200);
  });

  test('production Task relationship mount writes with ordinary operator authority and refuses account snapshots', async () => {
    const h = await setup();
    const project = await h.projectService.createProject({
      name: 'Relationships',
      slug: 'relationships',
    });
    const parent = await h.graph.createTask({
      projectId: project.id,
      title: 'Outcome',
    });
    const path = `/api/tasks/${parent.id}/children`;
    const input = {
      operationId: 'production-child',
      parent: { taskId: parent.id, taskCreatedAt: parent.createdAt },
      task: { projectId: project.slug, title: 'Deliverable' },
    };
    const post = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    };
    const created = await h.request(path, h.operatorHeaders(post));
    expect(created.status, await created.clone().text()).toBe(200);
    const body = await readJson<{ data: { task: { id: string } } }>(created);
    expect(h.graph.readTask(body.data.task.id)?.parent?.taskId).toBe(parent.id);
    const list = await h.request(
      `${path}?taskCreatedAt=${encodeURIComponent(parent.createdAt)}`,
      h.operatorHeaders(),
    );
    expect(list.status).toBe(200);
    expect(
      (
        await readJson<{ data: { children: { id: string }[] } }>(list)
      ).data.children.map((task) => task.id),
    ).toEqual([body.data.task.id]);
    const before = readFileSync(join(h.homeDir, 'task-graph.json'), 'utf8');
    expect(
      (
        await h.request(
          path,
          h.ownerHeaders({
            ...post,
            body: JSON.stringify({ ...input, operationId: 'denied-account' }),
          }),
        )
      ).status,
    ).toBe(404);
    expect(readFileSync(join(h.homeDir, 'task-graph.json'), 'utf8')).toBe(
      before,
    );
  });

  test('Project Room production mount requires exact incarnation and independent transport and member actions', async () => {
    const h = await setup();
    const { project, scope, guest, credential } = await h.shareWithGuestAdmin(
      'room-project',
      'Room Project',
    );
    const base = '/api/projects/room-project/room';
    const post = (value: unknown) =>
      guest({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(value),
      });
    expect((await h.request(base, guest())).status).toBe(404);
    expect(
      (
        await h.request(
          `${base}/init`,
          post({ expectedProjectId: 'wrong-incarnation' }),
        )
      ).status,
    ).toBe(409);
    expect((await h.request(base, guest())).status).toBe(404);
    const initialized = await h.request(
      `${base}/init`,
      post({ expectedProjectId: project.id }),
    );
    expect(initialized.status, await initialized.clone().text()).toBe(200);
    const identity = (
      await readJson<{
        data: { scope: ProjectMembershipScope; roomId: string };
      }>(initialized)
    ).data;
    expect(identity.scope).toEqual(scope);
    const retry = await h.request(
      `${base}/init`,
      post({ expectedProjectId: project.id }),
    );
    expect((await readJson<{ data: unknown }>(retry)).data).toEqual(identity);
    const discovered = await h.request(base, guest());
    expect(discovered.status).toBe(200);
    const view = (
      await readJson<{
        data: { actor: { id: string }; capabilities: { execute: boolean } };
      }>(discovered)
    ).data;
    expect(view.capabilities.execute).toBe(false);
    const guard = {
      expectedProjectId: project.id,
      expectedRoomId: identity.roomId,
      expectedActorId: view.actor.id,
    };
    const appended = await h.request(
      `${base}/messages`,
      post({
        ...guard,
        intentId: crypto.randomUUID(),
        text: 'Shared room message',
      }),
    );
    expect(appended.status, await appended.clone().text()).toBe(200);
    expect(
      (
        await h.request(
          `${base}/agents`,
          post({
            ...guard,
            intentId: crypto.randomUUID(),
            agentId: 'station',
            text: 'No compute grant',
          }),
        )
      ).status,
    ).toBe(403);
    for (const suffix of [
      '/init/extra',
      '/messages/extra',
      '/note/extra',
      '/agents/extra/reconcile/extra',
    ]) {
      expect(
        (
          await h.request(
            base + suffix,
            post({ expectedProjectId: project.id }),
          )
        ).status,
      ).toBe(403);
    }
    const anonymousMember = h.pairAccountBound('room-outsider', GUEST_GRANT);
    expect(
      (
        await h.request(
          base,
          h.guestHeaders(anonymousMember.credential, 'fixture_account=peer')(),
        )
      ).status,
    ).not.toBe(200);
    const rescope = await h.request(
      `/api/pairing/devices/${h.security.identifyDevice(credential)!.id}/scope`,
      h.operatorHeaders({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: ['orchestration:read'] }),
      }),
    );
    expect(rescope.status, await rescope.clone().text()).toBe(200);
    expect((await h.request(base, guest())).status).toBe(200);
    expect(
      (
        await h.request(
          `${base}/messages`,
          post({
            ...guard,
            intentId: crypto.randomUUID(),
            text: 'Must not append',
          }),
        )
      ).status,
    ).toBe(403);
    const history = await h.request(`${base}/messages`, guest());
    expect(
      (await readJson<{ data: { messages: unknown[] } }>(history)).data
        .messages,
    ).toHaveLength(1);
  });

  test('mounted Room Agent uses canonical orchestration, owner reads and selected answer publication without exposing private coordinates', async () => {
    const h = await setup(true);
    const { project } = await h.shareWithGuestAdmin('agent-room', 'Agent Room');
    const shared = await h.graph.createTask({
      projectId: project.id,
      title: 'Explicit shared recap Task',
      description: 'PRIVATE DESCRIPTION',
    });
    await h.graph.createTask({
      projectId: project.id,
      title: 'PRIVATE RECAP TASK SENTINEL',
    });
    const portable = new ProjectManifestStore(h.homeDir, h.storage).readRecord(
      project.slug,
    )!;
    const taskShare = h.membership.sharedTasks.share({
      scope: {
        stationId: STATION_ID,
        localProjectId: project.id,
        localProjectSlug: project.slug,
        portableProjectId: portable.id,
      },
      taskId: shared.id,
      taskCreatedAt: shared.createdAt,
      sharedBy: 'operator',
    });
    const root = join(h.homeDir, 'room-workspace');
    mkdirSync(root);
    await h.projectService.updateProject('agent-room', {
      workingDirectory: root,
    });
    const compute = h.pairAccountBound('room-compute', GUEST_GRANT);
    const promoted = await h.request(
      `/api/pairing/devices/${h.security.devicePairing.identifyDevice(compute.credential)!.id}/scope`,
      h.operatorHeaders({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: [...GUEST_GRANT.split(' '), 'coding:exec'],
        }),
      }),
    );
    expect(promoted.status, await promoted.clone().text()).toBe(200);
    const person = deploymentAccountPrincipal(
      PROVIDER_ISSUER,
      GUEST_SUBJECT,
      'Guest Person',
    );
    const group = await h.request(
      `/api/pairing/people/${encodeURIComponent(person.id)}/group`,
      h.operatorHeaders({
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ group: 'admin' }),
      }),
    );
    expect(group.status, await group.clone().text()).toBe(200);
    expect(h.security.resolveGrantedScope(compute.credential)).toContain(
      'coding:exec',
    );
    const guest = h.guestHeaders(compute.credential);
    const base = '/api/projects/agent-room/room';
    const post = (value: unknown) =>
      guest({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(value),
      });
    expect(
      (await h.request(`${base}/init`, post({ expectedProjectId: project.id })))
        .status,
    ).toBe(200);
    const view = (
      await readJson<{
        data: {
          roomId: string;
          actor: { id: string };
          capabilities: { execute: boolean };
        };
      }>(await h.request(base, guest()))
    ).data;
    expect(view.capabilities.execute).toBe(true);
    const guard = {
      expectedProjectId: project.id,
      expectedRoomId: view.roomId,
      expectedActorId: view.actor.id,
    };
    const input = {
      ...guard,
      intentId: crypto.randomUUID(),
      agentId: 'room-agent',
      text: 'Answer this room request',
    };
    const response = await h.request(`${base}/agents`, post(input));
    expect(response.status, await response.clone().text()).toBe(200);
    const handle = (
      await readJson<{ data: { requestId: string; state: string } }>(response)
    ).data;
    expect(handle.state).toBe('started');
    expect(handle).not.toHaveProperty('sessionId');
    expect(handle).not.toHaveProperty('executionCorrelationId');
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(h.send).toHaveBeenCalledTimes(1);
    const sessionId = h.start.mock.calls[0][0].threadId;
    expect(h.start.mock.calls[0][0].metadata?.userId).toBe(view.actor.id);
    expect(h.send.mock.calls[0][0].input).toContain('Answer this room request');
    const context = String(h.send.mock.calls[0][0].input);
    const taskEvidence = JSON.parse(context.split('\n')[0]!).tasks;
    expect(taskEvidence).toMatchObject({
      coverage: 'shared_subset',
      items: [
        {
          taskId: shared.id,
          taskCreatedAt: shared.createdAt,
          shareId: taskShare.shareId,
          title: shared.title,
          status: 'todo',
        },
      ],
    });
    expect(context).not.toMatch(/PRIVATE|childCount/);

    expect((await h.request(`${base}/agents`, post(input))).status).toBe(200);
    expect(h.start).toHaveBeenCalledTimes(1);
    const events = {
      provider: 'claude',
      threadId: sessionId,
      invocationId: h.send.mock.calls[0][0].invocationId,
      createdAt: new Date().toISOString(),
      turnId: 'turn-1',
    };
    h.adapter.events.push({
      ...events,
      eventId: crypto.randomUUID(),
      method: 'turn.started',
      prompt: 'Room prompt',
    });
    h.adapter.events.push({
      ...events,
      eventId: crypto.randomUUID(),
      method: 'content.text-delta',
      itemId: 'answer',
      delta: 'Selected shared answer',
    });
    h.adapter.events.push({
      ...events,
      eventId: crypto.randomUUID(),
      method: 'turn.completed',
      finishReason: 'stop',
      outputText: 'Selected shared answer',
    });
    await vi.waitFor(async () => {
      const reconciled = await h.request(
        `${base}/agents/${handle.requestId}/reconcile`,
        post(guard),
      );
      expect(reconciled.status, await reconciled.clone().text()).toBe(200);
      expect(
        (await readJson<{ data: { state: string } }>(reconciled)).data.state,
      ).toBe('published');
    });
    const history = (
      await readJson<{ data: { messages: { text: string }[] } }>(
        await h.request(`${base}/messages`, guest()),
      )
    ).data;
    expect(history.messages.map((m) => m.text)).toEqual([
      'Selected shared answer',
    ]);
    expect(JSON.stringify(history)).not.toContain(sessionId);
    const pending = await h.request(
      `${base}/agents`,
      post({ ...input, intentId: crypto.randomUUID() }),
    );
    expect(pending.status, await pending.clone().text()).toBe(200);
    const pendingHandle = (
      await readJson<{ data: { requestId: string } }>(pending)
    ).data;
    const pendingSession = h.start.mock.calls[1][0].threadId;
    const nextEvents = {
      ...events,
      threadId: pendingSession,
      invocationId: h.send.mock.calls[1][0].invocationId,
    };
    h.adapter.events.push({
      ...nextEvents,
      eventId: crypto.randomUUID(),
      method: 'turn.started',
      prompt: 'Room prompt',
    });
    h.adapter.events.push({
      ...nextEvents,
      eventId: crypto.randomUUID(),
      method: 'content.text-delta',
      itemId: 'answer',
      delta: 'Must stay private',
    });
    h.adapter.events.push({
      ...nextEvents,
      eventId: crypto.randomUUID(),
      method: 'turn.completed',
      finishReason: 'stop',
      outputText: 'Must stay private',
    });
    const readAnswer = h.sessions!.sessionQueries.readAssistantTurn.bind(
      h.sessions!.sessionQueries,
    );
    const selectedRead = vi
      .spyOn(h.sessions!.sessionQueries, 'readAssistantTurn')
      .mockImplementation(async (...args) => {
        const answer = await readAnswer(...args);
        if (answer.status === 'found') {
          const narrowed = await h.request(
            `/api/pairing/devices/${h.security.devicePairing.identifyDevice(compute.credential)!.id}/scope`,
            h.operatorHeaders({
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ scope: GUEST_GRANT.split(' ') }),
            }),
          );
          expect(narrowed.status).toBe(200);
        }
        return answer;
      });
    await vi.waitFor(async () => {
      const denied = await h.request(
        `${base}/agents/${pendingHandle.requestId}/reconcile`,
        post(guard),
      );
      expect(denied.status, await denied.clone().text()).toBe(403);
    });
    expect(selectedRead).toHaveBeenCalled();
    selectedRead.mockRestore();
    const repromoted = await h.request(
      `/api/pairing/devices/${h.security.devicePairing.identifyDevice(compute.credential)!.id}/scope`,
      h.operatorHeaders({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: [...GUEST_GRANT.split(' '), 'coding:exec'],
        }),
      }),
    );
    expect(repromoted.status).toBe(200);
    h.beforeSessionResolve(async () => {
      const denied = await h.request(
        `/api/pairing/devices/${h.security.devicePairing.identifyDevice(compute.credential)!.id}/scope`,
        h.operatorHeaders({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scope: GUEST_GRANT.split(' ') }),
        }),
      );
      expect(denied.status).toBe(200);
    });
    const fenced = await h.request(
      `${base}/agents`,
      post({ ...input, intentId: crypto.randomUUID() }),
    );
    expect(fenced.status, await fenced.clone().text()).toBe(403);
    expect(h.start).toHaveBeenCalledTimes(2);
    expect(h.send).toHaveBeenCalledTimes(2);

    const afterRevocation = await h.request(`${base}/messages`, guest());
    expect(
      (
        await readJson<{ data: { messages: { text: string }[] } }>(
          afterRevocation,
        )
      ).data.messages.map((m) => m.text),
    ).toEqual(['Selected shared answer']);
    const other = h.pairAccountBound(
      'other-room-account',
      `${GUEST_GRANT} coding:exec`,
    );
    expect(
      (
        await h.request(
          `${base}/agents/${handle.requestId}`,
          h.guestHeaders(other.credential, 'fixture_account=peer')(),
        )
      ).status,
    ).not.toBe(200);
  });

  test('baseline: project read 200, then admin GET access 200 and the four exact POST leaves 200', async () => {
    const h = await setup();
    const { scope, guest } = await h.shareWithGuestAdmin('demo', 'Demo');

    // Prerequisite Project read through the real gate + real routes.
    const read = await h.request('/api/projects/demo', guest());
    expect(read.status, await read.clone().text()).toBe(200);

    const access = await h.request('/api/projects/demo/access', guest());
    expect(access.status, await access.clone().text()).toBe(200);
    const view = await readJson<{
      success: boolean;
      data: { members: unknown[] };
    }>(access);
    expect(view.success).toBe(true);
    expect(view.data.members.length).toBeGreaterThanOrEqual(2);

    const invited = await h.request(
      '/api/projects/demo/access/invitations',
      guest({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope,
          email: null,
          role: 'viewer',
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        }),
      }),
    );
    expect(invited.status, await invited.clone().text()).toBe(200);
    const invitationId = (
      await readJson<{ data: { invitation: { id: string } } }>(invited)
    ).data.invitation.id;

    const revoked = await h.request(
      `/api/projects/demo/access/invitations/${invitationId}/revoke`,
      guest({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope }),
      }),
    );
    expect(revoked.status, await revoked.clone().text()).toBe(200);

    const changed = await h.request(
      '/api/projects/demo/access/members',
      guest({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope,
          principalId: deploymentAccountPrincipal(
            PROVIDER_ISSUER,
            GUEST_SUBJECT,
            'Guest Person',
          ).id,
          revision: 1,
          role: 'contributor',
          status: 'active',
        }),
      }),
    );
    // Self-demotion admin -> contributor still acknowledges.
    expect(changed.status, await changed.clone().text()).toBe(200);
  });

  // #3586: characterizes `accountMemberCaller` over the real composition.
  // An account session is held to membership on the Project read and the
  // catalogue alike; the operator keeps operator rules.
  test('member caller: a non-member account is refused the Project and the catalogue; a member reads its own; the operator reads all', async () => {
    const h = await setup();
    await h.shareWithGuestAdmin('demo', 'Demo');
    await h.projectService.createProject({ name: 'Private', slug: 'private' });
    const slugs = async (response: Response) => {
      expect(response.status, await response.clone().text()).toBe(200);
      const body = await readJson<{ data: { slug: string }[] }>(response);
      return body.data.map((project) => project.slug).sort();
    };
    const { credential: peerCredential } = h.pairAccountBound(
      'peer-kiosk',
      GUEST_GRANT,
      PEER_SUBJECT,
    );
    const peer = h.guestHeaders(peerCredential, 'fixture_account=peer');
    const peerRead = await h.request('/api/projects/demo', peer());
    expect(peerRead.status, await peerRead.clone().text()).toBe(404);
    expect(await slugs(await h.request('/api/projects', peer()))).toEqual([]);

    const { credential: guestCredential } = h.pairAccountBound(
      'guest-reader',
      GUEST_GRANT,
    );
    const guest = h.guestHeaders(guestCredential);
    const memberRead = await h.request('/api/projects/demo', guest());
    expect(memberRead.status, await memberRead.clone().text()).toBe(200);
    const unshared = await h.request('/api/projects/private', guest());
    expect(unshared.status, await unshared.clone().text()).toBe(404);
    expect(await slugs(await h.request('/api/projects', guest()))).toEqual([
      'demo',
    ]);

    const operatorRead = await h.request(
      '/api/projects/private',
      h.operatorHeaders(),
    );
    expect(operatorRead.status, await operatorRead.clone().text()).toBe(200);
    expect(
      await slugs(await h.request('/api/projects', h.operatorHeaders())),
    ).toEqual(['demo', 'private']);
  });

  test('account-bound pairing exchange refuses a provider session revoked after approval', async () => {
    const h = await setup();
    const pairing = h.security.devicePairing;
    const offer = pairing.createOffer({ endpoint: ORIGIN });
    const pending = pairing.requestPairing({
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: 'revoked-session-device',
      requesterPosition: 'unproven',
      accountCandidate: {
        issuer: PROVIDER_ISSUER,
        subject: GUEST_SUBJECT,
        displayName: 'Guest Person',
      },
      accountCandidateSessionId: `session-${GUEST_SUBJECT}`,
      requireAccountBinding: true,
    });
    const approved = await h.request(
      `/api/pairing/requests/${pending.requestId}/confirm`,
      h.operatorHeaders({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bindAccountIdentity: true }),
      }),
    );
    expect(approved.status, await approved.clone().text()).toBe(200);

    await h.authentication.service.revokeSessionReference(
      `session-${GUEST_SUBJECT}`,
      new AbortController().signal,
    );
    const before = pairing.listDevices().length;
    const exchange = await h.request(
      '/.well-known/station/v1/pairing/exchange',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          offerId: offer.offerId,
          proof: offer.challenge,
          requestId: pending.requestId,
        }),
      },
    );
    expect(exchange.status, await exchange.clone().text()).toBe(409);
    expect(await exchange.json()).toMatchObject({
      error: 'person_binding_unavailable',
    });
    expect(pairing.listDevices()).toHaveLength(before);
  });

  test('account-bound pairing exchange succeeds while the approved provider session remains current', async () => {
    const h = await setup();
    const pairing = h.security.devicePairing;
    const offer = pairing.createOffer({ endpoint: ORIGIN });
    const pending = pairing.requestPairing({
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: 'current-session-device',
      requesterPosition: 'unproven',
      accountCandidate: {
        issuer: PROVIDER_ISSUER,
        subject: GUEST_SUBJECT,
        displayName: 'Guest Person',
      },
      accountCandidateSessionId: `session-${GUEST_SUBJECT}`,
      requireAccountBinding: true,
    });
    const approved = await h.request(
      `/api/pairing/requests/${pending.requestId}/confirm`,
      h.operatorHeaders({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bindAccountIdentity: true }),
      }),
    );
    expect(approved.status, await approved.clone().text()).toBe(200);

    const exchange = await h.request(
      '/.well-known/station/v1/pairing/exchange',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          offerId: offer.offerId,
          proof: offer.challenge,
          requestId: pending.requestId,
        }),
      },
    );
    expect(exchange.status, await exchange.clone().text()).toBe(200);
    expect(await exchange.json()).toMatchObject({
      credential: expect.any(String),
      device: {
        principalBinding: {
          kind: 'account',
          issuer: PROVIDER_ISSUER,
          subject: GUEST_SUBJECT,
        },
      },
    });
  });

  test('ordinary Device approval does not inherit a request-only account candidate recheck', async () => {
    const h = await setup();
    const pairing = h.security.devicePairing;
    const offer = pairing.createOffer({ endpoint: ORIGIN });
    const pending = pairing.requestPairing({
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: 'device-only-approved-candidate',
      requesterPosition: 'unproven',
      accountCandidate: {
        issuer: PROVIDER_ISSUER,
        subject: GUEST_SUBJECT,
        displayName: 'Guest Person',
      },
      accountCandidateSessionId: `session-${GUEST_SUBJECT}`,
    });
    const approved = await h.request(
      `/api/pairing/requests/${pending.requestId}/confirm`,
      h.operatorHeaders({ method: 'POST' }),
    );
    expect(approved.status, await approved.clone().text()).toBe(200);

    // Account evidence can accompany a pairing-code request without the
    // operator choosing account binding. Its later revocation must not turn
    // the ordinary Device-only approval into an account-bound one.
    await h.authentication.service.revokeSessionReference(
      `session-${GUEST_SUBJECT}`,
      new AbortController().signal,
    );
    const exchange = await h.request(
      '/.well-known/station/v1/pairing/exchange',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          offerId: offer.offerId,
          proof: offer.challenge,
          requestId: pending.requestId,
        }),
      },
    );
    expect(exchange.status, await exchange.clone().text()).toBe(200);
    const exchanged = await readJson<{
      credential: string;
      device: Record<string, unknown>;
    }>(exchange);
    expect(exchanged.credential).toEqual(expect.any(String));
    expect(exchanged.device).not.toHaveProperty('principalBinding');
  });

  test('account-bound exchange fails closed when its approval evidence is unavailable', async () => {
    const h = await setup();
    const pairing = h.security.devicePairing;
    const offer = pairing.createOffer({ endpoint: ORIGIN });
    const pending = pairing.requestPairing({
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: 'missing-account-evidence-device',
      requesterPosition: 'unproven',
      accountCandidate: {
        issuer: PROVIDER_ISSUER,
        subject: GUEST_SUBJECT,
        displayName: 'Guest Person',
      },
      accountCandidateSessionId: `session-${GUEST_SUBJECT}`,
      requireAccountBinding: true,
    });
    const approved = await h.request(
      `/api/pairing/requests/${pending.requestId}/confirm`,
      h.operatorHeaders({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bindAccountIdentity: true }),
      }),
    );
    expect(approved.status, await approved.clone().text()).toBe(200);
    vi.spyOn(pairing, 'approvedAccountBindingForRequest').mockImplementation(
      () => {
        throw new DevicePairingError('invalid_request');
      },
    );

    const before = pairing.listDevices().length;
    const exchange = await h.request(
      '/.well-known/station/v1/pairing/exchange',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          offerId: offer.offerId,
          proof: offer.challenge,
          requestId: pending.requestId,
        }),
      },
    );
    expect(exchange.status, await exchange.clone().text()).toBe(400);
    expect(pairing.listDevices()).toHaveLength(before);
  });

  test('aborted account-bound exchange does not mint after an uncooperative provider finishes', async () => {
    const h = await setup();
    const pairing = h.security.devicePairing;
    const offer = pairing.createOffer({ endpoint: ORIGIN });
    const pending = pairing.requestPairing({
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: 'aborted-account-exchange-device',
      requesterPosition: 'unproven',
      accountCandidate: {
        issuer: PROVIDER_ISSUER,
        subject: GUEST_SUBJECT,
        displayName: 'Guest Person',
      },
      accountCandidateSessionId: `session-${GUEST_SUBJECT}`,
      requireAccountBinding: true,
    });
    const approved = await h.request(
      `/api/pairing/requests/${pending.requestId}/confirm`,
      h.operatorHeaders({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bindAccountIdentity: true }),
      }),
    );
    expect(approved.status, await approved.clone().text()).toBe(200);

    const verified = await h.authentication.service.verifySessionReference(
      `session-${GUEST_SUBJECT}`,
      new AbortController().signal,
    );
    expect(verified.kind).toBe('authenticated');
    let providerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });
    let finishProvider!: (value: typeof verified) => void;
    const delayed = new Promise<typeof verified>((resolve) => {
      finishProvider = resolve;
    });
    vi.spyOn(
      h.authentication.service,
      'verifySessionReference',
    ).mockImplementation(async () => {
      providerStarted();
      // Deliberately ignore AbortSignal to model a slow provider adapter.
      return delayed;
    });

    const controller = new AbortController();
    const before = pairing.listDevices().length;
    const response = h.request('/.well-known/station/v1/pairing/exchange', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        offerId: offer.offerId,
        proof: offer.challenge,
        requestId: pending.requestId,
      }),
    });
    await started;
    controller.abort();
    finishProvider(verified);

    let responseStatus: number | undefined;
    let rejection: unknown;
    try {
      responseStatus = (await response).status;
    } catch (error) {
      rejection = error;
    }
    if (responseStatus !== undefined) {
      expect(responseStatus).not.toBe(200);
    } else {
      // A canceled caller may stop receiving the response, but the rejection
      // must be the cancellation itself rather than a swallowed assertion.
      expect(rejection).toMatchObject({ name: 'AbortError' });
    }
    expect(pairing.listDevices()).toHaveLength(before);
  });

  test('layout management and personal subjects compose through real account credentials without sharing personal records', async () => {
    const h = await setup();
    const { scope, guest } = await h.shareWithGuestAdmin('lenses', 'Lenses');
    const send = (method: string, body: unknown) => ({
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const create = await h.request(
      '/api/projects/lenses/layouts',
      guest(send('POST', { slug: 'shared', name: 'Shared', config: {} })),
    );
    expect(create.status, await create.clone().text()).toBe(201);
    const cloned = await h.request(
      '/api/me/layouts/clone-project',
      guest(
        send('POST', {
          projectSlug: 'lenses',
          layoutSlug: 'shared',
          slug: 'mine',
        }),
      ),
    );
    expect(cloned.status, await cloned.clone().text()).toBe(201);
    expect((await h.request('/api/me/layouts/mine', guest())).status).toBe(200);
    expect(
      (
        await h.request(
          '/api/projects/lenses/layouts/shared',
          guest(send('PUT', { name: 'Renamed' })),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await h.request(
          '/api/projects/lenses/layout-policy',
          guest(send('PUT', { personalLayouts: 'off' })),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await h.request(
          '/api/projects/lenses/layout-policy',
          h.ownerHeaders(send('PUT', { personalLayouts: 'off' })),
        )
      ).status,
    ).toBe(200);
    expect((await h.request('/api/me/layouts/mine', guest())).status).toBe(404);
    expect(
      (
        await h.request(
          '/api/projects/lenses/layout-policy',
          h.ownerHeaders(send('PUT', { personalLayouts: 'project-panes' })),
        )
      ).status,
    ).toBe(200);
    expect((await h.request('/api/me/layouts/mine', guest())).status).toBe(200);

    const invited = await h.request(
      '/api/projects/lenses/access/invitations',
      h.ownerHeaders(
        send('POST', {
          scope,
          email: null,
          role: 'contributor',
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        }),
      ),
    );
    expect(invited.status).toBe(200);
    const token = (await readJson<{ data: { token: string } }>(invited)).data
      .token;
    const peerDevice = h.pairAccountBound(
      'lens-peer',
      GUEST_GRANT,
      PEER_SUBJECT,
    );
    const peer = h.guestHeaders(peerDevice.credential, 'fixture_account=peer');
    expect(
      (
        await h.request(
          '/api/account-auth/accept-invitation',
          peer(send('POST', { token })),
        )
      ).status,
    ).toBe(200);
    expect((await h.request('/api/projects/lenses', peer())).status).toBe(200);
    expect(
      (
        await readJson<{ data: unknown[] }>(
          await h.request('/api/me/layouts', peer()),
        )
      ).data,
    ).toEqual([]);
    for (const [method, suffix, body] of [
      ['GET', '', undefined],
      ['PUT', '', { name: 'Stolen' }],
      ['DELETE', '', undefined],
      ['POST', '/clone', { slug: 'stolen' }],
    ] as const) {
      const init = body === undefined ? { method } : send(method, body);
      const exists = await h.request(
        `/api/me/layouts/mine${suffix}`,
        peer(init),
      );
      const missing = await h.request(
        `/api/me/layouts/absent${suffix}`,
        peer(init),
      );
      expect(exists.status).toBe(404);
      expect(await exists.text()).toBe(await missing.text());
    }
    expect(
      (
        await h.request(
          '/api/projects/lenses/layouts',
          peer(send('POST', { slug: 'denied', name: 'Denied' })),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await h.request(
          '/api/projects/lenses/layouts/shared',
          peer(send('PUT', { name: 'Denied' })),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await h.request(
          '/api/projects/lenses/layouts/shared',
          peer({ method: 'DELETE' }),
        )
      ).status,
    ).toBe(403);
    expect((await h.request('/api/me/layouts/mine', guest())).status).toBe(200);
    expect(
      (
        await h.request(
          '/api/projects/lenses/layouts/shared',
          guest({ method: 'DELETE' }),
        )
      ).status,
    ).toBe(200);
  });

  test('enable-sharing stays operator-only and generic project mutation stays banned', async () => {
    const h = await setup();
    const { guest } = await h.shareWithGuestAdmin('locked', 'Locked');

    const enable = await h.request(
      '/api/projects/locked/access/enable',
      guest({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ localProjectId: 'whatever' }),
      }),
    );
    expect(enable.status).toBe(403);

    const mutate = await h.request(
      '/api/projects/locked',
      guest({
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed by guest' }),
      }),
    );
    expect(mutate.status).toBe(403);

    const nested = await h.request(
      '/api/projects/locked/access/nope',
      guest({ method: 'POST', body: '{}' }),
    );
    expect(nested.status).toBe(403);

    // A non-owner admin cannot transfer ownership either.
    const transfer = await h.request(
      '/api/projects/locked/access/transfer',
      guest({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: (
            await readJson<{ data: { scope: unknown } }>(
              await h.request('/api/projects/locked/access', guest()),
            )
          ).data.scope,
          recipientId: 'human:deployment:does-not-matter',
        }),
      }),
    );
    expect(transfer.status).toBe(403);
  });

  // Epic #2323 S2 (owner decision: any Project member may author a plugin).
  // Two layers, each proven on its own:
  // - the ACCOUNT-BOUND device surface (#488) keeps its route allowlist, which
  //   does not include the scaffold, so a bound kiosk is refused there;
  // - behind it, the Project guard bans member mutations except this one
  //   exact leaf, so a member session (a deployment-account session over a
  //   non-bound credential, the shape `ownerHeaders` uses) may scaffold into
  //   the Project's empty folder and nothing else.
  test('plugin scaffold: a member may scaffold an empty Project folder and nothing else; a non-member writes nothing', async () => {
    const h = await setup();
    const { guest } = await h.shareWithGuestAdmin('authoring', 'Authoring');
    const folder = h.projectService.getProject('authoring').workingDirectory!;
    expect(folder).toBeTruthy();
    const person =
      (cookie: string) =>
      (extra?: RequestInit): RequestInit => ({
        ...extra,
        headers: {
          ...((extra?.headers as Record<string, string>) ?? {}),
          Authorization: `Bearer ${h.operatorCredential}`,
          Cookie: cookie,
          Origin: ORIGIN,
        },
      });
    const member = person('fixture_account=guest');
    const outsider = person('fixture_account=peer');
    const scaffold = (
      headers: (extra?: RequestInit) => RequestInit,
      name: string,
      path = '/api/projects/authoring/plugin-scaffold',
    ) =>
      h.request(
        path,
        headers({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        }),
      );

    // Layer 1: the bound kiosk surface is unchanged.
    const byKiosk = await scaffold(guest, 'kiosk-plugin');
    expect(byKiosk.status).toBe(403);
    expect(await readJson(byKiosk)).toEqual({
      error: { code: 'account_bound_device_route_forbidden' },
    });

    // A signed-in account that is not a member: the Project does not exist
    // for it, and nothing is written.
    const byOutsider = await scaffold(outsider, 'outsider-plugin');
    expect(byOutsider.status).toBe(404);
    // I4: the read twin is guarded the same way; a non-member learns
    // nothing about the folder, not even whether it is empty.
    const outsiderEligibility = await h.request(
      '/api/projects/authoring/plugin-scaffold',
      outsider(),
    );
    expect(outsiderEligibility.status).toBe(404);
    expect(await outsiderEligibility.text()).not.toContain('eligible');
    expect(existsSync(join(folder, 'plugin.json'))).toBe(false);

    // Layer 2: the guard lets a member through this exact leaf only.
    for (const path of [
      '/api/projects/authoring/plugin-scaffold/',
      '/api/projects/authoring/plugin-scaffold/extra',
      '/api/projects/authoring/plugin-scaffold%2Fextra',
    ]) {
      const sibling = await scaffold(member, 'sibling-plugin', path);
      expect(sibling.status, path).toBe(403);
      expect(await readJson(sibling), path).toEqual({
        success: false,
        error: 'Project mutation is forbidden',
      });
    }
    const rename = await h.request(
      '/api/projects/authoring',
      member({
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed by member' }),
      }),
    );
    expect(rename.status).toBe(403);
    expect(existsSync(join(folder, 'plugin.json'))).toBe(false);

    // A member may read eligibility, then scaffold the empty folder.
    const eligible = await h.request(
      '/api/projects/authoring/plugin-scaffold',
      member(),
    );
    expect(eligible.status, await eligible.clone().text()).toBe(200);
    expect(
      (await readJson<{ data: { eligible: boolean } }>(eligible)).data,
    ).toEqual({ eligible: true });
    const byMember = await scaffold(member, 'member-plugin');
    expect(byMember.status, await byMember.clone().text()).toBe(201);
    expect(existsSync(join(folder, 'plugin.json'))).toBe(true);

    // The folder is no longer empty: a member cannot scaffold over it.
    // Put something of the operator's own in the folder too.
    writeFileSync(join(folder, 'operator-notes.md'), 'private');
    const again = await scaffold(member, 'another-plugin');
    expect(again.status).toBe(409);
    const refusal = await readJson<Record<string, unknown>>(again);
    expect(refusal.code).toBe('working-directory-not-empty');
    // D1: the refusal counts what is there and names none of it.
    expect(refusal.entryCount).toBeGreaterThan(1);
    expect(refusal).not.toHaveProperty('entries');
    expect(refusal).not.toHaveProperty('present');
    const text = JSON.stringify(refusal);
    for (const name of ['operator-notes.md', 'plugin.json', 'README.md', 'src'])
      expect(text, name).not.toContain(name);
    expect(
      JSON.parse(readFileSync(join(folder, 'plugin.json'), 'utf8')).name,
    ).toBe('member-plugin');
  });

  test('the member scaffold exemption matches exactly one leaf', () => {
    expect(
      isProjectMemberPluginScaffold('POST', '/api/projects/a/plugin-scaffold'),
    ).toBe(true);
    for (const [method, path] of [
      ['GET', '/api/projects/a/plugin-scaffold'],
      ['PUT', '/api/projects/a/plugin-scaffold'],
      ['POST', '/api/projects/a/plugin-scaffold/'],
      ['POST', '/api/projects/a/plugin-scaffold/x'],
      ['POST', '/api/projects/a/b/plugin-scaffold'],
      ['POST', '/api/projects//plugin-scaffold'],
      ['POST', '/api/projects/a/plugin-scaffolds'],
      ['POST', '/api/projects/a/Plugin-Scaffold'],
      ['POST', '/prefix/api/projects/a/plugin-scaffold'],
      ['POST', '/api/projects/a/plugin-scaffold?x=/'],
      ['POST', '/api/projects/a'],
    ] as const) {
      expect(
        isProjectMemberPluginScaffold(method, path),
        `${method} ${path}`,
      ).toBe(false);
    }
  });

  test('plugin scaffold: a member cannot scaffold a Project they do not belong to', async () => {
    const h = await setup();
    await h.shareWithGuestAdmin('shared', 'Shared');
    const other = await h.projectService.createProject({
      name: 'Private',
      slug: 'private',
    });
    const folder = other.workingDirectory!;
    const response = await h.request('/api/projects/private/plugin-scaffold', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${h.operatorCredential}`,
        Cookie: 'fixture_account=guest',
        Origin: ORIGIN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'intruder' }),
    });
    expect(response.status).toBe(404);
    expect(existsSync(join(folder, 'plugin.json'))).toBe(false);
    // I4: nor may they ask whether that Project's folder is empty.
    const eligibility = await h.request(
      '/api/projects/private/plugin-scaffold',
      {
        headers: {
          Authorization: `Bearer ${h.operatorCredential}`,
          Cookie: 'fixture_account=guest',
          Origin: ORIGIN,
        },
      },
    );
    expect(eligibility.status).toBe(404);
    expect(await eligibility.text()).not.toContain('eligible');
  });
  // Epic #2323 S3 (owner decision: any Project member may preview a plugin
  // draft). The Project read guard bans member mutations; starting a draft
  // lease is the one exact POST it lets a member through, because the lease
  // writes only host-owned storage. A non-member is refused before any draft
  // handler runs, so nothing is leased, watched, or built for them.
  //
  // The person is presented here as a deployment-account session over a
  // non-account-bound credential (the same shape `ownerHeaders` uses). An
  // ACCOUNT-BOUND device is a separate, stricter surface (#488): its route
  // allowlist does not include draft preview at all, and this slice does not
  // widen it — asserted last.
  test('plugin draft preview: a member may lease and read; a non-member is refused and starts nothing', async () => {
    const h = await setup();
    const folder = join(directories[directories.length - 1], 'draft-folder');
    mkdirSync(folder);
    const { guest } = await h.shareWithGuestAdmin('drafts', 'Drafts', folder);
    const person =
      (cookie: string) =>
      (extra?: RequestInit): RequestInit => ({
        ...extra,
        headers: {
          ...(extra?.headers ?? {}),
          Authorization: `Bearer ${h.operatorCredential}`,
          Cookie: cookie,
          Origin: ORIGIN,
        },
      });
    const member = person('fixture_account=guest');
    const outsider = person('fixture_account=peer');

    for (const [method, path] of [
      ['POST', '/api/projects/drafts/plugin-draft/lease'],
      ['GET', '/api/projects/drafts/plugin-draft'],
      [
        'GET',
        `/api/projects/drafts/plugin-draft/generations/1/${'0'.repeat(32)}/bundle.js`,
      ],
    ] as const) {
      const refused = await h.request(path, outsider({ method }));
      expect(refused.status, `${method} ${path}`).toBe(404);
      expect(await refused.text()).not.toContain('plugin-draft');
    }
    // The outsider's lease never reached the draft service.
    const idle = await h.request('/api/projects/drafts/plugin-draft', member());
    expect(idle.status, await idle.clone().text()).toBe(200);
    expect((await readJson<{ state: string }>(idle)).state).toBe('idle');

    const leased = await h.request(
      '/api/projects/drafts/plugin-draft/lease',
      member({ method: 'POST' }),
    );
    expect(leased.status, await leased.clone().text()).toBe(200);
    expect((await readJson<{ state: string }>(leased)).state).not.toBe('idle');

    // The exemption is that one leaf, not the draft family or the Project.
    const sibling = await h.request(
      '/api/projects/drafts/plugin-draft/lease/extra',
      member({ method: 'POST' }),
    );
    expect(sibling.status).toBe(403);
    const rename = await h.request(
      '/api/projects/drafts',
      member({
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed by member' }),
      }),
    );
    expect(rename.status).toBe(403);

    // The restricted account-bound device surface is unchanged.
    const bound = await h.request('/api/projects/drafts/plugin-draft', guest());
    expect(bound.status).toBe(403);
  });

  // S3 verifier G9: the member exemption is exactly POST on the lease leaf.
  test('the member draft-lease exemption admits only POST on the exact leaf', () => {
    const lease = '/api/projects/drafts/plugin-draft/lease';
    expect(isProjectMemberDraftLease('POST', lease)).toBe(true);
    for (const method of ['DELETE', 'PUT', 'PATCH', 'GET'])
      expect(isProjectMemberDraftLease(method, lease), method).toBe(false);
    for (const path of [
      '/api/projects/drafts/plugin-draft',
      '/api/projects/drafts/plugin-draft/lease/extra',
      '/api/projects/drafts/x/plugin-draft/lease',
      '/api/projects//plugin-draft/lease',
    ])
      expect(isProjectMemberDraftLease('POST', path), path).toBe(false);
  });

  // S3 verifier G4: the production /events gate for plugin-draft revisions.
  // A subscriber that cannot read the Project never receives its revision
  // events; a member does. Malformed payloads and a membership read that
  // throws are denied, never relayed.
  test('plugin draft revision events reach Project members only', async () => {
    const h = await setup();
    await h.shareWithGuestAdmin('drafts', 'Drafts');
    const person = (cookie: string): RequestInit => ({
      headers: {
        Authorization: `Bearer ${h.operatorCredential}`,
        Cookie: cookie,
        Origin: ORIGIN,
      },
    });
    const subscribe = async (cookie: string) => {
      const res = await h.request('/events', person(cookie));
      // Never read an SSE body to its end here: it does not end.
      expect(res.status).toBe(200);
      return res;
    };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
    const read = (res: Response) =>
      readStreamUntil(res.body!, (text) => text.includes('"marker":"after"'));

    const member = await subscribe('fixture_account=guest');
    const outsider = await subscribe('fixture_account=peer');
    await settle();
    h.eventBus.emit(SERVER_EVENTS.PLUGIN_DRAFTS_REBUILT, {
      projectSlug: 'drafts',
      draftId: 'draft_member_probe',
      generation: 1,
    });
    h.eventBus.emit(SERVER_EVENTS.PLUGIN_DRAFTS_REBUILT, {
      projectSlug: '',
      draftId: 'draft_empty_probe',
      generation: 1,
    });
    h.eventBus.emit(SERVER_EVENTS.PLUGIN_DRAFTS_REBUILT, {
      draftId: 'draft_missing_probe',
      generation: 1,
    });
    await settle();
    h.eventBus.emit(SERVER_EVENTS.CONFIG_CHANGED, { marker: 'after' });
    const [memberStream, outsiderStream] = await Promise.all([
      read(member),
      read(outsider),
    ]);
    expect(memberStream).toContain('draft_member_probe');
    expect(outsiderStream).toContain('"marker":"after"');
    expect(outsiderStream).not.toContain('plugin-drafts:rebuilt');
    expect(outsiderStream).not.toContain('draft_member_probe');
    for (const stream of [memberStream, outsiderStream]) {
      expect(stream).not.toContain('draft_empty_probe');
      expect(stream).not.toContain('draft_missing_probe');
    }

    // A membership read that fails is a denial, not a relay.
    const failing = vi
      .spyOn(h.membership.service, 'requireProjectRead')
      .mockRejectedValue(new Error('membership store unreadable'));
    const second = await subscribe('fixture_account=guest');
    await settle();
    h.eventBus.emit(SERVER_EVENTS.PLUGIN_DRAFTS_REBUILT, {
      projectSlug: 'drafts',
      draftId: 'draft_throw_probe',
      generation: 2,
    });
    await settle();
    h.eventBus.emit(SERVER_EVENTS.CONFIG_CHANGED, { marker: 'after' });
    const secondStream = await read(second);
    expect(failing).toHaveBeenCalled();
    expect(secondStream).not.toContain('draft_throw_probe');
    failing.mockRestore();
  });

  test('read-only rescope over the operator endpoint: GET yes, POST no; read+operate restores POST', async () => {
    const h = await setup();
    const { scope, credential, guest } = await h.shareWithGuestAdmin(
      'scoped',
      'Scoped',
    );
    const deviceId = h.security.devicePairing.identifyDevice(credential)?.id;
    expect(deviceId).toBeTruthy();

    const rescope = (scopeTokens: string[]) =>
      h.request(
        `/api/pairing/devices/${deviceId}/scope`,
        h.operatorHeaders({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scope: scopeTokens }),
        }),
      );

    // Baseline: the grant is exactly read+operate — no terminal, no
    // access:manage. Never the `standard` preset for guest management.
    expect(h.security.devicePairing.identifyDevice(credential)?.scope).toBe(
      GUEST_GRANT,
    );

    // Operator narrows to read-only through the existing HTTP endpoint.
    const narrowed = await rescope(['orchestration:read']);
    expect(narrowed.status, await narrowed.clone().text()).toBe(200);
    expect(
      (await h.request('/api/projects/scoped/access', guest())).status,
    ).toBe(200);
    expect(
      (
        await h.request(
          '/api/projects/scoped/access/invitations',
          guest({
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              scope,
              email: null,
              role: 'viewer',
              expiresAt: new Date(Date.now() + 3600_000).toISOString(),
            }),
          }),
        )
      ).status,
    ).toBe(403);

    // Operator restores the explicit read+operate grant: POST works again.
    const restored = await rescope(GUEST_GRANT.split(' '));
    expect(restored.status, await restored.clone().text()).toBe(200);
    expect(
      (
        await h.request(
          '/api/projects/scoped/access/invitations',
          guest({
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              scope,
              email: null,
              role: 'viewer',
              expiresAt: new Date(Date.now() + 3600_000).toISOString(),
            }),
          }),
        )
      ).status,
    ).toBe(200);
  });

  test('terminal, pairing-management, private, and nested-admin surfaces stay denied', async () => {
    const h = await setup();
    const { credential, guest } = await h.shareWithGuestAdmin('open', 'Open');
    const deviceId = h.security.devicePairing.identifyDevice(credential)?.id;
    expect(deviceId).toBeTruthy();
    // A project the guest was never admitted to stays invisible.
    await h.projectService.createProject({ name: 'Private', slug: 'other' });

    const terminal = await h.request(
      '/api/projects/open/terminals/terminal-nope',
      guest({ method: 'DELETE' }),
    );
    // `terminal:operate` is not in the guest grant: the pairing-scope
    // middleware refuses before any handler runs.
    expect(terminal.status).toBe(403);
    expect(await terminal.json()).toEqual({
      error: { code: 'insufficient_scope' },
    });

    // Pairing/device management stays operator-only at the first boundary
    // (archive#1887). This live device is not admitted to `/api/pairing*`,
    // so runtime-http answers 403 `insufficient_scope` before the
    // pairing-scope middleware or handler is reached. The browser keeps the
    // live session instead of treating the denial as expired credentials.
    const pairingAdmin = await h.request(
      '/api/pairing/offers',
      guest({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: ORIGIN }),
      }),
    );
    expect(pairingAdmin.status, await pairingAdmin.clone().text()).toBe(403);
    expect(await pairingAdmin.json()).toEqual({
      error: { code: 'insufficient_scope' },
    });

    // The guest cannot escalate its own grant through the operator
    // rescope endpoint either.
    const selfEscalation = await h.request(
      `/api/pairing/devices/${deviceId}/scope`,
      guest({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: ['orchestration:read'] }),
      }),
    );
    expect(selfEscalation.status, await selfEscalation.clone().text()).toBe(
      403,
    );
    expect(await selfEscalation.json()).toEqual({
      error: { code: 'insufficient_scope' },
    });

    // Operator accounts require `access:manage`: the pairing-scope
    // middleware refuses with 403 before the handler is reached.
    const operatorAccounts = await h.request('/api/operator/accounts', guest());
    expect(operatorAccounts.status, await operatorAccounts.clone().text()).toBe(
      403,
    );
    expect(await operatorAccounts.json()).toEqual({
      error: { code: 'insufficient_scope' },
    });

    const privateRead = await h.request('/api/projects/other', guest());
    expect(privateRead.status).toBe(404);
  });

  test('viewer and contributor are denied administration despite operate scope; downgrade is immediate', async () => {
    const h = await setup();
    const { scope, guest } = await h.shareWithGuestAdmin('roles', 'Roles');
    const guestId = deploymentAccountPrincipal(
      PROVIDER_ISSUER,
      GUEST_SUBJECT,
      'Guest Person',
    ).id;
    const inviteBody = {
      scope,
      email: null,
      role: 'viewer',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    } as const;
    const invite = () =>
      h.request(
        '/api/projects/roles/access/invitations',
        guest({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(inviteBody),
        }),
      );

    for (const role of ['viewer', 'contributor'] as const) {
      const member = (
        await readJson<{
          data: { members: { principal: { id: string }; revision: number }[] };
        }>(await h.request('/api/projects/roles/access', h.ownerHeaders()))
      ).data.members.find((entry) => entry.principal.id === guestId)!;
      const demoted = await h.request(
        '/api/projects/roles/access/members',
        h.ownerHeaders({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            scope,
            principalId: guestId,
            revision: member.revision,
            role,
            status: 'active',
          }),
        }),
      );
      expect(demoted.status, await demoted.clone().text()).toBe(200);
      // The very next request is refused: downgrade is immediate.
      expect((await invite()).status).toBe(403);
      expect(
        (await h.request('/api/projects/roles/access', guest())).status,
      ).toBe(403);
      // ...while the Project read itself still answers: both roles
      // retain `view`, only `manage-members` is gone.
      const read = await h.request('/api/projects/roles', guest());
      expect(read.status).toBe(200);
    }
  });

  test('stale revisions and wrong-project scopes conflict', async () => {
    const h = await setup();
    const { scope, guest } = await h.shareWithGuestAdmin('edgy', 'Edgy');
    const guestId = deploymentAccountPrincipal(
      PROVIDER_ISSUER,
      GUEST_SUBJECT,
      'Guest Person',
    ).id;

    const stale = await h.request(
      '/api/projects/edgy/access/members',
      guest({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope,
          principalId: guestId,
          revision: 9999,
          role: 'viewer',
          status: 'active',
        }),
      }),
    );
    expect(stale.status).toBe(409);

    const wrongProject = await h.request(
      '/api/projects/edgy/access/invitations',
      guest({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: { ...(scope as object), localProjectSlug: 'elsewhere' },
          email: null,
          role: 'viewer',
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        }),
      }),
    );
    expect(wrongProject.status).toBe(409);
  });

  test('member revocation is immediate; credential and account revocation fail closed independently', async () => {
    const h = await setup();
    const { scope, guest } = await h.shareWithGuestAdmin('revoke', 'Revoke');
    const guestId = deploymentAccountPrincipal(
      PROVIDER_ISSUER,
      GUEST_SUBJECT,
      'Guest Person',
    ).id;

    // Independent credential revocation fails closed first: the device
    // credential stops authenticating entirely.
    const second = h.pairAccountBound('revoke-spare', GUEST_GRANT);
    const spare = h.guestHeaders(second.credential);
    expect(
      (await h.request('/api/projects/revoke/access', spare())).status,
    ).toBe(200);
    h.security.devicePairing.revokeDevice(
      second.device.id,
      'operator-credential',
    );
    expect(
      (await h.request('/api/projects/revoke/access', spare())).status,
    ).toBe(401);

    // Member revocation: the next admin read and the next project read
    // both refuse, while the untouched first device still administers
    // until its own membership ends.
    const member = (
      await readJson<{
        data: { members: { principal: { id: string }; revision: number }[] };
      }>(await h.request('/api/projects/revoke/access', h.ownerHeaders()))
    ).data.members.find((entry) => entry.principal.id === guestId)!;
    const removed = await h.request(
      '/api/projects/revoke/access/members',
      h.ownerHeaders({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope,
          principalId: guestId,
          revision: member.revision,
          role: 'viewer',
          status: 'revoked',
        }),
      }),
    );
    expect(removed.status, await removed.clone().text()).toBe(200);
    expect(
      (await h.request('/api/projects/revoke/access', guest())).status,
    ).toBe(403);
    expect((await h.request('/api/projects/revoke', guest())).status).toBe(404);

    // Independent account revocation (logout) fails the deployment
    // tier closed even for an otherwise valid device credential.
    const logout = await h.request(
      '/api/account-auth/logout',
      guest({ method: 'POST', headers: { Origin: ORIGIN } }),
    );
    expect(logout.status).toBe(200);
    expect(
      (await h.request('/api/projects/revoke/access', guest())).status,
    ).toBe(401);
  });

  test('revoked invitations cannot be accepted or previewed', async () => {
    const h = await setup();
    const { scope, guest } = await h.shareWithGuestAdmin('token', 'Token');
    const invited = await h.request(
      '/api/projects/token/access/invitations',
      guest({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope,
          email: null,
          role: 'viewer',
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        }),
      }),
    );
    expect(invited.status).toBe(200);
    const { token, invitation } = (
      await readJson<{ data: { token: string; invitation: { id: string } } }>(
        invited,
      )
    ).data;
    const revoked = await h.request(
      `/api/projects/token/access/invitations/${invitation.id}/revoke`,
      guest({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope }),
      }),
    );
    expect(revoked.status).toBe(200);
    const preview = await h.request(
      '/api/account-auth/invitation-preview',
      guest({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      }),
    );
    expect(preview.status).toBe(409);
    const accept = await h.request(
      '/api/account-auth/accept-invitation',
      guest({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      }),
    );
    expect(accept.status).toBe(409);
  });

  test('delayed delivery across device rescope: read body still delivers, operate body denied', async () => {
    const h = await setup();
    const { scope, credential, guest } = await h.shareWithGuestAdmin(
      'rescope-delay',
      'Rescope Delay',
    );
    const deviceId = h.security.devicePairing.identifyDevice(credential)?.id;
    expect(deviceId).toBeTruthy();
    const inviteBody = JSON.stringify({
      scope,
      email: null,
      role: 'viewer',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });

    // Both responses are admitted while the explicit read+operate grant
    // holds; neither body is consumed or cloned yet (cloning would pull).
    const access = await h.request(
      '/api/projects/rescope-delay/access',
      guest(),
    );
    expect(access.status).toBe(200);
    const invited = await h.request(
      '/api/projects/rescope-delay/access/invitations',
      guest({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: inviteBody,
      }),
    );
    expect(invited.status).toBe(200);

    // Operator narrows the SAME device to read-only via the existing
    // endpoint; the guest principal and account session are untouched.
    const narrowed = await h.request(
      `/api/pairing/devices/${deviceId}/scope`,
      h.operatorHeaders({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: ['orchestration:read'] }),
      }),
    );
    expect(narrowed.status).toBe(200);

    // Fresh credential comparison after the final await: same device, same
    // principal, now read-only.
    expect(h.security.devicePairing.identifyDevice(credential)?.scope).toBe(
      'orchestration:read',
    );

    // Positive control, same person: the read-capability admin view still
    // delivers its member bytes — nothing about this principal changed.
    const view = (await access.json()) as {
      success: boolean;
      data: { members: unknown[] };
    };
    expect(view.success).toBe(true);
    expect(view.data.members.length).toBeGreaterThanOrEqual(2);

    // The operate-capability token body is denied: production `current()`
    // re-resolves `isRuntimeRequestPrincipalCurrent` per check, and the
    // read-only grant no longer includes the POST invitations scope.
    expectDeliveryDenied(await drainGuardedBody(invited));

    // Fresh requests agree: GET still 200, POST now middleware-403.
    expect(
      (await h.request('/api/projects/rescope-delay/access', guest())).status,
    ).toBe(200);
    expect(
      (
        await h.request(
          '/api/projects/rescope-delay/access/invitations',
          guest({
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: inviteBody,
          }),
        )
      ).status,
    ).toBe(403);
  });

  test('delayed delivery across device revocation: admin-view and token bodies denied with zero bytes', async () => {
    const h = await setup();
    const { scope, credential, guest } = await h.shareWithGuestAdmin(
      'revoke-delay',
      'Revoke Delay',
    );
    const deviceId = h.security.devicePairing.identifyDevice(credential)?.id;
    expect(deviceId).toBeTruthy();

    const access = await h.request(
      '/api/projects/revoke-delay/access',
      guest(),
    );
    expect(access.status).toBe(200);
    const invited = await h.request(
      '/api/projects/revoke-delay/access/invitations',
      guest({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope,
          email: null,
          role: 'viewer',
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        }),
      }),
    );
    expect(invited.status).toBe(200);

    // Independent device revocation lands before either body is read; the
    // membership record and the account session are untouched.
    h.security.devicePairing.revokeDevice(deviceId!, 'operator-credential');

    // Fresh credential comparison: the credential no longer identifies an
    // active device.
    expect(h.security.devicePairing.identifyDevice(credential)).toBeNull();

    // Both queued bodies deny with zero bytes — never a 500, never member
    // or token content.
    const deniedAccess = await drainGuardedBody(access);
    expectDeliveryDenied(deniedAccess);
    expect(deniedAccess.bytes.toString('utf8')).not.toContain('members');
    const deniedInvite = await drainGuardedBody(invited);
    expectDeliveryDenied(deniedInvite);
    expect(deniedInvite.bytes.toString('utf8')).not.toContain('token');

    // Fresh requests agree: the dead credential fails closed at 401.
    expect(
      (await h.request('/api/projects/revoke-delay/access', guest())).status,
    ).toBe(401);
  });

  test('delayed delivery across account logout: admin-view and token bodies denied with zero bytes', async () => {
    const h = await setup();
    const { scope, credential, guest } = await h.shareWithGuestAdmin(
      'logout-delay',
      'Logout Delay',
    );

    const access = await h.request(
      '/api/projects/logout-delay/access',
      guest(),
    );
    expect(access.status).toBe(200);
    const invited = await h.request(
      '/api/projects/logout-delay/access/invitations',
      guest({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope,
          email: null,
          role: 'viewer',
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        }),
      }),
    );
    expect(invited.status).toBe(200);

    // Independent account revocation (logout) lands before either body is
    // read; the device credential and the membership record are untouched.
    const logout = await h.request(
      '/api/account-auth/logout',
      guest({ method: 'POST', headers: { Origin: ORIGIN } }),
    );
    expect(logout.status).toBe(200);

    // Fresh credential comparison: the device still identifies (revocation
    // was account-level, not device-level) with its grant intact.
    expect(h.security.devicePairing.identifyDevice(credential)?.scope).toBe(
      GUEST_GRANT,
    );

    // Both queued bodies deny with zero bytes: production `current()`
    // re-authenticates per check and the logged-out account is invalid.
    const deniedAccess = await drainGuardedBody(access);
    expectDeliveryDenied(deniedAccess);
    expect(deniedAccess.bytes.toString('utf8')).not.toContain('members');
    const deniedInvite = await drainGuardedBody(invited);
    expectDeliveryDenied(deniedInvite);
    expect(deniedInvite.bytes.toString('utf8')).not.toContain('token');

    // Fresh requests agree: the revoked account fails closed at 401 even
    // for an otherwise valid device credential.
    expect(
      (await h.request('/api/projects/logout-delay/access', guest())).status,
    ).toBe(401);
  });

  test('substituted account credentials cannot commit a stale page intent: exact denial, zero effects', async () => {
    // The concrete UI race: a page rendered as A has both HttpOnly cookies
    // replaced by B in another window between its authority read and its
    // POST. B is independently an admin of the same Project with its own
    // bound read+operate device — the substitution is validly authenticated
    // as B, so only the caller-captured expected actor can stop A's stale
    // intent from committing as B. No client authority key can observe
    // HttpOnly cookie replacement; the comparison below is server-enforced
    // against freshly authenticated authority, never authority granted by
    // the client claim.
    const h = await setup();
    const { scope, guest } = await h.shareWithGuestAdmin('actor', 'Actor');
    const guestId = deploymentAccountPrincipal(
      PROVIDER_ISSUER,
      GUEST_SUBJECT,
      'Guest Person',
    ).id;
    const peerId = deploymentAccountPrincipal(
      PROVIDER_ISSUER,
      PEER_SUBJECT,
      'Guest Person',
    ).id;

    // A second independent admin: owner invites the peer account, which
    // accepts over the real route and pairs its own bound device.
    const invitedPeer = await h.request(
      '/api/projects/actor/access/invitations',
      h.ownerHeaders({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope,
          email: null,
          role: 'admin',
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        }),
      }),
    );
    expect(invitedPeer.status, await invitedPeer.clone().text()).toBe(200);
    const peerToken = (await readJson<{ data: { token: string } }>(invitedPeer))
      .data.token;
    const peerPairing = h.pairAccountBound(
      'actor-peer',
      GUEST_GRANT,
      PEER_SUBJECT,
    );
    const peer = h.guestHeaders(peerPairing.credential, 'fixture_account=peer');
    const peerAccepted = await h.request(
      '/api/account-auth/accept-invitation',
      peer({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: peerToken }),
      }),
    );
    expect(peerAccepted.status, await peerAccepted.clone().text()).toBe(200);

    // A's captured page state: the exact scope and acting principal from a
    // successful administration read, plus the current member revisions.
    const readView = async () =>
      readJson<{
        data: {
          scope: unknown;
          actingPrincipal: { id: string };
          members: { principal: { id: string }; revision: number }[];
          invitations: unknown[];
        };
      }>(await h.request('/api/projects/actor/access', guest()));
    const before = (await readView()).data;
    expect(before.actingPrincipal.id).toBe(guestId);

    const inviteBody = (expectedActor: string) =>
      JSON.stringify({
        scope,
        email: null,
        role: 'viewer',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        expectedActor,
      });

    // B's credentials submit A's captured actor: exact denial, and the
    // denial body carries no token bytes.
    const substituted = await h.request(
      '/api/projects/actor/access/invitations',
      peer({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: inviteBody(guestId),
      }),
    );
    expect(substituted.status).toBe(403);
    expect(await substituted.clone().json()).toEqual({
      error: { code: 'project_access_forbidden' },
    });
    expect(await substituted.text()).not.toContain('token');

    // Zero committed effects: the invitation inventory and every member
    // revision read back unchanged through A's own authority.
    const afterInvite = (await readView()).data;
    expect(afterInvite.invitations).toEqual(before.invitations);
    expect(afterInvite.members).toEqual(before.members);

    // Same substitution against the member-mutation leaf: exact denial and
    // the target revision untouched.
    const substitutedChange = await h.request(
      '/api/projects/actor/access/members',
      peer({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope,
          principalId: peerId,
          revision: 1,
          role: 'viewer',
          status: 'active',
          expectedActor: guestId,
        }),
      }),
    );
    expect(substitutedChange.status).toBe(403);
    expect(await substitutedChange.json()).toEqual({
      error: { code: 'project_access_forbidden' },
    });
    const afterChange = (await readView()).data;
    expect(afterChange.members).toEqual(before.members);

    // Positive control, same person: B's own captured actor commits, then
    // B revokes its own invitation — the precondition never blocks the
    // principal it was rendered for.
    const ownInvite = await h.request(
      '/api/projects/actor/access/invitations',
      peer({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: inviteBody(peerId),
      }),
    );
    expect(ownInvite.status, await ownInvite.clone().text()).toBe(200);
    const ownInvitation = (
      await readJson<{ data: { invitation: { id: string } } }>(ownInvite)
    ).data.invitation;
    const ownRevoke = await h.request(
      `/api/projects/actor/access/invitations/${ownInvitation.id}/revoke`,
      peer({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope, expectedActor: peerId }),
      }),
    );
    expect(ownRevoke.status, await ownRevoke.clone().text()).toBe(200);

    // Operator compatibility: existing callers that omit the precondition
    // keep working unchanged.
    const legacyInvite = await h.request(
      '/api/projects/actor/access/invitations',
      h.ownerHeaders({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope,
          email: null,
          role: 'viewer',
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        }),
      }),
    );
    expect(legacyInvite.status, await legacyInvite.clone().text()).toBe(200);
  });
  test('S3 source reads use Project membership while profile selection and attachment remain operator-only', async () => {
    vi.stubEnv('STATION_EXPERIMENTAL_S3_SOURCES', '1');
    try {
      const h = await setup();
      const { scope, guest } = await h.shareWithGuestAdmin(
        'archive',
        'Archive',
      );
      const privateProject = await h.projectService.createProject({
        name: 'Private archive',
        slug: 'private-archive',
      });
      const rootPath = '/api/knowledge/s3-sources/projects/archive';
      const input = {
        id: crypto.randomUUID(),
        expectedProjectId: scope.localProjectId,
        displayName: 'Archive fixture',
        accountId: '123456789012',
        region: 'us-west-2',
        bucket: 'fixture-archive',
        prefix: 'selected/',
        profile: 'fixture-only',
        shareWithProject: true,
      };
      const attach = (
        path: string,
        value: unknown,
        headers: typeof h.operatorHeaders,
      ) =>
        h.request(
          path,
          headers({
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(value),
          }),
        );
      const created = await attach(rootPath, input, h.operatorHeaders);
      expect(created.status, await created.clone().text()).toBe(200);
      const source = (
        await readJson<{ data: { id: string; projectId: string } }>(created)
      ).data;
      const listing = await h.request(rootPath, guest());
      expect(listing.status, await listing.clone().text()).toBe(200);
      expect(await listing.text()).not.toContain('fixture-only');
      expect(
        (await h.request('/api/knowledge/s3-sources/profiles', guest())).status,
      ).toBe(403);
      expect(
        (await attach(rootPath, { ...input, id: crypto.randomUUID() }, guest))
          .status,
      ).toBe(403);
      expect(
        (
          await attach(
            '/api/knowledge/s3-sources/projects/private-archive',
            {
              ...input,
              id: crypto.randomUUID(),
              expectedProjectId: privateProject.id,
            },
            h.operatorHeaders,
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await h.request(
            '/api/knowledge/s3-sources/projects/private-archive',
            guest(),
          )
        ).status,
      ).toBe(404);
      const send = vi
        .spyOn(S3Client.prototype, 'send')
        .mockImplementation(async () => ({
          Contents: [{ Key: 'selected/note.md', ETag: '"etag"', Size: 5 }],
          IsTruncated: false,
        }));
      const page = await h.request(`${rootPath}/${source.id}/objects`, guest());
      expect(page.status, await page.clone().text()).toBe(200);
      expect(send).toHaveBeenCalledTimes(1);
      expect(
        (
          await attach(
            `${rootPath}/${source.id}/disconnect`,
            { expectedSource: source },
            guest,
          )
        ).status,
      ).toBe(403);
      vi.stubEnv('STATION_EXPERIMENTAL_S3_SOURCES', '');
      expect(
        (await h.request(`${rootPath}/${source.id}/objects`, guest())).status,
      ).toBe(404);
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });
  test('knowledge roots and records enforce the account Project membership through real ingress', async () => {
    const h = await setup();
    const { scope, guest } = await h.shareWithGuestAdmin(
      'knowledge',
      'Knowledge',
    );
    const allowed = await h.knowledgeStoreProvider.createRoot({
      scope: { kind: 'project', projectSlug: 'knowledge' },
      adapterId: 'kit-default-store',
      storeRoot: join(directories[directories.length - 1], 'shared-notes'),
      displayName: 'Shared notes',
      projectId: scope.localProjectId,
    });
    const unrelated = await h.knowledgeStoreProvider.createRoot({
      scope: { kind: 'project', projectSlug: 'unrelated' },
      adapterId: 'kit-default-store',
      storeRoot: join(directories[directories.length - 1], 'private-notes'),
      displayName: 'Private notes',
    });
    const personal = await h.knowledgeStoreProvider.createRoot({
      scope: { kind: 'personal' },
      adapterId: 'kit-default-store',
      storeRoot: join(directories[directories.length - 1], 'personal-notes'),
      displayName: 'Personal notes',
    });
    const obsolete = await h.knowledgeStoreProvider.createRoot({
      scope: { kind: 'project', projectSlug: 'knowledge' },
      projectId: '11111111-1111-4111-8111-111111111111',
      adapterId: 'kit-default-store',
      storeRoot: join(
        directories[directories.length - 1],
        'former-project-notes',
      ),
      displayName: 'Former Project notes',
    });
    const unbound = await h.knowledgeStoreProvider.createRoot({
      scope: { kind: 'project', projectSlug: 'knowledge' },
      adapterId: 'kit-default-store',
      storeRoot: join(directories[directories.length - 1], 'unbound-notes'),
      displayName: 'Unbound notes',
    });
    const adapter = await h.knowledgeStoreProvider.adapterFor(allowed.id);
    const recordId = await adapter.create({
      type: 'raw',
      title: 'Selected source',
      body: 'Exact shared text',
      category: 'test',
      provenance: { agent: 'fixture' },
    });
    const capabilities = await h.request(
      '/api/knowledge/capabilities',
      guest(),
    );
    expect(capabilities.status).toBe(200);
    expect((await readJson<{ data: unknown }>(capabilities)).data).toEqual({
      canManageSources: false,
      canAttachLegacy: false,
      canCheckHostPaths: false,
    });
    const operatorCapabilities = await h.request(
      '/api/knowledge/capabilities',
      h.operatorHeaders(),
    );
    expect(operatorCapabilities.status).toBe(200);
    expect(
      (await readJson<{ data: unknown }>(operatorCapabilities)).data,
    ).toEqual({
      canManageSources: true,
      canAttachLegacy: true,
      canCheckHostPaths: true,
    });
    const list = await h.request('/api/knowledge/roots', guest());
    expect(list.status, await list.clone().text()).toBe(200);
    const body = await readJson<{ data: { id: string }[] }>(list);
    expect(body.data.map((root) => root.id)).toEqual([allowed.id]);
    const importId = crypto.randomUUID();
    const originalText = '\ufeff\nExact shared original\r\n';
    const imported = await h.request(
      '/api/knowledge/document-imports',
      h.operatorHeaders({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestId: importId,
          expectedRoot: allowed,
          documents: [
            {
              filename: 'shared.md',
              contentBase64: Buffer.from(originalText).toString('base64'),
            },
          ],
        }),
      }),
    );
    expect(imported.status, await imported.clone().text()).toBe(200);
    const importPath = `/api/knowledge/roots/${encodeURIComponent(allowed.id)}/document-imports/${importId}`;
    expect((await h.request(importPath, guest())).status).toBe(403);
    const original = await h.request(`${importPath}/originals/0`, guest());
    expect(original.status, await original.clone().text()).toBe(200);
    expect(Buffer.from(await original.arrayBuffer())).toEqual(
      Buffer.from(originalText),
    );
    expect(
      (
        await h.request(
          `/api/knowledge/roots/${encodeURIComponent(unrelated.id)}/document-imports/${importId}/originals/0`,
          guest(),
        )
      ).status,
    ).toBe(404);
    const read = await h.request(
      `/api/knowledge/roots/${encodeURIComponent(allowed.id)}/records/${recordId}`,
      guest(),
    );
    expect(read.status, await read.clone().text()).toBe(200);
    expect((await readJson<{ data: { body: string } }>(read)).data.body).toBe(
      'Exact shared text',
    );
    for (const root of [unrelated, personal, obsolete, unbound]) {
      expect(
        (
          await h.request(
            `/api/knowledge/roots/${encodeURIComponent(root.id)}/graph`,
            guest(),
          )
        ).status,
      ).toBe(403);
    }
    const arbitrary = await h.request(
      '/api/knowledge/roots',
      guest({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: { kind: 'project', projectSlug: 'knowledge' },
          adapterId: 'kit-default-store',
          storeRoot: '/private/host-path',
        }),
      }),
    );
    expect(arbitrary.status, await arbitrary.clone().text()).toBe(403);

    const operatorManaged = await h.request(
      '/api/knowledge/roots',
      h.operatorHeaders({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: { kind: 'project', projectSlug: 'knowledge' },
          expectedProjectId: scope.localProjectId,
          adapterId: 'kit-default-store',
        }),
      }),
    );
    expect(operatorManaged.status, await operatorManaged.clone().text()).toBe(
      201,
    );
    const bound = (
      await readJson<{ data: { projectId: string; storeRoot: string } }>(
        operatorManaged,
      )
    ).data;
    expect(bound.projectId).toBe(scope.localProjectId);
    expect(bound.storeRoot).toContain(
      join('knowledge', 'projects', scope.localProjectId, 'store'),
    );
    const createManaged = () =>
      h.request(
        '/api/knowledge/roots',
        guest({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            scope: { kind: 'project', projectSlug: 'knowledge' },
            adapterId: 'kit-default-store',
          }),
        }),
      );
    const managed = await createManaged();
    expect(managed.status, await managed.clone().text()).toBe(403);
    const guestId = deploymentAccountPrincipal(
      PROVIDER_ISSUER,
      GUEST_SUBJECT,
      'Guest Person',
    ).id;
    const members = (
      await readJson<{
        data: { members: { principal: { id: string }; revision: number }[] };
      }>(await h.request('/api/projects/knowledge/access', h.ownerHeaders()))
    ).data.members;
    const member = members.find(
      (candidate) => candidate.principal.id === guestId,
    )!;
    const demoted = await h.request(
      '/api/projects/knowledge/access/members',
      h.ownerHeaders({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope,
          principalId: guestId,
          revision: member.revision,
          role: 'viewer',
          status: 'active',
        }),
      }),
    );
    expect(demoted.status, await demoted.clone().text()).toBe(200);
    expect((await createManaged()).status).toBe(403);
    const deniedDisconnect = await h.request(
      `/api/knowledge/roots/${encodeURIComponent(allowed.id)}/disconnect`,
      guest({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedRoot: allowed }),
      }),
    );
    expect(deniedDisconnect.status).toBe(403);
    expect(await h.knowledgeStoreProvider.getRoot(allowed.id)).toEqual(allowed);
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const listRecords = adapter.listByType.bind(adapter);
    vi.spyOn(adapter, 'listByType').mockImplementationOnce(async (...args) => {
      entered();
      await held;
      return listRecords(...args);
    });
    const pendingGraph = h.request(
      `/api/knowledge/roots/${encodeURIComponent(allowed.id)}/graph`,
      guest(),
    );
    await started;
    const revoked = await h.request(
      '/api/projects/knowledge/access/members',
      h.ownerHeaders({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope,
          principalId: guestId,
          revision: member.revision + 1,
          role: 'viewer',
          status: 'revoked',
        }),
      }),
    );
    release();
    expect(revoked.status, await revoked.clone().text()).toBe(200);
    const afterRevocation = await pendingGraph;
    expect(afterRevocation.status).toBe(404);
    expect(await afterRevocation.text()).not.toContain('Selected source');
  });
});
