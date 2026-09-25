/**
 * #2620 through the REAL runtime composition: `configureRuntimeRoutes` with
 * the real credential pipeline must hand notification delivery the SAME
 * focus the focus route records and a liveness check the event route's
 * stream leases feed — keyed by the same `X-Station-Client-Session`. Only
 * the support services are replaced, to capture what delivery is given.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_GRANT_PAIRING_SCOPE } from '@kontourai/station-contracts/environment-security';
import { FOCUS_PRESENCE_REPORT_PATH } from '@kontourai/station-contracts/presence';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../../services/identity/principal-resolver.js';
import type {
  FocusSource,
  InAppLiveness,
} from '../../../services/notifications/delivery/router.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { DevicePairingService } from '../../../services/ssh/device-pairing-service.js';
import { configureRuntimeRoutes } from '../runtime-routes.js';

const captured = vi.hoisted(() => ({
  options: undefined as
    | { focus?: FocusSource; inAppLiveness?: InAppLiveness }
    | undefined,
}));

vi.mock('../runtime-route-support.js', () => {
  const stub = new Proxy({}, { get: () => () => undefined });
  return {
    configureRuntimeSupportServices: (
      _context: unknown,
      _flowRunService: unknown,
      options: typeof captured.options,
    ) => {
      captured.options = options;
      return {
        schedulerService: stub,
        notificationService: stub,
        attentionProjection: stub,
        webPushService: stub,
        webPushEnabled: false,
      };
    },
    createRuntimeSystemRouteDeps: () => stub,
  };
});

/** Answers every unlisted member with an inert, non-thenable proxy. */
function deepStub<T extends object>(overrides: T): T {
  return new Proxy(overrides, {
    get(target, property) {
      if (property in target) return Reflect.get(target, property);
      const proxy: unknown = new Proxy(() => undefined, {
        get: (_target, property) => (property === 'then' ? undefined : proxy),
      });
      return proxy;
    },
  }) as T;
}

const OPERATOR_SECRET = 'operator-secret-notification-focus-fixture';
const TAB = '0f0e0d0c-0b0a-4908-8706-050403020100';
const OTHER_TAB = '11111111-1111-4111-8111-111111111111';
const LOOPBACK = {
  incoming: { socket: { remoteAddress: '127.0.0.1' } },
} as never;
const makeTempDir = trackTempDirs();

describe('configureRuntimeRoutes: focus and in-app liveness reach delivery', () => {
  const streams: AbortController[] = [];
  afterEach(() => {
    for (const stream of streams.splice(0)) stream.abort();
    captured.options = undefined;
  });

  async function setup() {
    const homeDir = makeTempDir('station-notification-focus-');
    mkdirSync(join(homeDir, 'security'), { mode: 0o700 });
    const pairing = new DevicePairingService({
      homeDir,
      environmentId: '33333333-3333-4333-8333-333333333333',
    });
    // A paired browser device, the way the local UI holds its credential.
    const offer = pairing.createOffer({
      endpoint: 'https://station.example.test',
      scope: DEFAULT_GRANT_PAIRING_SCOPE,
      kind: 'device',
    });
    const pairingRequest = pairing.requestPairing({
      requesterPosition: 'off-box',
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: 'browser fixture',
    });
    pairing.confirmRequest(pairingRequest.requestId, {
      kind: 'presented-credential',
    });
    const browser = pairing.exchange({
      offerId: offer.offerId,
      proof: offer.challenge,
      requestId: pairingRequest.requestId,
    });
    const app = new Hono();
    const context = deepStub({
      projectMembership: undefined,
      projectSharedTasks: undefined,
      deploymentAuthentication: undefined,
      localAccounts: undefined,
      applicationSessions: undefined,
      focusPresence: undefined,
      app,
      port: 4321,
      appConfig: {},
      eventBus: new EventBus(),
      acpBridge: { getStatus: () => ({ connections: [] }) },
      configLoader: {
        getProjectHomeDir: () => homeDir,
        loadAppConfig: () => ({}),
      },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      activeAgents: new Map(),
      agentService: { listAgents: () => [] },
      agentMetadataMap: new Map(),
      agentFixedTokens: new Map(),
      agentTools: new Map(),
      agentStats: new Map(),
      agentStatus: new Map(),
      memoryAdapters: new Map(),
      metricsLog: [],
      monitoringEvents: [],
      orchestrationEventStore: deepStub({
        sessionTurnBoundaryAuthority: () => ({
          reconcile: () => ({ kind: 'available', interrupted: [] }),
        }),
      }),
      taskGraphService: { listTasks: () => [] },
      projectService: { listProjects: () => [] },
      environmentSecurityService: deepStub({
        verifyCredential: (credential: string) =>
          credential === OPERATOR_SECRET ||
          pairing.verifyCredential(credential),
        authorizeCredential: (credential: string) =>
          credential === OPERATOR_SECRET ||
          pairing.verifyCredential(credential),
        verifyOperatorCredential: (credential: string) =>
          credential === OPERATOR_SECRET,
        resolveGrantedScope: (credential: string) =>
          credential === OPERATOR_SECRET
            ? DEFAULT_GRANT_PAIRING_SCOPE
            : pairing.identifyDevice(credential)?.scope,
        identifyDevice: (credential: string) =>
          pairing.identifyDevice(credential),
        credentialLocality: (credential: string) =>
          pairing.credentialLocality(credential),
        credentialMintKind: (credential: string) =>
          pairing.credentialMintKind(credential),
        devicePairing: pairing,
      }),
    });
    Reflect.set(context as object, 'buildRuntimeContext', () => context);
    const result = configureRuntimeRoutes(
      context as unknown as Parameters<typeof configureRuntimeRoutes>[0],
    );
    await result.kitLifecycleReady;
    const delivery = captured.options;
    expect(delivery?.focus).toBeDefined();
    expect(delivery?.inAppLiveness).toBeDefined();
    return {
      app,
      browser,
      browserDeviceId: pairing.identifyDevice(browser.credential)!.id,
      focus: delivery!.focus!,
      liveness: delivery!.inAppLiveness!,
    };
  }

  const operatorHeaders = {
    Authorization: `Bearer ${OPERATOR_SECRET}`,
    'X-Station-Client-Session': TAB,
  };

  test("the operator tab's focus report and its event stream land on the surface delivery reads", async () => {
    const { app, focus, liveness } = await setup();
    const surface = `local:${TAB}` as const;
    expect(liveness.isLive(surface)).toBe(false);

    const controller = new AbortController();
    streams.push(controller);
    const stream = await app.request(
      '/events',
      { headers: operatorHeaders, signal: controller.signal },
      LOOPBACK,
    );
    expect(stream.status).toBe(200);
    await vi.waitFor(() => expect(liveness.isLive(surface)).toBe(true));

    const report = await app.request(
      FOCUS_PRESENCE_REPORT_PATH,
      {
        method: 'POST',
        headers: { ...operatorHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({
          clientSessionId: TAB,
          state: 'focused',
          seq: 1,
        }),
      },
      LOOPBACK,
    );
    expect(report.status).toBe(204);
    expect(
      focus.snapshotForPrincipals([LOCAL_OPERATOR_PRINCIPAL_ID]).get(surface),
    ).toMatchObject({
      state: 'focused',
      principalId: LOCAL_OPERATOR_PRINCIPAL_ID,
    });

    controller.abort();
    await vi.waitFor(() => expect(liveness.isLive(surface)).toBe(false));
    // Focus outlives the stream; liveness is what stops it quieting anyone.
    expect(
      focus.snapshotForPrincipals([LOCAL_OPERATOR_PRINCIPAL_ID]).has(surface),
    ).toBe(true);
  });

  test("a browser device: only the FOCUSED document's own stream makes it live", async () => {
    const { app, browser, browserDeviceId, liveness } = await setup();
    const surface = `device:${browserDeviceId}` as const;
    const headers = (document: string) => ({
      Authorization: `Bearer ${browser.credential}`,
      'X-Station-Client-Session': document,
    });
    const open = async (document: string) => {
      const controller = new AbortController();
      streams.push(controller);
      const response = await app.request(
        '/events',
        { headers: headers(document), signal: controller.signal },
        LOOPBACK,
      );
      expect(response.status).toBe(200);
      return controller;
    };
    let seq = 0;
    const report = async (document: string, state: string) => {
      seq += 1;
      const response = await app.request(
        FOCUS_PRESENCE_REPORT_PATH,
        {
          method: 'POST',
          headers: { ...headers(document), 'content-type': 'application/json' },
          body: JSON.stringify({ clientSessionId: document, state, seq }),
        },
        LOOPBACK,
      );
      expect(response.status).toBe(204);
    };

    // A background document of the browser holds a stream; the focused one
    // does not.
    await report(OTHER_TAB, 'hidden');
    await open(OTHER_TAB);
    await report(TAB, 'focused');
    // The stream's lease is taken before its headers are sent, so it is
    // already held here.
    expect(liveness.isLive(surface)).toBe(false);

    // The focused document opens its own stream (uppercase on the wire).
    const focused = await open(TAB.toUpperCase());
    await vi.waitFor(() => expect(liveness.isLive(surface)).toBe(true));
    focused.abort();
    await vi.waitFor(() => expect(liveness.isLive(surface)).toBe(false));
  });
});
