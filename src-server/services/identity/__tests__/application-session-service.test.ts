import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pairingScopePresetString } from '@kontourai/station-contracts/environment-security';
import {
  ApplicationSessionClient,
  createApplicationSessionKey,
} from '@kontourai/station-sdk/application-session';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createApplicationSessionRoutes } from '../../../routes/system/application-session-routes.js';
import { parseSecureDeviceSessionCookie } from '../../../runtime/bootstrap/runtime-http.js';
import { VirtualApplicationIngress } from '../../connections/virtual-application.js';
import { DevicePairingService } from '../../ssh/device-pairing-service.js';
import { createApplicationSessionRuntime } from '../application-session-runtime.js';
import { loadLocalAccounts } from '../local-account-runtime.js';

const origin = 'https://station.example.test';
const alternateOrigin = 'https://app.example.test';
const stationId = '33333333-3333-4333-8333-333333333333';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const close of cleanup.splice(0)) await close();
});

async function harness() {
  const home = await mkdtemp(join(tmpdir(), 'station-application-session-'));
  await mkdir(join(home, 'security'), { mode: 0o700 });
  let pairing = new DevicePairingService({
    homeDir: home,
    environmentId: stationId,
  });
  const pair = (name: string) => {
    const offer = pairing.createOffer({
      endpoint: origin,
      scope: pairingScopePresetString('standard'),
    });
    const request = pairing.requestPairing({
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: name,
      requesterPosition: 'off-box',
    });
    pairing.confirmRequest(request.requestId, {
      kind: 'presented-credential',
    });
    return pairing.exchange({
      offerId: offer.offerId,
      proof: offer.challenge,
      requestId: request.requestId,
    });
  };
  const device = pair('First device');
  const second = pair('Second device');
  const configuration = {
    publicOrigin: origin,
    allowedBrowserOrigins: [alternateOrigin],
  };
  const host = { homeDirectory: home, stationId };
  const enrollment = { mayRegister: async () => true };
  let accounts = await loadLocalAccounts(configuration, host, enrollment);
  let browserCookieJar = '';
  let lastIssuedAliasCredential: string | undefined;
  let sessions = createApplicationSessionRuntime(
    home,
    stationId,
    accounts,
    (value) => pairing.identifyDevice(value),
    (value) => pairing.credentialAliasId(value),
    {
      readSecureDeviceCookie: (request) =>
        parseSecureDeviceSessionCookie(
          request.headers.get('cookie') ?? undefined,
        ),
      issueAlias: (parentCredential, deviceId, aliasId) => {
        const alias = pairing.issueRelayCredentialAlias(
          parentCredential,
          deviceId,
          undefined,
          aliasId,
        );
        lastIssuedAliasCredential = alias.credential;
        return alias;
      },
      revokeAlias: (deviceId, aliasId) =>
        pairing.revokeRelayCredentialAlias(deviceId, aliasId),
    },
  )!;
  const app = () => {
    const result = new Hono();
    result.route(
      '/api/account-auth/continuations',
      createApplicationSessionRoutes(sessions),
    );
    result.get('/resource', async (c) => {
      const account = await accounts.service.authenticate(c.req.raw);
      return c.json(
        account.kind === 'authenticated'
          ? { principal: account.principal }
          : { kind: account.kind },
        account.kind === 'authenticated'
          ? 200
          : account.kind === 'unavailable'
            ? 503
            : 401,
      );
    });
    return result;
  };
  let currentApp = app();
  const browserFetch = vi.fn((url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (init?.credentials === 'same-origin') {
      headers.set('Cookie', browserCookieJar);
      headers.set('Origin', origin);
    }
    return currentApp.request(url, { ...init, headers });
  });
  vi.stubGlobal('fetch', browserFetch);
  const password = 'Application session fixture password';
  const signup = await accounts.service.handle(
    new Request(`${origin}/api/account-auth/sign-up/username`, {
      method: 'POST',
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        'x-station-invitation': 'fixture-enrollment',
      },
      body: JSON.stringify({ username: 'alice', password }),
    }),
    '/sign-up/username',
  );
  expect(signup.status).toBe(200);
  const key = await createApplicationSessionKey();
  const client = new ApplicationSessionClient(
    origin,
    stationId,
    origin,
    { credential: device.credential, credentialOrigin: origin },
    key,
  );
  cleanup.push(async () => {
    sessions.close();
    await accounts.service.close();
    await rm(home, { recursive: true, force: true });
  });
  return {
    client,
    key,
    device,
    second,
    get pairing() {
      return pairing;
    },
    password,
    accounts: () => accounts,
    application: () => currentApp,
    home,
    browserFetch,
    lastAliasCredential: () => lastIssuedAliasCredential,
    setBrowserCookieJar(value: string) {
      browserCookieJar = value;
    },
    request: (path: string, init: RequestInit) =>
      currentApp.request(origin + path, init),
    async restart() {
      sessions.close();
      await accounts.service.close();
      pairing = new DevicePairingService({
        homeDir: home,
        environmentId: stationId,
      });
      accounts = await loadLocalAccounts(configuration, host, enrollment);
      sessions = createApplicationSessionRuntime(
        home,
        stationId,
        accounts,
        (value) => pairing.identifyDevice(value),
        (value) => pairing.credentialAliasId(value),
        {
          readSecureDeviceCookie: (request) =>
            parseSecureDeviceSessionCookie(
              request.headers.get('cookie') ?? undefined,
            ),
          issueAlias: (parentCredential, deviceId, aliasId) => {
            const alias = pairing.issueRelayCredentialAlias(
              parentCredential,
              deviceId,
              undefined,
              aliasId,
            );
            lastIssuedAliasCredential = alias.credential;
            return alias;
          },
          revokeAlias: (deviceId, aliasId) =>
            pairing.revokeRelayCredentialAlias(deviceId, aliasId),
        },
      )!;
      currentApp = app();
    },
  };
}

describe('Device-bound continuation persistence and negative admission', () => {
  test('compensates an alias when continuation persistence faults after mint', async () => {
    const h = await harness();
    const login = await h.accounts().service.handle(
      new Request(`${origin}/api/account-auth/sign-in/username`, {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'alice', password: h.password }),
      }),
      '/sign-in/username',
    );
    const accountCookie = login.headers.getSetCookie()[0]!.split(';')[0]!;
    h.setBrowserCookieJar(
      `__Host-station-device=${h.device.credential}; ${accountCookie}`,
    );
    const browser = new ApplicationSessionClient(
      origin,
      stationId,
      origin,
      {},
      await createApplicationSessionKey(),
    );
    const database = new DatabaseSync(
      join(h.home, 'authentication', 'application-sessions.sqlite'),
    );
    database.exec(`CREATE TRIGGER injected_adoption_insert_failure
      BEFORE INSERT ON application_sessions
      BEGIN SELECT RAISE(ABORT, 'injected adoption persistence failure'); END;`);
    await expect(browser.adoptCookies()).rejects.toMatchObject({ status: 503 });
    const orphan = h.lastAliasCredential();
    expect(orphan).toBeDefined();
    expect(h.pairing.credentialAliasId(orphan!)).toBeUndefined();
    expect(h.pairing.verifyCredential(h.device.credential)).toBe(true);
    expect(
      database
        .prepare('SELECT count(*) AS n FROM application_session_adoptions')
        .get()?.n,
    ).toBe(0);
    expect(
      database.prepare('SELECT count(*) AS n FROM application_sessions').get()
        ?.n,
    ).toBe(0);
    database.exec('DROP TRIGGER injected_adoption_insert_failure');
    database.close();

    const adoption = await browser.adoptCookies();
    expect(h.pairing.credentialAliasId(adoption.aliasCredential)).toBe(
      adoption.aliasId,
    );
  });

  test('startup revokes prepared and undelivered aliases left by an interrupted adoption', async () => {
    const h = await harness();
    const deviceId = h.device.device.id;
    const preparedId = randomUUID();
    const issuedId = randomUUID();
    const preparedAlias = h.pairing.issueRelayCredentialAlias(
      h.device.credential,
      deviceId,
      undefined,
      randomUUID(),
    );
    const issuedAlias = h.pairing.issueRelayCredentialAlias(
      h.device.credential,
      deviceId,
      undefined,
      randomUUID(),
    );
    const database = new DatabaseSync(
      join(h.home, 'authentication', 'application-sessions.sqlite'),
    );
    const expiry = Date.now() + 24 * 60 * 60_000;
    const adoptionInsert = database.prepare(
      'INSERT INTO application_session_adoptions VALUES (?,?,?,?,?)',
    );
    adoptionInsert.run(
      preparedId,
      deviceId,
      preparedAlias.aliasId,
      expiry,
      'prepared',
    );
    adoptionInsert.run(
      issuedId,
      deviceId,
      issuedAlias.aliasId,
      expiry,
      'issued',
    );
    const unactivatedHash = 'u'.repeat(43);
    database
      .prepare('INSERT INTO application_sessions VALUES (?,?,?)')
      .run(unactivatedHash, expiry, JSON.stringify({ adoptionId: issuedId }));
    database
      .prepare('INSERT INTO application_session_proofs VALUES (?,?,?)')
      .run(unactivatedHash, 'p'.repeat(22), expiry);
    database.close();

    await h.restart();
    expect(
      h.pairing.credentialAliasId(preparedAlias.credential),
    ).toBeUndefined();
    expect(h.pairing.credentialAliasId(issuedAlias.credential)).toBeUndefined();
    expect(h.pairing.verifyCredential(h.device.credential)).toBe(true);
    const recovered = new DatabaseSync(
      join(h.home, 'authentication', 'application-sessions.sqlite'),
    );
    expect(
      recovered
        .prepare('SELECT count(*) AS n FROM application_session_adoptions')
        .get()?.n,
    ).toBe(0);
    expect(
      recovered.prepare('SELECT count(*) AS n FROM application_sessions').get()
        ?.n,
    ).toBe(0);
    expect(
      recovered
        .prepare('SELECT count(*) AS n FROM application_session_proofs')
        .get()?.n,
    ).toBe(0);
    recovered.close();
  });

  test('adopts existing HTTPS Device and local-account cookies, survives restart, and revokes only the alias', async () => {
    const h = await harness();
    const login = await h.accounts().service.handle(
      new Request(`${origin}/api/account-auth/sign-in/username`, {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'alice', password: h.password }),
      }),
      '/sign-in/username',
    );
    const accountCookie = login.headers.getSetCookie()[0]!.split(';')[0]!;
    const cookieJar = `__Host-station-device=${h.device.credential}; ${accountCookie}`;
    h.setBrowserCookieJar(cookieJar);
    const browserKey = await createApplicationSessionKey();
    expect(browserKey.privateKey.extractable).toBe(false);
    const browser = new ApplicationSessionClient(
      origin,
      stationId,
      origin,
      {},
      browserKey,
    );
    await expect(browser.capabilities()).resolves.toMatchObject({
      cookieAdoption: true,
      stationId,
      requestOrigin: origin,
    });
    const wrongOrigin = await h.request(
      '/api/account-auth/continuations/adopt-cookie/challenge',
      {
        method: 'POST',
        headers: {
          Origin: alternateOrigin,
          Cookie: `__Host-station-device=${h.device.credential}; ${accountCookie}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ publicKey: browserKey.publicKey }),
      },
    );
    expect(wrongOrigin.status).toBe(403);
    const insecureDeviceCookie = await h.request(
      '/api/account-auth/continuations/adopt-cookie/challenge',
      {
        method: 'POST',
        headers: {
          Origin: origin,
          Cookie: `station-device=${h.device.credential}; ${accountCookie}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ publicKey: browserKey.publicKey }),
      },
    );
    expect(insecureDeviceCookie.status).toBe(401);
    const devicesBefore = h.pairing.listDevices().map((device) => device.id);
    const adoption = await browser.adoptCookies();
    expect(adoption).toMatchObject({
      version: 'station.application-session/v1',
      continuation: {
        stationId,
        clientOrigin: origin,
        deviceId: h.device.device.id,
      },
    });
    expect(h.pairing.credentialAliasId(adoption.aliasCredential)).toBe(
      adoption.aliasId,
    );
    expect(h.pairing.listDevices().map((device) => device.id)).toEqual(
      devicesBefore,
    );
    expect(JSON.stringify(adoption)).not.toContain(accountCookie);
    expect(JSON.stringify(adoption)).not.toContain(h.device.credential);
    const adoptionCalls = h.browserFetch.mock.calls.filter(([url]) =>
      url.includes('/adopt-cookie/'),
    );
    expect(adoptionCalls).toHaveLength(2);
    for (const [, init] of adoptionCalls) {
      expect(init?.credentials).toBe('same-origin');
      expect(new Headers(init?.headers).has('Cookie')).toBe(false);
      expect(new Headers(init?.headers).has('Authorization')).toBe(false);
    }

    const relay = new ApplicationSessionClient(
      origin,
      stationId,
      origin,
      {
        credential: adoption.aliasCredential,
        credentialOrigin: origin,
      },
      browserKey,
    );
    const requestHeaders = await relay.headers(adoption.continuation, {
      method: 'GET',
      url: `${origin}/resource`,
    });
    expect(
      (
        await h.request('/resource', {
          headers: {
            ...requestHeaders,
            Authorization: `Bearer ${adoption.aliasCredential}`,
          },
        })
      ).status,
    ).toBe(200);

    const ingress = new VirtualApplicationIngress(origin);
    ingress.bind({ fetch: (request) => h.application().fetch(request) });
    const virtual = ingress.activate();
    const cookieAttempt = await virtual.fetch(
      new Request(
        `${origin}/api/account-auth/continuations/adopt-cookie/challenge`,
        {
          method: 'POST',
          headers: {
            Origin: origin,
            Cookie: cookieJar,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ publicKey: browserKey.publicKey }),
        },
      ),
    );
    expect(cookieAttempt.status).toBe(400);
    const cookieFreeAttempt = await virtual.fetch(
      new Request(
        `${origin}/api/account-auth/continuations/adopt-cookie/challenge`,
        {
          method: 'POST',
          headers: { Origin: origin, 'Content-Type': 'application/json' },
          body: JSON.stringify({ publicKey: browserKey.publicKey }),
        },
      ),
    );
    expect(cookieFreeAttempt.status).toBe(401);
    ingress.stop();

    await h.restart();
    const afterRestartHeaders = await relay.headers(adoption.continuation, {
      method: 'GET',
      url: `${origin}/resource`,
    });
    expect(
      (
        await h.request('/resource', {
          headers: {
            ...afterRestartHeaders,
            Authorization: `Bearer ${adoption.aliasCredential}`,
          },
        })
      ).status,
    ).toBe(200);

    await browser.revokeAlias(adoption.aliasCredential, adoption.continuation);
    expect(
      h.pairing.credentialAliasId(adoption.aliasCredential),
    ).toBeUndefined();
    expect(h.pairing.verifyCredential(h.device.credential)).toBe(true);
    expect(
      (
        await h.accounts().service.authenticate(
          new Request(`${origin}/api/account-auth/session`, {
            headers: { Cookie: accountCookie },
          }),
        )
      ).kind,
    ).toBe('authenticated');
  });

  test('reauthentication after continuation expiry keeps the exact adoption link through restart and alias revocation', async () => {
    const h = await harness();
    const login = await h.accounts().service.handle(
      new Request(`${origin}/api/account-auth/sign-in/username`, {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'alice', password: h.password }),
      }),
      '/sign-in/username',
    );
    const accountCookie = login.headers.getSetCookie()[0]!.split(';')[0]!;
    h.setBrowserCookieJar(
      `__Host-station-device=${h.device.credential}; ${accountCookie}`,
    );
    const firstKey = await createApplicationSessionKey();
    const secondKey = await createApplicationSessionKey();
    const firstAdopter = new ApplicationSessionClient(
      origin,
      stationId,
      origin,
      {},
      firstKey,
    );
    const secondAdopter = new ApplicationSessionClient(
      origin,
      stationId,
      origin,
      {},
      secondKey,
    );
    const first = await firstAdopter.adoptCookies();
    const second = await secondAdopter.adoptCookies();
    expect(first.continuation.deviceId).toBe(h.device.device.id);
    expect(second.continuation.deviceId).toBe(first.continuation.deviceId);

    const firstRelay = new ApplicationSessionClient(
      origin,
      stationId,
      origin,
      {
        credential: first.aliasCredential,
        credentialOrigin: origin,
        headers: { Cookie: accountCookie },
      },
      firstKey,
    );
    const secondRelay = new ApplicationSessionClient(
      origin,
      stationId,
      origin,
      {
        credential: second.aliasCredential,
        credentialOrigin: origin,
        headers: { Cookie: accountCookie },
      },
      secondKey,
    );
    const resourceHeaders = async (
      client: ApplicationSessionClient,
      continuation: Awaited<ReturnType<ApplicationSessionClient['establish']>>,
      aliasCredential: string,
    ) => ({
      ...(await client.headers(continuation, {
        method: 'GET',
        url: `${origin}/resource`,
      })),
      Authorization: `Bearer ${aliasCredential}`,
    });
    expect(
      (
        await h.request('/resource', {
          headers: await resourceHeaders(
            firstRelay,
            first.continuation,
            first.aliasCredential,
          ),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await h.request('/resource', {
          headers: await resourceHeaders(
            secondRelay,
            second.continuation,
            second.aliasCredential,
          ),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await h.request('/resource', {
          headers: {
            ...(await resourceHeaders(
              firstRelay,
              first.continuation,
              first.aliasCredential,
            )),
            Authorization: `Bearer ${second.aliasCredential}`,
          },
        })
      ).status,
    ).toBe(401);

    const sessions = new DatabaseSync(
      join(h.home, 'authentication', 'application-sessions.sqlite'),
    );
    const firstHash = createHash('sha256')
      .update(first.continuation.credential)
      .digest('base64url');
    const expired = Date.now() - 1;
    const session = sessions
      .prepare('SELECT record FROM application_sessions WHERE token_hash=?')
      .get(firstHash);
    expect(typeof session?.record).toBe('string');
    const record = JSON.parse(session!.record as string) as {
      expiresAt: number;
    };
    record.expiresAt = expired;
    expect(
      sessions
        .prepare(
          'UPDATE application_sessions SET expires_at=?, record=? WHERE token_hash=?',
        )
        .run(expired, JSON.stringify(record), firstHash).changes,
    ).toBe(1);
    sessions.close();
    expect(
      (
        await h.request('/resource', {
          headers: await resourceHeaders(
            firstRelay,
            first.continuation,
            first.aliasCredential,
          ),
        })
      ).status,
    ).toBe(401);

    await h.restart();
    const reauthenticated = await firstRelay.establish();
    expect(reauthenticated).toMatchObject({
      stationId,
      deviceId: h.device.device.id,
      principal: first.continuation.principal,
    });
    expect(
      (
        await h.request('/resource', {
          headers: await resourceHeaders(
            firstRelay,
            reauthenticated,
            first.aliasCredential,
          ),
        })
      ).status,
    ).toBe(200);

    await firstRelay.revokeAlias(first.aliasCredential, reauthenticated);
    expect(h.pairing.credentialAliasId(first.aliasCredential)).toBeUndefined();
    await expect(firstRelay.establish()).rejects.toMatchObject({ status: 401 });
    expect(h.pairing.credentialAliasId(second.aliasCredential)).toBe(
      second.aliasId,
    );
    expect(h.pairing.verifyCredential(h.device.credential)).toBe(true);
    expect(
      (
        await h.accounts().service.authenticate(
          new Request(`${origin}/api/account-auth/session`, {
            headers: { Cookie: accountCookie },
          }),
        )
      ).kind,
    ).toBe('authenticated');
    expect(
      (
        await h.request('/resource', {
          headers: await resourceHeaders(
            secondRelay,
            second.continuation,
            second.aliasCredential,
          ),
        })
      ).status,
    ).toBe(200);
  });

  test('an alias continuation is bound to its exact alias and alias bearers alone are denied over HTTP and VAI', async () => {
    const h = await harness();
    const login = await h.accounts().service.handle(
      new Request(`${origin}/api/account-auth/sign-in/username`, {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'alice', password: h.password }),
      }),
      '/sign-in/username',
    );
    const cookie = login.headers.getSetCookie()[0]!.split(';')[0]!;
    const firstAlias = h.pairing.issueRelayCredentialAlias(
      h.device.credential,
      h.device.device.id,
    );
    const secondAlias = h.pairing.issueRelayCredentialAlias(
      h.device.credential,
      h.device.device.id,
    );
    const firstClient = new ApplicationSessionClient(
      origin,
      stationId,
      origin,
      {
        credential: firstAlias.credential,
        credentialOrigin: origin,
        headers: { Cookie: cookie },
      },
      await createApplicationSessionKey(),
    );
    const secondClient = new ApplicationSessionClient(
      origin,
      stationId,
      origin,
      {
        credential: secondAlias.credential,
        credentialOrigin: origin,
        headers: { Cookie: cookie },
      },
      await createApplicationSessionKey(),
    );
    const firstSession = await firstClient.establish();
    const secondSession = await secondClient.establish();
    const proof = async (
      client: ApplicationSessionClient,
      session: Awaited<ReturnType<ApplicationSessionClient['establish']>>,
      credential: string,
    ) => ({
      ...(await client.headers(session, {
        method: 'GET',
        url: `${origin}/resource`,
      })),
      Authorization: `Bearer ${credential}`,
    });
    const firstHeaders = await proof(
      firstClient,
      firstSession,
      firstAlias.credential,
    );
    expect(
      (await h.request('/resource', { headers: firstHeaders })).status,
    ).toBe(200);

    expect(
      (
        await h.request('/resource', {
          headers: { Authorization: `Bearer ${firstAlias.credential}` },
        })
      ).status,
    ).toBe(401);
    const ingress = new VirtualApplicationIngress(origin);
    ingress.bind({ fetch: (request) => h.application().fetch(request) });
    const virtual = ingress.activate();
    expect(
      (
        await virtual.fetch(
          new Request(`${origin}/resource`, {
            headers: { Authorization: `Bearer ${firstAlias.credential}` },
          }),
        )
      ).status,
    ).toBe(401);
    ingress.stop();

    expect(
      (
        await h.request('/resource', {
          headers: {
            ...(await proof(firstClient, firstSession, firstAlias.credential)),
            Authorization: `Bearer ${secondAlias.credential}`,
          },
        })
      ).status,
    ).toBe(401);

    expect(
      h.pairing.revokeRelayCredentialAlias(
        h.device.device.id,
        firstAlias.aliasId,
      ),
    ).toBe(true);
    expect(
      (
        await h.request('/resource', {
          headers: await proof(
            firstClient,
            firstSession,
            firstAlias.credential,
          ),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await h.request('/resource', {
          headers: await proof(
            secondClient,
            secondSession,
            secondAlias.credential,
          ),
        })
      ).status,
    ).toBe(200);
  });

  test('an account-bound Device accepts only the matching provider account while cookie-only enrollment stays available', async () => {
    const h = await harness();
    const login = await h.accounts().service.handle(
      new Request(`${origin}/api/account-auth/sign-in/username`, {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'alice', password: h.password }),
      }),
      '/sign-in/username',
    );
    const Cookie = login.headers.getSetCookie()[0]!.split(';')[0]!;
    const authenticated = await h.accounts().service.authenticate(
      new Request(`${origin}/api/account-auth/session`, {
        headers: { Cookie },
      }),
    );
    expect(authenticated.kind).toBe('authenticated');
    if (authenticated.kind !== 'authenticated') return;
    const offer = h.pairing.createOffer({ endpoint: origin });
    const pending = h.pairing.requestPairing({
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: 'Account-bound device',
      requesterPosition: 'off-box',
      accountCandidate: {
        issuer: authenticated.issuer,
        subject: authenticated.session.subject,
        displayName: authenticated.session.displayName,
      },
      accountCandidateSessionId: authenticated.session.sessionId,
    });
    h.pairing.confirmRequest(
      pending.requestId,
      { kind: 'presented-credential' },
      { principalId: 'human:local:operator', kind: 'account' },
    );
    const bound = h.pairing.exchange({
      offerId: offer.offerId,
      proof: offer.challenge,
      requestId: pending.requestId,
    });
    const matching = new ApplicationSessionClient(
      origin,
      stationId,
      origin,
      {
        credential: bound.credential,
        credentialOrigin: origin,
        headers: { Cookie },
      },
      await createApplicationSessionKey(),
    );
    await expect(matching.establish()).resolves.toMatchObject({
      principal: authenticated.principal,
    });

    const signup = await h.accounts().service.handle(
      new Request(`${origin}/api/account-auth/sign-up/username`, {
        method: 'POST',
        headers: {
          Origin: origin,
          'Content-Type': 'application/json',
          'x-station-invitation': 'second-enrollment',
        },
        body: JSON.stringify({
          username: 'bob',
          password: 'Second account fixture password',
        }),
      }),
      '/sign-up/username',
    );
    expect(signup.status).toBe(200);
    const wrong = new ApplicationSessionClient(
      origin,
      stationId,
      origin,
      { credential: bound.credential, credentialOrigin: origin },
      await createApplicationSessionKey(),
    );
    await expect(
      wrong.establish({
        username: 'bob',
        password: 'Second account fixture password',
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  test('a cookie exchange keeps cookies private, persists replay refusal across restart and preserves its account identity', async () => {
    const h = await harness();
    const login = await h.accounts().service.handle(
      new Request(`${origin}/api/account-auth/sign-in/username`, {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'alice', password: h.password }),
      }),
      '/sign-in/username',
    );
    expect(login.status).toBe(200);
    const Cookie = login.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    const cookieClient = new ApplicationSessionClient(
      origin,
      stationId,
      origin,
      {
        credential: h.device.credential,
        credentialOrigin: origin,
        headers: { Cookie },
      },
      h.key,
    );
    const session = await cookieClient.establish();
    expect(JSON.stringify(session)).not.toContain(Cookie);
    const proof = await h.client.headers(session, {
      method: 'GET',
      url: `${origin}/resource`,
    });
    const headers = {
      ...proof,
      Authorization: `Bearer ${h.device.credential}`,
    };
    const first = await h.request('/resource', { headers });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ principal: session.principal });
    await h.restart();
    expect((await h.request('/resource', { headers })).status).toBe(401);
    const fresh = await h.client.headers(session, {
      method: 'GET',
      url: `${origin}/resource`,
    });
    expect(
      (
        await h.request('/resource', {
          headers: { ...fresh, Authorization: `Bearer ${h.device.credential}` },
        })
      ).status,
    ).toBe(200);
  });

  test('another active Device or an alternate allowed origin cannot reuse a continuation, and account disable revokes it', async () => {
    const h = await harness();
    const session = await h.client.establish({
      username: 'alice',
      password: h.password,
    });
    const proof = () =>
      h.client.headers(session, { method: 'GET', url: `${origin}/resource` });
    expect(
      (
        await h.request('/resource', {
          headers: {
            ...(await proof()),
            Authorization: `Bearer ${h.second.credential}`,
          },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await h.request('/resource', {
          headers: {
            ...(await proof()),
            Authorization: `Bearer ${h.device.credential}`,
            Origin: alternateOrigin,
          },
        })
      ).status,
    ).toBe(401);
    const account = h.accounts().administration.list()[0]!;
    h.accounts().administration.setDisabled(account.accountId, true);
    expect(
      (
        await h.request('/resource', {
          headers: {
            ...(await proof()),
            Authorization: `Bearer ${h.device.credential}`,
          },
        })
      ).status,
    ).toBe(401);
    expect(h.pairing.verifyCredential(h.device.credential)).toBe(true);
  });

  test('failed login uses no cookie shortcut, and oversized controls are refused by the body owner', async () => {
    const h = await harness();
    await expect(
      h.client.establish({ username: 'alice', password: 'wrong password' }),
    ).rejects.toThrow();
    const oversized = await h.request('/api/account-auth/continuations/login', {
      method: 'POST',
      body: 'x'.repeat(20 * 1024),
      headers: {
        Origin: origin,
        Authorization: `Bearer ${h.device.credential}`,
      },
    });
    expect(oversized.status).toBe(413);
    expect(h.pairing.verifyCredential(h.device.credential)).toBe(true);
  });
});
