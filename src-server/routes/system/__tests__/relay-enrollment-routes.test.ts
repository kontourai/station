import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RELAY_ENROLLMENT_BEGIN_PATH,
  RELAY_ENROLLMENT_LOGIN_PATH,
  RELAY_ENROLLMENT_PROOF_AUDIENCE,
  RELAY_ENROLLMENT_PROOF_TYPE,
  RELAY_ENROLLMENT_VERSION,
  type RelayEnrollmentChallenge,
} from '@kontourai/station-contracts/relay-enrollment';
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
  const pairing = {
    requestRelayEnrollmentAccess: vi.fn((input: unknown) =>
      options.requestRelay
        ? options.requestRelay(input, () => {
            current = false;
          })
        : {
            offerId: 'private-offer-1',
            proof: 'private-pairing-proof',
            requestId: 'operator-request-1',
            expiresAt: Date.now() + 60_000,
          },
    ),
    discardRelayEnrollmentOffer: vi.fn(),
  } as unknown as DevicePairingService;
  const service = new RelayEnrollmentService({
    stationId,
    requestOrigin: stationOrigin,
    allowedClientOrigins: [clientOrigin],
    authentication: {
      describe: () => ({
        issuer: 'urn:station:local-accounts:test',
        login: { kind: 'username-password', signInPath: '/sign-in/username' },
      }),
      pendingEnrollmentCapabilities: () => ({ available: true }),
      createPendingEnrollment: createPending,
      discardPendingEnrollment: discardPending,
      revokeSessionReference: vi.fn(async () => {}),
    } as never,
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
});
