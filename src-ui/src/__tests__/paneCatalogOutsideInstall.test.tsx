/**
 * @vitest-environment jsdom
 *
 * #2319 — a plugin installed, updated or removed OUTSIDE this tab (the CLI,
 * another tab or device, an earlier browser session, an agent) must reach the
 * Project pane catalog without the user clearing IndexedDB.
 *
 * Runs on the production pieces: the authority client's query defaults
 * (`refetchOnMount: false`), the real persist options with only the IndexedDB
 * storage swapped for an in-memory one whose restore the test releases, the
 * real reconnect sync, the real server-event invalidation table, and the SDK
 * pane-catalog hook every catalog surface reads through.
 */
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { _setApiBase } from '@kontourai/station-sdk';
import { useProjectWorkspacePanesQuery } from '@kontourai/station-sdk/workspace-pane';
import {
  dehydrate,
  type QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const connection = vi.hoisted(() => ({
  status: 'connected' as 'connected' | 'connecting' | 'error',
}));

vi.mock('@kontourai/station-connect', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-connect')>()),
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

// The lifecycle events also reload the plugin registry lazily; that reload is
// pinned in useServerEvents-grants-changed.test.tsx and is not under test here.
vi.mock('../core/PluginRegistry', () => ({
  pluginRegistry: { reload: vi.fn() },
}));

import { createAuthorityClient } from '../contexts/AuthorityQueryContext';
import { useQueryCacheReconnectSync } from '../hooks/useQueryCacheReconnectSync';
import { invalidateQueriesForServerEvent } from '../hooks/useServerEvents';
import {
  buildPersistOptions,
  QUERY_PERSISTENCE_STORAGE_KEY,
  queryPersistenceBuster,
  shouldPersistQuery,
} from '../lib/queryPersistence';

const API_BASE = 'https://station.example.test';
const PANES_URL = `${API_BASE}/api/projects/alpha/panes`;
const PLUGIN_PANE = 'plugin:connected-pulse:pane';

function paneCatalog(descriptorIds: string[]) {
  return {
    projectId: 'project-alpha',
    projectSlug: 'alpha',
    descriptors: descriptorIds.map((id) => ({ id })),
    instances: [],
  };
}

let serverCatalog = paneCatalog(['builtin-files', PLUGIN_PANE]);
async function serveCatalog(input: RequestInfo | URL) {
  const url = String(input);
  if (url !== PANES_URL) throw new Error(`unexpected request ${url}`);
  return new Response(JSON.stringify({ success: true, data: serverCatalog }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
const fetchMock = vi.fn(serveCatalog);

function paneRequests(): number {
  return fetchMock.mock.calls.filter(([input]) => String(input) === PANES_URL)
    .length;
}

beforeEach(() => {
  connection.status = 'connected';
  serverCatalog = paneCatalog(['builtin-files', PLUGIN_PANE]);
  fetchMock.mockClear();
  fetchMock.mockImplementation(serveCatalog);
  vi.stubGlobal('fetch', fetchMock);
  _setApiBase(API_BASE);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * The IndexedDB blob an earlier browser session left behind: a catalog read
 * BEFORE the plugin was installed elsewhere. Its age is "just now" on purpose,
 * so nothing but an explicit revalidation can replace it.
 */
function persistedBlobHoldingOldCatalog(): string {
  const earlierSession = createAuthorityClient();
  earlierSession.setQueryData(
    ['projects', 'alpha', 'panes'],
    paneCatalog(['builtin-files']),
  );
  return JSON.stringify({
    buster: queryPersistenceBuster(),
    timestamp: Date.now(),
    clientState: dehydrate(earlierSession, {
      shouldDehydrateQuery: shouldPersistQuery,
    }),
  });
}

/**
 * In-memory stand-in for the IndexedDB storage whose read the test releases,
 * so the connection is confirmed BEFORE the restore lands — the order a real
 * cold boot has, since App mounts only after the authority gate has heard
 * from the server.
 */
function gatedStorage(blob: string) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    release,
    storage: {
      getItem: async (key: string) => {
        await released;
        return key === QUERY_PERSISTENCE_STORAGE_KEY ? blob : undefined;
      },
      setItem: async () => undefined,
      removeItem: async () => undefined,
    },
  };
}

function CatalogProbe() {
  const { data } = useProjectWorkspacePanesQuery('alpha');
  const ids = (
    (data as { descriptors?: Array<{ id: string }> } | undefined)
      ?.descriptors ?? []
  ).map((descriptor) => descriptor.id);
  return <output data-testid="pane-catalog">{ids.join(',')}</output>;
}

function AppShell({ showCatalog }: { showCatalog: boolean }) {
  useQueryCacheReconnectSync();
  return showCatalog ? <CatalogProbe /> : null;
}

function renderRestoringApp(client: QueryClient, showCatalog: boolean) {
  const { storage, release } = gatedStorage(persistedBlobHoldingOldCatalog());
  const persistOptions = buildPersistOptions({ storage, throttleTime: 0 });
  const tree = (show: boolean) => (
    <PersistQueryClientProvider client={client} persistOptions={persistOptions}>
      <AppShell showCatalog={show} />
    </PersistQueryClientProvider>
  );
  const view = render(tree(showCatalog));
  return {
    release: () => act(async () => release()),
    showCatalog: () => view.rerender(tree(true)),
  };
}

const paneQueryState = (client: QueryClient) =>
  client.getQueryState(['projects', 'alpha', 'panes']);

describe('a plugin installed outside this tab reaches the pane catalog (#2319)', () => {
  it('revalidates a restored catalog on the first connect, when the connection was already confirmed before the app mounted', async () => {
    const client = createAuthorityClient();
    const app = renderRestoringApp(client, true);

    await app.release();

    await waitFor(() =>
      expect(screen.getByTestId('pane-catalog').textContent).toBe(
        `builtin-files,${PLUGIN_PANE}`,
      ),
    );
    expect(paneRequests()).toBe(1);
  });

  it('revalidates when the picker mounts later, after the boot sync ran with no catalog observer', async () => {
    const client = createAuthorityClient();
    const app = renderRestoringApp(client, false);

    await app.release();
    // The restored snapshot landed and the boot sync marked it invalidated;
    // nothing observes it, so nothing has fetched yet.
    await waitFor(() =>
      expect(paneQueryState(client)?.isInvalidated).toBe(true),
    );
    expect(paneRequests()).toBe(0);

    app.showCatalog();

    await waitFor(() =>
      expect(screen.getByTestId('pane-catalog').textContent).toBe(
        `builtin-files,${PLUGIN_PANE}`,
      ),
    );
    expect(paneRequests()).toBe(1);
  });

  it('does not refetch again once revalidated: rerenders and remounts keep the fresh answer', async () => {
    const client = createAuthorityClient();
    const app = renderRestoringApp(client, true);
    await app.release();
    await waitFor(() => expect(paneRequests()).toBe(1));
    await waitFor(() =>
      expect(paneQueryState(client)?.isInvalidated).toBe(false),
    );

    app.showCatalog();
    render(
      <QueryClientProvider client={client}>
        <CatalogProbe />
      </QueryClientProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(paneRequests()).toBe(1);
  });
});

describe('a plugin lifecycle server event reaches a catalog that is not on screen (#2319)', () => {
  it.each([
    {
      event: SERVER_EVENTS.PLUGINS_INSTALLED,
      cached: ['builtin-files'],
      server: ['builtin-files', PLUGIN_PANE],
    },
    {
      event: SERVER_EVENTS.PLUGINS_UPDATED,
      cached: ['builtin-files', PLUGIN_PANE],
      server: ['builtin-files', PLUGIN_PANE, 'plugin:connected-pulse:detail'],
    },
    {
      event: SERVER_EVENTS.PLUGINS_REMOVED,
      cached: ['builtin-files', PLUGIN_PANE],
      server: ['builtin-files'],
    },
  ])(
    '$event while the catalog is unmounted refreshes it on the next mount',
    async ({ event, cached, server }) => {
      const client = createAuthorityClient();
      client.setQueryData(['projects', 'alpha', 'panes'], paneCatalog(cached));
      serverCatalog = paneCatalog(server);

      invalidateQueriesForServerEvent(event, client);
      expect(paneRequests()).toBe(0);

      render(
        <QueryClientProvider client={client}>
          <CatalogProbe />
        </QueryClientProvider>,
      );

      await waitFor(() =>
        expect(screen.getByTestId('pane-catalog').textContent).toBe(
          server.join(','),
        ),
      );
      expect(paneRequests()).toBe(1);
    },
  );
});

describe('a failed revalidation keeps the cached catalog (#2319)', () => {
  it('reports isError while keeping the previous answer in data', async () => {
    fetchMock.mockImplementation(async () => {
      throw new TypeError('Failed to fetch');
    });
    const client = createAuthorityClient();
    client.setQueryData(
      ['projects', 'alpha', 'panes'],
      paneCatalog(['builtin-files', PLUGIN_PANE]),
    );
    await client.invalidateQueries({ queryKey: ['projects'] });

    render(
      <QueryClientProvider client={client}>
        <CatalogProbe />
      </QueryClientProvider>,
    );

    // `retry: 1` from the authority client: two attempts, then settled.
    // The retry waits ~1s, so give it room on a loaded host.
    await waitFor(() => expect(paneQueryState(client)?.status).toBe('error'), {
      timeout: 10_000,
    });
    expect(paneRequests()).toBeGreaterThan(0);
    expect(paneQueryState(client)?.data).toEqual(
      paneCatalog(['builtin-files', PLUGIN_PANE]),
    );
    // What consumers must render: the cached answer, not an error screen.
    expect(screen.getByTestId('pane-catalog').textContent).toBe(
      `builtin-files,${PLUGIN_PANE}`,
    );
  }, 15_000);
});
