/** @vitest-environment jsdom */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { expect, test, vi } from 'vitest';
import { _setApiBase } from '../api-core';
import {
  useDeleteFeedbackRatingMutation,
  useSaveFeedbackRatingMutation,
} from '../query-domains/analytics';

const { authenticatedFetch } = vi.hoisted(() => ({
  authenticatedFetch: vi.fn(),
}));
vi.mock('../client/http', () => ({ authenticatedFetch }));

const keys = [
  ['feedback', 'ratings'],
  ['feedback', 'guidelines'],
  ['feedback', 'status'],
];
const input = {
  agentSlug: 'agent',
  conversationId: 'conversation',
  messageIndex: 0,
  messagePreview: 'rated response',
  rating: 'thumbs_up' as const,
};

test.each(['save', 'delete'] as const)(
  '%s invalidates all derived feedback caches after the caller succeeds',
  async (kind) => {
    _setApiBase('https://station.example.test');
    authenticatedFetch.mockReset().mockResolvedValue(new Response('{}'));
    const client = new QueryClient();
    for (const key of keys) client.setQueryData(key, { old: true });
    client.setQueryData(['unrelated'], { untouched: true });
    const mounted = renderHook(
      () => ({
        save: useSaveFeedbackRatingMutation(),
        remove: useDeleteFeedbackRatingMutation(),
      }),
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        ),
      },
    );
    try {
      await act(async () => {
        const pending =
          kind === 'save'
            ? mounted.result.current.save.mutateAsync(input)
            : mounted.result.current.remove.mutateAsync({
                conversationId: input.conversationId,
                messageIndex: input.messageIndex,
              });
        await expect(pending).resolves.toBeUndefined();
      });
      for (const key of keys)
        expect(client.getQueryState(key)?.isInvalidated).toBe(true);
      expect(client.getQueryState(['unrelated'])?.isInvalidated).toBe(false);
      expect(authenticatedFetch).toHaveBeenCalledTimes(1);
    } finally {
      mounted.unmount();
      client.clear();
    }
  },
);

test('a failed rating request rejects its caller and preserves cached feedback', async () => {
  _setApiBase('https://station.example.test');
  authenticatedFetch
    .mockReset()
    .mockResolvedValue(new Response('{}', { status: 503 }));
  const client = new QueryClient();
  for (const key of keys) client.setQueryData(key, { current: true });
  const mounted = renderHook(() => useSaveFeedbackRatingMutation(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  try {
    await act(async () => {
      await expect(mounted.result.current.mutateAsync(input)).rejects.toThrow(
        'Failed to save feedback rating',
      );
    });
    for (const key of keys) {
      expect(client.getQueryState(key)?.isInvalidated).toBe(false);
      expect(client.getQueryData(key)).toEqual({ current: true });
    }
  } finally {
    mounted.unmount();
    client.clear();
  }
});

test('a success observer failure remains visible without leaving committed feedback cached', async () => {
  _setApiBase('https://station.example.test');
  authenticatedFetch.mockReset().mockResolvedValue(new Response('{}'));
  const client = new QueryClient();
  for (const key of keys) client.setQueryData(key, { old: true });
  const mounted = renderHook(
    () =>
      useSaveFeedbackRatingMutation({
        onSuccess: () => {
          throw new Error('observer failed');
        },
      }),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
  try {
    await act(async () => {
      await expect(mounted.result.current.mutateAsync(input)).rejects.toThrow(
        'observer failed',
      );
    });
    for (const key of keys)
      expect(client.getQueryState(key)?.isInvalidated).toBe(true);
  } finally {
    mounted.unmount();
    client.clear();
  }
});
