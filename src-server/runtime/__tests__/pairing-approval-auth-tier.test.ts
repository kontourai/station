import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
      allowedOrigins: [ORIGIN],
    },
  });
  configureDevicePairingHostRoutes(app as never, security.devicePairing, {
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

  configure?.(app, security);
  return {
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
  // Browser launcher grants also prove home possession, but were not minted
  // as desktop local grants and must not acquire pairing administration.
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
  const browserCookie = browser.headers.get('set-cookie')!.split(';')[0];
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
  ).toBe(403);
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
