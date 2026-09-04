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

  test('never reads a provider callable own bind getter or invokes its replacement', async () => {
    const hijacked = vi.fn(async () => ({
      version: UNIFIED_SEARCH_V1,
      state: 'available',
      results: [],
    }));
    const bindGetter = vi.fn(() => () => hijacked);
    const search = vi.fn(async function (this: { descriptor: { id: string } }) {
      expect(this.descriptor.id).toBe('station.tasks');
      expect(Object.isFrozen(this)).toBe(true);
      return {
        version: UNIFIED_SEARCH_V1,
        state: 'available' as const,
        results: [task()],
      };
    });
    Object.defineProperty(search, 'bind', { get: bindGetter });
    const service = new UnifiedSearchService([
      provider({ id: 'station.tasks', search }),
    ]);
    expect(bindGetter).not.toHaveBeenCalled();
    await expect(
      service.search({ version: UNIFIED_SEARCH_V1, query: 'parser' }),
    ).resolves.toMatchObject({
      state: 'complete',
      results: [{ id: 'task-1' }],
    });
    expect(search).toHaveBeenCalledOnce();
    expect(bindGetter).not.toHaveBeenCalled();
    expect(hijacked).not.toHaveBeenCalled();
  });

  test('isolates provider filters from validation and sibling requests', async () => {
    const sibling = vi.fn(async (request) => {
      expect(request.filters).toEqual({ projectId: 'alpha', kinds: ['task'] });
      return {
        version: UNIFIED_SEARCH_V1,
        state: 'available' as const,
        results: [task()],
      };
    });
    const service = new UnifiedSearchService([
      provider({
        id: 'mutator',
        search: async (request) => {
          try {
            request.filters!.projectId = 'beta';
          } catch {}
          try {
            request.filters!.kinds!.push('file');
          } catch {}
          const wrong = task();
          wrong.scope!.projectId = 'beta';
          wrong.openIntent = {
            kind: 'task',
            taskId: wrong.id,
            projectId: 'beta',
          };
          return {
            version: UNIFIED_SEARCH_V1,
            state: 'available',
            results: [wrong],
          };
        },
      }),
      provider({ id: 'sibling', search: sibling }),
    ]);
    const result = await service.search({
      version: UNIFIED_SEARCH_V1,
      query: 'parser',
      filters: { projectId: 'alpha', kinds: ['task'] },
    });
    expect(result).toMatchObject({
      state: 'partial',
      results: [{ providerId: 'sibling', scope: { projectId: 'alpha' } }],
    });
  });

  test('cancellation during invocation cannot publish accepted results', async () => {
    const controller = new AbortController();
    const service = new UnifiedSearchService([
      provider({
        id: 'station.tasks',
        search: async () => {
          controller.abort();
          return {
            version: UNIFIED_SEARCH_V1,
            state: 'available',
            results: [task()],
          };
        },
      }),
    ]);
    await expect(
      service.search(
        { version: UNIFIED_SEARCH_V1, query: 'parser' },
        controller.signal,
      ),
    ).resolves.toMatchObject({
      state: 'unavailable',
      results: [],
      sources: [{ reason: 'search-cancelled' }],
    });
  });

  test('cancelling fanout discards a source that already settled', async () => {
    const controller = new AbortController();
    let started!: () => void;
    const startedSlow = new Promise<void>((resolve) => {
      started = resolve;
    });
    const service = new UnifiedSearchService([
      provider({ id: 'fast' }),
      provider({
        id: 'slow',
        search: async () => {
          started();
          return new Promise(() => {});
        },
      }),
    ]);
    const pending = service.search(
      { version: UNIFIED_SEARCH_V1, query: 'parser' },
      controller.signal,
    );
    await startedSlow;
    await Promise.resolve();
    controller.abort();
    await expect(pending).resolves.toMatchObject({
      state: 'unavailable',
      results: [],
      sources: [{ reason: 'search-cancelled' }, { reason: 'search-cancelled' }],
    });
  });

  test('rejects a proxied provider result without running its traps', async () => {
    const trap = vi.fn(() => {
      throw new Error('proxy trap');
    });
    const candidate = new Proxy(task(), { get: trap, ownKeys: trap });
    const service = new UnifiedSearchService([
      provider({
        id: 'station.tasks',
        page: {
          version: UNIFIED_SEARCH_V1,
          state: 'available',
          results: [candidate],
        },
      }),
    ]);
    await expect(
      service.search({ version: UNIFIED_SEARCH_V1, query: 'parser' }),
    ).resolves.toMatchObject({ state: 'unavailable', results: [] });
    expect(trap).not.toHaveBeenCalled();
  });

  test.each([
    'page',
    'candidate',
    'scope',
    'currentness',
    'openIntent',
    'matchedFields',
  ] as const)('rejects %s accessors without invoking them', async (target) => {
    const getter = vi.fn(() => 'parser');
    const candidate = task();
    const page = {
      version: UNIFIED_SEARCH_V1,
      state: 'available',
      results: [candidate],
    };
    const [object, field] =
      target === 'page'
        ? [page, 'state']
        : target === 'candidate'
          ? [candidate, 'title']
          : target === 'scope'
            ? [candidate.scope!, 'projectId']
            : target === 'currentness'
              ? [candidate.currentness, 'observedAt']
              : target === 'openIntent'
                ? [candidate.openIntent, 'projectId']
                : [candidate.matchedFields, '0'];
    Object.defineProperty(object, field, { enumerable: true, get: getter });
    const service = new UnifiedSearchService([
      provider({ id: 'station.tasks', search: async () => page as never }),
    ]);
    await expect(
      service.search({ version: UNIFIED_SEARCH_V1, query: 'parser' }),
    ).resolves.toMatchObject({
      state: 'unavailable',
      results: [],
      sources: [{ reason: 'provider-response-invalid' }],
    });
    expect(getter).not.toHaveBeenCalled();
  });

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
    expect(result.results.some((entry) => 'authorization' in entry)).toBe(
      false,
    );
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

  test('unwraps only a host-bound continuation for the same query and filters', async () => {
    const search = vi.fn(async (request) => ({
      version: UNIFIED_SEARCH_V1,
      state: 'partial' as const,
      reason: 'result-window' as const,
      continuation: request.continuation ? 'next-token' : 'current-token',
      results: [task('task-2')],
    }));
    const service = new UnifiedSearchService([
      provider({ id: 'station.tasks', search }),
    ]);

    const first = await service.search({
      version: UNIFIED_SEARCH_V1,
      query: 'parser',
      filters: { projectId: 'alpha' },
    });
    if (first.state === 'invalid') throw new Error('unexpected invalid result');
    const token = first.sources[0]?.continuation;
    expect(token).toBeTruthy();
    expect(token).not.toBe('current-token');

    const result = await service.search({
      version: UNIFIED_SEARCH_V1,
      query: 'parser',
      filters: { projectId: 'alpha' },
      continuations: [{ providerId: 'station.tasks', token: token! }],
    });

    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ continuation: 'current-token' }),
      expect.any(AbortSignal),
    );
    if (result.state === 'invalid')
      throw new Error('unexpected invalid result');
    expect(result.sources[0]).toMatchObject({
      state: 'partial',
    });
    expect(result.sources[0]?.continuation).not.toBe('next-token');

    const callsBeforeMismatch = search.mock.calls.length;
    await expect(
      service.search({
        version: UNIFIED_SEARCH_V1,
        query: 'different-query',
        filters: { projectId: 'alpha' },
        continuations: [{ providerId: 'station.tasks', token: token! }],
      }),
    ).resolves.toMatchObject({
      state: 'unavailable',
      sources: [{ reason: 'continuation-invalid' }],
    });
    expect(search).toHaveBeenCalledTimes(callsBeforeMismatch);

    await expect(
      service.search({
        version: UNIFIED_SEARCH_V1,
        query: 'parser',
        filters: { projectId: 'different-project' },
        continuations: [{ providerId: 'station.tasks', token: token! }],
      }),
    ).resolves.toMatchObject({
      state: 'unavailable',
      sources: [{ reason: 'continuation-invalid' }],
    });
    expect(search).toHaveBeenCalledTimes(callsBeforeMismatch);
  });

  test('rejects non-exact and accessor-backed request fields without invoking them', async () => {
    const search = vi.fn(async () => ({
      version: UNIFIED_SEARCH_V1,
      state: 'available' as const,
      results: [],
    }));
    const service = new UnifiedSearchService([
      provider({ id: 'station.tasks', search }),
    ]);
    const queryGetter = vi.fn(() => 'parser');
    const accessorRequest = { version: UNIFIED_SEARCH_V1 } as Record<
      string,
      unknown
    >;
    Object.defineProperty(accessorRequest, 'query', {
      enumerable: true,
      get: queryGetter,
    });
    const kindGetter = vi.fn(() => 'task');
    const accessorKinds: unknown[] = [];
    Object.defineProperty(accessorKinds, '0', {
      enumerable: true,
      get: kindGetter,
    });
    accessorKinds.length = 1;
    const tokenGetter = vi.fn(() => 'opaque');
    const accessorContinuation = { providerId: 'station.tasks' } as Record<
      string,
      unknown
    >;
    Object.defineProperty(accessorContinuation, 'token', {
      enumerable: true,
      get: tokenGetter,
    });

    await expect(
      service.search(accessorRequest as never),
    ).resolves.toMatchObject({ state: 'invalid' });
    await expect(
      service.search({
        version: UNIFIED_SEARCH_V1,
        query: 'parser',
        filters: { projectId: 'alpha', futureScope: 'secret' } as never,
      }),
    ).resolves.toMatchObject({ state: 'invalid' });
    await expect(
      service.search({
        version: UNIFIED_SEARCH_V1,
        query: 'parser',
        unexpected: true,
      } as never),
    ).resolves.toMatchObject({ state: 'invalid' });
    await expect(
      service.search({
        version: UNIFIED_SEARCH_V1,
        query: 'parser',
        continuations: [
          {
            providerId: 'station.tasks',
            token: 'opaque',
            futureBinding: 'ignored-at-our-peril',
          } as never,
        ],
      }),
    ).resolves.toMatchObject({ state: 'invalid' });
    await expect(
      service.search({
        version: UNIFIED_SEARCH_V1,
        query: 'parser',
        filters: { kinds: accessorKinds } as never,
      }),
    ).resolves.toMatchObject({ state: 'invalid' });
    await expect(
      service.search({
        version: UNIFIED_SEARCH_V1,
        query: 'parser',
        continuations: [accessorContinuation as never],
      }),
    ).resolves.toMatchObject({ state: 'invalid' });
    expect(queryGetter).not.toHaveBeenCalled();
    expect(kindGetter).not.toHaveBeenCalled();
    expect(tokenGetter).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });

  test('rejects non-exact, accessor-backed, proxied, and sparse provider descriptors without invoking them', () => {
    const descriptorGetter = vi.fn(
      () => provider({ id: 'station.tasks' }).descriptor,
    );
    const accessorProvider = {
      search: async () => ({
        version: UNIFIED_SEARCH_V1,
        state: 'available' as const,
        results: [],
      }),
    } as Record<string, unknown>;
    Object.defineProperty(accessorProvider, 'descriptor', {
      enumerable: true,
      get: descriptorGetter,
    });
    expect(() => new UnifiedSearchService([accessorProvider as never])).toThrow(
      TypeError,
    );
    expect(descriptorGetter).not.toHaveBeenCalled();

    const ownerGetter = vi.fn(() => ({
      kind: 'station',
      stationId: 'station-a',
    }));
    const accessorDescriptor = {
      id: 'station.tasks',
      version: '1.0.0',
      kinds: ['task'],
    } as Record<string, unknown>;
    Object.defineProperty(accessorDescriptor, 'owner', {
      enumerable: true,
      get: ownerGetter,
    });
    expect(
      () =>
        new UnifiedSearchService([
          {
            descriptor: accessorDescriptor,
            search: async () => ({
              version: UNIFIED_SEARCH_V1,
              state: 'available',
              results: [],
            }),
          } as never,
        ]),
    ).toThrow(TypeError);
    expect(ownerGetter).not.toHaveBeenCalled();

    const stationIdGetter = vi.fn(() => 'station-a');
    const accessorOwner = { kind: 'station' } as Record<string, unknown>;
    Object.defineProperty(accessorOwner, 'stationId', {
      enumerable: true,
      get: stationIdGetter,
    });
    expect(
      () =>
        new UnifiedSearchService([
          {
            ...provider({ id: 'station.tasks' }),
            descriptor: {
              ...provider({ id: 'station.tasks' }).descriptor,
              owner: accessorOwner,
            },
          } as never,
        ]),
    ).toThrow(TypeError);
    expect(stationIdGetter).not.toHaveBeenCalled();

    const searchGetter = vi.fn(() => async () => ({
      version: UNIFIED_SEARCH_V1,
      state: 'available',
      results: [],
    }));
    const accessorSearch = {
      descriptor: provider({ id: 'station.tasks' }).descriptor,
    } as Record<string, unknown>;
    Object.defineProperty(accessorSearch, 'search', {
      enumerable: true,
      get: searchGetter,
    });
    expect(() => new UnifiedSearchService([accessorSearch as never])).toThrow(
      TypeError,
    );
    expect(searchGetter).not.toHaveBeenCalled();

    const providerGet = vi.fn();
    const proxiedProvider = new Proxy(provider({ id: 'station.tasks' }), {
      get: (target, property, receiver) => {
        providerGet(property);
        return Reflect.get(target, property, receiver);
      },
    });
    expect(() => new UnifiedSearchService([proxiedProvider])).toThrow(
      TypeError,
    );
    expect(providerGet).not.toHaveBeenCalled();

    const sparseProviders = new Array(1) as UnifiedSearchProvider[];
    expect(() => new UnifiedSearchService(sparseProviders)).toThrow(TypeError);

    const kindGetter = vi.fn(() => 'task');
    const accessorKinds: unknown[] = [];
    Object.defineProperty(accessorKinds, '0', {
      enumerable: true,
      get: kindGetter,
    });
    accessorKinds.length = 1;
    expect(
      () =>
        new UnifiedSearchService([
          {
            ...provider({ id: 'station.tasks' }),
            descriptor: {
              ...provider({ id: 'station.tasks' }).descriptor,
              kinds: accessorKinds,
            },
          } as never,
        ]),
    ).toThrow(TypeError);
    expect(kindGetter).not.toHaveBeenCalled();

    expect(
      () =>
        new UnifiedSearchService([
          {
            ...provider({ id: 'station.tasks' }),
            descriptor: {
              ...provider({ id: 'station.tasks' }).descriptor,
              kinds: new Array(1),
            },
          } as never,
        ]),
    ).toThrow(TypeError);

    const searchApply = vi.fn();
    const proxiedSearch = new Proxy(
      async () => ({
        version: UNIFIED_SEARCH_V1,
        state: 'available' as const,
        results: [],
      }),
      { apply: searchApply },
    );
    expect(
      () =>
        new UnifiedSearchService([
          provider({ id: 'station.tasks', search: proxiedSearch }),
        ]),
    ).toThrow(TypeError);
    expect(searchApply).not.toHaveBeenCalled();

    expect(
      () =>
        new UnifiedSearchService([
          {
            ...provider({ id: 'station.tasks' }),
            futureAuthority: true,
          } as never,
        ]),
    ).toThrow(TypeError);
    expect(
      () =>
        new UnifiedSearchService([
          {
            ...provider({ id: 'station.tasks' }),
            descriptor: {
              ...provider({ id: 'station.tasks' }).descriptor,
              futureAuthority: true,
            },
          } as never,
        ]),
    ).toThrow(TypeError);
    expect(
      () =>
        new UnifiedSearchService([
          {
            ...provider({ id: 'station.tasks' }),
            descriptor: {
              ...provider({ id: 'station.tasks' }).descriptor,
              owner: {
                kind: 'station',
                stationId: 'station-a',
                projectionId: undefined,
              },
            },
          } as never,
        ]),
    ).toThrow(TypeError);
  });

  test('attributes aggregate truncation to every source whose results were dropped', async () => {
    const stationId = 's\\'.repeat(128);
    const tenantId = 't\\'.repeat(128);
    const providers = Array.from(
      { length: UNIFIED_SEARCH_LIMITS.providers },
      (_, providerIndex): UnifiedSearchProvider => ({
        descriptor: {
          id: `station.source-${providerIndex}`,
          version: '1.0.0',
          owner: { kind: 'station', stationId, tenantId },
          kinds: ['file'],
        },
        search: async () => ({
          version: UNIFIED_SEARCH_V1,
          state:
            providerIndex === 0 ? ('stale' as const) : ('partial' as const),
          reason:
            providerIndex === 0
              ? ('source-stale' as const)
              : ('source-partial' as const),
          continuation: 'c'.repeat(
            UNIFIED_SEARCH_LIMITS.providerContinuationBytes,
          ),
          results: Array.from(
            { length: UNIFIED_SEARCH_LIMITS.resultsPerProvider },
            (_, resultIndex): UnifiedSearchCandidate => {
              const prefix = `file-${providerIndex}-${resultIndex}-`;
              const id = `${prefix}${'i'.repeat(
                UNIFIED_SEARCH_LIMITS.idBytes - prefix.length,
              )}`;
              return {
                id,
                kind: 'file',
                title: 'x'.repeat(UNIFIED_SEARCH_LIMITS.titleBytes),
                snippet: 'y'.repeat(UNIFIED_SEARCH_LIMITS.snippetBytes),
                matchedFields: ['id', 'title', 'snippet', 'path'],
                currentness: {
                  state: 'stale',
                  observedAt,
                  reason: 'r'.repeat(UNIFIED_SEARCH_LIMITS.reasonBytes),
                },
                relevance: 1,
                openIntent: {
                  kind: 'station-resource',
                  resourceKind: 'file',
                  resourceId: id,
                },
              };
            },
          ),
        }),
      }),
    );
    const service = new UnifiedSearchService(providers);

    const result = await service.search({
      version: UNIFIED_SEARCH_V1,
      query: 'large aggregate',
    });

    expect(result.state).toBe('partial');
    if (result.state === 'invalid')
      throw new Error('unexpected invalid result');
    expect(result.results).toEqual([]);
    expect(result.sources).toHaveLength(UNIFIED_SEARCH_LIMITS.providers);
    expect(result.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerId: 'station.source-0',
          state: 'partial',
          reason: 'aggregate-byte-limit',
          priorCondition: { state: 'stale', reason: 'source-stale' },
        }),
        expect.objectContaining({
          providerId: 'station.source-1',
          state: 'partial',
          reason: 'aggregate-byte-limit',
          priorCondition: { state: 'partial', reason: 'source-partial' },
        }),
      ]),
    );
    expect(
      result.sources.every(
        (source) => source.reason === 'aggregate-byte-limit',
      ),
    ).toBe(true);
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

  test('rejects a message intent that opens a different stable message identity', async () => {
    const service = new UnifiedSearchService([
      {
        descriptor: {
          id: 'station.messages',
          version: '1.0.0',
          owner: { kind: 'station', stationId: 'station-a' },
          kinds: ['message'],
        },
        search: async () => ({
          version: UNIFIED_SEARCH_V1,
          state: 'available',
          results: [
            {
              id: JSON.stringify(['session-1', 'message-shown']),
              kind: 'message',
              scope: { sessionId: 'session-1' },
              title: 'Shown message',
              matchedFields: ['title'],
              currentness: { state: 'current', observedAt },
              relevance: 1,
              openIntent: {
                kind: 'session-message',
                sessionId: 'session-1',
                messageId: 'message-other',
              },
            },
          ],
        }),
      },
    ]);

    await expect(
      service.search({ version: UNIFIED_SEARCH_V1, query: 'shown' }),
    ).resolves.toMatchObject({
      state: 'unavailable',
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
