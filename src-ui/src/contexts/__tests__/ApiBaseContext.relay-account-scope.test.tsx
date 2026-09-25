/** @vitest-environment jsdom */

import { useConnections } from '@kontourai/station-connect';
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  browserRelayAccountScopeKey,
  publishBrowserRelayAccountScope,
} from '../../lib/browserRelayAccountScope';
import {
  ApiBaseProvider,
  useHostRequestAuthorityScope,
} from '../ApiBaseContext';

vi.mock('../../platform/PlatformProfileContext', () => ({
  nativeProfileRepository: () => {
    throw new Error('browser relay scope must not use native profile storage');
  },
  useNativeProfileSelection: () => async () => {},
  useNativeProfileStoreEpoch: () => 0,
  usePlatformProfile: () => ({
    isTauri: false,
    target: 'web',
    isMobile: false,
    isDesktop: false,
    supervisesBundledServer: false,
    isDevBuild: false,
  }),
}));

vi.mock('../../platform/useBundledServerStatus', () => ({
  useBundledServerStatus: () => null,
}));

vi.mock('../../lib/browserRelayRouteRuntime', () => ({
  prepareBrowserRelayRoute: async () => {},
}));

const route = {
  brokerOrigin: 'https://broker.example.test',
  scope: {
    stationId: '11111111-1111-4111-8111-111111111111',
    enrollmentId: '22222222-2222-4222-8222-222222222222',
    routingGeneration: 1,
    browserOrigin: window.location.origin,
  },
};
const applicationOrigin = 'https://station.example.test';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe('relay account request scope', () => {
  it('a browser talking to its own Station directly does not require an enrolled credential (#2598)', async () => {
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <ApiBaseProvider>{children}</ApiBaseProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useHostRequestAuthorityScope(), {
      wrapper,
    });
    // Its own Station authenticates it with a session cookie, which the
    // server enforces; only a relay route or a native transport needs the
    // SDK-owned credential.
    await waitFor(() => expect(result.current).toBeDefined());
    expect(result.current?.requiresEnrolledCredential).toBe(false);
  });

  it('quarantines cache before hydration and changes the real request/query scope from account A to B', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <ApiBaseProvider>{children}</ApiBaseProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(
      () => {
        const connections = useConnections();
        const scope = useHostRequestAuthorityScope();
        const query = useQuery({
          queryKey: ['relay-private-data', scope?.authorityKey ?? 'unhydrated'],
          enabled: Boolean(scope),
          queryFn: async () => `private:${scope?.authorityKey}`,
        });
        return { connections, scope, query };
      },
      { wrapper },
    );

    let connectionId = '';
    act(() => {
      connectionId = result.current.connections.addBrokerRoute({
        name: 'Remote Station',
        applicationOrigin,
        brokerRoute: route,
      }).id;
    });
    await act(async () => {
      await result.current.connections.setActiveConnection(connectionId);
    });

    expect(result.current.scope).toBeUndefined();
    expect(result.current.query.data).toBeUndefined();
    const scopeKey = browserRelayAccountScopeKey({
      connectionId,
      applicationOrigin,
      route,
      clientOrigin: window.location.origin,
    });
    act(() => publishBrowserRelayAccountScope(scopeKey, 'account-A', 1));
    await waitFor(() => expect(result.current.scope).toBeDefined());
    // A relay route must carry the SDK-owned credential (#2598).
    expect(result.current.scope?.requiresEnrolledCredential).toBe(true);
    await waitFor(() =>
      expect(result.current.query.data).toBe(
        `private:${result.current.scope?.authorityKey}`,
      ),
    );
    const oldScope = result.current.scope;
    const oldQueryKey = result.current.query.data;

    act(() => publishBrowserRelayAccountScope(scopeKey, 'account-B', 2));
    await waitFor(() =>
      expect(result.current.scope?.authorityKey).not.toBe(
        oldScope?.authorityKey,
      ),
    );
    await waitFor(() =>
      expect(result.current.query.data).toBe(
        `private:${result.current.scope?.authorityKey}`,
      ),
    );
    expect(oldScope?.isCurrent()).toBe(false);
    expect(result.current.query.data).not.toBe(oldQueryKey);
    expect(result.current.scope?.authorityKey).toContain('account:account-B');
    const accountBScope = result.current.scope;

    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'station-browser-relay-account-scope-event-v1',
          newValue: JSON.stringify({
            route: scopeKey,
            authorityKey: 'account-C',
            version: 3,
            state: 'ready',
          }),
        }),
      );
    });
    await waitFor(() =>
      expect(result.current.scope?.authorityKey).toContain('account:account-C'),
    );
    expect(accountBScope?.isCurrent()).toBe(false);
  });
});
