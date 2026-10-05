import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type HttpBindings } from '@hono/node-server';
import {
  type DevicePairingOffer,
  type DevicePairingRequest,
  type PairedDevice,
  PUBLIC_DEVICE_PAIRING_LOCAL_GRANT_PATH,
} from '@kontourai/station-contracts';
import { Hono } from 'hono';
import { describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { reportOperatorCredentialUse } from '../../security/host-operator-credential.js';
import { isRuntimeRequestPrincipalCurrent } from '../../security/runtime-request-security.js';
import type { EventBus } from '../../services/orchestration/event-bus.js';
import { EnvironmentSecurityService } from '../../services/ssh/environment-security-service.js';
import {
  getInternalApiToken,
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_PROXY_CALLER_HEADER,
  INTERNAL_PROXY_CLIENT_FORWARDED_HEADER,
  INTERNAL_PROXY_FORWARDED_HOST_HEADER,
  INTERNAL_PROXY_PEER_HEADER,
} from '../../utils/internal-api-token.js';
import type { Logger } from '../../utils/logger.js';
import { configureRuntimeHttp } from '../bootstrap/runtime-http.js';
import {
  configureDevicePairingHostRoutes,
  configureDevicePairingPublicRoutes,
  type OperatorCredentialUseRecord,
} from '../routes/runtime-routes.js';

/**
 * #2894 S1 (owner decision D2, observe first). The device-admin routes will
 * accept the raw operator credential only from this Station's host. Before
 * that refusal ships, each route records every operator-credential use with
 * its host position, and still allows it.
 *
 * Runs the real boundary: a real `EnvironmentSecurityService` (so the
 * local-grant read exception in `authorizeCredential` is the production one),
 * the real middleware, and the real pairing routes, wired as
 * `configureRuntimeRoutes` wires them.
 */
const ORIGIN = 'https://station.example.test';
const LOOPBACK = '127.0.0.1';
const REMOTE_PEER = '100.96.12.7';
const LOOPBACK_HOST = '127.0.0.1:3241';
const makeTempDir = trackTempDirs();

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
  observe: (record: OperatorCredentialUseRecord) => void = () => {},
) {
  const homeDir = makeTempDir('station-operator-host-');
  const security = new EnvironmentSecurityService({ homeDir });
  const { credential: operatorCredential } = await security.initialize();
  const secretPath = join(homeDir, 'runtime', 'local-grant.secret');
  const observed: OperatorCredentialUseRecord[] = [];

  const app = new Hono<{ Bindings: TestBindings }>();
  configureDevicePairingPublicRoutes(app as never, security.devicePairing, {
    allowedOrigins: [ORIGIN],
    localGrant: { secretPath },
  });
  configureRuntimeHttp({
    app: app as never,
    logger,
    eventBus: { emit: vi.fn() } as unknown as EventBus,
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
        security.devicePairing.credentialLocality(credential),
      resolveCredentialMintKind: (credential) =>
        security.devicePairing.credentialMintKind(credential),
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
    observeOperatorCredentialUse: (record) => {
      observed.push(record);
      observe(record);
    },
  });

  /** One caller position: socket peer plus the headers that hop sets. */
  const call = (
    path: string,
    init: RequestInit,
    position: { peer: string; headers?: Record<string, string> },
  ) =>
    app.request(
      path,
      {
        ...init,
        headers: {
          ...(init.headers as Record<string, string> | undefined),
          ...position.headers,
        },
      },
      {
        incoming: { socket: { remoteAddress: position.peer } },
      } as TestBindings,
    );

  const bearer = (credential: string) => ({
    Authorization: `Bearer ${credential}`,
  });

  async function pairDevice(name: string) {
    const host = { peer: LOOPBACK, headers: { host: LOOPBACK_HOST } };
    const offer = (await (
      await call(
        '/api/pairing/offers',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...bearer(operatorCredential),
          },
          body: JSON.stringify({ endpoint: ORIGIN }),
        },
        host,
      )
    ).json()) as DevicePairingOffer;
    const pending = (await (
      await call(
        '/.well-known/station/v1/pairing/request',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            deviceName: name,
            offerId: offer.offerId,
            proof: offer.challenge,
          }),
        },
        { peer: REMOTE_PEER },
      )
    ).json()) as DevicePairingRequest;
    const confirmed = await call(
      `/api/pairing/requests/${pending.requestId}/confirm`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...bearer(operatorCredential),
        },
        body: '{}',
      },
      host,
    );
    expect(confirmed.status).toBe(200);
    const exchange = await call(
      '/.well-known/station/v1/pairing/exchange',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          offerId: offer.offerId,
          proof: offer.challenge,
          requestId: pending.requestId,
        }),
      },
      { peer: REMOTE_PEER },
    );
    expect(exchange.status).toBe(200);
    return (await exchange.json()) as {
      device: PairedDevice;
      credential: string;
    };
  }

  /**
   * The desktop app's exchange, byte for byte what
   * `station_local_self_provision` POSTs (`src-desktop/src/lib.rs`): the
   * per-boot secret over a direct loopback socket. The credential it returns
   * is what the native HTTP broker then attaches as the bearer for every
   * request the desktop panel makes.
   */
  async function desktopLocalGrant() {
    const response = await call(
      PUBLIC_DEVICE_PAIRING_LOCAL_GRANT_PATH,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          secret: readFileSync(secretPath, 'utf8').trim(),
          deviceName: 'This Mac',
          // The desktop mints and reuses a UUID per local profile.
          clientInstanceId: randomUUID(),
        }),
      },
      { peer: LOOPBACK, headers: { host: LOOPBACK_HOST } },
    );
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      device: PairedDevice;
      credential: string;
    };
    expect(security.devicePairing.credentialMintKind(result.credential)).toBe(
      'local-grant',
    );
    return result;
  }

  return {
    security,
    operatorCredential,
    observed,
    call,
    bearer,
    pairDevice,
    desktopLocalGrant,
  };
}

/** Caller positions, each the exact header set its real hop produces. */
const positions = {
  /** `station environment access ...` on the host (`openLocalOperatorChannel`). */
  hostCli: { peer: LOOPBACK, headers: { host: LOOPBACK_HOST } },
  /** A browser on this machine through Station's own UI proxy. */
  hostBrowserViaUiProxy: () => ({
    peer: LOOPBACK,
    headers: {
      host: LOOPBACK_HOST,
      [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
      [INTERNAL_PROXY_CALLER_HEADER]: 'remote',
      [INTERNAL_PROXY_PEER_HEADER]: LOOPBACK,
      [INTERNAL_PROXY_FORWARDED_HOST_HEADER]: 'localhost:3000',
    },
  }),
  /** A paired phone through the same UI proxy. */
  remoteBrowserViaUiProxy: () => ({
    peer: LOOPBACK,
    headers: {
      host: LOOPBACK_HOST,
      [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
      [INTERNAL_PROXY_CALLER_HEADER]: 'remote',
      [INTERNAL_PROXY_PEER_HEADER]: REMOTE_PEER,
      [INTERNAL_PROXY_FORWARDED_HOST_HEADER]: 'station.example.ts.net',
    },
  }),
  /** A tailnet or LAN peer dialling the API port directly. */
  remotePeer: {
    peer: REMOTE_PEER,
    headers: { host: 'station.example.ts.net:3241' },
  },
  /**
   * `tailscale serve` pointed straight at the API port, with no trusted
   * origin configured: loopback socket, no proxy headers, tailnet Host.
   */
  tailscaleServeDirect: {
    peer: LOOPBACK,
    headers: { host: 'station.example.ts.net' },
  },
  /** A direct loopback socket carrying a proxy token this host never issued. */
  forgedProxyToken: {
    peer: LOOPBACK,
    headers: {
      host: LOOPBACK_HOST,
      [INTERNAL_API_TOKEN_HEADER]: 'not-the-per-boot-token',
    },
  },
  /**
   * A remote client re-dialled onto loopback by a same-host forwarder that
   * keeps a loopback Host but adds its forwarding header (#2894 review).
   */
  forwardedFor: (name: string, value: string) => ({
    peer: LOOPBACK,
    headers: { host: LOOPBACK_HOST, [name]: value },
  }),
  /**
   * The UI proxy's client was itself a forwarder (for example Tailscale
   * Serve on the UI port, whose `tailscale-*` headers the proxy strips), and
   * the client chose a loopback Host: the proxy's marker decides.
   */
  remoteBehindUiProxyWithLoopbackHost: () => ({
    peer: LOOPBACK,
    headers: {
      host: LOOPBACK_HOST,
      [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
      [INTERNAL_PROXY_CALLER_HEADER]: 'remote',
      [INTERNAL_PROXY_PEER_HEADER]: LOOPBACK,
      [INTERNAL_PROXY_FORWARDED_HOST_HEADER]: 'localhost:3000',
      [INTERNAL_PROXY_CLIENT_FORWARDED_HEADER]: '1',
    },
  }),
};

describe('device-admin routes observe raw operator-credential position (#2894 S1)', () => {
  /**
   * The residual, pinned so nobody reads S1's position as authority: a
   * same-host forwarder that strips forwarding headers and keeps a loopback
   * Host is byte-identical to the host CLI. S1b must refuse on proof of a
   * host-only secret, never on this position.
   */
  test('a forwarder that strips forwarding headers is indistinguishable from the host CLI', async () => {
    const harness = await createHarness();
    const target = await harness.pairDevice('Phone');
    harness.observed.length = 0;
    const remoteRedialledByStrippingProxy = {
      peer: LOOPBACK,
      headers: { host: LOOPBACK_HOST },
    };

    const response = await harness.call(
      `/api/pairing/devices/${target.device.id}/scope`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...harness.bearer(harness.operatorCredential),
        },
        body: JSON.stringify({ scope: ['orchestration:read'] }),
      },
      remoteRedialledByStrippingProxy,
    );

    expect(response.status).toBe(200);
    expect(harness.observed.map(({ position }) => position)).toEqual([
      'host-direct',
    ]);
  });

  test('an observer that throws neither fails the request nor blocks the change', async () => {
    const harness = await createHarness(() => {
      throw new Error('telemetry sink down');
    });
    const target = await harness.pairDevice('Phone');

    const response = await harness.call(
      `/api/pairing/devices/${target.device.id}/scope`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...harness.bearer(harness.operatorCredential),
        },
        body: JSON.stringify({ scope: ['orchestration:read'] }),
      },
      positions.remotePeer,
    );

    expect(response.status).toBe(200);
    expect(
      harness.security.devicePairing.identifyDevice(target.credential)?.scope,
    ).toBe('orchestration:read');
    // The observer was reached, so the throw came from inside it.
    expect(harness.observed).toHaveLength(1);
  });

  test.each([
    ['the host CLI', 'host-direct', positions.hostCli, true],
    [
      'a host browser through the UI proxy',
      'host-ui-proxy',
      positions.hostBrowserViaUiProxy(),
      true,
    ],
    ['a remote peer', 'off-host', positions.remotePeer, false],
    [
      'a remote browser through the UI proxy',
      'off-host',
      positions.remoteBrowserViaUiProxy(),
      false,
    ],
    [
      'tailscale serve straight at the API',
      'off-host',
      positions.tailscaleServeDirect,
      false,
    ],
    ['a forged proxy token', 'off-host', positions.forgedProxyToken, false],
    [
      'a loopback re-dial carrying x-forwarded-for',
      'off-host',
      positions.forwardedFor('x-forwarded-for', REMOTE_PEER),
      false,
    ],
    [
      'a loopback re-dial carrying forwarded',
      'off-host',
      positions.forwardedFor('forwarded', `for=${REMOTE_PEER}`),
      false,
    ],
    [
      'a loopback re-dial carrying x-forwarded-host',
      'off-host',
      positions.forwardedFor('x-forwarded-host', 'station.example.ts.net'),
      false,
    ],
    [
      'a loopback re-dial carrying x-real-ip',
      'off-host',
      positions.forwardedFor('x-real-ip', REMOTE_PEER),
      false,
    ],
    [
      'a loopback re-dial carrying a tailscale header',
      'off-host',
      positions.forwardedFor('tailscale-user-login', 'someone@example.test'),
      false,
    ],
    [
      'a forwarder in front of the UI proxy with a loopback Host',
      'off-host',
      positions.remoteBehindUiProxyWithLoopbackHost(),
      false,
    ],
  ] as const)(
    '%s: the scope change applies and is recorded as %s',
    async (_label, expected, position, hostLocal) => {
      const harness = await createHarness();
      const target = await harness.pairDevice('Phone');
      harness.observed.length = 0;

      const response = await harness.call(
        `/api/pairing/devices/${target.device.id}/scope`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...harness.bearer(harness.operatorCredential),
          },
          body: JSON.stringify({ scope: ['orchestration:read'] }),
        },
        position,
      );

      // Observe, do not refuse: an off-host use still applies in S1.
      expect(response.status).toBe(200);
      expect(
        harness.security.devicePairing.identifyDevice(target.credential)?.scope,
      ).toBe('orchestration:read');
      expect(harness.observed).toEqual([
        {
          event: 'station.pairing.operator_credential_used',
          route: 'POST /api/pairing/devices/:deviceId/scope',
          position: expected,
          hostLocal,
          offHostUses: hostLocal ? 0 : 1,
          timestamp: expect.any(Number),
        },
      ]);
    },
  );

  test('every device-admin route records an off-host use, and the count accumulates', async () => {
    const harness = await createHarness();
    const target = await harness.pairDevice('Laptop');
    harness.observed.length = 0;
    const operator = harness.bearer(harness.operatorCredential);

    const list = await harness.call(
      '/api/pairing/devices',
      { headers: operator },
      positions.remotePeer,
    );
    expect(list.status).toBe(200);
    const revoke = await harness.call(
      `/api/pairing/devices/${target.device.id}`,
      { method: 'DELETE', headers: operator },
      positions.remotePeer,
    );
    expect(revoke.status).toBe(200);
    const remove = await harness.call(
      `/api/pairing/devices/${target.device.id}/record`,
      { method: 'DELETE', headers: operator },
      positions.remotePeer,
    );
    expect(remove.status).toBe(200);
    // A host use in between is recorded but does not advance the count.
    const hostList = await harness.call(
      '/api/pairing/devices',
      { headers: operator },
      positions.hostCli,
    );
    expect(hostList.status).toBe(200);

    expect(
      harness.observed.map(({ route, hostLocal, offHostUses }) => ({
        route,
        hostLocal,
        offHostUses,
      })),
    ).toEqual([
      { route: 'GET /api/pairing/devices', hostLocal: false, offHostUses: 1 },
      {
        route: 'DELETE /api/pairing/devices/:deviceId',
        hostLocal: false,
        offHostUses: 2,
      },
      {
        route: 'DELETE /api/pairing/devices/:deviceId/record',
        hostLocal: false,
        offHostUses: 3,
      },
      { route: 'GET /api/pairing/devices', hostLocal: true, offHostUses: 3 },
    ]);
  });

  /**
   * The draft's open question (section 1): which credential does the host
   * desktop app present to these routes? `station_local_self_provision`
   * stores the local-grant-minted DEVICE credential in the keychain, and the
   * native HTTP broker attaches the active profile's keychain credential as
   * the bearer on every request (`src-desktop/src/lib.rs`). The desktop
   * never reads the operator credential. That credential resolves to
   * `device-credential` authority, so today the desktop app can LIST
   * devices (the local-grant read exception in `authorizeCredential`) but
   * cannot change a scope, revoke, or remove a record. This pins that
   * truth, and that none of it is counted as an operator-credential use.
   */
  test('the desktop local-grant credential lists devices but cannot administer them, and is never an operator-credential use', async () => {
    const harness = await createHarness();
    const target = await harness.pairDevice('Tablet');
    const desktop = await harness.desktopLocalGrant();
    harness.observed.length = 0;
    const asDesktop = harness.bearer(desktop.credential);

    const list = await harness.call(
      '/api/pairing/devices',
      { headers: asDesktop },
      positions.hostCli,
    );
    expect(list.status).toBe(200);
    const scope = await harness.call(
      `/api/pairing/devices/${target.device.id}/scope`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...asDesktop },
        body: JSON.stringify({ scope: ['orchestration:read'] }),
      },
      positions.hostCli,
    );
    expect(scope.status).toBe(401);
    expect(await scope.json()).toEqual({ error: 'authentication_required' });
    const revoke = await harness.call(
      `/api/pairing/devices/${target.device.id}`,
      { method: 'DELETE', headers: asDesktop },
      positions.hostCli,
    );
    expect(revoke.status).toBe(401);
    expect(
      harness.security.devicePairing.identifyDevice(target.credential)?.scope,
    ).toBe(target.device.scope);
    expect(harness.observed).toEqual([]);
  });

  test.each([
    ['from the host', positions.hostCli],
    ['from a remote peer', positions.remotePeer],
  ] as const)(
    'an ordinary paired device is refused on every device-admin route %s',
    async (_label, position) => {
      const harness = await createHarness();
      const target = await harness.pairDevice('Phone');
      const other = await harness.pairDevice('Other phone');
      harness.observed.length = 0;
      const asDevice = harness.bearer(other.credential);

      const answers = [
        await harness.call(
          '/api/pairing/devices',
          { headers: asDevice },
          position,
        ),
        await harness.call(
          `/api/pairing/devices/${target.device.id}/scope`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...asDevice },
            body: JSON.stringify({ scope: ['orchestration:read'] }),
          },
          position,
        ),
        await harness.call(
          `/api/pairing/devices/${target.device.id}`,
          { method: 'DELETE', headers: asDevice },
          position,
        ),
        await harness.call(
          `/api/pairing/devices/${target.device.id}/record`,
          { method: 'DELETE', headers: asDevice },
          position,
        ),
      ];
      // A recognized device credential refused admission on the pairing
      // family is 403, not 401 (the draft's NOT VERIFIED status question).
      expect(answers.map((answer) => answer.status)).toEqual([
        403, 403, 403, 403,
      ]);
      expect(
        harness.security.devicePairing.identifyDevice(target.credential)?.scope,
      ).toBe(target.device.scope);
      expect(harness.observed).toEqual([]);
    },
  );
});

describe('reportOperatorCredentialUse, the production sink (#2894 S1)', () => {
  const record = (
    position: OperatorCredentialUseRecord['position'],
    hostLocal: boolean,
  ): OperatorCredentialUseRecord => ({
    event: 'station.pairing.operator_credential_used',
    route: 'POST /api/pairing/devices/:deviceId/scope',
    position,
    hostLocal,
    offHostUses: hostLocal ? 0 : 4,
    timestamp: 1_700_000_000_000,
  });

  test('counts every use by route and position, and warns only on an off-host use', () => {
    const add = vi.fn();
    const warn = vi.fn();
    const sinks = { counter: { add }, logger: { warn } };

    reportOperatorCredentialUse(record('host-direct', true), sinks);
    reportOperatorCredentialUse(record('host-ui-proxy', true), sinks);
    reportOperatorCredentialUse(record('off-host', false), sinks);

    expect(add.mock.calls).toEqual([
      [
        1,
        {
          route: 'POST /api/pairing/devices/:deviceId/scope',
          position: 'host-direct',
        },
      ],
      [
        1,
        {
          route: 'POST /api/pairing/devices/:deviceId/scope',
          position: 'host-ui-proxy',
        },
      ],
      [
        1,
        {
          route: 'POST /api/pairing/devices/:deviceId/scope',
          position: 'off-host',
        },
      ],
    ]);
    expect(warn.mock.calls).toEqual([
      [
        'Operator credential used off-host for device administration',
        record('off-host', false),
      ],
    ]);
  });
});
