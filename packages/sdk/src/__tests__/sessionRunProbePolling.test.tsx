// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The session detail's Flow-run and Builder-run probes. The client answers
 * `null` only for the server's 404 ("no run bound/joined to this session"),
 * and the detail used to re-ask that same question every 2s and 10s for as
 * long as it stayed open. These tests drive the real hooks through a real
 * QueryClient and count the probes the client module receives.
 */

const getSessionFlowRun = vi.hoisted(() => vi.fn());
const getSessionBuilderRun = vi.hoisted(() => vi.fn());

vi.mock('../client/orchestration', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../client/orchestration')>()),
  getSessionFlowRun,
  getSessionBuilderRun,
}));

import {
  useSessionBuilderRunQuery,
  useSessionFlowRunQuery,
} from '../query-domains/chatRuntimeOrchestration';

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };
}

function newClient() {
  // Station's app defaults: no retry, no refetch on focus/mount.
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        refetchOnWindowFocus: false,
        refetchOnMount: false,
      },
    },
  });
}

const boundFlowRun = {
  definitionId: 'station-delivery',
  run: { state: 'in_progress', openGates: [] },
};
const joinedBuilderRun = {
  identityStatus: 'present',
  matchKind: 'started-by-station',
  taskSlug: 'ship-it',
};

/** Resolve the mocked probe and let React Query commit it (fake timers stop
 * testing-library's `waitFor` from polling). */
async function settle() {
  await advance(50);
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('session run probes slow down after a definitive "no run"', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    getSessionFlowRun.mockReset();
    getSessionBuilderRun.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('Flow run: a null answer is re-asked only at the slow cadence, not every 2s', async () => {
    getSessionFlowRun.mockResolvedValue(null);
    const { result } = renderHook(
      () => useSessionFlowRunQuery('thread-1', 'http://station.test'),
      { wrapper: wrapperFor(newClient()) },
    );
    await settle();
    expect(result.current.isSuccess).toBe(true);
    expect(result.current.data).toBeNull();
    expect(getSessionFlowRun).toHaveBeenCalledTimes(1);

    await advance(29_000);
    expect(getSessionFlowRun).toHaveBeenCalledTimes(1);
    await advance(1_100);
    expect(getSessionFlowRun).toHaveBeenCalledTimes(2);
  });

  it('Flow run: a run joined after the first 404 appears while the detail stays open', async () => {
    getSessionFlowRun
      .mockResolvedValueOnce(null)
      .mockResolvedValue(boundFlowRun);
    const { result } = renderHook(
      () => useSessionFlowRunQuery('thread-1', 'http://station.test'),
      { wrapper: wrapperFor(newClient()) },
    );
    await settle();
    expect(result.current.data).toBeNull();
    await advance(30_100);
    expect(result.current.data).toEqual(boundFlowRun);
    // Bound again: back to the 2s cadence.
    await advance(2_000);
    expect(getSessionFlowRun).toHaveBeenCalledTimes(3);
  });

  it('refetchInterval 0 (a finished session) polls neither a bound nor an absent run', async () => {
    getSessionFlowRun.mockResolvedValue(boundFlowRun);
    getSessionBuilderRun.mockResolvedValue(null);
    renderHook(
      () => {
        useSessionFlowRunQuery('thread-1', 'http://station.test', {
          refetchInterval: 0,
        });
        useSessionBuilderRunQuery('thread-1', 'http://station.test', {
          refetchInterval: 0,
        });
      },
      { wrapper: wrapperFor(newClient()) },
    );
    await settle();
    await advance(120_000);
    expect(getSessionFlowRun).toHaveBeenCalledTimes(1);
    expect(getSessionBuilderRun).toHaveBeenCalledTimes(1);
  });

  it('Flow run: a bound run keeps polling every 2s (control)', async () => {
    getSessionFlowRun.mockResolvedValue(boundFlowRun);
    const { result } = renderHook(
      () => useSessionFlowRunQuery('thread-1', 'http://station.test'),
      { wrapper: wrapperFor(newClient()) },
    );
    await settle();
    expect(result.current.isSuccess).toBe(true);
    expect(getSessionFlowRun).toHaveBeenCalledTimes(1);

    await advance(6_100);
    expect(getSessionFlowRun).toHaveBeenCalledTimes(4);
  });

  it('Flow run: a failed read is not an answer and keeps polling', async () => {
    getSessionFlowRun.mockRejectedValue(new Error('Station unreachable'));
    const { result } = renderHook(
      () => useSessionFlowRunQuery('thread-1', 'http://station.test'),
      { wrapper: wrapperFor(newClient()) },
    );
    await settle();
    expect(result.current.isError).toBe(true);
    await advance(4_100);
    expect(getSessionFlowRun).toHaveBeenCalledTimes(3);
  });

  it('Flow run: a run that goes away slows the poll on the null that says so', async () => {
    getSessionFlowRun
      .mockResolvedValueOnce(boundFlowRun)
      .mockResolvedValue(null);
    const { result } = renderHook(
      () => useSessionFlowRunQuery('thread-1', 'http://station.test'),
      { wrapper: wrapperFor(newClient()) },
    );
    await settle();
    expect(result.current.data).toEqual(boundFlowRun);
    await advance(2_100);
    expect(result.current.data).toBeNull();
    expect(getSessionFlowRun).toHaveBeenCalledTimes(2);
    await advance(10_000);
    expect(getSessionFlowRun).toHaveBeenCalledTimes(2);
  });

  it('Builder run: a null answer is re-asked every 30s, not every 10s', async () => {
    getSessionBuilderRun.mockResolvedValue(null);
    const { result } = renderHook(
      () => useSessionBuilderRunQuery('thread-1', 'http://station.test'),
      { wrapper: wrapperFor(newClient()) },
    );
    await settle();
    expect(result.current.isSuccess).toBe(true);
    await advance(29_000);
    expect(getSessionBuilderRun).toHaveBeenCalledTimes(1);
    await advance(1_100);
    expect(getSessionBuilderRun).toHaveBeenCalledTimes(2);
  });

  it('Builder run: a joined run keeps polling every 10s (control)', async () => {
    getSessionBuilderRun.mockResolvedValue(joinedBuilderRun);
    const { result } = renderHook(
      () => useSessionBuilderRunQuery('thread-1', 'http://station.test'),
      { wrapper: wrapperFor(newClient()) },
    );
    await settle();
    expect(result.current.isSuccess).toBe(true);
    await advance(20_100);
    expect(getSessionBuilderRun).toHaveBeenCalledTimes(3);
  });

  it('reopening a detail whose cached answer was "no run" asks once more', async () => {
    getSessionFlowRun.mockResolvedValue(null);
    const client = newClient();
    const first = renderHook(
      () => useSessionFlowRunQuery('thread-1', 'http://station.test'),
      { wrapper: wrapperFor(client) },
    );
    await settle();
    expect(first.result.current.isSuccess).toBe(true);
    first.unmount();
    await advance(3_000);

    getSessionFlowRun.mockResolvedValue(boundFlowRun);
    const second = renderHook(
      () => useSessionFlowRunQuery('thread-1', 'http://station.test'),
      { wrapper: wrapperFor(client) },
    );
    await settle();
    expect(second.result.current.data).toEqual(boundFlowRun);
    expect(getSessionFlowRun).toHaveBeenCalledTimes(2);
  });
});
