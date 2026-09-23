import type { LayoutCatalogItem } from '@kontourai/station-contracts/distribution';
import type { ProjectIconCandidate } from '@kontourai/station-contracts/project';
import type {
  ProjectResolutionView,
  ProjectResourceBindOutcome,
} from '@kontourai/station-contracts/project-identity';
import type {
  WorkspaceFilePreview,
  WorkspaceFilePreviewRequest,
} from '@kontourai/station-contracts/workspace-file-preview';
import {
  keepPreviousData,
  type MutateOptions,
  type Query,
  type UseMutationResult,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useEffect } from 'react';
import { _getApiBase, fetchAvailableLayouts } from '../api';
import {
  type ApiRequestScope,
  isApiRequestScope,
  StationHttpError,
  StationRequestAuthorityError,
} from '../client/http';
import {
  applyProjectLayout,
  bindProjectResource,
  createProjectLayout,
  createProject as createProjectRaw,
  deleteProjectLayout,
  deleteProject as deleteProjectRaw,
  getProject,
  getProjectLayout,
  getProjectResolution,
  listProjectIconCandidates,
  listProjectLayouts,
  listProjectViews,
  listProjectWorkspacePanes,
  type ProjectWorkspacePaneCatalog,
  previewProjectWorkspaceFile,
  reorderProjects as reorderProjectsRaw,
  updateProject as updateProjectRaw,
} from '../client/projects';
import {
  type MutationOptions,
  type QueryConfig,
  useApiMutation,
  useApiQuery,
  useCancelWhenInactive,
} from '../query-core';
import { telemetry } from '../telemetry';

export type { LayoutCatalogItem as AvailableProjectLayout } from '@kontourai/station-contracts/distribution';

export const LAYOUT_CATALOG_MAX_RETRIES = 3;
export const LAYOUT_CATALOG_RETRY_DELAYS_MS = [1_000, 2_000, 4_000] as const;
const LAYOUT_CATALOG_QUERY_KEY = ['projects', 'layouts', 'available'] as const;

export type LayoutCatalogErrorReason =
  | 'authentication'
  | 'connection'
  | 'server'
  | 'unknown';

interface LayoutCatalogTransition {
  reason: LayoutCatalogErrorReason;
  cached: number;
}

const layoutCatalogTransitions = new WeakMap<
  ReturnType<typeof useQueryClient>,
  LayoutCatalogTransition
>();

export function layoutCatalogErrorReason(
  error: unknown,
): LayoutCatalogErrorReason {
  if (error instanceof StationHttpError) {
    if ([401, 403].includes(error.status)) return 'authentication';
    if (error.status >= 500) return 'server';
  }
  if (error instanceof TypeError) return 'connection';
  return 'unknown';
}

export function shouldRetryLayoutCatalog(
  failureCount: number,
  error: Error,
): boolean {
  if (error instanceof StationHttpError && [401, 403].includes(error.status)) {
    return false;
  }
  return failureCount < LAYOUT_CATALOG_MAX_RETRIES;
}

export function layoutCatalogRetryDelay(attemptIndex: number): number {
  return LAYOUT_CATALOG_RETRY_DELAYS_MS[
    Math.min(attemptIndex, LAYOUT_CATALOG_RETRY_DELAYS_MS.length - 1)
  ];
}

export interface ProjectReadQueryConfig<T> extends QueryConfig<T> {
  requestScope?: ApiRequestScope;
  /** Fail closed when the host has not established a current authority scope. */
  requireRequestScope?: boolean;
  /**
   * #481 stable data identity, distinct from ephemeral request liveness.
   * When a non-empty durable id is supplied (the UI passes its verified
   * authority namespace), the QUERY KEY uses it instead of the live
   * `authorityKey` segment — which embeds the per-tab activation epoch and
   * credential generation and therefore can never match a reloaded tab's
   * persisted snapshot. The WIRE scope is untouched: dispatch and body-read
   * guards still run against the live captured scope, and `isCurrent`/SDK
   * authority equality are not weakened. Reads and the reorder mutation MUST
   * pass the same durable id for one authority, or they address different
   * entries (safe, but split). Post-repair freshness stays owned by
   * invalidation (`useInvalidateCachesOnConnectionSwitch` keys on
   * credential state), not by key churn. Omitted/empty ⇒ legacy live-key
   * behavior, byte-for-byte.
   */
  durableAuthorityId?: string;
}

/**
 * Canonical cache key of one authority's Project list. Reads and the reorder
 * mutation MUST agree on this shape or an optimistic reorder lands in a cache
 * entry no reader watches. Scalar segments only — react-query hashes them
 * structurally, so the same authority always resolves to the same entry.
 */
function scopedProjectsListKey(
  requestScope: {
    apiBase: string;
    authorityKey: string;
  },
  durableAuthorityId?: string,
): (string | number)[] {
  return [
    'projects',
    'list',
    requestScope.apiBase,
    stableAuthoritySegment(requestScope.authorityKey, durableAuthorityId),
  ];
}

/**
 * The key segment that names WHOSE data this is. A live `authorityKey`
 * (per-tab epoch, credential generation) is correct for dispatch guards and
 * useless for durable identity; a verified durable id survives reloads.
 * An empty id can never become a segment — that would merge every authority
 * into one entry — so it falls back to the live key.
 */
function stableAuthoritySegment(
  authorityKey: string,
  durableAuthorityId: string | undefined,
): string {
  return typeof durableAuthorityId === 'string' && durableAuthorityId.length > 0
    ? durableAuthorityId
    : authorityKey;
}

/** Snapshot of a validated request scope; never retains caller-owned objects. */
interface CapturedProjectScope {
  apiBase: string;
  authorityKey: string;
}

function captureProjectScope(
  candidate: ApiRequestScope | undefined,
): CapturedProjectScope | undefined {
  return isApiRequestScope(candidate)
    ? { apiBase: candidate.apiBase, authorityKey: candidate.authorityKey }
    : undefined;
}

export function useProjectsQuery(config?: ProjectReadQueryConfig<any>) {
  const requestScope = captureProjectScope(config?.requestScope);
  const scoped = requestScope !== undefined;
  const unavailable = config?.requireRequestScope === true && !scoped;
  const queryKey = unavailable
    ? ['projects', 'list', 'unavailable']
    : scoped
      ? scopedProjectsListKey(requestScope, config?.durableAuthorityId)
      : ['projects'];
  return useApiQuery(
    queryKey,
    async (signal) => {
      if (unavailable) throw new StationRequestAuthorityError();
      if (scoped)
        return listProjectViews(requestScope.apiBase, {
          requestScope,
          signal,
        });
      const apiBase = await _getApiBase();
      return listProjectViews(apiBase, { signal });
    },
    { ...config, enabled: !unavailable && (config?.enabled ?? true) },
  );
}

export function useProjectQuery(
  slug: string,
  config?: ProjectReadQueryConfig<any>,
) {
  const candidate = config?.requestScope;
  const requestScope = isApiRequestScope(candidate)
    ? { apiBase: candidate.apiBase, authorityKey: candidate.authorityKey }
    : undefined;
  const scoped = requestScope !== undefined;
  const unavailable = config?.requireRequestScope === true && !scoped;
  const queryKey = unavailable
    ? ['projects', slug, 'unavailable']
    : scoped
      ? [
          'projects',
          slug,
          'detail',
          requestScope.apiBase,
          stableAuthoritySegment(
            requestScope.authorityKey,
            config?.durableAuthorityId,
          ),
        ]
      : ['projects', slug];
  return useApiQuery(
    queryKey,
    async (signal) => {
      if (unavailable) throw new StationRequestAuthorityError();
      if (scoped)
        return getProject(requestScope.apiBase, slug, {
          requestScope,
          signal,
        });
      const apiBase = await _getApiBase();
      return getProject(apiBase, slug, { signal });
    },
    {
      ...config,
      enabled: !unavailable && !!slug && (config?.enabled ?? true),
    },
  );
}

export function useProjectIconCandidatesQuery(
  workspacePath: string | undefined,
  config?: QueryConfig<ProjectIconCandidate[]>,
) {
  return useApiQuery(
    ['projects', 'icon-candidates', workspacePath ?? ''],
    async () => {
      const apiBase = await _getApiBase();
      return listProjectIconCandidates(apiBase, workspacePath!);
    },
    {
      ...config,
      enabled: !!workspacePath && (config?.enabled ?? true),
    },
  );
}

export function useProjectLayoutsQuery(
  projectSlug: string,
  config?: QueryConfig<any>,
) {
  return useApiQuery(
    ['projects', projectSlug, 'layouts'],
    async () => {
      const apiBase = await _getApiBase();
      return listProjectLayouts(apiBase, projectSlug);
    },
    { ...config, enabled: !!projectSlug && (config?.enabled ?? true) },
  );
}

/**
 * `refetchOnMount` policy for the pane catalog, whose contents change OUTSIDE
 * this client — a plugin installed from the CLI, another tab or device, an
 * agent (#2319).
 *
 * Station's client default is `refetchOnMount: false`, and TanStack applies it
 * even to an invalidated query. So `invalidateQueries` reaches only a query
 * observed at that moment: a plugin lifecycle event, an in-tab install, or the
 * reconnect sync that lands while the catalog is unmounted marks it
 * invalidated, and the next mount then serves the old answer anyway, with
 * nothing left to refetch it.
 *
 * Returning `true` for an invalidated query means "refetch if stale", and an
 * invalidated query is always stale. A remount of an untouched answer does
 * not refetch; it keeps the cache-first default.
 *
 * An invalidated answer that fails to refetch (the route dropped after the
 * invalidation) keeps its data and reports `isError`. Consumers must render
 * that data rather than an error screen; only a catalog with no data is an
 * error state.
 */
function refetchOnMountWhenInvalidated(
  query: Query<
    ProjectWorkspacePaneCatalog,
    Error,
    ProjectWorkspacePaneCatalog,
    string[]
  >,
): boolean {
  return query.state.isInvalidated;
}

/**
 * React read seam for the data-only current Workspace Pane catalog.
 *
 * Built on `useQuery` rather than `useApiQuery` because its mount policy is a
 * function, which `QueryConfig.refetchOnMount` does not carry. Every other
 * `QueryConfig` field maps exactly as `useApiQuery` maps it.
 */
export function useProjectWorkspacePanesQuery(
  projectSlug: string,
  config?: QueryConfig<ProjectWorkspacePaneCatalog>,
) {
  const queryClient = useQueryClient();
  const queryKey: string[] = ['projects', projectSlug, 'panes'];
  const enabled = !!projectSlug && (config?.enabled ?? true);
  const query = useQuery({
    queryKey,
    queryFn: async () => {
      const apiBase = await _getApiBase();
      return listProjectWorkspacePanes(apiBase, projectSlug);
    },
    staleTime: config?.staleTime ?? 5 * 60 * 1000,
    gcTime:
      config?.gcTime ??
      queryClient.getQueryDefaults(queryKey)?.gcTime ??
      10 * 60 * 1000,
    enabled,
    refetchOnMount: config?.refetchOnMount ?? refetchOnMountWhenInvalidated,
    refetchInterval: config?.refetchInterval,
    retry: config?.retry,
    retryDelay: config?.retryDelay,
    placeholderData: config?.keepPreviousData ? keepPreviousData : undefined,
  });
  useCancelWhenInactive(queryKey, enabled, config?.cancelWhenInactive);
  return query;
}

/**
 * station#1502 slice 4 — what this Station can truthfully say about the
 * project's resources (§3.6, §4.1). Keyed under the project so
 * {@link useBindProjectResourceMutation} and a `stale` re-verify both land on
 * the same entry.
 */
export function useProjectResolutionQuery(
  projectSlug: string,
  config?: QueryConfig<ProjectResolutionView>,
) {
  return useApiQuery<ProjectResolutionView>(
    ['projects', projectSlug, 'resolution'],
    async () => {
      const apiBase = await _getApiBase();
      return getProjectResolution(apiBase, projectSlug);
    },
    { ...config, enabled: !!projectSlug && (config?.enabled ?? true) },
  );
}

/** React read seam for a bounded, project-owned Workspace file preview. */
export function useProjectWorkspaceFilePreviewQuery(
  projectSlug: string,
  request: WorkspaceFilePreviewRequest | undefined,
  config?: QueryConfig<WorkspaceFilePreview>,
) {
  return useApiQuery(
    ['projects', projectSlug, 'file-preview', request ?? {}],
    async (signal) => {
      const apiBase = await _getApiBase();
      return previewProjectWorkspaceFile(apiBase, projectSlug, request!, {
        signal,
      });
    },
    {
      ...config,
      enabled: !!projectSlug && !!request?.path && (config?.enabled ?? true),
      cancelWhenInactive: config?.cancelWhenInactive ?? true,
    },
  );
}

/**
 * station#1502 slice 4 — §3.6's repair action.
 *
 * Invalidates the resolution query on success so the surface re-reads what the
 * Station can now say, rather than assuming the bind produced `bound`. A
 * REFUSAL rejects with the server's reason and invalidates nothing: nothing
 * was recorded, so nothing changed.
 *
 * The success value is a {@link ProjectResourceBindOutcome}, not a view: the
 * write and the re-read are two facts, and a failed re-read leaves a RECORDED
 * binding whose gap the surface must name rather than report as a failed bind.
 * The invalidation runs either way — it is what recovers from the gap.
 *
 * station#1503 slice 5: the variable is `{ path, resourceId? }`, because a
 * multi-repo project has one repair form PER RESOURCE and each must write the
 * record it is captioned with. `resourceId` is optional so a single-repo
 * project's form is unchanged, and the server refuses an unknown id rather
 * than falling back to the primary.
 */
export interface BindProjectResourceVariables {
  path: string;
  resourceId?: string;
}

export function useBindProjectResourceMutation(
  projectSlug: string,
  options?: MutationOptions<
    ProjectResourceBindOutcome,
    BindProjectResourceVariables
  >,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (variables: BindProjectResourceVariables) => {
      const apiBase = await _getApiBase();
      return bindProjectResource(apiBase, projectSlug, variables);
    },
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({
        queryKey: ['projects', projectSlug, 'resolution'],
      });
      options?.onSuccess?.(data, variables);
    },
    onError: (error, variables) =>
      options?.onError?.(error as Error, variables),
  });
}

/**
 * 4-HOME-009. A named layout that answers 4xx has been answered: asking again
 * cannot change it, and the host's default `retry: 1` kept `LayoutView` on its
 * loading screen for 6-12 seconds over a 404 the server returned immediately
 * (measured live, four requests). A 5xx or a transport failure still gets the
 * one retry that default was for.
 *
 * It defaults HERE rather than at a call site because the same query is
 * mounted by both `ProjectLayoutRenderer` and `LayoutView`; whichever observer
 * fetches first decides the retry behaviour, so a per-caller option is a
 * policy only one of them holds.
 */
export function shouldRetryProjectLayout(
  failureCount: number,
  error: Error,
): boolean {
  if (
    error instanceof StationHttpError &&
    error.status >= 400 &&
    error.status < 500
  ) {
    return false;
  }
  return failureCount < 1;
}

export function useProjectLayoutQuery(
  projectSlug: string | undefined,
  layoutSlug: string | undefined,
  config?: QueryConfig<any>,
) {
  return useApiQuery(
    ['projects', projectSlug ?? '', 'layouts', layoutSlug ?? ''],
    async () => {
      const apiBase = await _getApiBase();
      return getProjectLayout(apiBase, projectSlug!, layoutSlug!);
    },
    {
      retry: shouldRetryProjectLayout,
      ...config,
      enabled: !!projectSlug && !!layoutSlug && (config?.enabled ?? true),
    },
  );
}

export function useAvailableProjectLayoutsQuery(
  config?: QueryConfig<LayoutCatalogItem[]>,
) {
  const queryClient = useQueryClient();
  const enabled = config?.enabled ?? true;
  const query = useApiQuery(
    [...LAYOUT_CATALOG_QUERY_KEY],
    async (signal) => fetchAvailableLayouts(signal),
    {
      ...config,
      cancelWhenInactive: true,
      retry: shouldRetryLayoutCatalog,
      retryDelay: layoutCatalogRetryDelay,
    },
  );

  useEffect(() => {
    if (!enabled) return;

    const previous = layoutCatalogTransitions.get(queryClient);
    if (query.error) {
      const current = {
        reason: layoutCatalogErrorReason(query.error),
        cached: query.data?.length ? 1 : 0,
      };
      if (
        !previous ||
        previous.reason !== current.reason ||
        previous.cached !== current.cached
      ) {
        telemetry.track('ui.layout_catalog.state', {
          outcome: 'failure',
          ...current,
        });
        layoutCatalogTransitions.set(queryClient, current);
      }
      return;
    }

    if (previous && query.isSuccess) {
      telemetry.track('ui.layout_catalog.state', {
        outcome: 'recovered',
        ...previous,
      });
      layoutCatalogTransitions.delete(queryClient);
    }
  }, [enabled, query.data?.length, query.error, query.isSuccess, queryClient]);

  return query;
}

export function useApplyProjectLayoutMutation(
  projectSlug: string,
  options?: MutationOptions<any, string>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (layoutId: string) => {
      const apiBase = await _getApiBase();
      return applyProjectLayout(apiBase, projectSlug, layoutId);
    },
    onSuccess: (data, layoutId) => {
      queryClient.invalidateQueries({
        queryKey: ['projects', projectSlug, 'layouts'],
      });
      options?.onSuccess?.(data, layoutId);
    },
    onError: (error, layoutId) => options?.onError?.(error as Error, layoutId),
  });
}

export function useDeleteProjectLayoutMutation(
  projectSlug: string,
  options?: MutationOptions<void, string>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (layoutSlug: string) => {
      const apiBase = await _getApiBase();
      await deleteProjectLayout(apiBase, projectSlug, layoutSlug);
    },
    onSuccess: (_, layoutSlug) => {
      queryClient.invalidateQueries({
        queryKey: ['projects', projectSlug, 'layouts'],
      });
      options?.onSuccess?.(undefined, layoutSlug);
    },
    onError: (error, layoutSlug) => {
      options?.onError?.(error as Error, layoutSlug);
    },
  });
}

export function useCreateProjectMutation() {
  return useApiMutation(
    async (data: {
      name: string;
      slug: string;
      description?: string;
      icon?: string;
      workingDirectory?: string;
    }) => {
      const apiBase = await _getApiBase();
      return createProjectRaw(apiBase, data);
    },
    { invalidateKeys: [['projects']] },
  );
}

export function useCreateProjectLayoutMutation(
  options?: MutationOptions<
    any,
    {
      projectSlug: string;
      name: string;
      slug: string;
      type: string;
      icon?: string;
      description?: string;
      config?: Record<string, unknown>;
    }
  >,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      projectSlug,
      ...data
    }: {
      projectSlug: string;
      name: string;
      slug: string;
      type: string;
      icon?: string;
      description?: string;
      config?: Record<string, unknown>;
    }) => {
      const apiBase = await _getApiBase();
      return createProjectLayout(apiBase, projectSlug, data);
    },
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({
        queryKey: ['projects', variables.projectSlug, 'layouts'],
      });
      options?.onSuccess?.(data, variables);
    },
    onError: (error, variables) => {
      options?.onError?.(error as Error, variables);
    },
  });
}

export function useUpdateProjectMutation(
  options?: MutationOptions<any, { slug: string; [key: string]: any }>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      slug,
      ...data
    }: {
      slug: string;
      [key: string]: any;
    }) => {
      const apiBase = await _getApiBase();
      return updateProjectRaw(apiBase, slug, data);
    },
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['projects', variables.slug] });
      options?.onSuccess?.(data, variables);
    },
    onError: (error, variables) => {
      options?.onError?.(error as Error, variables);
    },
  });
}

/**
 * station#3315 — server-owned sidebar order. Optimistically applies the new
 * order to the cached Project list so a drag settles immediately, then
 * reconciles with the server's sorted list (rolling back on error) and
 * invalidates so every consumer re-reads the persisted order.
 *
 * #481 — captured-authority reorder. The variables accept EITHER a bare
 * `string[]` (legacy ambient callers: legacy `['projects']` cache, unchanged
 * behavior) or `{ order, requestScope, requireRequestScope }`. A scoped call
 * snapshots origin+authority BEFORE any await, targets the optimistic
 * update/rollback/settle at ONLY that authority's `scopedProjectsListKey()`
 * cache entry, and never re-resolves an ambient destination on completion —
 * a slow failed reorder for one home can never roll back or invalidate
 * another home's list. `requireRequestScope` rejects an absent or invalid
 * scope before the request and before any cache work.
 */
export interface ReorderProjectsInput {
  order: string[];
  requestScope?: ApiRequestScope;
  /** Fail closed when no current authority scope is captured. */
  requireRequestScope?: boolean;
  /**
   * #481 stable data identity for the optimistic/rollback/settle cache key.
   * MUST equal the `durableAuthorityId` the list reader used for this
   * authority, or the reorder addresses a different entry than the reader
   * watches. The request itself still travels on the live `requestScope`.
   */
  durableAuthorityId?: string;
}

export type ReorderProjectsVariables = string[] | ReorderProjectsInput;

interface CapturedReorder {
  order: string[];
  scope: CapturedProjectScope | undefined;
  durableAuthorityId: string | undefined;
}

function captureReorderInput(
  variables: ReorderProjectsVariables,
): CapturedReorder {
  if (Array.isArray(variables))
    return {
      order: variables,
      scope: undefined,
      durableAuthorityId: undefined,
    };
  return {
    order: variables.order,
    scope: captureProjectScope(variables.requestScope),
    durableAuthorityId:
      typeof variables.durableAuthorityId === 'string' &&
      variables.durableAuthorityId.length > 0
        ? variables.durableAuthorityId
        : undefined,
  };
}

/**
 * One private owned copy, taken ONCE at the public mutate/mutateAsync
 * invocation. The copy is what every internal callback reads, so a caller
 * mutating their own input object (order array or scope scalars) during the
 * mutation lifecycle can neither retarget the request nor corrupt the
 * optimistic write, rollback, or settle. Internal callbacks re-derive
 * `scope`/`order` from this private copy — safe by construction.
 *
 * The copy is privately owned, not frozen: callers keep full ownership of
 * their own input (including mutating it, which the race test exercises),
 * and only this copy travels downstream.
 */
function captureReorderVariables<TVariables extends ReorderProjectsVariables>(
  variables: TVariables,
): TVariables {
  if (Array.isArray(variables)) {
    // Bare-array shape: copy the array itself. The assertion restores the
    // caller's narrowed shape after a copy that provably preserves it —
    // an array in, an array out.
    return [...variables] as TVariables;
  }
  // Object shape: the input is provably not an array here, so the
  // object-shaped read below cannot observe the other variant. Copy the
  // order array plus the captured scalar scope and the fail-closed flag.
  const input = variables as ReorderProjectsInput;
  const captured: ReorderProjectsInput = { order: [...input.order] };
  // Pin the fail-closed contract: unsetting it on the caller's object
  // mid-flight must not enable an ambient fallback.
  if (input.requireRequestScope === true) captured.requireRequestScope = true;
  // Pin the stable key the same way: unsetting or swapping the durable id
  // mid-flight must not retarget the optimistic write/rollback/settle.
  if (
    typeof input.durableAuthorityId === 'string' &&
    input.durableAuthorityId.length > 0
  )
    captured.durableAuthorityId = input.durableAuthorityId;
  const scope = captureProjectScope(input.requestScope);
  if (scope) captured.requestScope = scope;
  return captured as TVariables;
}

interface ReorderMutationContext {
  previous?: any[];
  cacheKey: (string | number)[];
  scoped: boolean;
}

/**
 * Reorder mutation handle for one declared variables shape. Narrowing the
 * handle (not widening the callbacks) is what keeps the legacy contract
 * sound: a caller that declares bare-array callbacks receives a handle
 * that truthfully accepts only bare arrays, so a scoped object can never
 * arrive at a callback that cannot read it.
 */
interface ReorderProjectsMutation<TVariables extends ReorderProjectsVariables>
  extends Omit<
    UseMutationResult<any, Error, TVariables, ReorderMutationContext>,
    'mutate' | 'mutateAsync'
  > {
  mutate: (
    variables: TVariables,
    options?: MutateOptions<any, Error, TVariables, ReorderMutationContext>,
  ) => void;
  mutateAsync: (
    variables: TVariables,
    options?: MutateOptions<any, Error, TVariables, ReorderMutationContext>,
  ) => Promise<any>;
}

/**
 * Union handle: both variables shapes stay available, and each per-call
 * callback is tied to the variables of its own call, so a legacy per-call
 * callback observes only the bare array it was passed with.
 */
interface UnionReorderProjectsMutation
  extends Omit<
    UseMutationResult<
      any,
      Error,
      ReorderProjectsVariables,
      ReorderMutationContext
    >,
    'mutate' | 'mutateAsync'
  > {
  mutate: {
    (
      variables: string[],
      options?: MutateOptions<any, Error, string[], ReorderMutationContext>,
    ): void;
    (
      variables: ReorderProjectsInput,
      options?: MutateOptions<
        any,
        Error,
        ReorderProjectsInput,
        ReorderMutationContext
      >,
    ): void;
    (
      variables: ReorderProjectsVariables,
      options?: MutateOptions<
        any,
        Error,
        ReorderProjectsVariables,
        ReorderMutationContext
      >,
    ): void;
  };
  mutateAsync: {
    (
      variables: string[],
      options?: MutateOptions<any, Error, string[], ReorderMutationContext>,
    ): Promise<any>;
    (
      variables: ReorderProjectsInput,
      options?: MutateOptions<
        any,
        Error,
        ReorderProjectsInput,
        ReorderMutationContext
      >,
    ): Promise<any>;
    (
      variables: ReorderProjectsVariables,
      options?: MutateOptions<
        any,
        Error,
        ReorderProjectsVariables,
        ReorderMutationContext
      >,
    ): Promise<any>;
  };
}

export function useReorderProjectsMutation(
  options?: MutationOptions<any, ReorderProjectsVariables>,
): UnionReorderProjectsMutation;
export function useReorderProjectsMutation(
  options?: MutationOptions<any, string[]>,
): ReorderProjectsMutation<string[]>;
export function useReorderProjectsMutation(
  options?: MutationOptions<any, ReorderProjectsInput>,
): ReorderProjectsMutation<ReorderProjectsInput>;
export function useReorderProjectsMutation<
  TVariables extends ReorderProjectsVariables,
>(
  options?: MutationOptions<any, TVariables>,
): ReorderProjectsMutation<TVariables> {
  const queryClient = useQueryClient();
  const mutation = useMutation<any, Error, TVariables, ReorderMutationContext>({
    mutationFn: async (variables: TVariables) => {
      // `variables` is the private copy from `captureReorderVariables`;
      // deriving scope/order from it can no longer observe caller mutations.
      const { order, scope } = captureReorderInput(variables);
      // `Array.isArray` cannot narrow generic `TVariables`; the object
      // shape is asserted only after the bare-array shape is excluded at
      // runtime. The assertion is compile-time only and emits no code.
      if (
        !Array.isArray(variables) &&
        (variables as ReorderProjectsInput).requireRequestScope === true &&
        !scope
      )
        throw new StationRequestAuthorityError();
      if (scope)
        return reorderProjectsRaw(scope.apiBase, order, {
          requestScope: scope,
        });
      const apiBase = await _getApiBase();
      return reorderProjectsRaw(apiBase, order);
    },
    onMutate: async (variables: TVariables) => {
      const { order, scope, durableAuthorityId } =
        captureReorderInput(variables);
      // Same guarded object-shape assertion as `mutationFn` above.
      const required =
        !Array.isArray(variables) &&
        (variables as ReorderProjectsInput).requireRequestScope === true;
      // Reject BEFORE any await or cache work: an absent required scope must
      // not touch any home's cache.
      if (required && !scope) throw new StationRequestAuthorityError();
      const cacheKey: (string | number)[] = scope
        ? scopedProjectsListKey(scope, durableAuthorityId)
        : ['projects'];
      if (scope) {
        await queryClient.cancelQueries({ queryKey: cacheKey });
      } else {
        // Legacy callers keep the exact legacy cancel surface.
        await queryClient.cancelQueries({ queryKey: ['projects', 'list'] });
        await queryClient.cancelQueries({
          queryKey: ['projects'],
          exact: true,
        });
      }
      const previous = queryClient.getQueryData<any[]>(cacheKey);
      if (Array.isArray(previous)) {
        const byIndex = new Map(order.map((slug, index) => [slug, index]));
        const next = [...previous].sort((a, b) => {
          const left = byIndex.get(a.slug);
          const right = byIndex.get(b.slug);
          if (left !== undefined && right !== undefined) return left - right;
          if (left !== undefined) return -1;
          if (right !== undefined) return 1;
          return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
        });
        queryClient.setQueryData(cacheKey, next);
      }
      return { previous, cacheKey, scoped: scope !== undefined };
    },
    onError: (error, variables, context) => {
      // Rollback touches ONLY the captured authority's cache entry.
      if (context && Array.isArray(context.previous)) {
        queryClient.setQueryData(context.cacheKey, context.previous);
      }
      options?.onError?.(error as Error, variables);
    },
    onSuccess: (data, variables) => {
      options?.onSuccess?.(data, variables);
    },
    onSettled: (_data, _error, _variables, context) => {
      // No context ⇒ onMutate rejected before any request or cache work;
      // there is nothing to reconcile and touching prefixes here would
      // invalidate OTHER homes' lists.
      if (!context) return;
      if (context.scoped) {
        // Exactly one entry is intended: the captured authority's list.
        queryClient.invalidateQueries({
          queryKey: context.cacheKey,
          exact: true,
        });
        return;
      }
      // Legacy settle surface, byte-for-byte the station#3315 original:
      // the list prefix plus the bare legacy list, exact.
      queryClient.invalidateQueries({ queryKey: ['projects', 'list'] });
      queryClient.invalidateQueries({ queryKey: ['projects'], exact: true });
    },
  });
  // Capture ONCE at the public invocation. Everything below this wrapper
  // sees only the private owned copy; the spread preserves the full typed
  // mutation result (reset/isPending/data/…) and tanstack's per-call options
  // pass straight through.
  return {
    ...mutation,
    mutate: (
      variables: TVariables,
      options?: MutateOptions<any, Error, TVariables, ReorderMutationContext>,
    ) => mutation.mutate(captureReorderVariables(variables), options),
    mutateAsync: (
      variables: TVariables,
      options?: MutateOptions<any, Error, TVariables, ReorderMutationContext>,
    ) => mutation.mutateAsync(captureReorderVariables(variables), options),
  };
}

export function useDeleteProjectMutation(
  options?: MutationOptions<any, string>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (slug: string) => {
      const apiBase = await _getApiBase();
      return deleteProjectRaw(apiBase, slug);
    },
    onSuccess: (data, slug) => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.removeQueries({ queryKey: ['projects', slug] });
      options?.onSuccess?.(data, slug);
    },
    onError: (error, slug) => {
      options?.onError?.(error as Error, slug);
    },
  });
}

export function useCreateLayoutMutation(projectSlug: string) {
  return useApiMutation(
    async (data: {
      name: string;
      slug: string;
      type: string;
      icon?: string;
      description?: string;
      config?: Record<string, unknown>;
    }) => {
      const apiBase = await _getApiBase();
      return createProjectLayout(apiBase, projectSlug, data);
    },
    { invalidateKeys: [['projects', projectSlug, 'layouts']] },
  );
}
