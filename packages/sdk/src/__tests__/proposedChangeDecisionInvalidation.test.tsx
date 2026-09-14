/**
 * @vitest-environment jsdom
 */

import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../api', () => ({
  _getApiBase: vi.fn().mockResolvedValue('http://station.test'),
}));

import {
  useApproveProposedChangeMutation,
  useBulkApproveProposedChangesMutation,
  useBulkRejectProposedChangesMutation,
  useRejectProposedChangeMutation,
} from '../query-domains/proposedChanges';

/**
 * station#2064 review MED-1: deciding a proposed change must refresh the
 * ATTENTION projection, not only the proposed-change list.
 *
 * A pending change is an attention item, so after Approve the inbox row kept
 * offering Approve/Reject until `/api/attention`'s 10s poll came round — and a
 * second, entirely reasonable click answered a change that was already
 * decided, which the store refuses. The bell's number stayed wrong for the
 * same window.
 *
 * Run against a REAL QueryClient with a REAL observed attention query rather
 * than asserting the `invalidateKeys` array: the config is not the behaviour.
 * `invalidateQueries` only refetches ACTIVE queries, so a key that is merely
 * listed proves nothing about whether a mounted consumer actually re-reads.
 * Counting the attention fetches across the mutation is what does.
 */
const ATTENTION_KEY = ['attention', 'http://station.test'];

function wrapperFor(client: QueryClient) {
  return function QueryWrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };
}

const decisions = {
  approve: {
    label: 'approve',
    hook: useApproveProposedChangeMutation,
    input: { id: 'change-1', decision: { reason: 'Approved' } },
    data: { id: 'change-1' },
  },
  reject: {
    label: 'reject',
    hook: useRejectProposedChangeMutation,
    input: { id: 'change-1', decision: { reason: 'Rejected' } },
    data: { id: 'change-1' },
  },
  bulkApprove: {
    label: 'bulk approve',
    hook: useBulkApproveProposedChangesMutation,
    input: { ids: ['change-1'], reason: 'Bulk approved' },
    data: [{ id: 'change-1' }],
  },
  bulkReject: {
    label: 'bulk reject',
    hook: useBulkRejectProposedChangesMutation,
    input: { ids: ['change-1'], reason: 'Bulk rejected' },
    data: [{ id: 'change-1' }],
  },
} as const;

describe('a proposed-change decision refreshes the attention inbox', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  for (const key of Object.keys(decisions) as (keyof typeof decisions)[]) {
    const decision = decisions[key];
    test(`${decision.label} triggers an attention refetch`, async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ success: true, data: decision.data }),
        } as Response),
      );
      let attentionFetches = 0;
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const rendered = renderHook(
        () => ({
          attention: useQuery({
            queryKey: ATTENTION_KEY,
            queryFn: async () => {
              attentionFetches += 1;
              return { items: [], pendingCount: 0 };
            },
          }),
          mutation: decision.hook(),
        }),
        { wrapper: wrapperFor(client) },
      );

      await waitFor(() => expect(attentionFetches).toBe(1));

      await act(async () => {
        // `mutateAsync` so the assertion follows the settled mutation rather
        // than racing its onSuccess.
        await rendered.result.current.mutation.mutateAsync(
          decision.input as never,
        );
      });

      await waitFor(() => expect(attentionFetches).toBe(2));
    });
  }
});
