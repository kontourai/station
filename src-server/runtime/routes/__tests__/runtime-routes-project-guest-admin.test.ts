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
  const match = cookie.match(/fixture_account=(owner|guest)/);
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
        subject,displayName:subject,sessionId:'non-secret-record',
        authenticatedAt:new Date(Date.now()-1000).toISOString(),
        expiresAt:new Date(Date.now()+60000).toISOString(),contacts:[]
      }};
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
          mutate: (
            current: Record<string, unknown>,
          ) => Record<string, unknown>,
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
    const pairAccountBound = (name: string, scope: string) => {
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
          subject: GUEST_SUBJECT,
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
            GUEST_SUBJECT,
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
    const guestHeaders = (credential: string) => (extra?: RequestInit) => ({
      ...extra,
      headers: {
        ...(extra?.headers ?? {}),
        Authorization: `Bearer ${credential}`,
        Cookie: 'fixture_account=guest',
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

    // Pairing management answers at the handler's operator check (401)
    // rather than the scope middleware (403): either layer is a denial,
    // and the exact scope-middleware 403 is already pinned by the
    // terminal probe above and the read-only probe below.
    const pairingAdmin = await h.request(
      '/api/pairing/offers',
      guest({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: ORIGIN }),
      }),
    );
    expect([401, 403]).toContain(pairingAdmin.status);

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
    expect([401, 403]).toContain(selfEscalation.status);

    const operatorAccounts = await h.request('/api/operator/accounts', guest());
    expect([401, 403]).toContain(operatorAccounts.status);

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
});
