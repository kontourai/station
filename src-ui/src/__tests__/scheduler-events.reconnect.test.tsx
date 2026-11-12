/**
 * @vitest-environment jsdom
 *
 * The Schedule view's event stream against the real `fetchSSE` transport and a
 * stubbed `fetch`: `scheduler-events.test.ts` replaces the transport, so it
 * cannot see how the stream behaves across failures.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const box = vi.hoisted(() => ({
  apiBase: 'https://scheduler-reconnect-unset.example.test',
}));

vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: box.apiBase }),
}));
vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));
vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
}));

import { useSchedulerEvents } from '../hooks/useScheduler';

function mountSchedulerEvents() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const mounted = renderHook(() => useSchedulerEvents(), { wrapper });
  return { invalidate, unmount: mounted.unmount };
}

/** A stream response the server holds open, with a handle to drop it. */
function openStream(): { response: Response; drop: () => void } {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
    },
  });
  return {
    response: new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }),
    drop: () => controller.error(new Error('socket closed')),
  };
}

function streamAttempts(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(
    ([input, init]) =>
      String(input).includes('/scheduler/events') &&
      new Headers((init as RequestInit | undefined)?.headers).get('Accept') ===
        'text/event-stream',
  );
}

describe('scheduler event stream across failures', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps retrying past ten consecutive failures', async () => {
    vi.useFakeTimers();
    box.apiBase = 'https://scheduler-reconnect-outage.example.test';
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response('', { status: 503 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { unmount } = mountSchedulerEvents();
    await act(async () => {
      await vi.waitFor(() => expect(streamAttempts(fetchMock).length).toBe(1));
    });
    // 1, 2, 4, 8, 16 then 30s waits: the eleventh failure lands at 181s, which
    // is where a ten-retry budget ended the stream for the page's life.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(185_000);
    });
    expect(streamAttempts(fetchMock).length).toBe(11);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    // Four more ceiling waits; the upper bound keeps this a ladder.
    expect(streamAttempts(fetchMock).length).toBeGreaterThanOrEqual(14);
    expect(streamAttempts(fetchMock).length).toBeLessThanOrEqual(16);
    unmount();
  });

  it('re-reads jobs and runs when the stream re-opens after a failure', async () => {
    vi.useFakeTimers();
    box.apiBase = 'https://scheduler-reconnect-reopen.example.test';
    const first = openStream();
    const second = openStream();
    const fetchMock = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(first.response)
      .mockResolvedValueOnce(second.response);
    vi.stubGlobal('fetch', fetchMock);

    const { invalidate, unmount } = mountSchedulerEvents();
    await act(async () => {
      await vi.waitFor(() => expect(streamAttempts(fetchMock).length).toBe(1));
      await vi.advanceTimersByTimeAsync(10);
    });
    // Control: the first open follows no failure. The view's own queries are
    // loading already, so the stream asks for nothing.
    expect(invalidate).not.toHaveBeenCalled();

    await act(async () => {
      first.drop();
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(streamAttempts(fetchMock).length).toBe(2);
    const invalidated = invalidate.mock.calls.map(([filters]) =>
      JSON.stringify(filters?.queryKey),
    );
    expect(invalidated).toEqual(['["scheduler"]', '["runs"]']);
    unmount();
  });
});
