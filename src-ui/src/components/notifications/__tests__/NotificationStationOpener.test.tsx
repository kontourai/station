// @vitest-environment jsdom
/**
 * Wrong-Station taps, through the app's real opener: a desktop alert
 * clicked after switching Stations, and a Web Push tap the service worker
 * hands to the open tab while another Station is active. Each must switch
 * to the Station the notification came from before the conversation is
 * looked up, and say what it is doing.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AuthorityPersistenceContext } from '../../../contexts/AuthorityPersistenceContext';
import { toastStore } from '../../../contexts/ToastContext';
import { subscribeToNotificationOpen } from '../../../lib/notificationOpen';
import {
  requestNotificationOpen,
  setNotificationOpenNotice,
} from '../../../lib/notificationStationOpen';

const A = {
  id: 'conn-a',
  name: 'Studio Mac',
  url: 'https://a.example',
  endpoints: [{ url: 'https://a.example' }],
  environmentId: 'env-a',
};
const B = {
  id: 'conn-b',
  name: 'Home server',
  url: 'https://b.example',
  endpoints: [{ url: 'https://b.example' }],
  environmentId: 'env-b',
};

const connections = vi.hoisted(() => ({
  list: null as unknown[] | null,
  active: null as unknown,
  order: [] as string[],
  release: undefined as (() => void) | undefined,
}));
const navigate = vi.fn((pathname: string, params: Record<string, string>) =>
  connections.order.push(
    `navigate:${pathname}?${new URLSearchParams(params)}@${(connections.active as { id: string }).id}`,
  ),
);
const setActiveConnection = vi.fn(
  (id: string) =>
    new Promise<void>((resolve) => {
      connections.order.push(`switch:${id}`);
      connections.release = () => {
        connections.active = [A, B].find((c) => c.id === id);
        resolve();
      };
    }),
);

vi.mock('@kontourai/station-connect', () => ({
  useConnections: () => ({
    connections: connections.list ?? [A, B],
    activeConnection: connections.active,
    setActiveConnection,
    // The provider's live read of the active connection.
    captureCredentialEvidence: () =>
      connections.active
        ? { connectionId: (connections.active as { id: string }).id }
        : null,
  }),
}));
vi.mock('../../../contexts/NavigationContext', () => ({
  useNavigationActions: () => ({ navigate }),
}));

const { NotificationStationOpener } = await import(
  '../NotificationStationOpener'
);

class FakeServiceWorkerContainer extends EventTarget {
  startMessages = vi.fn();
}

let worker: FakeServiceWorkerContainer;

beforeEach(() => {
  connections.list = null;
  connections.order = [];
  connections.release = undefined;
  navigate.mockClear();
  setActiveConnection.mockClear();
  worker = new FakeServiceWorkerContainer();
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: worker,
  });
});

afterEach(() => {
  cleanup();
  act(() => setNotificationOpenNotice(null));
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('NotificationStationOpener', () => {
  test('a missing conversation uses a transient toast', () => {
    render(<NotificationStationOpener />);
    try {
      act(() => setNotificationOpenNotice({ kind: 'not-found' }));
      expect(toastStore.getSnapshot()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: 'Conversation not found',
            duration: 5000,
          }),
        ]),
      );
      expect(screen.queryByRole('button', { name: 'OK' })).toBeNull();
    } finally {
      toastStore.clear();
    }
  });

  test('desktop: an alert from Station A clicked while Station B is active opens on A', async () => {
    connections.active = B;
    render(<NotificationStationOpener />);
    const dispose = subscribeToNotificationOpen(
      requestNotificationOpen,
      Promise.resolve({
        listen: async () => () => {},
        // The host's answer: the alert's link and the origin it read it from.
        take: async () => ({
          link: '/?chat=thread-a&dock=open&openedNotification=n-1&station=env-a',
          origin: 'https://a.example',
        }),
      }),
    );
    await act(settle);
    expect(
      screen.getByRole('status', {
        name: 'Opening conversation on Studio Mac',
      }),
    ).toBeTruthy();
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(navigate).not.toHaveBeenCalled();
    await act(async () => {
      connections.release?.();
      await settle();
    });
    expect(connections.order).toEqual([
      'switch:conn-a',
      'navigate:/?chat=thread-a&dock=open&openedNotification=n-1@conn-a',
    ]);
    expect(screen.queryByRole('status')).toBeNull();
    dispose();
  });

  test('web: a push tap the worker hands over while another Station is active switches first', async () => {
    connections.active = A;
    render(<NotificationStationOpener />);
    const channel = new MessageChannel();
    const answered = new Promise((resolve) => {
      channel.port1.onmessage = (event) => resolve(event.data);
    });
    await act(async () => {
      worker.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'station-notification-open',
            url: `${window.location.origin}/projects/web?chat=thread-b&dock=open&station=env-b`,
          },
          ports: [channel.port2],
        }),
      );
      await settle();
    });
    // The worker is told the tab opened it, so it does not reload the tab.
    await expect(answered).resolves.toEqual({ handled: true });
    expect(worker.startMessages).toHaveBeenCalled();
    await act(async () => {
      connections.release?.();
      await settle();
    });
    expect(connections.order).toEqual([
      'switch:conn-b',
      'navigate:/projects/web?chat=thread-b&dock=open@conn-b',
    ]);
  });

  test('web: a message naming another origin is ignored and not acknowledged', async () => {
    connections.active = A;
    render(<NotificationStationOpener />);
    const channel = new MessageChannel();
    const answer = vi.fn();
    channel.port1.onmessage = answer;
    await act(async () => {
      worker.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'station-notification-open',
            url: 'https://evil.example/?chat=x&dock=open',
          },
          ports: [channel.port2],
        }),
      );
      await settle();
    });
    expect(answer).not.toHaveBeenCalled();
    expect(setActiveConnection).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  test('a tap from a Station not saved here says so, with Manage Stations', async () => {
    connections.active = A;
    render(<NotificationStationOpener />);
    await act(async () => {
      requestNotificationOpen({
        pathname: '/',
        params: { chat: 'thread-x', dock: 'open' },
        stationId: 'env-unknown',
      });
      await settle();
    });
    expect(screen.getByText('Station not on this device')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Manage Stations' }),
    ).toBeTruthy();
    expect(navigate).not.toHaveBeenCalled();
  });

  test('web: a tap from this very Station opens here though its saved connection has no id', async () => {
    // A same-origin browser connection never recorded its Station's id; the
    // verified authority observation names it.
    const sameOrigin = { ...A, environmentId: null };
    connections.list = [sameOrigin, B];
    connections.active = sameOrigin;
    const view = render(
      <AuthorityPersistenceContext.Provider
        value={{ status: 'unverified', namespace: null, observation: null }}
      >
        <NotificationStationOpener />
      </AuthorityPersistenceContext.Provider>,
    );
    await act(async () => {
      requestNotificationOpen({
        pathname: '/',
        params: { chat: 'thread-a', dock: 'open' },
        stationId: 'env-a',
      });
      await settle();
    });
    // Waits for the id rather than calling this Station another one.
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.queryByText('Station not on this device')).toBeNull();
    view.rerender(
      <AuthorityPersistenceContext.Provider
        value={{
          status: 'verified',
          namespace: 'ns',
          observation: { environmentId: 'env-a' } as never,
        }}
      >
        <NotificationStationOpener />
      </AuthorityPersistenceContext.Provider>,
    );
    await act(settle);
    expect(setActiveConnection).not.toHaveBeenCalled();
    expect(connections.order).toEqual([
      'navigate:/?chat=thread-a&dock=open@conn-a',
    ]);
  });
});
