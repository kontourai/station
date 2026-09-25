/**
 * @vitest-environment jsdom
 */

import type { Notification } from '@kontourai/station-contracts/notification';
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * A Station switch, driven through the REAL channels (blockingAlert and
 * notificationAlert) with only the OS notifier and the query mocked. The
 * notifications cache key carries no connection and a switch invalidates
 * rather than clears it, so the first render on B still holds A's list —
 * the shape this reproduces.
 */
const notifyNatively = vi.fn(async (_input: unknown) => true);
vi.mock('../platform/native/notify', () => ({
  notifyNatively: (input: unknown) => notifyNatively(input),
}));
const query = {
  current: { data: undefined as Notification[] | undefined, dataUpdatedAt: 0 },
};
vi.mock('@kontourai/station-sdk', () => ({
  LIVE_NOTIFICATION_STATUSES: ['pending', 'delivered'],
  useNotificationsQuery: () => query.current,
  authenticatedFetch: async () => ({
    ok: false,
    status: 404,
    json: async () => ({}),
  }),
}));
const connection = {
  current: { apiBase: 'http://station.one', connectionId: 'conn-a' },
};
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => connection.current,
}));
vi.mock('../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => ({
    isTauri: true,
    isDesktop: true,
    isMobile: false,
  }),
}));

import { useNotificationOsAlerts } from '../hooks/useNotificationOsAlerts';
import { resetBlockingAlertState } from '../platform/native/blockingAlert';
import { resetNotificationAlertState } from '../platform/native/notificationAlert';
import { resetOsAlertScope } from '../platform/native/osAlerts';

function agent(id: string): Notification {
  return {
    id,
    source: 'agent',
    category: 'agent-done',
    status: 'delivered',
    priority: 'normal',
    title: `Agent ${id}`,
    createdAt: '2026-09-24T00:00:00.000Z',
    updatedAt: '2026-09-24T00:00:00.000Z',
    metadata: {
      envelope: {
        v: 1,
        source: { kind: 'agent', sessionId: 's-1', assurance: 'bound' },
        audience: { kind: 'owner' },
        urgency: 'done',
        interrupt: 'default',
      },
    },
  } as Notification;
}

function approval(id: string): Notification {
  return { ...agent(id), category: 'approval-request', metadata: {} };
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe('useNotificationOsAlerts across a Station switch (#2587 review L-M3)', () => {
  beforeEach(() => {
    notifyNatively.mockClear();
    resetBlockingAlertState();
    resetNotificationAlertState();
    resetOsAlertScope();
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    query.current = { data: undefined, dataUpdatedAt: 0 };
    connection.current = {
      apiBase: 'http://station.one',
      connectionId: 'conn-a',
    };
  });
  afterEach(() => vi.restoreAllMocks());

  async function switchTo(
    next: typeof connection.current,
    backlog: Notification[],
  ) {
    const { rerender } = renderHook(() => useNotificationOsAlerts());
    query.current = { data: [agent('a-1')], dataUpdatedAt: 1 };
    rerender();
    await settle();

    // The switch render still holds A's list (invalidated, not cleared).
    connection.current = next;
    rerender();
    await settle();

    // B's own list arrives: its backlog must be seeded, not announced.
    query.current = { data: backlog, dataUpdatedAt: Date.now() + 1_000 };
    rerender();
    await settle();
    expect(notifyNatively).not.toHaveBeenCalled();

    // Positive control: something genuinely new on B still announces.
    query.current = {
      data: [...backlog, agent('b-4')],
      dataUpdatedAt: Date.now() + 2_000,
    };
    rerender();
    await settle();
    expect(notifyNatively).toHaveBeenCalledTimes(1);
  }

  test('a switch to another endpoint seeds B from B’s list, not A’s', async () => {
    await switchTo({ apiBase: 'http://station.two', connectionId: 'conn-b' }, [
      agent('b-1'),
      agent('b-2'),
      approval('b-3'),
    ]);
  });

  test('a switch between two saved Stations sharing one endpoint reseeds too', async () => {
    // Envelope channel only: the blocking channel is still keyed by endpoint
    // alone (its call shape is pinned by useApprovalOsAlerts.test), so a
    // same-endpoint switch can still announce B's waiting blocking requests.
    await switchTo({ apiBase: 'http://station.one', connectionId: 'conn-b' }, [
      agent('b-1'),
      agent('b-2'),
      agent('b-3'),
    ]);
  });
});
