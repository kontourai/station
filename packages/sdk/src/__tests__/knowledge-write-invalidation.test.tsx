/**
 * @vitest-environment jsdom
 *
 * #2343 review MEDIUM-1 and HIGH-1: every knowledge-document write refreshes
 * the same views. Save and delete used to refresh only the document list, so
 * a created note never reached the namespace tree or a filtered listing, and
 * a deleted one stayed in both. Update refreshed the listings but not the
 * document's cached body, so a reader of that body saw the pre-edit text.
 *
 * Driven through the real mutation hooks and the real read hooks on a real
 * QueryClient, counting fetches of each MOUNTED view: `invalidateQueries`
 * refetches only active queries, so a key that is merely listed proves
 * nothing about what a mounted consumer re-reads.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const api = vi.hoisted(() => ({
  fetchKnowledgeTree: vi.fn(async () => ({ name: '', children: [] })),
  fetchKnowledgeFiltered: vi.fn(async () => []),
  fetchKnowledgeDocContent: vi.fn(async () => 'body'),
  uploadKnowledge: vi.fn(async () => ({ id: 'doc-new' })),
  deleteKnowledgeDoc: vi.fn(async () => undefined),
  bulkDeleteKnowledgeDocs: vi.fn(async () => undefined),
  updateKnowledgeDoc: vi.fn(async () => ({ id: 'doc-1' })),
}));

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  _getApiBase: vi.fn().mockResolvedValue('http://station.test'),
  ...api,
}));

import {
  useKnowledgeBulkDeleteMutation,
  useKnowledgeDeleteMutation,
  useKnowledgeDocContentQuery,
  useKnowledgeFilteredQuery,
  useKnowledgeSaveMutation,
  useKnowledgeTreeQuery,
  useKnowledgeUpdateMutation,
} from '../query-domains/projectData';

const SLUG = 'proj';
const NS = 'notes';

function mountViews() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const views = renderHook(
    () => ({
      tree: useKnowledgeTreeQuery(SLUG, NS),
      filtered: useKnowledgeFilteredQuery(SLUG, NS, {}),
      body: useKnowledgeDocContentQuery(SLUG, 'doc-1', NS),
    }),
    { wrapper },
  );
  return { views, wrapper };
}

async function settled(views: ReturnType<typeof mountViews>['views']) {
  await waitFor(() => {
    expect(views.result.current.tree.isSuccess).toBe(true);
    expect(views.result.current.filtered.isSuccess).toBe(true);
    expect(views.result.current.body.isSuccess).toBe(true);
  });
}

function fetchCounts() {
  return {
    tree: api.fetchKnowledgeTree.mock.calls.length,
    filtered: api.fetchKnowledgeFiltered.mock.calls.length,
    body: api.fetchKnowledgeDocContent.mock.calls.length,
  };
}

beforeEach(() => vi.clearAllMocks());

const writes = [
  {
    name: 'save',
    run: async (wrapper: ReturnType<typeof mountViews>['wrapper']) => {
      const m = renderHook(() => useKnowledgeSaveMutation(SLUG, NS), {
        wrapper,
      });
      await act(() =>
        m.result.current.mutateAsync({ filename: 'a.md', content: 'x' }),
      );
    },
    refreshesBody: false,
  },
  {
    name: 'delete',
    run: async (wrapper: ReturnType<typeof mountViews>['wrapper']) => {
      const m = renderHook(() => useKnowledgeDeleteMutation(SLUG, NS), {
        wrapper,
      });
      await act(() => m.result.current.mutateAsync('doc-1'));
    },
    refreshesBody: true,
  },
  {
    name: 'bulk delete',
    run: async (wrapper: ReturnType<typeof mountViews>['wrapper']) => {
      const m = renderHook(() => useKnowledgeBulkDeleteMutation(SLUG, NS), {
        wrapper,
      });
      await act(() => m.result.current.mutateAsync(['doc-1', 'doc-2']));
    },
    refreshesBody: true,
  },
  {
    name: 'update',
    run: async (wrapper: ReturnType<typeof mountViews>['wrapper']) => {
      const m = renderHook(() => useKnowledgeUpdateMutation(SLUG, NS), {
        wrapper,
      });
      await act(() =>
        m.result.current.mutateAsync({ docId: 'doc-1', content: 'edited' }),
      );
    },
    refreshesBody: true,
  },
];

describe('a knowledge-document write refreshes every view of the namespace', () => {
  for (const write of writes) {
    test(`${write.name} refetches the mounted tree and filtered listing${write.refreshesBody ? ', and the written body' : ''}`, async () => {
      const { views, wrapper } = mountViews();
      await settled(views);
      const before = fetchCounts();

      await write.run(wrapper);

      await waitFor(() => {
        const after = fetchCounts();
        expect(after.tree).toBe(before.tree + 1);
        expect(after.filtered).toBe(before.filtered + 1);
      });
      expect(fetchCounts().body).toBe(
        before.body + (write.refreshesBody ? 1 : 0),
      );
    });
  }
});
