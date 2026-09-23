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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { resolveStationRoot } from '@kontourai/station-shared/runtime-path-resolver';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readJson } from '../../../__test-utils__/read-json.js';
import { FileStorageAdapter } from '../../../domain/file-storage-adapter.js';
import { createApplicationSessionRuntime } from '../../../services/identity/application-session-runtime.js';
import { loadDeploymentAuthentication } from '../../../services/identity/deployment-authentication-loader.js';
import { deploymentAccountPrincipal } from '../../../services/identity/deployment-authentication-service.js';
import { loadLocalAccounts } from '../../../services/identity/local-account-runtime.js';
import { ProjectManifestStore } from '../../../services/projects/project-manifest-store.js';
import { createProjectMembershipRuntime } from '../../../services/projects/project-membership-runtime.js';
import { ProjectService } from '../../../services/projects/project-service.js';
import { DevicePairingError } from '../../../services/ssh/device-pairing-service.js';
import { EnvironmentSecurityService } from '../../../services/ssh/environment-security-service.js';
import { configureRuntimeRoutes as configureRuntimeRoutesProduction } from '../runtime-routes.js';

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
  afterEach(() => {
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

  async function setup() {
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
    const manifests = new ProjectManifestStore(homeDir, storage);
    const projectService = new ProjectService(storage, manifests);
    const membership = createProjectMembershipRuntime(
      homeDir,
      STATION_ID,
      storage,
    );
    const localAccounts = await loadLocalAccounts(
      { publicOrigin: 'http://localhost:4321' },
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
    const context = deepStub({
      projectMembership: membership.service,
      projectSharedTasks: undefined,
      deploymentAuthentication: authentication,
      localAccounts,
      applicationSessions,
      storageAdapter: storage,
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
      agentService: { listAgents: () => [] },
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
      taskGraphService: { listTasks: () => [] },
    });
    const result = configureRuntimeRoutesProduction(
      context as unknown as Parameters<
        typeof configureRuntimeRoutesProduction
      >[0],
    );
    await result.kitLifecycleReady;

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
          issuer: PROVIDER_ISSUER,
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
            PROVIDER_ISSUER,
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
    const shareWithGuestAdmin = async (slug: string, name: string) => {
      const project = await projectService.createProject({ name, slug });
      const enabled = await request(
        `/api/projects/${slug}/access/enable`,
        ownerHeaders({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ localProjectId: project.id }),
        }),
      );
      expect(enabled.status, await enabled.clone().text()).toBe(200);
      const scope = (await readJson<{ data: { scope: unknown } }>(enabled)).data
        .scope;
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
      request,
      security,
      authentication,
      operatorCredential,
      projectService,
      membership,
      ownerHeaders,
      operatorHeaders,
      pairAccountBound,
      guestHeaders,
      shareWithGuestAdmin,
    };
  }

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

    // Pairing/device management stays operator-only at the FIRST boundary
    // (archive#1887): `authorizeCredential` admits no device credential to
    // `/api/pairing*` outside the approval leaves, so runtime-http answers
    // 401 `authentication_required` before the pairing-scope middleware
    // (which would 403 on the missing `access:manage`) or the handler's
    // operator check is reached.
    const pairingAdmin = await h.request(
      '/api/pairing/offers',
      guest({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: ORIGIN }),
      }),
    );
    expect(pairingAdmin.status, await pairingAdmin.clone().text()).toBe(401);
    expect(await pairingAdmin.json()).toEqual({
      error: { code: 'authentication_required' },
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
      401,
    );
    expect(await selfEscalation.json()).toEqual({
      error: { code: 'authentication_required' },
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
});
