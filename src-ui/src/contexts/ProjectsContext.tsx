import type { EnvironmentRef } from '@kontourai/station-contracts/execution-target';
import type {
  MemberProjectView,
  ProjectRunLocations,
  ProjectRunsAt,
  ProjectToolDefaults,
} from '@kontourai/station-contracts/project';
import type { ProjectIdentityView } from '@kontourai/station-contracts/project-identity';
import type { ProjectMemberAction } from '@kontourai/station-contracts/project-membership';
import type {
  ProjectSharedTaskDocument,
  ProjectSharedTaskHistory,
  ProjectSharedTaskPublication,
  ProjectSharedTaskSummary,
} from '@kontourai/station-contracts/project-shared-task';
import type { WorkspaceIsolationMode } from '@kontourai/station-contracts/workspace-isolation';
import {
  type ProjectReadQueryConfig,
  useProjectIdentityQuery,
  useProjectQuery,
  useProjectRunLocationsQuery,
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
> & {
  /**
   * Identity-lifetime binding (#480 review), forwarded to
   * `useProjectIdentityQuery`: the selected local Project record id joins
   * the identity cache key and validates the response association, so a
   * same-slug delete/recreate can never serve the previous incarnation.
   * Meaningless to the list/detail reads; consumed only by
   * `useScopedProjectIdentityQuery`.
   */
  expectedProjectId?: string;
};

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
 * #3391: where each Project's chats run (`GET /api/projects/run-locations`),
 * with the same scope contract as {@link useScopedProjectsQuery}. Mounted only
 * where a run location is shown (the start composer); the Project list never
 * waits on it, and a caller falls back to the stored folder until it answers.
 */
export function useScopedProjectRunLocationsQuery(
  config?: AppProjectReadConfig<ProjectRunLocations>,
) {
  const requestScope = useHostRequestAuthorityScope();
  const { namespace } = useAuthorityPersistence();
  return useProjectRunLocationsQuery({
    staleTime: PROJECT_RUN_LOCATIONS_STALE_MS,
    // Station's client default is `refetchOnMount: false`, which would keep
    // the first answer for the life of the tab: a mount refetches once the
    // answer is older than the stale time.
    refetchOnMount: true,
    ...config,
    requestScope,
    requireRequestScope: true,
    durableAuthorityId: namespace ?? undefined,
  });
}

/**
 * A folder can move or a mount can drop at any time, but the start resolves
 * it for real; the composer's hint only needs to be recent.
 */
const PROJECT_RUN_LOCATIONS_STALE_MS = 30_000;

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

/**
 * Canonical app-owner portable-identity read (#480/#1964 placement). Same
 * scope contract as {@link useScopedProjectQuery}: the request scope is
 * captured from the host authority and partitions the cache, so a late
 * identity response for a previous Home/authority can never satisfy the
 * current Project. Consumes the project-identity SDK subpath — the browser
 * never touches a stored peer secret to read it.
 */
export function useScopedProjectIdentityQuery(
  slug: string,
  config?: AppProjectReadConfig<ProjectIdentityView>,
) {
  const requestScope = useHostRequestAuthorityScope();
  return useProjectIdentityQuery(slug, {
    ...config,
    requestScope,
    requireRequestScope: true,
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
 * It is always bound to the render-captured host scope. Over a native host
 * transport or a browser relay route it requires the SDK-owned credential; a
 * browser talking to its own Station directly is authenticated by that
 * Station's session cookie (#2598), which the server enforces. No ambient
 * API-base path is available here.
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
        requireCredential: captured.requiresEnrolledCredential ?? true,
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
          requireCredential: captured.requiresEnrolledCredential ?? true,
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

function sameSharedProjectTask(
  actual: ProjectSharedTaskSummary,
  expected: ProjectSharedTaskSummary,
): boolean {
  return (
    actual.shareId === expected.shareId &&
    actual.project.stationId === expected.project.stationId &&
    actual.project.localProjectId === expected.project.localProjectId &&
    actual.project.localProjectSlug === expected.project.localProjectSlug &&
    actual.project.portableProjectId === expected.project.portableProjectId &&
    actual.task.id === expected.task.id &&
    actual.task.createdAt === expected.task.createdAt
  );
}

/** Read only the supported shared-work leaves under the page's captured scope. */
export function useScopedMemberProjectSharedTaskDetails(
  project: Pick<MemberProjectView, 'id' | 'slug'>,
  sharedTask: ProjectSharedTaskSummary,
  requestScope: ReturnType<typeof useHostRequestAuthorityScope>,
) {
  const apiBase = requestScope?.apiBase ?? 'unavailable';
  const authorityKey = requestScope?.authorityKey ?? 'unavailable';
  const key = useMemo(
    () =>
      [
        'member-project-shared-work-item',
        apiBase,
        authorityKey,
        project.id,
        project.slug,
        sharedTask.shareId,
        sharedTask.task.id,
        sharedTask.task.createdAt,
      ] as const,
    [
      apiBase,
      authorityKey,
      project.id,
      project.slug,
      sharedTask.shareId,
      sharedTask.task.createdAt,
      sharedTask.task.id,
    ],
  );
  const scopeIsCurrent = Boolean(requestScope?.isCurrent());
  const requestEnabled = Boolean(
    project.id &&
      project.slug &&
      sharedTask.shareId &&
      requestScope &&
      scopeIsCurrent,
  );
  const publication = useQuery<ProjectSharedTaskPublication>({
    queryKey: [...key, 'publication'],
    queryFn: async ({ signal }) => {
      const captured = requestScope;
      if (!captured?.isCurrent())
        throw new Error('The selected Station authority is unavailable.');
      const { getProjectSharedTaskPublication } = await import(
        '@kontourai/station-sdk/project-shared-tasks'
      );
      signal.throwIfAborted();
      if (!captured.isCurrent())
        throw new Error('The selected Station authority changed.');
      const value = await getProjectSharedTaskPublication(
        captured.apiBase,
        project.slug,
        sharedTask.task.id,
        {
          requestScope: captured,
          requireCredential: captured.requiresEnrolledCredential ?? true,
          signal,
          timeoutMs: 15_000,
          maxResponseBytes: 64 * 1024,
        },
      );
      if (!captured.isCurrent())
        throw new Error('The selected Station authority changed.');
      if (
        value.kind === 'shared'
          ? !sameSharedProjectTask(value.publication, sharedTask)
          : value.project.stationId !== sharedTask.project.stationId ||
            value.project.localProjectId !== project.id ||
            value.project.localProjectSlug !== project.slug ||
            value.task.id !== sharedTask.task.id ||
            value.task.createdAt !== sharedTask.task.createdAt
      )
        throw new Error(
          'Shared publication returned a different Project scope.',
        );
      return value;
    },
    enabled: requestEnabled,
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
  const publicationIsCurrent = Boolean(
    requestEnabled &&
      publication.isSuccess &&
      !publication.isFetching &&
      publication.data?.kind === 'shared' &&
      sameSharedProjectTask(publication.data.publication, sharedTask),
  );
  const sharedDetailsEnabled = requestEnabled && publicationIsCurrent;
  const history = useQuery<ProjectSharedTaskHistory>({
    queryKey: [...key, 'history'],
    queryFn: async ({ signal }) => {
      const captured = requestScope;
      if (!captured?.isCurrent())
        throw new Error('The selected Station authority is unavailable.');
      const { readProjectSharedTaskHistory } = await import(
        '@kontourai/station-sdk/project-shared-tasks'
      );
      signal.throwIfAborted();
      if (!captured.isCurrent())
        throw new Error('The selected Station authority changed.');
      const value = await readProjectSharedTaskHistory(
        captured.apiBase,
        project.slug,
        sharedTask.task.id,
        {
          requestScope: captured,
          requireCredential: captured.requiresEnrolledCredential ?? true,
          signal,
          timeoutMs: 15_000,
          maxResponseBytes: 1024 * 1024,
        },
      );
      if (!captured.isCurrent())
        throw new Error('The selected Station authority changed.');
      return value;
    },
    enabled: sharedDetailsEnabled,
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
  const document = useQuery<ProjectSharedTaskDocument>({
    queryKey: [...key, 'document'],
    queryFn: async ({ signal }) => {
      const captured = requestScope;
      if (!captured?.isCurrent())
        throw new Error('The selected Station authority is unavailable.');
      const { readProjectSharedTaskDocument } = await import(
        '@kontourai/station-sdk/project-shared-tasks'
      );
      signal.throwIfAborted();
      if (!captured.isCurrent())
        throw new Error('The selected Station authority changed.');
      const value = await readProjectSharedTaskDocument(
        captured.apiBase,
        project.slug,
        sharedTask.task.id,
        {
          requestScope: captured,
          requireCredential: captured.requiresEnrolledCredential ?? true,
          signal,
          timeoutMs: 15_000,
          maxResponseBytes: 1024 * 1024,
        },
      );
      if (!captured.isCurrent())
        throw new Error('The selected Station authority changed.');
      if (
        value.kind === 'snapshot' &&
        (value.project.id !== project.id ||
          value.project.slug !== project.slug ||
          value.task.id !== sharedTask.task.id ||
          value.task.createdAt !== sharedTask.task.createdAt)
      )
        throw new Error('Shared document returned a different Project scope.');
      return value;
    },
    enabled: sharedDetailsEnabled,
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });

  return { publication, publicationIsCurrent, history, document };
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
  /**
   * #3370: where a new chat in this project runs. Never sent by the Project
   * list: the start composer merges it in from the run-locations read
   * (`withProjectRunLocations`), and it is absent until that read answers.
   */
  runsAt?: ProjectRunsAt;
  actions?: readonly ProjectMemberAction[];
}

export interface ProjectConfig extends ProjectMetadata {
  toolDefaults?: ProjectToolDefaults;
  workingDirectory?: string;
  defaultModel?: string;
  defaultAgent?: AgentId;
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
