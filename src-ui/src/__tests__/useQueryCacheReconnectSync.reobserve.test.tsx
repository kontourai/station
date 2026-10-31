/**
 * @vitest-environment jsdom
 *
 * A route-only outage (a VPN dropping while Wi-Fi stays up) fires no browser
 * `online` event, so a failed authority observation is re-read on the
 * connection coordinator's own transition into `connected`.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const connection = vi.hoisted(() => ({
  status: 'error' as 'connected' | 'connecting' | 'error',
}));

vi.mock('@kontourai/station-connect', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-connect')>()),
  useConnections: () => ({ activeConnection: null }),
  useConnectionStatus: () => ({
    status: connection.status,
    checking: false,
    reason: null,
    blocked: false,
    recheck: vi.fn(),
  }),
}));

vi.mock('../lib/serverHealth', () => ({
  checkServerHealth: vi.fn(),
  probeServerConnection: vi.fn(),
}));

import { AuthorityPersistenceContext } from '../contexts/AuthorityPersistenceContext';
import { useQueryCacheReconnectSync } from '../hooks/useQueryCacheReconnectSync';

function Sync() {
  useQueryCacheReconnectSync();
  return null;
}

function mount(reobserve?: () => void) {
  const client = new QueryClient();
  const tree = () => (
    <QueryClientProvider client={client}>
      <AuthorityPersistenceContext.Provider
        value={{
          status: reobserve ? 'unverified' : 'verified',
          namespace: null,
          observation: null,
          ...(reobserve ? { reobserve } : {}),
        }}
      >
        <Sync />
      </AuthorityPersistenceContext.Provider>
    </QueryClientProvider>
  );
  const view = render(tree());
  return { rerender: () => view.rerender(tree()), client };
}

afterEach(() => {
  connection.status = 'error';
});

describe('useQueryCacheReconnectSync and a failed authority observation', () => {
  it('re-reads the observation when the connection comes back, once per transition', () => {
    const reobserve = vi.fn();
    const view = mount(reobserve);
    expect(reobserve).not.toHaveBeenCalled();

    connection.status = 'connected';
    act(() => view.rerender());
    expect(reobserve).toHaveBeenCalledTimes(1);

    // Staying connected is not a transition.
    act(() => view.rerender());
    expect(reobserve).toHaveBeenCalledTimes(1);

    connection.status = 'connecting';
    act(() => view.rerender());
    connection.status = 'connected';
    act(() => view.rerender());
    expect(reobserve).toHaveBeenCalledTimes(2);
    view.client.clear();
  });

  it('does not re-read the failed observation that mounted it', () => {
    // The fallback tree mounts after that read failed, usually while the
    // connection is already up. Re-reading at once put the tree back behind
    // the access check, which remounted it and re-read again, so the app
    // never left "Checking Station access".
    connection.status = 'connected';
    const reobserve = vi.fn();
    const view = mount(reobserve);
    act(() => view.rerender());
    expect(reobserve).not.toHaveBeenCalled();

    connection.status = 'connecting';
    act(() => view.rerender());
    connection.status = 'connected';
    act(() => view.rerender());
    expect(reobserve).toHaveBeenCalledTimes(1);
    view.client.clear();
  });

  it('asks nothing of a verified authority, which offers no re-read', () => {
    const view = mount();
    connection.status = 'connected';
    expect(() => act(() => view.rerender())).not.toThrow();
    view.client.clear();
  });
});
