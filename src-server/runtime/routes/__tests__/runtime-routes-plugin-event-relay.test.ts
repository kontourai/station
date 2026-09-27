/**
 * #2067 through the REAL runtime composition: `configureRuntimeRoutes` mounts
 * the plugin-event gate on `/events`, so a paired collaborator's stream
 * relays a plugin frame only while the grant record says they may see it,
 * and relays nothing once that record cannot be read. The gate's own cases
 * live in plugin-event-relay.test.ts; this proves the runtime mounts it.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_GRANT_PAIRING_SCOPE } from '@kontourai/station-contracts/environment-security';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { PluginVisibilityService } from '../../../services/plugins/plugin-visibility-service.js';
import { DevicePairingService } from '../../../services/ssh/device-pairing-service.js';
import { configureRuntimeRoutes } from '../runtime-routes.js';

vi.mock('../runtime-route-support.js', () => {
  const stub = new Proxy({}, { get: () => () => undefined });
  return {
    configureRuntimeSupportServices: () => ({
      schedulerService: stub,
      notificationService: stub,
      attentionProjection: stub,
      webPushService: stub,
      webPushEnabled: false,
    }),
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

const LOOPBACK = {
  incoming: { socket: { remoteAddress: '127.0.0.1' } },
} as never;
const makeTempDir = trackTempDirs();

describe('configureRuntimeRoutes: /events relays plugin frames through the visibility gate', () => {
  const streams: AbortController[] = [];
  afterEach(() => {
    for (const stream of streams.splice(0)) stream.abort();
  });

  async function setup() {
    const homeDir = makeTempDir('station-plugin-event-relay-');
    mkdirSync(join(homeDir, 'security'), { mode: 0o700 });
    const pairing = new DevicePairingService({
      homeDir,
      environmentId: '44444444-4444-4444-8444-444444444444',
    });
    // A paired collaborator device: a non-operator subscriber, so every
    // plugin frame it receives had to pass the grant record.
    const offer = pairing.createOffer({
      endpoint: 'https://station.example.test',
      scope: DEFAULT_GRANT_PAIRING_SCOPE,
      kind: 'device',
    });
    const pairingRequest = pairing.requestPairing({
      requesterPosition: 'off-box',
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: 'collaborator fixture',
    });
    pairing.confirmRequest(pairingRequest.requestId, {
      kind: 'presented-credential',
    });
    const device = pairing.exchange({
      offerId: offer.offerId,
      proof: offer.challenge,
      requestId: pairingRequest.requestId,
    });
    const deviceId = pairing.identifyDevice(device.credential)!.id;
    const eventBus = new EventBus();
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
      eventBus,
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
          pairing.verifyCredential(credential),
        authorizeCredential: (credential: string) =>
          pairing.verifyCredential(credential),
        verifyOperatorCredential: () => false,
        resolveGrantedScope: (credential: string) =>
          pairing.identifyDevice(credential)?.scope,
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
    // The same record the runtime's own instance reads: one path per home.
    const visibility = new PluginVisibilityService(homeDir);
    await visibility.grant(
      humanPrincipal('device', deviceId, 'collaborator fixture').id,
      'notes',
    );
    return { app, credential: device.credential, eventBus, visibility };
  }

  /** Opens the stream and reads its frames as they arrive. */
  async function open(app: Hono, credential: string) {
    const controller = new AbortController();
    streams.push(controller);
    const response = await app.request(
      '/events',
      {
        headers: { Authorization: `Bearer ${credential}` },
        signal: controller.signal,
      },
      LOOPBACK,
    );
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    /** Everything received up to and including `marker`'s frame. */
    const readThrough = async (marker: string) => {
      while (!text.includes(marker)) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`stream ended before ${marker}`);
        text += decoder.decode(value, { stream: true });
      }
      return text;
    };
    return { readThrough };
  }

  test('a granted frame relays while the record reads, and nothing relays once it cannot', async () => {
    const { app, credential, eventBus, visibility } = await setup();
    const stream = await open(app, credential);
    // Frames are written in emit order, so a broadcast marker arriving
    // after a plugin frame proves that frame was dropped, not still queued.
    let markers = 0;
    const mark = () => {
      markers += 1;
      const marker = `relay-marker-${markers}`;
      eventBus.emit(SERVER_EVENTS.AGENTS_CHANGED, { marker });
      return marker;
    };

    // The control: the granted plugin reaches the collaborator, and one they
    // were not granted does not, so the gate is mounted and discriminating.
    eventBus.emit(SERVER_EVENTS.PLUGINS_INSTALLED, { name: 'hidden-notes' });
    eventBus.emit(SERVER_EVENTS.PLUGINS_INSTALLED, { name: 'notes' });
    const before = await stream.readThrough(mark());
    expect(before).toContain('"name":"notes"');
    expect(before).not.toContain('hidden-notes');

    writeFileSync(visibility.recordPath, '{"grants":');
    eventBus.emit(SERVER_EVENTS.PLUGINS_UPDATED, { name: 'notes' });
    const after = await stream.readThrough(mark());
    expect(after.slice(before.length)).not.toContain(
      SERVER_EVENTS.PLUGINS_UPDATED,
    );
  });
});
