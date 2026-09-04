import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { types as utilTypes } from 'node:util';
import {
  UNIFIED_SEARCH_V1,
  type UnifiedSearchCandidate,
  type UnifiedSearchCurrentness,
  type UnifiedSearchFilters,
  type UnifiedSearchMatchedField,
  type UnifiedSearchOpenIntent,
  type UnifiedSearchOutcome,
  type UnifiedSearchOwner,
  type UnifiedSearchProvider,
  type UnifiedSearchProviderPage,
  type UnifiedSearchProviderReason,
  type UnifiedSearchRequest,
  type UnifiedSearchResponseState,
  type UnifiedSearchResult,
  type UnifiedSearchResultKind,
  type UnifiedSearchScope,
  type UnifiedSearchSourceState,
} from '@kontourai/station-contracts/unified-search';

export const UNIFIED_SEARCH_LIMITS = Object.freeze({
  providers: 8,
  resultsPerProvider: 8,
  queryBytes: 256,
  idBytes: 256,
  titleBytes: 160,
  snippetBytes: 512,
  reasonBytes: 240,
  providerContinuationBytes: 1_024,
  continuationBytes: 4_096,
  candidateBytes: 2_048,
  responseBytes: 256 * 1_024,
  providerTimeoutMs: 2_000,
});

const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const RESULT_KINDS = new Set<UnifiedSearchResultKind>([
  'project',
  'task',
  'session',
  'message',
  'file',
  'output',
  'run',
  'evidence',
  'receipt',
  'contribution',
]);
const MATCHED_FIELDS = new Set<UnifiedSearchMatchedField>([
  'id',
  'title',
  'description',
  'snippet',
  'label',
  'path',
]);
const PROVIDER_REASONS = new Set<UnifiedSearchProviderReason>([
  'authorization-restricted',
  'continuation-invalid',
  'result-window',
  'source-partial',
  'source-stale',
  'source-unavailable',
]);

type BoundProvider = {
  descriptor: {
    id: string;
    version: string;
    owner: UnifiedSearchOwner;
    kinds: readonly UnifiedSearchResultKind[];
  };
  search: UnifiedSearchProvider['search'];
};

type DataRecord = Readonly<Record<string, unknown>>;

function exactDataRecord(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[] = [],
): DataRecord | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return null;
    if (utilTypes.isProxy(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    if (Object.getOwnPropertySymbols(value).length > 0) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors);
    if (
      keys.some((key) => !allowed.includes(key)) ||
      required.some((key) => !keys.includes(key)) ||
      keys.some((key) => {
        const descriptor = descriptors[key];
        return (
          !descriptor ||
          !('value' in descriptor) ||
          descriptor.enumerable !== true
        );
      })
    ) {
      return null;
    }
    return Object.fromEntries(
      keys.map((key) => [key, descriptors[key]!.value]),
    );
  } catch {
    return null;
  }
}

function denseDataArray(
  value: unknown,
  maximum: number,
): readonly unknown[] | null {
  try {
    if (!Array.isArray(value)) return null;
    if (utilTypes.isProxy(value)) return null;
    if (Object.getPrototypeOf(value) !== Array.prototype) return null;
    if (Object.getOwnPropertySymbols(value).length > 0) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (
      !lengthDescriptor ||
      !('value' in lengthDescriptor) ||
      typeof lengthDescriptor.value !== 'number'
    ) {
      return null;
    }
    const length = lengthDescriptor.value;
    if (length > maximum) return null;
    const keys = Object.keys(descriptors).filter((key) => key !== 'length');
    if (
      keys.length !== length ||
      keys.some((key, index) => key !== String(index)) ||
      keys.some((key) => {
        const descriptor = descriptors[key];
        return (
          !descriptor ||
          !('value' in descriptor) ||
          descriptor.enumerable !== true
        );
      })
    ) {
      return null;
    }
    return keys.map((key) => descriptors[key]!.value);
  } catch {
    return null;
  }
}

function bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function safeText(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value === value.trim() &&
    bytes(value) <= maxBytes &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  );
}

function safeTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function cloneOwner(value: unknown): UnifiedSearchOwner | null {
  const owner = exactDataRecord(
    value,
    ['kind', 'stationId', 'tenantId', 'projectionId'],
    ['kind'],
  );
  if (!owner) return null;
  if (
    owner.kind === 'station' &&
    !Object.hasOwn(owner, 'projectionId') &&
    safeText(owner.stationId, UNIFIED_SEARCH_LIMITS.idBytes) &&
    (owner.tenantId === undefined ||
      safeText(owner.tenantId, UNIFIED_SEARCH_LIMITS.idBytes))
  ) {
    return {
      kind: 'station',
      stationId: owner.stationId,
      ...(typeof owner.tenantId === 'string'
        ? { tenantId: owner.tenantId }
        : {}),
    };
  }
  if (
    owner.kind === 'console-projection' &&
    !Object.hasOwn(owner, 'stationId') &&
    !Object.hasOwn(owner, 'tenantId') &&
    safeText(owner.projectionId, UNIFIED_SEARCH_LIMITS.idBytes)
  ) {
    return { kind: 'console-projection', projectionId: owner.projectionId };
  }
  return null;
}

function cloneScope(value: unknown): UnifiedSearchScope | null | undefined {
  if (value === undefined) return undefined;
  const scope = exactDataRecord(value, ['projectId', 'taskId', 'sessionId']);
  if (!scope) return null;
  if (
    Object.keys(scope).some(
      (key) => !['projectId', 'taskId', 'sessionId'].includes(key),
    )
  ) {
    return null;
  }
  for (const key of ['projectId', 'taskId', 'sessionId'] as const) {
    if (
      scope[key] !== undefined &&
      !safeText(scope[key], UNIFIED_SEARCH_LIMITS.idBytes)
    ) {
      return null;
    }
  }
  return {
    ...(typeof scope.projectId === 'string'
      ? { projectId: scope.projectId }
      : {}),
    ...(typeof scope.taskId === 'string' ? { taskId: scope.taskId } : {}),
    ...(typeof scope.sessionId === 'string'
      ? { sessionId: scope.sessionId }
      : {}),
  };
}

function sameScope(
  left: UnifiedSearchScope | undefined,
  right: UnifiedSearchScope | undefined,
): boolean {
  return (
    left?.projectId === right?.projectId &&
    left?.taskId === right?.taskId &&
    left?.sessionId === right?.sessionId
  );
}

function cloneCurrentness(value: unknown): UnifiedSearchCurrentness | null {
  const currentness = exactDataRecord(
    value,
    ['state', 'observedAt', 'reason', 'replacementId'],
    ['state', 'observedAt'],
  );
  if (!currentness) return null;
  if (!safeTimestamp(currentness.observedAt)) return null;
  switch (currentness.state) {
    case 'current':
    case 'external-live':
    case 'missing':
      return { state: currentness.state, observedAt: currentness.observedAt };
    case 'stale':
      return safeText(currentness.reason, UNIFIED_SEARCH_LIMITS.reasonBytes)
        ? {
            state: 'stale',
            observedAt: currentness.observedAt,
            reason: currentness.reason,
          }
        : null;
    case 'superseded':
      return currentness.replacementId === undefined ||
        safeText(currentness.replacementId, UNIFIED_SEARCH_LIMITS.idBytes)
        ? {
            state: 'superseded',
            observedAt: currentness.observedAt,
            ...(typeof currentness.replacementId === 'string'
              ? { replacementId: currentness.replacementId }
              : {}),
          }
        : null;
    default:
      return null;
  }
}

function cloneOpenIntent(
  value: unknown,
  candidateId: string,
  candidateKind: UnifiedSearchResultKind,
  candidateScope: UnifiedSearchScope | undefined,
  owner: UnifiedSearchOwner,
): UnifiedSearchOpenIntent | null {
  const intent = exactDataRecord(
    value,
    [
      'kind',
      'projectId',
      'taskId',
      'sessionId',
      'messageId',
      'resourceKind',
      'resourceId',
      'scope',
      'projectionId',
    ],
    ['kind'],
  );
  if (!intent) return null;
  if (
    intent.kind === 'task' &&
    candidateKind === 'task' &&
    safeText(intent.projectId, UNIFIED_SEARCH_LIMITS.idBytes) &&
    safeText(intent.taskId, UNIFIED_SEARCH_LIMITS.idBytes) &&
    intent.taskId === candidateId &&
    intent.projectId === candidateScope?.projectId &&
    intent.taskId === candidateScope.taskId &&
    owner.kind === 'station'
  ) {
    return {
      kind: 'task',
      projectId: intent.projectId,
      taskId: intent.taskId,
    };
  }
  if (
    intent.kind === 'session-message' &&
    candidateKind === 'message' &&
    safeText(intent.sessionId, UNIFIED_SEARCH_LIMITS.idBytes) &&
    safeText(intent.messageId, UNIFIED_SEARCH_LIMITS.idBytes) &&
    intent.sessionId === candidateScope?.sessionId &&
    candidateId === JSON.stringify([intent.sessionId, intent.messageId]) &&
    owner.kind === 'station'
  ) {
    return {
      kind: 'session-message',
      sessionId: intent.sessionId,
      messageId: intent.messageId,
    };
  }
  if (
    intent.kind === 'station-resource' &&
    owner.kind === 'station' &&
    candidateKind !== 'task' &&
    candidateKind !== 'message' &&
    intent.resourceKind === candidateKind &&
    intent.resourceId === candidateId &&
    safeText(intent.resourceId, UNIFIED_SEARCH_LIMITS.idBytes)
  ) {
    const scope = cloneScope(intent.scope);
    if (scope === null || !sameScope(scope, candidateScope)) return null;
    return {
      kind: 'station-resource',
      resourceKind: candidateKind,
      resourceId: candidateId,
      ...(scope ? { scope } : {}),
    };
  }
  if (
    intent.kind === 'console-projection' &&
    owner.kind === 'console-projection' &&
    intent.projectionId === owner.projectionId &&
    intent.resourceId === candidateId &&
    safeText(intent.resourceId, UNIFIED_SEARCH_LIMITS.idBytes)
  ) {
    return {
      kind: 'console-projection',
      projectionId: owner.projectionId,
      resourceId: candidateId,
    };
  }
  return null;
}

function cloneCandidate(
  value: unknown,
  owner: UnifiedSearchOwner,
): UnifiedSearchCandidate | null {
  try {
    const candidate = exactDataRecord(
      value,
      [
        'id',
        'kind',
        'scope',
        'title',
        'snippet',
        'matchedFields',
        'currentness',
        'relevance',
        'openIntent',
      ],
      [
        'id',
        'kind',
        'title',
        'matchedFields',
        'currentness',
        'relevance',
        'openIntent',
      ],
    );
    if (!candidate) return null;
    const matchedFields = denseDataArray(
      candidate.matchedFields,
      MATCHED_FIELDS.size,
    );
    if (
      !safeText(candidate.id, UNIFIED_SEARCH_LIMITS.idBytes) ||
      typeof candidate.kind !== 'string' ||
      !RESULT_KINDS.has(candidate.kind as UnifiedSearchResultKind) ||
      !safeText(candidate.title, UNIFIED_SEARCH_LIMITS.titleBytes) ||
      (candidate.snippet !== undefined &&
        !safeText(candidate.snippet, UNIFIED_SEARCH_LIMITS.snippetBytes)) ||
      typeof candidate.relevance !== 'number' ||
      !Number.isFinite(candidate.relevance) ||
      candidate.relevance < 0 ||
      candidate.relevance > 1 ||
      !matchedFields ||
      matchedFields.length < 1 ||
      !matchedFields.every(
        (field) =>
          typeof field === 'string' &&
          MATCHED_FIELDS.has(field as UnifiedSearchMatchedField),
      ) ||
      new Set(matchedFields).size !== matchedFields.length
    ) {
      return null;
    }
    const scope = cloneScope(candidate.scope);
    const currentness = cloneCurrentness(candidate.currentness);
    if (scope === null || !currentness) return null;
    const kind = candidate.kind as UnifiedSearchResultKind;
    const intent = cloneOpenIntent(
      candidate.openIntent,
      candidate.id,
      kind,
      scope,
      owner,
    );
    if (!intent) return null;
    const result: UnifiedSearchCandidate = {
      id: candidate.id,
      kind,
      ...(scope ? { scope } : {}),
      title: candidate.title,
      ...(typeof candidate.snippet === 'string'
        ? { snippet: candidate.snippet }
        : {}),
      matchedFields: [...matchedFields] as UnifiedSearchMatchedField[],
      currentness,
      relevance: candidate.relevance,
      openIntent: intent,
    };
    return bytes(JSON.stringify(result)) <= UNIFIED_SEARCH_LIMITS.candidateBytes
      ? result
      : null;
  } catch {
    return null;
  }
}

function providerKey(
  providerId: string,
  owner: UnifiedSearchOwner,
  resultId: string,
): string {
  return JSON.stringify([
    providerId,
    owner.kind,
    owner.kind === 'station' ? owner.stationId : owner.projectionId,
    owner.kind === 'station' ? (owner.tenantId ?? '') : '',
    resultId,
  ]);
}

function clonePage(
  value: unknown,
  owner: UnifiedSearchOwner,
  limit: number,
): UnifiedSearchProviderPage | null {
  try {
    const page = exactDataRecord(
      value,
      ['version', 'state', 'results', 'continuation', 'reason'],
      ['version', 'state'],
    );
    if (!page) return null;
    if (page.version !== UNIFIED_SEARCH_V1) return null;
    if (page.state === 'restricted' || page.state === 'unavailable') {
      return typeof page.reason === 'string' &&
        PROVIDER_REASONS.has(page.reason as UnifiedSearchProviderReason)
        ? {
            version: UNIFIED_SEARCH_V1,
            state: page.state,
            reason: page.reason as UnifiedSearchProviderReason,
          }
        : null;
    }
    if (!['available', 'stale', 'partial'].includes(page.state as string)) {
      return null;
    }
    const candidates = denseDataArray(page.results, limit);
    if (!candidates) return null;
    if (
      page.continuation !== undefined &&
      !safeText(
        page.continuation,
        UNIFIED_SEARCH_LIMITS.providerContinuationBytes,
      )
    ) {
      return null;
    }
    if (
      page.state !== 'available' &&
      (typeof page.reason !== 'string' ||
        !PROVIDER_REASONS.has(page.reason as UnifiedSearchProviderReason))
    ) {
      return null;
    }
    if (page.state === 'available' && page.reason !== undefined) return null;
    const results = candidates.map((candidate) =>
      cloneCandidate(candidate, owner),
    );
    if (results.some((candidate) => candidate === null)) return null;
    const ids = results.map((candidate) => candidate!.id);
    if (new Set(ids).size !== ids.length) return null;
    return {
      version: UNIFIED_SEARCH_V1,
      state: page.state as 'available' | 'stale' | 'partial',
      results: results as UnifiedSearchCandidate[],
      ...(typeof page.continuation === 'string'
        ? { continuation: page.continuation }
        : {}),
      ...(typeof page.reason === 'string'
        ? { reason: page.reason as UnifiedSearchProviderReason }
        : {}),
    };
  } catch {
    return null;
  }
}

function cloneFilters(value: unknown): UnifiedSearchFilters | null | undefined {
  if (value === undefined) return undefined;
  const filters = exactDataRecord(value, ['kinds', 'projectId', 'taskId']);
  if (!filters) return null;
  const kinds =
    filters.kinds === undefined
      ? undefined
      : denseDataArray(filters.kinds, RESULT_KINDS.size);
  if (
    filters.kinds !== undefined &&
    (!kinds?.every(
      (kind) =>
        typeof kind === 'string' &&
        RESULT_KINDS.has(kind as UnifiedSearchResultKind),
    ) ||
      new Set(kinds).size !== kinds.length)
  ) {
    return null;
  }
  for (const key of ['projectId', 'taskId'] as const) {
    if (
      filters[key] !== undefined &&
      !safeText(filters[key], UNIFIED_SEARCH_LIMITS.idBytes)
    ) {
      return null;
    }
  }
  return {
    ...(kinds ? { kinds: [...kinds] as UnifiedSearchResultKind[] } : {}),
    ...(typeof filters.projectId === 'string'
      ? { projectId: filters.projectId }
      : {}),
    ...(typeof filters.taskId === 'string' ? { taskId: filters.taskId } : {}),
  };
}

function responseState(
  results: readonly UnifiedSearchResult[],
  sources: readonly UnifiedSearchSourceState[],
): UnifiedSearchResponseState {
  const states = new Set(sources.map((source) => source.state));
  if (
    results.length > 0 &&
    (states.has('partial') ||
      states.has('restricted') ||
      states.has('unavailable'))
  ) {
    return 'partial';
  }
  if (states.has('partial')) return 'partial';
  if (states.size > 0 && [...states].every((state) => state === 'restricted')) {
    return 'restricted';
  }
  if (states.has('unavailable')) return 'unavailable';
  if (states.has('restricted')) return 'restricted';
  if (states.has('stale')) return 'stale';
  return 'complete';
}

export class UnifiedSearchService {
  private readonly providers: readonly BoundProvider[];
  private readonly continuationKey = randomBytes(32);

  constructor(providers: readonly UnifiedSearchProvider[]) {
    const providerValues = denseDataArray(
      providers,
      UNIFIED_SEARCH_LIMITS.providers,
    );
    if (!providerValues || providerValues.length < 1) {
      throw new TypeError(
        `Unified search requires 1 to ${UNIFIED_SEARCH_LIMITS.providers} providers`,
      );
    }
    const ids = new Set<string>();
    this.providers = Object.freeze(
      providerValues.map((providerValue) => {
        try {
          const provider = exactDataRecord(
            providerValue,
            ['descriptor', 'search'],
            ['descriptor', 'search'],
          );
          const descriptor = exactDataRecord(
            provider?.descriptor,
            ['id', 'version', 'owner', 'kinds'],
            ['id', 'version', 'owner', 'kinds'],
          );
          const owner = cloneOwner(descriptor?.owner);
          const kinds = denseDataArray(descriptor?.kinds, RESULT_KINDS.size);
          const search = provider?.search;
          if (
            !provider ||
            !descriptor ||
            typeof descriptor.id !== 'string' ||
            !PROVIDER_ID.test(descriptor.id) ||
            !safeText(descriptor.version, 64) ||
            !owner ||
            !kinds ||
            kinds.length < 1 ||
            !kinds.every(
              (kind) =>
                typeof kind === 'string' &&
                RESULT_KINDS.has(kind as UnifiedSearchResultKind),
            ) ||
            new Set(kinds).size !== kinds.length ||
            typeof search !== 'function' ||
            utilTypes.isProxy(search) ||
            ids.has(descriptor.id)
          ) {
            throw new TypeError(
              'Unified search provider descriptor is invalid',
            );
          }
          ids.add(descriptor.id);
          const boundDescriptor = Object.freeze({
            id: descriptor.id,
            version: descriptor.version,
            owner: Object.freeze(owner),
            kinds: Object.freeze([
              ...kinds,
            ]) as readonly UnifiedSearchResultKind[],
          });
          const receiver = Object.freeze({ descriptor: boundDescriptor });
          const bound: BoundProvider = {
            descriptor: boundDescriptor,
            search: (request, signal) =>
              Reflect.apply(search, receiver, [request, signal]),
          };
          return Object.freeze(bound);
        } catch (error) {
          if (error instanceof TypeError) throw error;
          throw new TypeError('Unified search provider descriptor is invalid');
        }
      }),
    );
  }

  async search(
    request: UnifiedSearchRequest,
    signal?: AbortSignal,
  ): Promise<UnifiedSearchOutcome> {
    let query: string;
    let filters: UnifiedSearchFilters | undefined;
    const continuations = new Map<string, string>();
    try {
      const parsedRequest = exactDataRecord(
        request,
        ['version', 'query', 'filters', 'continuations'],
        ['version', 'query'],
      );
      if (
        !parsedRequest ||
        parsedRequest.version !== UNIFIED_SEARCH_V1 ||
        typeof parsedRequest.query !== 'string'
      ) {
        throw new Error();
      }
      query = parsedRequest.query.trim();
      if (query.length < 2 || bytes(query) > UNIFIED_SEARCH_LIMITS.queryBytes) {
        throw new Error();
      }
      const parsedFilters = cloneFilters(parsedRequest.filters);
      if (parsedFilters === null) throw new Error();
      filters = parsedFilters;
      if (parsedRequest.continuations !== undefined) {
        const parsedContinuations = denseDataArray(
          parsedRequest.continuations,
          this.providers.length,
        );
        if (!parsedContinuations) throw new Error();
        for (const continuationValue of parsedContinuations) {
          const continuation = exactDataRecord(
            continuationValue,
            ['providerId', 'token'],
            ['providerId', 'token'],
          );
          if (
            !continuation ||
            typeof continuation.providerId !== 'string' ||
            !PROVIDER_ID.test(continuation.providerId) ||
            !safeText(
              continuation.token,
              UNIFIED_SEARCH_LIMITS.continuationBytes,
            ) ||
            continuations.has(continuation.providerId) ||
            !this.providers.some(
              (provider) => provider.descriptor.id === continuation.providerId,
            )
          ) {
            throw new Error();
          }
          continuations.set(continuation.providerId, continuation.token);
        }
      }
    } catch {
      return {
        version: UNIFIED_SEARCH_V1,
        state: 'invalid',
        reason: 'Search request is invalid',
      };
    }

    const activeProviders = filters?.kinds
      ? this.providers.filter((provider) =>
          provider.descriptor.kinds.some((kind) =>
            filters!.kinds!.includes(kind),
          ),
        )
      : this.providers;
    const settled = await Promise.all(
      activeProviders.map((provider) =>
        this.searchProvider(
          provider,
          query,
          filters,
          continuations.get(provider.descriptor.id),
          signal,
        ),
      ),
    );
    const sources = settled.map((entry) => entry.source);
    if (signal?.aborted) {
      return {
        version: UNIFIED_SEARCH_V1,
        state: 'unavailable',
        results: [],
        sources: sources.map((source) => ({
          providerId: source.providerId,
          owner: source.owner,
          state: 'unavailable',
          reason: 'search-cancelled',
        })),
      };
    }
    const results = settled
      .flatMap((entry) => entry.results)
      .sort((left, right) => right.relevance - left.relevance);
    const response = {
      version: UNIFIED_SEARCH_V1,
      state: responseState(results, sources),
      results,
      sources,
    } satisfies UnifiedSearchOutcome;
    if (
      bytes(JSON.stringify(response)) <= UNIFIED_SEARCH_LIMITS.responseBytes
    ) {
      return response;
    }
    return {
      ...response,
      state: 'partial',
      results: [],
      sources: sources.map((source, index) => {
        if (settled[index]!.results.length === 0) return source;
        const priorReason = PROVIDER_REASONS.has(
          source.reason as UnifiedSearchProviderReason,
        )
          ? (source.reason as UnifiedSearchProviderReason)
          : undefined;
        return {
          ...source,
          state: 'partial' as const,
          reason: 'aggregate-byte-limit' as const,
          priorCondition: {
            state: source.state,
            ...(priorReason ? { reason: priorReason } : {}),
          },
        };
      }),
    };
  }

  private async searchProvider(
    provider: BoundProvider,
    query: string,
    filters: UnifiedSearchFilters | undefined,
    continuation: string | undefined,
    outerSignal: AbortSignal | undefined,
  ): Promise<{
    source: UnifiedSearchSourceState;
    results: UnifiedSearchResult[];
  }> {
    const unavailableSource = (
      reason: NonNullable<UnifiedSearchSourceState['reason']>,
    ): UnifiedSearchSourceState => ({
      providerId: provider.descriptor.id,
      owner: provider.descriptor.owner,
      state: 'unavailable',
      reason,
    });
    if (outerSignal?.aborted) {
      return { source: unavailableSource('search-cancelled'), results: [] };
    }
    const providerContinuation = continuation
      ? this.unwrapContinuation(provider, query, filters, continuation)
      : undefined;
    if (continuation && providerContinuation === null) {
      return { source: unavailableSource('continuation-invalid'), results: [] };
    }
    const controller = new AbortController();
    const deadline =
      performance.now() + UNIFIED_SEARCH_LIMITS.providerTimeoutMs;
    const requireWithinDeadline = () => {
      if (controller.signal.aborted || performance.now() >= deadline) {
        throw new Error('search-aborted');
      }
    };
    const abort = () => controller.abort();
    outerSignal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, UNIFIED_SEARCH_LIMITS.providerTimeoutMs);
    let rejectAbort: () => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = () => reject(new Error('search-aborted'));
      controller.signal.addEventListener('abort', rejectAbort, { once: true });
      if (controller.signal.aborted) rejectAbort();
    });
    try {
      const providerFilters = filters
        ? Object.freeze({
            ...filters,
            ...(filters.kinds
              ? { kinds: Object.freeze([...filters.kinds]) }
              : {}),
          })
        : undefined;
      const providerRequest = Object.freeze({
        version: UNIFIED_SEARCH_V1,
        query,
        limit: UNIFIED_SEARCH_LIMITS.resultsPerProvider,
        ...(providerContinuation ? { continuation: providerContinuation } : {}),
        ...(providerFilters
          ? { filters: providerFilters as UnifiedSearchFilters }
          : {}),
      });
      const page = await Promise.race([
        Promise.resolve().then(() => {
          requireWithinDeadline();
          return provider.search(providerRequest, controller.signal);
        }),
        aborted,
      ]);
      requireWithinDeadline();
      const normalized = clonePage(
        page,
        provider.descriptor.owner,
        UNIFIED_SEARCH_LIMITS.resultsPerProvider,
      );
      requireWithinDeadline();
      if (!normalized) {
        return {
          source: unavailableSource('provider-response-invalid'),
          results: [],
        };
      }
      if (
        normalized.state === 'restricted' ||
        normalized.state === 'unavailable'
      ) {
        return {
          source: {
            providerId: provider.descriptor.id,
            owner: provider.descriptor.owner,
            state: normalized.state,
            reason: normalized.reason,
          },
          results: [],
        };
      }
      if (
        normalized.results.some(
          (candidate) =>
            !provider.descriptor.kinds.includes(candidate.kind) ||
            (filters?.kinds && !filters.kinds.includes(candidate.kind)) ||
            (filters?.projectId &&
              candidate.scope?.projectId !== filters.projectId) ||
            (filters?.taskId && candidate.scope?.taskId !== filters.taskId),
        )
      ) {
        return {
          source: unavailableSource('provider-response-invalid'),
          results: [],
        };
      }
      const results = normalized.results.map((candidate) => ({
        ...candidate,
        version: UNIFIED_SEARCH_V1,
        key: providerKey(
          provider.descriptor.id,
          provider.descriptor.owner,
          candidate.id,
        ),
        providerId: provider.descriptor.id,
        owner: provider.descriptor.owner,
      }));
      requireWithinDeadline();
      return {
        source: {
          providerId: provider.descriptor.id,
          owner: provider.descriptor.owner,
          state: normalized.state,
          ...(normalized.reason ? { reason: normalized.reason } : {}),
          ...(normalized.continuation
            ? {
                continuation: this.wrapContinuation(
                  provider,
                  query,
                  filters,
                  normalized.continuation,
                ),
              }
            : {}),
        },
        results,
      };
    } catch {
      return {
        source: unavailableSource(
          outerSignal?.aborted
            ? 'search-cancelled'
            : 'provider-timeout-or-error',
        ),
        results: [],
      };
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', rejectAbort);
      outerSignal?.removeEventListener('abort', abort);
    }
  }

  private continuationBinding(
    provider: BoundProvider,
    query: string,
    filters: UnifiedSearchFilters | undefined,
  ) {
    const digest = (value: unknown) =>
      createHash('sha256').update(JSON.stringify(value)).digest('base64url');
    return {
      providerId: provider.descriptor.id,
      providerVersion: provider.descriptor.version,
      owner: digest(provider.descriptor.owner),
      query: digest(query),
      filters: digest(filters ?? null),
    };
  }

  private wrapContinuation(
    provider: BoundProvider,
    query: string,
    filters: UnifiedSearchFilters | undefined,
    providerToken: string,
  ): string {
    const payload = JSON.stringify({
      version: 1,
      ...this.continuationBinding(provider, query, filters),
      providerToken,
    });
    const signature = createHmac('sha256', this.continuationKey)
      .update(payload)
      .digest('base64url');
    return `${Buffer.from(payload).toString('base64url')}.${signature}`;
  }

  private unwrapContinuation(
    provider: BoundProvider,
    query: string,
    filters: UnifiedSearchFilters | undefined,
    token: string,
  ): string | null {
    try {
      const [encoded, suppliedSignature, extra] = token.split('.');
      if (!encoded || !suppliedSignature || extra !== undefined) return null;
      const payload = Buffer.from(encoded, 'base64url').toString('utf8');
      const expectedSignature = createHmac('sha256', this.continuationKey)
        .update(payload)
        .digest();
      const signature = Buffer.from(suppliedSignature, 'base64url');
      if (
        signature.length !== expectedSignature.length ||
        !timingSafeEqual(signature, expectedSignature)
      ) {
        return null;
      }
      const parsed = exactDataRecord(
        JSON.parse(payload),
        [
          'version',
          'providerId',
          'providerVersion',
          'owner',
          'query',
          'filters',
          'providerToken',
        ],
        [
          'version',
          'providerId',
          'providerVersion',
          'owner',
          'query',
          'filters',
          'providerToken',
        ],
      );
      const binding = this.continuationBinding(provider, query, filters);
      if (
        parsed?.version !== 1 ||
        parsed.providerId !== binding.providerId ||
        parsed.providerVersion !== binding.providerVersion ||
        parsed.owner !== binding.owner ||
        parsed.query !== binding.query ||
        parsed.filters !== binding.filters ||
        !safeText(
          parsed.providerToken,
          UNIFIED_SEARCH_LIMITS.providerContinuationBytes,
        )
      ) {
        return null;
      }
      return parsed.providerToken;
    } catch {
      return null;
    }
  }
}
