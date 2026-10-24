/** @vitest-environment jsdom */

import {
  dehydrate,
  hydrate,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { _setApiBase } from '../api-core';
import { useModelPickerCatalogQuery } from '../query-domains/workspaceConnections';

afterEach(() => vi.unstubAllGlobals());

test('an invalidated persisted model picker refreshes readiness when opened', async () => {
  _setApiBase('https://station.example.test');
  const saved = new QueryClient();
  saved.setQueryData(['model-picker-catalog'], {
    agentConnections: [],
    modelConnections: [],
    excluded: { agents: 0, models: 0 },
  });
  const client = new QueryClient({
    defaultOptions: {
      queries: { refetchOnMount: false, retry: false, staleTime: Infinity },
    },
  });
  hydrate(client, dehydrate(saved));
  const fetchMock = vi.fn(async (url: string) =>
    Response.json({
      success: true,
      data: url.endsWith('/agents')
        ? [
            {
              id: 'oc',
              kind: 'agent',
              type: 'acp',
              name: 'OpenCode',
              status: 'ready',
              enabled: true,
              capabilities: ['agent-runtime'],
              config: {},
              setup: { state: 'ready', detected: true, configured: true },
            },
          ]
        : [],
    }),
  );
  vi.stubGlobal('fetch', fetchMock);
  await client.invalidateQueries({ queryKey: ['model-picker-catalog'] });
  expect(fetchMock).not.toHaveBeenCalled();
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  }
  const view = renderHook(() => useModelPickerCatalogQuery(), {
    wrapper: Wrapper,
  });
  try {
    await waitFor(() =>
      expect(view.result.current.data?.agentConnections).toMatchObject([
        { id: 'oc', name: 'OpenCode', status: 'ready' },
      ]),
    );
    expect(view.result.current.isError).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  } finally {
    view.unmount();
    client.clear();
    saved.clear();
  }
});
