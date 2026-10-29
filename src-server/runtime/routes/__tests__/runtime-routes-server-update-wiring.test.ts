/**
 * #3851 review F10, through the REAL runtime composition
 * (`configureRuntimeRoutes`):
 * - `GET /api/system/core-update/running-turns` lists running turns only as
 *   far as the CALLER may read them: two paired devices, each running a
 *   turn, see their own title and a count of the other's.
 * - opening `/events` reports the client's build to the server update
 *   coordinator, the trigger for a newer-client check.
 * - the coordinator's bus subscription is the runtime's real event bus, so
 *   a settings save (`config:changed`) reaches its policy re-evaluation.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CLIENT_ORIGIN_HEADER } from '@kontourai/station-contracts/client-origin';
import { DEFAULT_GRANT_PAIRING_SCOPE } from '@kontourai/station-contracts/environment-security';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import type { SessionReadAuthority } from '@kontourai/station-contracts/tenancy';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { ServerUpdateCoordinator } from '../../../services/server-update/server-update-coordinator.js';
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
    createRuntimeSystemRouteDeps: () => ({}),
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

function pairDevice(pairing: DevicePairingService, name: string) {
  const offer = pairing.createOffer({
    endpoint: 'https://station.example.test',
    scope: DEFAULT_GRANT_PAIRING_SCOPE,
    kind: 'device',
  });
  const request = pairing.requestPairing({
    requesterPosition: 'off-box',
    offerId: offer.offerId,
    proof: offer.challenge,
    deviceName: name,
  });
  pairing.confirmRequest(request.requestId, { kind: 'presented-credential' });
  const device = pairing.exchange({
    offerId: offer.offerId,
    proof: offer.challenge,
    requestId: request.requestId,
  });
  return {
    credential: device.credential,
    // The owner a session started on this device records.
    owner: `human:device:${pairing.identifyDevice(device.credential)!.id}`,
  };
}

describe('configureRuntimeRoutes: the server update seams (#3851 F10)', () => {
  const streams: AbortController[] = [];
  afterEach(() => {
    for (const stream of streams.splice(0)) stream.abort();
    vi.restoreAllMocks();
  });

  async function setup() {
    const homeDir = makeTempDir('station-server-update-wiring-');
    mkdirSync(join(homeDir, 'security'), { mode: 0o700 });
    const pairing = new DevicePairingService({
      homeDir,
      environmentId: '55555555-5555-4555-8555-555555555555',
    });
    const phone = pairDevice(pairing, 'phone fixture');
    const laptop = pairDevice(pairing, 'laptop fixture');
    // Both run a turn; each session is owned by its device.
    const sessions = [
      {
        threadId: 'phone-session',
        owner: phone.owner,
        displayTitle: 'Phone task',
        provider: 'codex',
        hasActiveTurn: true,
      },
      {
        threadId: 'laptop-session',
        owner: laptop.owner,
        displayTitle: 'Laptop task',
        provider: 'claude',
        hasActiveTurn: true,
      },
    ];
    const readAuthorities: string[] = [];
    const orchestrationService = deepStub({
      // Scoped exactly as the real read model scopes: by the authority's
      // user; the internal aggregate scope reads everything.
      listSessionReadModel: async (
        authority: SessionReadAuthority | { kind: string },
        options?: { threadIds?: readonly string[] },
      ) => {
        const userId = 'userId' in authority ? authority.userId : null;
        readAuthorities.push(userId ?? 'internal');
        return sessions
          .filter((session) => userId === null || session.owner === userId)
          .filter(
            (session) =>
              !options?.threadIds ||
              options.threadIds.includes(session.threadId),
          );
      },
      // A webhook's ephemeral session runs a turn too: the read model never
      // lists it, the restart still stops it (review round 2 item 4).
      listActiveTurnThreadIds: () => [
        ...sessions.map((session) => session.threadId),
        'webhook-session',
      ],
    });
    const app = new Hono();
    const eventBus = new EventBus();
    const context = deepStub({
      projectMembership: undefined,
      projectSharedTasks: undefined,
      deploymentAuthentication: undefined,
      localAccounts: undefined,
      applicationSessions: undefined,
      focusPresence: undefined,
      app,
      port: 4322,
      appConfig: {},
      eventBus,
      orchestrationService,
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
    const noted = vi.spyOn(
      ServerUpdateCoordinator.prototype,
      'noteClientBuild',
    );
    const result = configureRuntimeRoutes(
      context as unknown as Parameters<typeof configureRuntimeRoutes>[0],
    );
    await result.kitLifecycleReady;
    result.serverUpdate.stop();
    return {
      app,
      phone,
      laptop,
      readAuthorities,
      noted,
      eventBus,
      serverUpdate: result.serverUpdate,
    };
  }

  test('each caller sees its own running turn and only a count of the rest, an ephemeral one included', async () => {
    const { app, phone, laptop, readAuthorities } = await setup();
    const turnsFor = async (credential: string) => {
      const response = await app.request(
        '/api/system/core-update/running-turns',
        { headers: { Authorization: `Bearer ${credential}` } },
        LOOPBACK,
      );
      expect(response.status).toBe(200);
      return (await response.json()) as {
        turns: Array<{ title: string | null; engine: string }>;
        hiddenCount: number;
      };
    };
    expect(await turnsFor(phone.credential)).toEqual({
      turns: [
        expect.objectContaining({ title: 'Phone task', engine: 'codex' }),
      ],
      hiddenCount: 2,
    });
    expect(await turnsFor(laptop.credential)).toEqual({
      turns: [
        expect.objectContaining({ title: 'Laptop task', engine: 'claude' }),
      ],
      hiddenCount: 2,
    });
    // The titles were read with each caller's own authority.
    expect(readAuthorities).toContain(phone.owner);
    expect(readAuthorities).toContain(laptop.owner);
  });

  test('opening /events reports the client’s build to the update coordinator', async () => {
    const { app, phone, noted } = await setup();
    const controller = new AbortController();
    streams.push(controller);
    const response = await app.request(
      '/events',
      {
        headers: {
          Authorization: `Bearer ${phone.credential}`,
          'X-Station-Client-Session': 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
          [CLIENT_ORIGIN_HEADER]: '1;web;9.9.9+abcdef0',
        },
        signal: controller.signal,
      },
      LOOPBACK,
    );
    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(noted).toHaveBeenCalledWith('9.9.9+abcdef0'));
  });

  test('a settings save on the runtime bus reaches the coordinator’s policy re-evaluation', async () => {
    const { eventBus, serverUpdate } = await setup();
    // This fixture is no launcher-run archive, so start() subscribes nothing
    // (only a launcher-run server listens). Make the subscription start()
    // would make, through the deps the runtime composed, and route it the
    // way start() does: what is under test is that those deps reach the
    // runtime's bus and that a config event is one the coordinator acts on.
    const deps = Reflect.get(serverUpdate, 'deps') as {
      subscribe?: (
        listener: (message: {
          event: string;
          data?: Record<string, unknown>;
        }) => void,
      ) => () => void;
    };
    const onBusEvent = Reflect.get(serverUpdate, 'onBusEvent') as (message: {
      event: string;
      data?: Record<string, unknown>;
    }) => void;
    const settingsChanged = vi
      .spyOn(serverUpdate, 'settingsChanged')
      .mockResolvedValue(undefined);
    expect(deps.subscribe).toBeTypeOf('function');
    const unsubscribe = deps.subscribe!((message) =>
      onBusEvent.call(serverUpdate, message),
    );
    eventBus.emit(SERVER_EVENTS.AGENTS_CHANGED, {});
    expect(settingsChanged).not.toHaveBeenCalled();
    // The literal the config routes emit (src-server/routes/system/config.ts).
    expect(SERVER_EVENTS.CONFIG_CHANGED).toBe('config:changed');
    eventBus.emit(SERVER_EVENTS.CONFIG_CHANGED, { source: 'config' });
    expect(settingsChanged).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});
