import { useMemo } from 'react';
import { displayableProjectIcon } from '../components/icons/ProjectIcon';
import { useProjects } from '../contexts/ProjectsContext';

const NO_ICONS: ReadonlyMap<string, string> = new Map();

/**
 * The slug → icon map for surfaces that name a project by slug alone (the
 * inbox rows and their hover cards), from the one Project list the sidebar
 * shows — the sibling of `useProjectAccents`. Only icons `ProjectIcon` would
 * draw are present, so a row never carries a value it will not render.
 *
 * Memoized on the list's identity, which React Query keeps stable between
 * fetches; the empty list `useProjects` folds a pending read to is fresh each
 * render, so it maps to one shared empty map rather than a new one per render
 * (the dock panel's `memo()` wrap compares these by reference).
 */
export function useProjectIcons(): ReadonlyMap<string, string> {
  const { projects } = useProjects();
  return useMemo(() => {
    const icons = new Map<string, string>();
    for (const project of projects) {
      const icon = displayableProjectIcon(project.icon);
      if (icon) icons.set(project.slug, icon);
    }
    return icons.size > 0 ? icons : NO_ICONS;
  }, [projects]);
}
