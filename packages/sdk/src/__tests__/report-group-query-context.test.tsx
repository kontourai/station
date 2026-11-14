/** @vitest-environment jsdom */
import type { ReportGroupOperation } from '@kontourai/station-contracts/report-group';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { setClientCredentialResolver } from '../client/http';
import { useSyncReportGroupContext } from '../query-domains/reportGroups';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setClientCredentialResolver(undefined);
});

test.each(['authority-loss', 'unmount'] as const)(
  'inactive context rejects its waiting caller and preserves the canonical group cache: %s',
  async (mode) => {
    let current = true;
    const scope = {
      apiBase: 'https://report-scope.test',
      authorityKey: 'authority-a',
      isCurrent: () => current,
    };
    setClientCredentialResolver(() => ({
      origin: scope.apiBase,
      credential: 'controlled',
      requestAuthority: scope,
    }));
    let settle!: (response: Response) => void;
    let signal: AbortSignal | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>((resolve) => {
        settle = resolve;
      });
    });
    vi.stubGlobal('fetch', fetch);
    const client = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const key = ['report-groups', scope.apiBase, scope.authorityKey, null];
    const canonical = { groups: [], hasMore: false, nextGroupId: null };
    client.setQueryData(key, canonical);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const hook = renderHook(() => useSyncReportGroupContext(scope), {
      wrapper,
    });
    let waiting!: Promise<PromiseSettledResult<ReportGroupOperation>>;
    act(() => {
      waiting = hook.result.current
        .mutateAsync({
          groupId: 'group-a',
          command: {
            operationKey: 'sync-a',
            expectedRevision: 1,
            seatId: 'seat-a',
            flowHead: 'a'.repeat(64),
            text: 'Private context',
          },
        })
        .then(
          (value) => ({ status: 'fulfilled' as const, value }),
          (reason: unknown) => ({ status: 'rejected' as const, reason }),
        );
    });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    if (mode === 'authority-loss') {
      current = false;
      hook.rerender();
    } else hook.unmount();
    await waitFor(() => expect(signal?.aborted).toBe(true));
    await act(async () =>
      settle(
        new Response(
          JSON.stringify({
            success: true,
            data: {
              replayed: false,
              group: {
                version: 'station.report-group/v1',
                groupId: 'group-a',
                operationId: 'source',
                revision: 4,
                topology: { kind: 'flow', runId: 'run-a' },
                execution: 'returned',
                cancellation: 'none',
                authorityRevoked: false,
                acceptance: 'unassessed',
                members: [
                  {
                    seatId: 'seat-a',
                    agentId: 'agent-a',
                    taskId: 'task-a',
                    clientTurnId: 'turn-a',
                    requestedModelId: 'model',
                    attempts: [],
                  },
                ],
                contextSyncs: [
                  {
                    operationKey: 'sync-a',
                    seatId: 'seat-a',
                    flowHead: 'a'.repeat(64),
                    state: 'acknowledged',
                    reason: 'exact_ack',
                    preparedDigest: `sha256:${'b'.repeat(64)}`,
                    attempts: [
                      {
                        invocationId: 'sync-one',
                        allocation: {
                          inputTokens: 10,
                          outputTokens: 5,
                          costMicros: 100,
                        },
                        usage: {
                          inputTokens: 2,
                          outputTokens: 1,
                          costMicros: 21,
                        },
                        accountingTerminal: true,
                        terminal: {
                          id: 'terminal-sync',
                          domain: 'station.report-observation.v1',
                          digest: `sha256:${'c'.repeat(64)}`,
                        },
                      },
                    ],
                  },
                ],
              },
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    const outcome = await waiting;
    expect(outcome.status).toBe('rejected');
    if (mode === 'authority-loss') {
      await waitFor(() => expect(hook.result.current.isError).toBe(true));
      expect(hook.result.current.data).toBeUndefined();
    }
    expect(client.getQueryData(key)).toEqual(canonical);
    expect(client.getQueryState(key)?.isInvalidated).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    client.clear();
  },
);
