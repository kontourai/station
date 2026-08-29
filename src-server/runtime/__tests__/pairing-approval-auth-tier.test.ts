import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type HttpBindings } from '@hono/node-server';
import type {
  DevicePairingOffer,
  DevicePairingRequest,
  PairedDevice,
} from '@kontourai/station-contracts';
import { pairingScopeIncludes } from '@kontourai/station-contracts';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createAttentionRoutes } from '../../routes/orchestration/attention.js';
import { requiredPairingScope } from '../../security/pairing-route-scopes.js';
import { getRuntimeAuthenticatedRequestPrincipal } from '../../security/runtime-request-security.js';
import type { EventBus } from '../../services/orchestration/event-bus.js';
import { AttentionProjectionService } from '../../services/projects/attention-projection.js';
import { EnvironmentSecurityService } from '../../services/ssh/environment-security-service.js';
import type { Logger } from '../../utils/logger.js';
import {
  configureRuntimeHttp,
  LOOPBACK_DEVICE_SESSION_COOKIE,
} from '../bootstrap/runtime-http.js';
import {
  configureDevicePairingHostRoutes,
  configureDevicePairingPublicRoutes,
} from '../routes/runtime-routes.js';

/**
 * #765 D5, the auth path the attention card's tests mocked away.
 *
 * PR #796 gave the Needs-attention card Approve/Deny wired to
 * `POST /api/pairing/requests/:id/confirm` / `DELETE /api/pairing/requests/:id`
 * through the SDK — with every test stubbing `fetch`, so nothing ever asked
 * whether the session tier that SEES the card can PASS those routes. It
 * cannot: `EnvironmentSecurityService.authorizeCredential` admits the pairing
 * family only for the operator credential or an `access:approve`-promoted
 * device, `access:approve` is operator-promotion-only (no preset, not in the
 * default grant), and the middleware reports that refusal as 401
 * `authentication_required`. Live verification reproduced exactly that from a
 * paired browser session.
 *
 * This suite therefore runs the REAL boundary — real
 * `EnvironmentSecurityService` (not a synthetic `verifyCredential`), real
 * middleware, real pairing routes — wired the same way
 * `configureRuntimeRoutes` wires production, and pins:
 *  - the browser tier (device-session cookie AND device bearer) is refused
 *    with the exact live status/code, on confirm and on the deny twin;
 *  - `GET /api/attention` tells that same session `viewerCanDecide: false`
 *    up front, so the UI never renders the doomed buttons;
 *  - the operator and a promoted device both decide, and their attention
 *    reads say `viewerCanDecide: true`.
 */
const ORIGIN = 'https://station.example.test';
const OPERATOR_PEER = '203.0.113.10';
const homes: string[] = [];

type TestBindings = HttpBindings & {
  incoming: HttpBindings['incoming'] & {
    socket: HttpBindings['incoming']['socket'] & { remoteAddress?: string };
  };
};

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

async function createHarness() {
  const homeDir = mkdtempSync(join(tmpdir(), 'station-pairing-auth-tier-'));
  homes.push(homeDir);
  const security = new EnvironmentSecurityService({ homeDir });
  const { credential: operatorCredential } = await security.initialize();

  const app = new Hono<{ Bindings: TestBindings }>();
  configureDevicePairingPublicRoutes(app as never, security.devicePairing, {
    allowedOrigins: [ORIGIN],
  });
  configureRuntimeHttp({
    app: app as never,
    logger,
    eventBus: { emit: vi.fn() } as unknown as EventBus,
    // The production wiring, not a test double: `configureRuntimeRoutes`
    // routes path-aware verification through `authorizeCredential` and scope
    // resolution through the same service. A synthetic `verifyCredential`
    // here is exactly how the pairing family's tier rule escapes coverage.
    security: {
      verifyCredential: (credential, request) =>
        request
          ? security.authorizeCredential(credential, request)
          : security.verifyCredential(credential),
      resolveGrantedScope: (credential) =>
        security.resolveGrantedScope(credential),
      resolveCredentialAuthority: (credential) =>
        security.verifyOperatorCredential(credential)
          ? 'operator-credential'
          : security.devicePairing.identifyDevice(credential)
            ? 'device-credential'
            : undefined,
      resolveCredentialDeviceId: (credential) =>
        security.devicePairing.identifyDevice(credential)?.id,
      allowedOrigins: [ORIGIN],
    },
  });
  configureDevicePairingHostRoutes(app as never, security.devicePairing);

  // The attention projection over the SAME pairing service, mounted with the
  // SAME viewer predicate `configureRuntimeRoutes` installs — so the item the
  // UI renders and the boundary that answers its buttons are read together.
  const attention = new AttentionProjectionService(
    { list: () => [] } as never,
    {
      listSessionReadModel: async () => [],
      readSessionFlowRun: async () => null,
      readSession: async () => ({ session: {} as never, events: [] }),
    } as never,
    {
      getRunConsole: async () => ({ gates: [] }),
    } as never,
    undefined,
    undefined,
    undefined,
    () => security.devicePairing,
  );
  app.route(
    '/api/attention',
    createAttentionRoutes(attention, {
      // Mirrors `configureRuntimeRoutes` exactly: boundary predicate first,
      // then the scope table's tier for the approval leaves.
      viewerMayDecidePairingRequests: (request) => {
        const principal = getRuntimeAuthenticatedRequestPrincipal(request);
        if (!principal) return false;
        if (principal.kind === 'internal') return true;
        if (
          !security.credentialMayDecidePairingRequests(principal.credential)
        ) {
          return false;
        }
        const requiredScope = requiredPairingScope(
          'POST',
          '/api/pairing/requests/:requestId/confirm',
        );
        if (requiredScope === undefined) return false;
        const grantedScope = security.resolveGrantedScope(principal.credential);
        return (
          grantedScope !== undefined &&
          pairingScopeIncludes(grantedScope, requiredScope)
        );
      },
    }),
  );

  const request = (
    path: string,
    init: RequestInit = {},
    peer = OPERATOR_PEER,
  ) =>
    app.request(path, init, {
      incoming: { socket: { remoteAddress: peer } },
    } as TestBindings);

  const json = (body: unknown, credential?: string): RequestInit => ({
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
    },
    body: JSON.stringify(body),
  });

  /** Mint a paired device over the real routes (operator-approved). */
  const pairDevice = async (
    name: string,
  ): Promise<{ device: PairedDevice; credential: string }> => {
    const offerResponse = await request(
      '/api/pairing/offers',
      json({ endpoint: ORIGIN }, operatorCredential),
    );
    expect(offerResponse.status).toBe(201);
    const offer = (await offerResponse.json()) as DevicePairingOffer;
    const requestResponse = await request(
      '/.well-known/station/v1/pairing/request',
      json({
        deviceName: name,
        offerId: offer.offerId,
        proof: offer.challenge,
      }),
    );
    expect(requestResponse.status).toBe(202);
    const pending = (await requestResponse.json()) as DevicePairingRequest;
    const confirm = await request(
      `/api/pairing/requests/${pending.requestId}/confirm`,
      json({}, operatorCredential),
    );
    expect(confirm.status).toBe(200);
    const exchange = await request(
      '/.well-known/station/v1/pairing/exchange',
      json({
        offerId: offer.offerId,
        proof: offer.challenge,
        requestId: pending.requestId,
      }),
    );
    expect(exchange.status).toBe(200);
    return exchange.json() as Promise<{
      device: PairedDevice;
      credential: string;
    }>;
  };

  /** A pending inbound request awaiting an approve/deny decision. */
  const createPendingRequest = async (
    name: string,
  ): Promise<DevicePairingRequest> => {
    const offerResponse = await request(
      '/api/pairing/offers',
      json({ endpoint: ORIGIN }, operatorCredential),
    );
    expect(offerResponse.status).toBe(201);
    const offer = (await offerResponse.json()) as DevicePairingOffer;
    const requestResponse = await request(
      '/.well-known/station/v1/pairing/request',
      json({
        deviceName: name,
        offerId: offer.offerId,
        proof: offer.challenge,
      }),
    );
    expect(requestResponse.status).toBe(202);
    return (await requestResponse.json()) as DevicePairingRequest;
  };

  return {
    security,
    operatorCredential,
    request,
    json,
    pairDevice,
    createPendingRequest,
  };
}

/** The browser shape: HttpOnly device-session cookie, no Authorization. */
function cookieInit(
  credential: string,
  method: 'GET' | 'POST' | 'DELETE',
): RequestInit {
  return {
    method,
    headers: {
      Cookie: `${LOOPBACK_DEVICE_SESSION_COOKIE}=${credential}`,
      // Browsers send Origin on mutations; the middleware requires it for
      // cookie-authenticated unsafe methods.
      ...(method === 'GET' ? {} : { Origin: ORIGIN }),
    },
  };
}

async function attentionPairingItems(
  harness: Awaited<ReturnType<typeof createHarness>>,
  init: RequestInit,
  peer: string,
): Promise<Array<{ viewerCanDecide: boolean; source: { requestId: string } }>> {
  const response = await harness.request('/api/attention', init, peer);
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    success: boolean;
    data: {
      items: Array<{
        kind: string;
        viewerCanDecide: boolean;
        source: { requestId: string };
      }>;
    };
  };
  expect(body.success).toBe(true);
  return body.data.items.filter((item) => item.kind === 'device-pairing');
}

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe('pairing approve/deny auth tier over the real boundary (#765 D5)', () => {
  test('a paired browser session is refused with the live 401, and its attention read says viewerCanDecide: false up front', async () => {
    const harness = await createHarness();
    const paired = await harness.pairDevice('Paired browser');
    // The session cookie carries the paired-device credential verbatim; the
    // cookie parser only admits this exact shape.
    expect(paired.credential).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const pending = await harness.createPendingRequest('New phone');

    // The exact live failure (#765 verification): device-session cookie on
    // the confirm route. The middleware folds "authenticated but not
    // admitted to the pairing family" into `authentication_required`.
    const cookieConfirm = await harness.request(
      `/api/pairing/requests/${pending.requestId}/confirm`,
      cookieInit(paired.credential, 'POST'),
      '203.0.113.21',
    );
    expect(cookieConfirm.status).toBe(401);
    expect(await cookieConfirm.json()).toEqual({
      error: { code: 'authentication_required' },
    });

    // Same tier as a bearer, and the deny twin: same refusal.
    const bearerConfirm = await harness.request(
      `/api/pairing/requests/${pending.requestId}/confirm`,
      harness.json({}, paired.credential),
      '203.0.113.22',
    );
    expect(bearerConfirm.status).toBe(401);
    const cookieDeny = await harness.request(
      `/api/pairing/requests/${pending.requestId}`,
      cookieInit(paired.credential, 'DELETE'),
      '203.0.113.23',
    );
    expect(cookieDeny.status).toBe(401);

    // What the fix adds: the projection tells this session it cannot decide,
    // so the UI renders the remedy instead of buttons that can only 401.
    const deviceItems = await attentionPairingItems(
      harness,
      cookieInit(paired.credential, 'GET'),
      '203.0.113.21',
    );
    expect(deviceItems).toEqual([
      expect.objectContaining({
        source: expect.objectContaining({ requestId: pending.requestId }),
        viewerCanDecide: false,
      }),
    ]);

    // The operator sees the same item as decidable...
    const operatorItems = await attentionPairingItems(
      harness,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${harness.operatorCredential}` },
      },
      OPERATOR_PEER,
    );
    expect(operatorItems).toEqual([
      expect.objectContaining({ viewerCanDecide: true }),
    ]);

    // ...and the refused attempts did not consume the request: the operator
    // still makes the explicit decision.
    const operatorConfirm = await harness.request(
      `/api/pairing/requests/${pending.requestId}/confirm`,
      harness.json({}, harness.operatorCredential),
    );
    expect(operatorConfirm.status).toBe(200);
  });

  /*
   * Caught by the live re-verify, not by the first round of this suite: the
   * ONLY public promotion mechanism (`POST /api/pairing/devices/:id/scope`)
   * submits a complete replacement scope, and `access:manage` is
   * default-grant-only (`scope_not_grantable`), so a device promoted that
   * way holds `access:approve` WITHOUT `access:manage` — it passes the
   * pairing family's authority boundary and is then 403'd by the scope
   * table's `/api/pairing` tier. `viewerCanDecide` must compose BOTH gates,
   * or it renders buttons for a session the table refuses.
   */
  test('a device promoted through the real scope route (approve without manage) is 403d by the table, and viewerCanDecide says false', async () => {
    const harness = await createHarness();
    const paired = await harness.pairDevice('Scope-route promoted');
    const scopeChange = await harness.request(
      `/api/pairing/devices/${paired.device.id}/scope`,
      harness.json(
        {
          scope: [
            'orchestration:read',
            'orchestration:operate',
            'terminal:operate',
            'access:approve',
          ],
          expectedScope: paired.device.scope,
        },
        harness.operatorCredential,
      ),
    );
    expect(scopeChange.status).toBe(200);
    const pending = await harness.createPendingRequest('New watch');

    const confirm = await harness.request(
      `/api/pairing/requests/${pending.requestId}/confirm`,
      cookieInit(paired.credential, 'POST'),
      '203.0.113.41',
    );
    expect(confirm.status).toBe(403);
    expect(await confirm.json()).toEqual({
      error: { code: 'insufficient_scope' },
    });

    const items = await attentionPairingItems(
      harness,
      cookieInit(paired.credential, 'GET'),
      '203.0.113.41',
    );
    expect(items).toEqual([
      expect.objectContaining({ viewerCanDecide: false }),
    ]);
  });

  test('an access:approve-promoted device session decides, and its attention read says so', async () => {
    const harness = await createHarness();
    const paired = await harness.pairDevice('Promoted tablet');
    harness.security.devicePairing.setDeviceApprovalAuthority(
      paired.device.id,
      true,
      { kind: 'presented-credential' },
    );
    const pending = await harness.createPendingRequest('New laptop');

    const items = await attentionPairingItems(
      harness,
      cookieInit(paired.credential, 'GET'),
      '203.0.113.31',
    );
    expect(items).toEqual([
      expect.objectContaining({
        source: expect.objectContaining({ requestId: pending.requestId }),
        viewerCanDecide: true,
      }),
    ]);

    // And the claim is honest end-to-end: the same session's approve passes
    // the same middleware that refused the unpromoted tier above.
    const confirm = await harness.request(
      `/api/pairing/requests/${pending.requestId}/confirm`,
      cookieInit(paired.credential, 'POST'),
      '203.0.113.31',
    );
    expect(confirm.status).toBe(200);
  });
});
