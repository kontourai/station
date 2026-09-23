import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PAIRING_SCOPE_ORCHESTRATION_READ,
  pairingScopePresetString,
} from '@kontourai/station-contracts/environment-security';
import {
  ApplicationSessionClient,
  createApplicationSessionKey,
} from '@kontourai/station-sdk/application-session';
import { Hono } from 'hono';
import { calculateJwkThumbprint } from 'jose';
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
  let resolvePendingRelayDevice = (_deviceId: string, _enrollmentId: string) =>
    null as {
      deviceId: string;
      enrollmentId: string;
      issuer: string;
      subject: string;
      approvalId: string;
      approvedBy: string;
      scope: readonly string[];
    } | null;
  const resolvePending = (deviceId: string, enrollmentId: string) =>
    resolvePendingRelayDevice(deviceId, enrollmentId);
  const resolveActive = (deviceId: string, enrollmentId: string) =>
    pairing.resolveActiveRelayEnrollmentDevice(deviceId, enrollmentId);
  let accounts = await loadLocalAccounts(configuration, host, enrollment);
  let sessions = createApplicationSessionRuntime(
    home,
    stationId,
    accounts,
    (value) => pairing.identifyDevice(value),
    resolvePending,
    resolveActive,
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
        resolvePending,
        resolveActive,
      )!;
      currentApp = app();
    },
    setPendingRelayDeviceResolver(resolver: typeof resolvePendingRelayDevice) {
      resolvePendingRelayDevice = resolver;
    },
  };
}

describe('Device-bound continuation persistence and negative admission', () => {
  test('relay cleanup keys cannot remove an ordinary continuation', async () => {
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
    expect(
      h
        .sessions()
        .discardUncommittedAuthority(continuation.authorityKey, 'N'.repeat(43)),
    ).toBe(0);
    expect(() =>
      h
        .sessions()
        .discardUncommittedAuthority(
          continuation.authorityKey,
          undefined as never,
        ),
    ).toThrow();
    expect(
      (await h.request('/resource', { method: 'GET', headers })).status,
    ).toBe(200);
  });

  test('pending relay continuation stays inert until its exact Device activates and provider session is promoted', async () => {
    const h = await harness();
    const enrollmentId = 'N'.repeat(43);
    const pending = await h.accounts().service.createPendingEnrollment(
      enrollmentId,
      new Request(`${origin}/api/account-auth/sign-in/username`, {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'alice', password: h.password }),
      }),
    );
    expect(pending.kind).toBe('pending');
    if (pending.kind !== 'pending')
      throw new Error('provider did not create a pending enrollment session');
    const issuer = h.accounts().service.describe().issuer;
    const relayOffer = h.pairing.requestRelayEnrollmentAccess({
      enrollmentId,
      endpoint: origin,
      candidate: {
        issuer,
        subject: pending.session.subject,
        displayName: pending.session.displayName,
      },
      sessionId: pending.session.sessionId,
    });
    const relayConfirmation = h.pairing.confirmRelayEnrollmentRequest(
      relayOffer.requestId,
      { kind: 'presented-credential' },
      'human:deployment:operator',
      {
        enrollmentId,
        sessionId: pending.session.sessionId,
        issuer,
        subject: pending.session.subject,
      },
    );
    const relayBinding = relayConfirmation.principalBinding;
    if (
      !relayBinding ||
      !('kind' in relayBinding) ||
      relayBinding.kind !== 'account'
    )
      throw new Error('operator confirmation did not bind an account');
    const device = h.pairing.exchangeRelayEnrollment({
      offerId: relayOffer.offerId,
      proof: relayOffer.proof,
      requestId: relayOffer.requestId,
      enrollmentId,
      deviceId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    });
    const key = await createApplicationSessionKey();
    const authorityKey = randomUUID();
    const pendingDeviceAssertion = (
      candidateId: string,
      candidateEnrollmentId: string,
    ) =>
      candidateId === device.device.id && candidateEnrollmentId === enrollmentId
        ? {
            deviceId: device.device.id,
            enrollmentId,
            issuer,
            subject: pending.session.subject,
            approvalId: relayBinding.approvalId,
            approvedBy: relayBinding.approvedBy,
            scope: [PAIRING_SCOPE_ORCHESTRATION_READ],
          }
        : null;
    h.setPendingRelayDeviceResolver(pendingDeviceAssertion);
    const issueInput = {
      enrollmentId,
      deviceId: device.device.id,
      providerSessionId: pending.session.sessionId,
      issuer,
      subject: pending.session.subject,
      approvalId: relayBinding.approvalId,
      approvedBy: relayBinding.approvedBy,
      authorityKey,
      stationId,
      clientOrigin: origin,
      key: key.publicKey,
      keyThumbprint: await calculateJwkThumbprint(key.publicKey),
      nonce: 'Z'.repeat(43),
      expiresAt: Date.parse(pending.session.expiresAt),
      signal: new AbortController().signal,
    };
    await expect(
      h.sessions().issuePendingRelayContinuation({
        ...issueInput,
        stationId: `${stationId}-wrong`,
      }),
    ).rejects.toThrow();
    await expect(
      h.sessions().issuePendingRelayContinuation({
        ...issueInput,
        clientOrigin: 'https://untrusted.example.test',
      }),
    ).rejects.toThrow();
    await expect(
      h.sessions().issuePendingRelayContinuation({
        ...issueInput,
        keyThumbprint: 'Y'.repeat(43),
      }),
    ).rejects.toThrow();
    await expect(
      h.sessions().issuePendingRelayContinuation({
        ...issueInput,
        providerSessionId: randomUUID(),
      }),
    ).rejects.toThrow();
    await expect(
      h.sessions().issuePendingRelayContinuation({
        ...issueInput,
        enrollmentId: 'O'.repeat(43),
      }),
    ).rejects.toThrow();
    await expect(
      h.sessions().issuePendingRelayContinuation({
        ...issueInput,
        deviceId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
      }),
    ).rejects.toThrow();
    h.setPendingRelayDeviceResolver(() => null);
    await expect(
      h.sessions().issuePendingRelayContinuation(issueInput),
    ).rejects.toThrow();
    h.setPendingRelayDeviceResolver(() => ({
      deviceId: device.device.id,
      enrollmentId,
      issuer: `${issuer}-foreign`,
      subject: pending.session.subject,
      approvalId: relayBinding.approvalId,
      approvedBy: relayBinding.approvedBy,
      scope: [PAIRING_SCOPE_ORCHESTRATION_READ],
    }));
    await expect(
      h.sessions().issuePendingRelayContinuation(issueInput),
    ).rejects.toThrow();
    h.setPendingRelayDeviceResolver(() => ({
      deviceId: device.device.id,
      enrollmentId,
      issuer,
      subject: `${pending.session.subject}-foreign`,
      approvalId: relayBinding.approvalId,
      approvedBy: relayBinding.approvedBy,
      scope: [PAIRING_SCOPE_ORCHESTRATION_READ],
    }));
    await expect(
      h.sessions().issuePendingRelayContinuation(issueInput),
    ).rejects.toThrow();
    h.setPendingRelayDeviceResolver(() => ({
      deviceId: device.device.id,
      enrollmentId,
      issuer,
      subject: pending.session.subject,
      approvalId: relayBinding.approvalId,
      approvedBy: relayBinding.approvedBy,
      scope: [],
    }));
    await expect(
      h.sessions().issuePendingRelayContinuation(issueInput),
    ).rejects.toThrow();
    h.setPendingRelayDeviceResolver(() => ({
      deviceId: device.device.id,
      enrollmentId,
      issuer,
      subject: pending.session.subject,
      approvalId: randomUUID(),
      approvedBy: relayBinding.approvedBy,
      scope: [PAIRING_SCOPE_ORCHESTRATION_READ],
    }));
    await expect(
      h.sessions().issuePendingRelayContinuation(issueInput),
    ).rejects.toThrow();
    h.setPendingRelayDeviceResolver(() => ({
      deviceId: device.device.id,
      enrollmentId,
      issuer,
      subject: pending.session.subject,
      approvalId: relayBinding.approvalId,
      approvedBy: `${relayBinding.approvedBy}-changed`,
      scope: [PAIRING_SCOPE_ORCHESTRATION_READ],
    }));
    await expect(
      h.sessions().issuePendingRelayContinuation(issueInput),
    ).rejects.toThrow();
    h.setPendingRelayDeviceResolver(pendingDeviceAssertion);
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      h.sessions().issuePendingRelayContinuation({
        ...issueInput,
        authorityKey: randomUUID(),
        signal: aborted.signal,
      }),
    ).rejects.toThrow();
    const faultInput = issueInput;
    const faultDb = openPrivateSqlite(
      join(h.home, 'authentication', 'application-sessions.sqlite'),
      'Application session persistence fault fixture',
    );
    try {
      faultDb.exec(`CREATE TRIGGER fail_relay_continuation_insert
        BEFORE INSERT ON application_sessions
        WHEN json_extract(NEW.record, '$.relayEnrollmentId') IS NOT NULL
        BEGIN SELECT RAISE(ABORT, 'injected relay persistence fault'); END`);
      await expect(
        h.sessions().issuePendingRelayContinuation(faultInput),
      ).rejects.toThrow();
      faultDb.exec('DROP TRIGGER fail_relay_continuation_insert');
      expect(
        faultDb
          .prepare(
            "SELECT count(*) AS n FROM application_sessions WHERE json_extract(record, '$.authorityKey')=?",
          )
          .get(faultInput.authorityKey)?.n,
      ).toBe(0);
    } finally {
      faultDb.exec('DROP TRIGGER IF EXISTS fail_relay_continuation_insert');
      faultDb.close();
    }
    const continuation = await h
      .sessions()
      .issuePendingRelayContinuation(issueInput);
    expect(h.sessions().verifyPendingRelayContinuation(issueInput)).toBe(true);
    expect(
      h.sessions().verifyPendingRelayContinuation({
        ...issueInput,
        approvalId: randomUUID(),
      }),
    ).toBe(false);
    expect(
      h.sessions().verifyPendingRelayContinuation({
        ...issueInput,
        approvedBy: `${issueInput.approvedBy}-changed`,
      }),
    ).toBe(false);
    await expect(
      h.sessions().issuePendingRelayContinuation({
        ...issueInput,
        authorityKey: randomUUID(),
      }),
    ).rejects.toThrow();
    await expect(
      h.sessions().issuePendingRelayContinuation(issueInput),
    ).rejects.toThrow();
    const pendingClient = new ApplicationSessionClient(
      origin,
      stationId,
      origin,
      { credential: device.credential, credentialOrigin: origin },
      key,
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
    const pendingProvider = await h.request('/resource', {
      method: 'GET',
      headers: {
        ...(await pendingClient.headers(continuation, {
          method: 'GET',
          url: `${origin}/resource`,
        })),
        Authorization: `Bearer ${device.credential}`,
      },
    });
    expect(pendingProvider.status).toBe(401);

    await h
      .accounts()
      .service.promotePendingEnrollment(
        enrollmentId,
        pending.session.sessionId,
        new AbortController().signal,
      );
    const admitted = await h.request('/resource', {
      method: 'GET',
      headers: {
        ...signed,
        Authorization: `Bearer ${device.credential}`,
      },
    });
    expect(await h.sessions().verifyActiveRelayContinuation(issueInput)).toBe(
      true,
    );
    expect(admitted.status).toBe(200);
    expect(await admitted.json()).toMatchObject({
      principal: continuation.principal,
    });
    await h.restart();
    const afterRestart = await h.request('/resource', {
      method: 'GET',
      headers: {
        ...(await pendingClient.headers(continuation, {
          method: 'GET',
          url: `${origin}/resource`,
        })),
        Authorization: `Bearer ${device.credential}`,
      },
    });
    expect(afterRestart.status).toBe(200);
    expect(await afterRestart.json()).toMatchObject({
      principal: continuation.principal,
    });
    expect(
      h.sessions().discardUncommittedAuthority(authorityKey, 'O'.repeat(43)),
    ).toBe(0);
    let providerVerificationEntered!: () => void;
    let releaseProviderVerification!: () => void;
    const entered = new Promise<void>((resolve) => {
      providerVerificationEntered = resolve;
    });
    const providerGate = new Promise<void>((resolve) => {
      releaseProviderVerification = resolve;
    });
    const originalVerify = h
      .accounts()
      .service.verifySessionReference.bind(h.accounts().service);
    const verifySpy = vi
      .spyOn(h.accounts().service, 'verifySessionReference')
      .mockImplementation(async (...args) => {
        providerVerificationEntered();
        await providerGate;
        return originalVerify(...args);
      });
    try {
      const checking = h.sessions().verifyActiveRelayContinuation(issueInput);
      await entered;
      h.pairing.revokeDevice(device.device.id, 'operator-credential');
      releaseProviderVerification();
      await expect(checking).resolves.toBe(false);
    } finally {
      releaseProviderVerification();
      verifySpy.mockRestore();
    }
    expect(
      h.sessions().discardUncommittedAuthority(authorityKey, enrollmentId),
    ).toBe(1);
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
