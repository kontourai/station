import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pairingScopePresetString } from '@kontourai/station-contracts/environment-security';
import {
  ApplicationSessionClient,
  createApplicationSessionKey,
} from '@kontourai/station-sdk/application-session';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createApplicationSessionRoutes } from '../../../routes/system/application-session-routes.js';
import { openPrivateSqlite } from '../../../utils/private-sqlite.js';
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
  const pairing = new DevicePairingService({
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
  let sessions = createApplicationSessionRuntime(
    home,
    stationId,
    accounts,
    (value) => pairing.identifyDevice(value),
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
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => currentApp.request(url, init)),
  );
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
    home,
    second,
    pairing,
    password,
    accounts: () => accounts,
    sessions: () => sessions,
    request: (path: string, init: RequestInit) =>
      currentApp.request(origin + path, init),
    async restart() {
      sessions.close();
      await accounts.service.close();
      accounts = await loadLocalAccounts(configuration, host, enrollment);
      sessions = createApplicationSessionRuntime(
        home,
        stationId,
        accounts,
        (value) => pairing.identifyDevice(value),
      )!;
      currentApp = app();
    },
  };
}

describe('Device-bound continuation persistence and negative admission', () => {
  test('startup cleanup can discard one uncommitted continuation authority by reserved key', async () => {
    const h = await harness();
    const continuation = await h.client.establish({
      username: 'alice',
      password: h.password,
    });
    const headers = {
      ...(await h.client.headers(continuation, {
        method: 'GET',
        url: `${origin}/resource`,
      })),
      Authorization: `Bearer ${h.device.credential}`,
    };
    const before = await h.request('/resource', { method: 'GET', headers });
    expect(before.status).toBe(200);

    expect(
      h.sessions().discardUncommittedAuthority(continuation.authorityKey),
    ).toBe(1);
    expect(
      h.sessions().discardUncommittedAuthority(continuation.authorityKey),
    ).toBe(0);
    const after = await h.request('/resource', { method: 'GET', headers });
    expect(after.status).toBe(401);
    expect(await after.json()).toEqual({ kind: 'invalid' });
  });

  test('a continuation bound to a relay Device stays blocked until that exact Device activates', async () => {
    const h = await harness();
    const continuation = await h.client.establish({
      username: 'alice',
      password: h.password,
    });
    const login = await h.accounts().service.handle(
      new Request(`${origin}/api/account-auth/sign-in/username`, {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'alice', password: h.password }),
      }),
      '/sign-in/username',
    );
    expect(login.status).toBe(200);
    const accountCookie = login.headers.getSetCookie()[0]!.split(';')[0]!;
    const account = await h.accounts().service.authenticate(
      new Request(`${origin}/api/account-auth/session`, {
        headers: { Cookie: accountCookie },
      }),
    );
    expect(account.kind).toBe('authenticated');
    if (account.kind !== 'authenticated')
      throw new Error('provider session fixture did not authenticate');
    const enrollmentId = 'N'.repeat(43);
    const pending = h.pairing.requestRelayEnrollmentAccess({
      enrollmentId,
      endpoint: origin,
      candidate: {
        issuer: account.issuer,
        subject: account.session.subject,
        displayName: account.session.displayName,
      },
      sessionId: account.session.sessionId,
    });
    h.pairing.confirmRelayEnrollmentRequest(
      pending.requestId,
      { kind: 'presented-credential' },
      'human:deployment:operator',
      {
        enrollmentId,
        sessionId: account.session.sessionId,
        issuer: account.issuer,
        subject: account.session.subject,
      },
    );
    const device = h.pairing.exchangeRelayEnrollment({
      offerId: pending.offerId,
      proof: pending.proof,
      requestId: pending.requestId,
      enrollmentId,
      deviceId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    });

    // Seed a real continuation record bound to the reserved Device so the
    // control below proves the pending admission fence itself, not an
    // unrelated deviceId mismatch.
    const continuationDb = openPrivateSqlite(
      join(h.home, 'authentication', 'application-sessions.sqlite'),
      'Application session test continuation binding',
    );
    try {
      const tokenHash = createHash('sha256')
        .update(continuation.credential)
        .digest('base64url');
      const row = continuationDb
        .prepare('SELECT record FROM application_sessions WHERE token_hash=?')
        .get(tokenHash);
      expect(typeof row?.record).toBe('string');
      const record = JSON.parse(row!.record as string) as Record<
        string,
        unknown
      >;
      record.deviceId = device.device.id;
      continuationDb
        .prepare('UPDATE application_sessions SET record=? WHERE token_hash=?')
        .run(JSON.stringify(record), tokenHash);
    } finally {
      continuationDb.close();
    }
    const pendingClient = new ApplicationSessionClient(
      origin,
      stationId,
      origin,
      { credential: device.credential, credentialOrigin: origin },
      h.key,
    );
    const signed = await pendingClient.headers(continuation, {
      method: 'GET',
      url: `${origin}/resource`,
    });
    const response = await h.request('/resource', {
      method: 'GET',
      headers: {
        ...signed,
        Authorization: `Bearer ${device.credential}`,
      },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ kind: 'invalid' });
    expect(h.pairing.identifyDevice(device.credential)).toBeNull();

    h.pairing.activateRelayEnrollmentDevice(device.device.id, enrollmentId);
    const admitted = await h.request('/resource', {
      method: 'GET',
      headers: {
        ...signed,
        Authorization: `Bearer ${device.credential}`,
      },
    });
    expect(admitted.status).toBe(200);
    expect(await admitted.json()).toMatchObject({
      principal: continuation.principal,
    });
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
