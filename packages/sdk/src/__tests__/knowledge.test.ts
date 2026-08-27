import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createKnowledgeRecord,
  createKnowledgeRoot,
  deleteKnowledgeRoot,
  getKnowledgeGraph,
  getKnowledgeGraphNeo4j,
  getKnowledgeRecord,
  linkKnowledgeRecord,
  listKnowledgeAdapters,
  listKnowledgeRecordsByType,
  listKnowledgeRoots,
  migratePreIndexKnowledge,
  rebuildKnowledgeIndex,
  searchKnowledgeIndex,
  syncKnowledgeGraphNeo4j,
  validateKnowledgeRoot,
} from '../client/knowledge';

/**
 * `s201-knowledge-retrieval` Wave 4 — unit coverage for the two DRY K3
 * index-management fetchers against a mocked `fetch`, mirroring
 * `scheduler.test.ts`'s (success path) and
 * `client-fetchers-failure-paths.test.ts`'s (failure path) conventions.
 *
 * `s202-knowledge-onboarding` Wave 1 extends this file with the five new
 * K4 knowledge-store-root fetchers (`listKnowledgeRoots`/`createKnowledgeRoot`/
 * `validateKnowledgeRoot`/`listKnowledgeAdapters`/`deleteKnowledgeRoot`),
 * each covered for both its success path and its error-body passthrough.
 */
describe('client/knowledge', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('rebuildKnowledgeIndex posts to /api/knowledge/index/rebuild and returns per-root counts', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          roots: [{ rootId: 'root:personal', records: 3, chunks: 12 }],
        },
      }),
    } as Response);

    await expect(
      rebuildKnowledgeIndex('http://example.test', {
        rootId: 'root:personal',
      }),
    ).resolves.toEqual({
      roots: [{ rootId: 'root:personal', records: 3, chunks: 12 }],
    });

    expect(fetch).toHaveBeenCalledWith(
      'http://example.test/api/knowledge/index/rebuild',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ rootId: 'root:personal' }),
      }),
    );
  });

  it('rebuildKnowledgeIndex omits rootId from the body when not provided', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { roots: [] } }),
    } as Response);

    await rebuildKnowledgeIndex('http://example.test');

    expect(fetch).toHaveBeenCalledWith(
      'http://example.test/api/knowledge/index/rebuild',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ rootId: undefined }),
      }),
    );
  });

  it('rebuildKnowledgeIndex surfaces the server error body on a non-2xx response (e.g. no embedder configured)', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({
        success: false,
        error: 'No embedding provider connection is configured',
      }),
    } as Response);

    await expect(rebuildKnowledgeIndex('http://example.test')).rejects.toThrow(
      'No embedding provider connection is configured',
    );
  });

  it('migratePreIndexKnowledge posts to /api/knowledge/migrate and returns migration counts', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          documentsMigrated: 5,
          chunksIndexed: 20,
          namespacesProcessed: ['default'],
        },
      }),
    } as Response);

    await expect(
      migratePreIndexKnowledge('http://example.test', {
        projectSlug: 'acme',
      }),
    ).resolves.toEqual({
      documentsMigrated: 5,
      chunksIndexed: 20,
      namespacesProcessed: ['default'],
    });

    expect(fetch).toHaveBeenCalledWith(
      'http://example.test/api/knowledge/migrate',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ projectSlug: 'acme' }),
      }),
    );
  });

  it('migratePreIndexKnowledge surfaces the server error body on a non-2xx response', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({
        success: false,
        error: 'migration failed unexpectedly',
      }),
    } as Response);

    await expect(
      migratePreIndexKnowledge('http://example.test'),
    ).rejects.toThrow('migration failed unexpectedly');
  });

  it('listKnowledgeRoots gets /api/knowledge/roots and returns the root list', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: [
          {
            id: 'root:personal',
            scope: { kind: 'personal' },
            adapterId: 'kit-default-store',
            storeRoot: '/home/user/.station/knowledge/personal',
            displayName: 'Personal',
            createdAt: '2026-07-06T00:00:00.000Z',
          },
        ],
      }),
    } as Response);

    await expect(listKnowledgeRoots('http://example.test')).resolves.toEqual([
      {
        id: 'root:personal',
        scope: { kind: 'personal' },
        adapterId: 'kit-default-store',
        storeRoot: '/home/user/.station/knowledge/personal',
        displayName: 'Personal',
        createdAt: '2026-07-06T00:00:00.000Z',
      },
    ]);

    expect(fetch).toHaveBeenCalledWith(
      'http://example.test/api/knowledge/roots',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('listKnowledgeRoots surfaces the server error body on a non-2xx response', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({
        success: false,
        error: 'root registry unavailable',
      }),
    } as Response);

    await expect(listKnowledgeRoots('http://example.test')).rejects.toThrow(
      'root registry unavailable',
    );
  });

  it('createKnowledgeRoot posts to /api/knowledge/roots and returns the created root', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          id: 'root:personal',
          scope: { kind: 'personal' },
          adapterId: 'kit-default-store',
          storeRoot: '/home/user/.station/knowledge/personal',
          displayName: 'Personal',
          createdAt: '2026-07-06T00:00:00.000Z',
        },
      }),
    } as Response);

    await expect(
      createKnowledgeRoot('http://example.test', {
        scope: { kind: 'personal' },
        adapterId: 'kit-default-store',
      }),
    ).resolves.toEqual({
      id: 'root:personal',
      scope: { kind: 'personal' },
      adapterId: 'kit-default-store',
      storeRoot: '/home/user/.station/knowledge/personal',
      displayName: 'Personal',
      createdAt: '2026-07-06T00:00:00.000Z',
    });

    expect(fetch).toHaveBeenCalledWith(
      'http://example.test/api/knowledge/roots',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          scope: { kind: 'personal' },
          adapterId: 'kit-default-store',
        }),
      }),
    );
  });

  it('createKnowledgeRoot surfaces the server error body on a non-2xx response (e.g. unknown adapterId)', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({
        success: false,
        error: "Unknown adapterId 'bogus-adapter'",
      }),
    } as Response);

    await expect(
      createKnowledgeRoot('http://example.test', {
        scope: { kind: 'personal' },
        adapterId: 'bogus-adapter',
      }),
    ).rejects.toThrow("Unknown adapterId 'bogus-adapter'");
  });

  it('validateKnowledgeRoot posts to /api/knowledge/roots/validate and returns the honest ok/reason result', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          ok: false,
          reason:
            'storeRoot is an empty directory with no .obsidian/ vault marker',
        },
      }),
    } as Response);

    await expect(
      validateKnowledgeRoot('http://example.test', {
        adapterId: 'kit-obsidian-store',
        storeRoot: '/tmp/not-a-vault',
      }),
    ).resolves.toEqual({
      ok: false,
      reason: 'storeRoot is an empty directory with no .obsidian/ vault marker',
    });

    expect(fetch).toHaveBeenCalledWith(
      'http://example.test/api/knowledge/roots/validate',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          adapterId: 'kit-obsidian-store',
          storeRoot: '/tmp/not-a-vault',
        }),
      }),
    );
  });

  it('validateKnowledgeRoot surfaces the server error body on a non-2xx response', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({
        success: false,
        error: 'validation crashed unexpectedly',
      }),
    } as Response);

    await expect(
      validateKnowledgeRoot('http://example.test', {
        adapterId: 'kit-obsidian-store',
        storeRoot: '/tmp/not-a-vault',
      }),
    ).rejects.toThrow('validation crashed unexpectedly');
  });

  it('listKnowledgeAdapters gets /api/knowledge/adapters and returns id/displayName summaries', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: [
          { id: 'kit-default-store', displayName: 'Default store' },
          { id: 'kit-obsidian-store', displayName: 'Obsidian vault' },
        ],
      }),
    } as Response);

    await expect(listKnowledgeAdapters('http://example.test')).resolves.toEqual(
      [
        { id: 'kit-default-store', displayName: 'Default store' },
        { id: 'kit-obsidian-store', displayName: 'Obsidian vault' },
      ],
    );

    expect(fetch).toHaveBeenCalledWith(
      'http://example.test/api/knowledge/adapters',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('listKnowledgeAdapters surfaces the server error body on a non-2xx response', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({
        success: false,
        error: 'adapter registry unavailable',
      }),
    } as Response);

    await expect(listKnowledgeAdapters('http://example.test')).rejects.toThrow(
      'adapter registry unavailable',
    );
  });

  it('deleteKnowledgeRoot deletes /api/knowledge/roots/:id', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: undefined }),
    } as Response);

    await deleteKnowledgeRoot('http://example.test', 'root:project-acme');

    expect(fetch).toHaveBeenCalledWith(
      'http://example.test/api/knowledge/roots/root%3Aproject-acme',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('deleteKnowledgeRoot surfaces the server error body on a non-2xx response', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({
        success: false,
        error: 'root not found',
      }),
    } as Response);

    await expect(
      deleteKnowledgeRoot('http://example.test', 'root:missing'),
    ).rejects.toThrow('root not found');
  });

  it('createKnowledgeRecord posts to /api/knowledge/roots/:rootId/records and returns the created record', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          id: 'rec-1',
          type: 'raw',
          title: 'Meeting transcript',
          body: 'transcript body',
          category: 'meeting-notes',
          provenance: { agent: 'station.meeting-notes.capture' },
          created_at: '2026-07-06T00:00:00.000Z',
          updated_at: '2026-07-06T00:00:00.000Z',
        },
      }),
    } as Response);

    await expect(
      createKnowledgeRecord('http://example.test', 'root:personal', {
        type: 'raw',
        title: 'Meeting transcript',
        body: 'transcript body',
        category: 'meeting-notes',
        provenance: { agent: 'station.meeting-notes.capture' },
      }),
    ).resolves.toEqual(expect.objectContaining({ id: 'rec-1', type: 'raw' }));

    expect(fetch).toHaveBeenCalledWith(
      'http://example.test/api/knowledge/roots/root%3Apersonal/records',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('createKnowledgeRecord surfaces the server error body on a non-2xx response', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ success: false, error: 'Invalid type' }),
    } as Response);

    await expect(
      createKnowledgeRecord('http://example.test', 'root:personal', {
        type: 'raw',
        title: 't',
        body: 'b',
        category: 'c',
        provenance: { agent: 'test' },
      }),
    ).rejects.toThrow('Invalid type');
  });

  it('getKnowledgeRecord gets /api/knowledge/roots/:rootId/records/:id', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: { id: 'rec-1', type: 'raw', title: 'Meeting transcript' },
      }),
    } as Response);

    await expect(
      getKnowledgeRecord('http://example.test', 'root:personal', 'rec-1'),
    ).resolves.toEqual(
      expect.objectContaining({ id: 'rec-1', title: 'Meeting transcript' }),
    );

    expect(fetch).toHaveBeenCalledWith(
      'http://example.test/api/knowledge/roots/root%3Apersonal/records/rec-1',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('getKnowledgeRecord surfaces a 404 not-found error body', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ success: false, error: 'Record not found' }),
    } as Response);

    await expect(
      getKnowledgeRecord('http://example.test', 'root:personal', 'missing'),
    ).rejects.toThrow('Record not found');
  });

  it('listKnowledgeRecordsByType gets /api/knowledge/roots/:rootId/records?type=', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: [{ id: 'rec-1', type: 'raw' }],
      }),
    } as Response);

    await expect(
      listKnowledgeRecordsByType('http://example.test', 'root:personal', 'raw'),
    ).resolves.toEqual([{ id: 'rec-1', type: 'raw' }]);

    expect(fetch).toHaveBeenCalledWith(
      'http://example.test/api/knowledge/roots/root%3Apersonal/records?type=raw',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('linkKnowledgeRecord posts to /api/knowledge/roots/:rootId/records/:id/links', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: { id: 'rec-2', links: [{ target_id: 'rec-1', kind: 'source' }] },
      }),
    } as Response);

    await expect(
      linkKnowledgeRecord('http://example.test', 'root:personal', 'rec-2', {
        links: [{ target_id: 'rec-1', kind: 'source' }],
        evidence: { agent: 'station.meeting-notes.compile' },
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        id: 'rec-2',
        links: [{ target_id: 'rec-1', kind: 'source' }],
      }),
    );

    expect(fetch).toHaveBeenCalledWith(
      'http://example.test/api/knowledge/roots/root%3Apersonal/records/rec-2/links',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('getKnowledgeGraph gets /api/knowledge/roots/:rootId/graph', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          nodes: [{ id: 'rec-1', type: 'raw', title: 't', category: 'c' }],
          edges: [],
        },
      }),
    } as Response);

    await expect(
      getKnowledgeGraph('http://example.test', 'root:personal'),
    ).resolves.toEqual({
      nodes: [{ id: 'rec-1', type: 'raw', title: 't', category: 'c' }],
      edges: [],
    });

    expect(fetch).toHaveBeenCalledWith(
      'http://example.test/api/knowledge/roots/root%3Apersonal/graph',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('searchKnowledgeIndex posts to /api/knowledge/index/search and returns resolved excerpt hits', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: [
          {
            recordId: 'rec-1',
            rootId: 'root:personal',
            score: 0.92,
            title: 'Q3 roadmap notes',
            excerpt: 'roadmap discussion body',
            category: 'personal',
          },
        ],
      }),
    } as Response);

    await expect(
      searchKnowledgeIndex('http://example.test', {
        query: 'roadmap',
        topK: 5,
        rootIds: ['root:personal'],
      }),
    ).resolves.toEqual([
      {
        recordId: 'rec-1',
        rootId: 'root:personal',
        score: 0.92,
        title: 'Q3 roadmap notes',
        excerpt: 'roadmap discussion body',
        category: 'personal',
      },
    ]);

    expect(fetch).toHaveBeenCalledWith(
      'http://example.test/api/knowledge/index/search',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          query: 'roadmap',
          topK: 5,
          rootIds: ['root:personal'],
        }),
      }),
    );
  });

  it('searchKnowledgeIndex surfaces the NO_EMBEDDER_ERROR 400 body', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({
        success: false,
        error: 'No embedding provider connection is configured',
      }),
    } as Response);

    await expect(
      searchKnowledgeIndex('http://example.test', { query: 'anything' }),
    ).rejects.toThrow('No embedding provider connection is configured');
  });

  /**
   * `s203-knowledge-meeting-notes` Wave 3 cleanup (plan item 1c) — the
   * Neo4j-backed graph-view read/sync fetchers.
   */
  it('getKnowledgeGraphNeo4j gets /api/knowledge/roots/:rootId/graph/neo4j', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          nodes: [{ id: 'rec-1', type: 'raw', title: 't', category: 'c' }],
          edges: [],
        },
      }),
    } as Response);

    await expect(
      getKnowledgeGraphNeo4j('http://example.test', 'root:personal'),
    ).resolves.toEqual({
      nodes: [{ id: 'rec-1', type: 'raw', title: 't', category: 'c' }],
      edges: [],
    });

    expect(fetch).toHaveBeenCalledWith(
      'http://example.test/api/knowledge/roots/root%3Apersonal/graph/neo4j',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('getKnowledgeGraphNeo4j surfaces the honest 503 "not configured" body verbatim', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({
        success: false,
        error:
          'Neo4j graph-view connection is not configured — register one before syncing or reading the graph view',
      }),
    } as Response);

    await expect(
      getKnowledgeGraphNeo4j('http://example.test', 'root:personal'),
    ).rejects.toThrow('Neo4j graph-view connection is not configured');
  });

  it('syncKnowledgeGraphNeo4j posts to /api/knowledge/roots/:rootId/graph/neo4j-sync and returns sync stats', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          rootId: 'root:personal',
          recordsScanned: 2,
          linksScanned: 1,
          nodesWritten: 2,
          nodesUnchanged: 0,
          linksWritten: 1,
          linksUnchanged: 0,
          linksSkippedDangling: 0,
        },
      }),
    } as Response);

    await expect(
      syncKnowledgeGraphNeo4j('http://example.test', 'root:personal'),
    ).resolves.toEqual({
      rootId: 'root:personal',
      recordsScanned: 2,
      linksScanned: 1,
      nodesWritten: 2,
      nodesUnchanged: 0,
      linksWritten: 1,
      linksUnchanged: 0,
      linksSkippedDangling: 0,
    });

    expect(fetch).toHaveBeenCalledWith(
      'http://example.test/api/knowledge/roots/root%3Apersonal/graph/neo4j-sync',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('syncKnowledgeGraphNeo4j surfaces the honest 503 "not configured" body verbatim', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({
        success: false,
        error:
          'Neo4j graph-view connection is not configured — register one before syncing or reading the graph view',
      }),
    } as Response);

    await expect(
      syncKnowledgeGraphNeo4j('http://example.test', 'root:personal'),
    ).rejects.toThrow('Neo4j graph-view connection is not configured');
  });
});
