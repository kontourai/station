import type { EnvironmentRef } from '@kontourai/station-contracts/execution-target';
import type { WorkspaceIsolationMode } from '@kontourai/station-contracts/workspace-isolation';
import { useProjectQuery, useProjectsQuery } from '@kontourai/station-sdk';
import { type ReactNode } from 'react';

export interface ProjectMetadata {
  id: string;
  slug: string;
  name: string;
  icon?: string;
  description?: string;
  hasWorkingDirectory: boolean;
  workingDirectory?: string;
  defaultWorkspaceIsolation?: WorkspaceIsolationMode;
  defaultEnvironment?: EnvironmentRef;
  layoutCount: number;
  hasKnowledge: boolean;
  defaultProviderId?: string;
  /** Server-owned explicit sidebar position (archive#3315); list is pre-sorted by it. */
  position?: number;
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
    useProjectsQuery();
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
  const { data, isLoading } = useProjectQuery(slug, { enabled: !!slug });
  return { project: data, isLoading };
}

import type { AgentId } from '@kontourai/station-contracts/agent-identity';
