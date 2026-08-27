/**
 * Local-mode invariant regression guard.
 *
 * Station MUST be fully functional with zero identity providers and zero
 * network: identity (tailnet / Kontour account / fleet) is an additive
 * enhancement layer, never a precondition for the local path. See
 * `docs/design/identity.md` ("Local-first is non-negotiable") and the
 * constitution (belief #5 "Local-first, user owns their data"; non-negotiable
 * #3 "No hardcoded vendor dependencies in core paths").
 *
 * This suite asserts against the REAL `INGRESS_IDENTITY_SOURCES` /
 * `identifyIngress` (imported, not a fixture) that:
 *   1. A loopback request carrying no ingress-identity / internal-token headers
 *      yields NO identity (`identifyIngress` -> null).
 *   2. At the handler layer, such a request follows the same-origin / manual
 *      approval path (source !== 'tailnet') — the presence of the source list
 *      never makes identity mandatory.
 *
 * If a future change makes identity a precondition for the local path, this
 * guard fails.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type HttpBindings } from '@hono/node-server';
import {
  DEFAULT_GRANT_PAIRING_SCOPE,
  type DevicePairingRequest,
} from '@kontourai/station-contracts';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { configureRuntimeHttp } from '../../../runtime/bootstrap/runtime-http.js';
import {
  configureDevicePairingHostRoutes,
  configureDevicePairingPublicRoutes,
  INGRESS_IDENTITY_SOURCES,
  identifyIngress,
} from '../../../runtime/routes/runtime-routes.js';
import type { Logger } from '../../../utils/logger.js';
import type { EventBus } from '../../orchestration/event-bus.js';
import { DevicePairingService } from '../../ssh/device-pairing-service.js';

const LOOPBACK_ENVIRONMENT = {
  incoming: { socket: { remoteAddress: '127.0.0.1' } },
};

describe('local-mode invariant: no identity source configured, no network', () => {
  test('identifyIngress returns null for a loopback request with no ingress-identity headers', () => {
    const identity = identifyIngress({
      env: LOOPBACK_ENVIRONMENT,
      req: { header: () => undefined },
    });
    expect(identity).toBeNull();
  });

  test('every registered ingress source declines a request carrying no credential', () => {
    // Guards the invariant at the list level: a bare request must not be
    // recognized by ANY source, regardless of how many are registered. Today
    // the tailnet source is the only entry; this keeps future additive sources
    // honest.
    expect(INGRESS_IDENTITY_SOURCES.length).toBeGreaterThan(0);
    for (const source of INGRESS_IDENTITY_SOURCES) {
      expect(
        source.identify({
          environment: LOOPBACK_ENVIRONMENT,
          header: () => undefined,
        }),
      ).toBeNull();
    }
  });
});

// --- Handler-level guard -----------------------------------------------------
// Mirrors the existing `device pairing routes` harness (see
// src-server/runtime/__tests__/device-pairing-routes.test.ts): a same-origin
// loopback access request with NO ingress-identity headers must succeed AND be
// recorded with source !== 'tailnet' (the local manual-approval path), proving
// the source list does not make identity mandatory.

const MASTER_CREDENTIAL = 'master-credential';
const ENVIRONMENT_ID = '11111111-1111-4111-8111-111111111111';
const LOOPBACK_PEER = '127.0.0.1';
const homes: string[] = [];

type TestBindings = HttpBindings & {
  incoming: HttpBindings['incoming'] & {
    socket: HttpBindings['incoming']['socket'] & { remoteAddress?: string };
  };
};

function createHarness() {
  const homeDir = mkdtempSync(join(tmpdir(), 'station-local-mode-'));
  homes.push(homeDir);
  mkdirSync(join(homeDir, 'security'), { mode: 0o700 });
  const pairing = new DevicePairingService({
    homeDir,
    environmentId: ENVIRONMENT_ID,
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
  configureDevicePairingPublicRoutes(app as never, pairing, {
    allowedOrigins: ['https://station.example.test'],
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
      resolveGrantedScope: (credential) =>
        credential === MASTER_CREDENTIAL
          ? DEFAULT_GRANT_PAIRING_SCOPE
          : pairing.identifyDevice(credential)?.scope,
      allowedOrigins: ['https://station.example.test'],
    },
  });
  configureDevicePairingHostRoutes(app as never, pairing);

  const request = (
    path: string,
    init: RequestInit = {},
    peer = LOOPBACK_PEER,
  ) =>
    app.request(path, init, {
      incoming: { socket: { remoteAddress: peer } },
    } as TestBindings);
  return { pairing, request };
}

afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

describe('local-mode invariant: an access request needs explicit approval with no identity provider', () => {
  test('a headerless direct-loopback request stays pending — no identity vouched and no implicit local approval (station#1490/#1878)', async () => {
    const harness = createHarness();
    const endpoint =
      'https://station.example.test/.well-known/station/v1/pairing/access-request';

    const response = await harness.request(
      endpoint,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://station.example.test',
          'Sec-Fetch-Site': 'same-origin',
        },
        body: JSON.stringify({ deviceName: 'Local device' }),
      },
      LOOPBACK_PEER,
    );

    // Network position is never approval. A direct loopback request with no
    // verified ingress identity remains pending until an explicit operator
    // authority (or the separate owner-only local grant) completes it.
    expect(response.status).toBe(202);
    const body = (await response.json()) as {
      requestId?: string;
    };
    expect(body.requestId).toEqual(expect.any(String));
    // No identity provider vouched, so no requester identity is attached.
    expect(body).not.toHaveProperty('requester');

    // The request is observable for an authenticated operator to approve;
    // loopback alone cannot issue a bearer credential.
    const hostRequests = await harness.request('/api/pairing/requests', {
      headers: { Authorization: `Bearer ${MASTER_CREDENTIAL}` },
    });
    expect(hostRequests.status).toBe(200);
    const { requests } = (await hostRequests.json()) as {
      requests: DevicePairingRequest[];
    };
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      requestId: body.requestId,
      status: 'pending',
    });
    expect(requests[0]).not.toHaveProperty('requester');
  });
});
