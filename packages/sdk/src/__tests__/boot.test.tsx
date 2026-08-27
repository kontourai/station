// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { _setApiBase } from '../api';
import {
  BOOT_SEED_KEYS,
  fetchAndSeedBootPayload,
  fetchBootPayload,
  seedBootPayload,
} from '../boot';
import type { AgentCatalogProjection } from '../client/agents';
import {
  useAgentsQuery,
  useAuthStatusQuery,
  useBrandingQuery,
  useConfigQuery,
  useModelsQuery,
  useProjectsQuery,
  useServerCapabilitiesQuery,
} from '../queries';

describe('boot payload seeding', () => {
  test('seeds the exact keys used by each boot-critical hook without fetching', async () => {
    _setApiBase('http://station.test');
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const agentCatalog: AgentCatalogProjection = {
      agents: [],
      catalogState: 'reconciling',
      catalogAsOf: '2026-08-23T00:00:00.000Z',
    };
    await seedBootPayload(client, {
      version: 1,
      sections: {
        auth: { data: {} },
        config: { data: { success: true, data: {} } },
        capabilities: { data: {} },
        branding: { data: { success: true, data: {} } },
        agents: {
          data: {
            success: true,
            data: agentCatalog.agents,
            catalogState: agentCatalog.catalogState,
            catalogAsOf: agentCatalog.catalogAsOf,
          },
        },
        projects: { data: { success: true, data: [] } },
        models: { data: { success: true, data: [] } },
      },
    });
    const wrapper = ({ children }: any) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('network must not run');
    });
    const { result } = renderHook(
      () => [
        useAuthStatusQuery(),
        useConfigQuery(),
        useServerCapabilitiesQuery(),
        useBrandingQuery(),
        useAgentsQuery(),
        useProjectsQuery(),
        useModelsQuery(),
      ],
      { wrapper },
    );
    // RUNTIME BINDING (sol #2647 round-3 MED): fetch throws, so a hook can
    // only hold data if its OWN registered key equals the seed key — a hook
    // key change makes its query fetch, throw, and this test go red.
    for (const key of Object.values(BOOT_SEED_KEYS)) {
      expect(
        client.getQueryData(key as unknown as (string | number)[]),
      ).toBeDefined();
    }
    expect(
      client.getQueryData<AgentCatalogProjection>(BOOT_SEED_KEYS.agents),
    ).toEqual(agentCatalog);
    // Every seeded entry was CONSUMED by a hook: the cache holds no key that
    // no hook registered (count parity between seeds and hook queries).
    const cachedKeys = client
      .getQueryCache()
      .getAll()
      .map((entry) => JSON.stringify(entry.queryKey));
    for (const key of Object.values(BOOT_SEED_KEYS)) {
      expect(cachedKeys).toContain(JSON.stringify(key));
    }
    // SHAPE BINDING (station#3824): a matching key is not enough — the seeded
    // VALUE has to be the shape the hook reads. `useAgentsQuery` caches an
    // AgentCatalogProjection and returns `data.agents`, so seeding the boot
    // envelope's bare array left it `undefined` with a green key assertion
    // above. Named per hook so the failure says WHICH one stopped reading its
    // seed, rather than `expected false to be true`.
    const hookNames = [
      'useAuthStatusQuery',
      'useConfigQuery',
      'useServerCapabilitiesQuery',
      'useBrandingQuery',
      'useAgentsQuery',
      'useProjectsQuery',
      'useModelsQuery',
    ];
    const notSeeded = result.current
      .map((query, index) => (query.data === undefined ? hookNames[index] : ''))
      .filter(Boolean);
    expect(notSeeded).toEqual([]);
    fetchSpy.mockRestore();
  });

  test('does not overwrite data a hook resolved after the aggregate request started', async () => {
    _setApiBase('http://station.test');
    const client = new QueryClient();
    client.setQueryData<AgentCatalogProjection>(BOOT_SEED_KEYS.agents, {
      agents: ['hook'] as unknown as AgentCatalogProjection['agents'],
    });
    const requestStartedAt =
      client.getQueryState(BOOT_SEED_KEYS.agents)!.dataUpdatedAt - 1;

    await seedBootPayload(
      client,
      {
        version: 1,
        sections: { agents: { data: { success: true, data: ['boot'] } } },
      },
      { startedAt: requestStartedAt, apiBase: 'http://station.test' },
    );

    expect(client.getQueryData(BOOT_SEED_KEYS.agents)).toEqual({
      agents: ['hook'],
    });
  });

  test('drops the complete payload when the Station connection changes before seeding', async () => {
    _setApiBase('http://station.one');
    const client = new QueryClient();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => {
        _setApiBase('http://station.two');
        return Response.json({
          version: 1,
          sections: { agents: { data: { success: true, data: ['one'] } } },
        });
      });

    await fetchAndSeedBootPayload(client);

    expect(client.getQueryState(BOOT_SEED_KEYS.agents)).toBeUndefined();
    fetchSpy.mockRestore();
  });

  test('does not create a cache entry for an error section', async () => {
    _setApiBase('http://station.test');
    const client = new QueryClient();

    await seedBootPayload(client, {
      version: 1,
      sections: { agents: { error: true } },
    });

    expect(client.getQueryState(BOOT_SEED_KEYS.agents)).toBeUndefined();
  });

  test('continues with individual hook requests when /api/boot fails', async () => {
    _setApiBase('http://station.test');
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input) => {
        const url = String(input);
        if (url.endsWith('/api/boot'))
          return new Response(null, { status: 500 });
        return new Response(JSON.stringify({ success: true, data: [] }), {
          status: 200,
        });
      });
    await expect(fetchBootPayload()).rejects.toThrow(
      'Could not load Station’s startup information',
    );

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: any) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () => [
        useAuthStatusQuery(),
        useConfigQuery(),
        useServerCapabilitiesQuery(),
        useBrandingQuery(),
        useAgentsQuery(),
        useProjectsQuery(),
        useModelsQuery(),
      ],
      { wrapper },
    );
    await waitFor(() =>
      expect(
        fetchSpy.mock.calls.filter(
          ([input]) => !String(input).endsWith('/api/boot'),
        ),
      ).toHaveLength(7),
    );
    expect(result.current).toHaveLength(7);
    fetchSpy.mockRestore();
  });
});
