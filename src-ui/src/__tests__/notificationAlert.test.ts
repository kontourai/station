/**
 * @vitest-environment jsdom
 */

import {
  BLOCKING_NOTIFICATION_CATEGORIES,
  type Notification,
  type NotificationEnvelopeV1,
} from '@kontourai/station-contracts/notification';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const notifyNatively = vi.fn(
  async (_input: { title: string; body?: string }) => true,
);
vi.mock('../platform/native/notify', () => ({
  notifyNatively: (input: { title: string; body?: string }) =>
    notifyNatively(input),
}));
const authenticatedFetch = vi.fn();
vi.mock('@kontourai/station-sdk', () => ({
  authenticatedFetch: (...args: unknown[]) => authenticatedFetch(...args),
}));

import {
  type ClientNotificationPreferences,
  DEFAULT_CLIENT_NOTIFICATION_PREFERENCES,
} from '../lib/notification-preferences-client';
import {
  type NotificationAlertDeps,
  reconcileNotificationAlerts,
  resetNotificationAlertState,
} from '../platform/native/notificationAlert';

const A = 'http://station.one';

/**
 * The shape S1's `NotificationService.schedule` stores for an agent
 * `notify_user` call: category per urgency, envelope under metadata.
 */
function agentNotification(
  id: string,
  envelope: Partial<NotificationEnvelopeV1> = {},
  overrides: Partial<Notification> = {},
): Notification {
  return {
    id,
    source: 'agent',
    category: 'agent-done',
    status: 'delivered',
    priority: 'normal',
    title: 'Tests pass on fix-login',
    body: 'All 212 tests green.',
    createdAt: '2026-09-24T00:00:00.000Z',
    updatedAt: '2026-09-24T00:00:00.000Z',
    metadata: {
      envelope: {
        v: 1,
        source: {
          kind: 'agent',
          sessionId: 'session-1',
          agent: 'builder',
          projectId: 'proj-1',
          assurance: 'bound',
        },
        audience: { kind: 'session-readers', sessionId: 'session-1' },
        urgency: 'done',
        interrupt: 'default',
        ...envelope,
      },
    },
    ...overrides,
  } as Notification;
}

function deps(
  overrides: Partial<NotificationAlertDeps> & {
    preferences?: Partial<ClientNotificationPreferences>;
  } = {},
) {
  const notify = vi.fn(
    async (_input: { title: string; body?: string }) => true,
  );
  const { preferences, ...rest } = overrides;
  return {
    notify,
    isWindowFocused: () => false,
    readPreferences: async () => ({
      ...DEFAULT_CLIENT_NOTIFICATION_PREFERENCES,
      ...preferences,
    }),
    now: () => new Date(2026, 8, 24, 12, 0),
    ...rest,
  } satisfies NotificationAlertDeps;
}

describe('reconcileNotificationAlerts', () => {
  beforeEach(() => resetNotificationAlertState());

  test('raises an OS alert for a new agent notification while the window is not in use', async () => {
    const d = deps();
    expect(await reconcileNotificationAlerts([], A, d)).toBe(0);
    expect(
      await reconcileNotificationAlerts([agentNotification('n-1')], A, d),
    ).toBe(1);
    expect(d.notify).toHaveBeenCalledWith({
      title: 'Tests pass on fix-login',
      body: 'All 212 tests green.',
    });
  });

  test('stays in-app while the window is focused, and does not replay it after focus leaves', async () => {
    let focused = true;
    const d = deps({ isWindowFocused: () => focused });
    await reconcileNotificationAlerts([], A, d);
    expect(
      await reconcileNotificationAlerts([agentNotification('n-1')], A, d),
    ).toBe(0);
    focused = false;
    await reconcileNotificationAlerts([agentNotification('n-1')], A, d);
    expect(d.notify).not.toHaveBeenCalled();
    // Positive control: the same window, unfocused, does alert on the next one.
    await reconcileNotificationAlerts(
      [agentNotification('n-1'), agentNotification('n-2')],
      A,
      d,
    );
    expect(d.notify).toHaveBeenCalledTimes(1);
  });

  test('seeds the backlog at first observation instead of bursting it', async () => {
    const d = deps();
    expect(
      await reconcileNotificationAlerts(
        [agentNotification('old-1'), agentNotification('old-2')],
        A,
        d,
      ),
    ).toBe(0);
    expect(d.notify).not.toHaveBeenCalled();
    await reconcileNotificationAlerts(
      [agentNotification('old-1'), agentNotification('new-1')],
      A,
      d,
    );
    expect(d.notify).toHaveBeenCalledTimes(1);
  });

  test('announces each id once across polls and reseeds on a Station switch', async () => {
    const d = deps();
    await reconcileNotificationAlerts([], A, d);
    await reconcileNotificationAlerts([agentNotification('n-1')], A, d);
    await reconcileNotificationAlerts([agentNotification('n-1')], A, d);
    expect(d.notify).toHaveBeenCalledTimes(1);
    await reconcileNotificationAlerts(
      [agentNotification('n-1'), agentNotification('n-2')],
      'http://station.two',
      d,
    );
    expect(d.notify).toHaveBeenCalledTimes(1);
  });

  test('hideContent posts fixed copy, never the agent text', async () => {
    const d = deps({ preferences: { hideContent: true } });
    await reconcileNotificationAlerts([], A, d);
    await reconcileNotificationAlerts(
      [
        agentNotification('n-1', {}, { title: 'Deploy key sk-live-SECRET' }),
        agentNotification('n-2', { urgency: 'attention' }),
      ],
      A,
      d,
    );
    expect(d.notify.mock.calls.map(([input]) => input)).toEqual([
      { title: 'Station', body: 'An agent sent you a notification.' },
      { title: 'Station', body: 'An agent needs your attention.' },
    ]);
    expect(JSON.stringify(d.notify.mock.calls)).not.toContain('SECRET');
  });

  test('quiet hours suppress everything but attention, and attention only when allowed', async () => {
    const run = async (allowAttention: boolean) => {
      resetNotificationAlertState();
      const d = deps({
        // 23:30, inside an overnight 22:00–07:00 window.
        now: () => new Date(2026, 8, 24, 23, 30),
        preferences: {
          quietHours: { start: '22:00', end: '07:00', allowAttention },
        },
      });
      await reconcileNotificationAlerts([], A, d);
      await reconcileNotificationAlerts(
        [
          agentNotification('done-1'),
          agentNotification(
            'attn-1',
            { urgency: 'attention' },
            { title: 'Need approval' },
          ),
        ],
        A,
        d,
      );
      return d.notify.mock.calls.map(([input]) => input.title);
    };
    expect(await run(true)).toEqual(['Need approval']);
    expect(await run(false)).toEqual([]);
  });

  test('outside quiet hours the same window lets everything through', async () => {
    const d = deps({
      now: () => new Date(2026, 8, 24, 12, 0),
      preferences: {
        quietHours: { start: '22:00', end: '07:00', allowAttention: false },
      },
    });
    await reconcileNotificationAlerts([], A, d);
    await reconcileNotificationAlerts([agentNotification('n-1')], A, d);
    expect(d.notify).toHaveBeenCalledTimes(1);
  });

  test('honours mutes and silent interrupts', async () => {
    const d = deps({ preferences: { perAgent: { builder: 'off' } } });
    await reconcileNotificationAlerts([], A, d);
    await reconcileNotificationAlerts([agentNotification('n-1')], A, d);
    expect(d.notify).not.toHaveBeenCalled();

    resetNotificationAlertState();
    const silent = deps();
    await reconcileNotificationAlerts([], A, silent);
    await reconcileNotificationAlerts(
      [agentNotification('n-2', { interrupt: 'silent' })],
      A,
      silent,
    );
    expect(silent.notify).not.toHaveBeenCalled();
  });

  test('a source kind this build does not know never interrupts', async () => {
    const d = deps();
    await reconcileNotificationAlerts([], A, d);
    const newer = agentNotification('n-1', {
      source: { kind: 'robot', robotId: 'r-1' } as never,
    });
    await reconcileNotificationAlerts([newer], A, d);
    expect(d.notify).not.toHaveBeenCalled();
  });

  test('leaves legacy records and blocking categories to their own paths', async () => {
    const d = deps();
    await reconcileNotificationAlerts([], A, d);
    const legacy = agentNotification('legacy-1');
    delete legacy.metadata;
    await reconcileNotificationAlerts(
      [
        legacy,
        agentNotification(
          'pair-1',
          {},
          { category: BLOCKING_NOTIFICATION_CATEGORIES.devicePairing },
        ),
      ],
      A,
      d,
    );
    expect(d.notify).not.toHaveBeenCalled();
  });
});

describe('reconcileNotificationAlerts with its default host wiring', () => {
  beforeEach(() => {
    resetNotificationAlertState();
    notifyNatively.mockClear();
    authenticatedFetch.mockReset();
    // No preferences route yet (#2586): the safe defaults apply.
    authenticatedFetch.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({}),
    });
  });
  afterEach(() => vi.restoreAllMocks());

  test('reads focus from the document: unfocused posts, focused does not', async () => {
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    await reconcileNotificationAlerts([], A);
    await reconcileNotificationAlerts([agentNotification('n-1')], A);
    expect(notifyNatively).not.toHaveBeenCalled();

    hasFocus.mockReturnValue(false);
    await reconcileNotificationAlerts(
      [agentNotification('n-1'), agentNotification('n-2')],
      A,
    );
    expect(notifyNatively).toHaveBeenCalledTimes(1);
    expect(authenticatedFetch).toHaveBeenCalledWith(
      `${A}/api/notifications/preferences`,
    );
  });
});
