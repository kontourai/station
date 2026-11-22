import { resolveNewChatInitialContext } from '../components/modals/new-chat-modal-utils';
import type { ProjectMetadata } from '../contexts/ProjectsContext';

/**
 * The context a start opens in, from the project the start defaults to: a
 * project slug, `GLOBAL_CONTEXT`, or `undefined` while it cannot be known.
 *
 * Unknown is a real state (#3350): on a first launch the dock can name a
 * project before the project list has loaded, and
 * `resolveNewChatInitialContext` reads an unloaded list as "no such project"
 * and answers global, so a start in that window ran global with the global
 * Model. Both start surfaces wait instead: their chips show a skeleton and
 * Start stays unavailable until the list arrives.
 */
export function resolveStartContextFromProjectSlug(
  defaultProjectSlug: string | null | undefined,
  projects: ProjectMetadata[],
  projectsLoaded: boolean,
): string | undefined {
  if (defaultProjectSlug && !projectsLoaded) return undefined;
  return resolveNewChatInitialContext(defaultProjectSlug, projects);
}
