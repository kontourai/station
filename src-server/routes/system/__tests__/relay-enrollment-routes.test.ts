import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APPLICATION_SESSION_VERSION } from '@kontourai/station-contracts/application-session';
import { PAIRING_SCOPE_ORCHESTRATION_READ } from '@kontourai/station-contracts/environment-security';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import {
  RELAY_ENROLLMENT_ACTIVATE_PATH,
  RELAY_ENROLLMENT_BEGIN_PATH,
  RELAY_ENROLLMENT_FINALIZE_PATH,
  RELAY_ENROLLMENT_LOGIN_PATH,
  RELAY_ENROLLMENT_PROOF_AUDIENCE,
  RELAY_ENROLLMENT_PROOF_TYPE,
  RELAY_ENROLLMENT_VERSION,
  type RelayEnrollmentChallenge,
  type RelayEnrollmentDeliveredResponse,
  type RelayEnrollmentPendingResponse,
} from '@kontourai/station-contracts/relay-enrollment';
import {
  createRelayEnrollmentActivationProof,
  createRelayEnrollmentFinalizeProof,
  createRelayEnrollmentKey,
  createRelayEnrollmentLoginProof,
} from '@kontourai/station-sdk/relay-enrollment';
import { exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { VirtualApplicationIngress } from '../../../services/connections/virtual-application.js';
import { RelayEnrollmentService } from '../../../services/identity/relay-enrollment-service.js';
import { openRelayEnrollmentJournal } from '../../../services/relay/relay-enrollment-journal.js';
import { DevicePairingService } from '../../../services/ssh/device-pairing-service.js';
import { createRelayEnrollmentRoutes } from '../relay-enrollment-routes.js';

const stationId = 'station-stage-a-test';
const stationOrigin = 'https://station.example.test';
const clientOrigin = 'https://browser.example.test';
const connectionEnrollmentId = 'enroll-12345678';
const connectionId = 'client-12345678';
const directories: string[] = [];
const journals: Array<ReturnType<typeof openRelayEnrollmentJournal>> = [];

afterEach(() => {
  journals.splice(0).forEach((journal) => journal.close());
  directories
    .splice(0)
    .forEach((path) => rmSync(path, { recursive: true, force: true }));
});

function fixture(
  options: {
    createPending?: (
      enrollmentId: string,
      request: Request,
    ) => Promise<unknown>;
    requestRelay?: (input: unknown, retire: () => void) => unknown;
    providerAvailable?: boolean;
    failPromotion?: boolean;
    failDeviceActivation?: boolean;
    onPromotion?: () => void;
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'station-relay-stage-a-'));
  directories.push(directory);
  const journal = openRelayEnrollmentJournal({
    dbPath: join(directory, `${randomUUID()}.sqlite`),
    stationId,
  });
  journals.push(journal);
  const createPending = vi.fn(
    options.createPending ??
      (async (enrollmentId, _request) => ({
        kind: 'pending',
        session: {
          enrollmentId,
          sessionId: 'pending-session-ref',
          subject: 'local-user-1',
          displayName: 'Local User',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      })),
  );
  const discardPending = vi.fn(async () => {});
  let current = true;
  const ceremony = {
    enrollmentId: undefined as string | undefined,
    sessionId: 'pending-session-ref',
    candidate: undefined as
      | { issuer: string; subject: string; displayName: string }
      | undefined,
    pairing: undefined as
      | { offerId: string; proof: string; requestId: string; expiresAt: number }
      | undefined,
    approvedBy: 'human:deployment:operator',
    approvalId: '33333333-4444-4555-8666-777777777777',
    deviceId: undefined as string | undefined,
    deviceCredential: undefined as string | undefined,
    activeDevice: false,
    providerPromoted: false,
    continuation: undefined as
      | {
          version: typeof APPLICATION_SESSION_VERSION;
          credential: string;
          authorityKey: string;
          stationId: string;
          deviceId: string;
          principal: ReturnType<typeof humanPrincipal>;
          requestOrigin: string;
          clientOrigin: string;
          keyThumbprint: string;
          nonce: string;
          expiresAt: string;
          approvalId: string;
          approvedBy: string;
          issuer: string;
          subject: string;
        }
      | undefined,
  };
  const activationEvents: string[] = [];
  const discardContinuation = vi.fn(() => {
    ceremony.continuation = undefined;
    return 1;
  });
  const applicationSessions = {
    issuePendingRelayContinuation: vi.fn(async (input: Record<string, any>) => {
      const continuation = {
        version: APPLICATION_SESSION_VERSION,
        credential: 'C'.repeat(43),
        authorityKey: input.authorityKey,
        stationId: input.stationId,
        deviceId: input.deviceId,
        principal: humanPrincipal(
          'deployment',
          'local-user-hash',
          'Local User',
        ),
        requestOrigin: stationOrigin,
        clientOrigin: input.clientOrigin,
        keyThumbprint: input.keyThumbprint,
        nonce: input.nonce,
        expiresAt: new Date(input.expiresAt).toISOString(),
        approvalId: input.approvalId,
        approvedBy: input.approvedBy,
        issuer: input.issuer,
        subject: input.subject,
      };
      ceremony.continuation = continuation;
      return continuation;
    }),
    verifyPendingRelayContinuation: vi.fn(
      (input: Record<string, any>) =>
        !!ceremony.continuation &&
        !ceremony.activeDevice &&
        input.enrollmentId === ceremony.enrollmentId &&
        input.deviceId === ceremony.deviceId &&
        input.authorityKey === ceremony.continuation.authorityKey &&
        input.issuer === ceremony.continuation.issuer &&
        input.subject === ceremony.continuation.subject &&
        ceremony.continuation.approvalId === ceremony.approvalId &&
        ceremony.continuation.approvedBy === ceremony.approvedBy,
    ),
    verifyActiveRelayContinuation: vi.fn(
      async (input: Record<string, any>) =>
        !!ceremony.continuation &&
        ceremony.providerPromoted &&
        ceremony.activeDevice &&
        input.enrollmentId === ceremony.enrollmentId &&
        input.deviceId === ceremony.deviceId &&
        input.authorityKey === ceremony.continuation.authorityKey &&
        ceremony.continuation.issuer === ceremony.candidate?.issuer &&
        ceremony.continuation.subject === ceremony.candidate?.subject &&
        ceremony.continuation.approvalId === ceremony.approvalId &&
        ceremony.continuation.approvedBy === ceremony.approvedBy,
    ),
    discardUncommittedAuthority: discardContinuation,
  };
  const pairing = {
    requestRelayEnrollmentAccess: vi.fn((input: any) => {
      ceremony.enrollmentId = input.enrollmentId;
      ceremony.sessionId = input.sessionId;
      ceremony.candidate = input.candidate;
      const pairing = options.requestRelay
        ? options.requestRelay(input, () => {
            current = false;
          })
        : {
            offerId: 'private-offer-1',
            proof: 'private-pairing-proof',
            requestId: 'operator-request-1',
            expiresAt: Date.now() + 60_000,
          };
      ceremony.pairing = pairing as typeof ceremony.pairing;
      return pairing;
    }),
    relayEnrollmentForRequest: vi.fn((requestId: string) => {
      if (ceremony.pairing?.requestId !== requestId || !ceremony.candidate)
        return undefined;
      return {
        enrollmentId: ceremony.enrollmentId,
        offerId: ceremony.pairing.offerId,
        proof: ceremony.pairing.proof,
        requestId,
        sessionId: ceremony.sessionId,
        candidate: ceremony.candidate,
        scope: PAIRING_SCOPE_ORCHESTRATION_READ,
      };
    }),
    confirmRelayEnrollmentRequest: vi.fn(
      (requestId: string, _approval: unknown, principalId: string) => ({
        request: { requestId, status: 'confirmed' },
        principalBinding: {
          kind: 'account',
          ...ceremony.candidate,
          approvedAt: Date.now(),
          approvalId: ceremony.approvalId,
          approvedBy: principalId,
        },
      }),
    ),
    exchangeRelayEnrollment: vi.fn((input: any) => {
      ceremony.deviceId = input.deviceId;
      ceremony.deviceCredential = 'D'.repeat(43);
      return {
        environmentId: stationId,
        device: {
          id: input.deviceId,
          kind: 'device',
          scope: PAIRING_SCOPE_ORCHESTRATION_READ,
          principalBinding: {
            kind: 'account',
            ...ceremony.candidate,
            approvedAt: Date.now(),
            approvalId: ceremony.approvalId,
            approvedBy: ceremony.approvedBy,
          },
        },
        credential: ceremony.deviceCredential,
        replacement: 'none',
      };
    }),
    resolvePendingRelayDevice: vi.fn(
      (deviceId: string, enrollmentId: string) =>
        ceremony.deviceId === deviceId &&
        ceremony.enrollmentId === enrollmentId &&
        !ceremony.activeDevice &&
        ceremony.candidate
          ? {
              deviceId,
              enrollmentId,
              issuer: ceremony.candidate.issuer,
              subject: ceremony.candidate.subject,
              approvalId: ceremony.approvalId,
              approvedBy: ceremony.approvedBy,
              scope: [PAIRING_SCOPE_ORCHESTRATION_READ],
            }
          : null,
    ),
    resolveActiveRelayEnrollmentDevice: vi.fn(
      (deviceId: string, enrollmentId: string) =>
        ceremony.deviceId === deviceId &&
        ceremony.enrollmentId === enrollmentId &&
        ceremony.activeDevice &&
        ceremony.candidate
          ? {
              deviceId,
              enrollmentId,
              issuer: ceremony.candidate.issuer,
              subject: ceremony.candidate.subject,
              approvalId: ceremony.approvalId,
              approvedBy: ceremony.approvedBy,
              scope: [PAIRING_SCOPE_ORCHESTRATION_READ],
            }
          : null,
    ),
    activateRelayEnrollmentDevice: vi.fn(
      (deviceId: string, enrollmentId: string) => {
        activationEvents.push('device-activate');
        if (options.failDeviceActivation)
          throw new Error('injected Device activation persistence fault');
        if (
          ceremony.deviceId !== deviceId ||
          ceremony.enrollmentId !== enrollmentId
        )
          throw new Error('wrong relay Device');
        ceremony.activeDevice = true;
        return {
          id: deviceId,
          kind: 'device',
          scope: PAIRING_SCOPE_ORCHESTRATION_READ,
          principalBinding: {
            kind: 'account',
            ...ceremony.candidate,
            approvedAt: Date.now(),
            approvalId: ceremony.approvalId,
            approvedBy: ceremony.approvedBy,
          },
        };
      },
    ),
    discardRelayEnrollmentDevice: vi.fn(
      (deviceId: string, enrollmentId: string) => {
        if (
          ceremony.deviceId === deviceId &&
          ceremony.enrollmentId === enrollmentId
        ) {
          ceremony.deviceId = undefined;
          ceremony.activeDevice = false;
        }
      },
    ),
    discardRelayEnrollmentOffer: vi.fn(),
  } as unknown as DevicePairingService;
  const issuer = 'urn:station:local-accounts:test';
  const verifyPendingEnrollment = vi.fn(
    async (enrollmentId: string, sessionId: string) =>
      !ceremony.providerPromoted &&
      enrollmentId === ceremony.enrollmentId &&
      sessionId === ceremony.sessionId
        ? {
            kind: 'pending' as const,
            session: {
              enrollmentId,
              sessionId,
              subject: ceremony.candidate?.subject ?? 'local-user-1',
              displayName: ceremony.candidate?.displayName ?? 'Local User',
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            },
          }
        : { kind: 'invalid' as const, reason: 'revoked' as const },
  );
  const verifySessionReference = vi.fn(async (sessionId: string) =>
    ceremony.providerPromoted && sessionId === ceremony.sessionId
      ? {
          kind: 'authenticated' as const,
          issuer,
          principal: humanPrincipal(
            'deployment',
            'local-user-hash',
            'Local User',
          ),
          session: {
            sessionId,
            subject: ceremony.candidate?.subject ?? 'local-user-1',
            displayName: 'Local User',
            authenticatedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            contacts: [],
          },
        }
      : { kind: 'invalid' as const, reason: 'revoked' as const },
  );
  const promotePendingEnrollment = vi.fn(async () => {
    activationEvents.push('provider-promote');
    if (options.failPromotion)
      throw new Error('injected provider promotion fault');
    ceremony.providerPromoted = true;
    options.onPromotion?.();
  });
  const revokeSessionReference = vi.fn(async () => {
    ceremony.providerPromoted = false;
  });
  const service = new RelayEnrollmentService({
    stationId,
    requestOrigin: stationOrigin,
    allowedClientOrigins: [clientOrigin],
    authentication:
      options.providerAvailable === false
        ? undefined
        : ({
            describe: () => ({
              issuer,
              login: {
                kind: 'username-password',
                signInPath: '/sign-in/username',
              },
            }),
            pendingEnrollmentCapabilities: () => ({ available: true }),
            createPendingEnrollment: createPending,
            discardPendingEnrollment: discardPending,
            verifyPendingEnrollment,
            verifySessionReference,
            promotePendingEnrollment,
            revokeSessionReference,
          } as never),
    applicationSessions: applicationSessions as never,
    pairing,
    journal,
  });
  const routes = createRelayEnrollmentRoutes(service);
  const ingress = new VirtualApplicationIngress(stationOrigin, () => ({
    stationId,
    connectionEnrollmentId,
    routingGeneration: 7,
    connectionId,
    stationOrigin,
    browserOrigin: clientOrigin,
    signal: new AbortController().signal,
    isCurrent: () => current,
  }));
  ingress.bind(routes);
  const application = ingress.activate();
  return {
    journal,
    service,
    application,
    setCurrent(value: boolean) {
      current = value;
    },
    createPending,
    discardPending,
    applicationSessions,
    ceremony,
    verifyPendingEnrollment,
    verifySessionReference,
    promotePendingEnrollment,
    revokeSessionReference,
    activationEvents,
  };
}

function post(path: string, body: unknown, signal?: AbortSignal) {
  return new Request(`${stationOrigin}${path}`, {
    method: 'POST',
    headers: { Origin: clientOrigin, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
}

async function prepareDeliveredBundle(h: ReturnType<typeof fixture>) {
  const key = await createRelayEnrollmentKey();
  const begin = await h.application.fetch(
    post(RELAY_ENROLLMENT_BEGIN_PATH, { publicKey: key.publicKey }),
  );
  const challenge = (await begin.json()) as RelayEnrollmentChallenge;
  const loginProof = await createRelayEnrollmentLoginProof(key, challenge, {
    method: 'POST',
    url: `${stationOrigin}${RELAY_ENROLLMENT_LOGIN_PATH}`,
    clientOrigin,
  });
  const login = await h.application.fetch(
    post(RELAY_ENROLLMENT_LOGIN_PATH, {
      enrollmentId: challenge.enrollmentId,
      proof: loginProof,
      credentials: { username: 'alice', password: 'correct horse battery' },
    }),
  );
  const pending = (await login.json()) as RelayEnrollmentPendingResponse;
  await h.service.confirmOperatorBinding({
    requestId: pending.requestId,
    approval: { kind: 'presented-credential' },
    principalId: h.ceremony.approvedBy,
    signal: new AbortController().signal,
    isApprovalCurrent: () => true,
  });
  const finalizeProof = await createRelayEnrollmentFinalizeProof(
    key,
    challenge,
    {
      method: 'POST',
      url: `${stationOrigin}${RELAY_ENROLLMENT_FINALIZE_PATH}`,
      clientOrigin,
    },
  );
  const response = await h.application.fetch(
    post(RELAY_ENROLLMENT_FINALIZE_PATH, {
      enrollmentId: challenge.enrollmentId,
      proof: finalizeProof,
    }),
  );
  return {
    key,
    challenge,
    delivery: (await response.json()) as RelayEnrollmentDeliveredResponse,
  };
}

async function activationBody(
  key: Awaited<ReturnType<typeof createRelayEnrollmentKey>>,
  challenge: RelayEnrollmentChallenge,
  delivery: RelayEnrollmentDeliveredResponse,
) {
  const proof = await createRelayEnrollmentActivationProof(
    key,
    challenge,
    delivery,
    {
      method: 'POST',
      url: `${stationOrigin}${RELAY_ENROLLMENT_ACTIVATE_PATH}`,
      clientOrigin,
    },
  );
  return {
    enrollmentId: challenge.enrollmentId,
    activationNonce: delivery.activationNonce,
    deviceId: delivery.bundle.deviceId,
    authorityKey: delivery.bundle.continuation.authorityKey,
    bundleDigest: delivery.bundleDigest,
    proof,
  };
}

describe('unmounted relay enrollment handler', () => {
  test('begins without provider access and binds opaque verified broker IDs', async () => {
    const h = fixture();
    const pair = await generateKeyPair('ES256');
    const publicKey = await exportJWK(pair.publicKey);
    const response = await h.application.fetch(
      post(RELAY_ENROLLMENT_BEGIN_PATH, {
        publicKey: {
          kty: publicKey.kty,
          crv: publicKey.crv,
          x: publicKey.x,
          y: publicKey.y,
        },
      }),
    );
    expect(response.status).toBe(201);
    const challenge = (await response.json()) as RelayEnrollmentChallenge;
    expect(challenge).toMatchObject({
      version: RELAY_ENROLLMENT_VERSION,
      stationId,
      requestOrigin: stationOrigin,
      clientOrigin,
    });
    expect(h.journal.get(challenge.enrollmentId)).toMatchObject({
      state: 'challenge',
      connectionEnrollmentId,
      connectionId,
      routingGeneration: 7,
    });
    expect(h.createPending).not.toHaveBeenCalled();
  });

  test('refuses a mounted challenge when the account provider lacks fresh-session support', async () => {
    const h = fixture({ providerAvailable: false });
    const key = await createRelayEnrollmentKey();
    const response = await h.application.fetch(
      post(RELAY_ENROLLMENT_BEGIN_PATH, { publicKey: key.publicKey }),
    );
    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({
      error: { code: 'relay_enrollment_unsupported' },
    });
    expect(h.journal.listUnfinished()).toEqual([]);
    expect(h.createPending).not.toHaveBeenCalled();
  });

  test('validates one-time key proof before provider call and returns only pending metadata', async () => {
    const h = fixture();
    const pair = await generateKeyPair('ES256');
    const publicKey = await exportJWK(pair.publicKey);
    const begun = await h.application.fetch(
      post(RELAY_ENROLLMENT_BEGIN_PATH, {
        publicKey: {
          kty: publicKey.kty,
          crv: publicKey.crv,
          x: publicKey.x,
          y: publicKey.y,
        },
      }),
    );
    const challenge = (await begun.json()) as RelayEnrollmentChallenge;
    const proof = await new SignJWT({
      v: RELAY_ENROLLMENT_VERSION,
      stationId,
      enrollmentId: challenge.enrollmentId,
      clientOrigin,
      keyThumbprint: challenge.keyThumbprint,
      nonce: challenge.nonce,
      purpose: 'login',
      htm: 'POST',
      htu: `${stationOrigin}${RELAY_ENROLLMENT_LOGIN_PATH}`,
    })
      .setProtectedHeader({ alg: 'ES256', typ: RELAY_ENROLLMENT_PROOF_TYPE })
      .setAudience(RELAY_ENROLLMENT_PROOF_AUDIENCE)
      .setJti(randomUUID().replaceAll('-', '').slice(0, 22))
      .setIssuedAt()
      .setExpirationTime('30s')
      .sign(pair.privateKey);
    const decoded = await jwtVerify(proof, pair.publicKey, {
      algorithms: ['ES256'],
      audience: RELAY_ENROLLMENT_PROOF_AUDIENCE,
    });
    expect(Object.keys(decoded.payload).sort()).toEqual([
      'aud',
      'clientOrigin',
      'enrollmentId',
      'exp',
      'htm',
      'htu',
      'iat',
      'jti',
      'keyThumbprint',
      'nonce',
      'purpose',
      'stationId',
      'v',
    ]);
    const loginBody = {
      enrollmentId: challenge.enrollmentId,
      proof,
      credentials: { username: 'alice', password: 'correct horse battery' },
    };
    const response = await h.application.fetch(
      post(RELAY_ENROLLMENT_LOGIN_PATH, loginBody),
    );
    expect(
      response.status,
      JSON.stringify({
        body: await response.clone().json(),
        entry: h.journal.get(challenge.enrollmentId),
      }),
    ).toBe(202);
    const result = await response.json();
    expect(result).toMatchObject({
      state: 'pending',
      requestId: 'operator-request-1',
    });
    expect(result).not.toHaveProperty('offerProof');
    expect(result).not.toHaveProperty('providerSessionId');
    expect(h.journal.get(challenge.enrollmentId)).toMatchObject({
      state: 'pairing-requested',
      issuer: 'urn:station:local-accounts:test',
      subject: 'local-user-1',
    });
    const providerRequest = vi.mocked(h.createPending).mock
      .calls[0]?.[1] as Request;
    expect(providerRequest.headers.get('cookie')).toBeNull();
    expect(providerRequest.headers.get('authorization')).toBeNull();
    expect(providerRequest.headers.get('origin')).toBe(clientOrigin);
    expect(await providerRequest.json()).toEqual({
      username: 'alice',
      password: 'correct horse battery',
    });
    const replay = await h.application.fetch(
      post(RELAY_ENROLLMENT_LOGIN_PATH, loginBody),
    );
    expect(replay.status).toBe(410);
    expect(h.createPending).toHaveBeenCalledOnce();
  });

  test('generic VAI requests have no enrollment authority and cookies stop before provider', async () => {
    const h = fixture();
    const pair = await generateKeyPair('ES256');
    const publicKey = await exportJWK(pair.publicKey);
    const genericRoutes = createRelayEnrollmentRoutes(h.service);
    const genericIngress = new VirtualApplicationIngress(stationOrigin);
    genericIngress.bind(genericRoutes);
    const generic = genericIngress.activate();
    const response = await generic.fetch(
      post(RELAY_ENROLLMENT_BEGIN_PATH, {
        publicKey: {
          kty: publicKey.kty,
          crv: publicKey.crv,
          x: publicKey.x,
          y: publicKey.y,
        },
      }),
    );
    expect(response.status).toBe(400);
    const wrongOrigin = await h.application.fetch(
      new Request(`${stationOrigin}${RELAY_ENROLLMENT_BEGIN_PATH}`, {
        method: 'POST',
        headers: {
          Origin: 'https://attacker.example',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          publicKey: {
            kty: publicKey.kty,
            crv: publicKey.crv,
            x: publicKey.x,
            y: publicKey.y,
          },
        }),
      }),
    );
    expect(wrongOrigin.status).toBe(403);
    const withCookie = new Request(
      `${stationOrigin}${RELAY_ENROLLMENT_LOGIN_PATH}`,
      {
        method: 'POST',
        headers: {
          Origin: clientOrigin,
          'Content-Type': 'application/json',
          Cookie: 'session=secret',
        },
        body: '{}',
      },
    );
    const cookieResponse = await h.application.fetch(withCookie);
    expect(cookieResponse.status).toBe(400);
    expect(h.createPending).not.toHaveBeenCalled();
  });

  test('anonymous begin budget is global and bounded', async () => {
    const h = fixture();
    const pair = await generateKeyPair('ES256');
    const jwk = await exportJWK(pair.publicKey);
    const body = {
      publicKey: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
    };
    for (let index = 0; index < 120; index += 1) {
      const response = await h.application.fetch(
        post(RELAY_ENROLLMENT_BEGIN_PATH, body),
      );
      expect(response.status).toBe(201);
      await response.body?.cancel();
    }
    const limited = await h.application.fetch(
      post(RELAY_ENROLLMENT_BEGIN_PATH, body),
    );
    expect(limited.status).toBe(429);
    expect(h.createPending).not.toHaveBeenCalled();
  });

  test('aborted late provider result is discarded by attempt ID before any session ID was journaled', async () => {
    const controller = new AbortController();
    const h = fixture({
      createPending: async (enrollmentId) => {
        controller.abort(new Error('relay peer retired after provider commit'));
        return {
          kind: 'pending',
          session: {
            enrollmentId,
            sessionId: 'created-after-abort',
            subject: 'local-user-1',
            displayName: 'Local User',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        };
      },
    });
    const pair = await generateKeyPair('ES256');
    const jwk = await exportJWK(pair.publicKey);
    const begun = await h.application.fetch(
      post(RELAY_ENROLLMENT_BEGIN_PATH, {
        publicKey: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
      }),
    );
    const challenge = (await begun.json()) as RelayEnrollmentChallenge;
    const proof = await new SignJWT({
      v: RELAY_ENROLLMENT_VERSION,
      stationId,
      enrollmentId: challenge.enrollmentId,
      clientOrigin,
      keyThumbprint: challenge.keyThumbprint,
      nonce: challenge.nonce,
      purpose: 'login',
      htm: 'POST',
      htu: `${stationOrigin}${RELAY_ENROLLMENT_LOGIN_PATH}`,
    })
      .setProtectedHeader({ alg: 'ES256', typ: RELAY_ENROLLMENT_PROOF_TYPE })
      .setAudience(RELAY_ENROLLMENT_PROOF_AUDIENCE)
      .setJti('J'.repeat(22))
      .setIssuedAt()
      .setExpirationTime('30s')
      .sign(pair.privateKey);
    await expect(
      h.application.fetch(
        post(
          RELAY_ENROLLMENT_LOGIN_PATH,
          {
            enrollmentId: challenge.enrollmentId,
            proof,
            credentials: {
              username: 'alice',
              password: 'correct horse battery',
            },
          },
          controller.signal,
        ),
      ),
    ).rejects.toThrow();
    await vi.waitFor(() =>
      expect(h.discardPending).toHaveBeenCalledWith(
        challenge.enrollmentId,
        undefined,
        expect.any(AbortSignal),
      ),
    );
    expect(h.journal.get(challenge.enrollmentId)).toMatchObject({
      state: 'failed',
      terminalReason: 'provider-unavailable',
    });
  });

  test('peer retirement after private pairing creation immediately cleans the provider and offer', async () => {
    const h = fixture({
      requestRelay: (_input, retire) => {
        retire();
        return {
          offerId: 'private-offer-after-retire',
          proof: 'private-pairing-proof',
          requestId: 'operator-request-after-retire',
          expiresAt: Date.now() + 60_000,
        };
      },
    });
    const pair = await generateKeyPair('ES256');
    const jwk = await exportJWK(pair.publicKey);
    const begun = await h.application.fetch(
      post(RELAY_ENROLLMENT_BEGIN_PATH, {
        publicKey: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
      }),
    );
    const challenge = (await begun.json()) as RelayEnrollmentChallenge;
    const proof = await new SignJWT({
      v: RELAY_ENROLLMENT_VERSION,
      stationId,
      enrollmentId: challenge.enrollmentId,
      clientOrigin,
      keyThumbprint: challenge.keyThumbprint,
      nonce: challenge.nonce,
      purpose: 'login',
      htm: 'POST',
      htu: `${stationOrigin}${RELAY_ENROLLMENT_LOGIN_PATH}`,
    })
      .setProtectedHeader({ alg: 'ES256', typ: RELAY_ENROLLMENT_PROOF_TYPE })
      .setAudience(RELAY_ENROLLMENT_PROOF_AUDIENCE)
      .setJti('K'.repeat(22))
      .setIssuedAt()
      .setExpirationTime('30s')
      .sign(pair.privateKey);
    const response = await h.application.fetch(
      post(RELAY_ENROLLMENT_LOGIN_PATH, {
        enrollmentId: challenge.enrollmentId,
        proof,
        credentials: { username: 'alice', password: 'correct horse battery' },
      }),
    );
    expect(response.status).toBe(503);
    await vi.waitFor(() =>
      expect(h.discardPending).toHaveBeenCalledWith(
        challenge.enrollmentId,
        'pending-session-ref',
        expect.any(AbortSignal),
      ),
    );
    expect(h.journal.get(challenge.enrollmentId)).toMatchObject({
      state: 'failed',
      terminalReason: 'recovery-required',
    });
  });

  test('verified virtual ingress completes operator approval, inert delivery and current-access ACK', async () => {
    const h = fixture();
    const key = await createRelayEnrollmentKey();
    const begun = await h.application.fetch(
      post(RELAY_ENROLLMENT_BEGIN_PATH, { publicKey: key.publicKey }),
    );
    expect(begun.status).toBe(201);
    const challenge = (await begun.json()) as RelayEnrollmentChallenge;
    const loginProof = await createRelayEnrollmentLoginProof(key, challenge, {
      method: 'POST',
      url: `${stationOrigin}${RELAY_ENROLLMENT_LOGIN_PATH}`,
      clientOrigin,
    });
    const login = await h.application.fetch(
      post(RELAY_ENROLLMENT_LOGIN_PATH, {
        enrollmentId: challenge.enrollmentId,
        proof: loginProof,
        credentials: { username: 'alice', password: 'correct horse battery' },
      }),
    );
    expect(login.status).toBe(202);
    const pending = (await login.json()) as RelayEnrollmentPendingResponse;

    const finalizeProof = () =>
      createRelayEnrollmentFinalizeProof(key, challenge, {
        method: 'POST',
        url: `${stationOrigin}${RELAY_ENROLLMENT_FINALIZE_PATH}`,
        clientOrigin,
      });
    const waiting = await h.application.fetch(
      post(RELAY_ENROLLMENT_FINALIZE_PATH, {
        enrollmentId: challenge.enrollmentId,
        proof: await finalizeProof(),
      }),
    );
    expect(waiting.status).toBe(200);
    expect(await waiting.json()).toMatchObject({ state: 'pending' });
    expect(h.ceremony.deviceId).toBeUndefined();

    await h.service.confirmOperatorBinding({
      requestId: pending.requestId,
      approval: { kind: 'presented-credential' },
      principalId: h.ceremony.approvedBy,
      signal: new AbortController().signal,
      isApprovalCurrent: () => true,
    });
    const finalized = await h.application.fetch(
      post(RELAY_ENROLLMENT_FINALIZE_PATH, {
        enrollmentId: challenge.enrollmentId,
        proof: await finalizeProof(),
      }),
    );
    expect(
      finalized.status,
      JSON.stringify({
        body: await finalized.clone().json(),
        entry: h.journal.get(challenge.enrollmentId),
      }),
    ).toBe(200);
    const delivery =
      (await finalized.json()) as RelayEnrollmentDeliveredResponse;
    expect(delivery).toMatchObject({
      state: 'delivered',
      enrollmentId: challenge.enrollmentId,
      bundle: {
        stationId,
        deviceId: h.ceremony.deviceId,
        deviceCredential: h.ceremony.deviceCredential,
        continuation: {
          authorityKey: h.ceremony.continuation?.authorityKey,
        },
      },
    });
    expect(h.ceremony.providerPromoted).toBe(false);
    expect(h.ceremony.activeDevice).toBe(false);
    expect(h.journal.get(challenge.enrollmentId)).toMatchObject({
      state: 'awaiting-ack',
      bundleDigest: delivery.bundleDigest,
      activationNonce: delivery.activationNonce,
    });
    const activationProof = await createRelayEnrollmentActivationProof(
      key,
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
    const activated = await h.application.fetch(
      post(RELAY_ENROLLMENT_ACTIVATE_PATH, activationBody),
    );
    expect(activated.status).toBe(200);
    const receipt = await activated.json();
    expect(receipt).toMatchObject({
      state: 'active',
      enrollmentId: challenge.enrollmentId,
      deviceId: delivery.bundle.deviceId,
    });
    expect(h.ceremony.providerPromoted).toBe(true);
    expect(h.ceremony.activeDevice).toBe(true);
    expect(h.journal.get(challenge.enrollmentId)).toMatchObject({
      state: 'committed',
    });

    const retry = await h.application.fetch(
      post(RELAY_ENROLLMENT_ACTIVATE_PATH, activationBody),
    );
    expect(
      retry.status,
      JSON.stringify({
        body: await retry.clone().json(),
        ceremony: {
          providerPromoted: h.ceremony.providerPromoted,
          activeDevice: h.ceremony.activeDevice,
          continuation: h.ceremony.continuation,
        },
        activeResolverCalls:
          h.applicationSessions.verifyActiveRelayContinuation.mock.calls,
      }),
    ).toBe(200);
    expect(await retry.json()).toEqual(receipt);
    h.revokeSessionReference();
    const revokedProviderRetry = await h.application.fetch(
      post(RELAY_ENROLLMENT_ACTIVATE_PATH, activationBody),
    );
    expect(revokedProviderRetry.status).toBe(503);
    h.ceremony.providerPromoted = true;
    h.ceremony.activeDevice = false;
    const revokedDeviceRetry = await h.application.fetch(
      post(RELAY_ENROLLMENT_ACTIVATE_PATH, activationBody),
    );
    expect(revokedDeviceRetry.status).toBe(503);
  });

  test('uncertain finalize delivery is cleaned on retry and requires a fresh attempt', async () => {
    const h = fixture();
    const key = await createRelayEnrollmentKey();
    const begun = await h.application.fetch(
      post(RELAY_ENROLLMENT_BEGIN_PATH, { publicKey: key.publicKey }),
    );
    const challenge = (await begun.json()) as RelayEnrollmentChallenge;
    const loginProof = await createRelayEnrollmentLoginProof(key, challenge, {
      method: 'POST',
      url: `${stationOrigin}${RELAY_ENROLLMENT_LOGIN_PATH}`,
      clientOrigin,
    });
    const login = await h.application.fetch(
      post(RELAY_ENROLLMENT_LOGIN_PATH, {
        enrollmentId: challenge.enrollmentId,
        proof: loginProof,
        credentials: { username: 'alice', password: 'correct horse battery' },
      }),
    );
    const pending = (await login.json()) as RelayEnrollmentPendingResponse;
    await h.service.confirmOperatorBinding({
      requestId: pending.requestId,
      approval: { kind: 'presented-credential' },
      principalId: h.ceremony.approvedBy,
      signal: new AbortController().signal,
      isApprovalCurrent: () => true,
    });
    const makeFinalize = () =>
      createRelayEnrollmentFinalizeProof(key, challenge, {
        method: 'POST',
        url: `${stationOrigin}${RELAY_ENROLLMENT_FINALIZE_PATH}`,
        clientOrigin,
      });
    const firstDelivery = await h.application.fetch(
      post(RELAY_ENROLLMENT_FINALIZE_PATH, {
        enrollmentId: challenge.enrollmentId,
        proof: await makeFinalize(),
      }),
    );
    expect(
      firstDelivery.status,
      JSON.stringify({
        body: await firstDelivery.clone().json(),
        entry: h.journal.get(challenge.enrollmentId),
      }),
    ).toBe(200);
    const lost =
      (await firstDelivery.json()) as RelayEnrollmentDeliveredResponse;
    const retry = await h.application.fetch(
      post(RELAY_ENROLLMENT_FINALIZE_PATH, {
        enrollmentId: challenge.enrollmentId,
        proof: await makeFinalize(),
      }),
    );
    expect(retry.status).toBe(503);
    expect(await retry.json()).toMatchObject({
      error: { code: 'relay_enrollment_unavailable' },
    });
    expect(h.journal.get(challenge.enrollmentId)).toMatchObject({
      state: 'failed',
    });
    expect(h.revokeSessionReference).toHaveBeenCalled();
    expect(
      h.applicationSessions.discardUncommittedAuthority,
    ).toHaveBeenCalledWith(
      lost.bundle.continuation.authorityKey,
      challenge.enrollmentId,
    );
    expect(h.ceremony.activeDevice).toBe(false);
    expect(h.ceremony.providerPromoted).toBe(false);
  });

  test('promotion and Device persistence faults recover by revoking every new resource', async () => {
    for (const failure of ['promotion', 'device-activation'] as const) {
      const h = fixture({
        failPromotion: failure === 'promotion',
        failDeviceActivation: failure === 'device-activation',
      });
      const { key, challenge, delivery } = await prepareDeliveredBundle(h);
      const response = await h.application.fetch(
        post(
          RELAY_ENROLLMENT_ACTIVATE_PATH,
          await activationBody(key, challenge, delivery),
        ),
      );
      expect(response.status).toBe(503);
      expect(h.ceremony.providerPromoted).toBe(false);
      expect(h.ceremony.activeDevice).toBe(false);
      expect(h.ceremony.deviceId).toBeUndefined();
      expect(h.ceremony.continuation).toBeUndefined();
      expect(h.journal.get(challenge.enrollmentId)).toMatchObject({
        state: 'failed',
        terminalReason: 'activation-failed',
      });
      expect(h.activationEvents).toEqual(
        failure === 'promotion'
          ? ['provider-promote']
          : ['provider-promote', 'device-activate'],
      );
    }
  });

  test('peer abort after provider promotion revokes the session before Device activation', async () => {
    const controller = new AbortController();
    const h = fixture({
      onPromotion: () => controller.abort(new Error('peer retired during ACK')),
    });
    const { key, challenge, delivery } = await prepareDeliveredBundle(h);
    await expect(
      h.application.fetch(
        post(
          RELAY_ENROLLMENT_ACTIVATE_PATH,
          await activationBody(key, challenge, delivery),
          controller.signal,
        ),
      ),
    ).rejects.toThrow();
    expect(h.activationEvents).toEqual(['provider-promote']);
    expect(h.ceremony.providerPromoted).toBe(false);
    expect(h.ceremony.activeDevice).toBe(false);
    expect(h.ceremony.deviceId).toBeUndefined();
    expect(h.ceremony.continuation).toBeUndefined();
    expect(h.journal.get(challenge.enrollmentId)).toMatchObject({
      state: 'failed',
      terminalReason: 'activation-failed',
    });
  });
});
