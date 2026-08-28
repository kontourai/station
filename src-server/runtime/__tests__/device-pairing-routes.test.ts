import { createHmac } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { type HttpBindings } from '@hono/node-server';
import {
  DEFAULT_GRANT_PAIRING_SCOPE,
  type DevicePairingOffer,
  type DevicePairingRequest,
  type PairedDevice,
  PUBLIC_DEVICE_PAIRING_ACCESS_REQUEST_PATH,
  PUBLIC_DEVICE_PAIRING_LOCAL_GRANT_PATH,
  PUBLIC_DEVICE_PAIRING_UI_BOOTSTRAP_PATH,
} from '@kontourai/station-contracts';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { PairingFailureLimiter } from '../../security/pairing-failure-limiter.js';
import type { EventBus } from '../../services/orchestration/event-bus.js';
import { ClientConnectionPresence } from '../../services/ssh/client-connection-presence.js';
import { DevicePairingService } from '../../services/ssh/device-pairing-service.js';
import {
  devicePairingRequests,
  deviceSessionExchanges,
} from '../../telemetry/metrics.js';
import {
  getInternalApiToken,
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_INGRESS_IDENTITY_HEADER,
  INTERNAL_PROXY_CALLER_HEADER,
  INTERNAL_PROXY_FORWARDED_HOST_HEADER,
  INTERNAL_PROXY_PEER_HEADER,
} from '../../utils/internal-api-token.js';
import type { Logger } from '../../utils/logger.js';
import { configureRuntimeHttp } from '../bootstrap/runtime-http.js';
import {
  configureDevicePairingHostRoutes,
  configureDevicePairingPublicRoutes,
  type PairingApprovalAuditRecord,
  type PairingAuthFailureAuditRecord,
} from '../routes/runtime-routes.js';

const MASTER_CREDENTIAL = 'master-credential';
const ENVIRONMENT_ID = '11111111-1111-4111-8111-111111111111';
const REMOTE_PEER = '100.96.12.7';
const homes: string[] = [];

type TestBindings = HttpBindings & {
  incoming: HttpBindings['incoming'] & {
    socket: HttpBindings['incoming']['socket'] & { remoteAddress?: string };
  };
};

function createHarness(
  options: {
    maxActiveOffers?: number;
    maxActiveCredentialsWithoutVerifiedIdentity?: number;
    localGrant?: boolean;
    uiBootstrapToken?: string;
    now?: () => number;
    failureLimiter?: PairingFailureLimiter;
    connectedClientPresence?: ClientConnectionPresence;
    clientPresenceAvailable?: boolean;
    resolvePublicIngressOrigin?: () => Promise<string | undefined>;
  } = {},
) {
  const homeDir = mkdtempSync(join(tmpdir(), 'station-pairing-routes-'));
  homes.push(homeDir);
  mkdirSync(join(homeDir, 'security'), { mode: 0o700 });
  const pairing = new DevicePairingService({
    homeDir,
    environmentId: ENVIRONMENT_ID,
    maxActiveOffers: options.maxActiveOffers,
    maxActiveCredentialsWithoutVerifiedIdentity:
      options.maxActiveCredentialsWithoutVerifiedIdentity,
    now: options.now,
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
    getLevel: vi.fn(() => 'info' as const),
  };
  const app = new Hono<{ Bindings: TestBindings }>();
  const localGrantSecretPath = join(homeDir, 'runtime', 'local-grant.secret');
  const auditRecords: PairingApprovalAuditRecord[] = [];
  const authFailureAuditRecords: PairingAuthFailureAuditRecord[] = [];
  configureDevicePairingPublicRoutes(app as never, pairing, {
    allowedOrigins: ['https://station.example.test'],
    ...(options.localGrant
      ? { localGrant: { secretPath: localGrantSecretPath } }
      : {}),
    uiBootstrapToken: options.uiBootstrapToken,
    audit: (record) => auditRecords.push(record),
    authFailureAudit: (record) => authFailureAuditRecords.push(record),
    authFailureSourceId: (source) =>
      createHmac('sha256', 'test-pairing-audit-key')
        .update('station.pairing.audit.source.v1\0')
        .update(source)
        .digest('base64url'),
    failureLimiter: options.failureLimiter,
    now: options.now,
    ...(options.resolvePublicIngressOrigin
      ? { resolvePublicIngressOrigin: options.resolvePublicIngressOrigin }
      : {}),
  });
  configureRuntimeHttp({
    app: app as never,
    logger,
    eventBus: { emit: vi.fn() } as unknown as EventBus,
    security: {
      verifyCredential: (credential, request) =>
        credential === MASTER_CREDENTIAL ||
        (!request?.path.startsWith('/api/pairing') &&
          pairing.verifyCredential(credential)),
      // The master credential carries every scope; a real paired device
      // resolves through the same service `verifyCredential` above uses.
      resolveGrantedScope: (credential) =>
        credential === MASTER_CREDENTIAL
          ? DEFAULT_GRANT_PAIRING_SCOPE
          : pairing.identifyDevice(credential)?.scope,
      resolveCredentialAuthority: (credential) =>
        credential === MASTER_CREDENTIAL
          ? 'operator-credential'
          : pairing.identifyDevice(credential)
            ? 'device-credential'
            : undefined,
      resolveCredentialLocality: (credential) =>
        pairing.credentialLocality(credential),
      allowedOrigins: ['https://station.example.test'],
    },
  });
  configureDevicePairingHostRoutes(app as never, pairing, {
    audit: (record) => auditRecords.push(record),
    connectedClientPresence: options.connectedClientPresence,
    clientPresenceAvailable: options.clientPresenceAvailable,
  });
  app.get('/api/projects', (c) => c.json({ projects: [] }));
  app.post('/api/projects', (c) => c.json({ projects: [] }));
  app.get('/events', (c) =>
    c.body('data: connected\n\n', 200, {
      'Content-Type': 'text/event-stream',
    }),
  );

  const request = (path: string, init: RequestInit = {}, peer = REMOTE_PEER) =>
    app.request(path, init, {
      incoming: { socket: { remoteAddress: peer } },
    } as TestBindings);
  /**
   * A request whose socket carries no `remoteAddress` at all — what a peer
   * Station cannot read looks like. Separate from `request` because that
   * helper's default parameter would substitute a real remote peer for
   * `undefined` and quietly prove the opposite of what a caller wanted.
   */
  const requestWithoutPeer = (path: string, init: RequestInit = {}) =>
    app.request(path, init, {
      incoming: { socket: {} },
    } as unknown as TestBindings);
  const json = (body: unknown, credential?: string): RequestInit => ({
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return {
    logger,
    pairing,
    request,
    requestWithoutPeer,
    json,
    auditRecords,
    authFailureAuditRecords,
    localGrantSecretPath,
    readLocalGrantSecret: () => readFileSync(localGrantSecretPath, 'utf8'),
  };
}

async function pairDevice(
  harness: ReturnType<typeof createHarness>,
  name: string,
  clientInstanceId?: string,
  scope?: string,
): Promise<{
  environmentId: string;
  device: PairedDevice;
  credential: string;
}> {
  const offerResponse = await harness.request(
    '/api/pairing/offers',
    harness.json(
      { endpoint: 'https://station.example.test', ...(scope ? { scope } : {}) },
      MASTER_CREDENTIAL,
    ),
  );
  expect(offerResponse.status).toBe(201);
  const offer = (await offerResponse.json()) as DevicePairingOffer;
  const requestResponse = await harness.request(
    '/.well-known/station/v1/pairing/request',
    harness.json({
      ...(clientInstanceId ? { clientInstanceId } : {}),
      deviceName: name,
      offerId: offer.offerId,
      proof: offer.challenge,
    }),
  );
  expect(requestResponse.status).toBe(202);
  const pending = (await requestResponse.json()) as DevicePairingRequest;
  const confirm = await harness.request(
    `/api/pairing/requests/${pending.requestId}/confirm`,
    harness.json({}, MASTER_CREDENTIAL),
  );
  expect(confirm.status).toBe(200);
  const exchange = await harness.request(
    '/.well-known/station/v1/pairing/exchange',
    harness.json({
      ...(clientInstanceId ? { clientInstanceId } : {}),
      offerId: offer.offerId,
      proof: offer.challenge,
      requestId: pending.requestId,
    }),
  );
  expect(exchange.status).toBe(200);
  return exchange.json() as Promise<{
    environmentId: string;
    device: PairedDevice;
    credential: string;
  }>;
}

afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

describe('public pairing abuse hardening (station#2001)', () => {
  test('retains pre-threshold source history and bounds capacity overflow per surface', () => {
    let now = 1_000;
    const limiter = new PairingFailureLimiter({
      now: () => now,
      failureThreshold: 3,
      maxTrackedSources: 2,
      maxOverflowAttempts: 2,
      overflowWindowMs: 5_000,
    });

    for (const source of ['retained-one', 'retained-two']) {
      const result = limiter.admit('pairing-request', source);
      expect(result.kind).toBe('admitted');
      if (result.kind === 'admitted')
        limiter.finalize(result.admission, 'failure');
    }
    // The two retained peers are still below the lock threshold, but capacity
    // pressure must not erase that history and let them start over.
    const retained = limiter.admit('pairing-request', 'retained-one');
    expect(retained.kind).toBe('admitted');
    if (retained.kind === 'admitted')
      limiter.finalize(retained.admission, 'failure');

    let admitted = 0;
    let denied = 0;
    for (let index = 0; index < 100; index += 1) {
      const result = limiter.admit('pairing-request', `new-peer-${index}`);
      if (result.kind === 'admitted') {
        admitted += 1;
        limiter.finalize(result.admission, 'failure');
      } else {
        denied += 1;
      }
    }
    expect(admitted).toBe(2);
    expect(denied).toBe(98);

    now = 2_500;
    const midWindow = limiter.admit('pairing-request', 'mid-window-peer');
    expect(midWindow).toMatchObject({
      kind: 'rate-limited',
      retryAfterSeconds: 4,
    });
    now = 6_000;
    expect(limiter.admit('pairing-request', 'recovered-peer').kind).toBe(
      'admitted',
    );
  });

  test('keeps locked sources through per-surface churn and bounds overflow without permanent starvation', () => {
    let now = 1_000;
    const limiter = new PairingFailureLimiter({
      now: () => now,
      failureThreshold: 1,
      maxTrackedSources: 2,
      maxOverflowAttempts: 2,
      overflowWindowMs: 1_000,
    });
    limiter.recordFailure('pairing-request', 'locked-request');
    limiter.recordFailure('pairing-request', 'another-locked-request');

    // A distinct surface cannot evict a lock in the request partition.
    for (let index = 0; index < 2; index += 1) {
      const result = limiter.admit('credential-exchange', `exchange-${index}`);
      expect(result.kind).toBe('admitted');
      if (result.kind === 'admitted')
        limiter.finalize(result.admission, 'pending');
    }
    expect(limiter.admit('pairing-request', 'locked-request').kind).toBe(
      'rate-limited',
    );

    // With all request entries locked, a new source gets only the small,
    // shared overflow allowance; it never displaces either lock.
    const firstOverflow = limiter.admit('pairing-request', 'new-peer-one');
    const secondOverflow = limiter.admit('pairing-request', 'new-peer-two');
    const exhaustedOverflow = limiter.admit(
      'pairing-request',
      'new-peer-three',
    );
    expect(firstOverflow.kind).toBe('admitted');
    expect(secondOverflow.kind).toBe('admitted');
    expect(exhaustedOverflow.kind).toBe('rate-limited');
    if (firstOverflow.kind === 'admitted')
      limiter.finalize(firstOverflow.admission, 'failure');
    if (secondOverflow.kind === 'admitted')
      limiter.finalize(secondOverflow.admission, 'pending');
    expect(limiter.admit('pairing-request', 'locked-request').kind).toBe(
      'rate-limited',
    );

    // Overflow recovers on its finite window, so protected capacity does not
    // become a permanent outage for a newly seen legitimate peer.
    now += 1_000;
    expect(limiter.admit('pairing-request', 'new-peer-four').kind).toBe(
      'admitted',
    );
  });

  test('locks failed pairing codes per source with exponential backoff, clears on success, and audits no proof', async () => {
    let now = 1_000;
    const limiter = new PairingFailureLimiter({
      now: () => now,
      failureThreshold: 2,
      baseLockoutMs: 1_000,
      maxLockoutMs: 8_000,
    });
    const harness = createHarness({ now: () => now, failureLimiter: limiter });
    const source = '198.51.100.71';
    const otherSource = '198.51.100.72';
    const attemptedProof = 'attempted-pairing-proof-must-not-be-audited';
    const attempt = async (
      offer: DevicePairingOffer,
      peer = source,
      proof = attemptedProof,
    ) =>
      harness.request(
        '/.well-known/station/v1/pairing/request',
        harness.json({
          deviceName: 'Abuse test device',
          offerId: offer.offerId,
          proof,
        }),
        peer,
      );

    const offer = harness.pairing.createOffer({
      endpoint: 'https://station.example.test',
    });
    expect((await attempt(offer)).status).toBe(400);
    expect((await attempt(offer)).status).toBe(400);
    const locked = await attempt(offer);
    expect(locked.status).toBe(429);
    expect(locked.headers.get('Retry-After')).toBe('1');
    // A distinct source remains independent of the locked peer.
    expect((await attempt(offer, otherSource)).status).toBe(400);

    now += 1_000;
    expect((await attempt(offer)).status).toBe(400);
    const extendedLock = await attempt(offer);
    expect(extendedLock.status).toBe(429);
    expect(extendedLock.headers.get('Retry-After')).toBe('2');

    now += 2_000;
    expect((await attempt(offer, source, offer.challenge)).status).toBe(202);
    const afterSuccess = harness.pairing.createOffer({
      endpoint: 'https://station.example.test',
    });
    expect((await attempt(afterSuccess)).status).toBe(400);
    expect((await attempt(afterSuccess)).status).toBe(400);
    expect((await attempt(afterSuccess)).status).toBe(429);
    expect(
      harness.authFailureAuditRecords.map((record) => record.event),
    ).toContain('station.pairing.authentication_rate_limited');
    expect(JSON.stringify(harness.authFailureAuditRecords)).not.toContain(
      attemptedProof,
    );
    const failureAudit = harness.authFailureAuditRecords.find(
      (record) => record.event === 'station.pairing.authentication_failed',
    );
    expect(failureAudit).toMatchObject({
      sourceCorrelation: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      failureCount: 1,
      lockDurationMs: 0,
    });
    expect(JSON.stringify(harness.authFailureAuditRecords)).not.toContain(
      source,
    );
    expect(JSON.stringify(harness.authFailureAuditRecords)).not.toContain(
      offer.offerId,
    );
  });

  test('reserves one authentication attempt before concurrent body parsing reaches pairing', async () => {
    const limiter = new PairingFailureLimiter({
      failureThreshold: 10,
      maxInFlightPerSource: 1,
    });
    const harness = createHarness({ failureLimiter: limiter });
    const offer = harness.pairing.createOffer({
      endpoint: 'https://station.example.test',
    });
    const authenticate = vi.spyOn(harness.pairing, 'requestPairing');
    const attempt = () =>
      harness.request(
        '/.well-known/station/v1/pairing/request',
        harness.json({
          deviceName: 'Concurrent attempt',
          offerId: offer.offerId,
          proof: 'not-the-offer-proof',
        }),
        '198.51.100.201',
      );

    const responses = await Promise.all([attempt(), attempt()]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      400, 429,
    ]);
    expect(authenticate).toHaveBeenCalledTimes(1);
  });

  test('applies coarse request and exchange budgets before parsing or authentication', async () => {
    const now = 1_000;
    const limiter = new PairingFailureLimiter({
      now: () => now,
      failureThreshold: 100,
    });
    const harness = createHarness({ now: () => now, failureLimiter: limiter });
    const requestPeer = '198.51.100.202';
    const requestOffer = harness.pairing.createOffer({
      endpoint: 'https://station.example.test',
    });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(
        (
          await harness.request(
            '/.well-known/station/v1/pairing/request',
            harness.json({
              deviceName: 'Coarse request budget',
              offerId: requestOffer.offerId,
              proof: `bad-proof-${attempt}`,
            }),
            requestPeer,
          )
        ).status,
      ).toBe(400);
    }
    expect(
      (
        await harness.request(
          '/.well-known/station/v1/pairing/request',
          harness.json({
            deviceName: 'Coarse request budget',
            offerId: requestOffer.offerId,
            proof: 'never-parsed',
          }),
          requestPeer,
        )
      ).status,
    ).toBe(429);

    const exchangePeer = '198.51.100.203';
    const exchangeOffer = harness.pairing.createOffer({
      endpoint: 'https://station.example.test',
    });
    const pending = harness.pairing.requestPairing({
      offerId: exchangeOffer.offerId,
      proof: exchangeOffer.challenge,
      deviceName: 'Coarse exchange budget',
      requesterPosition: 'off-box',
      source: 'pairing-code',
    });
    for (let attempt = 0; attempt < 90; attempt += 1) {
      expect(
        (
          await harness.request(
            '/.well-known/station/v1/pairing/exchange',
            harness.json({
              offerId: exchangeOffer.offerId,
              proof: exchangeOffer.challenge,
              requestId: pending.requestId,
            }),
            exchangePeer,
          )
        ).status,
      ).toBe(409);
    }
    expect(
      (
        await harness.request(
          '/.well-known/station/v1/pairing/exchange',
          harness.json({
            offerId: exchangeOffer.offerId,
            proof: exchangeOffer.challenge,
            requestId: pending.requestId,
          }),
          exchangePeer,
        )
      ).status,
    ).toBe(429);
  });

  test('does not restore an exhausted request budget through cross-surface churn', async () => {
    const limiter = new PairingFailureLimiter({ failureThreshold: 100 });
    const harness = createHarness({ failureLimiter: limiter });
    const requestPeer = '198.51.100.242';
    const requestOffer = harness.pairing.createOffer({
      endpoint: 'https://station.example.test',
    });
    const request = () =>
      harness.request(
        '/.well-known/station/v1/pairing/request',
        harness.json({
          deviceName: 'Coarse budget retention',
          offerId: requestOffer.offerId,
          proof: 'invalid-proof',
        }),
        requestPeer,
      );

    for (let attempt = 0; attempt < 10; attempt += 1)
      expect((await request()).status).toBe(400);
    expect((await request()).status).toBe(429);

    for (let index = 0; index < 1_025; index += 1) {
      const response = await harness.request(
        PUBLIC_DEVICE_PAIRING_ACCESS_REQUEST_PATH,
        {
          ...harness.json({ invalid: 'unparseable pairing access request' }),
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://station.example.test',
          },
        },
        `198.51.${Math.floor(index / 255)}.${index % 255}`,
      );
      expect([400, 403, 429]).toContain(response.status);
    }
    expect((await request()).status).toBe(429);
  });

  test('locks failed credential exchanges without penalizing pending approval polls, then clears on a valid exchange', async () => {
    let now = 1_000;
    const limiter = new PairingFailureLimiter({
      now: () => now,
      failureThreshold: 2,
      baseLockoutMs: 1_000,
      maxLockoutMs: 8_000,
    });
    const harness = createHarness({ now: () => now, failureLimiter: limiter });
    const source = '198.51.100.73';
    const exchange = async (
      offer: DevicePairingOffer,
      requestId: string,
      proof: string,
    ) =>
      harness.request(
        '/.well-known/station/v1/pairing/exchange',
        harness.json({ offerId: offer.offerId, proof, requestId }),
        source,
      );
    const offer = harness.pairing.createOffer({
      endpoint: 'https://station.example.test',
    });
    const request = harness.pairing.requestPairing({
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: 'Exchange test device',
      requesterPosition: 'off-box',
      source: 'pairing-code',
    });
    // Waiting for approval is an expected poll, not a bad credential attempt.
    expect(
      (await exchange(offer, request.requestId, offer.challenge)).status,
    ).toBe(409);
    expect(harness.authFailureAuditRecords).toEqual([]);

    harness.pairing.confirmRequest(request.requestId, {
      kind: 'presented-credential',
    });
    const attemptedProof = 'attempted-exchange-proof-must-not-be-audited';
    expect(
      (await exchange(offer, request.requestId, attemptedProof)).status,
    ).toBe(400);
    expect(
      (await exchange(offer, request.requestId, attemptedProof)).status,
    ).toBe(400);
    expect(
      (await exchange(offer, request.requestId, attemptedProof)).status,
    ).toBe(429);

    now += 1_000;
    expect(
      (await exchange(offer, request.requestId, offer.challenge)).status,
    ).toBe(200);
    expect(JSON.stringify(harness.authFailureAuditRecords)).not.toContain(
      attemptedProof,
    );
  });

  test('keeps the pairing challenge and manual-code entropy floor explicit and rejects expiry', async () => {
    let now = 1_000;
    const harness = createHarness({ now: () => now });
    const offer = harness.pairing.createOffer({
      endpoint: 'https://station.example.test',
    });
    // 32 random bytes encoded as base64url is 256 bits. The exact 31-symbol,
    // 10-character manual-code floor is 10 * log2(31) = 49.54 bits.
    expect(offer.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(offer.manualCode).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{10}$/);
    expect(offer.expiresAt).toBe(now + 5 * 60_000);

    now += 5 * 60_000;
    const expired = await harness.request(
      '/.well-known/station/v1/pairing/request',
      harness.json({
        deviceName: 'Expired device',
        offerId: offer.offerId,
        proof: offer.challenge,
      }),
    );
    expect(expired.status).toBe(410);
  });
});

describe('device pairing routes', () => {
  test('station#1123 slice 1: POST /api/pairing/offers accepts kind and rejects an unknown one', async () => {
    const harness = createHarness();

    const delegationOffer = await harness.request(
      '/api/pairing/offers',
      harness.json(
        {
          endpoint: 'https://station.example.test',
          scope: 'orchestration:read orchestration:operate',
          kind: 'delegation',
        },
        MASTER_CREDENTIAL,
      ),
    );
    expect(delegationOffer.status).toBe(201);
    // kind is a host-side label, never part of the wire DevicePairingOffer.
    expect(await delegationOffer.json()).not.toHaveProperty('kind');

    const invalidKind = await harness.request(
      '/api/pairing/offers',
      harness.json(
        { endpoint: 'https://station.example.test', kind: 'operator' },
        MASTER_CREDENTIAL,
      ),
    );
    expect(invalidKind.status).toBe(400);
  });

  test('station#1123 slice 1: a delegation-kind grant exchanges, lists, and revokes through the same device routes', async () => {
    const harness = createHarness();
    const delegationScope = 'orchestration:read orchestration:operate';

    const offerResponse = await harness.request(
      '/api/pairing/offers',
      harness.json(
        {
          endpoint: 'https://station.example.test',
          scope: delegationScope,
          kind: 'delegation',
        },
        MASTER_CREDENTIAL,
      ),
    );
    const offer = (await offerResponse.json()) as DevicePairingOffer;
    const requestResponse = await harness.request(
      '/.well-known/station/v1/pairing/request',
      harness.json({
        deviceName: 'Peer: box-b',
        offerId: offer.offerId,
        proof: offer.challenge,
      }),
    );
    const pending = (await requestResponse.json()) as DevicePairingRequest;
    await harness.request(
      `/api/pairing/requests/${pending.requestId}/confirm`,
      harness.json({}, MASTER_CREDENTIAL),
    );
    const exchangeResponse = await harness.request(
      '/.well-known/station/v1/pairing/exchange',
      harness.json({
        offerId: offer.offerId,
        proof: offer.challenge,
        requestId: pending.requestId,
      }),
    );
    const exchanged = (await exchangeResponse.json()) as {
      device: PairedDevice;
      credential: string;
    };
    expect(exchanged.device.kind).toBe('delegation');
    expect(exchanged.device.scope).toBe(delegationScope);

    const listResponse = await harness.request('/api/pairing/devices', {
      headers: { Authorization: `Bearer ${MASTER_CREDENTIAL}` },
    });
    const listed = (await listResponse.json()) as { devices: PairedDevice[] };
    expect(listed.devices).toEqual([
      expect.objectContaining({
        id: exchanged.device.id,
        kind: 'delegation',
        issuedAt: expect.any(Number),
      }),
    ]);
    expect(listed.devices[0]).not.toHaveProperty('lastUsedAt');

    const liveRemoval = await harness.request(
      `/api/pairing/devices/${exchanged.device.id}/record`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${MASTER_CREDENTIAL}` },
      },
    );
    expect(liveRemoval.status).toBe(409);
    expect(harness.pairing.verifyCredential(exchanged.credential)).toBe(true);

    const revokeResponse = await harness.request(
      `/api/pairing/devices/${exchanged.device.id}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${MASTER_CREDENTIAL}` },
      },
    );
    expect(revokeResponse.status).toBe(200);
    const revoked = (await revokeResponse.json()) as PairedDevice;
    expect(revoked.kind).toBe('delegation');
    expect(revoked.revokedAt).not.toBeNull();
    expect(harness.pairing.verifyCredential(exchanged.credential)).toBe(false);

    // The internal token is valid only as Station's process credential for
    // runtime dispatch. It never gains the explicit operator authority that
    // permanently deletes a revoked-device record.
    const internalOnlyRemoval = await harness.request(
      `/api/pairing/devices/${exchanged.device.id}/record`,
      {
        method: 'DELETE',
        headers: {
          [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
          [INTERNAL_PROXY_CALLER_HEADER]: 'local',
        },
      },
      '127.0.0.1',
    );
    expect(internalOnlyRemoval.status).toBe(401);
    expect(harness.pairing.listDevices()).toEqual([
      expect.objectContaining({
        id: exchanged.device.id,
        revokedAt: expect.any(Number),
      }),
    ]);

    const tombstoneRemoval = await harness.request(
      `/api/pairing/devices/${exchanged.device.id}/record`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${MASTER_CREDENTIAL}` },
      },
    );
    expect(tombstoneRemoval.status).toBe(200);
    expect(harness.pairing.listDevices()).toEqual([]);
  });

  test('labels only internally attested Tailscale Serve access requests as tailnet', async () => {
    const harness = createHarness();
    const endpoint =
      'https://station.example.test/.well-known/station/v1/pairing/access-request';
    const baseHeaders = {
      'Content-Type': 'application/json',
      Origin: 'https://station.example.test',
      'Sec-Fetch-Site': 'same-origin',
    };
    const spoofed = await harness.request(
      endpoint,
      {
        ...harness.json({ deviceName: 'Spoofed browser' }),
        headers: {
          ...baseHeaders,
          'Tailscale-Headers-Info': 'https://tailscale.com/s/serve-headers',
          'Tailscale-User-Login': 'attacker@example.test',
          [INTERNAL_INGRESS_IDENTITY_HEADER]: Buffer.from(
            JSON.stringify({
              provider: 'tailscale-serve',
              login: 'attacker@example.test',
            }),
          ).toString('base64url'),
        },
      },
      '100.96.12.21',
    );
    expect(spoofed.status).toBe(202);

    const identity = Buffer.from(
      JSON.stringify({
        provider: 'tailscale-serve',
        login: 'brian@example.test',
        displayName: 'Brian',
      }),
    ).toString('base64url');
    const verified = await harness.request(
      endpoint,
      {
        ...harness.json({ deviceName: 'Verified browser' }),
        headers: {
          ...baseHeaders,
          [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
          [INTERNAL_INGRESS_IDENTITY_HEADER]: identity,
        },
      },
      '127.0.0.1',
    );
    expect(verified.status).toBe(202);

    const hostRequests = await harness.request('/api/pairing/requests', {
      headers: { Authorization: `Bearer ${MASTER_CREDENTIAL}` },
    });
    expect(hostRequests.status).toBe(200);
    expect(await hostRequests.json()).toMatchObject({
      requests: [
        { deviceName: 'Spoofed browser', source: 'same-origin' },
        {
          deviceName: 'Verified browser',
          source: 'tailnet',
          requester: {
            provider: 'tailscale-serve',
            login: 'brian@example.test',
            displayName: 'Brian',
          },
        },
      ],
    });
  });

  test('creates a same-origin access request without a code and cannot approve itself', async () => {
    const harness = createHarness();
    const endpoint =
      'https://station.example.test/.well-known/station/v1/pairing/access-request';
    const denied = await harness.request(
      endpoint,
      harness.json({ deviceName: 'Browser without origin' }),
      '100.96.12.20',
    );
    expect(denied.status).toBe(403);
    const hostileOrigin = await harness.request(
      endpoint,
      {
        ...harness.json({ deviceName: 'Hostile browser' }),
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://hostile.example.test',
          'Sec-Fetch-Site': 'cross-site',
        },
      },
      '100.96.12.20',
    );
    expect(hostileOrigin.status).toBe(403);

    const accessResponse = await harness.request(
      endpoint,
      {
        ...harness.json({ deviceName: 'Laptop browser' }),
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://station.example.test',
          'Sec-Fetch-Site': 'same-origin',
        },
      },
      '100.96.12.21',
    );
    expect(accessResponse.status).toBe(202);
    const access = (await accessResponse.json()) as {
      environmentId: string;
      offerId: string;
      proof: string;
      requestId: string;
      expiresAt: number;
    };
    expect(access).toMatchObject({ environmentId: ENVIRONMENT_ID });
    expect(access.offerId).not.toBe('');
    expect(access.proof).not.toBe('');
    expect(access.requestId).not.toBe('');
    expect(access.expiresAt).toBeGreaterThan(Date.now());

    const selfApproval = await harness.request(
      `/api/pairing/requests/${access.requestId}/confirm`,
      harness.json({}),
    );
    expect(selfApproval.status).toBe(401);

    const hostRequests = await harness.request('/api/pairing/requests', {
      headers: { Authorization: `Bearer ${MASTER_CREDENTIAL}` },
    });
    expect(hostRequests.status).toBe(200);
    expect(await hostRequests.json()).toMatchObject({
      requests: [
        {
          requestId: access.requestId,
          deviceName: 'Laptop browser',
          status: 'pending',
        },
      ],
    });

    expect(
      (
        await harness.request(
          `/api/pairing/requests/${access.requestId}/confirm`,
          harness.json({}, MASTER_CREDENTIAL),
        )
      ).status,
    ).toBe(200);
    const exchange = await harness.request(
      'https://station.example.test/.well-known/station/v1/pairing/exchange',
      {
        ...harness.json({
          delivery: 'browser-cookie',
          offerId: access.offerId,
          proof: access.proof,
          requestId: access.requestId,
        }),
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://station.example.test',
          'Sec-Fetch-Site': 'same-origin',
        },
      },
    );
    expect(exchange.status).toBe(200);
    expect(await exchange.json()).not.toHaveProperty('credential');
    expect(exchange.headers.get('set-cookie')).toContain('HttpOnly');

    const rateLimitedStatuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      rateLimitedStatuses.push(
        (
          await harness.request(
            endpoint,
            {
              ...harness.json({ deviceName: `Rate limited ${attempt}` }),
              headers: {
                'Content-Type': 'application/json',
                Origin: 'https://station.example.test',
                'Sec-Fetch-Site': 'same-origin',
              },
            },
            '100.96.12.22',
          )
        ).status,
      );
    }
    expect(rateLimitedStatuses).toEqual([202, 202, 202, 202, 202, 429]);
  });

  test('returns 429 when the global active-offer queue is full', async () => {
    const harness = createHarness({ maxActiveOffers: 1 });
    const endpoint =
      'https://station.example.test/.well-known/station/v1/pairing/access-request';
    const requestAccess = (peer: string, deviceName: string) =>
      harness.request(
        endpoint,
        {
          ...harness.json({ deviceName }),
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://station.example.test',
            'Sec-Fetch-Site': 'same-origin',
          },
        },
        peer,
      );

    expect((await requestAccess('100.96.12.30', 'First browser')).status).toBe(
      202,
    );
    const full = await requestAccess('100.96.12.31', 'Second browser');
    expect(full.status).toBe(429);
    expect(await full.json()).toEqual({ error: 'offer_capacity_reached' });
  });

  test('requires owner authority to deny and tells the requester to stop polling', async () => {
    const harness = createHarness();
    const endpoint =
      'https://station.example.test/.well-known/station/v1/pairing/access-request';
    const accessResponse = await harness.request(
      endpoint,
      {
        ...harness.json({ deviceName: 'Unrecognized browser' }),
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://station.example.test',
          'Sec-Fetch-Site': 'same-origin',
        },
      },
      '100.96.12.32',
    );
    const access = (await accessResponse.json()) as {
      offerId: string;
      proof: string;
      requestId: string;
    };

    expect(
      (
        await harness.request(`/api/pairing/requests/${access.requestId}`, {
          method: 'DELETE',
        })
      ).status,
    ).toBe(401);
    const denied = await harness.request(
      `/api/pairing/requests/${access.requestId}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${MASTER_CREDENTIAL}` },
      },
    );
    expect(denied.status).toBe(200);
    expect(await denied.json()).toMatchObject({ status: 'denied' });

    const exchange = await harness.request(
      'https://station.example.test/.well-known/station/v1/pairing/exchange',
      {
        ...harness.json({
          delivery: 'browser-cookie',
          offerId: access.offerId,
          proof: access.proof,
          requestId: access.requestId,
        }),
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://station.example.test',
          'Sec-Fetch-Site': 'same-origin',
        },
      },
    );
    expect(exchange.status).toBe(403);
    expect(await exchange.json()).toEqual({ error: 'request_denied' });
  });

  test('requires host authentication, exchanges publicly, and revokes immediately', async () => {
    const harness = createHarness();
    expect(
      (
        await harness.request(
          '/api/pairing/offers',
          harness.json({ endpoint: 'https://station.example.test' }),
        )
      ).status,
    ).toBe(401);

    const first = await pairDevice(harness, 'First phone');
    const second = await pairDevice(harness, 'Second phone');
    expect(first.environmentId).toBe(ENVIRONMENT_ID);
    expect(
      (
        await harness.request('/api/projects', {
          headers: { Authorization: `Bearer ${first.credential}` },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await harness.request('/events', {
          headers: { Authorization: `Bearer ${first.credential}` },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await harness.request(
          '/api/pairing/offers',
          harness.json(
            { endpoint: 'https://station.example.test' },
            first.credential,
          ),
        )
      ).status,
    ).toBe(401);

    const revoked = await harness.request(
      `/api/pairing/devices/${first.device.id}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${MASTER_CREDENTIAL}` },
      },
    );
    expect(revoked.status).toBe(200);
    expect(
      (
        await harness.request('/api/projects', {
          headers: { Authorization: `Bearer ${first.credential}` },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await harness.request('/events', {
          headers: { Authorization: `Bearer ${first.credential}` },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await harness.request('/api/projects', {
          headers: { Authorization: `Bearer ${second.credential}` },
        })
      ).status,
    ).toBe(200);
  });

  test('projects only bounded live-session aggregates and clears them on revocation', async () => {
    const presence = new ClientConnectionPresence();
    const harness = createHarness({ connectedClientPresence: presence });
    const paired = await pairDevice(harness, 'Live phone');
    presence.connect(paired.device.id, '11111111-1111-4111-8111-111111111111');
    const listed = await harness.request('/api/pairing/devices', {
      headers: { Authorization: `Bearer ${MASTER_CREDENTIAL}` },
    });
    const body = (await listed.json()) as {
      devices: Array<PairedDevice & { connectedClients?: unknown }>;
    };
    expect(body.devices[0]?.connectedClients).toEqual({
      deviceId: paired.device.id,
      sessionCount: 1,
      connectedAt: expect.any(Number),
      lastSeenAt: expect.any(Number),
      transports: ['events-sse'],
    });
    expect(JSON.stringify(body)).not.toContain(
      '11111111-1111-4111-8111-111111111111',
    );

    await harness.request(`/api/pairing/devices/${paired.device.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${MASTER_CREDENTIAL}` },
    });
    expect(presence.snapshot([paired.device.id]).has(paired.device.id)).toBe(
      false,
    );
  });

  test('serves protected aggregate-only presence and suppresses it outside personal mode', async () => {
    const presence = new ClientConnectionPresence();
    const harness = createHarness({ connectedClientPresence: presence });
    const paired = await pairDevice(harness, 'Summary phone');
    presence.connect(paired.device.id, '11111111-1111-4111-8111-111111111111');
    const response = await harness.request('/api/client-presence/summary', {
      headers: { Authorization: `Bearer ${paired.credential}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      connectedClients: 1,
      connectedDevices: 1,
      observedAt: expect.any(Number),
    });
    expect((await harness.request('/api/client-presence/summary')).status).toBe(
      401,
    );
    const insufficient = await pairDevice(
      harness,
      'No read scope',
      undefined,
      'terminal:operate',
    );
    expect(
      (
        await harness.request('/api/client-presence/summary', {
          headers: { Authorization: `Bearer ${insufficient.credential}` },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await harness.request('/api/client-presence/summary', {
          headers: { Authorization: `Bearer ${MASTER_CREDENTIAL}` },
        })
      ).status,
    ).toBe(200);

    const unavailable = createHarness({ clientPresenceAvailable: false });
    const hidden = await unavailable.request('/api/client-presence/summary', {
      headers: { Authorization: `Bearer ${MASTER_CREDENTIAL}` },
    });
    expect(hidden.status).toBe(404);
    expect(await hidden.json()).toEqual({ error: 'unavailable' });
  });

  test('never records a credentialless loopback caller as an operator revocation', async () => {
    const harness = createHarness();
    const paired = await pairDevice(harness, 'Protected phone');
    const response = await harness.request(
      `/api/pairing/devices/${paired.device.id}`,
      { method: 'DELETE' },
      '127.0.0.1',
    );
    expect(response.status).toBe(401);
    expect(harness.pairing.verifyCredential(paired.credential)).toBe(true);
  });

  test('supersedes only the same opaque client instance and never returns it', async () => {
    const harness = createHarness();
    const exchanges = vi.spyOn(deviceSessionExchanges, 'add');
    const first = await pairDevice(
      harness,
      'First display name',
      '11111111-1111-4111-8111-111111111111',
    );
    const replacement = await pairDevice(
      harness,
      'First display name',
      '11111111-1111-4111-8111-111111111111',
    );
    const independent = await pairDevice(
      harness,
      'First display name',
      '22222222-2222-4222-8222-222222222222',
    );

    expect(replacement.device.name).toBe('First display name');
    expect(independent.device.name).toBe('First display name (2)');

    expect(harness.pairing.verifyCredential(first.credential)).toBe(false);
    expect(harness.pairing.verifyCredential(replacement.credential)).toBe(true);
    expect(harness.pairing.verifyCredential(independent.credential)).toBe(true);

    const listed = await harness.request('/api/pairing/devices', {
      headers: { Authorization: `Bearer ${MASTER_CREDENTIAL}` },
    });
    const listedBody = await listed.json();
    expect(JSON.stringify(listedBody)).not.toContain('clientInstanceId');
    expect(listedBody).toMatchObject({
      devices: [
        { id: first.device.id, revokedAt: expect.any(Number) },
        { id: replacement.device.id, revokedAt: null },
        { id: independent.device.id, revokedAt: null },
      ],
    });
    expect(exchanges).toHaveBeenCalledWith(1, {
      outcome: 'issued',
      replacement: 'superseded',
    });
    for (const [, attributes] of exchanges.mock.calls) {
      expect(Object.keys(attributes ?? {})).not.toContain('clientInstanceId');
    }
    exchanges.mockRestore();
  });

  test('rejects secrets in query strings and throttles hostile attempts', async () => {
    const harness = createHarness();
    const query = await harness.request(
      '/.well-known/station/v1/pairing/request?offerId=secret',
      harness.json({ deviceName: 'Phone', offerId: 'x', proof: 'y' }),
      '100.96.12.8',
    );
    expect(query.status).toBe(400);

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 11; attempt += 1) {
      statuses.push(
        (
          await harness.request(
            '/.well-known/station/v1/pairing/request',
            harness.json({ deviceName: 'Phone', offerId: 'x', proof: 'y' }),
            '100.96.12.9',
          )
        ).status,
      );
    }
    expect(statuses.slice(0, 3).every((status) => status === 400)).toBe(true);
    expect(statuses.slice(3).every((status) => status === 429)).toBe(true);
  });

  test('never records challenge or issued credential in request logs', async () => {
    const harness = createHarness();
    const paired = await pairDevice(harness, 'Private phone');
    const logs = JSON.stringify(
      (harness.logger.info as ReturnType<typeof vi.fn>).mock.calls,
    );
    expect(logs).not.toContain(paired.credential);
    expect(logs).not.toContain('Private phone');
  });

  test('delivers a persistent HttpOnly session to a same-origin paired browser', async () => {
    const harness = createHarness();
    const offerResponse = await harness.request(
      '/api/pairing/offers',
      harness.json(
        { endpoint: 'https://station.example.test' },
        MASTER_CREDENTIAL,
      ),
    );
    const offer = (await offerResponse.json()) as DevicePairingOffer;
    const pairingRequestResponse = await harness.request(
      '/.well-known/station/v1/pairing/request',
      harness.json({
        deviceName: 'Persistent phone',
        offerId: offer.offerId,
        proof: offer.challenge,
      }),
    );
    const pairingRequest =
      (await pairingRequestResponse.json()) as DevicePairingRequest;
    expect(
      (
        await harness.request(
          `/api/pairing/requests/${pairingRequest.requestId}/confirm`,
          harness.json({}, MASTER_CREDENTIAL),
        )
      ).status,
    ).toBe(200);

    const exchange = await harness.request(
      'https://station.example.test/.well-known/station/v1/pairing/exchange',
      {
        ...harness.json({
          delivery: 'browser-cookie',
          offerId: offer.offerId,
          proof: offer.challenge,
          requestId: pairingRequest.requestId,
        }),
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://station.example.test',
        },
      },
    );
    expect(exchange.status).toBe(200);
    const result = (await exchange.json()) as Record<string, unknown>;
    expect(result).toMatchObject({
      environmentId: ENVIRONMENT_ID,
      delivery: 'browser-cookie',
    });
    expect(result).not.toHaveProperty('credential');

    const setCookie = exchange.headers.get('set-cookie');
    expect(setCookie).toContain('__Host-station-device=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toMatch(/Max-Age=\d+/);
    const cookie = setCookie!.split(';', 1)[0];

    expect(
      (
        await harness.request('/api/projects', {
          headers: { Cookie: cookie },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await harness.request('/api/projects', {
          method: 'POST',
          headers: {
            Cookie: cookie,
            Origin: 'https://station.example.test',
          },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await harness.request('/api/projects', {
          method: 'POST',
          headers: { Cookie: cookie },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await harness.request('/api/pairing/devices', {
          headers: { Cookie: cookie },
        })
      ).status,
    ).toBe(401);

    const device = result.device as PairedDevice;
    expect(
      (
        await harness.request(`/api/pairing/devices/${device.id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${MASTER_CREDENTIAL}` },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await harness.request('/api/projects', {
          headers: { Cookie: cookie },
        })
      ).status,
    ).toBe(401);
  });

  test('refuses browser-cookie delivery without a same-origin browser request', async () => {
    const harness = createHarness();
    const offerResponse = await harness.request(
      '/api/pairing/offers',
      harness.json(
        { endpoint: 'https://station.example.test' },
        MASTER_CREDENTIAL,
      ),
    );
    const offer = (await offerResponse.json()) as DevicePairingOffer;
    const pairingRequestResponse = await harness.request(
      '/.well-known/station/v1/pairing/request',
      harness.json({
        deviceName: 'Hostile phone',
        offerId: offer.offerId,
        proof: offer.challenge,
      }),
    );
    const pairingRequest =
      (await pairingRequestResponse.json()) as DevicePairingRequest;
    await harness.request(
      `/api/pairing/requests/${pairingRequest.requestId}/confirm`,
      harness.json({}, MASTER_CREDENTIAL),
    );

    for (const origin of [undefined, 'https://hostile.example.test']) {
      const response = await harness.request(
        'https://station.example.test/.well-known/station/v1/pairing/exchange',
        {
          ...harness.json({
            delivery: 'browser-cookie',
            offerId: offer.offerId,
            proof: offer.challenge,
            requestId: pairingRequest.requestId,
          }),
          headers: {
            'Content-Type': 'application/json',
            ...(origin ? { Origin: origin } : {}),
          },
        },
      );
      expect(response.status).toBe(403);
      expect(response.headers.get('set-cookie')).toBeNull();
    }
  });

  it('accepts an access request from a native shell, which is always cross-site', async () => {
    // The desktop and mobile apps reach a REMOTE Station from their own packaged
    // origin, so they can never be same-origin with it. Refusing cross-site made
    // "Request access" impossible from exactly the surfaces it exists for. No web
    // page can present a tauri origin, so this does not admit a hostile site, and
    // the operator still approves every request out of band.
    const harness = createHarness();
    const endpoint =
      'https://station.example.test/.well-known/station/v1/pairing/access-request';

    for (const nativeOrigin of [
      'tauri://localhost',
      'https://tauri.localhost',
      'http://tauri.localhost',
    ]) {
      const nativeShell = await harness.request(
        endpoint,
        {
          ...harness.json({ deviceName: 'Pixel 10 Pro XL \u00b7 Station' }),
          headers: {
            'Content-Type': 'application/json',
            Origin: nativeOrigin,
            'Sec-Fetch-Site': 'cross-site',
          },
        },
        '100.96.12.20',
      );
      expect(nativeShell.status).toBe(202);
    }

    // A hostile site is still refused, cross-site or not.
    for (const site of ['cross-site', 'same-origin']) {
      const hostile = await harness.request(
        endpoint,
        {
          ...harness.json({ deviceName: 'Hostile' }),
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://hostile.example.test',
            'Sec-Fetch-Site': site,
          },
        },
        '100.96.12.21',
      );
      expect(hostile.status).toBe(403);
    }
  });
});

/**
 * archive#1673 — additive tolerance on the public pairing endpoints.
 * `readPairingJson`/`readPairingExchangeJson` used to require the request
 * body's key set to match an allow-listed set exactly, so a body carrying
 * any key the server didn't expect — including a genuinely optional one
 * from a differently-versioned client — 400'd. Required keys must still be
 * present and correctly typed; anything else is ignored.
 */
describe('device scope change (station#3816)', () => {
  test('the operator narrows a device through the route, and the narrowed scope is what enforcement then sees', async () => {
    const harness = createHarness();
    const paired = await pairDevice(harness, 'Phone');

    const response = await harness.request(
      `/api/pairing/devices/${paired.device.id}/scope`,
      harness.json({ scope: ['orchestration:read'] }, MASTER_CREDENTIAL),
    );
    expect(response.status).toBe(200);
    const device = (await response.json()) as PairedDevice;
    expect(device.scope).toBe('orchestration:read');
    // The credential itself resolves to the new scope — this is what the
    // route-authorization layer reads, so the narrowing is real, not label.
    expect(harness.pairing.identifyDevice(paired.credential)?.scope).toBe(
      'orchestration:read',
    );
  });

  test('a narrowing is enforced on the NEXT request, not merely recorded', async () => {
    const harness = createHarness();
    const paired = await pairDevice(harness, 'Phone');

    // Standard access can mutate. This is the capability the narrowing must
    // actually remove — asserting the stored string changed would pass even
    // if enforcement kept honouring the old scope until restart, which is
    // the failure that matters.
    const before = await harness.request('/api/projects', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${paired.credential}`,
      },
      body: '{}',
    });
    expect(before.status).toBe(200);

    const narrowed = await harness.request(
      `/api/pairing/devices/${paired.device.id}/scope`,
      harness.json({ scope: ['orchestration:read'] }, MASTER_CREDENTIAL),
    );
    expect(narrowed.status).toBe(200);

    // Same credential, same route, immediately after: now refused.
    const after = await harness.request('/api/projects', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${paired.credential}`,
      },
      body: '{}',
    });
    expect(after.status).not.toBe(200);
    // Reading still works: the device was narrowed, not revoked.
    const read = await harness.request('/api/projects', {
      headers: { Authorization: `Bearer ${paired.credential}` },
    });
    expect(read.status).toBe(200);
  });

  test('a paired device cannot change its own (or any) scope', async () => {
    const harness = createHarness();
    const paired = await pairDevice(harness, 'Phone');

    const response = await harness.request(
      `/api/pairing/devices/${paired.device.id}/scope`,
      harness.json({ scope: ['orchestration:read'] }, paired.credential),
    );
    expect(response.status).toBe(401);
    expect(harness.pairing.identifyDevice(paired.credential)?.scope).toBe(
      paired.device.scope,
    );
  });

  test('promotion to consent:decide works; a default-grant-only token is refused with its own code', async () => {
    const harness = createHarness();
    const paired = await pairDevice(harness, 'Phone');

    const promoted = await harness.request(
      `/api/pairing/devices/${paired.device.id}/scope`,
      harness.json(
        { scope: ['orchestration:read', 'consent:decide'] },
        MASTER_CREDENTIAL,
      ),
    );
    expect(promoted.status).toBe(200);
    expect(((await promoted.json()) as PairedDevice).scope).toBe(
      'orchestration:read consent:decide',
    );

    // access:manage has no legitimate promotion path: its holder population
    // is inherited and permanently ambiguous, and the contracts say it must
    // not grow. The refusal names the reason, not a generic 400.
    const refused = await harness.request(
      `/api/pairing/devices/${paired.device.id}/scope`,
      harness.json(
        { scope: ['orchestration:read', 'access:manage'] },
        MASTER_CREDENTIAL,
      ),
    );
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: 'scope_not_grantable' });
  });

  test('a stale editor cannot silently re-grant what another operator removed', async () => {
    const harness = createHarness();
    const paired = await pairDevice(harness, 'Phone');
    const original = paired.device.scope;

    // Operator A removes a capability.
    const removed = await harness.request(
      `/api/pairing/devices/${paired.device.id}/scope`,
      harness.json({ scope: ['orchestration:read'] }, MASTER_CREDENTIAL),
    );
    expect(removed.status).toBe(200);

    // Operator B applies from an editor opened BEFORE that change. Its
    // request is a whole-scope replacement, so without a conditional write
    // it would silently restore what A just took away.
    const stale = await harness.request(
      `/api/pairing/devices/${paired.device.id}/scope`,
      harness.json(
        {
          scope: ['orchestration:read', 'orchestration:operate'],
          expectedScope: original,
        },
        MASTER_CREDENTIAL,
      ),
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: 'scope_changed' });
    // A's decision stands.
    expect(harness.pairing.identifyDevice(paired.credential)?.scope).toBe(
      'orchestration:read',
    );

    // Re-reading and redoing the edit succeeds.
    const redone = await harness.request(
      `/api/pairing/devices/${paired.device.id}/scope`,
      harness.json(
        {
          scope: ['orchestration:read', 'orchestration:operate'],
          expectedScope: 'orchestration:read',
        },
        MASTER_CREDENTIAL,
      ),
    );
    expect(redone.status).toBe(200);
  });

  test('a scope change drops the device’s live connections so they re-authenticate (review HIGH)', async () => {
    const disconnected: string[] = [];
    const harness = createHarness({
      connectedClientPresence: {
        disconnectDevice: (deviceId: string) => disconnected.push(deviceId),
      } as never,
    });
    const paired = await pairDevice(harness, 'Phone');

    // Terminal and voice authenticate ONCE at the handshake, so a demoted
    // device kept writing on a socket it had already opened. Dropping its
    // leases is what makes a narrowing bite on connections that already
    // exist, not only on new requests.
    const response = await harness.request(
      `/api/pairing/devices/${paired.device.id}/scope`,
      harness.json({ scope: ['orchestration:read'] }, MASTER_CREDENTIAL),
    );
    expect(response.status).toBe(200);
    expect(disconnected).toEqual([paired.device.id]);
  });

  test('a malformed body is a 400, not a scope change', async () => {
    const harness = createHarness();
    const paired = await pairDevice(harness, 'Phone');

    for (const body of [{}, { scope: 'orchestration:read' }, { scope: [42] }]) {
      const response = await harness.request(
        `/api/pairing/devices/${paired.device.id}/scope`,
        harness.json(body, MASTER_CREDENTIAL),
      );
      expect(response.status).toBe(400);
    }
    expect(harness.pairing.identifyDevice(paired.credential)?.scope).toBe(
      paired.device.scope,
    );
  });
});

describe('additive tolerance on the public pairing endpoints (station#1673)', () => {
  // Every route here shares its rate-limit bucket by peer address across the
  // whole test file (the limiter is a module-level map, not reset between
  // tests), so each test dials its own unused address rather than the
  // harness default — the same isolation pattern the local-grant and
  // loopback-compatibility describes below use.
  test('an unknown key on the access-request body does not break the request', async () => {
    const harness = createHarness();
    const response = await harness.request(
      '/.well-known/station/v1/pairing/access-request',
      {
        ...harness.json({
          deviceName: 'Phone',
          somethingNewerClientsSend: 'value',
        }),
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://station.example.test',
        },
      },
      '100.96.12.50',
    );
    expect(response.status).toBe(202);
  });

  test('a body predating clientInstanceId still succeeds against a server that added it', async () => {
    const harness = createHarness();
    const offerResponse = await harness.request(
      '/api/pairing/offers',
      harness.json(
        { endpoint: 'https://station.example.test' },
        MASTER_CREDENTIAL,
      ),
    );
    const offer = (await offerResponse.json()) as DevicePairingOffer;

    // Live-verified shape (archive#1673): { deviceName, offerId, proof } with
    // no `clientInstanceId` — a pairing-code request from a client that
    // predates the field must still succeed against a server that added it
    // as optional.
    const requestResponse = await harness.request(
      '/.well-known/station/v1/pairing/request',
      harness.json({
        deviceName: 'Older client',
        offerId: offer.offerId,
        proof: offer.challenge,
      }),
      '100.96.12.51',
    );
    expect(requestResponse.status).toBe(202);
  });

  test('a missing required key still 400s on the pairing-code request route', async () => {
    const harness = createHarness();
    const missingProof = await harness.request(
      '/.well-known/station/v1/pairing/request',
      harness.json({ deviceName: 'Phone', offerId: 'x' }),
      '100.96.12.52',
    );
    expect(missingProof.status).toBe(400);
  });

  test('a wrong-typed required key still 400s on the pairing-code request route', async () => {
    const harness = createHarness();
    const wrongType = await harness.request(
      '/.well-known/station/v1/pairing/request',
      harness.json({ deviceName: 'Phone', offerId: 'x', proof: 42 }),
      '100.96.12.53',
    );
    expect(wrongType.status).toBe(400);
  });

  test('an unknown key on the exchange body does not break the exchange', async () => {
    const harness = createHarness();
    const offerResponse = await harness.request(
      '/api/pairing/offers',
      harness.json(
        { endpoint: 'https://station.example.test' },
        MASTER_CREDENTIAL,
      ),
    );
    const offer = (await offerResponse.json()) as DevicePairingOffer;
    const requestResponse = await harness.request(
      '/.well-known/station/v1/pairing/request',
      harness.json({
        deviceName: 'Phone',
        offerId: offer.offerId,
        proof: offer.challenge,
      }),
      '100.96.12.54',
    );
    expect(requestResponse.status).toBe(202);
    const pending = (await requestResponse.json()) as DevicePairingRequest;
    await harness.request(
      `/api/pairing/requests/${pending.requestId}/confirm`,
      harness.json({}, MASTER_CREDENTIAL),
    );

    const exchangeResponse = await harness.request(
      '/.well-known/station/v1/pairing/exchange',
      harness.json({
        offerId: offer.offerId,
        proof: offer.challenge,
        requestId: pending.requestId,
        somethingNewerClientsSend: 'value',
      }),
      '100.96.12.54',
    );
    expect(exchangeResponse.status).toBe(200);
  });

  test('a missing required key still 400s on the exchange route', async () => {
    const harness = createHarness();
    const missingRequestId = await harness.request(
      '/.well-known/station/v1/pairing/exchange',
      harness.json({ offerId: 'x', proof: 'y' }),
      '100.96.12.55',
    );
    expect(missingRequestId.status).toBe(400);
  });

  test('an unknown key on the local-grant body does not break local self-authorization', async () => {
    const harness = createHarness({ localGrant: true });
    const secret = harness.readLocalGrantSecret();
    const response = await harness.request(
      PUBLIC_DEVICE_PAIRING_LOCAL_GRANT_PATH,
      harness.json({
        secret,
        deviceName: 'Local device',
        somethingNewerClientsSend: 'value',
      }),
      '127.0.0.99',
    );
    expect(response.status).toBe(200);
  });
});

/**
 * archive#1715 — same-user local self-authorization. A direct loopback
 * caller that presents the per-boot local-grant secret runs the full
 * offer/request/confirm/exchange ceremony server-side in one request and
 * gets back a normal paired-device credential, with no operator approval
 * step in between.
 */
describe('local self-authorization grant exchange (station#1715)', () => {
  // The route rate-limits per peer address through a module-level map that
  // outlives each test (see the pairing-approval describe below for the same
  // pattern) — every test here dials loopback, so each gets its
  // own last octet rather than sharing one bucket across unrelated tests.
  let localGrantDialCount = 0;
  const nextLocalGrantPeer = () =>
    `127.0.0.${(localGrantDialCount++ % 250) + 2}`;
  const LOOPBACK_PEER = '127.0.0.1';

  test('is unconditionally refused when the route is configured with no localGrant option', async () => {
    const harness = createHarness();
    const response = await harness.request(
      PUBLIC_DEVICE_PAIRING_LOCAL_GRANT_PATH,
      harness.json({ secret: 'anything', deviceName: 'This Mac' }),
      LOOPBACK_PEER,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'local_grant_forbidden' });
  });

  test('exchanges the secret for a working paired-device credential and audits the approver', async () => {
    const harness = createHarness({ localGrant: true });
    const secret = harness.readLocalGrantSecret();

    const response = await harness.request(
      PUBLIC_DEVICE_PAIRING_LOCAL_GRANT_PATH,
      harness.json({ secret, deviceName: 'This Mac' }),
      LOOPBACK_PEER,
    );
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      environmentId: string;
      device: PairedDevice;
      credential: string;
    };
    expect(result.environmentId).toBe(ENVIRONMENT_ID);
    expect(result.device.name).toBe('This Mac');
    expect(result.device.scope).toBe(DEFAULT_GRANT_PAIRING_SCOPE);
    expect(harness.pairing.verifyCredential(result.credential)).toBe(true);
    expect(harness.pairing.credentialLocality(result.credential)).toBe(
      'home-possession',
    );
    // archive#3677 PR 3: THIS route is the one mint whose credential may
    // drive the native consent broker — the exchange must stamp the
    // local-grant mint kind end-to-end, and the public device must not
    // leak it.
    expect(harness.pairing.credentialMintKind(result.credential)).toBe(
      'local-grant',
    );
    expect(result.device).not.toHaveProperty('locality');
    expect(result.device).not.toHaveProperty('mintKind');

    const listed = await harness.request('/api/pairing/devices', {
      headers: { Authorization: `Bearer ${MASTER_CREDENTIAL}` },
    });
    expect(await listed.json()).toMatchObject({
      devices: [{ id: result.device.id, name: 'This Mac' }],
    });

    expect(harness.auditRecords).toEqual([
      {
        event: 'station.pairing.approved',
        approver: 'local-grant',
        source: 'same-origin',
        timestamp: expect.any(Number),
      },
    ]);
  });

  test('refuses a wrong secret with the same code as a bad network position', async () => {
    const harness = createHarness({ localGrant: true });
    const response = await harness.request(
      PUBLIC_DEVICE_PAIRING_LOCAL_GRANT_PATH,
      harness.json({ secret: 'not-the-real-secret', deviceName: 'This Mac' }),
      LOOPBACK_PEER,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'local_grant_forbidden' });
    expect(harness.auditRecords).toEqual([]);
  });

  /**
   * archive#1818 part 3 — proves the mechanism the desktop client's fix
   * (`local_self_provision_client_instance_id` in `src-desktop/src/lib.rs`)
   * depends on: this route already supersedes a prior device sharing the
   * same `clientInstanceId`, exactly like the public exchange route does
   * (see the `clientInstanceId` describe block above). Nothing server-side
   * needed to change — the desktop client used to send a FRESH random id on
   * every call, which could never match, so this supersession never fired
   * for local self-provision even though the route already supported it.
   * Two exchanges through THIS EXACT route with the same `clientInstanceId`
   * (what two `station_local_self_provision` calls for the same local
   * profile now send, including across a nightly-bundle-swap relaunch)
   * revoke the first grant and issue a second — never two live, unrevoked,
   * full-scope credentials.
   */
  test('supersedes a prior local-grant device sharing the same clientInstanceId', async () => {
    const harness = createHarness({ localGrant: true });
    const secret = harness.readLocalGrantSecret();
    const clientInstanceId = '33333333-3333-4333-8333-333333333333';
    // Own peer address, not the shared `LOOPBACK_PEER` literal every other
    // test in this describe block dials — this test makes two requests
    // against the module-level per-peer rate-limit bucket, and other tests
    // sharing that exact address already consume part of its budget.
    const peer = nextLocalGrantPeer();

    const first = await harness.request(
      PUBLIC_DEVICE_PAIRING_LOCAL_GRANT_PATH,
      harness.json({ secret, deviceName: 'This Mac', clientInstanceId }),
      peer,
    );
    expect(first.status).toBe(200);
    const firstResult = (await first.json()) as {
      device: PairedDevice;
      credential: string;
    };

    const second = await harness.request(
      PUBLIC_DEVICE_PAIRING_LOCAL_GRANT_PATH,
      harness.json({ secret, deviceName: 'This Mac', clientInstanceId }),
      peer,
    );
    expect(second.status).toBe(200);
    const secondResult = (await second.json()) as {
      device: PairedDevice;
      credential: string;
    };

    // THE assertion: the prior grant no longer works. Before the client-side
    // fix, the equivalent of these two calls (two relaunches after a
    // bundle swap) left BOTH credentials live — the accumulation the
    // issue's comment reported.
    expect(harness.pairing.verifyCredential(firstResult.credential)).toBe(
      false,
    );
    expect(harness.pairing.verifyCredential(secondResult.credential)).toBe(
      true,
    );

    const listed = await harness.request('/api/pairing/devices', {
      headers: { Authorization: `Bearer ${MASTER_CREDENTIAL}` },
    });
    expect(await listed.json()).toMatchObject({
      devices: [
        { id: firstResult.device.id, revokedAt: expect.any(Number) },
        { id: secondResult.device.id, revokedAt: null },
      ],
    });
  });

  test('refuses a non-loopback direct caller even with the correct secret', async () => {
    const harness = createHarness({ localGrant: true });
    const secret = harness.readLocalGrantSecret();
    const response = await harness.request(
      PUBLIC_DEVICE_PAIRING_LOCAL_GRANT_PATH,
      harness.json({ secret, deviceName: 'Remote attempt' }),
      '100.96.12.40',
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'local_grant_forbidden' });
  });

  test('refuses a request proxied through the UI proxy without evaluating the secret at all', async () => {
    const harness = createHarness({ localGrant: true });
    const secret = harness.readLocalGrantSecret();
    const response = await harness.request(
      PUBLIC_DEVICE_PAIRING_LOCAL_GRANT_PATH,
      {
        ...harness.json({ secret, deviceName: 'Proxied attempt' }),
        headers: {
          'Content-Type': 'application/json',
          [INTERNAL_PROXY_CALLER_HEADER]: 'loopback',
          [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
        },
      },
      LOOPBACK_PEER,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'local_grant_forbidden' });
    // The correct secret was presented; only the proxy header made this a
    // refusal, proving the guard is evaluated before the secret comparison.
    expect(harness.auditRecords).toEqual([]);
  });

  test('refuses a request carrying a server-verified tailnet identity, even from loopback', async () => {
    const harness = createHarness({ localGrant: true });
    const secret = harness.readLocalGrantSecret();
    const identity = Buffer.from(
      JSON.stringify({
        provider: 'tailscale-serve',
        login: 'brian@example.test',
      }),
    ).toString('base64url');
    const response = await harness.request(
      PUBLIC_DEVICE_PAIRING_LOCAL_GRANT_PATH,
      {
        ...harness.json({ secret, deviceName: 'Serve attempt' }),
        headers: {
          'Content-Type': 'application/json',
          [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
          [INTERNAL_INGRESS_IDENTITY_HEADER]: identity,
        },
      },
      LOOPBACK_PEER,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'local_grant_forbidden' });
  });

  test('rate-limits repeated attempts from the same peer', async () => {
    const harness = createHarness({ localGrant: true });
    const peer = nextLocalGrantPeer();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await harness.request(
        PUBLIC_DEVICE_PAIRING_LOCAL_GRANT_PATH,
        harness.json({ secret: 'wrong-every-time', deviceName: 'This Mac' }),
        peer,
      );
      statuses.push(response.status);
    }
    expect(statuses).toEqual([403, 403, 403, 403, 403, 429]);
  });

  test('rejects a malformed body and a query string the same as sibling pairing routes', async () => {
    const harness = createHarness({ localGrant: true });
    const secret = harness.readLocalGrantSecret();

    const query = await harness.request(
      `${PUBLIC_DEVICE_PAIRING_LOCAL_GRANT_PATH}?x=1`,
      harness.json({ secret, deviceName: 'This Mac' }),
      LOOPBACK_PEER,
    );
    expect(query.status).toBe(400);

    const malformed = await harness.request(
      PUBLIC_DEVICE_PAIRING_LOCAL_GRANT_PATH,
      harness.json({ secret }),
      LOOPBACK_PEER,
    );
    expect(malformed.status).toBe(400);
  });

  test('writes the secret file 0600 and mints a different value on every configure (boot)', async () => {
    const first = createHarness({ localGrant: true });
    const firstSecret = first.readLocalGrantSecret();
    if (process.platform !== 'win32') {
      const mode = statSync(first.localGrantSecretPath).mode & 0o777;
      expect(mode).toBe(0o600);
    }

    const second = createHarness({ localGrant: true });
    const secondSecret = second.readLocalGrantSecret();
    expect(secondSecret).not.toBe(firstSecret);

    // The first harness's own secret keeps working against its own instance;
    // rotation is per-process/per-configure, not a global invalidation.
    const response = await first.request(
      PUBLIC_DEVICE_PAIRING_LOCAL_GRANT_PATH,
      first.json({ secret: firstSecret, deviceName: 'This Mac' }),
      LOOPBACK_PEER,
    );
    expect(response.status).toBe(200);
  });
});

/**
 * archive#1490 — a direct loopback socket is not operator authority: an SSH
 * local forward is indistinguishable from an operator browser at this layer.
 * These pin the fail-loud credential requirement on protected pairing-host
 * routes and the authenticated bearer path that follows it.
 */
describe('pairing approval requires a runtime credential (station#1490)', () => {
  const LOOPBACK_PEER = '127.0.0.1';
  // The public pairing routes rate-limit per peer address through a
  // module-level map that outlives each test, and every case here dials from
  // loopback. 127.0.0.0/8 is loopback in its entirety, so walking the last
  // octet gives each request its own limiter key without changing what the
  // guard sees.
  let loopbackDialCount = 0;
  const nextLoopbackPeer = () => `127.0.0.${(loopbackDialCount++ % 250) + 2}`;
  // TEST-NET-2 (RFC 5737). Peers here are judged against this host's REAL
  // interface list, so a fixture address must be one no machine can hold —
  // a plausible-looking LAN or tailnet address would make these tests pass or
  // fail depending on whose laptop ran them.
  const DEVICE_PEER = '198.51.100.42';
  const hostOwnAddress = () =>
    Object.values(networkInterfaces())
      .flatMap((entries) => entries ?? [])
      .find((entry) => entry.family === 'IPv4' && !entry.internal)?.address;

  async function accessRequest(
    harness: ReturnType<typeof createHarness>,
    peer: string,
    deviceName: string,
    extraHeaders: Record<string, string> = {},
  ) {
    // `isTrustedBrowserPairingOrigin` accepts an allow-listed Origin with NO
    // `sec-fetch-site` at all (the guard reads the resulting `null` as
    // same-origin), which no browser produces for a POST but any HTTP client
    // does. That is how the probe's first request got in, so it is how these
    // make theirs.
    const response = await harness.request(
      '/.well-known/station/v1/pairing/access-request',
      {
        ...harness.json({ deviceName }),
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://station.example.test',
          ...extraHeaders,
        },
      },
      peer,
    );
    const body = (await response.json()) as {
      offerId?: string;
      proof?: string;
      requestId?: string;
      credential?: string;
      bootstrap?: string;
      environmentId?: string;
    };
    expect(response.status).toBe(202);
    expect(body.requestId).toEqual(expect.any(String));
    return body as {
      offerId: string;
      proof: string;
      requestId: string;
      credential?: string;
      bootstrap?: string;
    };
  }

  const approve = (
    harness: ReturnType<typeof createHarness>,
    requestId: string,
    credential?: string,
  ) =>
    harness.request(
      `/api/pairing/requests/${requestId}/confirm`,
      credential ? harness.json({}, credential) : { method: 'POST' },
      LOOPBACK_PEER,
    );

  test('a direct loopback access-request stays pending until explicit operator authority confirms it', async () => {
    const harness = createHarness();
    const access = await accessRequest(
      harness,
      nextLoopbackPeer(),
      'Tunnel probe',
    );

    expect(access.bootstrap).toBeUndefined();
    expect(access.credential).toBeUndefined();
    const bareConfirm = await approve(harness, access.requestId ?? 'missing');
    expect(bareConfirm.status).toBe(401);
    await expect(bareConfirm.json()).resolves.toMatchObject({
      error: { code: 'authentication_required' },
    });
    // The explicit operator credential reaches the host handler and confirms
    // the still-pending local request.
    expect(
      (await approve(harness, access.requestId ?? 'missing', MASTER_CREDENTIAL))
        .status,
    ).toBe(200);
  });

  test('an SSH-forward-shaped loopback access-request cannot mint a credential', async () => {
    const harness = createHarness();
    const access = await accessRequest(
      harness,
      nextLoopbackPeer(),
      'SSH forwarded browser',
      {
        'X-Forwarded-For': '203.0.113.17',
        'X-Forwarded-Host': 'localhost',
      },
    );

    expect(access.credential).toBeUndefined();
    expect(access.bootstrap).toBeUndefined();
    expect(access.requestId).toEqual(expect.any(String));
    expect(harness.pairing.listDevices()).toEqual([]);
  });

  test('requires a bearer to list and approve an off-box device from loopback', async () => {
    const harness = createHarness();
    const access = await accessRequest(harness, DEVICE_PEER, 'Brian phone');

    const bareInbox = await harness.request(
      '/api/pairing/requests',
      {},
      LOOPBACK_PEER,
    );
    expect(bareInbox.status).toBe(401);
    await expect(bareInbox.json()).resolves.toMatchObject({
      error: { code: 'authentication_required' },
    });

    const inbox = await harness.request(
      '/api/pairing/requests',
      { headers: { Authorization: `Bearer ${MASTER_CREDENTIAL}` } },
      LOOPBACK_PEER,
    );
    expect(inbox.status).toBe(200);

    const approval = await approve(
      harness,
      access.requestId,
      MASTER_CREDENTIAL,
    );
    expect(approval.status).toBe(200);
    expect(await approval.json()).toMatchObject({ status: 'confirmed' });

    const exchange = await harness.request(
      '/.well-known/station/v1/pairing/exchange',
      harness.json({
        offerId: access.offerId,
        proof: access.proof,
        requestId: access.requestId,
      }),
      DEVICE_PEER,
    );
    expect(exchange.status).toBe(200);
    expect((await exchange.json()) as { device: PairedDevice }).toMatchObject({
      device: { name: 'Brian phone', scope: DEFAULT_GRANT_PAIRING_SCOPE },
    });
  });

  test('a bearer creates an offer and approves a scanned pairing-code request', async () => {
    const harness = createHarness();
    const offerResponse = await harness.request(
      '/api/pairing/offers',
      harness.json(
        {
          endpoint: 'https://station.example.test',
          scope: 'orchestration:read orchestration:operate',
        },
        MASTER_CREDENTIAL,
      ),
      LOOPBACK_PEER,
    );
    expect(offerResponse.status).toBe(201);
    const offer = (await offerResponse.json()) as DevicePairingOffer;

    const requestResponse = await harness.request(
      '/.well-known/station/v1/pairing/request',
      harness.json({
        deviceName: 'Scanned phone',
        offerId: offer.offerId,
        proof: offer.challenge,
      }),
      DEVICE_PEER,
    );
    expect(requestResponse.status).toBe(202);
    const pending = (await requestResponse.json()) as DevicePairingRequest;

    expect(
      (await approve(harness, pending.requestId, MASTER_CREDENTIAL)).status,
    ).toBe(200);
  });

  test('a bare loopback caller cannot create an offer to recombine into authority', async () => {
    const harness = createHarness();
    const offerResponse = await harness.request(
      '/api/pairing/offers',
      harness.json({ endpoint: 'https://station.example.test' }),
      LOOPBACK_PEER,
    );
    expect(offerResponse.status).toBe(401);
    await expect(offerResponse.json()).resolves.toMatchObject({
      error: { code: 'authentication_required' },
    });
  });

  test('a request dialled to one of this host own addresses still needs a bearer to approve', async () => {
    const harness = createHarness();
    const own = hostOwnAddress();
    // Every machine that runs this suite has at least one non-internal IPv4
    // address; without one there is nothing to assert and a silent skip would
    // read as coverage.
    expect(own).toBeDefined();
    // The self-dial: a process on this host reaching Station at the host's own
    // LAN address. The kernel gives the server that same address as the peer,
    // so "not loopback" is true and proves nothing — which is exactly the
    // conversion this closes.
    const access = await accessRequest(harness, own as string, 'Self dial');

    const approval = await approve(harness, access.requestId);
    expect(approval.status).toBe(401);
    await expect(approval.json()).resolves.toMatchObject({
      error: { code: 'authentication_required' },
    });
  });

  test('an unreadable requester peer does not waive the bearer requirement to approve', async () => {
    const harness = createHarness();
    // The route must classify the requester from the RAW address, not from the
    // rate-limiter's `'absent'` sentinel string — that string is not loopback,
    // so classifying it would quietly make an unreadable peer approvable.
    const response = await harness.requestWithoutPeer(
      '/.well-known/station/v1/pairing/access-request',
      {
        ...harness.json({ deviceName: 'Peerless probe' }),
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://station.example.test',
        },
      },
    );
    expect(response.status).toBe(202);
    const access = (await response.json()) as { requestId: string };

    const approval = await approve(harness, access.requestId);
    expect(approval.status).toBe(401);
    await expect(approval.json()).resolves.toMatchObject({
      error: { code: 'authentication_required' },
    });
  });

  describe('approval attribution after runtime authentication (station#1490)', () => {
    test('refuses bare loopback approval before recording a verified approval', async () => {
      const harness = createHarness();
      const addSpy = vi.spyOn(devicePairingRequests, 'add');
      const access = await accessRequest(harness, DEVICE_PEER, 'Brian phone');

      const bareApproval = await approve(harness, access.requestId);
      expect(bareApproval.status).toBe(401);
      await expect(bareApproval.json()).resolves.toMatchObject({
        error: { code: 'authentication_required' },
      });
      expect(harness.auditRecords).toEqual([]);

      expect(
        (await approve(harness, access.requestId, MASTER_CREDENTIAL)).status,
      ).toBe(200);

      // The event log is reserved for anomalous unauthenticated approvals;
      // a verified bearer approval is accounted for by the privacy-safe
      // metric below without producing that residue record.
      expect(harness.auditRecords).toEqual([]);
      expect(addSpy).toHaveBeenCalledWith(1, {
        source: 'same-origin',
        outcome: 'approved',
        approver: 'presented-credential',
      });
      // No device name, no id, no address — the counter's privacy rule.
      for (const [, attributes] of addSpy.mock.calls) {
        expect(Object.keys(attributes ?? {}).sort()).not.toContain(
          'deviceName',
        );
      }
      addSpy.mockRestore();
    });

    test('records a bearer approval without retaining a caller identity in telemetry', async () => {
      const harness = createHarness();
      const addSpy = vi.spyOn(devicePairingRequests, 'add');
      const access = await accessRequest(harness, DEVICE_PEER, 'Brian phone');

      expect(
        (await approve(harness, access.requestId, MASTER_CREDENTIAL)).status,
      ).toBe(200);

      // The approved metric records the credential class, never a device name
      // or secret, so it remains attribution without disclosure.
      expect(harness.auditRecords).toEqual([]);
      expect(addSpy).toHaveBeenCalledWith(1, {
        source: 'same-origin',
        outcome: 'approved',
        approver: 'presented-credential',
      });
      addSpy.mockRestore();
    });

    test('does not record a loopback access request as an approval', async () => {
      const harness = createHarness();
      const access = await accessRequest(
        harness,
        nextLoopbackPeer(),
        'Tunnel probe',
      );

      expect(access.bootstrap).toBeUndefined();
      expect(harness.auditRecords).toEqual([]);
    });

    test('the production wiring passes an audit sink, not just this harness', async () => {
      // `configureRuntimeRoutes` is the only production call site, and nothing
      // else observes it — deleting its `audit:` option left every test green.
      const source = await readFile(
        new URL('../routes/runtime-routes.ts', import.meta.url),
        'utf8',
      );
      const callSite = source.slice(
        source.indexOf('configureDevicePairingHostRoutes(\n    context.app,'),
      );
      expect(callSite).not.toBe('');
      expect(callSite.slice(0, 400)).toContain('audit:');
    });

    test('the production wiring persists secret-safe failed-auth evidence', async () => {
      const source = await readFile(
        new URL('../routes/runtime-routes.ts', import.meta.url),
        'utf8',
      );
      const callSite = source.slice(
        source.indexOf('configureDevicePairingPublicRoutes(\n    context.app,'),
      );
      expect(callSite).not.toBe('');
      expect(callSite.slice(0, 500)).toContain('authFailureAudit:');
      expect(source).toContain(
        "context.logger.warn('Pairing authentication attempt rejected'",
      );
    });
  });

  describe('behind Tailscale Serve', () => {
    // Serve terminates the tailnet connection on this host and re-dials the UI
    // port from loopback, which `trustedTailscaleIdentity` requires. So the
    // attested peer for a Serve request is always 127.0.0.1, and judging it by
    // address alone refused exactly the requests carrying the strongest
    // provenance Station has (archive#1490 delta review H2).
    const serveIdentity = (login = 'brian@example.test') =>
      Buffer.from(
        JSON.stringify({ provider: 'tailscale-serve', login }),
      ).toString('base64url');

    test('preserves a server-verified tailnet identity and requires a bearer to approve it', async () => {
      const harness = createHarness();
      const access = await accessRequest(
        harness,
        nextLoopbackPeer(),
        'Phone over Serve',
        {
          [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
          [INTERNAL_INGRESS_IDENTITY_HEADER]: serveIdentity(),
          // What the proxy would truthfully attest for a Serve request.
          [INTERNAL_PROXY_PEER_HEADER]: LOOPBACK_PEER,
        },
      );

      const bareInbox = await harness.request(
        '/api/pairing/requests',
        {},
        LOOPBACK_PEER,
      );
      expect(bareInbox.status).toBe(401);
      await expect(bareInbox.json()).resolves.toMatchObject({
        error: { code: 'authentication_required' },
      });

      const inbox = await harness.request(
        '/api/pairing/requests',
        { headers: { Authorization: `Bearer ${MASTER_CREDENTIAL}` } },
        LOOPBACK_PEER,
      );
      expect(await inbox.json()).toMatchObject({
        requests: [
          expect.objectContaining({
            requestId: access.requestId,
            source: 'tailnet',
            requester: expect.objectContaining({
              provider: 'tailscale-serve',
              login: 'brian@example.test',
            }),
          }),
        ],
      });

      const approval = await approve(
        harness,
        access.requestId,
        MASTER_CREDENTIAL,
      );
      expect(approval.status).toBe(200);
      expect(await approval.json()).toMatchObject({ status: 'confirmed' });
    });

    test('refuses an identity claim that is not backed by the internal token', async () => {
      const harness = createHarness();
      // Without the token the identity is just a header anyone on the floor
      // can type, and the request remains pending for explicit approval.
      const access = await accessRequest(
        harness,
        nextLoopbackPeer(),
        'Forged Serve claim',
        {
          [INTERNAL_INGRESS_IDENTITY_HEADER]: serveIdentity('attacker@x.test'),
        },
      );

      expect(access.bootstrap).toBeUndefined();
      expect(access.credential).toBeUndefined();
    });
  });

  describe('launcher UI bootstrap capability (station#2093)', () => {
    test('exchanges an explicit one-time capability for an HttpOnly browser session without trusting proxy position', async () => {
      // The proxy hop here attests an OFF-BOX client (archive#3876): the
      // browser is a phone on the UI port, so the session it mints is a
      // paired device however trusted the hop itself is.

      const bootstrapToken = 'launcher-ui-bootstrap-token';
      const harness = createHarness({ uiBootstrapToken: bootstrapToken });
      const bootstrap = await harness.request(
        PUBLIC_DEVICE_PAIRING_UI_BOOTSTRAP_PATH,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://station.example.test',
            [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
            [INTERNAL_PROXY_CALLER_HEADER]: 'remote',
            [INTERNAL_PROXY_PEER_HEADER]: DEVICE_PEER,
          },
          body: JSON.stringify({ token: bootstrapToken }),
        },
        nextLoopbackPeer(),
      );

      expect(bootstrap.status).toBe(200);
      expect(bootstrap.headers.get('set-cookie')).toContain('HttpOnly');
      await expect(bootstrap.json()).resolves.toMatchObject({
        environmentId: ENVIRONMENT_ID,
        delivery: 'browser-cookie',
      });
      const proxiedCredential = /(?:__Host-)?station-device=([^;]+)/.exec(
        bootstrap.headers.get('set-cookie') ?? '',
      )?.[1];
      expect(proxiedCredential).toEqual(expect.any(String));
      expect(
        harness.pairing.credentialLocality(proxiedCredential as string),
        'a bootstrap the proxy attested for an OFF-BOX client recorded home-possession locality',
      ).toBeUndefined();
      expect(harness.auditRecords).toEqual([
        expect.objectContaining({ approver: 'ui-bootstrap' }),
      ]);

      const replay = await harness.request(
        PUBLIC_DEVICE_PAIRING_UI_BOOTSTRAP_PATH,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://station.example.test',
          },
          body: JSON.stringify({ token: bootstrapToken }),
        },
      );
      expect(replay.status).toBe(403);
      await expect(replay.json()).resolves.toEqual({
        error: 'ui_bootstrap_forbidden',
      });
    });

    /**
     * archive#3876 — the OPERATOR'S OWN JOURNEY. `station start` prints
     * `http://127.0.0.1:<uiPort>/#station-ui-bootstrap=…`, so the ordinary way
     * an operator reaches their own Station is through the UI proxy, not the
     * server socket. Before this, that browser minted a session with no
     * `home-possession` stamp, and every surface reading that one locality
     * fact — D6's log redaction, archive#3843's presentation — treated the person
     * sitting at the machine as a remote control for it.
     *
     * The four cases below are the whole derivation. Each removes exactly one
     * of the three attested facts and must fall back to `paired`; only the
     * first, which has all three, is the local operator.
     */
    const uiBootstrapThroughProxy = async (
      harness: ReturnType<typeof createHarness>,
      bootstrapToken: string,
      headers: Record<string, string>,
      directPeer = nextLoopbackPeer(),
    ) => {
      const response = await harness.request(
        PUBLIC_DEVICE_PAIRING_UI_BOOTSTRAP_PATH,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://station.example.test',
            ...headers,
          },
          body: JSON.stringify({ token: bootstrapToken }),
        },
        directPeer,
      );
      expect(response.status).toBe(200);
      const credential = /(?:__Host-)?station-device=([^;]+)/.exec(
        response.headers.get('set-cookie') ?? '',
      )?.[1];
      expect(credential).toEqual(expect.any(String));
      return harness.pairing.credentialLocality(credential as string);
    };

    /** What Station's own UI proxy puts on the hop it opens for a browser. */
    const attestedUiProxyHop = (
      clientPeer: string,
      browserHost: string,
      token = getInternalApiToken(),
    ) => ({
      [INTERNAL_API_TOKEN_HEADER]: token,
      // The proxy's own marker is ALWAYS `remote` (it never speaks for its
      // client's authority); the attested address and browser host are what
      // the derivation reads.
      [INTERNAL_PROXY_CALLER_HEADER]: 'remote',
      [INTERNAL_PROXY_PEER_HEADER]: clientPeer,
      [INTERNAL_PROXY_FORWARDED_HOST_HEADER]: browserHost,
    });

    test('the printed URL, opened through the UI proxy, records home-possession locality', async () => {
      const bootstrapToken = 'printed-url-bootstrap-token';
      const harness = createHarness({ uiBootstrapToken: bootstrapToken });
      const locality = await uiBootstrapThroughProxy(
        harness,
        bootstrapToken,
        attestedUiProxyHop('127.0.0.1', '127.0.0.1:5274'),
      );
      expect(
        locality,
        'the operator opening the URL `station start` printed is still classified as a paired device',
      ).toBe('home-possession');
    });

    test('a Tailscale Serve hop stays paired even though Serve re-dials from loopback', async () => {
      const bootstrapToken = 'serve-hop-bootstrap-token';
      const harness = createHarness({ uiBootstrapToken: bootstrapToken });
      const locality = await uiBootstrapThroughProxy(harness, bootstrapToken, {
        ...attestedUiProxyHop('127.0.0.1', '127.0.0.1:5274'),
        [INTERNAL_INGRESS_IDENTITY_HEADER]: Buffer.from(
          JSON.stringify({
            provider: 'tailscale-serve',
            login: 'operator@example.test',
          }),
        ).toString('base64url'),
      });
      expect(
        locality,
        'a phone reaching the proxy over the tailnet minted home possession',
      ).toBeUndefined();
    });

    test('a browser that addressed a NON-loopback authority stays paired', async () => {
      // The tailnet case Station was not configured to identify: with no
      // `STATION_TRUSTED_TAILSCALE_SERVE_ORIGIN` the proxy mints no ingress
      // identity, and Serve's own re-dial IS loopback. What Serve preserves is
      // the browser's `Host`, which names the tailnet, not this machine.
      const bootstrapToken = 'tailnet-host-bootstrap-token';
      const harness = createHarness({ uiBootstrapToken: bootstrapToken });
      const locality = await uiBootstrapThroughProxy(
        harness,
        bootstrapToken,
        attestedUiProxyHop('127.0.0.1', 'kontour.example.ts.net'),
      );
      expect(
        locality,
        'a browser that never addressed this machine minted home possession',
      ).toBeUndefined();
    });

    test('a forged proxy attestation stays paired — it is the token, not the header', async () => {
      const bootstrapToken = 'forged-attestation-bootstrap-token';
      // (1) An untrusted token from a loopback socket. Accepting the address
      // header on its own would let anything that can reach this port claim
      // the proxy's authority (archive#3693's rule).
      const wrongToken = createHarness({ uiBootstrapToken: bootstrapToken });
      expect(
        await uiBootstrapThroughProxy(
          wrongToken,
          bootstrapToken,
          attestedUiProxyHop('127.0.0.1', '127.0.0.1:5274', 'not-the-token'),
        ),
        'a forged proxy attestation minted home possession — the header was believed without the per-boot token',
      ).toBeUndefined();

      // (2) The same forged headers from an OFF-BOX socket, which is where a
      // caller that is not this machine's proxy actually sits.
      const offBox = createHarness({ uiBootstrapToken: bootstrapToken });
      expect(
        await uiBootstrapThroughProxy(
          offBox,
          bootstrapToken,
          attestedUiProxyHop('127.0.0.1', '127.0.0.1:5274', 'not-the-token'),
          DEVICE_PEER,
        ),
        'an off-box caller spelling the proxy headers minted home possession',
      ).toBeUndefined();
    });

    test('a direct-loopback bootstrap without proxy attestation records home-possession locality', async () => {
      const bootstrapToken = 'direct-loopback-bootstrap-token';
      const harness = createHarness({ uiBootstrapToken: bootstrapToken });
      const bootstrap = await harness.request(
        PUBLIC_DEVICE_PAIRING_UI_BOOTSTRAP_PATH,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://station.example.test',
          },
          body: JSON.stringify({ token: bootstrapToken }),
        },
        nextLoopbackPeer(),
      );

      expect(bootstrap.status).toBe(200);
      const credential = /(?:__Host-)?station-device=([^;]+)/.exec(
        bootstrap.headers.get('set-cookie') ?? '',
      )?.[1];
      expect(credential).toEqual(expect.any(String));
      expect(harness.pairing.credentialLocality(credential as string)).toBe(
        'home-possession',
      );
      // archive#3677 PR 3: the discriminating stamp — this credential lives
      // in host-browser JS, so its mint kind must read `ui-bootstrap`,
      // which the native consent broker refuses.
      expect(harness.pairing.credentialMintKind(credential as string)).toBe(
        'ui-bootstrap',
      );
    });

    test('refuses a missing or wrong capability without minting a session', async () => {
      const harness = createHarness({ uiBootstrapToken: 'correct-token' });
      for (const token of ['', 'wrong-token']) {
        const response = await harness.request(
          PUBLIC_DEVICE_PAIRING_UI_BOOTSTRAP_PATH,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Origin: 'https://station.example.test',
            },
            body: JSON.stringify({ token }),
          },
        );
        expect(response.status).toBe(403);
        expect(response.headers.get('set-cookie')).toBeNull();
      }
    });

    test('refuses a valid capability from an untrusted browser origin', async () => {
      const bootstrapToken = 'origin-bound-bootstrap-token';
      const harness = createHarness({ uiBootstrapToken: bootstrapToken });

      const response = await harness.request(
        PUBLIC_DEVICE_PAIRING_UI_BOOTSTRAP_PATH,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://attacker.example.test',
          },
          body: JSON.stringify({ token: bootstrapToken }),
        },
      );

      expect(response.status).toBe(403);
      expect(response.headers.get('set-cookie')).toBeNull();
    });

    test('reuses a preserved HttpOnly session for repeated launcher links without issuing another credential', async () => {
      const bootstrapToken = 'preserved-session-bootstrap-token';
      const harness = createHarness({ uiBootstrapToken: bootstrapToken });
      const request = (cookie?: string) =>
        harness.request(PUBLIC_DEVICE_PAIRING_UI_BOOTSTRAP_PATH, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://station.example.test',
            ...(cookie ? { Cookie: cookie } : {}),
          },
          body: JSON.stringify({ token: bootstrapToken }),
        });

      const first = await request();
      expect(first.status).toBe(200);
      const firstBody = (await first.json()) as { device: PairedDevice };
      const setCookie = first.headers.get('set-cookie');
      expect(setCookie).toContain('HttpOnly');
      const sessionCookie = setCookie?.split(';', 1)[0];
      expect(sessionCookie).toEqual(expect.any(String));

      const repeated = await request(sessionCookie);
      expect(repeated.status).toBe(200);
      expect(repeated.headers.get('set-cookie')).toBeNull();
      await expect(repeated.json()).resolves.toMatchObject({
        device: { id: firstBody.device.id },
        delivery: 'browser-cookie',
      });
      expect(
        harness.pairing
          .listDevices()
          .filter((device) => device.revokedAt === null),
      ).toEqual([expect.objectContaining({ id: firstBody.device.id })]);
    });

    test('keeps a launcher capability usable after quota refusal instead of spending it before issuance', async () => {
      const bootstrapToken = 'quota-retry-bootstrap-token';
      const harness = createHarness({
        uiBootstrapToken: bootstrapToken,
        maxActiveCredentialsWithoutVerifiedIdentity: 1,
        // The pre-existing paired device retains its used offer in this
        // in-memory service; two slots leave exactly one slot for bootstrap.
        maxActiveOffers: 2,
      });
      const existing = await pairDevice(
        harness,
        'Existing identityless device',
      );
      const request = () =>
        harness.request(PUBLIC_DEVICE_PAIRING_UI_BOOTSTRAP_PATH, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://station.example.test',
          },
          body: JSON.stringify({ token: bootstrapToken }),
        });

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const blocked = await request();
        expect(blocked.status).toBe(400);
        await expect(blocked.json()).resolves.toEqual({
          error: 'unattributed_credential_quota_reached',
        });
      }
      expect(harness.auditRecords).toEqual([]);

      harness.pairing.revokeDevice(existing.device.id, 'operator-credential');
      // With only one bootstrap slot, this immediately proves all failed offers
      // were cancelled/pruned rather than retained until their TTL expires.
      const retry = await request();
      expect(retry.status).toBe(200);
      expect(retry.headers.get('set-cookie')).toContain('HttpOnly');
      expect(
        harness.pairing
          .listDevices()
          .filter((device) => device.revokedAt === null),
      ).toHaveLength(1);
    });

    test('issues at most one session when concurrent callers replay one capability', async () => {
      const bootstrapToken = 'concurrent-bootstrap-token';
      const harness = createHarness({ uiBootstrapToken: bootstrapToken });
      const request = () =>
        harness.request(PUBLIC_DEVICE_PAIRING_UI_BOOTSTRAP_PATH, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://station.example.test',
          },
          body: JSON.stringify({ token: bootstrapToken }),
        });

      const responses = await Promise.all([request(), request()]);

      expect(responses.map((response) => response.status).sort()).toEqual([
        200, 403,
      ]);
      expect(
        responses.filter((response) => response.headers.has('set-cookie')),
      ).toHaveLength(1);
    });
  });

  describe('behind tailscale serve pointed straight at this server', () => {
    // A channel app (stable/beta/nightly) embeds its server with no UI proxy
    // in front, so nothing attests the hop and the previous rule left the
    // endpoint as `http://<node>.ts.net` — which createOffer rejects. That is
    // why those apps could not pair over the tailnet at all (archive#3645).
    const TAILNET_URL =
      'http://kontour.python-smelt.ts.net/.well-known/station/v1/pairing/access-request';

    const directRequest = (
      harness: ReturnType<typeof createHarness>,
      url = TAILNET_URL,
    ) =>
      harness.request(
        url,
        {
          ...harness.json({ deviceName: 'Channel app phone' }),
          headers: {
            'content-type': 'application/json',
            // What the Android shell actually sends: its own packaged origin,
            // not a Station host. That is the caller this topology exists for.
            origin: 'http://tauri.localhost',
          },
        },
        nextLoopbackPeer(),
      );

    test('records the resolved public origin when Host is our own ingress', async () => {
      const harness = createHarness({
        resolvePublicIngressOrigin: async () =>
          'https://kontour.python-smelt.ts.net',
      });
      const recorded = vi.spyOn(harness.pairing, 'requestAccess');

      const response = await directRequest(harness);

      expect(response.status).toBe(202);
      expect(recorded.mock.calls[0]?.[0]).toMatchObject({
        endpoint: 'https://kontour.python-smelt.ts.net',
      });
    });

    test('ignores the resolved origin when Host is not the one serve published', async () => {
      // The daemon says we are served at `kontour...`; a request claiming some
      // other authority has not proven it came through that ingress, so the
      // previous behaviour stands rather than us advertising an address this
      // request never used.
      const harness = createHarness({
        resolvePublicIngressOrigin: async () =>
          'https://kontour.python-smelt.ts.net',
      });
      const recorded = vi.spyOn(harness.pairing, 'requestAccess');

      await directRequest(
        harness,
        'http://other-node.python-smelt.ts.net/.well-known/station/v1/pairing/access-request',
      );

      expect(recorded.mock.calls[0]?.[0]).toMatchObject({
        endpoint: 'http://other-node.python-smelt.ts.net',
      });
    });

    test('a ported Host matches a ported origin, and any port mismatch falls back', async () => {
      // The daemon preserves the listener port in the forwarded Host
      // (measured live: a serve listener on :9443 forwards
      // `Host: <node>:9443`), and the resolver renders non-default listeners
      // as `https://<host>:<port>`. Equality must therefore hold exactly
      // when the ports agree, and every disagreement — including an explicit
      // `:443` on the http-forwarded side, which URL keeps because 443 is
      // not http's default — must fall back rather than choose an endpoint
      // the request never arrived at.
      const cases: Array<{
        hostHeader: string;
        resolved: string;
        used: boolean;
      }> = [
        {
          hostHeader: 'kontour.python-smelt.ts.net:8444',
          resolved: 'https://kontour.python-smelt.ts.net:8444',
          used: true,
        },
        {
          hostHeader: 'kontour.python-smelt.ts.net',
          resolved: 'https://kontour.python-smelt.ts.net:8444',
          used: false,
        },
        {
          hostHeader: 'kontour.python-smelt.ts.net:443',
          resolved: 'https://kontour.python-smelt.ts.net',
          used: false,
        },
      ];
      for (const { hostHeader, resolved, used } of cases) {
        const harness = createHarness({
          resolvePublicIngressOrigin: async () => resolved,
        });
        const recorded = vi.spyOn(harness.pairing, 'requestAccess');
        await directRequest(
          harness,
          `http://${hostHeader}/.well-known/station/v1/pairing/access-request`,
        );
        expect(recorded, hostHeader).toHaveBeenCalledTimes(1);
        expect(recorded.mock.calls[0]?.[0], hostHeader).toMatchObject({
          endpoint: used ? resolved : `http://${hostHeader}`,
        });
      }
    });

    test('an unresolvable origin through the Host branch falls back untouched', async () => {
      // The .ts.net suffix opens consultation, not selection: when the
      // daemon has no mapping for us, the endpoint must be exactly what the
      // pre-change behaviour produced.
      const harness = createHarness({
        resolvePublicIngressOrigin: async () => undefined,
      });
      const recorded = vi.spyOn(harness.pairing, 'requestAccess');
      await directRequest(harness);
      expect(recorded).toHaveBeenCalledTimes(1);
      expect(recorded.mock.calls[0]?.[0]).toMatchObject({
        endpoint: 'http://kontour.python-smelt.ts.net',
      });
    });

    test('does not consult the daemon for an ordinary loopback request', async () => {
      // A local browser pairing against 127.0.0.1 must not spawn the CLI.
      let consulted = 0;
      const harness = createHarness({
        resolvePublicIngressOrigin: async () => {
          consulted += 1;
          return 'https://kontour.python-smelt.ts.net';
        },
      });
      const recorded = vi.spyOn(harness.pairing, 'requestAccess');

      await directRequest(
        harness,
        'http://localhost/.well-known/station/v1/pairing/access-request',
      );

      expect(consulted).toBe(0);
      expect(recorded.mock.calls[0]?.[0]).toMatchObject({
        endpoint: 'http://localhost',
      });
    });
  });

  describe('behind Station own loopback UI proxy', () => {
    // The proxy terminates the client connection and opens its own, so every
    // request behind it arrives from 127.0.0.1. Without the attested peer
    // address, a phone loading the UI from the UI port — the ordinary way a
    // phone reaches a Station — is indistinguishable from the operator's own
    // browser, and the guard would refuse the primary journey outright.
    const proxied = (peer: string, token = getInternalApiToken()) => ({
      [INTERNAL_API_TOKEN_HEADER]: token,
      [INTERNAL_PROXY_PEER_HEADER]: peer,
    });

    /** The proxy's own attestation that the hop came through Tailscale Serve. */
    const attestedIngress = (login = 'operator@example.test') => ({
      [INTERNAL_INGRESS_IDENTITY_HEADER]: Buffer.from(
        JSON.stringify({ provider: 'tailscale-serve', login }),
      ).toString('base64url'),
    });

    // archive#3379 follow-up. The endpoint recorded on the offer is the
    // address the device is later told to present its credential at, and the
    // request URL cannot supply it behind `tailscale serve`: TLS terminates in
    // the daemon, so the API sees plain http, and through this proxy it sees
    // `127.0.0.1` — an address no phone can reach. These pin the seam that
    // decides it, which the resolver's own unit tests cannot: a swapped
    // condition or dropped wiring would otherwise keep every other test green
    // while silently restoring the original defect.
    test('an attested proxy request records the resolved public origin', async () => {
      const harness = createHarness({
        resolvePublicIngressOrigin: async () =>
          'https://kontour.python-smelt.ts.net',
      });
      const recorded = vi.spyOn(harness.pairing, 'requestAccess');

      const response = await accessRequest(
        harness,
        nextLoopbackPeer(),
        'Proxied phone',
        { ...proxied(DEVICE_PEER), ...attestedIngress() },
      );

      expect(response.requestId).toBeTruthy();
      expect(recorded).toHaveBeenCalledTimes(1);
      expect(recorded.mock.calls[0]?.[0]).toMatchObject({
        endpoint: 'https://kontour.python-smelt.ts.net',
      });
    });

    test('a resolver that cannot answer leaves the request-derived endpoint', async () => {
      // No Tailscale, no daemon, or no mapping for this Station: the previous
      // behaviour must survive untouched rather than the request failing.
      const harness = createHarness({
        resolvePublicIngressOrigin: async () => undefined,
      });
      const recorded = vi.spyOn(harness.pairing, 'requestAccess');

      await accessRequest(harness, nextLoopbackPeer(), 'Proxied phone', {
        ...proxied(DEVICE_PEER),
        ...attestedIngress(),
      });

      expect(recorded).toHaveBeenCalledTimes(1);
      expect(recorded.mock.calls[0]?.[0]).not.toMatchObject({
        endpoint: 'https://kontour.python-smelt.ts.net',
      });
    });

    test('the production route configuration wires the resolver', () => {
      // The two tests above inject the resolver through the harness, so they
      // prove the handler USES it — not that production SUPPLIES it. Dropping
      // the wiring at the real call site leaves them green (verified by
      // injection), which is the gap this closes. It pins source text rather
      // than behaviour, deliberately: constructing the full runtime context
      // here would cost more than the defect it guards against.
      const source = readFileSync(
        new URL('../routes/runtime-routes.ts', import.meta.url),
        'utf8',
      );
      expect(source).toMatch(
        /resolvePublicIngressOrigin:\s*publicIngressOriginResolver\(/,
      );
    });

    test('an access-request minted through the UI proxy does not record home-possession locality', async () => {
      const harness = createHarness();
      const access = await accessRequest(
        harness,
        nextLoopbackPeer(),
        'Proxied phone',
        proxied(DEVICE_PEER),
      );
      expect(
        (await approve(harness, access.requestId, MASTER_CREDENTIAL)).status,
      ).toBe(200);
      const exchange = await harness.request(
        '/.well-known/station/v1/pairing/exchange',
        harness.json({
          offerId: access.offerId,
          proof: access.proof,
          requestId: access.requestId,
        }),
        DEVICE_PEER,
      );
      expect(exchange.status).toBe(200);
      const minted = (await exchange.json()) as { credential: string };
      expect(
        harness.pairing.credentialLocality(minted.credential),
        'same-origin credential minted via access-request through the proxy recorded home-possession locality',
      ).toBeUndefined();
    });

    test('an off-box proxy observation still requires a bearer to approve', async () => {
      const harness = createHarness();
      const access = await accessRequest(
        harness,
        nextLoopbackPeer(),
        'Proxied phone',
        proxied(DEVICE_PEER),
      );

      const bareApproval = await approve(harness, access.requestId);
      expect(bareApproval.status).toBe(401);
      await expect(bareApproval.json()).resolves.toMatchObject({
        error: { code: 'authentication_required' },
      });
      expect(
        (await approve(harness, access.requestId, MASTER_CREDENTIAL)).status,
      ).toBe(200);
    });

    test('a proxy-attested loopback client stays pending without explicit operator authority', async () => {
      const harness = createHarness();
      const access = await accessRequest(
        harness,
        nextLoopbackPeer(),
        'Proxied local browser',
        proxied(LOOPBACK_PEER),
      );

      // Proxy attestation distinguishes the network peer but never grants an
      // approval authority. This remains pending like every public request.
      expect(access.bootstrap).toBeUndefined();
      expect(access.credential).toBeUndefined();
      expect(access.requestId).toEqual(expect.any(String));
    });

    test('a proxy-attested own-address client stays pending without explicit operator authority', async () => {
      const harness = createHarness();
      const own = hostOwnAddress();
      expect(own).toBeDefined();
      const access = await accessRequest(
        harness,
        nextLoopbackPeer(),
        'Proxied self dial',
        proxied(own as string),
      );

      // An attested own address is network evidence, not operator authority.
      expect(access.bootstrap).toBeUndefined();
      expect(access.credential).toBeUndefined();
      expect(access.requestId).toEqual(expect.any(String));
    });

    test('an attested peer address does not turn a bare non-loopback caller into an approver', async () => {
      const harness = createHarness();
      const own = hostOwnAddress();
      expect(own).toBeDefined();
      // The stated anchor of the whole attestation argument is that only a
      // process on this host can be the proxy. A caller reaching the API
      // directly from a non-loopback address is not that process, so its
      // attested claim must be ignored even holding a valid token — otherwise
      // a leaked token turns any network position into an asserted one
      // (archive#1490 delta review L1).
      const access = await accessRequest(
        harness,
        own as string,
        'Off-path token holder',
        {
          [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
          [INTERNAL_PROXY_PEER_HEADER]: DEVICE_PEER,
        },
      );

      const approval = await approve(harness, access.requestId);
      expect(approval.status).toBe(401);
      await expect(approval.json()).resolves.toMatchObject({
        error: { code: 'authentication_required' },
      });
    });

    test('a request carrying an internal-token header — even invalid — stays pending', async () => {
      const harness = createHarness();
      // Internal proxy headers do not elevate a public access request.
      const access = await accessRequest(
        harness,
        nextLoopbackPeer(),
        'Forged proxy claim',
        proxied(DEVICE_PEER, 'not-the-internal-token'),
      );

      expect(access.bootstrap).toBeUndefined();
      expect(access.credential).toBeUndefined();
      expect(access.requestId).toEqual(expect.any(String));
    });

    test('ignores an attested peer address with no token at all', async () => {
      const harness = createHarness();
      const access = await accessRequest(
        harness,
        nextLoopbackPeer(),
        'No token',
        {
          [INTERNAL_PROXY_PEER_HEADER]: DEVICE_PEER,
        },
      );

      expect(access.bootstrap).toBeUndefined();
      expect(access.credential).toBeUndefined();
    });
  });
});
