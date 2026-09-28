/**
 * Authority observation route (#481 groundwork) through the production HTTP
 * composition: the REAL `configureRuntimeHttp` transport middleware, the
 * REAL account-bound device gate, the REAL canonical principal owner, and
 * the REAL `EnvironmentSecurityService` device registry on an isolated home
 * — never a stubbed principal, middleware, or identity. The only fixture is
 * the external account provider module (the same operator-module loader the
 * real Station uses), whose cookie sessions exercise the continuation and
 * account-bound tiers.
 *
 * Every positive is followed by its negatives on the SAME harness, so a
 * refusal proves the boundary moved rather than the fixture never working.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEPLOYMENT_AUTHENTICATION_BASE_PATH } from '@kontourai/station-contracts/deployment-authentication';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { readJson } from '../../../__test-utils__/read-json.js';
import { installAccountBoundDeviceGate } from '../../../runtime/bootstrap/account-bound-device-gate.js';
import { createOrchestrationRequestPrincipalResolver } from '../../../runtime/bootstrap/orchestration-request-principal.js';
import { configureRuntimeHttp } from '../../../runtime/bootstrap/runtime-http.js';
import { loadDeploymentAuthentication } from '../../../services/identity/deployment-authentication-loader.js';
import { identifyIngress } from '../../../services/identity/identity-source.js';
import type { EventBus } from '../../../services/orchestration/event-bus.js';
import { EnvironmentSecurityService } from '../../../services/ssh/environment-security-service.js';
import type { Logger } from '../../../utils/logger.js';
import { createDeploymentAuthenticationRoutes } from '../deployment-authentication-routes.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  authOps: { add: vi.fn() },
  deviceSessionAuthorizations: { add: vi.fn() },
  requestBudgetOutcomes: { add: vi.fn() },
}));
vi.mock('../../../providers/registries/registry.js', () => ({
  getAuthProvider: () => ({
    getStatus: async () => ({ authenticated: true, method: 'sso' }),
    renew: async () => ({ success: true, message: 'Renewed' }),
  }),
  getUserIdentityProvider: () => ({
    getIdentity: async () => ({ alias: 'testuser', name: 'Test User' }),
  }),
  getUserDirectoryProvider: () => ({
    searchPeople: async (q: string) => [{ alias: q, name: q }],
    lookupPerson: (alias: string) => ({ alias, name: alias }),
  }),
  getCachedUser: () => ({ alias: 'testuser' }),
}));

const { createAuthRoutes } = await import('../auth.js');

const ORIGIN = 'https://station.example.test';
const STATION_ID = 'authority-observation-fixture';
const PROVIDER_ISSUER = `urn:station:${STATION_ID}`;
const ACCOUNT_SUBJECT = 'person-opaque';

const homes: string[] = [];
afterEach(async () => {
  delete (globalThis as Record<string, unknown>)
    .__authorityObservationAccountGate;
  for (const home of homes.splice(0))
    await rm(home, { recursive: true, force: true });
});

const logger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn().mockReturnThis(),
  setLevel: vi.fn(),
  getLevel: vi.fn(() => 'error' as const),
};

/** Deterministic barrier for the account-provider round-trip. */
interface AccountGate {
  armed: boolean;
  entered: () => void;
  wait: Promise<void>;
  resetAuthorityCalls?: boolean;
}

async function writeProviderModule(homeDirectory: string): Promise<string> {
  const modulePath = join(homeDirectory, 'fixture-provider.mjs');
  await writeFile(
    modulePath,
    `
let authorityCalls = 0;
let revoked = false;
export async function createStationAuthenticationProvider(host) {
  return {
    version: 'station.authentication/v1',
    issuer: 'urn:station:' + host.stationId,
    displayName: 'Disposable test account provider',
    sessionCookies: ['fixture_account'],
    endpoints: [
      {path:'/login',methods:['POST'],operation:'begin-login'},
      {path:'/logout',methods:['POST'],operation:'logout'}
    ],
    async authenticate(request) {
      // Only the route's fresh revalidation parks at the barrier. The
      // counter resets when the test arms the gate, so the pending
      // request's own middleware round-trip (count 1) passes and only its
      // revalidation (count 2) waits; unrelated account operations
      // (notably logout) never park — so the test can revoke identity
      // mid-await deterministically, past the middleware but before the
      // release guard it is actually proving.
      const authorityRead =
        new URL(request.url).pathname === '/api/auth/authority';
      const gate = globalThis.__authorityObservationAccountGate;
      if (gate && gate.resetAuthorityCalls) {
        authorityCalls = 0;
        gate.resetAuthorityCalls = false;
      }
      if (authorityRead) authorityCalls += 1;
      if (gate && gate.armed && authorityRead && authorityCalls >= 2) {
        gate.entered();
        await gate.wait;
      }
      const cookie = request.headers.get('cookie');
      if (!cookie) return {kind:'absent'};
      if (cookie === 'fixture_account=outage') throw new Error('PRIVATE_PROVIDER_FAILURE');
      if (!cookie.includes('fixture_account=valid') || revoked) return {kind:'invalid',reason:'revoked'};
      return {kind:'authenticated',session:{
        subject:'${ACCOUNT_SUBJECT}',displayName:'Fixture Person',sessionId:'non-secret-record',
        authenticatedAt:new Date(Date.now()-1000).toISOString(),
        expiresAt:new Date(Date.now()+60000).toISOString(),contacts:[]
      }};
    },
    async handle(request) {
      if (new URL(request.url).pathname.endsWith('/logout')) revoked = true;
      return Response.json({accepted:true},{headers:{'Set-Cookie':'fixture_account=valid; Secure; HttpOnly; SameSite=Lax; Path=/'}});
    }
  };
}
`,
  );
  return modulePath;
}

async function createHarness(options?: {
  resolveRequestPrincipal?: (
    context: Parameters<
      ReturnType<typeof createOrchestrationRequestPrincipalResolver>
    >[0],
  ) => { id: string; kind: 'human'; display: string };
}) {
  const homeDirectory = await mkdtemp(join(tmpdir(), 'station-authority-obs-'));
  homes.push(homeDirectory);
  const security = new EnvironmentSecurityService({ homeDir: homeDirectory });
  const { credential: operatorCredential, environmentId } =
    await security.initialize();
  const modulePath = await writeProviderModule(homeDirectory);
  const authentication = await loadDeploymentAuthentication(
    { modulePath, publicOrigin: ORIGIN },
    { stationId: STATION_ID, homeDirectory },
  );
  if (!authentication) throw new Error('fixture provider failed to load');

  const app = new Hono();
  configureRuntimeHttp({
    app: app as never,
    logger,
    eventBus: { emit: vi.fn() } as unknown as EventBus,
    // The production wiring, not test doubles: path-aware credential
    // verification and scope resolution through the SAME service the
    // observation reads. A synthetic verifier here is exactly how a
    // revocation race escapes coverage.
    security: {
      deploymentAuthentication: authentication.service,
      verifyCredential: (credential, request) =>
        request
          ? security.authorizeCredential(credential, request)
          : security.verifyCredential(credential),
      recognizeCredential: (credential) =>
        security.verifyCredential(credential),
      resolveGrantedScope: (credential) =>
        security.resolveGrantedScope(credential),
      resolveCredentialAuthority: (credential) =>
        security.verifyOperatorCredential(credential)
          ? 'operator-credential'
          : security.devicePairing.identifyDevice(credential)
            ? 'device-credential'
            : undefined,
      resolveCredentialDeviceId: (credential) =>
        security.devicePairing.identifyDevice(credential)?.id,
      allowedOrigins: [ORIGIN],
    },
  });
  installAccountBoundDeviceGate(app as never, {
    identifyDevice: (credential) => security.identifyDevice(credential),
    identifyIngress,
    deploymentAuthentication: authentication,
  });
  app.route(
    '/api/auth',
    createAuthRoutes({
      // The SAME canonical owner every orchestration route resolves
      // through — constructed here exactly as `configureRuntimeRoutes`
      // constructs it (personal mode, same services). Overridable only
      // for the fault-injection case below, which proves the
      // resolver-throw mapping with everything else production-real.
      resolveRequestPrincipal:
        options?.resolveRequestPrincipal ??
        createOrchestrationRequestPrincipalResolver({
          environmentSecurityService: security,
          deploymentAuthentication: authentication.service,
          hostedTenantRegistry: undefined,
        }),
      security,
      deploymentAuthentication: authentication,
    }),
  );
  // The real account login/logout surface (provider revocation included),
  // mounted exactly where production mounts it.
  app.route(
    DEPLOYMENT_AUTHENTICATION_BASE_PATH,
    createDeploymentAuthenticationRoutes(authentication),
  );
  // A non-allowlisted management-shaped leaf: proves the account-bound
  // device gate still denies everything outside the exact self-read.
  app.post('/api/projects/:slug/publish', (c) => c.json({ published: true }));
  app.get('/api/auth/status', (c) => c.json({ authenticated: true }));
  app.get('/api/system/identity', (c) =>
    c.json({ bootId: '11111111-1111-4111-8111-111111111111' }),
  );
  app.get('/api/system/status', (c) => c.json({ ready: true }));

  const request = async (
    path: string,
    init: RequestInit = {},
  ): Promise<Response> => app.request(`${ORIGIN}${path}`, init);
  const bearer = (credential: string): RequestInit => ({
    headers: { Authorization: `Bearer ${credential}` },
  });
  const deviceCookie = (credential: string): RequestInit => ({
    headers: { Cookie: `station-device=${credential}` },
  });
  const accountCookie: RequestInit = {
    headers: { Cookie: 'fixture_account=valid' },
  };
  const bothCookies = (credential: string): RequestInit => ({
    headers: {
      Cookie: `station-device=${credential}; fixture_account=valid`,
    },
  });

  /** Mint a personal (non-account-bound) device through the real registry. */
  const pairPersonalDevice = (name: string) => {
    const pairing = security.devicePairing;
    const offer = pairing.createOffer({ endpoint: ORIGIN });
    const pending = pairing.requestPairing({
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: name,
      requesterPosition: 'unproven',
      source: 'same-origin',
    });
    pairing.confirmRequest(pending.requestId, {
      kind: 'presented-credential',
    });
    const { device, credential } = pairing.exchange({
      offerId: offer.offerId,
      proof: offer.challenge,
      requestId: pending.requestId,
    });
    return { device, credential };
  };

  /**
   * Mint an account-bound device whose binding matches (`match: true`) or
   * conflicts with (`match: false`) the fixture account session.
   */
  const pairAccountBoundDevice = (name: string, match: boolean) => {
    const pairing = security.devicePairing;
    const offer = pairing.createOffer({ endpoint: ORIGIN });
    const pending = pairing.requestPairing({
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: name,
      requesterPosition: 'unproven',
      source: 'same-origin',
      accountCandidate: {
        issuer: PROVIDER_ISSUER,
        subject: match ? ACCOUNT_SUBJECT : 'someone-else',
        displayName: 'Fixture Person',
      },
      accountCandidateSessionId: 'candidate-proof',
      requireAccountBinding: true,
    });
    pairing.confirmRequest(
      pending.requestId,
      { kind: 'presented-credential' },
      { principalId: 'human:local:operator', kind: 'account' },
    );
    const { device, credential } = pairing.exchange({
      offerId: offer.offerId,
      proof: offer.challenge,
      requestId: pending.requestId,
    });
    return { device, credential };
  };

  return {
    security,
    operatorCredential,
    environmentId,
    authentication,
    request,
    bearer,
    deviceCookie,
    accountCookie,
    bothCookies,
    pairPersonalDevice,
    pairAccountBoundDevice,
  };
}

describe('GET /api/auth/authority through the production composition', () => {
  test('unwired auth routes expose no observation leaf (fail closed)', async () => {
    const bare = createAuthRoutes();
    const response = await bare.request('/authority');
    expect(response.status).toBe(404);
  });

  test('canonical resolver failure maps to fail-closed 401, never a guessed principal', async () => {
    const { PrincipalUnresolvedError } = await import(
      '../../../services/identity/principal-resolver.js'
    );
    // Fault injection: the ONLY stub in this suite replaces the canonical
    // owner with a throw, proving the route maps resolution failure to the
    // boundary refusal with middleware, gate, and registry all real.
    const h = await createHarness({
      resolveRequestPrincipal: () => {
        throw new PrincipalUnresolvedError(
          'injected: no verified identity for this request',
        );
      },
    });
    const response = await h.request(
      '/api/auth/authority',
      h.bearer(h.operatorCredential),
    );
    expect(response.status).toBe(401);
    expect(await readJson(response)).toEqual({
      error: { code: 'authentication_required' },
    });
  });

  test('operator bearer observes the closed operator authority', async () => {
    const h = await createHarness();
    const response = await h.request(
      '/api/auth/authority',
      h.bearer(h.operatorCredential),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body = await readJson<{
      schemaVersion: string;
      environmentId: string;
      principal: { kind: string; id: string };
      grant: Record<string, unknown>;
    }>(response);
    expect(body.schemaVersion).toBe('station.authority-observation/v1');
    expect(body.environmentId).toBe(h.environmentId);
    expect(body.principal).toEqual({
      kind: 'human',
      id: 'human:local:operator',
    });
    expect(body.grant).toEqual({ kind: 'operator' });
    // Closed shape: no credential material, no contacts, no extras.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(h.operatorCredential);
    expect(body).not.toHaveProperty('credential');
    expect(body).not.toHaveProperty('email');
    expect(body.principal).not.toHaveProperty('display');
  });

  test('personal device bearer observes its public grant, then revocation fails closed', async () => {
    const h = await createHarness();
    const { device, credential } = h.pairPersonalDevice('field-phone');
    const response = await h.request(
      '/api/auth/authority',
      h.bearer(credential),
    );
    expect(response.status).toBe(200);
    const body = await readJson<{
      environmentId: string;
      principal: { kind: string; id: string };
      grant: { kind: string; deviceId: string; grantedScopes: string[] };
    }>(response);
    expect(body.environmentId).toBe(h.environmentId);
    expect(body.principal).toEqual({
      kind: 'human',
      id: `human:device:${device.id}`,
    });
    expect(body.grant.kind).toBe('device');
    expect(body.grant.deviceId).toBe(device.id);
    expect(body.grant.grantedScopes).toContain('orchestration:read');

    // Positive proven above; the SAME credential revoked now fails closed
    // at the boundary with no observation bytes.
    h.security.devicePairing.revokeDevice(device.id, 'operator-credential');
    const revoked = await h.request(
      '/api/auth/authority',
      h.bearer(credential),
    );
    expect(revoked.status).toBe(401);
    expect(await readJson(revoked)).toEqual({
      error: { code: 'authentication_required' },
    });
  });

  test('device-session cookie (browser shape) observes the same authority', async () => {
    const h = await createHarness();
    const { device, credential } = h.pairPersonalDevice('browser-tablet');
    const response = await h.request(
      '/api/auth/authority',
      h.deviceCookie(credential),
    );
    expect(response.status).toBe(200);
    const body = await readJson<{
      principal: { kind: string; id: string };
      grant: { kind: string; deviceId: string };
    }>(response);
    expect(body.principal).toEqual({
      kind: 'human',
      id: `human:device:${device.id}`,
    });
    expect(body.grant.deviceId).toBe(device.id);
  });

  test('operator continuation resolves the account principal through the canonical owner', async () => {
    const h = await createHarness();
    const withAccount: RequestInit = {
      headers: {
        Authorization: `Bearer ${h.operatorCredential}`,
        Cookie: 'fixture_account=valid',
      },
    };
    const response = await h.request('/api/auth/authority', withAccount);
    expect(response.status).toBe(200);
    const body = await readJson<{
      principal: { kind: string; id: string };
      grant: Record<string, unknown>;
    }>(response);
    // The canonical owner prefers the valid account session: the observed
    // principal is the deployment-account principal, derived by the server
    // — never a client-guessed operator.
    expect(body.principal.kind).toBe('human');
    expect(body.principal.id).toMatch(/^human:deployment:[0-9a-f]{64}$/);
    expect(body.grant).toEqual({ kind: 'operator' });

    // The provider revokes (logout): the SAME request shape now fails
    // closed — first at the transport boundary — with no observation.
    const logout = await h.request('/api/account-auth/logout', {
      method: 'POST',
      headers: { Origin: ORIGIN, Cookie: 'fixture_account=valid' },
    });
    expect(logout.status).toBe(200);
    const afterRevoke = await h.request('/api/auth/authority', withAccount);
    expect(afterRevoke.status).toBe(401);
    // The transport boundary's own shape (code plus its source-based
    // reason) — still no observation bytes.
    expect(await readJson(afterRevoke)).toEqual({
      error: { code: 'account_authentication_invalid', reason: 'revoked' },
    });
  });

  test('account-bound device allowlist: exact GET self-read only', async () => {
    const h = await createHarness();
    const { credential } = h.pairAccountBoundDevice('shared-kiosk', true);

    // Without the account session the gate refuses before the route.
    const noSession = await h.request(
      '/api/auth/authority',
      h.bearer(credential),
    );
    expect(noSession.status).toBe(401);
    expect(await readJson(noSession)).toEqual({
      error: { code: 'account_authentication_required' },
    });

    // With it, the exact self-read is allowed through the real gate.
    const allowed = await h.request(
      '/api/auth/authority',
      h.bothCookies(credential),
    );
    expect(allowed.status).toBe(200);
    const body = await readJson<{
      principal: { kind: string; id: string };
      grant: { kind: string; deviceId: string };
    }>(allowed);
    expect(body.principal.id).toMatch(/^human:deployment:[0-9a-f]{64}$/);
    expect(body.grant.kind).toBe('device');

    // The browser's encrypted-route gate may read this Station's own
    // identity after account/Device admission, without opening system status
    // or another operator/runtime surface.
    const identity = await h.request(
      '/api/system/identity',
      h.bothCookies(credential),
    );
    expect(identity.status).toBe(200);
    expect(await readJson(identity)).toEqual({
      bootId: '11111111-1111-4111-8111-111111111111',
    });
    const identityWithoutAccount = await h.request(
      '/api/system/identity',
      h.bearer(credential),
    );
    expect(identityWithoutAccount.status).toBe(401);
    const identityWrongVerb = await h.request('/api/system/identity', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credential}`,
        Cookie: 'fixture_account=valid',
      },
    });
    expect(identityWrongVerb.status).toBe(403);
    const siblingSystemRead = await h.request(
      '/api/system/status',
      h.bothCookies(credential),
    );
    expect(siblingSystemRead.status).toBe(403);

    // Everything else stays denied: a sibling auth self-read, a non-read
    // verb on the observation path, and a management mutation.
    const sibling = await h.request(
      '/api/auth/status',
      h.bothCookies(credential),
    );
    expect(sibling.status).toBe(403);
    expect(await readJson(sibling)).toEqual({
      error: { code: 'account_bound_device_route_forbidden' },
    });
    const wrongVerb = await h.request('/api/auth/authority', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credential}`,
        Cookie: 'fixture_account=valid',
      },
    });
    expect(wrongVerb.status).toBe(403);
    expect(await readJson(wrongVerb)).toEqual({
      error: { code: 'account_bound_device_route_forbidden' },
    });
    const management = await h.request('/api/projects/demo/publish', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${credential}`,
        Cookie: 'fixture_account=valid',
      },
      body: '{}',
    });
    expect(management.status).toBe(403);
    expect(await readJson(management)).toEqual({
      error: { code: 'account_bound_device_route_forbidden' },
    });
  });

  test('conflicting account binding fails closed through the real gate', async () => {
    const h = await createHarness();
    const { credential } = h.pairAccountBoundDevice('conflicted-kiosk', false);
    const response = await h.request(
      '/api/auth/authority',
      h.bothCookies(credential),
    );
    expect(response.status).toBe(401);
    expect(await readJson(response)).toEqual({
      error: { code: 'account_identity_conflict' },
    });
  });

  test('absent and forged credentials fail closed with no observation', async () => {
    const h = await createHarness();
    h.pairPersonalDevice('proof-device');
    const absent = await h.request('/api/auth/authority');
    expect(absent.status).toBe(401);
    const forged = await h.request(
      '/api/auth/authority',
      h.bearer('f'.repeat(43)),
    );
    expect(forged.status).toBe(401);
    expect(await readJson(forged)).toEqual({
      error: { code: 'authentication_required' },
    });
  });

  test('the family read tier still applies: a grant without read is denied', async () => {
    const h = await createHarness();
    const { device, credential } = h.pairPersonalDevice('narrowed-device');
    // Positive first: the default grant reaches the new leaf.
    expect(
      (await h.request('/api/auth/authority', h.bearer(credential))).status,
    ).toBe(200);
    // Narrow to operate-only through the real registry: the observation
    // inherits the family's read requirement — scope behavior unchanged.
    h.security.devicePairing.setDeviceScope(
      device.id,
      ['orchestration:operate'],
      { kind: 'presented-credential' },
    );
    const narrowed = await h.request(
      '/api/auth/authority',
      h.bearer(credential),
    );
    expect(narrowed.status).toBe(403);
    expect(await readJson(narrowed)).toEqual({
      error: { code: 'insufficient_scope' },
    });
  });

  test('credential revoked DURING the final account await never publishes', async () => {
    const h = await createHarness();
    const { device, credential } = h.pairPersonalDevice('race-device');
    // Positive first through the account tier, so the refusal below proves
    // the race and not the fixture.
    expect(
      (await h.request('/api/auth/authority', h.bothCookies(credential)))
        .status,
    ).toBe(200);

    let releaseGate!: () => void;
    const gateWait = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let enteredResolve!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    (globalThis as Record<string, unknown>).__authorityObservationAccountGate =
      {
        armed: true,
        entered: enteredResolve,
        wait: gateWait,
        resetAuthorityCalls: true,
      } satisfies AccountGate;

    // The route's fresh revalidation parks inside its final `authenticate`
    // (the pending request's own middleware round-trip already passed, so
    // this refusal is the delivery guard's, not the boundary's); revoke the
    // DEVICE credential mid-await, then release.
    const pending = h.request('/api/auth/authority', h.bothCookies(credential));
    await entered;
    h.security.devicePairing.revokeDevice(device.id, 'operator-credential');
    releaseGate();
    const response = await pending;
    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body = await readJson<Record<string, unknown>>(response);
    expect(body).toEqual({ error: { code: 'authentication_required' } });
    expect(JSON.stringify(body)).not.toContain(device.id);
    expect(JSON.stringify(body)).not.toContain(h.environmentId);
  });

  test('account session revoked DURING the final account await never publishes', async () => {
    const h = await createHarness();
    const { credential } = h.pairPersonalDevice('account-race-device');
    // Positive first through the account tier, so the refusal below proves
    // the race and not the fixture.
    expect(
      (await h.request('/api/auth/authority', h.bothCookies(credential)))
        .status,
    ).toBe(200);

    let releaseGate!: () => void;
    const gateWait = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let enteredResolve!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    (globalThis as Record<string, unknown>).__authorityObservationAccountGate =
      {
        armed: true,
        entered: enteredResolve,
        wait: gateWait,
        resetAuthorityCalls: true,
      } satisfies AccountGate;

    // The route's fresh revalidation parks inside its final `authenticate`;
    // signing the session out mid-await must fail the release with the
    // boundary refusal and no observation bytes.
    const pending = h.request('/api/auth/authority', h.bothCookies(credential));
    await entered;
    const logout = await h.request('/api/account-auth/logout', {
      method: 'POST',
      headers: { Origin: ORIGIN, Cookie: 'fixture_account=valid' },
    });
    expect(logout.status).toBe(200);
    releaseGate();
    const response = await pending;
    // The refusal comes from the route's own delivery guard (past the
    // middleware, before the first body byte): the boundary refusal shape
    // with `no-store`, and no observation bytes.
    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body = await readJson<Record<string, unknown>>(response);
    expect(body).toEqual({ error: { code: 'authentication_required' } });
    expect(JSON.stringify(body)).not.toContain('human:deployment:');
  });

  test('credential revoked after headers but before body consumption publishes nothing', async () => {
    const h = await createHarness();
    const { device, credential } = h.pairPersonalDevice('consume-race');
    const response = await h.request(
      '/api/auth/authority',
      h.bearer(credential),
    );
    expect(response.status).toBe(200);
    // Headers left the seam while the credential was valid; revoke before
    // the queued body is consumed — the per-chunk guard must refuse, and
    // the already-queued observation bytes must never surface.
    h.security.devicePairing.revokeDevice(device.id, 'operator-credential');
    await expect(response.text()).rejects.toThrow(
      'Authority observation ended before response delivery.',
    );
  });
});
