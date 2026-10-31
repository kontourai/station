// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { useTaskWriteBackQuery } from '../query-domains/taskWriteBack';

const entry = (taskId: string) => ({
  id: `attempt-${taskId}`,
  taskId,
  taskCreatedAt: '2026-10-24T00:00:00.000Z',
  ordinal: 1,
  target: {
    kind: 'chat',
    system: 'discord',
    destination: 'channel',
    action: 'message',
  },
  initiatedBy: { kind: 'person', id: 'owner' },
  attemptedAt: '2026-10-24T00:00:00.000Z',
  retryOf: null,
  state: 'failed',
  failureReason: 'Unavailable',
  settledAt: '2026-10-24T00:00:01.000Z',
});
const response = (taskId: string) =>
  Response.json({ success: true, data: { entries: [entry(taskId)] } });

afterEach(() => vi.unstubAllGlobals());

test.each([false, true])(
  'Task changes never expose previous data (caller opt-in: %s)',
  async (optIn) => {
    const client = new QueryClient();
    let release!: (response: Response) => void;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response('a'))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const view = renderHook(
      ({ taskId }) =>
        useTaskWriteBackQuery(
          'https://station.example',
          taskId,
          optIn ? { keepPreviousData: true } : undefined,
        ),
      { initialProps: { taskId: 'a' }, wrapper },
    );
    try {
      await waitFor(() =>
        expect(view.result.current.data?.entries[0]?.taskId).toBe('a'),
      );
      view.rerender({ taskId: 'b' });
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      expect(view.result.current.data).toBeUndefined();
      expect(view.result.current.isPlaceholderData).toBe(false);
      await act(async () => {
        release(response('b'));
      });
      await waitFor(() =>
        expect(view.result.current.data?.entries[0]?.taskId).toBe('b'),
      );
      expect(view.result.current.isPlaceholderData).toBe(false);
    } finally {
      view.unmount();
      client.clear();
    }
  },
);
