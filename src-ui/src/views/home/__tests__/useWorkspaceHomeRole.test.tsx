/** @vitest-environment jsdom */

import {
  createWorkspaceHomeRoleGrant,
  WORKSPACE_HOME_PROJECTION_FIELDS,
} from '@kontourai/station-contracts/workspace-home-role';
import { _setApiBase } from '@kontourai/station-sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';

/**
 * The client authority projection is fail-closed (archive#3122,
 * re-). The status rides the shared TanStack Query cache,
 * so "no client cache" would be a false claim — the enforceable rule is
 * that a cached `granted` never survives the server being unable to affirm
 * it: an errored read projects to `undefined` (the floor), and revocation
 * transitions to the floor optimistically. These tests drive the REAL SDK
 * query/mutation legs over a stubbed wire — nothing between the hook and
 * `fetch` is mocked.
 */

const registrySeam = vi.hoisted(() => ({
  subscribers: [] as Array<() => void>,
}));

vi.mock('../../../core/PluginRegistry', () => ({
  pluginRegistry: {
    subscribe: (callback: () => void) => {
      registrySeam.subscribers.push(callback);
      return () => {};
    },
  },
}));

import {
  useRevokeWorkspaceHomeRole,
  useWorkspaceHomeRoleStatus,
} from '../useWorkspaceHomeRole';

const PLUGIN_ID = 'third-party-home';

const grant = createWorkspaceHomeRoleGrant({
  descriptor: {
    version: '1.0',
    id: `pane:plugin%3A${PLUGIN_ID}:home`,
    name: 'Home',
    rendererId: `renderer:plugin:${PLUGIN_ID}:home`,
    renderer: { kind: 'plugin-component', name: 'third-party-home-surface' },
    requiredRendererCapabilities: ['trusted-plugin-react'],
    placement: {
      supportedRegions: ['standalone'],
      preferredRegion: 'standalone',
    },
    modes: [{ id: 'default' }],
    provenance: { origin: 'plugin', pluginId: PLUGIN_ID },
    lifecycle: { stage: 'stable' },
  },
  contribution: {
    id: `plugin:${PLUGIN_ID}:pane-abc123def456`,
    version: '3.1.0',
    sourceIdentity: {
      id: PLUGIN_ID,
      kind: 'local',
      source: `plugins/${PLUGIN_ID}`,
    },
    provenance: { origin: 'plugin', pluginId: PLUGIN_ID },
  },
  grantedAt: '2026-08-20T12:00:00.000Z',
  projectionFields: WORKSPACE_HOME_PROJECTION_FIELDS,
});

if (!grant) {
  throw new Error('fixture grant must satisfy the contract constructor');
}

const grantedResponse = () => ({
  ok: true,
  status: 200,
  json: async () => ({ success: true, status: { state: 'granted', grant } }),
});

const unavailableResponse = () => ({
  ok: false,
  status: 503,
  json: async () => ({
    success: false,
    error: 'Home role store is unavailable',
  }),
});

function harness() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, wrapper };
}

afterEach(() => {
  registrySeam.subscribers = [];
  vi.unstubAllGlobals();
});

test('a cached granted status does not survive the server failing to affirm it — the floor projects', async () => {
  _setApiBase('http://station.test');
  let serverHealthy = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      serverHealthy ? grantedResponse() : unavailableResponse(),
    ),
  );
  const { queryClient, wrapper } = harness();
  const rendered = renderHook(() => useWorkspaceHomeRoleStatus(), { wrapper });
  await waitFor(() =>
    expect(rendered.result.current).toMatchObject({ state: 'granted' }),
  );

// The grant store becomes unreadable: the server 503s. A plugin registry
// reload (the hook's own revalidation seam) triggers the refetch.
  serverHealthy = false;
  act(() => {
    for (const notify of registrySeam.subscribers) notify();
  });

// The hook's own retry policy (one retry, ~1s default backoff) must
// exhaust before the error state lands; the window is bounded by design.
  await waitFor(() => expect(rendered.result.current).toBeUndefined(), {
    timeout: 4000,
  });
// The stale granted payload is genuinely still in the query cache — the
// authority projection, not cache absence, is what kept it from mounting.
  expect(queryClient.getQueryData(['workspace-home-role'])).toMatchObject({
    state: 'granted',
  });
});

test('revocation transitions to the floor optimistically, before the wire answers', async () => {
  _setApiBase('http://station.test');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: unknown, init?: { method?: string }) => {
      if (init?.method === 'DELETE') {
// A wire that never answers: the floor must not wait for it.
        return new Promise(() => {});
      }
      return grantedResponse();
    }),
  );
  const { wrapper } = harness();
  const rendered = renderHook(
    () => ({
      status: useWorkspaceHomeRoleStatus(),
      revoke: useRevokeWorkspaceHomeRole(),
    }),
    { wrapper },
  );
  await waitFor(() =>
    expect(rendered.result.current.status).toMatchObject({ state: 'granted' }),
  );

  act(() => {
    rendered.result.current.revoke();
  });

  await waitFor(() =>
    expect(rendered.result.current.status).toEqual({ state: 'none' }),
  );
});
