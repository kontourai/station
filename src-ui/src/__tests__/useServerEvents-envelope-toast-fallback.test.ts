/**
 * @vitest-environment jsdom
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { describe, expect, test, vi } from 'vitest';

const host = vi.hoisted(() => ({ current: true }));
const streams = vi.hoisted(
  () =>
    [] as Array<{
      onMessage: (message: { event: string; data: string }) => void;
    }>,
);
vi.mock('@kontourai/station-sdk', () => ({
  fetchSSE: vi.fn((_url: string, options: (typeof streams)[number]) => {
    streams.push(options);
    return { close: vi.fn() };
  }),
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'https://station.test' }),
  useHostRequestAuthorityScope: () => ({
    apiBase: 'https://station.test',
    authorityKey: host.current ? 'a:1' : 'b:1',
    isCurrent: host.current ? () => host.current : () => !host.current,
  }),
}));

const { show } = vi.hoisted(() => ({ show: vi.fn() }));
vi.mock('../contexts/ToastContext', () => ({ toastStore: { show } }));
vi.mock('../lib/notification-sounds', () => ({
  playDeliveredNotificationSound: vi.fn(),
}));
// The lazily loaded envelope toast chunk fails to load (offline, or a deploy
// replaced it).
vi.mock('../lib/notification-envelope-toast', () => {
  throw new Error('chunk failed to load');
});

import {
  handleNotificationDeliveredToast,
  NOTIFICATION_TOAST_DISPLAY_MS,
  useServerEvents,
} from '../hooks/useServerEvents';

describe('enveloped delivery toast fallback (#2587 review L6)', () => {
  test('a failed envelope chunk still shows the plain toast', async () => {
    handleNotificationDeliveredToast({
      id: 'n-1',
      category: 'agent-done',
      title: 'Tests pass',
      body: 'All green.',
      metadata: { envelope: { v: 1 } },
    });
    await vi.waitFor(() => expect(show).toHaveBeenCalledTimes(1));
    expect(show).toHaveBeenCalledWith(
      'Tests pass — All green.',
      undefined,
      NOTIFICATION_TOAST_DISPLAY_MS,
      undefined,
      { envelope: { v: 1 } },
    );
  });
});

test('a failed deferred envelope chunk cannot show an A delivery after the SSE authority switches to B', async () => {
  show.mockClear();
  host.current = true;
  streams.length = 0;
  const client = new QueryClient();
  const hook = renderHook(() => useServerEvents(), {
    wrapper: ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children),
  });
  const deliver = (index: number, title: string) =>
    streams[index]!.onMessage({
      event: 'notification:delivered',
      data: JSON.stringify({ title, metadata: { envelope: { v: 1 } } }),
    });
  try {
    act(() => {
      deliver(0, 'Private A result');
      host.current = false;
    });
    hook.rerender();
    await act(async () => deliver(1, 'Current B result'));
    await vi.waitFor(() =>
      expect(show).toHaveBeenCalledWith(
        'Current B result',
        undefined,
        NOTIFICATION_TOAST_DISPLAY_MS,
        undefined,
        { envelope: { v: 1 } },
      ),
    );
    expect(show.mock.calls.map(([message]) => message)).toEqual([
      'Current B result',
    ]);
  } finally {
    hook.unmount();
    client.clear();
  }
});
