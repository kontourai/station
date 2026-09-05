/**
 * K4 knowledge-store-root React Query hooks (`s202-knowledge-onboarding`
 * Wave 1) — the first React hooks over the K2 store-root registry
 * (`listRoots`/`createRoot`/`removeRoot`/`listAdapters`/
 * `validateRootForAdapter`, `src-server/routes/knowledge/knowledge-store-routes.ts`).
 * Mirrors `./projectData.ts`'s hook-shape conventions: `useApiQuery` for
 * reads, `useMutation` + `queryClient.invalidateQueries` on success for
 * writes. Also adds `useMigratePreIndexKnowledgeMutation`, wrapping the
 * pre-existing `migratePreIndexKnowledge` fetcher (K3 Wave 4, `../client/
 * knowledge.ts`) which shipped with no React hook of its own — Wave 2's
 * project-settings task depends on this hook living here.
 */
import type {
  KitRecord,
  KitRecordType,
  KnowledgeAdapterDescriptor,
  KnowledgeStoreRoot,
} from '@kontourai/station-contracts/knowledge-store';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { _getApiBase } from '../api';
import {
  type CreateKnowledgeRecordInput,
  type CreateKnowledgeRootInput,
  createKnowledgeRecord,
  createKnowledgeRoot,
  deleteKnowledgeRoot,
  getKnowledgeGraph,
  getKnowledgeGraphNeo4j,
  getKnowledgeRecord,
  type KnowledgeGraph,
  type KnowledgeGraphNeo4jSyncStats,
  type KnowledgeSearchResult,
  type LinkKnowledgeRecordInput,
  linkKnowledgeRecord,
  listKnowledgeAdapters,
  listKnowledgeRecordsByType,
  listKnowledgeRoots,
  type MigratePreIndexKnowledgeOptions,
  type MigratePreIndexKnowledgeResult,
  migratePreIndexKnowledge,
  type SearchKnowledgeIndexOptions,
  searchKnowledgeIndex,
  syncKnowledgeGraphNeo4j,
  type ValidateKnowledgeRootInput,
  validateKnowledgeRoot,
} from '../client/knowledge';
import {
  type LearningSourceReference,
  observeLearningSource,
} from '../client/learning-source';
import type { ApiRequestScope } from '../query-core';
import { type QueryConfig, useApiQuery } from '../query-core';

/** Shared root-list query key, so mutations below can invalidate exactly
 * what the read hooks key against. */
const KNOWLEDGE_ROOTS_QUERY_KEY = ['knowledge', 'roots'] as const;
const KNOWLEDGE_ADAPTERS_QUERY_KEY = ['knowledge', 'adapters'] as const;

/** `GET /api/knowledge/roots` — every registered knowledge-store root. */
export function useKnowledgeRootsQuery(
  config?: QueryConfig<KnowledgeStoreRoot[]>,
) {
  return useApiQuery<KnowledgeStoreRoot[]>(
    [...KNOWLEDGE_ROOTS_QUERY_KEY],
    async () => {
      const apiBase = await _getApiBase();
      return listKnowledgeRoots(apiBase);
    },
    config,
  );
}

/** `GET /api/knowledge/adapters` — every registered adapter descriptor
 * (id/displayName only). */
export function useKnowledgeAdaptersQuery(
  config?: QueryConfig<
    Pick<KnowledgeAdapterDescriptor, 'id' | 'displayName'>[]
  >,
) {
  return useApiQuery<Pick<KnowledgeAdapterDescriptor, 'id' | 'displayName'>[]>(
    [...KNOWLEDGE_ADAPTERS_QUERY_KEY],
    async () => {
      const apiBase = await _getApiBase();
      return listKnowledgeAdapters(apiBase);
    },
    { staleTime: 5 * 60 * 1000, ...config },
  );
}

/** `POST /api/knowledge/roots` — register a new root, then refresh the root list. */
export function useCreateKnowledgeRootMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateKnowledgeRootInput) => {
      const apiBase = await _getApiBase();
      return createKnowledgeRoot(apiBase, input);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: [...KNOWLEDGE_ROOTS_QUERY_KEY],
      });
    },
  });
}

/**
 * `POST /api/knowledge/roots/validate` — no query invalidation (read-only
 * probe of a candidate path; never mutates the registry). Callers render
 * `result.reason` verbatim on `ok:false` — see `../client/knowledge.ts`'s
 * `validateKnowledgeRoot` docblock for the honesty contract this preserves.
 */
export function useValidateKnowledgeRootMutation() {
  return useMutation({
    mutationFn: async (input: ValidateKnowledgeRootInput) => {
      const apiBase = await _getApiBase();
      return validateKnowledgeRoot(apiBase, input);
    },
  });
}

/** `DELETE /api/knowledge/roots/:id` — deregister a root (never deletes
 * store files), then refresh the root list. */
export function useDeleteKnowledgeRootMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (rootId: string) => {
      const apiBase = await _getApiBase();
      return deleteKnowledgeRoot(apiBase, rootId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: [...KNOWLEDGE_ROOTS_QUERY_KEY],
      });
    },
  });
}

/**
 * `POST /api/knowledge/migrate` — wraps the pre-existing `migratePreIndexKnowledge`
 * fetcher (K3 Wave 4) in a hook for the first time. Non-destructive: never
 * deletes/mutates the pre-index source trees it migrates from. Invalidates both
 * the knowledge-store root list (migration may create a new root) and the
 * pre-index knowledge status/doc queries (`./projectData.ts`'s `['knowledge',
 * 'status', projectSlug]` / `['knowledge', 'docs', projectSlug]` keys) so
 * the UI reflects the migrated state without a manual refetch.
 */
export function useMigratePreIndexKnowledgeMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      opts?: MigratePreIndexKnowledgeOptions,
    ): Promise<MigratePreIndexKnowledgeResult> => {
      const apiBase = await _getApiBase();
      return migratePreIndexKnowledge(apiBase, opts);
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: [...KNOWLEDGE_ROOTS_QUERY_KEY],
      });
      if (variables?.projectSlug) {
        queryClient.invalidateQueries({
          queryKey: ['knowledge', 'status', variables.projectSlug],
        });
        queryClient.invalidateQueries({
          queryKey: ['knowledge', 'docs', variables.projectSlug],
        });
      }
    },
  });
}

/**
 * K5 knowledge-record + index-search hooks (`s203-knowledge-meeting-notes` Wave 1
 * Task 2) — thin `useApiQuery`/`useMutation` wrappers over the record-CRUD fetchers
 * and the K3 index-search fetcher added to `../client/knowledge.ts` alongside this
 * file. Mirrors this file's own `useApiQuery`-for-reads / `useMutation`-plus-
 * `invalidateQueries`-for-writes convention.
 */

/** Query key for a root's records of one type — `listByType`'s own scoping. */
function knowledgeRecordsQueryKey(rootId: string, type: KitRecordType) {
  return ['knowledge', 'records', rootId, type] as const;
}
function knowledgeRecordQueryKey(rootId: string, id: string) {
  return ['knowledge', 'record', rootId, id] as const;
}
function knowledgeGraphQueryKey(rootId: string) {
  return ['knowledge', 'graph', rootId] as const;
}
function knowledgeGraphNeo4jQueryKey(rootId: string) {
  return ['knowledge', 'graph-neo4j', rootId] as const;
}

/** `GET /api/knowledge/roots/:rootId/records?type=` */
export function useKnowledgeRecordsByTypeQuery(
  rootId: string | undefined,
  type: KitRecordType | undefined,
  options?: { includeRetired?: boolean },
  config?: QueryConfig<KitRecord[]>,
) {
  return useApiQuery<KitRecord[]>(
    [...knowledgeRecordsQueryKey(rootId ?? '', type ?? 'raw')],
    async () => {
      const apiBase = await _getApiBase();
      return listKnowledgeRecordsByType(
        apiBase,
        rootId as string,
        type as KitRecordType,
        options,
      );
    },
    { enabled: Boolean(rootId && type), ...config },
  );
}

/** `GET /api/knowledge/roots/:rootId/records/:id` — full-id lookup only (see
 * `../client/knowledge.ts`'s `getKnowledgeRecord` doc comment). */
export function useKnowledgeRecordQuery(
  rootId: string | undefined,
  id: string | undefined,
  config?: QueryConfig<KitRecord>,
) {
  return useApiQuery<KitRecord>(
    [...knowledgeRecordQueryKey(rootId ?? '', id ?? '')],
    async () => {
      const apiBase = await _getApiBase();
      return getKnowledgeRecord(apiBase, rootId as string, id as string);
    },
    { enabled: Boolean(rootId && id), ...config },
  );
}

/** `GET /api/knowledge/roots/:rootId/graph` — bulk nodes/edges for the wikilink
 * graph pane. */
export function useKnowledgeGraphQuery(
  rootId: string | undefined,
  config?: QueryConfig<KnowledgeGraph>,
) {
  return useApiQuery<KnowledgeGraph>(
    [...knowledgeGraphQueryKey(rootId ?? '')],
    async () => {
      const apiBase = await _getApiBase();
      return getKnowledgeGraph(apiBase, rootId as string);
    },
    { enabled: Boolean(rootId), ...config },
  );
}

/**
 * `GET /api/knowledge/roots/:rootId/graph/neo4j` — bulk nodes/edges from the
 * Neo4j-backed graph view (Wave 3 cleanup, plan item 1c). Enabled by default
 * whenever `rootId` is set, same as `useKnowledgeGraphQuery` above — this hook
 * itself does no view-toggle gating. `GraphPane.tsx`'s actual usage gates this
 * query by conditionally MOUNTING the component that calls it (rendering
 * `Neo4jGraphSection` only once `view === 'neo4j'`) rather than by passing
 * `config: { enabled: false }`; the net effect is the same — the query never
 * fires until the user switches views — but callers that DO want the
 * always-mounted alongside-the-file-graph shape instead can pass
 * `config: { enabled: false }` and flip it on explicitly. Surfaces the route's
 * honest `503` (no connection registered / driver unavailable) as this
 * query's `error`, same as every other `useApiQuery` hook in this file.
 */
export function useKnowledgeGraphNeo4jQuery(
  rootId: string | undefined,
  config?: QueryConfig<KnowledgeGraph>,
) {
  return useApiQuery<KnowledgeGraph>(
    [...knowledgeGraphNeo4jQueryKey(rootId ?? '')],
    async () => {
      const apiBase = await _getApiBase();
      return getKnowledgeGraphNeo4j(apiBase, rootId as string);
    },
    { enabled: Boolean(rootId), ...config },
  );
}

/** `POST /api/knowledge/roots/:rootId/records` — create a record, then refresh
 * that root's `listByType` query for the created record's type and its graph. */
export function useCreateKnowledgeRecordMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      rootId: string;
      record: CreateKnowledgeRecordInput;
    }) => {
      const apiBase = await _getApiBase();
      return createKnowledgeRecord(apiBase, input.rootId, input.record);
    },
    onSuccess: (record, variables) => {
      queryClient.invalidateQueries({
        queryKey: [...knowledgeRecordsQueryKey(variables.rootId, record.type)],
      });
      queryClient.invalidateQueries({
        queryKey: [...knowledgeGraphQueryKey(variables.rootId)],
      });
    },
  });
}

/** `POST /api/knowledge/roots/:rootId/records/:id/links` — link a source record
 * to one or more targets, then refresh that record's query and the root's graph. */
export function useLinkKnowledgeRecordMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      rootId: string;
      id: string;
      link: LinkKnowledgeRecordInput;
    }) => {
      const apiBase = await _getApiBase();
      return linkKnowledgeRecord(apiBase, input.rootId, input.id, input.link);
    },
    onSuccess: (_record, variables) => {
      queryClient.invalidateQueries({
        queryKey: [...knowledgeRecordQueryKey(variables.rootId, variables.id)],
      });
      queryClient.invalidateQueries({
        queryKey: [...knowledgeGraphQueryKey(variables.rootId)],
      });
    },
  });
}

/**
 * `POST /api/knowledge/index/search` — retrieval-grounded excerpt search over
 * the K3 index (the Q&A pane's entire backbone). No invalidation: a pure read
 * modeled as a mutation because it takes a body, mirroring
 * `useValidateKnowledgeRootMutation`'s same shape/rationale above.
 */
export function useSearchKnowledgeIndexMutation() {
  return useMutation({
    mutationFn: async (
      options: SearchKnowledgeIndexOptions,
    ): Promise<KnowledgeSearchResult[]> => {
      const apiBase = await _getApiBase();
      return searchKnowledgeIndex(apiBase, options);
    },
  });
}

/**
 * `POST /api/knowledge/roots/:rootId/graph/neo4j-sync` — idempotent sync
 * trigger (Wave 3 cleanup, plan item 1c); refreshes the Neo4j graph-view
 * query for the synced root on success so the pane reflects the freshly
 * synced graph without a manual refetch.
 */
export function useSyncKnowledgeGraphNeo4jMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      rootId: string,
    ): Promise<KnowledgeGraphNeo4jSyncStats> => {
      const apiBase = await _getApiBase();
      return syncKnowledgeGraphNeo4j(apiBase, rootId);
    },
    onSuccess: (_stats, rootId) => {
      queryClient.invalidateQueries({
        queryKey: [...knowledgeGraphNeo4jQueryKey(rootId)],
      });
    },
  });
}

/** Source-only observations never reuse old protected data during a fresh read. */
export function useLearningSourceObservationQuery(
  reference: LearningSourceReference,
  scope: ApiRequestScope,
  enabled = true,
) {
  const query = useApiQuery(
    [
      'knowledge-source',
      scope.apiBase,
      scope.authorityKey,
      reference.rootIdentity,
      reference.rootId,
      reference.recordId,
    ],
    (signal) =>
      observeLearningSource(scope.apiBase, reference, {
        signal,
        requestScope: scope,
      }),
    {
      enabled,
      staleTime: 0,
      refetchOnMount: 'always',
      retry: false,
      cancelWhenInactive: true,
      gcTime: 30_000,
    },
  );
  return {
    ...query,
    data:
      query.isFetchedAfterMount &&
      query.status === 'success' &&
      !query.isFetching
        ? query.data
        : undefined,
    isLoading:
      !query.isFetchedAfterMount || query.isLoading || query.isFetching,
  };
}
