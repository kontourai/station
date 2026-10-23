import { useSyncExternalStore } from 'react';
import { useNavigation } from '../../contexts/NavigationContext';
import { navigationStore } from '../../contexts/navigation-store';
import { isPlainLeftClick } from '../../utils/attentionOpen';
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

export function ProjectNavigation({
  slug,
  member = false,
}: {
  slug: string;
  member?: boolean;
}) {
  const { destination, selectDestination } = useProjectDestination(slug);
  const { navigate } = useNavigation();
  const destinations = [
    ['overview', 'Overview'],
    ['room', '# Project room'],
    ['tasks', 'Tasks'],
    ...(!member ? [['sources', 'Files & connections'] as const] : []),
  ] as const;
  const projectPath = `/projects/${encodeURIComponent(slug)}`;
  return (
    <details className="project-page__navigation-panel" open>
      <summary>Rooms</summary>
      <nav className="project-page__navigation" aria-label="Project">
        {destinations.map(([id, label]) => (
          <a
            key={id}
            href={`${projectPath}?section=${id}`}
            aria-current={destination === id ? 'page' : undefined}
            onClick={(event) => {
              if (!isPlainLeftClick(event)) return;
              event.preventDefault();
              selectDestination(id);
            }}
          >
            {label}
          </a>
        ))}
        {!member && (
          <a
            href={`${projectPath}/edit`}
            onClick={(event) => {
              if (!isPlainLeftClick(event)) return;
              event.preventDefault();
              navigate(`${projectPath}/edit`);
            }}
          >
            Settings
          </a>
        )}
      </nav>
    </details>
  );
}
