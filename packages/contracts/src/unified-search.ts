/** Public contract version for Station's bounded search composition. */
export const UNIFIED_SEARCH_V1 = 'station.unified-search/v1' as const;

export type UnifiedSearchResultKind =
  | 'project'
  | 'task'
  | 'session'
  | 'message'
  | 'file'
  | 'output'
  | 'run'
  | 'evidence'
  | 'receipt'
  | 'contribution';

/** Semantic ownership remains attached to every result after aggregation. */
export type UnifiedSearchOwner =
  | {
      kind: 'station';
      stationId: string;
      tenantId?: string;
    }
  | {
      /** May be supplied only by Console's future published search Adapter. */
      kind: 'console-projection';
      projectionId: string;
    };

export interface UnifiedSearchScope {
  projectId?: string;
  taskId?: string;
  sessionId?: string;
}

export type UnifiedSearchCurrentness =
  | { state: 'current'; observedAt: string }
  | { state: 'stale'; observedAt: string; reason: string }
  | { state: 'superseded'; observedAt: string; replacementId?: string }
  | { state: 'missing'; observedAt: string }
  | { state: 'external-live'; observedAt: string };

export type UnifiedSearchMatchedField =
  | 'id'
  | 'title'
  | 'description'
  | 'snippet'
  | 'label'
  | 'path';

/** Host-resolved intent. Cached search data never grants open authority. */
export type UnifiedSearchOpenIntent =
  | { kind: 'task'; projectId: string; taskId: string }
  | { kind: 'session-message'; sessionId: string; messageId: string }
  | {
      kind: 'station-resource';
      resourceKind: Exclude<UnifiedSearchResultKind, 'task' | 'message'>;
      resourceId: string;
      scope?: UnifiedSearchScope;
    }
  | {
      kind: 'console-projection';
      projectionId: string;
      resourceId: string;
    };

/** Candidate returned by one authorized provider before owner stamping. */
export interface UnifiedSearchCandidate {
  id: string;
  kind: UnifiedSearchResultKind;
  scope?: UnifiedSearchScope;
  title: string;
  snippet?: string;
  matchedFields: UnifiedSearchMatchedField[];
  currentness: UnifiedSearchCurrentness;
  relevance: number;
  openIntent: UnifiedSearchOpenIntent;
}

/** Owner-qualified, collision-free result emitted by the aggregator. */
export interface UnifiedSearchResult extends UnifiedSearchCandidate {
  version: typeof UNIFIED_SEARCH_V1;
  key: string;
  providerId: string;
  owner: UnifiedSearchOwner;
}

export interface UnifiedSearchFilters {
  kinds?: UnifiedSearchResultKind[];
  projectId?: string;
  taskId?: string;
}

export interface UnifiedSearchProviderRequest {
  version: typeof UNIFIED_SEARCH_V1;
  query: string;
  limit: number;
  continuation?: string;
  filters?: UnifiedSearchFilters;
}

/** Closed provider reason vocabulary; source state cannot carry resource ids. */
export type UnifiedSearchProviderReason =
  | 'authorization-restricted'
  | 'continuation-invalid'
  | 'result-window'
  | 'source-partial'
  | 'source-stale'
  | 'source-unavailable';

export type UnifiedSearchProviderPage =
  | {
      version: typeof UNIFIED_SEARCH_V1;
      state: 'available' | 'stale' | 'partial';
      results: UnifiedSearchCandidate[];
      continuation?: string;
      reason?: UnifiedSearchProviderReason;
    }
  | {
      version: typeof UNIFIED_SEARCH_V1;
      state: 'restricted';
      /** Provider-level policy reason; never a hidden resource identity/count. */
      reason: UnifiedSearchProviderReason;
    }
  | {
      version: typeof UNIFIED_SEARCH_V1;
      state: 'unavailable';
      reason: UnifiedSearchProviderReason;
    };

export interface UnifiedSearchProviderDescriptor {
  id: string;
  version: string;
  owner: UnifiedSearchOwner;
  kinds: UnifiedSearchResultKind[];
}

export interface UnifiedSearchProvider {
  descriptor: UnifiedSearchProviderDescriptor;
  search(
    request: UnifiedSearchProviderRequest,
    signal: AbortSignal,
  ): Promise<UnifiedSearchProviderPage>;
}

export interface UnifiedSearchRequest {
  version: typeof UNIFIED_SEARCH_V1;
  query: string;
  filters?: UnifiedSearchFilters;
  continuations?: Array<{ providerId: string; token: string }>;
}

export interface UnifiedSearchSourceState {
  providerId: string;
  owner: UnifiedSearchOwner;
  state: UnifiedSearchProviderPage['state'];
  reason?:
    | UnifiedSearchProviderReason
    | 'aggregate-byte-limit'
    | 'provider-response-invalid'
    | 'provider-timeout-or-error'
    | 'search-cancelled';
  continuation?: string;
  /** Source condition before the aggregate dropped accepted results for its cap. */
  priorCondition?: {
    state: UnifiedSearchProviderPage['state'];
    reason?: UnifiedSearchProviderReason;
  };
}

export type UnifiedSearchResponseState =
  | 'complete'
  | 'partial'
  | 'restricted'
  | 'unavailable'
  | 'stale';

export interface UnifiedSearchResponse {
  version: typeof UNIFIED_SEARCH_V1;
  state: UnifiedSearchResponseState;
  results: UnifiedSearchResult[];
  sources: UnifiedSearchSourceState[];
}

export type UnifiedSearchOutcome =
  | { state: 'invalid'; reason: string; version: typeof UNIFIED_SEARCH_V1 }
  | UnifiedSearchResponse;
