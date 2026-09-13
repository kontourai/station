/**
 * @vitest-environment jsdom
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ConnectedServerUpdateContext } from '../hooks/useConnectedServerUpdateContext';

/**
 * update-ux PR4 fault-injection host: these tests run against the REAL SDK
 * query hook and a real QueryClient, because the A→B isolation they pin is a
 * property of the CACHE KEY — invisible to any test that mocks the hook.
 *
 * Reverting the scope-key inclusion in `useCoreUpdateStatusQuery` makes both
 * selections share one cache entry: selection B then renders selection A's
 * comparison facts from cache without a request, and the middle assertion
 * below fails.
 */
const { CoreUpdateCheck } = await import('../views/settings/CoreUpdateCheck');

const API_BASE = 'http://localhost:4311';

function makeContext(scopeKey: string): ConnectedServerUpdateContext {
  return {
    scopeKey,
    apiBase: API_BASE,
    connectionName: scopeKey,
    reachability: 'connected',
    kind: 'remote-server',
    identity: null,
    identitySettled: true,
    identityReady: true,
    nativeObservationPending: false,
    claimedOwnerUnresolved: false,
    isCurrent: () => true,
  };
}

function checkoutStatus(behind: number) {
  return {
    installKind: 'source-checkout',
    applyMethod: 'git-pull',
    branch: 'main',
    currentHash: behind === 2 ? 'aaaaaaa' : 'ccccccc',
    remoteHash: 'bbbbbbb',
    behind,
    ahead: 0,
    updateAvailable: behind > 0,
  };
}

describe('CoreUpdateCheck scope isolation (real query cache)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test('A→B→A: each selection answers from its own scope, never the other’s cache', async () => {
    const fetchMock = vi.fn();
    let body = checkoutStatus(2);
    fetchMock.mockImplementation(async () => Response.json(body));
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const tree = (scopeKey: string) => (
      <QueryClientProvider client={client}>
        <CoreUpdateCheck
          apiBase={API_BASE}
          enabled
          context={makeContext(scopeKey)}
        />
      </QueryClientProvider>
    );
    const view = render(tree('scope-a'));

    expect(
      await screen.findByText(
        'Server checkout is 2 commits behind its configured upstream.',
      ),
    ).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Selection B: MUST issue its own request and render its own facts.
    body = checkoutStatus(5);
    view.rerender(tree('scope-b'));
    expect(
      await screen.findByText(
        'Server checkout is 5 commits behind its configured upstream.',
      ),
    ).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Back to A: the fresh A entry answers from cache — with A's facts.
    body = checkoutStatus(9);
    view.rerender(tree('scope-a'));
    expect(
      await screen.findByText(
        'Server checkout is 2 commits behind its configured upstream.',
      ),
    ).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    view.unmount();
    client.clear();
  });
});
