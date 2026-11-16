// @vitest-environment jsdom

import {
  QueryClient,
  QueryClientProvider,
  QueryObserver,
} from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import * as React from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const host = vi.hoisted(() => ({
  activationEpoch: 'activation-a',
  authorityGeneration: 1,
  bindingId: 'binding-a',
}));
const applied = vi.hoisted(() => vi.fn());
const streams = vi.hoisted(
  () =>
    [] as Array<
      ReturnType<typeof import('@kontourai/station-sdk').fetchSSE> & {
        onMessage: (message: { event: string; data: string }) => void;
        onOpen?: (response: Response) => void;
        onError?: (error: unknown) => void;
      }
    >,
);

function createStreamHandle(): ReturnType<
  typeof import('@kontourai/station-sdk').fetchSSE
> {
  const controller = new AbortController();
  const completed = new Promise<void>((resolve) => {
    controller.signal.addEventListener('abort', () => resolve(), {
      once: true,
    });
  });
  return {
    signal: controller.signal,
    completed,
    close: vi.fn(() => controller.abort()),
    retry: vi.fn(),
    restart: vi.fn(),
  };
}

vi.mock('@kontourai/station-sdk', () => ({
  _setApiBase: vi.fn(),
  applyServerUpdateStateEvent: applied,
  fetchSSE: vi.fn(
    (
      url: string,
      options: {
        onMessage: (message: { event: string; data: string }) => void;
        onOpen?: (response: Response) => void;
        onError?: (error: unknown) => void;
      },
    ) => {
      const stream = {
        ...createStreamHandle(),
        onMessage: options.onMessage,
        onOpen: options.onOpen,
        onError: options.onError,
      };
      if (url.endsWith('/events') && !url.includes('/api/orchestration/'))
        streams.push(stream);
      return stream;
    },
  ),
  notifyCredentialChanged: vi.fn(),
  serverUpdateStateQueryKey: (apiBase: string) => [
    'server-update-state',
    apiBase,
  ],
  setClientCredentialResolver: vi.fn(),
  setClientRawEgressPolicyResolver: vi.fn(),
}));

vi.mock('@kontourai/station-connect', () => ({
  ConnectionsProvider: ({ children }: { children: ReactNode }) => children,
  DEFAULT_CONNECTION_CREDENTIAL_KEY: 'station-connection-credential',
  defaultCredentialStorage: { remove: vi.fn() },
  RejectingCredentialStorage: class {},
  requestAuthorityScopeFromCredentialEvidence: (
    evidence: {
      activationEpoch: string;
      authorityGeneration: number;
      connectionId: string;
      credentialState: string;
      origin: string;
    },
    options?: { authorityQualifier?: string },
  ) => ({
    apiBase: evidence.origin,
    authorityKey: JSON.stringify([
      evidence.connectionId,
      evidence.activationEpoch,
      evidence.authorityGeneration,
      evidence.credentialState,
      ...(options?.authorityQualifier ? [options.authorityQualifier] : []),
    ]),
  }),
  setNativePairingExchangeTransport: vi.fn(),
  // This deliberately returns fresh evidence and fresh callbacks on every
  // render, matching the public Connect contract rather than hiding the bug
  // behind a stable hook mock.
  useConnections: () => {
    const captured = {
      connectionId: 'native-station',
      activationEpoch: host.activationEpoch,
      generation: 1,
      authorityGeneration: host.authorityGeneration,
      credentialState: 'device-session',
      credential: undefined,
      origin: 'https://station.test',
    };
    return {
      apiBase: captured.origin,
      activeConnection: { id: captured.connectionId },
      captureCredentialEvidence: () => ({ ...captured }),
      credentialAuthorityGeneration: () => host.authorityGeneration,
      isCredentialEvidenceCurrent: (evidence: typeof captured) =>
        evidence.activationEpoch === host.activationEpoch &&
        evidence.authorityGeneration === host.authorityGeneration,
      markCredentialRequired: vi.fn(),
      recordAuthenticatedSuccess: vi.fn(),
    };
  },
}));

vi.mock('../platform/PlatformProfileContext', () => ({
  nativeProfileRepository: () => ({
    // Fresh receipts are normal native-repository behavior too.
    captureNativeRequestBinding: () => ({
      bindingId: host.bindingId,
      exactOrigin: 'https://station.test',
    }),
  }),
  useNativeProfileSelection: () => async () => {},
  useNativeProfileStoreEpoch: () => 0,
  usePlatformProfile: () => ({
    isTauri: true,
    isMobile: false,
    supervisesBundledServer: false,
  }),
}));
vi.mock('../platform/useBundledServerStatus', () => ({
  useBundledServerStatus: () => null,
}));

import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { ApiBaseProvider } from '../contexts/ApiBaseContext';
import { useServerEvents } from '../hooks/useServerEvents';

/**
 * #3851: `server-update:changed` carries the server's update state, which
 * the hook writes into that server's state query (no refetch, no poll).
 */
describe('useServerEvents and the server update state', () => {
  beforeEach(() => {
    streams.length = 0;
    applied.mockClear();
  });

  test('writes a pushed update state for the stream’s server, and ignores a malformed one', async () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    renderHook(() => useServerEvents(), {
      wrapper: ({ children }: { children: ReactNode }) =>
        React.createElement(
          ApiBaseProvider,
          undefined,
          React.createElement(QueryClientProvider, { client }, children),
        ),
    });
    const stream = streams[0]!;
    const state = { supported: true, progress: { state: 'idle' } };
    await act(async () => {
      stream.onMessage({
        event: SERVER_EVENTS.SERVER_UPDATE_CHANGED,
        data: JSON.stringify(state),
      });
    });
    expect(applied).toHaveBeenCalledWith(client, 'https://station.test', state);
    expect(invalidate).not.toHaveBeenCalled();
    await act(async () => {
      stream.onMessage({
        event: SERVER_EVENTS.SERVER_UPDATE_CHANGED,
        data: '{not json',
      });
    });
    expect(applied).toHaveBeenCalledTimes(1);
  });
});

test('overflow resync invalidates every cached query, including future event query keys', async () => {
  streams.length = 0;
  const client = new QueryClient();
  client.setQueryData(['future-event-key'], { value: 'stale' });
  client.setQueryData(['attention'], { value: 'stale' });
  const { unmount } = renderHook(() => useServerEvents(), {
    wrapper: ({ children }: { children: ReactNode }) =>
      React.createElement(
        ApiBaseProvider,
        undefined,
        React.createElement(QueryClientProvider, { client }, children),
      ),
  });
  try {
    act(() =>
      streams[0]!.onMessage({
        event: SERVER_EVENTS.DATA_CHANGED,
        data: JSON.stringify({ resync: true }),
      }),
    );
    expect(client.getQueryState(['future-event-key'])?.isInvalidated).toBe(
      true,
    );
    expect(client.getQueryState(['attention'])?.isInvalidated).toBe(true);
  } finally {
    const stream = streams[0]!;
    unmount();
    expect(stream.signal.aborted).toBe(true);
    await expect(stream.completed).resolves.toBeUndefined();
    client.clear();
  }
});

/*
 * General events are not replayed, so a stream that re-opens after a failure
 * may have missed any of them. The hook re-reads the queries those events keep
 * current. Unlike the overflow resync above it must not touch the rest of the
 * cache: a reconnect is routine, and refetching every mounted query on each
 * one is what overloads a slow Station.
 */
test('a general stream re-opening after a failure invalidates the event-backed queries only', async () => {
  streams.length = 0;
  const client = new QueryClient();
  const eventBacked = [
    ['notifications'],
    ['attention'],
    ['plugins'],
    ['projects'],
    ['layouts'],
    ['agents'],
    ['system-status'],
    ['plugin-updates'],
    ['server-update-state', 'https://station.test'],
  ];
  const untouched = [['orchestration-sessions'], ['future-event-key']];
  for (const key of [...eventBacked, ...untouched])
    client.setQueryData(key, { value: 'stale' });
  const invalidated = (key: readonly unknown[]) =>
    client.getQueryState(key)?.isInvalidated;
  const { unmount } = renderHook(() => useServerEvents(), {
    wrapper: ({ children }: { children: ReactNode }) =>
      React.createElement(
        ApiBaseProvider,
        undefined,
        React.createElement(QueryClientProvider, { client }, children),
      ),
  });
  try {
    const stream = streams[0]!;
    // Control: the first open follows no failure and re-reads nothing.
    act(() => stream.onOpen?.(new Response(null)));
    for (const key of eventBacked) expect(invalidated(key)).toBe(false);

    act(() => {
      stream.onError?.(new Error('socket closed'));
      stream.onOpen?.(new Response(null));
    });
    for (const key of eventBacked)
      expect(invalidated(key), String(key)).toBe(true);
    for (const key of untouched)
      expect(invalidated(key), String(key)).toBe(false);
  } finally {
    unmount();
    client.clear();
  }
});

test('re-reading after a resumed stream keeps a read that is already in flight', async () => {
  const { invalidateQueriesForMissedServerEvents } = await import(
    '../hooks/useServerEvents'
  );
  const client = new QueryClient();
  let finish!: (value: string[]) => void;
  const queryFn = vi.fn(
    () =>
      new Promise<string[]>((resolve) => {
        finish = resolve;
      }),
  );
  client.setQueryData(['agents'], ['stale']);
  const observer = new QueryObserver(client, {
    queryKey: ['agents'],
    queryFn,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const unsubscribe = observer.subscribe(() => {});
  try {
    // The health recovery's own refetch is in flight when the stream re-opens.
    void client.invalidateQueries({ queryKey: ['agents'] });
    expect(queryFn).toHaveBeenCalledTimes(1);
    // `agents` is named by several handlers: none of them, and not the read
    // already running, may start another request.
    invalidateQueriesForMissedServerEvents(client, 'https://station.test');
    expect(queryFn).toHaveBeenCalledTimes(1);
    finish(['fresh']);
    await vi.waitFor(() =>
      expect(client.getQueryData(['agents'])).toEqual(['fresh']),
    );
  } finally {
    unsubscribe();
    client.clear();
  }
});
