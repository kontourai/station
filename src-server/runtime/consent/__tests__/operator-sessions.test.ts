import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { parsePairingScope } from '@kontourai/station-contracts/environment-security';
import * as fileLocks from '@kontourai/station-shared/lifecycle-events';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  authenticatedFetch,
  StationHttpError,
  setClientCredentialResolver,
} from '../../../../packages/sdk/src/client/http.js';
import { fetchPairedDevices } from '../../../../packages/sdk/src/query-domains/devicePairingRequests.js';
import { readJson } from '../../../__test-utils__/read-json.js';
import { SoftwareAuthenticator } from '../../../__test-utils__/software-authenticator.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  getRuntimeAuthenticatedRequestPrincipal,
  isBoundRuntimeLocalOperator,
  isRuntimeRequestPrincipalCurrent,
} from '../../../security/runtime-request-security.js';
import { ConsentChannelService } from '../../../services/consent/consent-channel.js';
import { DeploymentAuthenticationService } from '../../../services/identity/deployment-authentication-service.js';
import { OperatorPasskeyEnrollmentService } from '../../../services/identity/operator-passkey-enrollment.js';
import { LazyOperatorPasskeyRegistry } from '../../../services/identity/operator-passkey-registry.js';
import {
  OPERATOR_SESSION_ABSOLUTE_MS,
  OPERATOR_SESSION_IDLE_MS,
  OperatorSessionService,
} from '../../../services/identity/operator-sessions.js';
import type { EventBus } from '../../../services/orchestration/event-bus.js';
import { EnvironmentSecurityService } from '../../../services/ssh/environment-security-service.js';
import {
  getInternalApiToken,
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_PROXY_CALLER_HEADER,
} from '../../../utils/internal-api-token.js';
import type { Logger } from '../../../utils/logger.js';
import { installAccountBoundDeviceGate } from '../../bootstrap/account-bound-device-gate.js';
import { configureRuntimeHttp } from '../../bootstrap/runtime-http.js';
import { configureDevicePairingHostRoutes } from '../../routes/runtime-routes.js';
import { createConsentApp } from '../consent-listener.js';

const ORIGIN = 'https://station.example.test:8443';
const APP = 'https://station.example.test';
const makeTemp = trackTempDirs();
const registries: LazyOperatorPasskeyRegistry[] = [];
afterEach(() => {
  setClientCredentialResolver(undefined);
  vi.restoreAllMocks();
  for (const registry of registries.splice(0)) registry.close();
});

async function build(
  options: {
    origin?: string | null;
    hosted?: boolean;
    accountBound?: boolean;
  } = {},
) {
  const home = makeTemp('station-operator-session-');
  const clock = { now: 1_800_000_000_000 };
  const security = new EnvironmentSecurityService({
    homeDir: home,
    now: () => clock.now,
  });
  const operator = await security.initialize();
  const pairing = security.devicePairing;
  const account = { disabled: false };
  const issuer = 'urn:station:operator-session-test';
  pairing.setAccountDirectory({
    issuer,
    standing: () => (account.disabled ? 'disabled' : 'current'),
    list: () => [],
  });
  function pair(
    name: string,
    scope = 'orchestration:read',
    kind: 'device' | 'delegation' = 'device',
    accountBound = false,
    localGrant: boolean | 'ui-bootstrap' = false,
  ) {
    const offer = pairing.createOffer({ endpoint: APP, scope, kind });
    const pending = pairing.requestPairing({
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: name,
      source: 'pairing-code',
      requesterPosition: 'unproven',
      ...(accountBound
        ? {
            accountCandidate: {
              issuer,
              subject: 'operator',
              displayName: 'Operator',
            },
            accountCandidateSessionId: 'account-session',
          }
        : {}),
    });
    pairing.confirmRequest(
      pending.requestId,
      { kind: 'presented-credential' },
      accountBound
        ? { principalId: 'human:local:operator', kind: 'account' }
        : undefined,
    );
    return pairing.exchange({
      offerId: offer.offerId,
      proof: offer.challenge,
      requestId: pending.requestId,
      ...(localGrant
        ? {
            locality: 'home-possession' as const,
            mintKind:
              localGrant === 'ui-bootstrap'
                ? ('ui-bootstrap' as const)
                : ('local-grant' as const),
          }
        : {}),
    });
  }
  const first = pair(
    'Operator browser',
    'orchestration:read',
    'device',
    options.accountBound,
  );
  const second = pair('Other browser');
  const registry = new LazyOperatorPasskeyRegistry(home, () => clock.now);
  registries.push(registry);
  const origin = options.origin === undefined ? ORIGIN : options.origin;
  const sessionService = new OperatorSessionService({
    registry,
    origin,
    now: () => clock.now,
    identifyDevice: (credential) => security.identifyDevice(credential),
    epoch: () =>
      security.pseudonymizePairingAuditSource('operator-session-epoch.v1'),
    available: () => !options.hosted,
  });
  const enrollment = new OperatorPasskeyEnrollmentService({
    registry,
    origin,
    now: () => clock.now,
  });
  const channel = new ConsentChannelService({
    trustedOrigin: origin,
    now: () => clock.now,
  });
  channel.markListening(4321);
  const consent = createConsentApp({
    channel,
    credentials: security,
    passkeys: enrollment,
    sessions: sessionService,
  });
  const api = new Hono();
  // The account provider is the fixture boundary; real HTTP admission and
  // account-device policy consume its resolved session.
  const accountAuthentication = new DeploymentAuthenticationService(
    {
      version: 'station.authentication/v1',
      issuer,
      displayName: 'Fixture account',
      sessionCookies: ['fixture_account'],
      endpoints: [{ path: '/logout', methods: ['POST'], operation: 'logout' }],
      authenticate: async () =>
        account.disabled
          ? { kind: 'invalid', reason: 'revoked' }
          : {
              kind: 'authenticated',
              session: {
                subject: 'operator',
                displayName: 'Operator',
                sessionId: 'account-session',
                authenticatedAt: new Date(clock.now - 1000).toISOString(),
                expiresAt: new Date(clock.now + 60_000).toISOString(),
                contacts: [],
              },
            },
      handle: async () => new Response(null, { status: 404 }),
    },
    () => clock.now,
  );
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  } as unknown as Logger;
  const audit = vi.fn();
  configureRuntimeHttp({
    app: api as never,
    logger,
    eventBus: { emit: vi.fn() } as unknown as EventBus,
    security: {
      audit,
      now: () => clock.now,
      deploymentAuthentication: accountAuthentication,
      operatorSessions: options.hosted ? undefined : sessionService,
      allowedOrigins: [APP],
      verifyCredential: (credential, request) =>
        request
          ? security.authorizeCredential(credential, request)
          : security.verifyCredential(credential),
      recognizeCredential: (credential) =>
        security.verifyCredential(credential),
      resolveCredentialAuthority: (credential) =>
        security.verifyOperatorCredential(credential)
          ? 'operator-credential'
          : security.identifyDevice(credential)
            ? 'device-credential'
            : undefined,
      resolveCredentialAliasId: (credential) =>
        pairing.credentialAliasId(credential),
      resolveCredentialLocality: (credential) =>
        pairing.credentialLocality(credential),
      resolveCredentialMintKind: (credential) =>
        pairing.credentialMintKind(credential),
      resolveGrantedScope: (credential) =>
        security.resolveGrantedScope(credential),
    },
  });
  installAccountBoundDeviceGate(api as never, {
    identifyDevice: (credential) => security.identifyDevice(credential),
    identifyIngress: () => null,
    deploymentAuthentication: { service: accountAuthentication },
  });
  api.use('/api/*', async (c, next) => {
    await next();
    c.header(
      'X-Fixture-Local-Operator',
      String(isBoundRuntimeLocalOperator(c.req.raw)),
    );
  });
  configureDevicePairingHostRoutes(api as never, pairing, {
    consentChannel: channel,
    groups: {
      groupOf: (id) => security.groupOf(id),
      assignments: () => security.groupAssignments(),
      assign: (id, group, expected, current) =>
        security.assignGroup(id, group, expected, current),
    },
    verifyOperatorCredential: (credential) =>
      security.verifyOperatorCredential(credential),
    isRequestPrincipalCurrent: (request) =>
      isRuntimeRequestPrincipalCurrent(request, security),
    isApprovalCurrent: (request) =>
      isRuntimeRequestPrincipalCurrent(request, security),
    operatorPasskeys: options.hosted ? undefined : enrollment,
    operatorSessions: options.hosted ? undefined : sessionService,
  });
  api.get('/api/operator/accounts', (c) =>
    c.json({
      authority: getRuntimeAuthenticatedRequestPrincipal(c.req.raw)?.authority,
    }),
  );
  api.get('/api/projects', (c) =>
    c.json({
      authority: getRuntimeAuthenticatedRequestPrincipal(c.req.raw)?.authority,
    }),
  );
  const headers = (
    credential = first.credential,
    extra: Record<string, string> = {},
  ) => ({
    host: new URL(ORIGIN).host,
    origin: ORIGIN,
    cookie: `__Host-station-device=${credential}`,
    'sec-fetch-site': 'same-origin',
    'content-type': 'application/json',
    ...extra,
  });
  async function enroll(authenticator = new SoftwareAuthenticator()) {
    const opened = enrollment.createRequest({
      credential: first.credential,
      deviceLabel: 'Operator browser',
      requester: {
        kind: 'paired-device',
        deviceId: first.device.id,
        pairedAt: clock.now,
        scope: first.device.scope,
      },
    });
    enrollment.confirm(opened.code, first.device.id);
    const opts = await enrollment.beginRegistration(
      opened.requestId,
      first.credential,
    );
    const passkey = await enrollment.finishRegistration(
      opened.requestId,
      first.credential,
      authenticator.register(opts, { origin: ORIGIN }),
      'Primary',
    );
    return { authenticator, passkey };
  }
  async function challenge(credential = first.credential) {
    const page = await consent.request('/operator/sign-in', {
      headers: headers(credential, {
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
      }),
    });
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain(
      "frame-ancestors 'none'",
    );
    const nonce = (await page.text()).match(/data-nonce="([^"]+)"/)?.[1];
    expect(nonce).toBeTruthy();
    const options = await consent.request('/operator/sign-in/options', {
      method: 'POST',
      headers: headers(credential),
      body: JSON.stringify({ nonce }),
    });
    expect(options.status).toBe(200);
    return options.json() as Promise<{
      ceremonyId: string;
      options: { challenge: string; rpId: string };
    }>;
  }
  async function finish(
    ceremony: Awaited<ReturnType<typeof challenge>>,
    authenticator: SoftwareAuthenticator,
    input: Partial<Parameters<SoftwareAuthenticator['authenticate']>[1]> = {},
    credential = first.credential,
  ) {
    return consent.request('/operator/sign-in/complete', {
      method: 'POST',
      headers: headers(credential),
      body: JSON.stringify({
        ceremonyId: ceremony.ceremonyId,
        response: authenticator.authenticate(ceremony.options, {
          origin: ORIGIN,
          ...input,
        }),
      }),
    });
  }
  async function signIn(credential = first.credential) {
    const enrolled = await enroll();
    const ceremony = await challenge(credential);
    const result = await finish(
      ceremony,
      enrolled.authenticator,
      {},
      credential,
    );
    expect(result.status).toBe(200);
    const setCookie = result.headers.get('set-cookie')!;
    const cookie = `__Host-station-device=${credential}; ${setCookie.split(';')[0]}`;
    return { ...enrolled, cookie, setCookie, ceremony };
  }
  const read = (cookie: string, path = '/api/pairing/devices') =>
    api.request(path, { headers: { cookie, origin: APP } });
  return {
    home,
    channel,
    audit,
    account,
    clock,
    security,
    operator,
    pairing,
    first,
    second,
    pair,
    registry,
    sessionService,
    consent,
    api,
    headers,
    enroll,
    challenge,
    finish,
    signIn,
    read,
  };
}

describe('operator sign-in and device-bound reads (#3257 S3)', () => {
  test('access-change status hides outside-agent ids from every admitted authority (#4164)', async () => {
    const h = await build();
    const signed = await h.signIn();
    const session = h.sessionService.resolve(
      signed.setCookie.split(';')[0].split('=')[1],
      h.first.credential,
    );
    if (!session) throw new Error('operator session fixture');
    const target = {
      kind: 'outside-agent-grant-change',
      subject: 'private-grant',
      fingerprint: 'private-fingerprint',
    };
    const created = h.channel.store.create({
      tenantId: h.channel.tenantId,
      ceremony: 'webauthn',
      operatorSessionId: session.sessionId,
      target,
      requester: { kind: 'operator-session', id: session.sessionId },
      rateKey: session.sessionId,
      description: {
        title: 'Change outside-agent access',
        summary: 'Private outside-agent transaction',
        items: [],
        approveLabel: 'Approve',
        denyLabel: 'Deny',
      },
      revalidateTarget: async () => target,
      commitApproval: vi.fn(),
    });
    if (!created.ok) throw new Error('outside-agent transaction fixture');
    const id = created.transaction.id;
    const audit = structuredClone(h.channel.store.auditTrail('local', id));
    const desktop = h.pair(
      'Desktop operator',
      'access:manage',
      'device',
      false,
      true,
    );
    for (const [cookie, status] of [
      [`__Host-station-device=${h.operator.credential}`, 404],
      [`__Host-station-device=${desktop.credential}`, 401],
      [`__Host-station-device=${h.first.credential}`, 403],
      [signed.cookie, 404],
      ['', 401],
    ] as const) {
      const unknown = await h.read(
        cookie,
        '/api/pairing/device-access-transactions/unknown-id',
      );
      const guarded = await h.read(
        cookie,
        `/api/pairing/device-access-transactions/${id}`,
      );
      expect(unknown.status).toBe(status);
      expect(guarded.status).toBe(unknown.status);
      expect(Buffer.from(await guarded.arrayBuffer())).toEqual(
        Buffer.from(await unknown.arrayBuffer()),
      );
      expect([...guarded.headers]).toEqual([...unknown.headers]);
      expect(h.channel.store.auditTrail('local', id)).toEqual(audit);
    }
    expect(h.channel.store.get('local', id)).toEqual(created.transaction);
  });

  test('consent-origin UV assertion sets a private hashed session; app-origin reads list paired devices', async () => {
    const h = await build();
    const signed = await h.signIn();
    expect(signed.setCookie).toMatch(
      /^__Host-station-operator=[A-Za-z0-9_-]{43}; Secure; HttpOnly; SameSite=Strict; Path=\/; Max-Age=43200$/,
    );
    const response = await h.read(signed.cookie);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      devices: Array<{ id: string }>;
      operatorSession: { expiresAt: number };
    };
    expect(body.devices.map((device: { id: string }) => device.id)).toContain(
      h.second.device.id,
    );
    expect(body.operatorSession.expiresAt).toBe(
      h.clock.now + OPERATOR_SESSION_ABSOLUTE_MS,
    );
    expect(
      await (await h.read(signed.cookie, '/api/operator/session')).json(),
    ).toMatchObject({ signedIn: true });
    expect(
      await (await h.read(signed.cookie, '/api/operator/passkeys')).json(),
    ).toMatchObject({ passkeys: [{ id: signed.passkey.id }] });
    const secret = signed.setCookie.split(';')[0].split('=')[1];
    expect(
      readFileSync(
        join(h.home, 'authentication/operator-passkeys.sqlite'),
      ).includes(Buffer.from(secret)),
    ).toBe(false);
    expect(
      (await h.read(signed.cookie, '/api/pairing/devices/extra')).status,
    ).toBe(403);
    expect(
      (
        (await (await h.read(signed.cookie, '/api/projects')).json()) as {
          authority: string;
        }
      ).authority,
    ).toBe('device-credential');
  });

  test('session leaves do not intercept existing operator endpoints or weaken their admission', async () => {
    const h = await build();
    const signed = await h.signIn();
    const host = await h.api.request('/api/operator/accounts', {
      headers: { authorization: `Bearer ${h.operator.credential}` },
    });
    expect(host.status).toBe(200);
    expect(await host.json()).toMatchObject({
      authority: 'operator-credential',
    });
    expect((await h.read(signed.cookie, '/api/operator/accounts')).status).toBe(
      403,
    );
    const own = await h.api.request('/api/operator/passkeys', {
      headers: { authorization: `Bearer ${h.operator.credential}` },
    });
    expect(own.status).toBe(200);
    expect(await own.json()).toMatchObject({
      passkeys: [{ id: signed.passkey.id }],
    });
  });

  test.each(['valid', 'expired'] as const)(
    'an operator bearer succeeds on read and mutation leaves with a %s operator cookie',
    async (state) => {
      const h = await build();
      const signed = await h.signIn();
      if (state === 'expired') h.clock.now += OPERATOR_SESSION_IDLE_MS;
      const headers = {
        cookie: signed.cookie,
        origin: APP,
        authorization: `Bearer ${h.operator.credential}`,
      };
      expect(
        (await h.api.request('/api/pairing/devices', { headers })).status,
      ).toBe(200);
      const revoked = await h.api.request(
        `/api/pairing/devices/${h.second.device.id}`,
        { method: 'DELETE', headers },
      );
      expect(revoked.status).toBe(200);
      expect(
        h.pairing.listDevices().find((d) => d.id === h.second.device.id)
          ?.revokedAt,
      ).not.toBeNull();
    },
  );

  test.each(['bearer', 'device-cookie'] as const)(
    'access:devices through a %s remains independent of an operator cookie on reads and mutations',
    async (transport) => {
      const h = await build();
      const signed = await h.signIn();
      const admin = h.pair('Device administrator');
      h.pairing.setDeviceScope(
        admin.device.id,
        ['orchestration:read', 'access:devices'],
        { kind: 'presented-credential' },
      );
      const headers = {
        origin: APP,
        cookie:
          transport === 'device-cookie'
            ? signed.cookie.replace(h.first.credential, admin.credential)
            : signed.cookie,
        ...(transport === 'bearer'
          ? { authorization: `Bearer ${admin.credential}` }
          : {}),
      };
      expect(
        (await h.api.request('/api/pairing/devices', { headers })).status,
      ).toBe(200);
      expect(
        (
          await h.api.request(`/api/pairing/devices/${h.second.device.id}`, {
            method: 'DELETE',
            headers,
          })
        ).status,
      ).toBe(200);
      expect(
        h.pairing.listDevices().find((d) => d.id === h.second.device.id)
          ?.revokedAt,
      ).not.toBeNull();
    },
  );

  test.each(['absent', 'junk'] as const)(
    'invalid bearer failures with an %s operator cookie share the ordinary limiter and audit',
    async (cookie) => {
      const h = await build();
      const headers = {
        origin: APP,
        authorization: 'Bearer garbage',
        ...(cookie === 'junk'
          ? { cookie: '__Host-station-operator=junk' }
          : {}),
      };
      for (let attempt = 0; attempt < 10; attempt++) {
        expect(
          (await h.api.request('/api/pairing/devices', { headers })).status,
        ).toBe(401);
      }
      // Both a cookie-charged budget and one tripped without a cookie must
      // refuse the next request before returning a session-specific failure.
      const limited = await h.api.request('/api/pairing/devices', {
        headers: { ...headers, cookie: '__Host-station-operator=junk' },
      });
      expect(limited.status).toBe(429);
      expect(limited.headers.get('Retry-After')).toBe('60');
      expect(h.audit.mock.calls.slice(0, 10).map(([record]) => record)).toEqual(
        Array.from({ length: 10 }, () =>
          expect.objectContaining({
            event: 'station.auth.failure',
            reason: 'credential_invalid',
            path: '/api/pairing/devices',
          }),
        ),
      );
      expect(h.audit).toHaveBeenLastCalledWith(
        expect.objectContaining({
          event: 'station.auth.rate_limited',
          reason: 'too_many_failures',
        }),
      );
    },
  );

  test('background polls validate expiry without extending idle time; a user read extends it', async () => {
    const h = await build();
    const signed = await h.signIn();
    const poll = () =>
      h.api.request('/api/pairing/devices', {
        headers: {
          cookie: signed.cookie,
          origin: APP,
          'X-Station-Background-Refresh': '1',
        },
      });
    const start = h.clock.now;
    for (
      let elapsed = 15_000;
      elapsed < OPERATOR_SESSION_IDLE_MS;
      elapsed += 15_000
    ) {
      h.clock.now = start + elapsed;
      expect((await poll()).status).toBe(200);
    }
    h.clock.now = start + OPERATOR_SESSION_IDLE_MS;
    expect((await poll()).status).toBe(403);

    const next = await h.signIn();
    h.clock.now += OPERATOR_SESSION_IDLE_MS - 1;
    expect((await h.read(next.cookie)).status).toBe(200);
    h.clock.now += OPERATOR_SESSION_IDLE_MS - 1;
    expect((await h.read(next.cookie)).status).toBe(200);
  });

  test('a live operator session cannot bypass the binding device account-session gate', async () => {
    const h = await build({ accountBound: true });
    const signed = await h.signIn();
    expect(
      h.security.authorizeCredential(h.first.credential, {
        method: 'GET',
        path: '/api/auth/authority',
      }),
    ).toBe(true);
    expect(
      h.sessionService.resolve(
        signed.setCookie.split(';')[0].split('=')[1],
        h.first.credential,
      ),
    ).not.toBeNull();
    const response = await h.read(signed.cookie);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: 'account_authentication_required' },
    });
  });

  test('disabling the binding account refuses reads under a still-live operator session', async () => {
    const h = await build({ accountBound: true });
    const signed = await h.signIn();
    const secret = signed.setCookie.split(';')[0].split('=')[1];
    expect(h.sessionService.resolve(secret, h.first.credential)).not.toBeNull();
    h.account.disabled = true;
    const response = await h.read(`${signed.cookie}; fixture_account=valid`);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: 'account_authentication_invalid' },
    });
    expect(h.registry.existing()!.session(secret)).not.toBeNull();
  });

  test.each(['expired', 'missing', 'malformed'] as const)(
    'sign-out clears a %s cookie after valid nonce and origin checks',
    async (state) => {
      const h = await build();
      const signed = await h.signIn();
      h.clock.now += OPERATOR_SESSION_IDLE_MS;
      const nonce = h.sessionService.renderNonce(h.first.credential);
      const cookie =
        state === 'missing'
          ? `__Host-station-device=${h.first.credential}`
          : state === 'malformed'
            ? signed.cookie.replace(
                /__Host-station-operator=[^;]+/,
                '__Host-station-operator=invalid',
              )
            : signed.cookie;
      const result = await h.consent.request('/operator/sign-out', {
        method: 'POST',
        headers: h.headers(h.first.credential, { cookie }),
        body: JSON.stringify({ nonce }),
      });
      expect(result.status).toBe(200);
      expect(result.headers.get('set-cookie')).toContain('Max-Age=0');
    },
  );

  test.each(['/operator/sign-in', '/operator/sign-out'])(
    '%s refuses cross-site navigation before charging the per-device budget',
    async (path) => {
      const h = await build();
      const navigate = (site: string) =>
        h.consent.request(path, {
          headers: h.headers(h.first.credential, {
            'sec-fetch-site': site,
            'sec-fetch-mode': 'navigate',
            'sec-fetch-dest': 'document',
          }),
        });
      for (let i = 0; i < 6; i++)
        expect((await navigate('cross-site')).status).toBe(403);
      for (const site of ['same-origin', 'same-site', 'none'])
        expect((await navigate(site)).status).toBe(200);
      expect((await navigate('none')).status).toBe(200);
      expect((await navigate('none')).status).toBe(200);
      expect((await navigate('none')).status).toBe(429);
    },
  );

  test('session persistence retains hashed bindings and server-side idle expiry after reopening', async () => {
    const h = await build();
    const signed = await h.signIn();
    h.registry.close();
    h.clock.now += OPERATOR_SESSION_IDLE_MS - 1;
    expect((await h.read(signed.cookie)).status).toBe(200);
    h.registry.close();
    h.clock.now += OPERATOR_SESSION_IDLE_MS;
    expect((await h.read(signed.cookie)).status).toBe(403);
  });

  test('challenge and render nonce expiry, replacement and rate limits fail closed', async () => {
    const h = await build();
    const { authenticator } = await h.enroll();
    const ceremony = await h.challenge();
    h.clock.now += 2 * 60_000;
    expect((await h.finish(ceremony, authenticator)).status).toBe(401);
    const nonce = h.sessionService.renderNonce(h.first.credential);
    await h.sessionService.options(nonce, h.first.credential);
    await expect(
      h.sessionService.options(nonce, h.first.credential),
    ).rejects.toMatchObject({ code: 'challenge_invalid' });
    for (let index = 0; index < 4; index++)
      h.sessionService.renderNonce(h.first.credential);
    expect(() => h.sessionService.renderNonce(h.first.credential)).toThrow(
      'rate_limited',
    );
  });

  test('consent-origin sign-out consumes its nonce, clears the cookie, and ends reads', async () => {
    const h = await build();
    const signed = await h.signIn();
    const page = await h.consent.request('/operator/sign-out', {
      headers: h.headers(h.first.credential, {
        cookie: signed.cookie,
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
      }),
    });
    expect(page.status).toBe(200);
    const nonce = (await page.text()).match(/data-nonce="([^"]+)"/)?.[1];
    expect(nonce).toBeTruthy();
    const init = {
      method: 'POST',
      headers: h.headers(h.first.credential, { cookie: signed.cookie }),
      body: JSON.stringify({ nonce }),
    };
    const out = await h.consent.request('/operator/sign-out', init);
    expect(out.status).toBe(200);
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await h.read(signed.cookie)).status).toBe(403);
    expect((await h.consent.request('/operator/sign-out', init)).status).toBe(
      401,
    );
  });

  test.each(['expired', 'other-device', 'invalid'] as const)(
    '%s session refuses every device-admin leaf without mutation or fallback',
    async (fault) => {
      const h = await build();
      const signed = await h.signIn();
      let cookie = signed.cookie;
      if (fault === 'expired') h.clock.now += OPERATOR_SESSION_IDLE_MS;
      if (fault === 'other-device')
        cookie = cookie.replace(h.first.credential, h.second.credential);
      if (fault === 'invalid')
        cookie = cookie.replace(
          /__Host-station-operator=[^;]+/,
          '__Host-station-operator=invalid',
        );
      for (const [method, path] of [
        ['GET', '/api/pairing/devices'],
        ['POST', `/api/pairing/devices/${h.second.device.id}/scope`],
        ['DELETE', `/api/pairing/devices/${h.second.device.id}`],
        ['DELETE', `/api/pairing/devices/${h.second.device.id}/record`],
      ]) {
        const result = await h.api.request(path, {
          method,
          headers: { cookie, origin: APP, 'content-type': 'application/json' },
          body:
            method === 'POST'
              ? JSON.stringify({
                  scope: ['orchestration:read'],
                  expectedScope: h.second.device.scope,
                })
              : undefined,
        });
        expect(result.status).toBe(403);
        expect(await result.json()).toMatchObject({
          error: { code: 'operator_session_required' },
        });
      }
      expect(
        h.pairing
          .listDevices()
          .find((device) => device.id === h.second.device.id),
      ).toMatchObject({ scope: h.second.device.scope, revokedAt: null });
    },
  );

  test.each(['origin', 'rp', 'uv', 'up', 'unknown', 'counter'] as const)(
    'refuses an assertion with invalid %s',
    async (fault) => {
      const h = await build();
      const { authenticator } = await h.enroll();
      if (fault === 'counter')
        expect(
          (await h.finish(await h.challenge(), authenticator, { counter: 5 }))
            .status,
        ).toBe(200);
      const ceremony = await h.challenge();
      const result = await h.finish(
        ceremony,
        fault === 'unknown' ? new SoftwareAuthenticator() : authenticator,
        {
          ...(fault === 'origin' ? { origin: APP } : {}),
          ...(fault === 'rp' ? { rpId: 'wrong.example.test' } : {}),
          ...(fault === 'uv' ? { userVerified: false } : {}),
          ...(fault === 'up' ? { userPresent: false } : {}),
        },
      );
      expect(result.status).toBe(401);
      expect(await result.json()).toMatchObject({
        error: 'verification_failed',
      });
      expect(result.headers.get('set-cookie')).toBeNull();
    },
  );

  test('challenge consumption is atomic under replay and bound to the requesting device', async () => {
    const h = await build();
    const { authenticator } = await h.enroll();
    const ceremony = await h.challenge();
    const responses = await Promise.all([
      h.finish(ceremony, authenticator),
      h.finish(ceremony, authenticator),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 401]);
    const other = await h.challenge();
    expect(
      (
        await h.finish(
          other,
          authenticator,
          { counter: 2 },
          h.second.credential,
        )
      ).status,
    ).toBe(401);
    expect((await h.finish(other, authenticator, { counter: 2 })).status).toBe(
      401,
    );
  });

  test('idle expiry refuses SDK inventory reads without invalidating the admitted device credential', async () => {
    const h = await build();
    const signed = await h.signIn();
    let credential: string | undefined = h.first.credential;
    const onUnauthorized = vi.fn(() => {
      credential = undefined;
    });
    setClientCredentialResolver(() => ({
      origin: APP,
      onUnauthorized,
    }));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set('cookie', signed.cookie);
      headers.set('origin', APP);
      return h.api.request(String(input), { ...init, headers });
    });
    expect((await fetchPairedDevices(APP)).map((d) => d.id)).toContain(
      h.first.device.id,
    );
    h.clock.now += OPERATOR_SESSION_IDLE_MS;
    await expect(fetchPairedDevices(APP)).rejects.toBeInstanceOf(
      StationHttpError,
    );
    await expect(fetchPairedDevices(APP)).rejects.toMatchObject({
      status: 403,
    });
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(credential).toBe(h.first.credential);
    expect(await (await h.read(signed.cookie)).json()).toMatchObject({
      error: { code: 'operator_session_required' },
      signInUrl: `${ORIGIN}/operator/sign-in`,
    });

    h.pairing.revokeDevice(h.first.device.id, 'operator-credential');
    await expect(fetchPairedDevices(APP)).rejects.toMatchObject({
      status: 401,
    });
    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect(credential).toBeUndefined();
  });

  test.each(['valid', 'expired', 'other-device', 'revoked'] as const)(
    'SDK bearer with a %s operator cookie distinguishes live and revoked devices on reads and mutations',
    async (state) => {
      const h = await build();
      const signed = await h.signIn(
        state === 'other-device' ? h.second.credential : h.first.credential,
      );
      if (state === 'expired') h.clock.now += OPERATOR_SESSION_IDLE_MS;
      if (state === 'revoked')
        h.pairing.revokeDevice(h.first.device.id, 'operator-credential');
      expect(h.security.verifyCredential(h.first.credential)).toBe(
        state !== 'revoked',
      );
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const headers = new Headers(init?.headers);
        expect(headers.get('authorization')).toBe(
          `Bearer ${h.first.credential}`,
        );
        // Native bearer and host-scoped operator cookie, with no device cookie.
        headers.set('cookie', signed.setCookie.split(';')[0]);
        headers.set('origin', APP);
        return h.api.request(String(input), { ...init, headers });
      });
      for (const method of ['GET', 'DELETE']) {
        const onUnauthorized = vi.fn();
        setClientCredentialResolver(() => ({
          origin: APP,
          credential: h.first.credential,
          onUnauthorized,
        }));
        const status = state === 'revoked' ? 401 : 403;
        if (method === 'GET') {
          await expect(fetchPairedDevices(APP)).rejects.toMatchObject({
            status,
          });
        } else {
          const response = await authenticatedFetch(
            `${APP}/api/pairing/devices/${h.second.device.id}`,
            { method },
          );
          expect(response.status).toBe(status);
          expect(await response.json()).toMatchObject({
            error: { code: 'operator_session_required' },
          });
        }
        expect(onUnauthorized).toHaveBeenCalledTimes(
          state === 'revoked' ? 1 : 0,
        );
      }
      expect(
        h.pairing.listDevices().find((d) => d.id === h.second.device.id)
          ?.revokedAt,
      ).toBeNull();
    },
  );

  test('an alias-bound operator session still requires its proof-bound account continuation', async () => {
    const h = await build();
    const alias = h.pairing.issueRelayCredentialAlias(
      h.first.credential,
      h.first.device.id,
    );
    const signed = await h.signIn(alias.credential);
    expect(h.security.identifyDevice(alias.credential)?.id).toBe(
      h.first.device.id,
    );
    expect(
      h.security.authorizeCredential(alias.credential, {
        method: 'GET',
        path: '/api/auth/authority',
      }),
    ).toBe(true);
    expect(
      h.sessionService.resolve(
        signed.setCookie.split(';')[0].split('=')[1],
        alias.credential,
      ),
    ).not.toBeNull();
    for (const cookie of [
      signed.cookie,
      `${signed.cookie}; fixture_account=valid`,
    ]) {
      const response = await h.read(cookie);
      expect({
        status: response.status,
        body: await response.json(),
      }).toMatchObject({
        status: 401,
        body: { error: { code: 'account_authentication_required' } },
      });
    }
    const ordinary = await h.signIn();
    expect((await h.read(ordinary.cookie)).status).toBe(200);
  });

  test.each(['/api/operator/session', '/api/pairing/devices'])(
    'SDK alias bearer reports account continuation failure before operator-session fallback on %s',
    async (path) => {
      const h = await build();
      const alias = h.pairing.issueRelayCredentialAlias(
        h.first.credential,
        h.first.device.id,
      );
      const signed = await h.signIn(alias.credential);
      const onUnauthorized = vi.fn();
      const onAccountUnauthorized = vi.fn();
      setClientCredentialResolver(() => ({
        origin: APP,
        credential: alias.credential,
        onUnauthorized,
        onAccountUnauthorized,
      }));
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set('cookie', signed.setCookie.split(';')[0]);
        headers.set('origin', APP);
        return h.api.request(String(input), { ...init, headers });
      });
      const response = await authenticatedFetch(`${APP}${path}`);
      expect(response.status).toBe(401);
      expect(response.headers.get('X-Station-Authentication-Failure')).toBe(
        'account',
      );
      expect(await response.json()).toMatchObject({
        error: { code: 'account_authentication_required' },
      });
      expect(onAccountUnauthorized).toHaveBeenCalledOnce();
      expect(onUnauthorized).not.toHaveBeenCalled();
    },
  );

  test('operator-session admission clears the home-possession bearer local-operator flag', async () => {
    const h = await build();
    const signed = await h.signIn();
    const local = h.pair(
      'Host device',
      'orchestration:read',
      'device',
      false,
      true,
    );
    const headers = {
      authorization: `Bearer ${local.credential}`,
      cookie: signed.cookie,
      origin: APP,
    };
    const deviceRead = await h.api.request('/api/projects', { headers });
    expect(deviceRead.status).toBe(200);
    expect(deviceRead.headers.get('X-Fixture-Local-Operator')).toBe('true');
    expect(await deviceRead.json()).toMatchObject({
      authority: 'device-credential',
    });
    const sessionRead = await h.api.request('/api/pairing/devices', {
      headers,
    });
    expect(sessionRead.status).toBe(200);
    expect(await sessionRead.json()).toHaveProperty('operatorSession');
    expect(sessionRead.headers.get('X-Fixture-Local-Operator')).toBe('false');
  });

  test('absolute expiry wins over recent activity, at the boundary and after it', async () => {
    const h = await build();
    const signed = await h.signIn();
    for (
      let elapsed = OPERATOR_SESSION_IDLE_MS - 1;
      elapsed < OPERATOR_SESSION_ABSOLUTE_MS;
      elapsed += OPERATOR_SESSION_IDLE_MS - 1
    ) {
      h.clock.now = 1_800_000_000_000 + elapsed;
      expect((await h.read(signed.cookie)).status).toBe(200);
    }
    h.clock.now = 1_800_000_000_000 + OPERATOR_SESSION_ABSOLUTE_MS;
    expect((await h.read(signed.cookie)).status).toBe(403);
    h.clock.now++;
    expect((await h.read(signed.cookie)).status).toBe(403);
  });

  test('a session cannot read with another device cookie or with no live paired cookie', async () => {
    const h = await build();
    const signed = await h.signIn();
    const other = signed.cookie.replace(
      h.first.credential,
      h.second.credential,
    );
    expect((await h.read(other)).status).toBe(403);
    expect((await h.read(signed.setCookie.split(';')[0])).status).toBe(401);
    expect((await h.read(signed.cookie)).status).toBe(200);
    expect(
      (
        await h.read(
          signed.cookie.replace(
            /__Host-station-operator=[^;]+/,
            '__Host-station-operator=invalid',
          ),
        )
      ).status,
    ).toBe(403);
    expect(
      (await h.read(`${signed.cookie}; ${signed.setCookie.split(';')[0]}`))
        .status,
    ).toBe(403);
  });

  test.each(['device', 'passkey', 'rotation', 'reset'] as const)(
    '%s revocation ends existing sessions',
    async (event) => {
      const h = await build();
      const signed = await h.signIn();
      if (event === 'device')
        h.pairing.revokeDevice(h.first.device.id, 'operator-credential');
      if (event === 'passkey') h.registry.existing()!.revoke(signed.passkey.id);
      if (event === 'rotation') await h.security.rotateCredential();
      if (event === 'reset') await h.security.resetEnvironment();
      expect((await h.read(signed.cookie)).status).toBe(
        event === 'device' || event === 'reset' ? 401 : 403,
      );
    },
  );

  test('app-origin operator-session writes return 202 and no mutation; unrelated mutations refuse', async () => {
    const h = await build();
    const signed = await h.signIn();
    const scopePath = `/api/pairing/devices/${h.second.device.id}/scope`;
    const hostScope = (scope: string[], expectedScope: string) =>
      h.api.request(scopePath, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${h.operator.credential}`,
          origin: APP,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ scope, expectedScope }),
      });
    const promoted = await hostScope(
      ['orchestration:read', 'orchestration:operate'],
      h.second.device.scope,
    );
    expect(promoted.status).toBe(200);
    const current = h.pairing
      .listDevices()
      .find((device) => device.id === h.second.device.id)!;
    expect(current.scope).toContain('orchestration:operate');
    const restored = await hostScope(['orchestration:read'], current.scope);
    expect(restored.status).toBe(200);
    const revoked = h.pair('Revoked browser');
    h.pairing.revokeDevice(revoked.device.id, 'operator-credential');
    const before = h.pairing.listDevices();
    for (const [method, path] of [
      ['POST', `/api/pairing/devices/${h.second.device.id}/scope`],
      ['DELETE', `/api/pairing/devices/${h.second.device.id}`],
      ['DELETE', `/api/pairing/devices/${revoked.device.id}/record`],
      ['DELETE', '/api/operator/session'],
    ]) {
      const response = await h.api.request(path, {
        method,
        headers: {
          cookie: signed.cookie,
          origin: APP,
          'content-type': 'application/json',
        },
        body:
          method === 'POST'
            ? JSON.stringify({
                scope: ['orchestration:read', 'orchestration:operate'],
                expectedScope: h.second.device.scope,
              })
            : undefined,
      });
      if (path === '/api/operator/session') {
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({
          error: { code: 'insufficient_scope' },
        });
      } else {
        expect(response.status).toBe(202);
        expect(await response.json()).toMatchObject({
          status: 'step_up_required',
          transaction: { reviewUrl: expect.stringContaining(ORIGIN) },
        });
      }
    }
    const host = await h.api.request('/api/pairing/devices', {
      headers: { authorization: `Bearer ${h.operator.credential}` },
    });
    expect(host.status).toBe(200);
    expect(
      (
        (await host.json()) as {
          devices: Array<{
            id: string;
            scope: string;
            revokedAt: number | null;
          }>;
        }
      ).devices.map(
        ({
          id,
          scope,
          revokedAt,
        }: {
          id: string;
          scope: string;
          revokedAt: number | null;
        }) => ({ id, scope, revokedAt }),
      ),
    ).toEqual(
      before.map(({ id, scope, revokedAt }) => ({ id, scope, revokedAt })),
    );
  });

  test.each([
    'orchestration:read',
    'access:manage',
    'access:approve',
    'consent:decide',
    'delegation',
  ])(
    'unpromoted %s device stays refused on the S3 device-admin leaves',
    async (scope) => {
      const h = await build();
      const device = h.pair(
        'Unpromoted',
        scope === 'delegation' ? 'orchestration:read' : scope,
        scope === 'delegation' ? 'delegation' : 'device',
      );
      for (const [method, path] of [
        ['GET', '/api/pairing/devices'],
        ['GET', '/api/pairing/device-access-transactions/unknown'],
        ['PUT', '/api/pairing/people/human:test:casey/group'],
        ['POST', '/api/pairing/people/human:test:casey/tokens'],
        ['DELETE', '/api/pairing/people/human:test:casey/tokens/unknown'],
        ['DELETE', '/api/pairing/operator-passkeys/unknown'],
        ['POST', `/api/pairing/devices/${h.second.device.id}/scope`],
        ['DELETE', `/api/pairing/devices/${h.second.device.id}`],
        ['DELETE', `/api/pairing/devices/${h.second.device.id}/record`],
      ]) {
        const response = await h.api.request(path, {
          method,
          headers: {
            cookie: `__Host-station-device=${device.credential}`,
            origin: APP,
          },
        });
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({
          error: { code: 'insufficient_scope' },
        });
      }
    },
  );

  test.each(['origin', 'host', 'metadata', 'cookie', 'nonce', 'json'] as const)(
    'sign-in options refuses missing or wrong %s',
    async (missing) => {
      const h = await build();
      await h.enroll();
      const nonce = h.sessionService.renderNonce(h.first.credential);
      const headers = h.headers();
      if (missing === 'origin') headers.origin = APP;
      if (missing === 'host') headers.host = new URL(APP).host;
      if (missing === 'metadata') headers['sec-fetch-site'] = 'same-site';
      if (missing === 'cookie') headers.cookie = '';
      if (missing === 'json') headers['content-type'] = 'text/plain';
      const response = await h.consent.request('/operator/sign-in/options', {
        method: 'POST',
        headers,
        body: JSON.stringify({ nonce: missing === 'nonce' ? 'wrong' : nonce }),
      });
      expect(response.status).toBe(
        missing === 'nonce' || missing === 'cookie'
          ? 401
          : missing === 'json'
            ? 400
            : 403,
      );
    },
  );

  test.each([{ origin: null }, { hosted: true }])(
    'no remote sign-in without configured consent origin or on hosted tenants: %j',
    async (options) => {
      const h = await build(options);
      expect(
        (await h.consent.request('/operator/sign-in', { headers: h.headers() }))
          .status,
      ).toBe(503);
      expect(
        (
          await h.consent.request('/operator/sign-in/options', {
            method: 'POST',
            headers: h.headers(),
            body: '{}',
          })
        ).status,
      ).toBe(503);
      const passkeys = await h.api.request('/api/operator/passkeys', {
        headers: { authorization: `Bearer ${h.operator.credential}` },
      });
      expect(passkeys.status).toBe(options.hosted ? 503 : 200);
      if (options.hosted)
        expect(await passkeys.json()).toMatchObject({
          error: { code: 'sign_in_unavailable' },
        });
      expect(h.registry.existing()).toBeNull();
    },
  );
});

type StepUpHarness = Awaited<ReturnType<typeof build>>;
type SignedOperator = Awaited<ReturnType<StepUpHarness['signIn']>>;
async function requestChange(
  h: StepUpHarness,
  signed: SignedOperator,
  method = 'POST',
  path = `/api/pairing/devices/${h.second.device.id}/scope`,
  body: unknown = {
    scope: ['orchestration:read', 'orchestration:operate'],
    expectedScope: h.second.device.scope,
  },
) {
  const response = await h.api.request(path, {
    method,
    headers: {
      cookie: signed.cookie,
      origin: APP,
      'content-type': 'application/json',
    },
    ...(method === 'DELETE' ? {} : { body: JSON.stringify(body) }),
  });
  expect(response.status).toBe(202);
  return (
    await readJson<{
      transaction: { id: string; reviewUrl: string; expiresAt: number };
    }>(response)
  ).transaction;
}
async function reviewChange(
  h: StepUpHarness,
  signed: SignedOperator,
  id: string,
) {
  const response = await h.consent.request(`/consent/${id}`, {
    headers: {
      ...h.headers(),
      cookie: signed.cookie,
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
    },
  });
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(response.headers.get('content-security-policy')).toContain(
    "script-src 'nonce-",
  );
  const nonce = html.match(/name="nonce" value="([^"]+)"/)![1];
  const options = JSON.parse(
    html
      .match(/data-options="([^"]+)"/)![1]
      .replaceAll('&quot;', '"')
      .replaceAll('&amp;', '&'),
  ) as { challenge: string; rpId: string };
  return { nonce, options, html };
}
async function commitChange(
  h: StepUpHarness,
  signed: SignedOperator,
  id: string,
  review: Pick<Awaited<ReturnType<typeof reviewChange>>, 'nonce' | 'options'>,
  counter = 2,
  input: Partial<Parameters<SoftwareAuthenticator['authenticate']>[1]> = {},
) {
  return h.consent.request(`/consent/${id}/decide`, {
    method: 'POST',
    headers: {
      ...h.headers(),
      cookie: signed.cookie,
    },
    body: JSON.stringify({
      nonce: review.nonce,
      response: signed.authenticator.authenticate(review.options, {
        origin: ORIGIN,
        counter,
        ...input,
      }),
    }),
  });
}

async function reviewRefusalText(
  html: string,
  result: Response,
): Promise<string> {
  let submit!: (event: unknown) => Promise<void>;
  const status = { textContent: '', setAttribute() {} };
  const form = {
    action: '/consent/action/decide',
    elements: { nonce: { value: 'rendered-nonce' } },
    querySelectorAll: () => [],
    after() {},
    addEventListener: (_name: string, handler: typeof submit) => {
      submit = handler;
    },
  };
  const script = html.match(
    /<script type="module" nonce="[^"]+">([\s\S]*?)<\/script>/,
  )![1];
  runInNewContext(script, {
    document: { querySelector: () => form, createElement: () => status },
    fetch: async () => result,
  });
  await submit({ preventDefault() {}, submitter: { value: 'deny' } });
  return status.textContent;
}

describe('per-action operator passkey step-up (#3257 S4)', () => {
  test('People and token controls are unreachable with operator-session authority', async () => {
    const h = await build(),
      signed = await h.signIn();
    const people = await h.read(signed.cookie, '/api/pairing/people');
    expect(people.status).toBe(403);
    expect(await people.json()).toMatchObject({
      error: { code: 'insufficient_scope' },
    });
    // Desktop home possession can read People, but is independently admitted:
    // its session cookie does not turn its writes into step-up requests.
    const local = h.pair('Desktop', 'access:manage', 'device', false, true);
    const cookie = `__Host-station-device=${local.credential}; ${signed.setCookie.split(';')[0]}`;
    const headers = {
      authorization: `Bearer ${local.credential}`,
      cookie,
      origin: APP,
      'content-type': 'application/json',
    };
    expect(
      (await h.api.request('/api/pairing/people', { headers })).status,
    ).toBe(200);
    for (const [method, path, body] of [
      ['PUT', '/api/pairing/people/human:test:casey/group', { group: 'admin' }],
      [
        'POST',
        '/api/pairing/people/human:test:casey/tokens',
        { name: 'CI', scope: 'orchestration:read' },
      ],
      [
        'DELETE',
        '/api/pairing/people/human:test:casey/tokens/token-id',
        undefined,
      ],
    ] as const) {
      const result = await h.api.request(path, {
        method,
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      expect(result.status).toBe(401);
      expect(await result.json()).toEqual({ error: 'authentication_required' });
    }
  });

  test.each([
    'grant',
    'revoke',
    'remove-full-access',
    'remove-record',
    'retain-full-access',
  ] as const)('full access warning describes only a grant: %s', async (op) => {
    const h = await build(),
      signed = await h.signIn();
    const full = ['orchestration:read', 'approval:full-access'] as const;
    if (op !== 'grant')
      h.pairing.setDeviceScope(h.second.device.id, [...full], {
        kind: 'presented-credential',
      });
    if (op === 'remove-record')
      h.pairing.revokeDevice(h.second.device.id, 'operator-credential');
    const path = `/api/pairing/devices/${h.second.device.id}`;
    const transaction =
      op === 'revoke' || op === 'remove-record'
        ? await requestChange(
            h,
            signed,
            'DELETE',
            path + (op === 'remove-record' ? '/record' : ''),
          )
        : await requestChange(h, signed, 'POST', path + '/scope', {
            scope:
              op === 'remove-full-access' ? ['orchestration:read'] : [...full],
          });
    await reviewChange(h, signed, transaction.id);
    const description = h.channel.store.get(
      h.channel.tenantId,
      transaction.id,
    )!.description;
    expect(description.warning).toBe(
      op === 'grant'
        ? 'Full access allows this Device to grant unrestricted agent execution.'
        : undefined,
    );
  });

  test.each(['group', 'mint', 'revoke'] as const)(
    '%s rechecks session and target after a host write inside mutation acquisition',
    async (op) => {
      const h = await build(),
        signed = await h.signIn();
      const principalId = 'human:tailscale-serve:casey';
      const offer = h.pairing.createOffer({
        endpoint: APP,
        scope: 'orchestration:read',
      });
      const pending = h.pairing.requestPairing({
        offerId: offer.offerId,
        proof: offer.challenge,
        deviceName: 'Casey',
        source: 'tailnet',
        requesterPosition: 'off-box',
        requester: { provider: 'tailscale-serve', login: 'casey' },
      });
      h.pairing.confirmRequest(
        pending.requestId,
        { kind: 'presented-credential' },
        { kind: 'verified-ingress', principalId },
      );
      const personDevice = h.pairing.exchange({
        offerId: offer.offerId,
        proof: offer.challenge,
        requestId: pending.requestId,
      });
      const existing = await h.pairing.mintPersonalToken({
        name: 'Existing',
        ownerPrincipalId: principalId,
        binding: personDevice.device.principalBinding!,
        scope: 'orchestration:read',
        expiresAt: null,
      });
      const path = `/api/pairing/people/${principalId}`;
      const transaction =
        op === 'group'
          ? await requestChange(h, signed, 'PUT', `${path}/group`, {
              group: 'admin',
            })
          : op === 'mint'
            ? await requestChange(h, signed, 'POST', `${path}/tokens`, {
                name: 'New',
                scope: 'orchestration:read',
              })
            : await requestChange(
                h,
                signed,
                'DELETE',
                `${path}/tokens/${existing.token.id}`,
              );
      const review = await reviewChange(h, signed, transaction.id);
      const html = review.html;
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const resume = new Promise<void>((resolve) => {
        release = resolve;
      });
      const acquire = fileLocks.acquireFileMutationLockAsync;
      const lock = vi
        .spyOn(fileLocks, 'acquireFileMutationLockAsync')
        .mockImplementationOnce(async (...args) => {
          expect(args[0]).toBe(
            join(
              h.home,
              'security',
              op === 'group'
                ? 'station-groups.json.mutation'
                : 'personal-tokens.json.mutation',
            ),
          );
          enter();
          await resume;
          return acquire(...args);
        });
      const committing = commitChange(h, signed, transaction.id, review);
      try {
        await entered;
        if (op === 'mint') await h.security.assignGroup(principalId, 'admin');
        else h.pairing.revokeDevice(h.first.device.id, 'operator-credential');
      } finally {
        release();
        lock.mockRestore();
      }
      const result = await committing;
      expect(result.status).toBe(409);
      const reason = op === 'mint' ? 'target_changed' : 'session_ended';
      expect(await result.clone().json()).toMatchObject({ error: reason });
      expect(await reviewRefusalText(html, result)).toBe(
        op === 'mint'
          ? 'This changed since you asked. Nothing was applied; open a new request.'
          : 'Your operator session ended; sign in again. Nothing was applied.',
      );
      expect(
        h.channel.store.get(h.channel.tenantId, transaction.id)?.status,
      ).toBe(reason);
      expect(
        h.channel.store.auditTrail(h.channel.tenantId, transaction.id),
      ).toContainEqual({
        at: h.clock.now,
        event: 'closed',
        detail: reason,
      });
      expect(h.security.groupOf(principalId)).toBe(
        op === 'mint' ? 'admin' : 'member',
      );
      expect(
        h.pairing.listPersonalTokens(principalId).map((token) => token.id),
      ).toEqual([existing.token.id]);
    },
  );

  test('Cancel denies on the server without a passkey and a later approve cannot commit', async () => {
    const h = await build(),
      signed = await h.signIn();
    const transaction = await requestChange(h, signed);
    const review = await reviewChange(h, signed, transaction.id);
    const deny = await h.consent.request(`/consent/${transaction.id}/decide`, {
      method: 'POST',
      headers: { ...h.headers(), cookie: signed.cookie },
      body: JSON.stringify({ decision: 'deny', nonce: review.nonce }),
    });
    expect(deny.status).toBe(200);
    expect(await deny.json()).toEqual({ status: 'denied' });
    const status = await h.read(
      signed.cookie,
      `/api/pairing/device-access-transactions/${transaction.id}`,
    );
    expect(await status.json()).toMatchObject({ status: 'denied' });
    const later = await commitChange(h, signed, transaction.id, review);
    expect(later.status).toBe(409);
    expect(await later.json()).toEqual({ error: 'not_pending' });
    expect(
      h.pairing.listDevices().find((d) => d.id === h.second.device.id)?.scope,
    ).toBe(h.second.device.scope);
  });

  test.each([
    'origin',
    'host',
    'metadata',
    'nonce',
    'device cookie',
    'operator cookie',
    'other session',
  ])(
    'Cancel refuses a missing or wrong %s without closing the transaction',
    async (missing) => {
      const h = await build(),
        signed = await h.signIn();
      const transaction = await requestChange(h, signed),
        review = await reviewChange(h, signed, transaction.id);
      const headers = { ...h.headers(), cookie: signed.cookie };
      if (missing === 'origin') headers.origin = APP;
      if (missing === 'host') headers.host = new URL(APP).host;
      if (missing === 'metadata') headers['sec-fetch-site'] = 'same-site';
      if (missing === 'device cookie')
        headers.cookie = signed.cookie.split('; ')[1];
      if (missing === 'operator cookie')
        headers.cookie = signed.cookie.split('; ')[0];
      if (missing === 'other session')
        headers.cookie = (await h.signIn(h.second.credential)).cookie;
      const result = await h.consent.request(
        `/consent/${transaction.id}/decide`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            decision: 'deny',
            nonce: missing === 'nonce' ? 'wrong' : review.nonce,
          }),
        },
      );
      expect(result.status).toBe(
        missing.includes('cookie') || missing === 'other session'
          ? 404
          : missing === 'nonce'
            ? 409
            : 403,
      );
      expect(
        h.channel.store.get(h.channel.tenantId, transaction.id)?.status,
      ).toBe('pending');
    },
  );

  test('one assertion commits one device change, response effect matches the direct body and replay refuses', async () => {
    const h = await build(),
      signed = await h.signIn();
    const transaction = await requestChange(h, signed);
    expect(
      h.pairing.listDevices().find((d) => d.id === h.second.device.id)?.scope,
    ).toBe(h.second.device.scope);
    const review = await reviewChange(h, signed, transaction.id);
    const before = h.registry
      .existing()!
      .session(signed.setCookie.split(';')[0].split('=')[1])!;
    expect((await commitChange(h, signed, transaction.id, review)).status).toBe(
      200,
    );
    const status = await h.read(
      signed.cookie,
      `/api/pairing/device-access-transactions/${transaction.id}`,
    );
    expect(status.status).toBe(200);
    const body = await readJson<{ effect: Record<string, unknown> }>(status);
    const direct = await h.api.request(
      `/api/pairing/devices/${h.second.device.id}/scope`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${h.operator.credential}`,
          'content-type': 'application/json',
          origin: APP,
        },
        body: JSON.stringify({
          scope: ['orchestration:read', 'orchestration:operate'],
        }),
      },
    );
    expect(JSON.stringify(body.effect)).toBe(await direct.text());
    expect((await commitChange(h, signed, transaction.id, review)).status).toBe(
      409,
    );
    const after = h.registry
      .existing()!
      .session(signed.setCookie.split(';')[0].split('=')[1])!;
    expect(after.lastUsedAt).toBe(before.lastUsedAt);
    expect(after.expiresAt).toBe(before.expiresAt);
    const next = await requestChange(
      h,
      signed,
      'DELETE',
      `/api/pairing/devices/${h.second.device.id}`,
    );
    expect((await commitChange(h, signed, next.id, review)).status).toBe(409);
    expect(
      h.pairing.listDevices().find((d) => d.id === h.second.device.id)
        ?.revokedAt,
    ).toBeNull();
  });

  test('an assertion for A cannot commit B even with B’s valid nonce', async () => {
    const h = await build(),
      signed = await h.signIn();
    const a = await requestChange(h, signed),
      b = await requestChange(h, signed);
    const ar = await reviewChange(h, signed, a.id),
      br = await reviewChange(h, signed, b.id);
    const result = await commitChange(h, signed, b.id, {
      nonce: br.nonce,
      options: ar.options,
    });
    expect(result.status).toBe(409);
    expect(await result.json()).toEqual({ error: 'authority_required' });
    expect(
      h.pairing.listDevices().find((d) => d.id === h.second.device.id)?.scope,
    ).toBe(h.second.device.scope);
  });

  test('target_changed is terminal even after A to B to A and preserves the host’s change', async () => {
    const h = await build(),
      signed = await h.signIn();
    const t = await requestChange(h, signed),
      r = await reviewChange(h, signed, t.id);
    const changed = h.pairing.setDeviceScope(
      h.second.device.id,
      ['orchestration:read', 'terminal:operate'],
      { kind: 'presented-credential' },
    );
    const result = await commitChange(h, signed, t.id, r);
    expect(result.status).toBe(409);
    expect(await result.json()).toEqual({ error: 'target_changed' });
    expect(h.channel.store.auditTrail(h.channel.tenantId, t.id)).toContainEqual(
      {
        at: h.clock.now,
        event: 'closed',
        detail: 'target_changed',
      },
    );
    expect(
      h.pairing.listDevices().find((d) => d.id === h.second.device.id)?.scope,
    ).toBe(changed.scope);
    const statusPath = `/api/pairing/device-access-transactions/${t.id}`;
    expect(await (await h.read(signed.cookie, statusPath)).json()).toEqual({
      status: 'target_changed',
    });
    h.pairing.setDeviceScope(
      h.second.device.id,
      parsePairingScope(h.second.device.scope)!,
      { kind: 'presented-credential' },
    );
    const reopened = await h.consent.request(`/consent/${t.id}`, {
      headers: {
        ...h.headers(),
        cookie: signed.cookie,
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
      },
    });
    expect(reopened.status).toBe(409);
    expect(await reopened.text()).toContain(
      'This changed since you asked. Nothing was applied; open a new request.',
    );
    const later = await commitChange(h, signed, t.id, r, 3);
    expect(await later.json()).toEqual({ error: 'not_pending' });
    expect(await (await h.read(signed.cookie, statusPath)).json()).toEqual({
      status: 'target_changed',
    });
  });

  test.each([
    ['approved', 'Applied. Return to Station.'],
    ['denied', 'Cancelled. Nothing was applied.'],
    ['expired', 'The review expired. Nothing was applied; open a new request.'],
  ] as const)(
    'reopening a %s review explains the outcome without action buttons',
    async (outcome, message) => {
      const h = await build(),
        signed = await h.signIn();
      const t = await requestChange(h, signed),
        r = await reviewChange(h, signed, t.id);
      if (outcome === 'expired') h.clock.now += 5 * 60_000 + 1;
      else if (outcome === 'approved')
        expect((await commitChange(h, signed, t.id, r)).status).toBe(200);
      else
        expect(
          (
            await h.consent.request(`/consent/${t.id}/decide`, {
              method: 'POST',
              headers: { ...h.headers(), cookie: signed.cookie },
              body: JSON.stringify({ nonce: r.nonce, decision: 'deny' }),
            })
          ).status,
        ).toBe(200);
      const reopened = await h.consent.request(`/consent/${t.id}`, {
        headers: {
          ...h.headers(),
          cookie: signed.cookie,
          'sec-fetch-mode': 'navigate',
          'sec-fetch-dest': 'document',
        },
      });
      expect(reopened.status).toBe(409);
      const html = await reopened.text();
      expect(html).toContain(message);
      expect(html).not.toContain('<form');
    },
  );

  test.each([
    { name: 'app origin', input: { origin: APP } },
    { name: 'wrong RP', input: { rpId: 'wrong.example.test' } },
    { name: 'UV absent', input: { userVerified: false } },
    { name: 'UP absent', input: { userPresent: false } },
    { name: 'counter regression', input: { counter: 1 } },
  ])(
    'step-up refuses $name through the real assertion verifier',
    async ({ input }) => {
      const h = await build(),
        signed = await h.signIn();
      const t = await requestChange(h, signed),
        r = await reviewChange(h, signed, t.id);
      const result = await commitChange(h, signed, t.id, r, 2, input);
      expect(result.status).toBe(409);
      expect(await result.json()).toEqual({ error: 'authority_required' });
      expect(
        h.pairing.listDevices().find((d) => d.id === h.second.device.id)?.scope,
      ).toBe(h.second.device.scope);
    },
  );

  test.each([
    'origin',
    'host',
    'metadata',
    'nonce',
    'assertion',
    'device cookie',
    'operator cookie',
  ])('consent decide refuses a missing or wrong %s', async (missing) => {
    const h = await build(),
      signed = await h.signIn();
    const t = await requestChange(h, signed),
      r = await reviewChange(h, signed, t.id);
    const headers = { ...h.headers(), cookie: signed.cookie };
    if (missing === 'origin') headers.origin = APP;
    if (missing === 'host') headers.host = new URL(APP).host;
    if (missing === 'metadata') headers['sec-fetch-site'] = 'same-site';
    if (missing === 'device cookie')
      headers.cookie = signed.cookie.split('; ')[1];
    if (missing === 'operator cookie')
      headers.cookie = signed.cookie.split('; ')[0];
    const result = await h.consent.request(`/consent/${t.id}/decide`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        nonce: missing === 'nonce' ? 'wrong' : r.nonce,
        response:
          missing === 'assertion'
            ? undefined
            : signed.authenticator.authenticate(r.options, {
                origin: ORIGIN,
                counter: 2,
              }),
      }),
    });
    expect(result.status).toBe(
      missing.includes('cookie') ? 404 : missing === 'nonce' ? 409 : 403,
    );
    expect(
      h.pairing.listDevices().find((d) => d.id === h.second.device.id)?.scope,
    ).toBe(h.second.device.scope);
  });

  test.each([
    'operator-credential',
    'device-consent-scope',
    'consent-session',
    'native-host',
    'operator-session',
  ] as const)(
    '%s cannot decide a WebAuthn transaction even with its valid nonce',
    async (authority) => {
      const h = await build(),
        signed = await h.signIn();
      const t = await requestChange(h, signed),
        r = await reviewChange(h, signed, t.id);
      expect(
        await h.channel.store.decide(
          h.channel.tenantId,
          t.id,
          'approved',
          r.nonce,
          authority,
          {
            sessionId: h.channel.store.get(h.channel.tenantId, t.id)!
              .operatorSessionId!,
            verify: async () => signed.passkey.id,
          },
        ),
      ).toMatchObject({ ok: false, reason: 'authority_required' });
      expect(
        h.pairing.listDevices().find((d) => d.id === h.second.device.id)?.scope,
      ).toBe(h.second.device.scope);
    },
  );

  test.each([
    'transaction expiry',
    'session expiry',
    'device revocation',
    'passkey revocation',
  ])('%s prevents the pending action from committing', async (event) => {
    const h = await build(),
      signed = await h.signIn();
    const t = await requestChange(h, signed),
      r = await reviewChange(h, signed, t.id);
    if (event === 'transaction expiry') h.clock.now = t.expiresAt;
    if (event === 'session expiry') h.clock.now += OPERATOR_SESSION_IDLE_MS;
    if (event === 'device revocation')
      h.pairing.revokeDevice(h.first.device.id, 'operator-credential');
    if (event === 'passkey revocation')
      h.registry.existing()!.revoke(signed.passkey.id);
    expect((await commitChange(h, signed, t.id, r)).status).toBe(
      event === 'transaction expiry' ? 409 : 404,
    );
    expect(
      h.pairing.listDevices().find((d) => d.id === h.second.device.id)?.scope,
    ).toBe(h.second.device.scope);
    if (event === 'session expiry') {
      const start = await h.api.request(
        `/api/pairing/devices/${h.second.device.id}`,
        { method: 'DELETE', headers: { cookie: signed.cookie, origin: APP } },
      );
      expect(start.status).toBe(403);
      expect(await start.json()).toMatchObject({
        error: { code: 'operator_session_required' },
      });
    }
  });

  test('host reads any action; another operator session can neither read, render nor decide it', async () => {
    const h = await build(),
      first = await h.signIn(),
      other = await h.signIn(h.second.credential);
    const t = await requestChange(h, first);
    const path = `/api/pairing/device-access-transactions/${t.id}`;
    expect(
      (
        await h.api.request(path, {
          headers: { authorization: `Bearer ${h.operator.credential}` },
        })
      ).status,
    ).toBe(200);
    expect((await h.read(other.cookie, path)).status).toBe(404);
    const r = await reviewChange(h, first, t.id);
    expect(
      (
        await h.consent.request(`/consent/${t.id}`, {
          headers: {
            ...h.headers(),
            cookie: other.cookie,
            'sec-fetch-mode': 'navigate',
            'sec-fetch-dest': 'document',
          },
        })
      ).status,
    ).toBe(403);
    expect((await commitChange(h, other, t.id, r)).status).toBe(404);
  });

  test('D8 refuses the same passkey and accepts a different passkey for remote revocation', async () => {
    const h = await build(),
      signed = await h.signIn(),
      backup = await h.enroll();
    const path = `/api/pairing/operator-passkeys/${signed.passkey.id}`;
    const t = await requestChange(h, signed, 'DELETE', path),
      r = await reviewChange(h, signed, t.id);
    const refused = await commitChange(h, signed, t.id, r);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      error: 'commit_refused',
      detail: 'Use a different passkey to revoke this one.',
    });
    expect(h.channel.store.get(h.channel.tenantId, t.id)?.status).toBe(
      'pending',
    );
    expect(h.registry.existing()!.get(signed.passkey.id)?.revokedAt).toBeNull();
    const r2 = await reviewChange(h, signed, t.id);
    const result = await commitChange(
      h,
      { ...signed, authenticator: backup.authenticator },
      t.id,
      r2,
      1,
    );
    expect(result.status).toBe(200);
    expect(
      h.registry.existing()!.get(signed.passkey.id)?.revokedAt,
    ).not.toBeNull();
    expect((await h.read(signed.cookie)).status).toBe(403);
  });

  test('D12 group and D13 tokens use expected state; a token secret appears once only in the initiating commit response', async () => {
    const h = await build(),
      signed = await h.signIn();
    const offer = h.pairing.createOffer({
      endpoint: APP,
      scope: 'orchestration:read',
    });
    const pending = h.pairing.requestPairing({
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: 'Casey',
      source: 'tailnet',
      requesterPosition: 'off-box',
      requester: { provider: 'tailscale-serve', login: 'casey' },
    });
    h.pairing.confirmRequest(
      pending.requestId,
      { kind: 'presented-credential' },
      { kind: 'verified-ingress', principalId: 'human:tailscale-serve:casey' },
    );
    h.pairing.exchange({
      offerId: offer.offerId,
      proof: offer.challenge,
      requestId: pending.requestId,
    });
    const principalId = 'human:tailscale-serve:casey',
      groupPath = `/api/pairing/people/${principalId}/group`;
    const stale = await requestChange(h, signed, 'PUT', groupPath, {
      group: 'admin',
    });
    const sr = await reviewChange(h, signed, stale.id);
    await h.security.assignGroup(principalId, 'admin');
    expect((await commitChange(h, signed, stale.id, sr)).status).toBe(409);
    const group = await requestChange(h, signed, 'PUT', groupPath, {
      group: 'member',
    });
    expect(
      (
        await commitChange(
          h,
          signed,
          group.id,
          await reviewChange(h, signed, group.id),
          3,
        )
      ).status,
    ).toBe(200);
    expect(h.security.groupOf(principalId)).toBe('member');
    const staleMint = await requestChange(
      h,
      signed,
      'POST',
      `/api/pairing/people/${principalId}/tokens`,
      { name: 'Stale', scope: 'orchestration:read' },
    );
    const staleReview = await reviewChange(h, signed, staleMint.id);
    await h.security.assignGroup(principalId, 'admin');
    expect(
      (await commitChange(h, signed, staleMint.id, staleReview, 4)).status,
    ).toBe(409);
    expect(h.pairing.listPersonalTokens(principalId)).toHaveLength(0);
    await h.security.assignGroup(principalId, 'member');
    const mint = await requestChange(
      h,
      signed,
      'POST',
      `/api/pairing/people/${principalId}/tokens`,
      { name: 'Automation', scope: 'orchestration:read' },
    );
    const mr = await reviewChange(h, signed, mint.id);
    const result = await commitChange(h, signed, mint.id, mr, 5);
    expect(result.status).toBe(200);
    const committed = await readJson<{ secret: string }>(result);
    expect(committed.secret).toMatch(/^stp_/);
    expect(h.security.verifyCredential(committed.secret)).toBe(true);
    const path = `/api/pairing/device-access-transactions/${mint.id}`;
    for (let read = 0; read < 2; read++) {
      const projection = await (await h.read(signed.cookie, path)).text();
      expect(projection).not.toContain(committed.secret);
      expect(JSON.parse(projection)).toMatchObject({
        effect: { token: { name: 'Automation' } },
      });
      expect(projection).not.toContain('"secret"');
    }
    expect(
      JSON.stringify(h.channel.store.get(h.channel.tenantId, mint.id)),
    ).not.toContain(committed.secret);
    const replay = await commitChange(h, signed, mint.id, mr, 5);
    expect(replay.status).toBe(409);
    expect(await replay.text()).not.toContain(committed.secret);
    const other = await h.signIn(h.second.credential);
    expect((await h.read(other.cookie, path)).status).toBe(404);
    expect((await commitChange(h, other, mint.id, mr)).status).toBe(404);
    const token = h.pairing.listPersonalTokens(principalId)[0];
    const revoke = await requestChange(
      h,
      signed,
      'DELETE',
      `/api/pairing/people/${principalId}/tokens/${token.id}`,
    );
    expect(
      (
        await commitChange(
          h,
          signed,
          revoke.id,
          await reviewChange(h, signed, revoke.id),
          6,
        )
      ).status,
    ).toBe(200);
    expect(h.security.verifyCredential(committed.secret)).toBe(false);
    const tied = h.pairing
      .listDevices()
      .find(
        (device) =>
          device.principalBinding &&
          'provider' in device.principalBinding &&
          device.principalBinding.provider === 'tailscale-serve',
      );
    const token2 = await h.pairing.mintPersonalToken({
      name: 'Stale revoke',
      ownerPrincipalId: principalId,
      binding: tied!.principalBinding!,
      scope: 'orchestration:read',
      expiresAt: null,
    });
    const staleRevoke = await requestChange(
      h,
      signed,
      'DELETE',
      `/api/pairing/people/${principalId}/tokens/${token2.token.id}`,
    );
    const staleRevokeReview = await reviewChange(h, signed, staleRevoke.id);
    await h.pairing.revokePersonalToken(token2.token.id, principalId);
    expect(
      (await commitChange(h, signed, staleRevoke.id, staleRevokeReview, 7))
        .status,
    ).toBe(409);
  });
});

describe('S4 action lifecycle and admission boundaries', () => {
  test('device revoke ends its sessions, records the passkey actor durably, and remove-record commits its projected record', async () => {
    const h = await build(),
      signed = await h.signIn(),
      other = await h.signIn(h.second.credential);
    const revoke = await requestChange(
      h,
      signed,
      'DELETE',
      `/api/pairing/devices/${h.second.device.id}`,
    );
    const review = await reviewChange(h, signed, revoke.id);
    const results = await Promise.all([
      commitChange(h, signed, revoke.id, review),
      commitChange(h, signed, revoke.id, review),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    expect((await h.read(other.cookie)).status).toBe(401);
    const reloaded = new EnvironmentSecurityService({
      homeDir: h.home,
      now: () => h.clock.now,
    });
    await reloaded.initialize();
    const revoked = reloaded.devicePairing
      .listDevices()
      .find((d) => d.id === h.second.device.id)!;
    expect(revoked.revocation).toEqual({
      state: 'recorded',
      actor: 'operator-passkey',
      reason: 'owner-request',
    });
    const remove = await requestChange(
      h,
      signed,
      'DELETE',
      `/api/pairing/devices/${h.second.device.id}/record`,
    );
    expect(
      (
        await commitChange(
          h,
          signed,
          remove.id,
          await reviewChange(h, signed, remove.id),
          3,
        )
      ).status,
    ).toBe(200);
    const status = await h.read(
      signed.cookie,
      `/api/pairing/device-access-transactions/${remove.id}`,
    );
    expect(await status.json()).toEqual({
      status: 'approved',
      effect: revoked,
    });
    expect(
      h.pairing.listDevices().some((d) => d.id === h.second.device.id),
    ).toBe(false);
  });

  test.each(['expired', 'other-device'] as const)(
    '%s session refuses every new S4 leaf',
    async (mode) => {
      const h = await build(),
        signed = await h.signIn();
      if (mode === 'expired') h.clock.now += OPERATOR_SESSION_IDLE_MS;
      const cookie =
        mode === 'other-device'
          ? signed.cookie.replace(h.first.credential, h.second.credential)
          : signed.cookie;
      for (const [method, path] of [
        ['POST', `/api/pairing/devices/${h.second.device.id}/scope`],
        ['DELETE', `/api/pairing/devices/${h.second.device.id}`],
        ['DELETE', `/api/pairing/devices/${h.second.device.id}/record`],
        ['GET', '/api/pairing/device-access-transactions/unknown'],
        ['PUT', '/api/pairing/people/human:test:casey/group'],
        ['POST', '/api/pairing/people/human:test:casey/tokens'],
        ['DELETE', '/api/pairing/people/human:test:casey/tokens/unknown'],
        ['DELETE', `/api/pairing/operator-passkeys/${signed.passkey.id}`],
      ]) {
        const response = await h.api.request(path, {
          method,
          headers: { cookie, origin: APP },
        });
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({
          error: { code: 'operator_session_required' },
          signInUrl: `${ORIGIN}/operator/sign-in`,
        });
      }
    },
  );

  test('grant policy refuses an ungrantable scope before opening any consent transaction', async () => {
    const h = await build(),
      signed = await h.signIn();
    const create = vi.spyOn(h.channel.store, 'create');
    const response = await h.api.request(
      `/api/pairing/devices/${h.second.device.id}/scope`,
      {
        method: 'POST',
        headers: {
          cookie: signed.cookie,
          origin: APP,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          scope: ['orchestration:read', 'access:manage'],
        }),
      },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: 'scope_not_grantable',
    });
    expect(create).not.toHaveBeenCalled();
  });

  test.each(['unknown', 'revoked'] as const)(
    '%s assertion credential cannot approve a pending action',
    async (state) => {
      const h = await build(),
        signed = await h.signIn();
      const backup =
        state === 'revoked'
          ? await h.enroll()
          : { authenticator: new SoftwareAuthenticator() };
      if ('passkey' in backup) h.registry.existing()!.revoke(backup.passkey.id);
      const t = await requestChange(h, signed),
        r = await reviewChange(h, signed, t.id);
      expect(
        (
          await commitChange(
            h,
            { ...signed, authenticator: backup.authenticator },
            t.id,
            r,
            1,
          )
        ).status,
      ).toBe(409);
      expect(
        h.pairing.listDevices().find((d) => d.id === h.second.device.id)?.scope,
      ).toBe(h.second.device.scope);
    },
  );

  test('passkey revocation refuses an expected-state mismatch without revoking the deciding passkey', async () => {
    const h = await build(),
      signed = await h.signIn(),
      backup = await h.enroll();
    const t = await requestChange(
      h,
      signed,
      'DELETE',
      `/api/pairing/operator-passkeys/${backup.passkey.id}`,
    );
    const r = await reviewChange(h, signed, t.id);
    h.registry.existing()!.revoke(backup.passkey.id);
    expect((await commitChange(h, signed, t.id, r)).status).toBe(409);
    expect(h.registry.existing()!.get(signed.passkey.id)?.revokedAt).toBeNull();
  });
});

describe('S4 authority matrix for the independent host and Device paths', () => {
  test.each(['local-grant', 'ui-bootstrap', 'internal'] as const)(
    '%s has no operator-session authority on the new action leaves',
    async (authority) => {
      const h = await build();
      const device =
        authority === 'internal'
          ? null
          : h.pair(
              authority,
              'access:manage',
              'device',
              false,
              authority === 'ui-bootstrap' ? 'ui-bootstrap' : true,
            );
      const headers = device
        ? { authorization: `Bearer ${device.credential}`, origin: APP }
        : {
            [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
            [INTERNAL_PROXY_CALLER_HEADER]: 'local',
            origin: APP,
          };
      const environment = {
        incoming: { socket: { remoteAddress: '127.0.0.1' } },
      };
      const list = await h.api.request(
        '/api/pairing/devices',
        { headers },
        environment,
      );
      expect(list.status).toBe(authority === 'internal' ? 401 : 200);
      for (const [method, path] of [
        ['GET', '/api/pairing/device-access-transactions/unknown'],
        ['PUT', '/api/pairing/people/human:test:casey/group'],
        ['POST', '/api/pairing/people/human:test:casey/tokens'],
        ['DELETE', '/api/pairing/people/human:test:casey/tokens/unknown'],
        ['DELETE', '/api/pairing/operator-passkeys/unknown'],
      ]) {
        const response = await h.api.request(
          path,
          { method, headers },
          environment,
        );
        expect(response.status).toBe(authority === 'ui-bootstrap' ? 403 : 401);
        expect(await response.json()).toEqual(
          authority === 'ui-bootstrap'
            ? { error: { code: 'insufficient_scope' } }
            : { error: 'authentication_required' },
        );
      }
      const scope = await h.api.request(
        `/api/pairing/devices/${h.second.device.id}/scope`,
        {
          method: 'POST',
          headers: {
            ...headers,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            scope: ['orchestration:read', 'orchestration:operate'],
          }),
        },
        environment,
      );
      expect(scope.status).toBe(authority === 'ui-bootstrap' ? 200 : 401);
      const revoke = await h.api.request(
        `/api/pairing/devices/${h.second.device.id}`,
        { method: 'DELETE', headers },
        environment,
      );
      expect(revoke.status).toBe(authority === 'ui-bootstrap' ? 200 : 401);
      h.pairing.revokeDevice(h.second.device.id, 'operator-credential');
      const remove = await h.api.request(
        `/api/pairing/devices/${h.second.device.id}/record`,
        { method: 'DELETE', headers },
        environment,
      );
      expect(remove.status).toBe(authority === 'ui-bootstrap' ? 200 : 401);
    },
  );
});
