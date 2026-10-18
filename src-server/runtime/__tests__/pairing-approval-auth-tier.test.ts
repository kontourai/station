import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type HttpBindings } from '@hono/node-server';
import type {
  DevicePairingOffer,
  DevicePairingRequest,
  PairedDevice,
} from '@kontourai/station-contracts';
import type { CredentialRecoveryGroupProjection } from '@kontourai/station-contracts/connection-recovery';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { agentConnectionFixture } from '../../../tests/helpers/connection-fixtures.js';
import { credentialProfileAppHomeDir } from '../../providers/app-home/credential-profile-registry.js';
import { createPersonalTokenRoutes } from '../../routes/access/personal-token-routes.js';
import { createAppHomeRoutes } from '../../routes/connections/app-home.js';
import { createAttentionRoutes } from '../../routes/orchestration/attention.js';
import {
  pairingScopeSatisfiesHttpRoute,
  requiredPairingScope,
} from '../../security/pairing-route-scopes.js';
import {
  getRuntimeAuthenticatedRequestPrincipal,
  isRuntimeRequestPrincipalCurrent,
} from '../../security/runtime-request-security.js';
import { DeviceCodeLoginManager } from '../../services/connections/device-code-login.js';
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

async function createHarness(
  configure?: (
    app: Hono<{ Bindings: TestBindings }>,
    security: EnvironmentSecurityService,
  ) => void,
) {
  const homeDir = mkdtempSync(join(tmpdir(), 'station-pairing-auth-tier-'));
  homes.push(homeDir);
  const security = new EnvironmentSecurityService({ homeDir });
  const { credential: operatorCredential } = await security.initialize();

  const app = new Hono<{ Bindings: TestBindings }>();
  configureDevicePairingPublicRoutes(app as never, security.devicePairing, {
    allowedOrigins: [ORIGIN],
    localGrant: { secretPath: join(homeDir, 'runtime', 'local-grant.secret') },
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
      recognizeCredential: (credential) =>
        security.verifyCredential(credential),
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
      resolveCredentialLocality: (credential) =>
        security.credentialLocality(credential),
      resolveCredentialMintKind: (credential) =>
        security.credentialMintKind(credential),
      allowedOrigins: [ORIGIN],
    },
  });
  const audits: Array<{ event: string; approver: string }> = [];
  configureDevicePairingHostRoutes(app as never, security.devicePairing, {
    groups: {
      groupOf: (principalId) => security.groupOf(principalId),
      assignments: () => security.groupAssignments(),
      assign: (principalId, group) => security.assignGroup(principalId, group),
    },
    audit: (record) => audits.push(record),
    verifyOperatorCredential: (credential) =>
      security.verifyOperatorCredential(credential),
    isApprovalCurrent: (request) =>
      isRuntimeRequestPrincipalCurrent(request, security),
    isRequestPrincipalCurrent: (request) =>
      isRuntimeRequestPrincipalCurrent(request, security),
  });

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
    '/api/access/tokens',
    createPersonalTokenRoutes(security.devicePairing),
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
          pairingScopeSatisfiesHttpRoute(grantedScope, requiredScope, {
            method: 'POST',
            path: '/api/pairing/requests/request/confirm',
          })
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
    scope?: string,
  ): Promise<DevicePairingRequest> => {
    const offerResponse = await request(
      '/api/pairing/offers',
      json(
        { endpoint: ORIGIN, ...(scope ? { scope } : {}) },
        operatorCredential,
      ),
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

  /** A device's own access request, as the Station app sends it. */
  const deviceAccessRequest = async (
    name: string,
    scope: string,
  ): Promise<DevicePairingRequest> => {
    const response = await request(
      '/.well-known/station/v1/pairing/access-request',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
        body: JSON.stringify({ deviceName: name, scope }),
      },
    );
    expect(response.status).toBe(202);
    const { requestId } = (await response.json()) as { requestId: string };
    return security.devicePairing
      .listRequests()
      .find((candidate) => candidate.requestId === requestId)!;
  };

  configure?.(app, security);
  return {
    audits,
    deviceAccessRequest,
    homeDir,
    security,
    operatorCredential,
    localGrantSecret: () =>
      readFileSync(
        join(homeDir, 'runtime', 'local-grant.secret'),
        'utf8',
      ).trim(),
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
): Promise<
  Array<{
    viewerCanDecide: boolean;
    source: { requestId: string };
    deviceName: string;
    requestedScope?: string;
  }>
> {
  const response = await harness.request('/api/attention', init, peer);
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    success: boolean;
    data: {
      items: Array<{
        kind: string;
        viewerCanDecide: boolean;
        source: { requestId: string };
        deviceName: string;
        requestedScope?: string;
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
  test('a paired browser session is refused as insufficient scope, and its attention read says viewerCanDecide: false up front', async () => {
    const harness = await createHarness();
    const paired = await harness.pairDevice('Paired browser');
    // The session cookie carries the paired-device credential verbatim; the
    // cookie parser only admits this exact shape.
    expect(paired.credential).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const pending = await harness.createPendingRequest('New phone');

    // Device-session cookie on the confirm route. The credential is live;
    // route admission still refuses it. That answer is 403, not 401: a 401
    // is what the browser treats as a dead device session.
    const cookieConfirm = await harness.request(
      `/api/pairing/requests/${pending.requestId}/confirm`,
      cookieInit(paired.credential, 'POST'),
      '203.0.113.21',
    );
    expect(cookieConfirm.status).toBe(403);
    expect(await cookieConfirm.json()).toEqual({
      error: { code: 'insufficient_scope' },
    });

    // Same tier as a bearer, and the deny twin: same refusal.
    const bearerConfirm = await harness.request(
      `/api/pairing/requests/${pending.requestId}/confirm`,
      harness.json({}, paired.credential),
      '203.0.113.22',
    );
    expect(bearerConfirm.status).toBe(403);
    expect(await bearerConfirm.json()).toEqual({
      error: { code: 'insufficient_scope' },
    });
    const cookieDeny = await harness.request(
      `/api/pairing/requests/${pending.requestId}`,
      cookieInit(paired.credential, 'DELETE'),
      '203.0.113.23',
    );
    expect(cookieDeny.status).toBe(403);
    expect(await cookieDeny.json()).toEqual({
      error: { code: 'insufficient_scope' },
    });

    // The projection tells this session it cannot decide, so the UI renders
    // the remedy instead of buttons the boundary will refuse.
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

  // The real scope editor cannot grant legacy access:manage. Explicit approval
  // must still reach only pending-request decisions, through the actual boundary.
  test('a scope-route promotion lists, confirms and denies pending requests without management authority', async () => {
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
    const listed = await harness.request(
      '/api/pairing/requests',
      cookieInit(paired.credential, 'GET'),
      '203.0.113.41',
    );
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({
      requests: [expect.objectContaining({ requestId: pending.requestId })],
    });

    const items = await attentionPairingItems(
      harness,
      cookieInit(paired.credential, 'GET'),
      '203.0.113.41',
    );
    expect(items).toEqual([expect.objectContaining({ viewerCanDecide: true })]);
    const confirm = await harness.request(
      `/api/pairing/requests/${pending.requestId}/confirm`,
      { ...cookieInit(paired.credential, 'POST'), body: '{}' },
      '203.0.113.41',
    );
    expect(confirm.status).toBe(200);

    const deniedRequest = await harness.createPendingRequest('Other phone');
    const denied = await harness.request(
      `/api/pairing/requests/${deniedRequest.requestId}`,
      cookieInit(paired.credential, 'DELETE'),
      '203.0.113.41',
    );
    expect(denied.status).toBe(200);
    const management = await harness.request(
      '/api/pairing/devices',
      cookieInit(paired.credential, 'GET'),
      '203.0.113.41',
    );
    expect(management.status).toBe(403);
    expect(await management.json()).toEqual({
      error: { code: 'insufficient_scope' },
    });
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

describe('a request that asks for an elevated grant', () => {
  // Literal: Standard plus full access, as the Station app asks for it.
  const WITH_FULL_ACCESS =
    'orchestration:read orchestration:operate terminal:operate approval:full-access';

  test('lists what it asks for, and an access:approve device may approve it only with the elevated grant left out', async () => {
    const harness = await createHarness();
    const promoted = await harness.pairDevice('Promoted tablet');
    harness.security.devicePairing.setDeviceApprovalAuthority(
      promoted.device.id,
      true,
      { kind: 'presented-credential' },
    );
    const pending = await harness.deviceAccessRequest(
      'New phone',
      WITH_FULL_ACCESS,
    );

    const items = await attentionPairingItems(
      harness,
      cookieInit(promoted.credential, 'GET'),
      '203.0.113.51',
    );
    expect(items).toEqual([
      expect.objectContaining({ requestedScope: WITH_FULL_ACCESS }),
    ]);

    // Keeping full access is the operator's call, not the promoted device's.
    const kept = await harness.request(
      `/api/pairing/requests/${pending.requestId}/confirm`,
      { ...cookieInit(promoted.credential, 'POST'), body: '{}' },
      '203.0.113.51',
    );
    expect(kept.status).toBe(403);
    expect(await kept.json()).toEqual({
      error: 'approval_requires_operator',
      operatorCli: 'station',
    });
    // Refused and recorded as a refusal, like the service's own refusals.
    expect(harness.audits).toContainEqual(
      expect.objectContaining({ event: 'station.pairing.refused' }),
    );

    const trimmed = await harness.request(
      `/api/pairing/requests/${pending.requestId}/confirm`,
      {
        ...cookieInit(promoted.credential, 'POST'),
        headers: {
          ...(cookieInit(promoted.credential, 'POST').headers as Record<
            string,
            string
          >),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          scope: 'orchestration:read orchestration:operate terminal:operate',
        }),
      },
      '203.0.113.51',
    );
    expect(trimmed.status).toBe(200);
    expect(await trimmed.json()).toMatchObject({
      scope: 'orchestration:read orchestration:operate terminal:operate',
    });
  });

  test('a peer Station delegation is listed without a scope to trim', async () => {
    const harness = await createHarness();
    const response = await harness.request(
      '/.well-known/station/v1/pairing/access-request',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
        body: JSON.stringify({
          deviceName: 'Peer Station',
          kind: 'delegation',
        }),
      },
    );
    expect(response.status).toBe(202);
    await harness.deviceAccessRequest('Phone', WITH_FULL_ACCESS);
    const items = await attentionPairingItems(
      harness,
      { headers: { Authorization: `Bearer ${harness.operatorCredential}` } },
      '203.0.113.53',
    );
    const byName = new Map(items.map((item) => [item.deviceName, item]));
    expect(byName.get('Peer Station')).not.toHaveProperty('requestedScope');
    expect(byName.get('Phone')?.requestedScope).toBe(WITH_FULL_ACCESS);
  });

  test("an operator's own offer carrying an elevated grant is held to the same rule", async () => {
    const harness = await createHarness();
    const promoted = await harness.pairDevice('Promoted tablet');
    harness.security.devicePairing.setDeviceApprovalAuthority(
      promoted.device.id,
      true,
      { kind: 'presented-credential' },
    );
    const pending = await harness.createPendingRequest(
      'Scanned phone',
      WITH_FULL_ACCESS,
    );
    const kept = await harness.request(
      `/api/pairing/requests/${pending.requestId}/confirm`,
      { ...cookieInit(promoted.credential, 'POST'), body: '{}' },
      '203.0.113.52',
    );
    expect(kept.status).toBe(403);
  });

  test('the operator keeps it, or unticks part of it, and never adds to it', async () => {
    const harness = await createHarness();
    const confirm = (requestId: string, body: unknown) =>
      harness.request(
        `/api/pairing/requests/${requestId}/confirm`,
        harness.json(body, harness.operatorCredential),
      );

    const asked = await harness.deviceAccessRequest('Phone', WITH_FULL_ACCESS);
    const keptAll = await confirm(asked.requestId, {});
    expect(keptAll.status).toBe(200);
    expect(await keptAll.json()).toMatchObject({ scope: WITH_FULL_ACCESS });

    const trimmedRequest = await harness.deviceAccessRequest(
      'Tablet',
      WITH_FULL_ACCESS,
    );
    const trimmed = await confirm(trimmedRequest.requestId, {
      scope: 'orchestration:read',
    });
    expect(trimmed.status).toBe(200);
    expect(await trimmed.json()).toMatchObject({ scope: 'orchestration:read' });

    const narrow = await harness.deviceAccessRequest(
      'Watch',
      'orchestration:read',
    );
    const widened = await confirm(narrow.requestId, {
      scope: 'orchestration:read coding:exec',
    });
    expect(widened.status).toBe(400);
    expect(
      harness.security.devicePairing
        .listRequests()
        .find((candidate) => candidate.requestId === narrow.requestId)?.status,
    ).toBe('pending');
  });
});

test('the desktop home-proven local grant can invite and approve a phone without elevating that phone', async () => {
  const h = await createHarness();
  const mint = await h.request(
    '/.well-known/station/v1/pairing/local-grant',
    h.json({ secret: h.localGrantSecret(), deviceName: 'Desktop' }),
    '127.0.0.1',
  );
  expect(mint.status).toBe(200);
  const desktop = (await mint.json()) as {
    credential: string;
    device: PairedDevice;
  };
  expect(
    h.security.devicePairing.isLocalGrantMintedCredential(desktop.credential),
  ).toBe(true);
  const offerResponse = await h.request(
    '/api/pairing/offers',
    h.json({ endpoint: ORIGIN }, desktop.credential),
  );
  expect(offerResponse.status).toBe(201);
  const offer = (await offerResponse.json()) as DevicePairingOffer;
  const pendingResponse = await h.request(
    '/.well-known/station/v1/pairing/request',
    h.json({
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: 'Phone',
    }),
  );
  expect(pendingResponse.status).toBe(202);
  const pending = (await pendingResponse.json()) as DevicePairingRequest;
  const authorization = { Authorization: `Bearer ${desktop.credential}` };
  expect(
    (await h.request('/api/pairing/requests', { headers: authorization }))
      .status,
  ).toBe(200);
  expect(
    (await h.request('/api/pairing/devices', { headers: authorization }))
      .status,
  ).toBe(200);
  expect(
    h.security.credentialMayDecidePairingRequests(desktop.credential),
  ).toBe(true);
  expect(
    (
      await h.request(
        `/api/pairing/requests/${pending.requestId}/confirm`,
        h.json({}, desktop.credential),
      )
    ).status,
  ).toBe(200);
  const exchange = await h.request(
    '/.well-known/station/v1/pairing/exchange',
    h.json({
      offerId: offer.offerId,
      proof: offer.challenge,
      requestId: pending.requestId,
    }),
  );
  expect(exchange.status).toBe(200);
  const phone = (await exchange.json()) as {
    credential: string;
    device: PairedDevice;
  };
  expect(
    (
      await h.request(
        '/api/pairing/offers',
        h.json({ endpoint: ORIGIN }, phone.credential),
      )
    ).status,
  ).toBe(403);
  expect(h.security.credentialMayDecidePairingRequests(phone.credential)).toBe(
    false,
  );
  // The host-issued browser session can invite devices without acquiring
  // the native desktop grant used by the consent broker.
  const launcher = await h.request(
    '/.well-known/station/v1/pairing/mint-ui-bootstrap',
    h.json({ secret: h.localGrantSecret() }),
    '127.0.0.1',
  );
  expect(launcher.status).toBe(200);
  const { token } = (await launcher.json()) as { token: string };
  const browser = await h.request(
    '/.well-known/station/v1/pairing/ui-bootstrap',
    {
      ...h.json({ token }),
      headers: {
        'Content-Type': 'application/json',
        Origin: ORIGIN,
        Cookie: `${LOOPBACK_DEVICE_SESSION_COOKIE}=${phone.credential}`,
      },
    },
    '127.0.0.1',
  );
  expect(browser.status).toBe(200);
  const browserCookie = browser.headers.get('set-cookie')!.split(';')[0];
  const browserCredential = browserCookie.slice(browserCookie.indexOf('=') + 1);
  expect(
    h.security.devicePairing.isLocalGrantMintedCredential(browserCredential),
  ).toBe(false);
  expect(h.security.credentialMayDecidePairingRequests(browserCredential)).toBe(
    true,
  );
  const browserHeaders = { Origin: ORIGIN, Cookie: browserCookie };
  expect(
    (await h.request('/api/pairing/devices', { headers: browserHeaders }))
      .status,
  ).toBe(200);
  expect(
    (await h.request('/api/pairing/people', { headers: browserHeaders }))
      .status,
  ).toBe(403);
  const requestedFullAccess = await h.deviceAccessRequest(
    'Another browser',
    'orchestration:read orchestration:operate terminal:operate coding:exec approval:full-access',
  );
  const approvedFullAccess = await h.request(
    `/api/pairing/requests/${requestedFullAccess.requestId}/confirm`,
    {
      ...h.json({}),
      headers: { ...browserHeaders, 'Content-Type': 'application/json' },
    },
  );
  expect(approvedFullAccess.status).toBe(200);
  const changed = await h.request(
    `/api/pairing/devices/${phone.device.id}/scope`,
    {
      ...h.json({
        scope: ['orchestration:read'],
        expectedScope: phone.device.scope,
      }),
      headers: { ...browserHeaders, 'Content-Type': 'application/json' },
    },
  );
  expect(changed.status).toBe(200);
  expect(((await changed.json()) as PairedDevice).scope).toBe(
    'orchestration:read',
  );
  expect(
    (
      await h.request(`/api/pairing/devices/${phone.device.id}`, {
        method: 'DELETE',
        headers: browserHeaders,
      })
    ).status,
  ).toBe(200);

  expect(
    (
      await h.request(
        '/api/pairing/offers',
        {
          ...h.json({ endpoint: ORIGIN }),
          headers: {
            'Content-Type': 'application/json',
            Origin: ORIGIN,
            Cookie: browserCookie,
          },
        },
        '127.0.0.1',
      )
    ).status,
  ).toBe(201);
  h.security.devicePairing.revokeDevice(
    desktop.device.id,
    'operator-credential',
  );
  expect(
    (
      await h.request(
        '/api/pairing/offers',
        h.json({ endpoint: ORIGIN }, desktop.credential),
      )
    ).status,
  ).toBe(401);
});

describe('host browser cannot transfer protected promotion authority', () => {
  async function browserHarness() {
    const h = await createHarness();
    const minted = await h.request(
      '/.well-known/station/v1/pairing/mint-ui-bootstrap',
      h.json({ secret: h.localGrantSecret() }),
      '127.0.0.1',
    );
    expect(minted.status).toBe(200);
    const { token } = (await minted.json()) as { token: string };
    const browser = await h.request(
      '/.well-known/station/v1/pairing/ui-bootstrap',
      {
        ...h.json({ token }),
        headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      },
      '127.0.0.1',
    );
    expect(browser.status).toBe(200);
    const headers = {
      'Content-Type': 'application/json',
      Origin: ORIGIN,
      Cookie: browser.headers.get('set-cookie')!.split(';')[0],
    };
    return {
      ...h,
      browserPost: (path: string, body?: unknown) =>
        h.request(path, {
          method: 'POST',
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
    };
  }

  test.each(['relay:manage', 'access:approve', 'consent:decide'] as const)(
    'refuses %s in browser invitations, final approval and scope introductions',
    async (token) => {
      const h = await browserHarness();
      const scope = `orchestration:read ${token}`;
      for (const approval of ['on-create', 'on-request'] as const) {
        const created = await h.browserPost('/api/pairing/offers', {
          endpoint: ORIGIN,
          scope,
          approval,
        });
        expect(created.status).toBe(403);
        expect(await created.json()).toMatchObject({
          error: 'approval_requires_operator',
        });
      }
      // An operator-created or older browser offer can already be pending.
      const pending = await h.createPendingRequest(
        'Pending protected offer',
        scope,
      );
      const confirmPath = `/api/pairing/requests/${pending.requestId}/confirm`;
      for (const body of [undefined, { scope }]) {
        const confirmed = await h.browserPost(confirmPath, body);
        expect(confirmed.status).toBe(403);
        expect(await confirmed.json()).toMatchObject({
          error: 'approval_requires_operator',
        });
        expect(
          h.security.devicePairing
            .listRequests()
            .find((request) => request.requestId === pending.requestId)?.status,
        ).toBe('pending');
      }
      const narrowed = await h.browserPost(confirmPath, {
        scope: 'orchestration:read',
      });
      expect(narrowed.status).toBe(200);
      expect(await narrowed.json()).toMatchObject({
        scope: 'orchestration:read',
      });

      const target = await h.pairDevice('Ordinary Device');
      const changed = await h.browserPost(
        `/api/pairing/devices/${target.device.id}/scope`,
        {
          scope: ['orchestration:read', token],
          expectedScope: target.device.scope,
        },
      );
      expect(changed.status).toBe(403);
      expect(await changed.json()).toMatchObject({
        error: 'approval_requires_operator',
      });
      expect(h.security.resolveGrantedScope(target.credential)).toBe(
        target.device.scope,
      );
    },
  );

  test.each(['relay:manage', 'access:approve', 'consent:decide'] as const)(
    'keeps deliberate operator and explicit device administrator grants of %s',
    async (token) => {
      const h = await browserHarness();
      const scope = `orchestration:read ${token}`;
      const preapproved = await h.request(
        '/api/pairing/offers',
        h.json(
          {
            endpoint: ORIGIN,
            scope,
            approval: 'on-create',
          },
          h.operatorCredential,
        ),
      );
      expect(preapproved.status).toBe(400);
      expect(await preapproved.json()).toEqual({ error: 'invalid_request' });
      const pending = await h.createPendingRequest(
        'Operator approved Device',
        scope,
      );
      const confirmed = await h.request(
        `/api/pairing/requests/${pending.requestId}/confirm`,
        h.json({}, h.operatorCredential),
      );
      expect(confirmed.status).toBe(200);
      expect(await confirmed.json()).toMatchObject({ scope });

      const admin = await h.pairDevice('Explicit access administrator');
      const promoted = await h.request(
        `/api/pairing/devices/${admin.device.id}/scope`,
        h.json(
          { scope: ['orchestration:read', 'access:devices'] },
          h.operatorCredential,
        ),
      );
      expect(promoted.status).toBe(200);
      const target = await h.pairDevice('Managed Device');
      const path = `/api/pairing/devices/${target.device.id}/scope`;
      const granted = await h.request(
        path,
        h.json({ scope: ['orchestration:read', token] }, admin.credential),
      );
      expect(granted.status).toBe(200);
      expect(h.security.resolveGrantedScope(target.credential)).toBe(scope);
      const retained = await h.browserPost(path, {
        scope: ['orchestration:read', 'orchestration:operate', token],
      });
      expect(retained.status).toBe(200);
      const removed = await h.browserPost(path, {
        scope: ['orchestration:read'],
      });
      expect(removed.status).toBe(200);
      expect(h.security.resolveGrantedScope(target.credential)).toBe(
        'orchestration:read',
      );
    },
  );
});

test.each([
  'offer',
  'cancel',
  'request',
  'deny',
  'scope',
  'revoke',
  'remove',
] as const)(
  'host browser device administration cannot manage a peer delegation through %s',
  async (operation) => {
    const h = await createHarness();
    const launcher = await h.request(
      '/.well-known/station/v1/pairing/mint-ui-bootstrap',
      h.json({ secret: h.localGrantSecret() }),
      '127.0.0.1',
    );
    expect(launcher.status).toBe(200);
    const { token } = (await launcher.json()) as { token: string };
    const browser = await h.request(
      '/.well-known/station/v1/pairing/ui-bootstrap',
      {
        ...h.json({ token }),
        headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      },
      '127.0.0.1',
    );
    expect(browser.status).toBe(200);
    const headers = {
      Origin: ORIGIN,
      Cookie: browser.headers.get('set-cookie')!.split(';')[0],
    };
    if (operation === 'offer' || operation === 'cancel') {
      const response = await h.request('/api/pairing/offers', {
        ...h.json(
          {
            endpoint: ORIGIN,
            kind: 'delegation',
            scope: 'orchestration:read orchestration:operate',
          },
          operation === 'cancel' ? h.operatorCredential : undefined,
        ),
        ...(operation === 'offer'
          ? { headers: { ...headers, 'Content-Type': 'application/json' } }
          : {}),
      });
      if (operation === 'offer') {
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({
          error: 'approval_requires_operator',
        });
      } else {
        expect(response.status).toBe(201);
        const offer = (await response.json()) as DevicePairingOffer;
        const cancelled = await h.request(
          `/api/pairing/offers/${offer.offerId}`,
          { method: 'DELETE', headers },
        );
        expect(cancelled.status).toBe(403);
        expect(await cancelled.json()).toMatchObject({
          error: 'approval_requires_operator',
        });
      }
      return;
    }
    const requested = await h.request(
      '/.well-known/station/v1/pairing/access-request',
      {
        ...h.json({ deviceName: 'Peer Station', kind: 'delegation' }),
        headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      },
    );
    expect(requested.status).toBe(202);
    const pending = (await requested.json()) as {
      requestId: string;
      offerId: string;
      proof: string;
    };
    const confirmPath = `/api/pairing/requests/${pending.requestId}/confirm`;
    if (operation === 'request' || operation === 'deny') {
      // Exercise the bodyless approval path as well as the JSON offer path.
      const response = await h.request(
        operation === 'request'
          ? confirmPath
          : `/api/pairing/requests/${pending.requestId}`,
        { method: operation === 'request' ? 'POST' : 'DELETE', headers },
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: 'approval_requires_operator',
      });
    }
    expect(
      (await h.request(confirmPath, h.json({}, h.operatorCredential))).status,
    ).toBe(200);
    const exchanged = await h.request(
      '/.well-known/station/v1/pairing/exchange',
      h.json(pending),
    );
    expect(exchanged.status).toBe(200);
    const { device } = (await exchanged.json()) as { device: PairedDevice };
    expect(device.kind).toBe('delegation');
    if (operation === 'request' || operation === 'deny') return;
    const devicePath = `/api/pairing/devices/${device.id}`;
    if (operation === 'remove') {
      expect(
        (
          await h.request(devicePath, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${h.operatorCredential}` },
          })
        ).status,
      ).toBe(200);
    }
    const response = await h.request(
      operation === 'scope'
        ? `${devicePath}/scope`
        : operation === 'remove'
          ? `${devicePath}/record`
          : devicePath,
      operation === 'scope'
        ? {
            ...h.json({ scope: ['orchestration:read'] }),
            headers: { ...headers, 'Content-Type': 'application/json' },
          }
        : { method: 'DELETE', headers },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: 'approval_requires_operator',
    });
  },
);

test('an operator-created invitation grants its assigned access once without a second approval', async () => {
  const h = await createHarness();
  const scope =
    'orchestration:read orchestration:operate terminal:operate coding:exec approval:full-access';
  const created = await h.request(
    '/api/pairing/offers',
    h.json(
      { endpoint: ORIGIN, scope, approval: 'on-create' },
      h.operatorCredential,
    ),
  );
  expect(created.status).toBe(201);
  const offer = (await created.json()) as DevicePairingOffer;
  expect(offer).not.toHaveProperty('preapproved');
  const requested = await h.request(
    '/.well-known/station/v1/pairing/request',
    h.json({
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: 'Invited browser',
    }),
  );
  expect(requested.status).toBe(202);
  const pending = (await requested.json()) as DevicePairingRequest;
  expect(pending.status).toBe('confirmed');
  const exchanged = await h.request(
    '/.well-known/station/v1/pairing/exchange',
    h.json({
      offerId: offer.offerId,
      proof: offer.challenge,
      requestId: pending.requestId,
    }),
  );
  expect(exchanged.status).toBe(200);
  const device = (await exchanged.json()) as {
    credential: string;
    device: PairedDevice;
  };
  expect(device.device.scope).toBe(scope);
  expect(
    h.security.devicePairing.credentialLocality(device.credential),
  ).toBeUndefined();
  expect(
    (
      await h.request(
        '/api/pairing/offers',
        h.json({ endpoint: ORIGIN }, device.credential),
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await h.request(
        '/.well-known/station/v1/pairing/exchange',
        h.json({
          offerId: offer.offerId,
          proof: offer.challenge,
          requestId: pending.requestId,
        }),
      )
    ).status,
  ).toBe(409);
});

test('cancelled invitations cannot grant access and unsolicited requests cannot approve themselves', async () => {
  const h = await createHarness();
  const created = await h.request(
    '/api/pairing/offers',
    h.json(
      {
        endpoint: ORIGIN,
        scope: 'orchestration:read',
        approval: 'on-create',
      },
      h.operatorCredential,
    ),
  );
  expect(created.status).toBe(201);
  const offer = (await created.json()) as DevicePairingOffer;
  expect(
    (
      await h.request(`/api/pairing/offers/${offer.offerId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${h.operatorCredential}` },
      })
    ).status,
  ).toBe(204);
  expect(
    (
      await h.request(
        '/.well-known/station/v1/pairing/request',
        h.json({
          offerId: offer.offerId,
          proof: offer.challenge,
          deviceName: 'Too late',
        }),
      )
    ).status,
  ).toBe(409);
  const unsolicited = await h.request(
    '/.well-known/station/v1/pairing/access-request',
    {
      ...h.json({
        deviceName: 'Uninvited browser',
        scope: 'orchestration:read',
        approval: 'on-create',
      }),
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    },
  );
  expect(unsolicited.status).toBe(202);
  const pending = (await unsolicited.json()) as {
    requestId: string;
    offerId: string;
    proof: string;
  };
  const exchange = await h.request(
    '/.well-known/station/v1/pairing/exchange',
    h.json(pending),
  );
  expect(exchange.status).toBe(409);
  expect(await exchange.json()).toMatchObject({
    error: 'request_not_confirmed',
  });
});

describe('delegated engine sign-in HTTP admission', () => {
  test('a promoted device reads safe profiles without gaining management access', async () => {
    const recovery: CredentialRecoveryGroupProjection = {
      profiles: [{ ref: 'http-login-read-smoke', label: 'Smoke profile' }],
      group: {
        profileRefs: ['http-login-read-smoke'],
        enrolledProfileRefs: [],
      },
      policy: { automatic: false },
      application: { capability: 'restart_resume' },
    };
    let holdRead = false;
    let releaseRead: (() => void) | undefined;
    const profileReads = vi.fn(async () => {
      if (holdRead)
        await new Promise<void>((resolve) => {
          releaseRead = resolve;
        });
      return recovery;
    });
    const capabilities = vi.fn(async () => ({
      engine: 'codex' as const,
      observedAt: '2026-09-30T00:00:00Z',
      evidence: [
        {
          mechanism: 'device-code' as const,
          observedCommand: ['/private/CLI_ARGUMENT_CANARY', 'login', '--help'],
          observedMatch: '--device-auth',
          argument: '--device-auth',
        },
      ],
    }));
    const mutations = vi.fn(async () => recovery);
    const closedLogins = new DeviceCodeLoginManager();
    closedLogins.cancelAll();
    homes.push(credentialProfileAppHomeDir('codex', 'http-login-read-smoke'));
    const harness = await createHarness((app, security) =>
      app.route(
        '/api/connections',
        createAppHomeRoutes({
          connectionService: {
            getConnection: async () =>
              agentConnectionFixture({ id: 'codex', type: 'codex' }),
            getCredentialRecovery: profileReads,
            upsertCredentialProfile: mutations,
            deleteCredentialProfile: mutations,
            setCredentialProfileEnrollment: mutations,
            setCredentialProfileEnv: mutations,
            setCredentialRecoveryAutomaticPolicy: mutations,
            applyCredentialProfile: async () => ({
              capability: 'unsupported',
              outcome: 'unsupported',
            }),
          },
          loginCapabilities: capabilities,
          deviceCodeLogins: closedLogins,
          accountAuth: async () => ({ state: 'unauthenticated' }),
          accountUsage: async () => ({
            status: 'ok',
            fetchedAt: '2026-10-01T00:00:00Z',
            exhausted: false,
            windows: [{ id: 'five-hour', label: '5 hour', usedPercent: 20 }],
          }),
          isLoginReadCurrent: (request) =>
            isRuntimeRequestPrincipalCurrent(request, security),
        }),
      ),
    );
    const { device, credential } = await harness.pairDevice('Login reader');
    const path = '/api/connections/agent/codex/device-code-profiles';
    const before = await harness.request(
      path,
      cookieInit(credential, 'GET'),
      '203.0.113.42',
    );
    expect(before.status).toBe(403);
    expect(profileReads).not.toHaveBeenCalled();
    const scopeChange = await harness.request(
      `/api/pairing/devices/${device.id}/scope`,
      harness.json(
        {
          scope: [
            'orchestration:read',
            'orchestration:operate',
            'engine:login',
          ],
          expectedScope: device.scope,
        },
        harness.operatorCredential,
      ),
    );
    expect(scopeChange.status).toBe(200);
    const allowed = await harness.request(
      path,
      cookieInit(credential, 'GET'),
      '203.0.113.42',
    );
    expect(allowed.status).toBe(200);
    const body = await allowed.json();
    expect(body).toEqual({
      success: true,
      data: {
        profiles: [
          {
            ref: 'http-login-read-smoke',
            label: 'Smoke profile',
            authState: 'unauthenticated',
            mechanisms: ['device-code'],
          },
        ],
      },
    });
    expect(JSON.stringify(body)).not.toContain('CLI_ARGUMENT_CANARY');
    const accounts = await harness.request(
      '/api/connections/agent/codex/accounts',
      cookieInit(credential, 'GET'),
      '203.0.113.42',
    );
    expect(accounts.status).toBe(200);
    expect(await accounts.json()).toMatchObject({
      success: true,
      data: {
        engine: 'codex',
        accounts: [
          { ref: null, label: 'Default account' },
          { ref: 'http-login-read-smoke', label: 'Smoke profile' },
        ],
      },
    });
    const usage = await harness.request(
      '/api/connections/agent/codex/account-usage?profileRef=http-login-read-smoke',
      cookieInit(credential, 'GET'),
      '203.0.113.42',
    );
    expect(usage.status).toBe(403);
    const operatorUsage = await harness.request(
      '/api/connections/agent/codex/account-usage?profileRef=http-login-read-smoke',
      { headers: { Authorization: `Bearer ${harness.operatorCredential}` } },
    );
    expect(operatorUsage.status).toBe(200);
    expect(JSON.stringify(await operatorUsage.json())).not.toContain(
      'CLI_ARGUMENT_CANARY',
    );
    const globalLogin = await harness.request(
      '/api/connections/agent/codex/account-login',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credential}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
      },
      '203.0.113.42',
    );
    expect(globalLogin.status).toBe(400);
    const missingAccount = await harness.request(
      '/api/connections/agent/codex/account-usage?profileRef=unregistered',
      cookieInit(harness.operatorCredential, 'GET'),
      '203.0.113.42',
    );
    expect(missingAccount.status).toBe(404);
    for (const [method, suffix] of [
      ['GET', 'credential-recovery'],
      ['GET', 'enrolment/http-login-read-smoke'],
      ['POST', 'credential-recovery/profiles'],
      ['POST', 'credential-recovery/profiles/http-login-read-smoke/import'],
      ['POST', 'credential-recovery/profiles/http-login-read-smoke/apply'],
      ['PUT', 'credential-recovery/policy'],
    ]) {
      const denied = await harness.request(
        `/api/connections/agent/codex/${suffix}`,
        { method, headers: { Authorization: `Bearer ${credential}` } },
        '203.0.113.42',
      );
      expect(denied.status, `${method} ${suffix}`).toBe(403);
    }
    expect(mutations).not.toHaveBeenCalled();
    const operator = await harness.request(path, {
      headers: { Authorization: `Bearer ${harness.operatorCredential}` },
    });
    expect(operator.status).toBe(200);
    expect(
      harness.security.resolveGrantedScope(harness.operatorCredential),
    ).toBe(
      'orchestration:read orchestration:operate terminal:operate access:manage',
    );
    const inference = await harness.request('/api/inference/chat', {
      method: 'POST',
      headers: { Authorization: `Bearer ${harness.operatorCredential}` },
    });
    expect(inference.status).toBe(403);
    // A closed manager refuses execution; these statuses prove auth admission,
    // not a successful provider login. Scope failure would be 403 instead.
    const loginPath =
      '/api/connections/agent/codex/enrolment/http-login-read-smoke/device-code';
    for (const [loginCredential, peer] of [
      [harness.operatorCredential, OPERATOR_PEER],
      [credential, '203.0.113.42'],
    ]) {
      const start = await harness.request(
        loginPath,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${loginCredential}` },
        },
        peer,
      );
      expect(start.status).toBe(503);
      expect(await start.json()).toMatchObject({ data: { outcome: 'closed' } });
      for (const method of ['GET', 'DELETE']) {
        const status = await harness.request(
          loginPath,
          { method, headers: { Authorization: `Bearer ${loginCredential}` } },
          peer,
        );
        expect(status.status).toBe(404);
      }
    }
    holdRead = true;
    profileReads.mockClear();
    capabilities.mockClear();
    const reading = harness.request(
      path,
      cookieInit(credential, 'GET'),
      '203.0.113.42',
    );
    await vi.waitFor(() => expect(releaseRead).toBeTypeOf('function'));
    const revoke = await harness.request(`/api/pairing/devices/${device.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${harness.operatorCredential}` },
    });
    expect(revoke.status).toBe(200);
    releaseRead?.();
    expect((await reading).status).toBe(403);
    expect(capabilities).not.toHaveBeenCalled();
    profileReads.mockClear();
    const revoked = await harness.request(
      path,
      cookieInit(credential, 'GET'),
      '203.0.113.42',
    );
    expect(revoked.status).toBe(401);
    expect(profileReads).not.toHaveBeenCalled();
  });
});

describe('#3557 Station groups at the HTTP boundary', () => {
  const ELEVATED =
    'orchestration:read orchestration:operate terminal:operate access:approve';

  /** A device tied to a verified Tailscale person, with `scope`. */
  const pairPerson = async (
    harness: Awaited<ReturnType<typeof createHarness>>,
    login: string,
    scope: string,
  ) => {
    const pairing = harness.security.devicePairing;
    const offer = pairing.createOffer({ endpoint: ORIGIN, scope });
    const request = pairing.requestPairing({
      requesterPosition: 'off-box',
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: `${login} phone`,
      source: 'tailnet',
      requester: { provider: 'tailscale-serve', login },
    });
    const principalId = `human:tailscale-serve:${login}`;
    pairing.confirmRequest(
      request.requestId,
      { kind: 'presented-credential' },
      { principalId, kind: 'verified-ingress' },
    );
    return {
      principalId,
      ...pairing.exchange({
        offerId: offer.offerId,
        proof: offer.challenge,
        requestId: request.requestId,
      }),
    };
  };

  test("a Member's device holding access:approve is refused an approval; promoting the person admits it without re-pairing", async () => {
    const harness = await createHarness();
    const casey = await pairPerson(harness, 'casey', ELEVATED);
    const pending = await harness.createPendingRequest('New watch');
    const confirm = () =>
      harness.request(
        `/api/pairing/requests/${pending.requestId}/confirm`,
        { ...cookieInit(casey.credential, 'POST'), body: '{}' },
        '203.0.113.61',
      );
    expect([401, 403]).toContain((await confirm()).status);

    const promoted = await harness.request(
      `/api/pairing/people/${encodeURIComponent(casey.principalId)}/group`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${harness.operatorCredential}`,
        },
        body: JSON.stringify({ group: 'admin' }),
      },
    );
    expect(promoted.status).toBe(200);
    expect(await promoted.json()).toMatchObject({
      person: {
        principalId: casey.principalId,
        group: 'admin',
        assigned: true,
      },
    });
    expect((await confirm()).status).toBe(200);
  });

  test('a group change the record cannot take is 503, and a non-person is 400; neither changes anyone', async () => {
    const harness = await createHarness();
    const casey = await pairPerson(harness, 'casey', ELEVATED);
    const put = (principalId: string) =>
      harness.request(
        `/api/pairing/people/${encodeURIComponent(principalId)}/group`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${harness.operatorCredential}`,
          },
          body: JSON.stringify({ group: 'admin' }),
        },
      );
    const invalid = await put('device:not-a-person');
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: 'invalid_principal' });

    // The record path is unusable (a directory sits there).
    const recordPath = join(harness.homeDir, 'security', 'station-groups.json');
    rmSync(recordPath, { force: true });
    mkdirSync(recordPath);
    const unavailable = await put(casey.principalId);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ error: 'groups_unavailable' });
    expect(harness.security.groupOf(casey.principalId)).toBe('member');
  });

  test("the desktop's local grant lists people but cannot change a group: that needs the operator credential", async () => {
    const harness = await createHarness();
    const casey = await pairPerson(harness, 'casey', ELEVATED);
    const mint = await harness.request(
      '/.well-known/station/v1/pairing/local-grant',
      harness.json({
        secret: harness.localGrantSecret(),
        deviceName: 'Desktop',
      }),
      '127.0.0.1',
    );
    const desktop = (await mint.json()) as { credential: string };
    const authorization = { Authorization: `Bearer ${desktop.credential}` };
    expect(
      (await harness.request('/api/pairing/people', { headers: authorization }))
        .status,
    ).toBe(200);
    const change = await harness.request(
      `/api/pairing/people/${encodeURIComponent(casey.principalId)}/group`,
      {
        method: 'PUT',
        headers: { ...authorization, 'Content-Type': 'application/json' },
        body: JSON.stringify({ group: 'admin' }),
      },
    );
    expect(change.status).toBe(401);
    expect(harness.security.groupOf(casey.principalId)).toBe('member');
  });

  test("a person's own device neither lists people nor changes a group", async () => {
    const harness = await createHarness();
    const casey = await pairPerson(harness, 'casey', ELEVATED);
    await harness.security.assignGroup(casey.principalId, 'admin');
    const listed = await harness.request('/api/pairing/people', {
      headers: { Authorization: `Bearer ${harness.operatorCredential}` },
    });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({
      people: [
        {
          principalId: casey.principalId,
          group: 'admin',
          devices: [{ id: casey.device.id, effectiveScope: ELEVATED }],
          canHoldTokens: true,
        },
      ],
    });

    await harness.security.assignGroup(casey.principalId, 'member');
    const devices = await harness.request('/api/pairing/devices', {
      headers: { Authorization: `Bearer ${harness.operatorCredential}` },
    });
    expect(
      ((await devices.json()) as { devices: PairedDevice[] }).devices.find(
        (device) => device.id === casey.device.id,
      ),
    ).toMatchObject({
      scope: ELEVATED,
      effectiveScope:
        'orchestration:read orchestration:operate terminal:operate',
    });
    await harness.security.assignGroup(casey.principalId, 'admin');

    // Casey's own Admin device may approve pairing requests, but never
    // change anyone's group: that is the operator's alone.
    for (const [method, path, body] of [
      ['GET', '/api/pairing/people', undefined],
      [
        'PUT',
        `/api/pairing/people/${encodeURIComponent(casey.principalId)}/group`,
        JSON.stringify({ group: 'admin' }),
      ],
    ] as const) {
      const refused = await harness.request(
        path,
        {
          ...cookieInit(casey.credential, method === 'GET' ? 'GET' : 'POST'),
          method,
          ...(body ? { body } : {}),
        },
        '203.0.113.62',
      );
      expect([401, 403], `${method} ${path}`).toContain(refused.status);
    }
    expect(harness.security.groupOf(casey.principalId)).toBe('admin');
  });
});

describe('#3557 personal access tokens at the HTTP boundary', () => {
  const STANDARD = 'orchestration:read orchestration:operate terminal:operate';
  const pairPerson = async (
    harness: Awaited<ReturnType<typeof createHarness>>,
    login: string,
    scope: string,
  ) => {
    const pairing = harness.security.devicePairing;
    const offer = pairing.createOffer({ endpoint: ORIGIN, scope });
    const request = pairing.requestPairing({
      requesterPosition: 'off-box',
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: `${login} phone`,
      source: 'tailnet',
      requester: { provider: 'tailscale-serve', login },
    });
    const principalId = `human:tailscale-serve:${login}`;
    pairing.confirmRequest(
      request.requestId,
      { kind: 'presented-credential' },
      { principalId, kind: 'verified-ingress' },
    );
    return {
      principalId,
      ...pairing.exchange({
        offerId: offer.offerId,
        proof: offer.challenge,
        requestId: request.requestId,
      }),
    };
  };
  const bearer = (credential: string, body?: unknown): RequestInit => ({
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${credential}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  test('a person mints a token from their own device; it reads as them and can do nothing more', async () => {
    const harness = await createHarness();
    const casey = await pairPerson(harness, 'casey', STANDARD);
    const minted = await harness.request(
      '/api/access/tokens',
      bearer(casey.credential, {
        name: 'CI',
        scope: 'orchestration:read orchestration:operate',
      }),
    );
    expect(minted.status).toBe(201);
    const { secret, token } = (await minted.json()) as {
      secret: string;
      token: { id: string; ownerPrincipalId: string };
    };
    expect(token.ownerPrincipalId).toBe(casey.principalId);

    expect(
      (await harness.request('/api/attention', bearer(secret))).status,
    ).toBe(200);
    // A token neither manages tokens nor reaches device management.
    expect(
      (await harness.request('/api/access/tokens', bearer(secret))).status,
    ).toBe(403);
    expect(
      [401, 403].includes(
        (await harness.request('/api/pairing/devices', bearer(secret))).status,
      ),
    ).toBe(true);

    // Never a Project's member administration, whatever its scope.
    const administer = await harness.request(
      '/api/projects/demo/access/invitations',
      bearer(secret, {}),
    );
    expect(administer.status).toBe(403);
    // The same person's device passes the boundary (the harness mounts no
    // Project routes behind it), so the 403 is the token's alone.
    expect(
      (
        await harness.request(
          '/api/projects/demo/access/invitations',
          bearer(casey.credential, {}),
        )
      ).status,
    ).not.toBe(403);

    const listed = await harness.request(
      '/api/access/tokens',
      bearer(casey.credential),
    );
    expect(await listed.json()).toMatchObject({
      tokens: [{ id: token.id, name: 'CI' }],
    });
    const revoked = await harness.request(`/api/access/tokens/${token.id}`, {
      ...bearer(casey.credential),
      method: 'DELETE',
    });
    expect(revoked.status).toBe(200);
    expect(
      (await harness.request('/api/attention', bearer(secret))).status,
    ).toBe(401);
  });

  test('a token never exceeds what the minting device may use, and only a device tied to a person mints', async () => {
    const harness = await createHarness();
    // A read-only device cannot reach the mint at all (it needs Operate);
    // a device that operates but cannot read cannot mint a reading token.
    const readOnly = await pairPerson(harness, 'erin', 'orchestration:read');
    expect(
      (
        await harness.request(
          '/api/access/tokens',
          bearer(readOnly.credential, {
            name: 'x',
            scope: 'orchestration:read',
          }),
        )
      ).status,
    ).toBe(403);
    const operateOnly = await pairPerson(
      harness,
      'dana',
      'orchestration:operate',
    );
    const exceeded = await harness.request(
      '/api/access/tokens',
      bearer(operateOnly.credential, {
        name: 'too much',
        scope: 'orchestration:read',
      }),
    );
    expect(exceeded.status).toBe(400);
    expect(await exceeded.json()).toEqual({
      error: { code: 'scope_exceeds_access' },
    });

    const mine = await harness.pairDevice('My phone');
    for (const credential of [mine.credential, harness.operatorCredential]) {
      const refused = await harness.request(
        '/api/access/tokens',
        bearer(credential, { name: 'x', scope: 'orchestration:read' }),
      );
      expect(refused.status).toBe(403);
    }
  });

  test('a read-only person revokes a token the operator made for them', async () => {
    const harness = await createHarness();
    const erin = await pairPerson(harness, 'erin', 'orchestration:read');
    const minted = await harness.request(
      `/api/pairing/people/${encodeURIComponent(erin.principalId)}/tokens`,
      bearer(harness.operatorCredential, {
        name: 'Ops',
        scope: 'orchestration:read',
      }),
    );
    expect(minted.status).toBe(201);
    const { secret, token } = (await minted.json()) as {
      secret: string;
      token: { id: string };
    };
    const revoked = await harness.request(`/api/access/tokens/${token.id}`, {
      ...bearer(erin.credential),
      method: 'DELETE',
    });
    expect(revoked.status).toBe(200);
    expect(harness.security.verifyCredential(secret)).toBe(false);
  });

  test('the operator mints for a person; the desktop local grant cannot', async () => {
    const harness = await createHarness();
    const casey = await pairPerson(harness, 'casey', STANDARD);
    const path = `/api/pairing/people/${encodeURIComponent(casey.principalId)}/tokens`;
    const minted = await harness.request(
      path,
      bearer(harness.operatorCredential, {
        name: 'Ops',
        scope: 'orchestration:read orchestration:operate',
        expiresInDays: 30,
      }),
    );
    expect(minted.status).toBe(201);
    const { secret } = (await minted.json()) as { secret: string };
    expect(harness.security.identifyDevice(secret)?.principalBinding).toEqual(
      casey.device.principalBinding,
    );

    // The token outlives Casey's last device; Casey stays listed with it.
    const operator = { Authorization: `Bearer ${harness.operatorCredential}` };
    expect(
      (
        await harness.request(`/api/pairing/devices/${casey.device.id}`, {
          method: 'DELETE',
          headers: operator,
        })
      ).status,
    ).toBe(200);
    expect(harness.security.verifyCredential(secret)).toBe(true);
    const people = (await (
      await harness.request('/api/pairing/people', { headers: operator })
    ).json()) as {
      people: { principalId: string; tokens: { name: string }[] }[];
    };
    expect(
      people.people.find((person) => person.principalId === casey.principalId),
    ).toMatchObject({ tokens: [{ name: 'Ops' }], canHoldTokens: false });

    const mint = await harness.request(
      '/.well-known/station/v1/pairing/local-grant',
      harness.json({
        secret: harness.localGrantSecret(),
        deviceName: 'Desktop',
      }),
      '127.0.0.1',
    );
    const desktop = (await mint.json()) as { credential: string };
    expect(
      (
        await harness.request(
          path,
          bearer(desktop.credential, {
            name: 'x',
            scope: 'orchestration:read',
          }),
        )
      ).status,
    ).toBe(401);
  });
});
