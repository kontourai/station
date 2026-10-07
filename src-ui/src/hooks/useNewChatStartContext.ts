import { resolveNewChatModalDefaultProjectSlug } from '../components/chat-dock/chat-dock-utils';
import { resolveNewChatInitialContext } from '../components/modals/new-chat-modal-utils';
import { useDeviceSettings } from '../contexts/DeviceSettingsContext';
import { useNavigation } from '../contexts/NavigationContext';
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

/**
 * The context (a project slug, or `GLOBAL_CONTEXT`) a chat started from
 * Home's composer opens in, so Home's chips name what Start will use.
 *
 * Home's start dispatches a new-chat intent the ambient dock answers (a dock
 * with an immutable project scope ignores it). That dock hands its New Chat
 * modal `resolveNewChatModalDefaultProjectSlug(...)`, and the modal resolves
 * it with `resolveStartContextFromProjectSlug`. This composes the SAME two
 * functions with the ambient dock's inputs: no fork, no immutable scope, and
 * the dock's remembered project binding (`chatDockProjectSlug`), which both
 * composers' project chip writes.
 *
 * Not covered: a sidebar "new chat in project" override (`ChatDock`'s
 * `newChatProjectOverride`) applies only to that one request and is cleared
 * when the modal closes, so it never applies to a Start from Home.
 */
export function resolveNewChatStartContext(input: {
  dockProjectSlug: string | null;
  routeActiveProjectSlug: string | null;
  projects: ProjectMetadata[];
  /** Whether `projects` is a loaded list, not the pending empty one. */
  projectsLoaded: boolean;
}): string | undefined {
  return resolveStartContextFromProjectSlug(
    resolveNewChatModalDefaultProjectSlug({
      forkProjectSlug: undefined,
      hasImmutableProjectScope: false,
      immutableProjectSlug: undefined,
      dockChromeProjectSlug: input.dockProjectSlug,
      routeActiveProjectSlug: input.routeActiveProjectSlug,
    }),
    input.projects,
    input.projectsLoaded,
  );
}

/** `resolveNewChatStartContext` over the live dock binding and route. */
export function useNewChatStartContext(
  projects: ProjectMetadata[],
  projectsLoaded: boolean,
): string | undefined {
  const { chatDockProjectSlug } = useDeviceSettings();
  // The route's project. The resolver pins that it never overrides the dock
  // binding (ChatDock passes `useActiveProject`'s slug, which adds the
  // remembered `lastProject`; neither value changes the result).
  const routeProject = useNavigation((state) => state.selectedProject);
  return resolveNewChatStartContext({
    dockProjectSlug: chatDockProjectSlug,
    routeActiveProjectSlug: routeProject,
    projects,
    projectsLoaded,
  });
}
