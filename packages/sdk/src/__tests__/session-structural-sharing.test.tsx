/** @vitest-environment jsdom */
import type { OrchestrationSessionSummary } from '@kontourai/station-contracts/orchestration';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { _setApiBase } from '../api-core';
import { setClientCredentialResolver } from '../client/http';
import { useOrchestrationSessionsQuery } from '../query-domains/chatRuntimeOrchestration';
import { useBoardRecentWorkQuery } from '../query-domains/personalBoards';

const first = '2026-10-17T12:00:00.000Z';
const second = '2026-10-17T12:00:10.000Z';
const third = '2026-10-17T12:00:20.000Z';

function sessions(observedAt: string): OrchestrationSessionSummary[] {
  return Array.from({ length: 5 }, (_, index) => ({
    threadId: `finished-${index}`,
    provider: 'claude',
    status: 'closed',
    lifecycleState: 'completed',
    controlMode: 'station-owned',
    isLoaded: false,
    isPersisted: true,
    eventCount: 1,
    createdAt: first,
    updatedAt: first,
    answerability: {
      answerable: false,
      qualification: 'past_resume',
      observedBy: 'station-A',
      observedAt,
    },
    childWork: {
      children: { observability: 'reported', running: [], observedAt },
    },
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  setClientCredentialResolver();
});

test.each([
  ['sessions', () => useOrchestrationSessionsQuery()],
  [
    'board recent work',
    () =>
      useBoardRecentWorkQuery({
        apiBase: 'http://station.test',
        authorityKey: 'personal',
      }),
  ],
] as const)(
  '%s retains rows across observation clocks but exposes changed verdicts and work',
  async (_name, useSessions) => {
    _setApiBase('http://station.test');
    setClientCredentialResolver();
    let response = sessions(first);
    const fetcher = vi.fn(async () =>
      Response.json({ success: true, data: response }),
    );
    vi.stubGlobal('fetch', fetcher);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const view = renderHook(useSessions, {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
    try {
      await waitFor(() => expect(view.result.current.isSuccess).toBe(true));
      const before = view.result.current.data!;
      response = sessions(second);
      let refetched: OrchestrationSessionSummary[] | undefined;
      await act(async () => {
        refetched = (await view.result.current.refetch()).data;
      });
      expect(refetched).toBe(before);
      expect(view.result.current.data).toBe(before);
      for (const [index, row] of before.entries())
        expect(view.result.current.data![index]).toBe(row);
      expect(view.result.current.data![0].answerability).toMatchObject({
        observedAt: first,
      });

      response = sessions(third);
      response[0].lifecycleState = 'idle';
      response[0].status = 'ready';
      response[0].answerability = {
        answerable: false,
        qualification: 'provider_absent',
        observedBy: 'station-A',
        observedAt: third,
      };
      response[1].answerability = {
        answerable: false,
        qualification: 'past_resume',
        observedBy: 'station-B',
        observedAt: third,
      };
      response[2].answerability = { answerable: true };
      response[3].childWork = {
        children: {
          observability: 'not-reported',
          reason: 'Engine stopped reporting',
        },
      };
      await act(async () => {
        refetched = (await view.result.current.refetch()).data;
      });
      await waitFor(() => expect(view.result.current.data).toBe(refetched));
      const changed = view.result.current.data!;
      expect(refetched).toBe(changed);
      expect(changed).not.toBe(before);
      for (const index of [0, 1, 2, 3])
        expect(changed[index]).not.toBe(before[index]);
      expect(changed[0].answerability).toEqual(response[0].answerability);
      expect(changed[1].answerability).toEqual(response[1].answerability);
      expect(changed[2].answerability).toEqual({ answerable: true });
      expect(changed[3].childWork).toEqual(response[3].childWork);
      expect(changed[4]).toBe(before[4]);

      response = [...response].reverse();
      await act(async () => {
        refetched = (await view.result.current.refetch()).data;
      });
      await waitFor(() => expect(view.result.current.data).toBe(refetched));
      expect(view.result.current.data).not.toBe(changed);
      for (const [index, row] of changed.entries())
        expect(view.result.current.data![4 - index]).toBe(row);
      expect(fetcher).toHaveBeenCalledTimes(4);
    } finally {
      view.unmount();
      client.clear();
    }
  },
);
