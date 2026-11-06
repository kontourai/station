// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { setClientCredentialResolver } from '../client/http';
import type { ConnectionReadTarget } from '../connection-read-target';
import { useAgentsQuery } from '../query-domains/agentAdmin';
import { useConversationInventoryQuery } from '../query-domains/chatRuntimeConversations';
import { useOrchestrationSessionsQuery } from '../query-domains/chatRuntimeOrchestration';
import { useEngineConnectionsQuery } from '../query-domains/workspaceConnections';
import { useProjectQuery } from '../query-domains/workspaceProjects';

afterEach(() => {
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});

function useReads(readTarget: ConnectionReadTarget) {
  return {
    agents: useAgentsQuery({ readTarget }),
    engines: useEngineConnectionsQuery({ readTarget }),
    sessions: useOrchestrationSessionsQuery({ readTarget }),
    inventory: useConversationInventoryQuery({ readTarget }),
    project: useProjectQuery('same', { readTarget }),
  };
}

it('concurrent catalog, sessions, inventory and Project readers fetch and cache their explicit relay target', async () => {
  const source = 'https://source.test';
  const scope = { apiBase: source, authorityKey: 'source-owner' };
  const a = {
    targetApiBase: `${source}/peer/a/chat-api`,
    requestScope: scope,
    runtimeKey: 'lease-a',
  };
  const b = {
    targetApiBase: `${source}/peer/b/chat-api`,
    requestScope: scope,
    runtimeKey: 'lease-b',
  };
  const seen: string[] = [];
  setClientCredentialResolver((selector) => {
    expect(selector?.requestScope).toEqual(scope);
    return {
      origin: source,
      credential: 'source-device',
      requestAuthority: { ...scope, isCurrent: () => true },
    };
  });
  vi.stubGlobal(
    'fetch',
    vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async (input, options) => {
        const url = String(input);
        seen.push(url);
        expect(new Headers(options?.headers).get('Authorization')).toBe(
          'Bearer source-device',
        );
        if (url.endsWith('/api/agents'))
          return Response.json({
            success: true,
            data: [],
            catalogState: 'current',
            catalogAsOf: '2026-11-04T00:00:00Z',
          });
        if (url.includes('/api/conversations'))
          return Response.json({
            success: true,
            data: { items: [], hasMore: false },
          });
        if (url.endsWith('/api/projects/same'))
          return Response.json({
            success: true,
            data: { slug: 'same', name: url.includes('/peer/a/') ? 'A' : 'B' },
          });
        if (
          url.endsWith('/api/connections/agents') ||
          url.endsWith('/api/orchestration/sessions/read-model')
        )
          return Response.json({ success: true, data: [] });
        throw new Error(`Unexpected target read: ${url}`);
      }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(() => ({ a: useReads(a), b: useReads(b) }), {
    wrapper,
  });
  await waitFor(() => {
    for (const target of Object.values(hook.result.current))
      for (const query of Object.values(target))
        expect(query.isSuccess).toBe(true);
  });
  for (const target of [a, b]) {
    expect(
      seen.filter((url) => url.startsWith(`${target.targetApiBase}/`)),
    ).toHaveLength(5);
    expect(
      client.getQueryData([
        'projects',
        target.targetApiBase,
        scope.authorityKey,
        target.runtimeKey,
        'detail',
        'same',
      ]),
    ).toMatchObject({ name: target === a ? 'A' : 'B' });
    expect(
      client.getQueryData([
        'orchestration-sessions',
        target.targetApiBase,
        scope.authorityKey,
        target.runtimeKey,
      ]),
    ).toEqual([]);
  }
  hook.unmount();
  client.clear();
});
