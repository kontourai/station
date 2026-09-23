import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  APPLICATION_SESSION_BASE_PATH,
  APPLICATION_SESSION_VERSION,
  type ApplicationSessionContinuation,
} from '@kontourai/station-contracts/application-session';
import { PAIRING_SCOPE_ORCHESTRATION_READ } from '@kontourai/station-contracts/environment-security';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import {
  RELAY_ENROLLMENT_ACTIVATE_PATH,
  RELAY_ENROLLMENT_BEGIN_PATH,
  RELAY_ENROLLMENT_FINALIZE_PATH,
  RELAY_ENROLLMENT_LOGIN_PATH,
  RELAY_ENROLLMENT_VERSION,
  type RelayEnrollmentChallenge,
  type RelayEnrollmentDeliveredResponse,
  type RelayEnrollmentPendingResponse,
} from '@kontourai/station-contracts/relay-enrollment';
import { ApplicationSessionClient } from '@kontourai/station-sdk/application-session';
import {
  createRelayEnrollmentActivationProof,
  createRelayEnrollmentFinalizeProof,
  createRelayEnrollmentKey,
  createRelayEnrollmentLoginProof,
} from '@kontourai/station-sdk/relay-enrollment';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createApplicationSessionRoutes } from '../../../routes/system/application-session-routes.js';
import { createRelayEnrollmentRoutes } from '../../../routes/system/relay-enrollment-routes.js';
import { configureRuntimeHttp } from '../../../runtime/bootstrap/runtime-http.js';
import {
  EXTERNAL_SURFACE_CAPABILITY_TABLE,
  findUnclassifiedRuntimeHttpRoutes,
} from '../../../security/pairing-route-scopes.js';
import { openPrivateSqlite } from '../../../utils/private-sqlite.js';
import { VirtualApplicationIngress } from '../../connections/virtual-application.js';
import { DevicePairingService } from '../../ssh/device-pairing-service.js';
import { createApplicationSessionRuntime } from '../application-session-runtime.js';
import { loadLocalAccounts } from '../local-account-runtime.js';
import { createRelayEnrollmentRuntime } from '../relay-enrollment-service.js';

const stationId = '33333333-3333-4333-8333-333333333333';
const stationOrigin = 'https://station.example.test';
const clientOrigin = 'https://browser.example.test';
const homes: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const cleanup of cleanups.splice(0)) await cleanup();
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});

function post(path: string, body: unknown) {
  return new Request(`${stationOrigin}${path}`, {
    method: 'POST',
    headers: { Origin: clientOrigin, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} exceeded the test bound`)),
          10_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

describe('fresh relay enrollment over verified virtual ingress', () => {
  test('real local provider and Pairing service require operator ACK before account-protected Device access', async () => {
    const home = await mkdtemp(join(tmpdir(), 'station-relay-virtual-e2e-'));
    homes.push(home);
    await mkdir(join(home, 'security'), { recursive: true, mode: 0o700 });
    const pairing = new DevicePairingService({
      homeDir: home,
      environmentId: stationId,
    });
    const accounts = await loadLocalAccounts(
      { publicOrigin: stationOrigin, allowedBrowserOrigins: [clientOrigin] },
      { stationId, homeDirectory: home },
      { mayRegister: async () => true },
    );
    const applicationSessions = createApplicationSessionRuntime(
      home,
      stationId,
      accounts,
      (credential) => pairing.identifyDevice(credential),
      pairing.resolvePendingRelayDevice.bind(pairing),
      pairing.resolveActiveRelayEnrollmentDevice.bind(pairing),
    );
    expect(applicationSessions).toBeDefined();
    const relayEnrollment = await createRelayEnrollmentRuntime({
      home,
      stationId,
      requestOrigin: stationOrigin,
      allowedClientOrigins: [clientOrigin],
      authentication: accounts.service,
      applicationSessions,
      pairing,
    });
    expect(relayEnrollment).toBeDefined();
    cleanups.push(() => relayEnrollment!.close());
    cleanups.push(() => applicationSessions!.close());
    cleanups.push(() => accounts.service.close());
    const app = new Hono();
    configureRuntimeHttp({
      app: app as never,
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        fatal: vi.fn(),
      } as never,
      eventBus: { emit: vi.fn() } as never,
      security: {
        deploymentAuthentication: accounts.service,
        verifyCredential: (credential: string) =>
          pairing.identifyDevice(credential) !== null,
        resolveGrantedScope: (credential: string) =>
          pairing.identifyDevice(credential)?.scope,
        allowedOrigins: [clientOrigin, stationOrigin],
      },
    });
    const enrollmentPaths = [
      RELAY_ENROLLMENT_BEGIN_PATH,
      RELAY_ENROLLMENT_LOGIN_PATH,
      RELAY_ENROLLMENT_FINALIZE_PATH,
      RELAY_ENROLLMENT_ACTIVATE_PATH,
    ] as const;
    const enrollmentPathSet = new Set<string>(enrollmentPaths);
    expect(
      EXTERNAL_SURFACE_CAPABILITY_TABLE.filter((rule) =>
        enrollmentPathSet.has(rule.prefix),
      ).map(({ method, prefix, capability }) => ({
        method,
        path: prefix,
        capability,
      })),
    ).toEqual(
      enrollmentPaths.map((path) => ({
        method: 'POST',
        path,
        capability: 'public',
      })),
    );
    expect(
      findUnclassifiedRuntimeHttpRoutes(
        enrollmentPaths.map((path) => ({ method: 'POST', path })),
      ),
    ).toEqual([]);
    const relayRoutes = createRelayEnrollmentRoutes(relayEnrollment!);
    app.post(RELAY_ENROLLMENT_BEGIN_PATH, (c) => relayRoutes.fetch(c.req.raw));
    app.post(RELAY_ENROLLMENT_LOGIN_PATH, (c) => relayRoutes.fetch(c.req.raw));
    app.post(RELAY_ENROLLMENT_FINALIZE_PATH, (c) =>
      relayRoutes.fetch(c.req.raw),
    );
    app.post(RELAY_ENROLLMENT_ACTIVATE_PATH, (c) =>
      relayRoutes.fetch(c.req.raw),
    );
    app.route(
      '/api/account-auth/continuations',
      createApplicationSessionRoutes(applicationSessions),
    );
    app.get('/api/system/relay-resource', async (c) => {
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
    const directHttps = await app.request(RELAY_ENROLLMENT_BEGIN_PATH, {
      method: 'POST',
      headers: {
        Origin: clientOrigin,
        'Content-Type': 'application/json',
        'X-Pion-Verified': 'true',
      },
      body: JSON.stringify({
        publicKey: (await createRelayEnrollmentKey()).publicKey,
      }),
    });
    expect(directHttps.status).toBe(400);
    const peerCurrent = true;
    const peerLifetime = new AbortController();
    const ingress = new VirtualApplicationIngress(stationOrigin, () => ({
      stationId,
      connectionEnrollmentId: 'enroll-12345678',
      routingGeneration: 4,
      connectionId: 'client-12345678',
      stationOrigin,
      browserOrigin: clientOrigin,
      signal: peerLifetime.signal,
      isCurrent: () => peerCurrent,
    }));
    ingress.bind(app);
    const channel = ingress.activate();

    const password = 'Real local provider relay test password';
    const signup = await accounts.service.handle(
      new Request(`${stationOrigin}/api/account-auth/sign-up/username`, {
        method: 'POST',
        headers: {
          Origin: clientOrigin,
          'Content-Type': 'application/json',
          'x-station-invitation': 'test-enrollment',
        },
        body: JSON.stringify({ username: 'relayuser', password }),
      }),
      '/sign-up/username',
    );
    expect(signup.status).toBe(200);

    const relayKey = await createRelayEnrollmentKey();
    const begun = await channel.fetch(
      post(RELAY_ENROLLMENT_BEGIN_PATH, { publicKey: relayKey.publicKey }),
    );
    expect(begun.status).toBe(201);
    const challenge = (await begun.json()) as RelayEnrollmentChallenge;
    expect(challenge.version).toBe(RELAY_ENROLLMENT_VERSION);
    const loginProof = await createRelayEnrollmentLoginProof(
      relayKey,
      challenge,
      {
        method: 'POST',
        url: `${stationOrigin}${RELAY_ENROLLMENT_LOGIN_PATH}`,
        clientOrigin,
      },
    );
    const loggedIn = await channel.fetch(
      post(RELAY_ENROLLMENT_LOGIN_PATH, {
        enrollmentId: challenge.enrollmentId,
        proof: loginProof,
        credentials: { username: 'relayuser', password },
      }),
    );
    expect(loggedIn.status).toBe(202);
    const pending = (await loggedIn.json()) as RelayEnrollmentPendingResponse;
    expect(pending).not.toHaveProperty('providerSessionId');
    expect(pending).not.toHaveProperty('offerProof');

    const finalizeProof = () =>
      createRelayEnrollmentFinalizeProof(relayKey, challenge, {
        method: 'POST',
        url: `${stationOrigin}${RELAY_ENROLLMENT_FINALIZE_PATH}`,
        clientOrigin,
      });
    const beforeApproval = await channel.fetch(
      post(RELAY_ENROLLMENT_FINALIZE_PATH, {
        enrollmentId: challenge.enrollmentId,
        proof: await finalizeProof(),
      }),
    );
    expect(beforeApproval.status).toBe(200);
    expect(await beforeApproval.json()).toMatchObject({ state: 'pending' });

    await relayEnrollment!.confirmOperatorBinding({
      requestId: pending.requestId,
      approval: { kind: 'presented-credential' },
      principalId: humanPrincipal('deployment', 'operator', 'Operator').id,
      signal: new AbortController().signal,
      isApprovalCurrent: () => true,
    });
    const finalized = await channel.fetch(
      post(RELAY_ENROLLMENT_FINALIZE_PATH, {
        enrollmentId: challenge.enrollmentId,
        proof: await finalizeProof(),
      }),
    );
    expect(finalized.status).toBe(200);
    const delivery =
      (await finalized.json()) as RelayEnrollmentDeliveredResponse;
    expect(delivery).toMatchObject({
      version: RELAY_ENROLLMENT_VERSION,
      state: 'delivered',
      enrollmentId: challenge.enrollmentId,
      bundle: {
        deviceId: delivery.bundle.deviceId,
        stationId,
        continuation: {
          version: APPLICATION_SESSION_VERSION,
          deviceId: delivery.bundle.deviceId,
          stationId,
          clientOrigin,
        },
      },
    });
    expect(pairing.identifyDevice(delivery.bundle.deviceCredential)).toBeNull();
    expect(pairing.verifyCredential(delivery.bundle.deviceCredential)).toBe(
      false,
    );

    const applicationKey = relayKey;
    const accountClient = new ApplicationSessionClient(
      stationOrigin,
      stationId,
      clientOrigin,
      {
        credential: delivery.bundle.deviceCredential,
        credentialOrigin: clientOrigin,
      },
      applicationKey,
    );
    const pendingHeaders = await accountClient.headers(
      delivery.bundle.continuation,
      { method: 'GET', url: `${stationOrigin}/api/system/relay-resource` },
    );
    const pendingAccess = await channel.fetch(
      new Request(`${stationOrigin}/api/system/relay-resource`, {
        headers: {
          ...pendingHeaders,
          Authorization: `Bearer ${delivery.bundle.deviceCredential}`,
        },
      }),
    );
    expect(pendingAccess.status).toBe(401);

    const activationProof = await createRelayEnrollmentActivationProof(
      relayKey,
      challenge,
      delivery,
      {
        method: 'POST',
        url: `${stationOrigin}${RELAY_ENROLLMENT_ACTIVATE_PATH}`,
        clientOrigin,
      },
    );
    const activationBody = {
      enrollmentId: challenge.enrollmentId,
      activationNonce: delivery.activationNonce,
      deviceId: delivery.bundle.deviceId,
      authorityKey: delivery.bundle.continuation.authorityKey,
      bundleDigest: delivery.bundleDigest,
      proof: activationProof,
    };
    const activated = await channel.fetch(
      post(RELAY_ENROLLMENT_ACTIVATE_PATH, activationBody),
    );
    expect(activated.status).toBe(200);
    expect(await activated.json()).toMatchObject({
      state: 'active',
      deviceId: delivery.bundle.deviceId,
    });
    expect(
      pairing.identifyDevice(delivery.bundle.deviceCredential),
    ).toMatchObject({
      id: delivery.bundle.deviceId,
      scope: PAIRING_SCOPE_ORCHESTRATION_READ,
    });
    const protectedHeaders = await accountClient.headers(
      delivery.bundle.continuation,
      { method: 'GET', url: `${stationOrigin}/api/system/relay-resource` },
    );
    const admitted = await channel.fetch(
      new Request(`${stationOrigin}/api/system/relay-resource`, {
        headers: {
          ...protectedHeaders,
          Authorization: `Bearer ${delivery.bundle.deviceCredential}`,
        },
      }),
    );
    expect(admitted.status, JSON.stringify(await admitted.clone().json())).toBe(
      200,
    );
    expect(await admitted.json()).toMatchObject({
      principal: delivery.bundle.continuation.principal,
    });
    const renewalUrl = `${stationOrigin}${APPLICATION_SESSION_BASE_PATH}/renew`;
    const renew = async (continuation: ApplicationSessionContinuation) => {
      const headers = await accountClient.headers(continuation, {
        method: 'POST',
        url: renewalUrl,
      });
      return channel.fetch(
        new Request(renewalUrl, {
          method: 'POST',
          headers: {
            ...headers,
            Authorization: `Bearer ${delivery.bundle.deviceCredential}`,
            'Content-Type': 'application/json',
          },
          body: '{}',
        }),
      );
    };
    const applicationSessionDatabase = openPrivateSqlite(
      join(home, 'authentication', 'application-sessions.sqlite'),
      'Relay renewal rollback fixture',
    );
    try {
      const previousContinuation = applicationSessionDatabase
        .prepare(
          "SELECT record FROM application_sessions WHERE json_extract(record, '$.authorityKey')=?",
        )
        .get(delivery.bundle.continuation.authorityKey)?.record;
      expect(JSON.parse(previousContinuation as string)).toMatchObject({
        relayEnrollmentId: challenge.enrollmentId,
      });
      applicationSessionDatabase.exec(`CREATE TRIGGER fail_relay_renewal_insert
        BEFORE INSERT ON application_sessions
        WHEN json_extract(NEW.record, '$.relayEnrollmentId') IS NOT NULL
        BEGIN SELECT RAISE(ABORT, 'injected relay renewal insert fault'); END;`);
      const failedRenewal = await within(
        renew(delivery.bundle.continuation),
        'fault-injected relay renewal',
      );
      expect(
        failedRenewal.status,
        JSON.stringify(await failedRenewal.clone().json()),
      ).toBe(503);
      const originalStillWorksHeaders = await accountClient.headers(
        delivery.bundle.continuation,
        {
          method: 'GET',
          url: `${stationOrigin}/api/system/relay-resource`,
        },
      );
      const originalStillWorks = await channel.fetch(
        new Request(`${stationOrigin}/api/system/relay-resource`, {
          headers: {
            ...originalStillWorksHeaders,
            Authorization: `Bearer ${delivery.bundle.deviceCredential}`,
          },
        }),
      );
      expect(originalStillWorks.status).toBe(200);
    } finally {
      applicationSessionDatabase.exec(
        'DROP TRIGGER IF EXISTS fail_relay_renewal_insert',
      );
      applicationSessionDatabase.close();
    }

    const responses = await within(
      Promise.all([
        renew(delivery.bundle.continuation),
        renew(delivery.bundle.continuation),
      ]),
      'concurrent relay renewals',
    );
    const acceptedRenewals = responses.filter(
      (response) => response.status === 200,
    );
    expect(acceptedRenewals).toHaveLength(1);
    const payload = (await acceptedRenewals[0]!.json()) as {
      data: ApplicationSessionContinuation;
    };
    const rotated = payload.data;
    expect(rotated).toMatchObject({
      authorityKey: delivery.bundle.continuation.authorityKey,
      deviceId: delivery.bundle.deviceId,
      principal: delivery.bundle.continuation.principal,
      keyThumbprint: delivery.bundle.continuation.keyThumbprint,
    });
    expect(rotated).toBeDefined();
    const staleHeaders = await accountClient.headers(
      delivery.bundle.continuation,
      { method: 'GET', url: `${stationOrigin}/api/system/relay-resource` },
    );
    const staleAccess = await channel.fetch(
      new Request(`${stationOrigin}/api/system/relay-resource`, {
        headers: {
          ...staleHeaders,
          Authorization: `Bearer ${delivery.bundle.deviceCredential}`,
        },
      }),
    );
    expect(staleAccess.status).toBe(401);
    const rotatedHeaders = await accountClient.headers(rotated!, {
      method: 'GET',
      url: `${stationOrigin}/api/system/relay-resource`,
    });
    const rotatedAccess = await channel.fetch(
      new Request(`${stationOrigin}/api/system/relay-resource`, {
        headers: {
          ...rotatedHeaders,
          Authorization: `Bearer ${delivery.bundle.deviceCredential}`,
        },
      }),
    );
    expect(rotatedAccess.status).toBe(200);
    expect(
      await applicationSessions!.verifyActiveRelayContinuation({
        authorityKey: delivery.bundle.continuation.authorityKey,
        enrollmentId: challenge.enrollmentId,
        deviceId: delivery.bundle.deviceId,
        clientOrigin,
        keyThumbprint: delivery.bundle.continuation.keyThumbprint,
        signal: new AbortController().signal,
      }),
    ).toBe(true);

    const activeContinuationSpy = vi.spyOn(
      applicationSessions!,
      'verifyActiveRelayContinuation',
    );
    const activeVerificationsBeforeReplay =
      activeContinuationSpy.mock.results.length;
    const committedReplay = await channel.fetch(
      post(RELAY_ENROLLMENT_ACTIVATE_PATH, activationBody),
    );
    const activeReplayResults = await Promise.all(
      activeContinuationSpy.mock.results
        .slice(activeVerificationsBeforeReplay)
        .map((result) => result.value),
    );
    expect(activeReplayResults).toEqual([true]);
    activeContinuationSpy.mockClear();
    expect(
      committedReplay.status,
      JSON.stringify(await committedReplay.clone().json()),
    ).toBe(200);
    expect(await committedReplay.json()).toMatchObject({
      state: 'active',
      deviceId: delivery.bundle.deviceId,
    });

    let releaseReplay!: () => void;
    let replayVerificationEntered!: () => void;
    let replayTimeout: ReturnType<typeof setTimeout> | undefined;
    const replayGate = new Promise<void>((resolve) => {
      releaseReplay = resolve;
    });
    const replayEntered = new Promise<
      { kind: 'provider-verification' } | { kind: 'timeout' }
    >((resolve) => {
      replayTimeout = setTimeout(() => resolve({ kind: 'timeout' }), 10_000);
      replayVerificationEntered = () => {
        clearTimeout(replayTimeout);
        resolve({ kind: 'provider-verification' });
      };
    });
    const replaySessionVerification =
      accounts.service.verifySessionReference.bind(accounts.service);
    const replayVerificationSpy = vi
      .spyOn(accounts.service, 'verifySessionReference')
      .mockImplementation(async (...args) => {
        replayVerificationEntered();
        await replayGate;
        return replaySessionVerification(...args);
      });
    const enrollmentJournal = (
      relayEnrollment as unknown as {
        options: {
          journal: {
            get(id: string): unknown;
          };
        };
      }
    ).options.journal;
    const originalJournalGet = enrollmentJournal.get.bind(enrollmentJournal);
    let useStaleAwaitingAck = true;
    enrollmentJournal.get = (id: string) => {
      const record = originalJournalGet(id);
      if (
        useStaleAwaitingAck &&
        record &&
        typeof record === 'object' &&
        'state' in record &&
        record.state === 'committed'
      ) {
        useStaleAwaitingAck = false;
        return {
          ...record,
          state: 'awaiting-ack',
          authorityKey: delivery.bundle.continuation.authorityKey,
        };
      }
      return record;
    };
    try {
      const replay = channel.fetch(
        post(RELAY_ENROLLMENT_ACTIVATE_PATH, activationBody),
      );
      const replayProgress = await Promise.race([
        replayEntered,
        replay.then(async (response) => ({
          kind: 'completed' as const,
          status: response.status,
          body: await response.text(),
        })),
      ]);
      if (replayProgress.kind === 'timeout')
        throw new Error('Committed ACK replay missed provider verification');
      if (replayProgress.kind === 'completed')
        throw new Error(
          `Committed ACK replay completed before provider verification: ${replayProgress.status} ${replayProgress.body}`,
        );
      expect(useStaleAwaitingAck).toBe(false);
      expect(replayProgress.kind).toBe('provider-verification');
      expect(
        applicationSessions!.discardUncommittedAuthority(
          delivery.bundle.continuation.authorityKey,
          challenge.enrollmentId,
        ),
      ).toBe(1);
      releaseReplay();
      clearTimeout(replayTimeout);
      const replayResult = await within(replay, 'committed ACK replay');
      expect(replayResult.status).not.toBe(200);
    } finally {
      enrollmentJournal.get = originalJournalGet;
      releaseReplay();
      replayVerificationSpy.mockRestore();
      activeContinuationSpy.mockRestore();
    }
    expect(peerCurrent).toBe(true);
    const wrongOrigin = await channel.fetch(
      new Request(`${stationOrigin}${RELAY_ENROLLMENT_ACTIVATE_PATH}`, {
        method: 'POST',
        headers: {
          Origin: 'https://other.example',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(activationBody),
      }),
    );
    expect(wrongOrigin.status).toBe(403);
    ingress.stop();
  });
});
