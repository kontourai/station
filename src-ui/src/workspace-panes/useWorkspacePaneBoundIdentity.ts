import type {
  LayoutMetadata,
  ProjectMetadata,
} from '@kontourai/station-contracts';
import {
  useProjectLayoutsQuery,
  useProjectsQuery,
} from '@kontourai/station-sdk';
import type { WorkspacePaneInstance } from '@kontourai/station-sdk/workspace-pane';

type ResolutionReason = 'missing' | 'ambiguous';

export type WorkspacePaneBoundIdentity =
  | { state: 'loading' }
  | { state: 'query-error'; query: 'projects' | 'layouts' }
  | { state: 'missing-project-binding' }
  | { state: 'project-unresolvable'; reason: ResolutionReason }
  | { state: 'missing-layout-binding' }
  | { state: 'layout-unresolvable'; reason: ResolutionReason }
  /** The catalog instance does not satisfy this renderer's exact contract. */
  | { state: 'pane-instance-invalid' }
  /** Persisted pane-local state is absent or does not match its occurrence. */
  | { state: 'pane-state-mismatch' }
  | { state: 'resolved'; project: ProjectMetadata; layout?: LayoutMetadata };

function exactMatch<T extends { id: string }>(
  entries: readonly T[],
  id: string,
): T | ResolutionReason {
  const matches = entries.filter((entry) => entry.id === id);
  return matches.length === 1
    ? matches[0]
    : matches.length === 0
      ? 'missing'
      : 'ambiguous';
}

/** Resolves only exact stable IDs and keeps fetching separate from absence. */
export function resolveWorkspacePaneBoundIdentity({
  instance,
  needsLayout,
  projects,
  projectsLoading,
  projectsError,
  layouts,
  layoutsLoading,
  layoutsError,
}: {
  instance: WorkspacePaneInstance;
  needsLayout: boolean;
  projects: readonly ProjectMetadata[];
  projectsLoading: boolean;
  projectsError: boolean;
  layouts: readonly LayoutMetadata[];
  layoutsLoading: boolean;
  layoutsError: boolean;
}): WorkspacePaneBoundIdentity {
  const projectId = instance.boundContext?.projectId;
  if (!projectId) return { state: 'missing-project-binding' };
  if (projectsLoading) return { state: 'loading' };
  if (projectsError) return { state: 'query-error', query: 'projects' };
  const project = exactMatch(projects, projectId);
  if (typeof project === 'string')
    return { state: 'project-unresolvable', reason: project };
  if (!needsLayout) return { state: 'resolved', project };

  const layoutId = instance.boundContext?.layoutId;
  if (!layoutId) return { state: 'missing-layout-binding' };
  if (layoutsLoading) return { state: 'loading' };
  if (layoutsError) return { state: 'query-error', query: 'layouts' };
  const layout = exactMatch(layouts, layoutId);
  if (typeof layout === 'string' || layout.projectSlug !== project.slug)
    return {
      state: 'layout-unresolvable',
      reason: typeof layout === 'string' ? layout : 'missing',
    };
  return { state: 'resolved', project, layout };
}

/** Resolves a pane's captured identity through the SDK, never route state. */
export function useWorkspacePaneBoundIdentity(
  instance: WorkspacePaneInstance,
  needsLayout: boolean,
): WorkspacePaneBoundIdentity {
  const projectsQuery = useProjectsQuery();
  const projectId = instance.boundContext?.projectId;
  const projects = (projectsQuery.data ?? []) as readonly ProjectMetadata[];
  const project = projectId ? exactMatch(projects, projectId) : 'missing';
  const projectSlug =
    needsLayout && typeof project !== 'string' ? project.slug : '';
  const layoutsQuery = useProjectLayoutsQuery(projectSlug, {
    enabled: needsLayout && !!projectSlug,
  });
  return resolveWorkspacePaneBoundIdentity({
    instance,
    needsLayout,
    projects,
    projectsLoading: projectsQuery.isLoading,
    projectsError: projectsQuery.isError,
    layouts: (layoutsQuery.data ?? []) as readonly LayoutMetadata[],
    layoutsLoading: layoutsQuery.isLoading,
    layoutsError: layoutsQuery.isError,
  });
}
