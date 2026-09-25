/**
 * @vitest-environment jsdom
 */

import type { Notification } from '@kontourai/station-contracts/notification';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const authenticatedFetch = vi.fn();
vi.mock('@kontourai/station-sdk', () => ({
  authenticatedFetch: (...args: unknown[]) => authenticatedFetch(...args),
}));
const markNotificationRead = vi.fn(async () => 'read');
vi.mock('@kontourai/station-sdk/notification-read', () => ({
  markNotificationRead: (...args: unknown[]) =>
    markNotificationRead(...(args as [])),
}));
const navigate = vi.fn();
vi.mock('../contexts/NavigationContext', () => ({
  navigationStore: { navigate: (...args: unknown[]) => navigate(...args) },
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
}));

import { NotificationCard } from '../components/notifications/NotificationCard';
import { NotificationHistoryItem } from '../components/notifications/NotificationHistoryItem';

function agentNotification(): Notification {
  return {
    id: 'n-1',
    source: 'agent',
    category: 'agent-attention',
    status: 'delivered',
    priority: 'high',
    title: 'Need approval to run migration',
    createdAt: '2026-09-24T00:00:00.000Z',
    updatedAt: '2026-09-24T00:00:00.000Z',
    metadata: {
      envelope: {
        v: 1,
        source: {
          kind: 'agent',
          sessionId: '6f1c2d3e-aaaa-bbbb-cccc-111122223333',
          agent: 'builder',
          projectId: 'proj-1',
          assurance: 'bound',
        },
        audience: { kind: 'owner' },
        urgency: 'attention',
        interrupt: 'default',
      },
    },
  };
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function preferencesRoute(present: boolean) {
  authenticatedFetch.mockImplementation(
    async (_url: string, init?: { method?: string }) => {
      if (!present) return { ok: false, status: 404, json: async () => ({}) };
      return {
        ok: true,
        status: 200,
        json: async () => (init?.method === 'PUT' ? {} : { perAgent: {} }),
      };
    },
  );
}

function renderHistoryItem(notification = agentNotification()) {
  return render(
    <NotificationHistoryItem
      notification={notification}
      isActionPending={false}
      isDismissPending={false}
      onAction={vi.fn()}
      onDismiss={vi.fn()}
    />,
    { wrapper },
  );
}

describe('inbox rows for enveloped notifications (#2587)', () => {
  beforeEach(() => {
    authenticatedFetch.mockReset();
    markNotificationRead.mockClear();
    navigate.mockClear();
  });

  test('attributes an agent notification to its agent and session', async () => {
    preferencesRoute(false);
    renderHistoryItem();
    expect(screen.getByTestId('notification-attribution').textContent).toBe(
      'from builder · session 6f1c2d3e',
    );
  });

  test('offers Mute only once the preferences route answers, and mutes through it', async () => {
    preferencesRoute(true);
    renderHistoryItem();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Mute this agent' }),
    );
    await screen.findByText('Muted');
    const put = authenticatedFetch.mock.calls.find(
      ([, init]) => init?.method === 'PUT',
    );
    expect(put?.[0]).toBe('http://station.test/api/notifications/preferences');
    expect(JSON.parse(put?.[1].body)).toMatchObject({
      perAgent: { builder: 'off' },
    });
    expect(
      screen.getByRole('button', { name: 'Mute this project' }),
    ).toBeTruthy();
  });

  test('without the preferences route there is no Mute to press', async () => {
    preferencesRoute(false);
    renderHistoryItem();
    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalled());
    // Let the settled query render before asserting absence.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole('button', { name: /Mute/ })).toBeNull();
  });

  test('Open goes to the calling session and marks the notification read', async () => {
    preferencesRoute(false);
    render(
      <NotificationCard
        notification={agentNotification()}
        onDismiss={vi.fn()}
      />,
      {
        wrapper,
      },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    await waitFor(() =>
      expect(markNotificationRead).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'n-1' }),
      ),
    );
    expect(navigate).toHaveBeenCalledWith('/', {
      chat: '6f1c2d3e-aaaa-bbbb-cccc-111122223333',
      dock: 'open',
    });
  });

  test('a legacy record renders neither attribution nor Open', () => {
    const legacy = agentNotification();
    legacy.metadata = {};
    renderHistoryItem(legacy);
    expect(screen.queryByTestId('notification-envelope-controls')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull();
  });
});
