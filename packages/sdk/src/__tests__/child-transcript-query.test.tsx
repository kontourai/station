// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import {
  useChildWorkTranscriptQuery,
  useChildWorkTranscriptTailQuery,
} from '../query-domains/chatRuntimeOrchestration';

const read = vi.hoisted(() => vi.fn(async () => ({ entries: [] })));
vi.mock('../client/orchestration', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../client/orchestration')>()),
  getChildWorkTranscript: read,
}));
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
test('a running child refreshes through React Query and settlement stops refreshes', async () => {
  vi.useFakeTimers();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const observer = renderHook(
    ({ running }) =>
      useChildWorkTranscriptQuery(
        { threadId: 'parent', childId: 'child', running },
        'https://station.test',
      ),
    { wrapper, initialProps: { running: true } },
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(read).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_000);
  });
  expect(read).toHaveBeenCalledTimes(2);
  observer.rerender({ running: false });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(4_000);
  });
  expect(read).toHaveBeenCalledTimes(2);
  observer.unmount();
  client.clear();
});

test('a chat-shaped read opens on the latest messages, loads older ones before them, and a running child polls only past its cursor', async () => {
  vi.useFakeTimers();
  // The server's shapes: a tail page names where it starts and ends; a
  // forward read from a cursor returns what follows.
  const transcript = Array.from({ length: 70 }, (_, message) => ({
    kind: 'text' as const,
    role: 'assistant' as const,
    message,
    text: `m${message}`,
  }));
  let length = 70;
  read.mockImplementation((async (
    _apiBase: string,
    _thread: string,
    _child: string,
    page: { offset?: number; limit?: number; tail?: boolean },
  ) => {
    const limit = page.limit ?? 30;
    const offset = page.tail ? Math.max(0, length - limit) : (page.offset ?? 0);
    const end = Math.min(length, offset + limit);
    return {
      entries: transcript.slice(offset, end),
      offset,
      endOffset: Math.max(offset, end),
    };
  }) as never);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const observer = renderHook(
    ({ running }) =>
      useChildWorkTranscriptTailQuery(
        { threadId: 'parent', childId: 'child', running },
        'https://station.test',
      ),
    { wrapper, initialProps: { running: true } },
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  const messages = () =>
    observer.result.current.data?.pages.flatMap((page) =>
      page.entries.map((entry) => entry.message),
    ) ?? [];
  expect(read.mock.calls[0]?.[3]).toEqual({ tail: true, limit: 30 });
  expect(messages()[0]).toBe(40);
  expect(messages().at(-1)).toBe(69);
  expect(observer.result.current.hasPreviousPage).toBe(true);
  // Older history loads before the first message.
  await act(async () => {
    await observer.result.current.fetchPreviousPage();
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(read).toHaveBeenLastCalledWith(
    'https://station.test',
    'parent',
    'child',
    { offset: 10, limit: 30 },
    expect.anything(),
  );
  expect(messages().slice(0, 2)).toEqual([10, 11]);
  // A poll reads only from the cursor; two new messages are appended.
  read.mockClear();
  transcript.push(
    { kind: 'text', role: 'assistant', message: 70, text: 'm70' },
    { kind: 'text', role: 'assistant', message: 71, text: 'm71' },
  );
  length = 72;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_000);
  });
  expect(read.mock.calls.length).toBeGreaterThan(0);
  for (const call of read.mock.calls)
    expect(call[3]).toMatchObject({ offset: expect.any(Number) });
  expect(read.mock.calls.every((call) => !call[3]?.tail)).toBe(true);
  expect(read.mock.calls[0]?.[3]).toEqual({ offset: 70, limit: 50 });
  expect(messages().slice(-2)).toEqual([70, 71]);
  expect(new Set(messages()).size).toBe(messages().length);
  // Settled: no more polls.
  observer.rerender({ running: false });
  read.mockClear();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(6_000);
  });
  expect(read).not.toHaveBeenCalled();
  // A reported change still reads past the cursor once.
  await act(async () => {
    observer.result.current.refreshLatest();
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(read.mock.calls.map((call) => call[3])).toEqual([
    { offset: 72, limit: 50 },
  ]);
  observer.unmount();
  client.clear();
});

function mountTail(running: boolean) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const observer = renderHook(
    ({ running }) =>
      useChildWorkTranscriptTailQuery(
        { threadId: 'parent', childId: 'child', running },
        'https://station.test',
      ),
    { wrapper, initialProps: { running } },
  );
  const messages = () =>
    observer.result.current.data?.pages.flatMap((page) =>
      page.entries.map((entry) => entry.message),
    ) ?? [];
  return { client, observer, messages };
}

const text = (message: number) => ({
  kind: 'text' as const,
  role: 'assistant' as const,
  message,
  text: `m${message}`,
});

test('against a server from before page ranges, the reader pages forward by nextOffset and a running child re-reads its pages', async () => {
  vi.useFakeTimers();
  // The old route: no `tail`, no `offset`/`endOffset`; a page from `offset`
  // and `nextOffset` while more follow. Unknown query parameters are ignored.
  let length = 40;
  read.mockImplementation((async (
    _apiBase: string,
    _thread: string,
    _child: string,
    page: { offset?: number; limit?: number },
  ) => {
    const offset = page.offset ?? 0;
    const limit = page.limit ?? 30;
    const end = Math.min(length, offset + limit);
    return {
      entries: Array.from({ length: end - offset }, (_, i) => text(offset + i)),
      ...(end < length ? { nextOffset: end } : {}),
    };
  }) as never);
  const { client, observer, messages } = mountTail(true);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(messages()).toEqual(Array.from({ length: 30 }, (_, i) => i));
  expect(observer.result.current.hasLaterPage).toBe(true);
  expect(observer.result.current.hasPreviousPage).toBe(false);
  await act(async () => {
    await observer.result.current.fetchNextPage();
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(read).toHaveBeenLastCalledWith(
    'https://station.test',
    'parent',
    'child',
    { offset: 30, limit: 30 },
    expect.anything(),
  );
  expect(messages().at(-1)).toBe(39);
  expect(observer.result.current.hasLaterPage).toBe(false);
  // Running: the loaded pages are re-read, so new messages appear.
  length = 42;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_000);
  });
  expect(messages().at(-1)).toBe(41);
  observer.unmount();
  client.clear();
});

test('a transcript rewritten shorter than the cursor starts again from its latest messages', async () => {
  vi.useFakeTimers();
  let length = 50;
  read.mockImplementation((async (
    _apiBase: string,
    _thread: string,
    _child: string,
    page: { offset?: number; limit?: number; tail?: boolean },
  ) => {
    const limit = page.limit ?? 30;
    // The server's shape: a read from past the end starts at the end.
    const offset = page.tail
      ? Math.max(0, length - limit)
      : Math.min(page.offset ?? 0, length);
    const end = Math.min(length, offset + limit);
    return {
      entries: Array.from({ length: end - offset }, (_, i) => text(offset + i)),
      offset,
      endOffset: end,
    };
  }) as never);
  const { client, observer, messages } = mountTail(true);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(messages().at(-1)).toBe(49);
  length = 10;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_100);
  });
  expect(messages()).toEqual(Array.from({ length: 10 }, (_, i) => i));
  // ...and it follows the new transcript from there.
  length = 11;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_100);
  });
  expect(messages().at(-1)).toBe(10);
  observer.unmount();
  client.clear();
});

test('an invalidation rebuilds every loaded page instead of keeping only the first', async () => {
  vi.useFakeTimers();
  let length = 60;
  read.mockImplementation((async (
    _apiBase: string,
    _thread: string,
    _child: string,
    page: { offset?: number; limit?: number; tail?: boolean },
  ) => {
    const limit = page.limit ?? 30;
    const offset = page.tail
      ? Math.max(0, length - limit)
      : Math.min(page.offset ?? 0, length);
    const end = Math.min(length, offset + limit);
    return {
      entries: Array.from({ length: end - offset }, (_, i) => text(offset + i)),
      offset,
      endOffset: end,
    };
  }) as never);
  const { client, observer, messages } = mountTail(true);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  length = 63;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_100);
  });
  // Older history loaded above: the first page is now an older one.
  await act(async () => {
    await observer.result.current.fetchPreviousPage();
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(messages()[0]).toBe(0);
  expect(messages().at(-1)).toBe(62);
  observer.rerender({ running: false });
  await act(async () => {
    await client.invalidateQueries();
    await vi.advanceTimersByTimeAsync(1);
  });
  // Still from the oldest loaded message to the latest one, once each.
  expect(messages()[0]).toBe(0);
  expect(messages().at(-1)).toBe(62);
  expect(new Set(messages()).size).toBe(messages().length);
  observer.unmount();
  client.clear();
});
