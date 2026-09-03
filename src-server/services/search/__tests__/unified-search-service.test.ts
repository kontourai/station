import {
  UNIFIED_SEARCH_V1,
  type UnifiedSearchCandidate,
  type UnifiedSearchProvider,
  type UnifiedSearchProviderPage,
} from '@kontourai/station-contracts/unified-search';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  UNIFIED_SEARCH_LIMITS,
  UnifiedSearchService,
} from '../unified-search-service.js';

const observedAt = '2026-09-03T00:00:00.000Z';

function task(id = 'task-1'): UnifiedSearchCandidate {
  return {
    id,
    kind: 'task',
    scope: { projectId: 'alpha', taskId: id },
    title: 'Repair the parser',
    snippet: 'Preserve exact failure receipts.',
    matchedFields: ['title', 'description'],
    currentness: { state: 'current', observedAt },
    relevance: 0.9,
    openIntent: { kind: 'task', projectId: 'alpha', taskId: id },
  };
}

function provider(input: {
  id: string;
  stationId?: string;
  page?: UnifiedSearchProviderPage;
  search?: UnifiedSearchProvider['search'];
}): UnifiedSearchProvider {
  return {
    descriptor: {
      id: input.id,
      version: '1.0.0',
      owner: { kind: 'station', stationId: input.stationId ?? 'station-a' },
      kinds: ['task'],
    },
    search:
      input.search ??
      (async () =>
        input.page ?? {
          version: UNIFIED_SEARCH_V1,
          state: 'available',
          results: [task()],
        }),
  };
}

describe('UnifiedSearchService', () => {
  afterEach(() => vi.useRealTimers());

  test('keeps identical resource ids collision-free across Station owners', async () => {
    const service = new UnifiedSearchService([
      provider({ id: 'station-a.tasks', stationId: 'station-a' }),
      provider({ id: 'station-b.tasks', stationId: 'station-b' }),
    ]);

    const result = await service.search({
      version: UNIFIED_SEARCH_V1,
      query: 'parser',
    });

    expect(result.state).toBe('complete');
    if (result.state === 'invalid')
      throw new Error('unexpected invalid result');
    expect(result.results).toHaveLength(2);
    expect(new Set(result.results.map((entry) => entry.key)).size).toBe(2);
    expect(result.results.map((entry) => entry.owner)).toEqual([
      { kind: 'station', stationId: 'station-a' },
      { kind: 'station', stationId: 'station-b' },
    ]);
    expect(
      result.results.every(
        (entry) => entry.authorization.state === 'authorized',
      ),
    ).toBe(true);
  });

  test('preserves authorized results while naming restricted and unavailable providers', async () => {
    const service = new UnifiedSearchService([
      provider({ id: 'station.tasks' }),
      provider({
        id: 'station.receipts',
        page: {
          version: UNIFIED_SEARCH_V1,
          state: 'restricted',
          reason: 'authorization-restricted',
        },
      }),
      provider({
        id: 'station.outputs',
        search: async () => {
          throw new Error('private provider detail');
        },
      }),
    ]);

    const result = await service.search({
      version: UNIFIED_SEARCH_V1,
      query: 'parser',
    });

    expect(result.state).toBe('partial');
    if (result.state === 'invalid')
      throw new Error('unexpected invalid result');
    expect(result.results.map((entry) => entry.id)).toEqual(['task-1']);
    expect(result.sources).toEqual([
      expect.objectContaining({
        providerId: 'station.tasks',
        state: 'available',
      }),
      {
        providerId: 'station.receipts',
        owner: { kind: 'station', stationId: 'station-a' },
        state: 'restricted',
        reason: 'authorization-restricted',
      },
      {
        providerId: 'station.outputs',
        owner: { kind: 'station', stationId: 'station-a' },
        state: 'unavailable',
        reason: 'provider-timeout-or-error',
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('private provider detail');
    expect(result.sources.some((source) => 'resultCount' in source)).toBe(
      false,
    );
  });

  test('passes only the owning provider continuation and preserves the next token', async () => {
    const search = vi.fn(async (_request) => ({
      version: UNIFIED_SEARCH_V1,
      state: 'partial' as const,
      reason: 'result-window' as const,
      continuation: 'next-token',
      results: [task('task-2')],
    }));
    const service = new UnifiedSearchService([
      provider({ id: 'station.tasks', search }),
    ]);

    const result = await service.search({
      version: UNIFIED_SEARCH_V1,
      query: 'parser',
      continuations: [{ providerId: 'station.tasks', token: 'current-token' }],
    });

    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ continuation: 'current-token' }),
      expect.any(AbortSignal),
    );
    if (result.state === 'invalid')
      throw new Error('unexpected invalid result');
    expect(result.sources[0]).toMatchObject({
      state: 'partial',
      continuation: 'next-token',
    });
  });

  test('preserves a stale provider page without rewriting result currentness', async () => {
    const service = new UnifiedSearchService([
      provider({
        id: 'station.tasks',
        page: {
          version: UNIFIED_SEARCH_V1,
          state: 'stale',
          reason: 'source-stale',
          results: [
            {
              ...task(),
              currentness: {
                state: 'stale',
                observedAt,
                reason: 'Task snapshot needs refresh',
              },
            },
          ],
        },
      }),
    ]);

    const result = await service.search({
      version: UNIFIED_SEARCH_V1,
      query: 'parser',
    });

    expect(result.state).toBe('stale');
    if (result.state === 'invalid')
      throw new Error('unexpected invalid result');
    expect(result.results[0]?.currentness).toEqual({
      state: 'stale',
      observedAt,
      reason: 'Task snapshot needs refresh',
    });
  });

  test('rejects malformed or over-producing providers without adopting partial data', async () => {
    const excessive = Array.from(
      { length: UNIFIED_SEARCH_LIMITS.resultsPerProvider + 1 },
      (_, index) => task(`task-${index}`),
    );
    const service = new UnifiedSearchService([
      provider({
        id: 'station.tasks',
        page: {
          version: UNIFIED_SEARCH_V1,
          state: 'available',
          results: excessive,
        },
      }),
    ]);

    const result = await service.search({
      version: UNIFIED_SEARCH_V1,
      query: 'parser',
    });

    expect(result).toEqual({
      version: UNIFIED_SEARCH_V1,
      state: 'unavailable',
      results: [],
      sources: [
        {
          providerId: 'station.tasks',
          owner: { kind: 'station', stationId: 'station-a' },
          state: 'unavailable',
          reason: 'provider-response-invalid',
        },
      ],
    });
  });

  test('rejects a provider that equivocates between displayed scope and open intent', async () => {
    const candidate: UnifiedSearchCandidate = {
      id: 'file-1',
      kind: 'file',
      scope: { projectId: 'shown-project' },
      title: 'release.txt',
      matchedFields: ['title'],
      currentness: { state: 'current', observedAt },
      relevance: 0.8,
      openIntent: {
        kind: 'station-resource',
        resourceKind: 'file',
        resourceId: 'file-1',
        scope: { projectId: 'different-project' },
      },
    };
    const service = new UnifiedSearchService([
      {
        descriptor: {
          id: 'station.files',
          version: '1.0.0',
          owner: { kind: 'station', stationId: 'station-a' },
          kinds: ['file'],
        },
        search: async () => ({
          version: UNIFIED_SEARCH_V1,
          state: 'available',
          results: [candidate],
        }),
      },
    ]);

    await expect(
      service.search({ version: UNIFIED_SEARCH_V1, query: 'release' }),
    ).resolves.toMatchObject({
      state: 'unavailable',
      results: [],
      sources: [{ reason: 'provider-response-invalid' }],
    });
  });

  test('rejects results outside the provider declaration or explicit filter', async () => {
    const service = new UnifiedSearchService([
      provider({
        id: 'station.tasks',
        page: {
          version: UNIFIED_SEARCH_V1,
          state: 'available',
          results: [task()],
        },
      }),
    ]);

    await expect(
      service.search({
        version: UNIFIED_SEARCH_V1,
        query: 'parser',
        filters: { kinds: ['task'], projectId: 'different-project' },
      }),
    ).resolves.toMatchObject({
      state: 'unavailable',
      results: [],
      sources: [{ reason: 'provider-response-invalid' }],
    });
  });

  test('bounds provider time and converts an abort-ignoring provider to unavailable', async () => {
    vi.useFakeTimers();
    const service = new UnifiedSearchService([
      provider({
        id: 'station.tasks',
        search: () => new Promise(() => {}),
      }),
    ]);
    const pending = service.search({
      version: UNIFIED_SEARCH_V1,
      query: 'parser',
    });

    await vi.advanceTimersByTimeAsync(UNIFIED_SEARCH_LIMITS.providerTimeoutMs);

    await expect(pending).resolves.toMatchObject({
      state: 'unavailable',
      sources: [{ providerId: 'station.tasks', state: 'unavailable' }],
    });
  });

  test('rejects unknown continuation owners without invoking a provider', async () => {
    const search = vi.fn(async () => ({
      version: UNIFIED_SEARCH_V1,
      state: 'available' as const,
      results: [],
    }));
    const service = new UnifiedSearchService([
      provider({ id: 'station.tasks', search }),
    ]);

    await expect(
      service.search({
        version: UNIFIED_SEARCH_V1,
        query: 'parser',
        continuations: [{ providerId: 'unknown.source', token: 'opaque' }],
      }),
    ).resolves.toEqual({
      version: UNIFIED_SEARCH_V1,
      state: 'invalid',
      reason: 'Search request is invalid',
    });
    expect(search).not.toHaveBeenCalled();
  });
});
