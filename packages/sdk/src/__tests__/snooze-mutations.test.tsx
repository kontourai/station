/** @vitest-environment jsdom */
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../api', () => ({
  _getApiBase: vi.fn().mockResolvedValue('http://station.test'),
}));

import {
  snoozeAttentionItem,
  unsnoozeAttentionItem,
  useSnoozeAttentionItemMutation,
  useUnsnoozeAttentionItemMutation,
} from '../query-domains/attention';
import {
  snoozeNotification,
  useSnoozeNotificationMutation,
} from '../query-domains/notifications';

const until = '2026-10-29T12:00:00.000Z';
const itemId = 'session-failed:one/two';

describe('snooze SDK mutations', () => {
  beforeEach(() =>
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ success: true, data: { snoozedUntil: until } }),
            { status: 200 },
          ),
        ),
    ),
  );
  afterEach(() => vi.unstubAllGlobals());

  test.each(['attention', 'unsnooze', 'notification'] as const)(
    '%s sends the encoded request and refreshes mounted queries',
    async (kind) => {
      const client = new QueryClient({
        defaultOptions: {
          queries: { retry: false },
          mutations: { retry: false },
        },
      });
      const attentionFetch = vi.fn(async () => ({
        pendingCount: 0,
        items: [],
      }));
      const notificationFetch = vi.fn(async () => []);
      function Wrapper({ children }: { children: ReactNode }) {
        return (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        );
      }
      const rendered = renderHook(
        () => ({
          attention: useQuery({
            queryKey: ['attention', 'http://other-base.test'],
            queryFn: attentionFetch,
          }),
          notifications: useQuery({
            queryKey: ['notifications', { status: ['pending'] }],
            queryFn: notificationFetch,
          }),
          snooze: useSnoozeAttentionItemMutation('http://explicit.test'),
          unsnooze: useUnsnoozeAttentionItemMutation('http://explicit.test'),
          notification: useSnoozeNotificationMutation(),
        }),
        { wrapper: Wrapper },
      );
      try {
        await waitFor(() => {
          expect(rendered.result.current.attention.isSuccess).toBe(true);
          expect(rendered.result.current.notifications.isSuccess).toBe(true);
        });
        await act(async () => {
          if (kind === 'attention')
            await rendered.result.current.snooze.mutateAsync({ itemId, until });
          else if (kind === 'unsnooze')
            await rendered.result.current.unsnooze.mutateAsync(itemId);
          else
            await rendered.result.current.notification.mutateAsync({
              id: itemId,
              until,
            });
        });
        await waitFor(() => expect(attentionFetch).toHaveBeenCalledTimes(2));
        expect(notificationFetch).toHaveBeenCalledTimes(
          kind === 'notification' ? 2 : 1,
        );
        const [url, request] = vi.mocked(fetch).mock.calls[0]!;
        expect(url).toBe(
          kind === 'notification'
            ? 'http://station.test/notifications/session-failed%3Aone%2Ftwo/snooze'
            : 'http://explicit.test/api/attention/session-failed%3Aone%2Ftwo/snooze',
        );
        expect(request?.method).toBe(kind === 'unsnooze' ? 'DELETE' : 'POST');
        if (kind === 'unsnooze') expect(request?.body).toBeUndefined();
        else {
          expect(JSON.parse(request?.body as string)).toEqual({ until });
          expect(new Headers(request?.headers).get('Content-Type')).toBe(
            'application/json',
          );
        }
      } finally {
        rendered.unmount();
        client.clear();
      }
    },
  );

  test.each([
    () => snoozeAttentionItem(itemId, until),
    () => unsnoozeAttentionItem(itemId),
    () => snoozeNotification(itemId, until),
  ])(
    'propagates the server message on a non-OK response, even with success true',
    async (call) => {
      vi.mocked(fetch).mockResolvedValue(
        new Response(
          JSON.stringify({ success: true, error: 'Snooze refused' }),
          { status: 403 },
        ),
      );
      await expect(call()).rejects.toThrow('Snooze refused');
    },
  );

  test.each([
    () => snoozeAttentionItem(itemId, until),
    () => unsnoozeAttentionItem(itemId),
  ])(
    'reports an older host without snooze routes as unsupported',
    async (call) => {
      vi.mocked(fetch).mockResolvedValue(
        new Response('404 Not Found', { status: 404 }),
      );
      await expect(call()).rejects.toThrow(
        'not supported by this host. Try updating Station',
      );
      vi.mocked(fetch).mockResolvedValue(
        new Response(
          JSON.stringify({ success: false, error: 'Route not found' }),
          { status: 404 },
        ),
      );
      await expect(call()).rejects.toThrow(
        'Route not found. Attention snooze is not supported by this host',
      );
    },
  );
});
