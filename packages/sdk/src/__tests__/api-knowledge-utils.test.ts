import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { _setApiBase } from '../api-core';
import {
  deleteKnowledgeDoc,
  searchKnowledge,
  updateKnowledgeNamespace,
  uploadKnowledge,
} from '../api-knowledge';
import {
  buildKnowledgeFilterQuery,
  knowledgeBase,
  requestKnowledgeJson,
} from '../api-knowledge-utils';

describe('api-knowledge-utils', () => {
  beforeEach(() => {
    _setApiBase('https://station.example.test');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('knowledgeBase encodes project slugs and namespaces', () => {
    expect(knowledgeBase('proj slug', 'notes/core')).toBe(
      '/api/projects/proj%20slug/knowledge/ns/notes%2Fcore',
    );
  });

  test('buildKnowledgeFilterQuery serializes known filters', () => {
    expect(
      buildKnowledgeFilterQuery({
        tags: ['alpha', 'beta'],
        after: '2026-01-01',
        before: '2026-01-31',
        pathPrefix: 'docs/',
        status: 'indexed',
        metadata: { owner: 'brian', version: 2 },
      }),
    ).toBe(
      'tags=alpha%2Cbeta&after=2026-01-01&before=2026-01-31&pathPrefix=docs%2F&status=indexed&metadata.owner=brian&metadata.version=2',
    );
  });

  test('returns data from a valid knowledge response envelope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ success: true, data: ['record-1'] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    await expect(
      requestKnowledgeJson<string[]>('/api/knowledge', {
        errorPrefix: 'Knowledge request failed',
      }),
    ).resolves.toEqual(['record-1']);
  });

  test('constructs one exact apiBase-prefixed URL for upload, search, and rules routes', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(
      async () =>
        new Response(JSON.stringify({ success: true, data: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await uploadKnowledge('proj slug', 'notes.md', 'hello');
    await searchKnowledge('proj slug', 'hello', 'notes/core', 3);
    await uploadKnowledge(
      'proj slug',
      'project-rules.md',
      'Use exact evidence.',
      'rules',
    );

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://station.example.test/api/projects/proj%20slug/knowledge/upload',
      'https://station.example.test/api/projects/proj%20slug/knowledge/ns/notes%2Fcore/search',
      'https://station.example.test/api/projects/proj%20slug/knowledge/ns/rules/upload',
    ]);
  });

  test('rejects a malformed knowledge response with the operation prefix', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    await expect(
      requestKnowledgeJson<string[]>('/api/knowledge', {
        errorPrefix: 'Knowledge request failed',
      }),
    ).rejects.toThrow('Knowledge request failed: invalid response');
  });

  test.each([
    [
      'document delete',
      () => deleteKnowledgeDoc('project-one', 'document-one'),
      'DELETE',
    ],
    [
      'namespace update',
      () => updateKnowledgeNamespace('project-one', 'namespace-one', {}),
      'PUT',
    ],
  ])('accepts a valid void-success %s response', async (_, request, method) => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ success: true }), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(request()).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ method }),
    );
  });
});
