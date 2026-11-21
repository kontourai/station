import { useMemo } from 'react';
import { useProjects } from '../contexts/ProjectsContext';
export function useProjectNames() {
  const { projects } = useProjects();
  return useMemo(
    () => new Map(projects.map((project) => [project.slug, project.name])),
    [projects],
  );
}
