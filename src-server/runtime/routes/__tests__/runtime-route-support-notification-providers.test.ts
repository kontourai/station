/**
 * #2597: a plugin notification provider with a refused id (here `api`) must
 * not stop Station booting. Drives the REAL `configureRuntimeSupportServices`
 * seam — the loop that registers plugin providers — with the plugin
 * registry answering one refused and one ordinary provider.
 */
import { afterEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';

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

function supportContext(home: string, warn = vi.fn()) {
  return new Proxy(
    {
      eventBus: new EventBus(),
      logger: { warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() },
      configLoader: { getProjectHomeDir: () => home },
    } as Record<PropertyKey, unknown>,
    { get: (target, key) => (key in target ? target[key] : stub()) },
  );
}

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
