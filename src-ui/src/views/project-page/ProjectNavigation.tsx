import { useSyncExternalStore } from 'react';
import { SectionNavigation } from '../../components/SectionNavigation';
import { useNavigation } from '../../contexts/NavigationContext';
import { navigationStore } from '../../contexts/navigation-store';
import { ProjectSearch } from './ProjectSearch';
import {
  type ProjectDestination,
  projectDestination,
} from './project-navigation';

function subscribeDestination(listener: () => void) {
  const unsubscribe = navigationStore.subscribe(listener);
  window.addEventListener('popstate', listener);
  return () => {
    unsubscribe();
    window.removeEventListener('popstate', listener);
  };
}

export function useProjectDestination(slug: string) {
  const { navigate } = useNavigation();
  const search = useSyncExternalStore(
    subscribeDestination,
    () => window.location.search,
  );
  const destination = projectDestination(search);
  function selectDestination(next: ProjectDestination) {
    if (next === destination) return;
    const open = () =>
      navigate(`/projects/${encodeURIComponent(slug)}`, { section: next });
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
  return { destination, selectDestination };
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
  const projectPath = `/projects/${encodeURIComponent(slug)}`;
  const section = (key: ProjectDestination, label: string) => ({
    key,
    label,
    href: `${projectPath}?section=${key}`,
  });
  // The same section navigation Settings and Project settings use: a rail
  // beside the page on desktop, a picker on a phone.
  const items = [
    section('overview', 'Overview'),
    section('room', '# Project room'),
    section('tasks', 'Tasks'),
    ...(member
      ? []
      : [
          section('sources', 'Files & connections'),
          { key: SETTINGS_KEY, label: 'Settings', href: `${projectPath}/edit` },
        ]),
  ];
  return (
    <SectionNavigation
      label="Project"
      pickerLabel="Project section"
      items={items}
      activeKey={destination}
      onNavigate={(key) => {
        if (key === SETTINGS_KEY) navigate(`${projectPath}/edit`);
        else selectDestination(key as ProjectDestination);
      }}
    >
      {projectId && <ProjectSearch key={projectId} projectId={projectId} />}
    </SectionNavigation>
  );
}
