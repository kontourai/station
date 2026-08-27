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
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { _getApiBase, fetchAvailableLayouts } from '../api';
import { StationHttpError } from '../client/http';
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
  listProjects,
  listProjectWorkspacePanes,
  previewProjectWorkspaceFile,
  reorderProjects as reorderProjectsRaw,
  updateProject as updateProjectRaw,
} from '../client/projects';
import {
  type MutationOptions,
  type QueryConfig,
  useApiMutation,
  useApiQuery,
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

export function useProjectsQuery(config?: QueryConfig<any>) {
  return useApiQuery(
    ['projects'],
    async () => {
      const apiBase = await _getApiBase();
      return listProjects(apiBase);
    },
    config,
  );
}

export function useProjectQuery(slug: string, config?: QueryConfig<any>) {
  return useApiQuery(
    ['projects', slug],
    async () => {
      const apiBase = await _getApiBase();
      return getProject(apiBase, slug);
    },
    { ...config, enabled: !!slug && (config?.enabled ?? true) },
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

/** React read seam for the data-only current Workspace Pane catalog. */
export function useProjectWorkspacePanesQuery(
  projectSlug: string,
  config?: QueryConfig<
    import('../client/projects').ProjectWorkspacePaneCatalog
  >,
) {
  return useApiQuery(
    ['projects', projectSlug, 'panes'],
    async () => {
      const apiBase = await _getApiBase();
      return listProjectWorkspacePanes(apiBase, projectSlug);
    },
    { ...config, enabled: !!projectSlug && (config?.enabled ?? true) },
  );
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
 * order to the cached `['projects']` list so a drag settles immediately, then
 * reconciles with the server's sorted list (rolling back on error) and
 * invalidates so every consumer re-reads the persisted order.
 */
export function useReorderProjectsMutation(
  options?: MutationOptions<any, string[]>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (order: string[]) => {
      const apiBase = await _getApiBase();
      return reorderProjectsRaw(apiBase, order);
    },
    onMutate: async (order: string[]) => {
      await queryClient.cancelQueries({ queryKey: ['projects'], exact: true });
      const previous = queryClient.getQueryData<any[]>(['projects']);
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
        queryClient.setQueryData(['projects'], next);
      }
      return { previous };
    },
    onError: (error, order, context: { previous?: any[] } | undefined) => {
      if (context?.previous) {
        queryClient.setQueryData(['projects'], context.previous);
      }
      options?.onError?.(error as Error, order);
    },
    onSuccess: (data, order) => {
      options?.onSuccess?.(data, order);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'], exact: true });
    },
  });
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
