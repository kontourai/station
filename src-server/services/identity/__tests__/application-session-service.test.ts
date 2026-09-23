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
    (value) => pairing.credentialAliasId(value),
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
    second,
    pairing,
    password,
    accounts: () => accounts,
    application: () => currentApp,
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
        (value) => pairing.credentialAliasId(value),
      )!;
      currentApp = app();
    },
  };
}

describe('Device-bound continuation persistence and negative admission', () => {
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
