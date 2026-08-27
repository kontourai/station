import { describe, expect, test, vi } from 'vitest';
import { searchKnowledgeDocuments } from '../knowledge-search.js';

describe('knowledge-search helpers', () => {
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
