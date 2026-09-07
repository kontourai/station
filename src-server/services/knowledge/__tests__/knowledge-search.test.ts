import { describe, expect, test, vi } from 'vitest';
import { searchKnowledgeDocuments } from '../knowledge-search.js';

describe('knowledge-search helpers', () => {
  test.each([undefined, 'missing'])(
    'does not embed when no searchable namespace exists (%s)',
    async (namespace) => {
      const embed = vi.fn();
      const search = vi.fn();
      const result = await searchKnowledgeDocuments({
        projectSlug: 'p',
        query: 'hello',
        topK: 5,
        namespace,
        vectorDb: { namespaceExists: vi.fn().mockResolvedValue(false), search },
        embeddingProvider: { embed },
        listNamespaces: () => [{ id: 'injected', behavior: 'inject' }],
        listAuthoritativeDocuments: vi.fn(),
      });
      expect(result).toEqual([]);
      expect(embed).not.toHaveBeenCalled();
      expect(search).not.toHaveBeenCalled();
    },
  );

  test('bounds concurrent namespace searches and preserves tied-score order despite completion order', async () => {
    const pending = new Map<string, () => void>();
    let active = 0;
    let peak = 0;
    const search = vi.fn(async (namespace: string) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => pending.set(namespace, resolve));
      active--;
      return [
        {
          id: namespace,
          score: 1,
          metadata: { docId: 'doc', contentHash: 'hash' },
        },
      ];
    });
    const result = searchKnowledgeDocuments({
      projectSlug: 'p',
      query: 'hello',
      topK: 6,
      vectorDb: { namespaceExists: async () => true, search },
      embeddingProvider: { embed: async () => [[1]] },
      listNamespaces: () =>
        Array.from({ length: 6 }, (_, i) => ({
          id: String(i),
          behavior: 'rag',
        })),
      listAuthoritativeDocuments: async () => new Map([['doc', 'hash']]),
    });
    await vi.waitFor(() => expect(pending.size).toBe(4));
    expect(active).toBe(4);
    for (const id of ['3', '2']) pending.get(`project-p:${id}`)!();
    await vi.waitFor(() => expect(pending.size).toBe(6));
    for (const release of pending.values()) release();
    expect((await result).map((row) => row.id)).toEqual(
      Array.from({ length: 6 }, (_, i) => `project-p:${i}`),
    );
    expect(peak).toBe(4);
  });

  test('searches a single namespace when requested', async () => {
    const search = vi.fn().mockResolvedValue([
      {
        id: 'chunk-1',
        score: 0.7,
        metadata: { docId: 'doc-1', contentHash: 'hash-1' },
      },
    ]);

    await expect(
      searchKnowledgeDocuments({
        projectSlug: 'project-a',
        query: 'hello',
        topK: 3,
        namespace: 'docs',
        vectorDb: {
          namespaceExists: vi.fn().mockResolvedValue(true),
          search,
        },
        embeddingProvider: {
          embed: vi.fn().mockResolvedValue([[1, 2, 3]]),
        },
        listNamespaces: vi.fn(),
        listAuthoritativeDocuments: vi
          .fn()
          .mockResolvedValue(new Map([['doc-1', 'hash-1']])),
      }),
    ).resolves.toEqual([
      {
        id: 'chunk-1',
        score: 0.7,
        metadata: { docId: 'doc-1', contentHash: 'hash-1' },
      },
    ]);

    expect(search).toHaveBeenCalledWith('project-project-a:docs', [1, 2, 3], 3);
  });

  test('fans out over rag namespaces and returns top scored results', async () => {
    const namespaceExists = vi.fn().mockResolvedValue(true);
    const search = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: 'a',
          score: 0.2,
          metadata: { docId: 'doc-a', contentHash: 'hash-a' },
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'b',
          score: 0.9,
          metadata: { docId: 'doc-b', contentHash: 'hash-b' },
        },
        {
          id: 'c',
          score: 0.6,
          metadata: { docId: 'doc-c', contentHash: 'hash-c' },
        },
      ]);

    await expect(
      searchKnowledgeDocuments({
        projectSlug: 'project-a',
        query: 'hello',
        topK: 2,
        vectorDb: { namespaceExists, search },
        embeddingProvider: {
          embed: vi.fn().mockResolvedValue([[4, 5, 6]]),
        },
        listNamespaces: () => [
          { id: 'rag-a', behavior: 'rag' },
          { id: 'inject-a', behavior: 'inject' },
          { id: 'rag-b', behavior: 'rag' },
        ],
        listAuthoritativeDocuments: vi
          .fn()
          .mockResolvedValueOnce(new Map([['doc-a', 'hash-a']]))
          .mockResolvedValueOnce(
            new Map([
              ['doc-b', 'hash-b'],
              ['doc-c', 'hash-c'],
            ]),
          ),
      }),
    ).resolves.toEqual([
      {
        id: 'b',
        score: 0.9,
        metadata: { docId: 'doc-b', contentHash: 'hash-b' },
      },
      {
        id: 'c',
        score: 0.6,
        metadata: { docId: 'doc-c', contentHash: 'hash-c' },
      },
    ]);

    expect(namespaceExists).toHaveBeenCalledTimes(2);
    expect(search).toHaveBeenCalledTimes(2);
  });

  test('returns empty when required providers are missing', async () => {
    await expect(
      searchKnowledgeDocuments({
        projectSlug: 'project-a',
        query: 'hello',
        topK: 3,
        vectorDb: null,
        embeddingProvider: {
          embed: vi.fn(),
        },
        listNamespaces: vi.fn(),
        listAuthoritativeDocuments: vi.fn(),
      }),
    ).resolves.toEqual([]);

    await expect(
      searchKnowledgeDocuments({
        projectSlug: 'project-a',
        query: 'hello',
        topK: 3,
        vectorDb: {
          namespaceExists: vi.fn(),
          search: vi.fn(),
        },
        embeddingProvider: null,
        listNamespaces: vi.fn(),
        listAuthoritativeDocuments: vi.fn(),
      }),
    ).resolves.toEqual([]);
  });

  test('filters orphaned derived-vector hits against authoritative metadata', async () => {
    await expect(
      searchKnowledgeDocuments({
        projectSlug: 'project-a',
        query: 'hello',
        topK: 3,
        namespace: 'docs',
        vectorDb: {
          namespaceExists: vi.fn().mockResolvedValue(true),
          search: vi.fn().mockResolvedValue([
            {
              id: 'live:0',
              score: 0.8,
              metadata: { docId: 'live', contentHash: 'live-hash' },
            },
            { id: 'ghost:0', score: 0.9, metadata: { docId: 'ghost' } },
          ]),
        },
        embeddingProvider: {
          embed: vi.fn().mockResolvedValue([[1, 2, 3]]),
        },
        listNamespaces: vi.fn(),
        listAuthoritativeDocuments: vi
          .fn()
          .mockResolvedValue(new Map([['live', 'live-hash']])),
      }),
    ).resolves.toEqual([
      {
        id: 'live:0',
        score: 0.8,
        metadata: { docId: 'live', contentHash: 'live-hash' },
      },
    ]);
  });

  test('rejects a derived hit whose content revision does not match authority', async () => {
    await expect(
      searchKnowledgeDocuments({
        projectSlug: 'project-a',
        query: 'hello',
        topK: 3,
        namespace: 'docs',
        vectorDb: {
          namespaceExists: vi.fn().mockResolvedValue(true),
          search: vi.fn().mockResolvedValue([
            {
              id: 'doc-1:0',
              score: 0.9,
              metadata: { docId: 'doc-1', contentHash: 'new-hash' },
            },
          ]),
        },
        embeddingProvider: {
          embed: vi.fn().mockResolvedValue([[1, 2, 3]]),
        },
        listNamespaces: vi.fn(),
        listAuthoritativeDocuments: vi
          .fn()
          .mockResolvedValue(new Map([['doc-1', 'old-hash']])),
      }),
    ).resolves.toEqual([]);
  });

  test('legacy authority without a content hash cannot authorize stale vectors', async () => {
    await expect(
      searchKnowledgeDocuments({
        projectSlug: 'project-a',
        query: 'hello',
        topK: 3,
        namespace: 'docs',
        vectorDb: {
          namespaceExists: vi.fn().mockResolvedValue(true),
          search: vi
            .fn()
            .mockResolvedValue([
              { id: 'legacy:0', score: 0.9, metadata: { docId: 'legacy' } },
            ]),
        },
        embeddingProvider: {
          embed: vi.fn().mockResolvedValue([[1, 2, 3]]),
        },
        listNamespaces: vi.fn(),
        listAuthoritativeDocuments: vi
          .fn()
          .mockResolvedValue(new Map([['legacy', null]])),
      }),
    ).resolves.toEqual([]);
  });
});
