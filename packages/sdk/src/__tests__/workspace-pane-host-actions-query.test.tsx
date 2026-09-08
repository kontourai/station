/** @vitest-environment jsdom */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { _setApiBase } from '../api-core';
import { setClientCredentialResolver } from '../client/http';
import { useOrchestrationSessionsQuery } from '../query-domains/chatRuntimeOrchestration';
import { useWorkspacePaneHostActionMutation } from '../query-domains/workspacePaneHostActions';
import { orchestrationQueries } from '../queryFactories';

afterEach(() => {
  vi.unstubAllGlobals();
  setClientCredentialResolver();
});

test('a host action refreshes an already-successful empty Session list before Open is exposed', async () => {
  _setApiBase('http://station.test');
  setClientCredentialResolver();
  let invoked = false;
  let sessionReads = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      let data: unknown;
      if (url.endsWith('/prepare'))
        data = { state: 'prepared', ticket: 'a'.repeat(43) };
      else if (url.endsWith('/execute')) {
        invoked = true;
        data = {
          state: 'accepted',
          conversationId: 'created-conversation',
          sessionId: 'created-session',
          turnId: 'turn-one',
        };
      } else if (url.endsWith('/sessions/read-model')) {
        sessionReads++;
        data = invoked
          ? [
              {
                threadId: 'created-session',
                provider: 'muse',
                status: 'idle',
                lifecycleState: 'completed',
                createdAt: '2026-09-04T00:00:00Z',
                updatedAt: '2026-09-04T00:00:00Z',
              },
            ]
          : [];
      } else throw new Error(`Unexpected request ${url}`);
      return new Response(JSON.stringify({ success: true, data }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(orchestrationQueries.sessions().queryKey, []);
  const { result, unmount } = renderHook(
    () => ({
      sessions: useOrchestrationSessionsQuery({
        staleTime: Number.POSITIVE_INFINITY,
      }),
      start: useWorkspacePaneHostActionMutation('project-one'),
    }),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
  try {
    expect(result.current.sessions.data).toEqual([]);
    await act(async () => {
      await result.current.start.mutateAsync({
        pluginId: 'plugin',
        installationGeneration: 'generation-one',
        actionKey: 'action-one',
      });
    });
    await waitFor(() =>
      expect(result.current.sessions.data?.[0]?.threadId).toBe(
        'created-session',
      ),
    );
    expect(sessionReads).toBe(1);
  } finally {
    unmount();
    client.clear();
  }
});
