import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  StationHttpError,
  setClientCredentialResolver,
} from '../../../../packages/sdk/src/client/http.js';
import { fetchPairedDevices } from '../../../../packages/sdk/src/query-domains/devicePairingRequests.js';
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
    localGrant = false,
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
            mintKind: 'local-grant' as const,
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
  configureRuntimeHttp({
    app: api as never,
    logger,
    eventBus: { emit: vi.fn() } as unknown as EventBus,
    security: {
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

  test('app-origin operator-session mutations refuse and leave host-observed device state unchanged', async () => {
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
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: {
          code:
            path === '/api/operator/session'
              ? 'insufficient_scope'
              : 'operator_session_required',
        },
      });
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
