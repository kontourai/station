import type { EnvironmentRef } from '@kontourai/station-contracts/execution-target';
import type { ProjectMemberAction } from '@kontourai/station-contracts/project-membership';
import type { WorkspaceIsolationMode } from '@kontourai/station-contracts/workspace-isolation';
import {
  type ProjectReadQueryConfig,
  useProjectQuery,
  useProjectsQuery,
} from '@kontourai/station-sdk';
import { type ReactNode } from 'react';
import { useHostRequestAuthorityScope } from './ApiBaseContext';
import { useAuthorityPersistence } from './AuthorityQueryContext';

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
  'requestScope' | 'requireRequestScope'
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
    ...(namespace ? { durableAuthorityId: namespace } : {}),
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
    ...(namespace ? { durableAuthorityId: namespace } : {}),
  });
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
