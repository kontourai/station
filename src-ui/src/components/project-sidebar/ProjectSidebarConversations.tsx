import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { useNavigation } from '../../contexts/NavigationContext';
import { navigationStore } from '../../contexts/navigation-store';
import {
  projectDestination,
  projectRoomAddress,
} from '../../views/project-page/project-navigation';
import {
  openProjectRoom,
  projectPath,
  useProjectSearch,
} from '../../views/project-page/project-room-navigation';
import { requestNewChannel } from '../project-conversations/new-channel-request';
import {
  type CurrentConversation,
  ProjectConversationList,
} from '../project-conversations/ProjectConversationList';

/**
 * The expanded Project's channels and Task rooms in the sidebar (#4794).
 * Loaded with the row's views, off the shell's first bundle.
 */
export function ProjectSidebarConversations({
  project,
  onNavigate,
}: {
  project: { slug: string; id: string; name: string };
  onNavigate?: () => void;
}) {
  const requestScope = useHostRequestAuthorityScope();
  const pathname = useNavigation((state) => state.pathname);
  const search = useProjectSearch();
  const current = currentConversation(project.slug, pathname, search);
  const after = () => onNavigate?.();
  return (
    <ProjectConversationList
      variant="sidebar"
      project={project}
      requestScope={requestScope}
      current={current}
      onOpenChannel={(channelId) => {
        openProjectRoom(project.slug, channelId);
        after();
      }}
      onOpenTask={(taskId) => {
        navigationStore.navigate(`/tasks/${encodeURIComponent(taskId)}`, {
          taskView: 'conversation',
        });
        after();
      }}
      onMoreTasks={() => {
        navigationStore.navigate(projectPath(project.slug), {
          section: 'tasks',
          channel: null,
          thread: null,
        });
        after();
      }}
      onNewChannel={() => {
        requestNewChannel(project.slug);
        // The room's own create form answers; stay on the open channel.
        navigationStore.navigate(projectPath(project.slug), {
          section: 'room',
          thread: null,
        });
        after();
      }}
    />
  );
}

/** What the route is showing, as a row of this Project's list. */
function currentConversation(
  slug: string,
  pathname: string,
  search: string,
): CurrentConversation | undefined {
  if (pathname.startsWith('/tasks/')) {
    const taskId = decodeURIComponent(pathname.slice('/tasks/'.length));
    return taskId ? { kind: 'task', taskId } : undefined;
  }
  if (pathname !== projectPath(slug) || projectDestination(search) !== 'room')
    return undefined;
  return {
    kind: 'channel',
    channelId: projectRoomAddress(search).channelId ?? null,
  };
}
