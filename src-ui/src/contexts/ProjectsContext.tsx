import type { EnvironmentRef } from '@kontourai/station-contracts/execution-target';
import type { MemberProjectView } from '@kontourai/station-contracts/project';
import type { ProjectMemberAction } from '@kontourai/station-contracts/project-membership';
import type { ProjectSharedTaskSummary } from '@kontourai/station-contracts/project-shared-task';
import type { WorkspaceIsolationMode } from '@kontourai/station-contracts/workspace-isolation';
import {
  type ProjectReadQueryConfig,
  useProjectQuery,
  useProjectsQuery,
} from '@kontourai/station-sdk';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useMemo } from 'react';
import { useHostRequestAuthorityScope } from './ApiBaseContext';
import { useAuthorityPersistence } from './AuthorityPersistenceContext';

/**
 * App-owned Project read config: the caller shapes query behavior, while the
 * request scope itself is NEVER caller-supplied — it is always captured from
 * the host authority. A missing/stale scope therefore fails closed (disabled
 * query, `unavailable` key) instead of falling back to ambient
 * `_getApiBase()` reads, which is the multi-home isolation contract for
 * Project list/detail in `src-ui` (#481 slice A).
 */
type AppProjectReadConfig<T> = Omit<
  ProjectReadQueryConfig<T>,
  'requestScope' | 'requireRequestScope' | 'durableAuthorityId'
>;

/**
 * Canonical app-owner Project LIST read. Returns the full typed query result
 * (data/isLoading/isError/refetch/…) — callers that need more than the
 * `useProjects()` projection use this instead of the SDK hook directly, so
 * every Project list read in the app shares one scope capture.
 *
 * The cache key names the VERIFIED durable namespace (stable across reloads)
 * while the request itself travels on the live captured scope — see
 * `durableAuthorityId` in the SDK. Post-repair freshness is owned by
 * invalidation, not key churn.
 */
export function useScopedProjectsQuery(
  config?: AppProjectReadConfig<ProjectMetadata[]>,
) {
  const requestScope = useHostRequestAuthorityScope();
  const { namespace } = useAuthorityPersistence();
  return useProjectsQuery({
    ...config,
    requestScope,
    requireRequestScope: true,
    durableAuthorityId: namespace ?? undefined,
  });
}

/**
 * Canonical app-owner Project DETAIL read. Same scope contract as
 * {@link useScopedProjectsQuery}; `enabled` continues to require a slug.
 */
export function useScopedProjectQuery(
  slug: string,
  config?: AppProjectReadConfig<ProjectConfig>,
) {
  const requestScope = useHostRequestAuthorityScope();
  const { namespace } = useAuthorityPersistence();
  return useProjectQuery(slug, {
    ...config,
    requestScope,
    requireRequestScope: true,
    durableAuthorityId: namespace ?? undefined,
  });
}

export type ProjectPageView = ProjectConfig | MemberProjectView;

function isMemberProjectView(
  value: ProjectPageView,
): value is MemberProjectView {
  return (
    'version' in value &&
    value.version === 'station.member-project/v1' &&
    value.kind === 'member-project'
  );
}

/**
 * Project page detail read that preserves the server's narrow member view.
 * It is always bound to the render-captured host scope and a credentialed SDK
 * transport; no ambient API-base or browser-cookie path is available here.
 */
export function useScopedProjectPageViewQuery(slug: string) {
  const requestScope = useHostRequestAuthorityScope();
  const queryClient = useQueryClient();
  const scopeIsCurrent = Boolean(requestScope?.isCurrent());
  const apiBase = requestScope?.apiBase ?? 'unavailable';
  const authorityKey = requestScope?.authorityKey ?? 'unavailable';
  const queryKey = useMemo(
    () => ['projects', slug, 'page-view', apiBase, authorityKey] as const,
    [apiBase, authorityKey, slug],
  );
  const query = useQuery<ProjectPageView>({
    queryKey,
    queryFn: async ({ signal }) => {
      const captured = requestScope;
      if (!captured?.isCurrent())
        throw new Error('The selected Station authority is unavailable.');
      const { getProjectView } = await import('@kontourai/station-sdk');
      const value = (await getProjectView(captured.apiBase, slug, {
        requestScope: captured,
        requireCredential: true,
        signal,
        timeoutMs: 15_000,
        maxResponseBytes: 64 * 1024,
      })) as ProjectPageView;
      if (!captured.isCurrent())
        throw new Error('The selected Station authority changed.');
      return value;
    },
    enabled: Boolean(slug && requestScope && scopeIsCurrent),
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    gcTime: 0,
  });

  useEffect(
    () => () => {
      void queryClient.cancelQueries({ queryKey, exact: true });
      void queryClient.removeQueries({ queryKey, exact: true });
    },
    [queryClient, queryKey],
  );
  return {
    ...query,
    requestScope,
    isMemberProject: query.data ? isMemberProjectView(query.data) : false,
  };
}

/**
 * Read the exact shared-work summaries published for a member Project. The
 * authority scope is supplied by the page-detail capture and reused for both
 * cache identity and SDK dispatch.
 */
export function useScopedMemberProjectSharedTasksQuery(
  project: Pick<MemberProjectView, 'id' | 'slug'>,
  requestScope: ReturnType<typeof useHostRequestAuthorityScope>,
) {
  const queryClient = useQueryClient();
  const apiBase = requestScope?.apiBase ?? 'unavailable';
  const authorityKey = requestScope?.authorityKey ?? 'unavailable';
  const queryKey = useMemo(
    () =>
      [
        'member-project-shared-work',
        apiBase,
        authorityKey,
        project.id,
        project.slug,
      ] as const,
    [apiBase, authorityKey, project.id, project.slug],
  );
  const scopeIsCurrent = Boolean(requestScope?.isCurrent());
  const query = useQuery<ProjectSharedTaskSummary[]>({
    queryKey,
    queryFn: async ({ signal }) => {
      const captured = requestScope;
      if (!captured?.isCurrent())
        throw new Error('The selected Station authority is unavailable.');
      const { listProjectSharedTasks } = await import(
        '@kontourai/station-sdk/project-shared-tasks'
      );
      const values = await listProjectSharedTasks(
        captured.apiBase,
        project.slug,
        {
          requestScope: captured,
          requireCredential: true,
          signal,
          timeoutMs: 15_000,
          maxResponseBytes: 1024 * 1024,
        },
      );
      if (!captured.isCurrent())
        throw new Error('The selected Station authority changed.');
      if (
        values.some(
          (value) =>
            value.project.localProjectId !== project.id ||
            value.project.localProjectSlug !== project.slug,
        )
      )
        throw new Error('Shared work returned a different Project scope.');
      return values;
    },
    enabled: Boolean(
      project.id && project.slug && requestScope && scopeIsCurrent,
    ),
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    gcTime: 0,
  });

  useEffect(
    () => () => {
      void queryClient.cancelQueries({ queryKey, exact: true });
      void queryClient.removeQueries({ queryKey, exact: true });
    },
    [queryClient, queryKey],
  );
  return query;
}

export interface ProjectMetadata {
  version?: 'station.member-project/v1';
  kind?: 'member-project';
  id: string;
  slug: string;
  name: string;
  icon?: string;
  description?: string;
  hasWorkingDirectory?: boolean;
  workingDirectory?: string;
  defaultWorkspaceIsolation?: WorkspaceIsolationMode;
  defaultEnvironment?: EnvironmentRef;
  layoutCount?: number;
  hasKnowledge?: boolean;
  defaultProviderId?: string;
  /** Server-owned explicit sidebar position (archive#3315); list is pre-sorted by it. */
  position?: number;
  actions?: readonly ProjectMemberAction[];
}

export interface ProjectConfig extends ProjectMetadata {
  workingDirectory?: string;
  defaultModel?: string;
  defaultEmbeddingProviderId?: string;
  defaultEmbeddingModel?: string;
  similarityThreshold?: number;
  topK?: number;
  agents?: AgentId[];
  createdAt: string;
  updatedAt: string;
}

// Provider is a no-op wrapper — data is fetched via hooks using React Query
export function ProjectsProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export function useProjects(): {
  projects: ProjectMetadata[];
  isLoading: boolean;
  /**
   * archive#4525: true only once the list has been
   * POSITIVELY confirmed by a successful, error-free load with real data —
   * never true for the pending shape (`isLoading`) OR the error shape,
   * because both fold `data` to the same `[]` `projects` reads. A caller
   * that treats an empty `projects` as "there really are none" (e.g. a
   * cleanup that deletes state referencing a since-removed project) must
   * gate on this, not on `!isLoading` — `!isLoading` is also true the
   * instant the query settles into an error, and a query that errors on a
   * cold boot (server not durably listening yet) or a broken network
   * window must never read as "confirmed empty."
   */
  isConfirmedLoaded: boolean;
} {
  const { data, isLoading, isSuccess, isError, isPlaceholderData } =
    useScopedProjectsQuery();
  return {
    projects: data ?? [],
    isLoading,
    // `!isPlaceholderData`: placeholderData forces status to "success" while
    // the real fetch is still pending, so without this a future
    // keepPreviousData opt-in on the projects query would let placeholder
    // contents read as a confirmed load (latent today — no caller opts in).
    isConfirmedLoaded:
      Boolean(isSuccess) &&
      !isError &&
      !isPlaceholderData &&
      data !== undefined,
  };
}

export function useProject(slug: string): {
  project: ProjectConfig | undefined;
  isLoading: boolean;
} {
  const { data, isLoading } = useScopedProjectQuery(slug, {
    enabled: !!slug,
  });
  return { project: data, isLoading };
}

import type { AgentId } from '@kontourai/station-contracts/agent-identity';
