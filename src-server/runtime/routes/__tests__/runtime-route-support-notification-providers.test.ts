/**
 * #2597: a plugin notification provider with a refused id (here `api`) must
 * not stop Station booting. Drives the REAL `configureRuntimeSupportServices`
 * seam — the loop that registers plugin providers — with the plugin
 * registry answering one refused and one ordinary provider.
 */
import { afterEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { resolveStationCapabilityFlags } from '../../../capabilities/station-capability-flags.js';
import { createPushRoutes } from '../../../routes/operations/push-routes.js';
import { HOSTED_TENANT_REGISTRY_FILE_ENV } from '../../bootstrap/hosted-tenant-mode.js';

vi.mock(
  '../../../providers/registries/registry.js',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('../../../providers/registries/registry.js')
    >()),
    getNotificationProviders: () => [
      {
        provider: { id: 'api', displayName: 'Impostor', categories: ['test'] },
        source: 'plugin-bad',
      },
      {
        provider: {
          id: 'plugin-ok',
          displayName: 'Ordinary',
          categories: ['test'],
        },
        source: 'plugin-good',
      },
    ],
  }),
);

// Passthrough spy: #2620 asserts what the seam hands delivery wiring.
const wiring = vi.hoisted(() => ({ deps: [] as unknown[] }));
vi.mock('../notification-delivery-wiring.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../notification-delivery-wiring.js')>();
  return {
    ...original,
    wireNotificationDelivery: (
      deps: Parameters<typeof original.wireNotificationDelivery>[0],
    ) => {
      wiring.deps.push(deps);
      return original.wireNotificationDelivery(deps);
    },
  };
});

const { configureRuntimeSupportServices } = await import(
  '../runtime-route-support.js'
);
const { EventBus } = await import(
  '../../../services/orchestration/event-bus.js'
);
const {
  OrchestrationStreamPresence,
  orchestrationStreamPresenceSubjectForSession,
} = await import(
  '../../../services/orchestration/orchestration-stream-presence.js'
);

const makeTempDir = trackTempDirs();
const shutdowns: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const shutdown of shutdowns.splice(0)) await shutdown();
});

/**
 * Any service the composition touches but this test does not observe: every
 * property is a no-op function whose result is the same stub (never a
 * thenable), so construction-time wiring runs without real collaborators.
 */
function stub(): any {
  const fn: any = () => proxy;
  const proxy: any = new Proxy(fn, {
    get: (_target, key) =>
      key === 'then' || key === Symbol.toPrimitive ? undefined : proxy,
    apply: () => proxy,
  });
  return proxy;
}

function supportContext(
  home: string,
  warn = vi.fn(),
  overrides: Record<PropertyKey, unknown> = {},
) {
  return new Proxy(
    {
      eventBus: new EventBus(),
      logger: { warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() },
      configLoader: { getProjectHomeDir: () => home },
      ...overrides,
    } as Record<PropertyKey, unknown>,
    { get: (target, key) => (key in target ? target[key] : stub()) },
  );
}

/** Real members first; anything else the composition touches is inert. */
function withStubFallback<T extends object>(members: T): T {
  return new Proxy(members, {
    get: (target, key) => (key in target ? Reflect.get(target, key) : stub()),
  }) as T;
}

test('a turn completion is recorded while its owner holds a live /events stream', async () => {
  // The live-Station regression: a desktop app idling in the tray keeps its
  // orchestration stream open, and the old "owner is connected" gate then
  // recorded no completion at all, so no surface was ever notified. Whether
  // a connected, focused surface is interrupted is the delivery router's
  // decision; the record must exist for it to decide.
  const eventBus = new EventBus();
  const presence = new OrchestrationStreamPresence();
  const owner = orchestrationStreamPresenceSubjectForSession('owner-1');
  const disconnect = presence.connect(owner);
  const warn = vi.fn();
  const context = supportContext(makeTempDir('runtime-support-turn-'), warn, {
    eventBus,
    orchestrationStreamPresence: presence,
    orchestrationService: withStubFallback({
      isReadOnlyAttachedSession: () => false,
      isEphemeralSession: () => false,
      resolveSessionPresenceSubject: () => owner,
      consumeInternalStopSuppression: () => false,
    }),
  });
  const services = configureRuntimeSupportServices(context as never, stub(), {
    webPushEnabled: false,
  });
  shutdowns.push(() => services.notificationService.shutdown());
  try {
    expect(presence.isConnected(owner)).toBe(true);
    const event = {
      createdAt: new Date().toISOString(),
      provider: 'claude',
      threadId: 'thread-live',
      turnId: 'turn-1',
    };
    eventBus.emit('orchestration:event', {
      event: { ...event, method: 'turn.started', prompt: 'go' },
    });
    eventBus.emit('orchestration:event', {
      event: { ...event, method: 'turn.completed', finishReason: 'stop' },
    });
    await services.notificationService.drainAsyncDispatch();

    const recorded = (await services.notificationService.list()).filter(
      (notification) => notification.source === 'turn-completion',
    );
    expect(recorded).toEqual([
      expect.objectContaining({
        category: 'turn-completed',
        title: 'Your agent finished',
        metadata: expect.objectContaining({
          threadId: 'thread-live',
          turnId: 'turn-1',
        }),
      }),
    ]);
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining('turn-completion'),
      expect.anything(),
    );
  } finally {
    disconnect();
  }
});

test('#2620: the focus source and in-app liveness reach delivery wiring', () => {
  const focus = { snapshotForPrincipals: () => new Map() };
  const inAppLiveness = { isLive: () => false };
  wiring.deps.length = 0;
  const services = configureRuntimeSupportServices(
    supportContext(makeTempDir('runtime-support-focus-')) as never,
    stub(),
    { webPushEnabled: false, focus, inAppLiveness },
  );
  shutdowns.push(() => services.notificationService.shutdown());
  expect(wiring.deps).toHaveLength(1);
  expect(wiring.deps[0]).toMatchObject({ focus, inAppLiveness });
});

test('a plugin provider with a reserved id is skipped at boot and the ordinary one registers', () => {
  const home = makeTempDir('runtime-support-notif-');
  const warn = vi.fn();
  const context = supportContext(home, warn);

  const services = configureRuntimeSupportServices(context as never, stub(), {
    webPushEnabled: false,
  });
  shutdowns.push(() => services.notificationService.shutdown());

  const ids = services.notificationService.listProviders().map((p) => p.id);
  expect(ids).toContain('plugin-ok');
  expect(ids).not.toContain('api');
  expect(warn).toHaveBeenCalledWith(
    'Plugin notification provider skipped',
    expect.objectContaining({ plugin: 'plugin-bad', reason: 'reserved' }),
  );
});

// #4177: the composition, given no explicit webPushEnabled, derives it from
// the deployment, and that composed value is what both the push routes and
// the handshake's webPushNotifications flag answer.
test.each([
  { mode: 'personal', hosted: false },
  { mode: 'hosted', hosted: true },
])(
  '$mode: composed Web Push enablement matches the advertised flag',
  async ({ hosted }) => {
    vi.stubEnv(
      HOSTED_TENANT_REGISTRY_FILE_ENV,
      hosted ? '/hosted/tenants.json' : undefined,
    );
    try {
      const services = configureRuntimeSupportServices(
        supportContext(makeTempDir('runtime-support-push-')) as never,
        stub(),
      );
      shutdowns.push(() => services.notificationService.shutdown());
      const routes = createPushRoutes({
        enabled: services.webPushEnabled,
        getVapidPublicKey: () => 'vapid-public-key',
        identifyDevice: () => null,
        credentialAliasId: () => undefined,
        setPushSubscription: vi.fn(),
        clearPushSubscription: vi.fn(),
      });
      const served = (await routes.request('/vapid-public-key')).status === 200;
      const advertised =
        resolveStationCapabilityFlags({ hosted }).webPushNotifications === true;

      expect(services.webPushEnabled).toBe(!hosted);
      expect(served).toBe(!hosted);
      expect(advertised).toBe(served);
    } finally {
      vi.unstubAllEnvs();
    }
  },
);
