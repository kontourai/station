import { resolveNewChatModalDefaultProjectSlug } from '../components/chat-dock/chat-dock-utils';
import { resolveNewChatInitialContext } from '../components/modals/new-chat-modal-utils';
import { useDeviceSettings } from '../contexts/DeviceSettingsContext';
import { useNavigation } from '../contexts/NavigationContext';
import type { ProjectMetadata } from '../contexts/ProjectsContext';

/**
 * The context (a project slug, or `GLOBAL_CONTEXT`) a chat started from
 * outside the dock opens in — Home's "Start a chat" — so a surface that names
 * what Start will use resolves it the same way the start path does.
 *
 * Start dispatches a new-chat intent the ambient dock answers (a dock with an
 * immutable project scope ignores a `startWithDefault` intent). That dock
 * hands its New Chat modal `resolveNewChatModalDefaultProjectSlug(...)`, and
 * the modal opens on `resolveNewChatInitialContext(thatSlug, projects)`. This
 * composes the SAME two functions with the ambient dock's inputs: no fork, no
 * immutable scope, and the dock's remembered project binding, which is the
 * `chatDockProjectSlug` device setting `useDockShellChrome` reads live and
 * the navigation store writes when a project is opened.
 *
 * Not covered: a sidebar "new chat in project" override (`ChatDock`'s
 * `newChatProjectOverride`) applies only to that one request and is cleared
 * when the modal closes, so it never applies to a Start from Home.
 */
export function resolveNewChatStartContext(input: {
  dockProjectSlug: string | null;
  routeActiveProjectSlug: string | null;
  projects: ProjectMetadata[];
}): string {
  return resolveNewChatInitialContext(
    resolveNewChatModalDefaultProjectSlug({
      forkProjectSlug: undefined,
      hasImmutableProjectScope: false,
      immutableProjectSlug: undefined,
      dockChromeProjectSlug: input.dockProjectSlug,
      routeActiveProjectSlug: input.routeActiveProjectSlug,
    }),
    input.projects,
  );
}

/** `resolveNewChatStartContext` over the live dock binding and route. */
export function useNewChatStartContext(projects: ProjectMetadata[]): string {
  const { chatDockProjectSlug } = useDeviceSettings();
  // The slug `useActiveProject` (ChatDock's `routeActiveProjectSlug`)
  // resolves, read without that hook's project-detail query.
  const { selectedProject, lastProject } = useNavigation((state) => ({
    selectedProject: state.selectedProject,
    lastProject: state.lastProject,
  }));
  return resolveNewChatStartContext({
    dockProjectSlug: chatDockProjectSlug,
    routeActiveProjectSlug: selectedProject || lastProject || null,
    projects,
  });
}
