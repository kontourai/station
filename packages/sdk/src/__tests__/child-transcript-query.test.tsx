// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { useChildWorkTranscriptQuery } from '../query-domains/chatRuntimeOrchestration';

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
