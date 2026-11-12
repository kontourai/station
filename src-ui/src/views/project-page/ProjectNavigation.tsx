import { SectionNavigation } from '../../components/SectionNavigation';
import { useNavigation } from '../../contexts/NavigationContext';
import { navigationStore } from '../../contexts/navigation-store';
import { ProjectSearch } from './ProjectSearch';
import {
  type ProjectDestination,
  projectDestination,
  projectRoomAddress,
} from './project-navigation';
import {
  openProjectRoom,
  projectPath,
  useProjectSearch,
} from './project-room-navigation';

/**
 * Leave a room level the reader pushed (a channel, a thread): Back when the
 * previous entry is the page they came from, otherwise that page's address
 * (a link or a reload has no such entry).
 */
function back(
  isParent: (search: URLSearchParams) => boolean,
  parent: () => void,
) {
  const previous = navigationStore.adjacentLocation(-1);
  if (
    previous &&
    previous.pathname === window.location.pathname &&
    isParent(new URLSearchParams(previous.search))
  ) {
    window.history.back();
    return;
  }
  parent();
}

export function useProjectDestination(slug: string) {
  const { navigate } = useNavigation();
  const search = useProjectSearch();
  const destination = projectDestination(search);
  const room = projectRoomAddress(search);
  function openThread(rootId: string | undefined) {
    const path = projectPath(slug);
    if (rootId) {
      navigate(path, { section: 'room', thread: rootId });
      return;
    }
    back(
      (previous) =>
        previous.get('section') === 'room' &&
        !previous.get('thread') &&
        (previous.get('channel') ?? undefined) === room.channelId,
      () => navigate(path, { thread: null }),
    );
  }
  /** A phone's room screen back to the Project's channel list. */
  function leaveRoom() {
    back(
      (previous) => projectDestination(`?${previous}`) === 'overview',
      () =>
        navigate(projectPath(slug), {
          section: null,
          channel: null,
          thread: null,
        }),
    );
  }
  function selectDestination(next: ProjectDestination) {
    if (next === destination) return;
    const open = () =>
      navigate(projectPath(slug), {
        section: next,
        // The room's address belongs to the room destination.
        ...(next === 'room' ? {} : { channel: null, thread: null }),
      });
    // Overview and Room share one mounted editor; keep its draft on expansion.
    if (
      (destination === 'overview' || destination === 'room') &&
      (next === 'overview' || next === 'room')
    ) {
      open();
      return;
    }
    // Same-path query navigation otherwise leaves an editor's visible surface.
    navigationStore.runNavigationGuards(open);
  }
  return {
    destination,
    selectDestination,
    room,
    openRoom: (channelId: string | undefined) =>
      openProjectRoom(slug, channelId),
    openThread,
    leaveRoom,
  };
}

/** Project settings is its own page; the rail links to it beside the sections. */
const SETTINGS_KEY = 'settings';

export function ProjectNavigation({
  slug,
  member = false,
  projectId,
}: {
  slug: string;
  member?: boolean;
  projectId?: string;
}) {
  const { destination, selectDestination } = useProjectDestination(slug);
  const { navigate } = useNavigation();
  const path = projectPath(slug);
  const section = (key: ProjectDestination, label: string) => ({
    key,
    label,
    href: `${path}?section=${key}`,
  });
  // The same section navigation Settings and Project settings use: a rail
  // beside the page on desktop, a picker on a phone.
  const items = [
    section('overview', 'Overview'),
    section('room', 'Room'),
    section('tasks', 'Tasks'),
    ...(member
      ? []
      : [
          section('sources', 'Files & connections'),
          { key: SETTINGS_KEY, label: 'Settings', href: `${path}/edit` },
        ]),
  ];
  return (
    <SectionNavigation
      label="Project"
      pickerLabel="Project section"
      items={items}
      activeKey={destination}
      onNavigate={(key) => {
        if (key === SETTINGS_KEY) navigate(`${path}/edit`);
        else selectDestination(key as ProjectDestination);
      }}
    >
      {projectId && <ProjectSearch key={projectId} projectId={projectId} />}
    </SectionNavigation>
  );
}
