/**
 * @vitest-environment jsdom
 *
 * #2343 review MEDIUM-1 and HIGH-1: every knowledge-document write refreshes
 * the same listings. Save and delete used to refresh only the document list,
 * so a created note never reached the namespace tree or a filtered listing,
 * and a deleted one stayed in both. Update refreshed the listings but not the
 * document's cached body, so a reader of that body saw the pre-edit text.
 *
 * Bodies are handled per write: an update seeds the written body and then
 * refetches it; a delete drops the body instead of refetching a 404.
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
  return { views, wrapper, client };
}

const BODY_KEY = ['knowledge', 'doc-content', SLUG, 'doc-1'];

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

const writes: Array<{
  name: string;
  run: (wrapper: ReturnType<typeof mountViews>['wrapper']) => Promise<void>;
  body: 'untouched' | 'removed' | 'refetched';
}> = [
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
    body: 'untouched',
  },
  {
    name: 'delete',
    run: async (wrapper: ReturnType<typeof mountViews>['wrapper']) => {
      const m = renderHook(() => useKnowledgeDeleteMutation(SLUG, NS), {
        wrapper,
      });
      await act(() => m.result.current.mutateAsync('doc-1'));
    },
    body: 'removed',
  },
  {
    name: 'bulk delete',
    run: async (wrapper: ReturnType<typeof mountViews>['wrapper']) => {
      const m = renderHook(() => useKnowledgeBulkDeleteMutation(SLUG, NS), {
        wrapper,
      });
      await act(() => m.result.current.mutateAsync(['doc-1', 'doc-2']));
    },
    body: 'removed',
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
    body: 'refetched',
  },
];

describe('a knowledge-document write refreshes every view of the namespace', () => {
  for (const write of writes) {
    test(`${write.name} refetches the mounted tree and filtered listing; the body is ${write.body}`, async () => {
      const { views, wrapper, client } = mountViews();
      await settled(views);
      const before = fetchCounts();

      await write.run(wrapper);

      await waitFor(() => {
        const after = fetchCounts();
        expect(after.tree).toBe(before.tree + 1);
        expect(after.filtered).toBe(before.filtered + 1);
      });
      // A deleted body is dropped, never refetched: that fetch is a 404.
      expect(fetchCounts().body).toBe(
        before.body + (write.body === 'refetched' ? 1 : 0),
      );
      if (write.body === 'removed') {
        expect(client.getQueryCache().find({ queryKey: BODY_KEY })).toBe(
          undefined,
        );
      } else {
        expect(client.getQueryData(BODY_KEY)).toBeDefined();
      }
    });
  }
});

describe('an update seeds the body it wrote', () => {
  test('a reader that mounts while the refetch is in flight gets the saved body', async () => {
    const { views, wrapper } = mountViews();
    await settled(views);
    expect(views.result.current.body.data).toBe('body');
    // The post-save refetch never answers, as on a slow connection.
    api.fetchKnowledgeDocContent.mockImplementation(
      () => new Promise<string>(() => {}),
    );

    const m = renderHook(() => useKnowledgeUpdateMutation(SLUG, NS), {
      wrapper,
    });
    await act(() =>
      m.result.current.mutateAsync({ docId: 'doc-1', content: 'saved text' }),
    );

    // Switching back to the note mounts a fresh reader of its body.
    const reader = renderHook(
      () => useKnowledgeDocContentQuery(SLUG, 'doc-1', NS),
      { wrapper },
    );
    expect(reader.result.current.data).toBe('saved text');
  });
});
