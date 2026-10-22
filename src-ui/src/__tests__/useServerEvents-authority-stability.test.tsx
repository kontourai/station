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
const streams = vi.hoisted(
  () =>
    [] as Array<{
      close: ReturnType<typeof vi.fn>;
      onMessage: (message: { event: string; data: string }) => void;
    }>,
);

vi.mock('@kontourai/station-sdk', async () => ({
  applyACPStatusEvent: (await import('../../../packages/sdk/src/server-events'))
    .applyACPStatusEvent,
  _setApiBase: vi.fn(),
  fetchSSE: vi.fn(
    (
      _url: string,
      options: {
        onMessage: (message: { event: string; data: string }) => void;
      },
    ) => {
      const stream = { close: vi.fn(), onMessage: options.onMessage };
      streams.push(stream);
      return stream;
    },
  ),
  notifyCredentialChanged: vi.fn(),
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
import { answerBasisQueries } from '@kontourai/station-sdk/answer-basis';
import {
  ApiBaseProvider,
  useHostRequestAuthorityScope,
} from '../contexts/ApiBaseContext';
import { useServerEvents } from '../hooks/useServerEvents';

function provider(client: QueryClient) {
  return ({ children }: { children: ReactNode }) =>
    React.createElement(
      ApiBaseProvider,
      undefined,
      React.createElement(QueryClientProvider, { client }, children),
    );
}

describe('useServerEvents authority stability through the real host capture hook', () => {
  beforeEach(() => {
    host.activationEpoch = 'activation-a';
    host.authorityGeneration = 1;
    host.bindingId = 'binding-a';
    streams.length = 0;
  });

  test('draft recovery survives a page boot but refuses changed authorization or native binding', () => {
    const client = new QueryClient();
    const first = renderHook(() => useHostRequestAuthorityScope(), {
      wrapper: provider(client),
    });
    const saved = first.result.current;
    expect(saved?.draftRecoveryKey).toBeTruthy();
    first.unmount();
    host.activationEpoch = 'a-new-page-boot';
    const next = renderHook(() => useHostRequestAuthorityScope(), {
      wrapper: provider(client),
    });
    expect(next.result.current?.authorityKey).not.toBe(saved?.authorityKey);
    expect(next.result.current?.draftRecoveryKey).toBe(saved?.draftRecoveryKey);
    expect(saved?.isCurrent()).toBe(false);
    host.authorityGeneration += 1;
    next.rerender();
    expect(next.result.current?.draftRecoveryKey).not.toBe(
      saved?.draftRecoveryKey,
    );
    const authorized = next.result.current?.draftRecoveryKey;
    host.bindingId = 'replacement-binding';
    next.rerender();
    expect(next.result.current?.draftRecoveryKey).not.toBe(authorized);
    next.unmount();
    client.clear();
  });

  test('ACP reconnect compares the last applied status and repairs a change missed while disconnected', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const offline = { connected: false, connections: [] };
    const online = {
      connected: true,
      connections: [{ id: 'engine', status: 'available', detail: 'ready' }],
    };
    client.setQueryData(['system-status', 'https://station.test'], {
      acp: offline,
    });
    let observedStatus = 0;
    const fetchAgents = vi.fn(async () => observedStatus);
    const observer = new QueryObserver(client, {
      queryKey: ['agents'],
      queryFn: fetchAgents,
      initialData: 0,
      staleTime: Infinity,
    });
    const unsubscribe = observer.subscribe(() => {});
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const hook = renderHook(() => useServerEvents(), {
      wrapper: provider(client),
    });
    const send = async (index: number, status: unknown) =>
      act(async () => {
        streams[index]!.onMessage({
          event: SERVER_EVENTS.ACP_STATUS,
          data: JSON.stringify(status),
        });
      });
    await send(0, offline);
    expect(invalidate).not.toHaveBeenCalled();
    expect(fetchAgents).not.toHaveBeenCalled();
    observedStatus = 1;
    await send(0, online);
    expect(fetchAgents).toHaveBeenCalledTimes(1);
    expect(client.getQueryData(['agents'])).toBe(1);
    expect(invalidate.mock.calls.map(([options]) => options?.queryKey)).toEqual(
      [['agents'], ['acp-connections'], ['system-status']],
    );
    invalidate.mockClear();
    hook.unmount();
    expect(streams[0]!.close).toHaveBeenCalledTimes(1);
    // No frame is delivered during the disconnect. The status has reverted
    // to the old REST snapshot, but differs from the last applied live frame.
    const reconnected = renderHook(() => useServerEvents(), {
      wrapper: provider(client),
    });
    observedStatus = 2;
    await send(1, offline);
    expect(invalidate).toHaveBeenCalledTimes(3);
    expect(fetchAgents).toHaveBeenCalledTimes(2);
    expect(client.getQueryData(['agents'])).toBe(2);
    invalidate.mockClear();
    await send(1, { connections: [], connected: false });
    expect(invalidate).not.toHaveBeenCalled();
    await send(1, online);
    invalidate.mockClear();
    // Preserve changes beyond id/status, even when connection identity is unchanged.
    await send(1, {
      ...online,
      connections: [{ ...online.connections[0], detail: 'changed' }],
    });
    expect(invalidate).toHaveBeenCalledTimes(3);
    reconnected.unmount();
    unsubscribe();
    client.clear();
  });

  test('does not reconnect for equivalent fresh captures, but reconnects once per authority epoch or native binding change', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const hook = renderHook(() => useServerEvents(), {
      wrapper: provider(client),
    });
    const streamA1 = streams[0]!;

    hook.rerender();
    hook.rerender();
    hook.rerender();
    expect(streams).toHaveLength(1);
    expect(streamA1.close).not.toHaveBeenCalled();

    host.authorityGeneration = 2;
    hook.rerender();
    expect(streams).toHaveLength(2);
    expect(streamA1.close).toHaveBeenCalledTimes(1);

    const streamA2 = streams[1]!;
    host.bindingId = 'binding-b';
    hook.rerender();
    expect(streams).toHaveLength(3);
    expect(streamA2.close).toHaveBeenCalledTimes(1);

    // A -> B -> A creates a new authority epoch.  The original stream must
    // not acquire the later A cache merely because its binding id matches.
    host.bindingId = 'binding-a';
    host.activationEpoch = 'activation-a-2';
    host.authorityGeneration = 3;
    hook.rerender();
    const currentAuthority = {
      apiBase: 'https://station.test',
      authorityKey: JSON.stringify([
        'native-station',
        'activation-a-2',
        3,
        'device-session',
        'binding-a',
      ]),
    };
    const key = answerBasisQueries.answer(
      'session-a',
      'turn-a',
      currentAuthority,
    ).queryKey;
    client.setQueryData(key, { policy: 'current-a' });
    await act(async () => {
      streamA1.onMessage({
        event: SERVER_EVENTS.ANSWER_ASSESSMENT_UPDATED,
        data: JSON.stringify({
          sessionId: 'session-a',
          turnId: 'turn-a',
          revision: 2,
          active: false,
        }),
      });
    });
    expect(client.getQueryData(key)).toEqual({ policy: 'current-a' });
  });
});
