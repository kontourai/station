import { beforeEach, describe, expect, test, vi } from 'vitest';

const applyOrchestrationSnapshot = vi.fn();
vi.mock('../snapshotHandlers', () => ({
  applyOrchestrationSnapshot: (...args: unknown[]) =>
    applyOrchestrationSnapshot(...args),
}));

const handleOrchestrationEvent = vi.fn();
vi.mock('../eventHandlers', () => ({
  handleOrchestrationEvent: (...args: unknown[]) =>
    handleOrchestrationEvent(...args),
}));

const mocks = vi.hoisted(() => ({
  capturedOnMessage: undefined as
    | ((raw: { event: string; data: string; id?: string }) => void)
    | undefined,
  capturedOnError: undefined as ((error: unknown) => void) | undefined,
  fetchSSE: vi.fn(),
}));
vi.mock('@kontourai/station-sdk', () => ({
  fetchSSE: mocks.fetchSSE,
}));

import { ensureOrchestrationEventStream } from '../ensureOrchestrationEventStream';

describe('ensureOrchestrationEventStream reconnect-fallback snapshot gating (station#1225)', () => {
  const capturedOnMessage = () => mocks.capturedOnMessage!;

  beforeEach(() => {
    mocks.fetchSSE.mockClear();
    mocks.capturedOnMessage = undefined;
    mocks.capturedOnError = undefined;
    mocks.fetchSSE.mockImplementation((_url: string, opts: any) => {
      mocks.capturedOnMessage = opts.onMessage;
      mocks.capturedOnError = opts.onError;
      return {
        close: vi.fn(),
        signal: new AbortController().signal,
        completed: Promise.resolve(),
        retry: vi.fn(),
      };
    });
  });

  test('keeps the owned stream single-flight while its transport retries a transient failure', () => {
    ensureOrchestrationEventStream('http://api-1848-transient');
    expect(mocks.fetchSSE).toHaveBeenCalledOnce();

    // fetchSSE invokes this for a failed attempt but retains its retry loop.
    // A remount in that interval must not create another subscriber.
    mocks.capturedOnError!(new Error('connection reset'));
    ensureOrchestrationEventStream('http://api-1848-transient');

    expect(mocks.fetchSSE).toHaveBeenCalledOnce();
  });

  test('the FIRST snapshot on a fresh stream is never treated as a reconnect fallback', () => {
    applyOrchestrationSnapshot.mockClear();
    ensureOrchestrationEventStream('http://api-1225-a');
    capturedOnMessage()({
      event: 'orchestration:snapshot',
      data: JSON.stringify({ sessions: [] }),
      id: '5',
    });

    expect(applyOrchestrationSnapshot).toHaveBeenCalledTimes(1);
    expect(applyOrchestrationSnapshot).toHaveBeenCalledWith(
      { sessions: [] },
      { apiBase: 'http://api-1225-a', isReconnectFallback: false },
    );
  });

  test('a SECOND snapshot on the same (reconnected) stream IS treated as a reconnect fallback', () => {
    applyOrchestrationSnapshot.mockClear();
    ensureOrchestrationEventStream('http://api-1225-b');
    capturedOnMessage()({
      event: 'orchestration:snapshot',
      data: JSON.stringify({ sessions: [] }),
      id: '1',
    });
    capturedOnMessage()({
      event: 'orchestration:snapshot',
      data: JSON.stringify({ sessions: [] }),
      id: '9001',
    });

    expect(applyOrchestrationSnapshot).toHaveBeenCalledTimes(2);
    expect(applyOrchestrationSnapshot).toHaveBeenNthCalledWith(
      1,
      { sessions: [] },
      { apiBase: 'http://api-1225-b', isReconnectFallback: false },
    );
    expect(applyOrchestrationSnapshot).toHaveBeenNthCalledWith(
      2,
      { sessions: [] },
      { apiBase: 'http://api-1225-b', isReconnectFallback: true },
    );
  });

  test('a second call for the SAME apiBase is a no-op (existing dedup guard) — no new snapshot state', () => {
    applyOrchestrationSnapshot.mockClear();
    ensureOrchestrationEventStream('http://api-1225-c');
    const firstOnMessage = capturedOnMessage();
    ensureOrchestrationEventStream('http://api-1225-c');
    expect(capturedOnMessage()).toBe(firstOnMessage);
  });

  test('station#1225 review (MEDIUM fix): a supplied queryClient is threaded through to applyOrchestrationSnapshot', () => {
    applyOrchestrationSnapshot.mockClear();
    const fakeQueryClient = { getQueryData: vi.fn() } as any;
    ensureOrchestrationEventStream('http://api-1225-d', fakeQueryClient);
    capturedOnMessage()({
      event: 'orchestration:snapshot',
      data: JSON.stringify({ sessions: [] }),
      id: '1',
    });

    expect(applyOrchestrationSnapshot).toHaveBeenCalledWith(
      { sessions: [] },
      {
        apiBase: 'http://api-1225-d',
        isReconnectFallback: false,
        queryClient: fakeQueryClient,
      },
    );
  });
});
