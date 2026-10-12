import { useMemo } from 'react';
import { projectAccents } from '../components/project-sidebar/projectAccent';
import { useProjects } from '../contexts/ProjectsContext';

/**
 * The slug → accent map every surface paints a project with: the sidebar's
 * rows, the dock's project switcher, and the inbox rows in the dock and on
 * Home. `projectAccents` is set-aware — a colour depends on the whole slug
 * set — so each surface computing it over its OWN list (a scoped dock's one
 * project, a filtered picker) would give one project two colours. This reads
 * the one Project list the sidebar shows.
 *
 * Keyed by the slug set, not the list's identity: `useProjects` folds a
 * pending read to a fresh `[]` each render, and a new map per render would
 * defeat the dock panel's `memo()` wrap.
 */
export function useProjectAccents(): ReadonlyMap<string, string> {
  const { projects } = useProjects();
  const slugKey = JSON.stringify(
    projects.map((project) => project.slug).sort(),
  );
  return useMemo(
    () => projectAccents(JSON.parse(slugKey) as string[]),
    [slugKey],
  );
}
