import { useMemo } from 'react';
import { useNavigation } from '../contexts/NavigationContext';
import { useProject, useProjects } from '../contexts/ProjectsContext';

/**
 * useActiveProject — single source of truth for the active project context.
 *
 * Resolution order:
 *   1. URL path (/projects/:slug/...) via selectedProject
 *   2. localStorage lastProject (persisted across navigations)
 *   3. null (no project context)
 */
export function useActiveProject(): {
  projectSlug: string | null;
  projectName: string | null;
  workingDirectory: string | null;
} {
  const { selectedProject, lastProject } = useNavigation();
  const { projects } = useProjects();

  const slug = selectedProject || lastProject || null;
  const { project } = useProject(slug ?? '');

  return useMemo(() => {
    if (!slug)
      return { projectSlug: null, projectName: null, workingDirectory: null };
    const name =
      project?.name ?? projects.find((p: any) => p.slug === slug)?.name ?? slug;
    return {
      projectSlug: slug,
      projectName: name,
      workingDirectory: project?.workingDirectory ?? null,
    };
  }, [slug, project, projects]);
}
