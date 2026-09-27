import {
  afterEach,
  beforeEach,
  describe,
  expect,
  type Mock,
  test,
  vi,
} from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  notificationOps: { add: vi.fn() },
}));

const { NotificationService } = await import('../notification-service.js');
const { registerPluginNotificationProviders } = await import(
  '../plugin-notification-providers.js'
);
const { EventBus } = await import('../../orchestration/event-bus.js');

function provider(id: string, displayName = id) {
  return { id, displayName, categories: ['test'] };
}

describe('registerPluginNotificationProviders', () => {
  const makeTempDir = trackTempDirs();
  let svc: InstanceType<typeof NotificationService>;
  type Warn = (message: string, data?: Record<string, unknown>) => void;
  let warn: Mock<Warn>;

  beforeEach(() => {
    svc = new NotificationService(
      new EventBus(),
      makeTempDir('notif-plugin-providers-'),
      999_999,
    );
    // The built-in, registered before plugins exactly as runtime wiring does.
    svc.addProvider(provider('device-pairing', 'Built-in pairing'));
    warn = vi.fn<Warn>();
  });

  afterEach(async () => {
    await svc.shutdown();
  });

  test('a plugin with a reserved id is skipped with a warning and the others load', () => {
    const registered = registerPluginNotificationProviders(
      svc,
      [
        { provider: provider('before'), source: 'plugin-a' },
        { provider: provider('api'), source: 'plugin-bad' },
        { provider: provider('after'), source: 'plugin-c' },
      ],
      { warn },
    );
    expect(registered).toBe(2);
    expect(svc.listProviders().map((p) => p.id)).toEqual([
      'device-pairing',
      'before',
      'after',
    ]);
    expect(warn).toHaveBeenCalledWith('Plugin notification provider skipped', {
      plugin: 'plugin-bad',
      providerId: 'api',
      reason: 'reserved',
    });
  });

  test.each([
    ['device-pairing', 'internal'],
    ['scheduler', 'internal'],
    ['turn-completion', 'internal'],
  ])(
    'a plugin registering %s is skipped (%s) and never replaces a built-in',
    (id, reason) => {
      registerPluginNotificationProviders(
        svc,
        [{ provider: provider(id, 'Plugin impostor'), source: 'plugin-x' }],
        { warn },
      );
      expect(svc.listProviders().map((p) => p.displayName)).toEqual([
        'Built-in pairing',
      ]);
      expect(warn).toHaveBeenCalledWith(
        'Plugin notification provider skipped',
        expect.objectContaining({ providerId: id, reason }),
      );
    },
  );

  test('a plugin provider cannot set the card mark: its marked item is refused on poll, the rest land (#2589)', async () => {
    // A card-alerted item (orchestration approval shape) that a plugin marks
    // `onActivityCard` would silence its own phone alert.
    const cardShaped = {
      category: 'approval-request',
      metadata: { sessionId: 's1', sessionKind: 'runtime' },
    };
    registerPluginNotificationProviders(
      svc,
      [
        {
          provider: {
            ...provider('plugin-feed'),
            poll: async () => [
              {
                ...cardShaped,
                title: 'Marked',
                metadata: { ...cardShaped.metadata, onActivityCard: true },
              },
              { ...cardShaped, title: 'Unmarked' },
            ],
          },
          source: 'plugin-a',
        },
      ],
      { warn },
    );
    await svc.poll();
    const stored = await svc.list();
    expect(stored.map((n) => n.title)).toEqual(['Unmarked']);
    expect(stored[0].metadata).not.toHaveProperty('onActivityCard');
  });

  test('duplicate plugin ids: the first wins, the second is skipped', () => {
    registerPluginNotificationProviders(
      svc,
      [
        { provider: provider('shared', 'First'), source: 'plugin-1' },
        { provider: provider('shared', 'Second'), source: 'plugin-2' },
      ],
      { warn },
    );
    expect(
      svc.listProviders().find((p) => p.id === 'shared')?.displayName,
    ).toBe('First');
    expect(warn).toHaveBeenCalledWith(
      'Plugin notification provider skipped',
      expect.objectContaining({ plugin: 'plugin-2', reason: 'duplicate' }),
    );
  });

  test('an unexpected error still propagates (only id refusals are skipped)', () => {
    const failing = {
      addPluginProvider: () => {
        throw new Error('boom');
      },
    };
    expect(() =>
      registerPluginNotificationProviders(
        failing,
        [{ provider: provider('x'), source: 'p' }],
        { warn },
      ),
    ).toThrow('boom');
  });
});
