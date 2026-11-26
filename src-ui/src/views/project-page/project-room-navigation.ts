import { useSyncExternalStore } from 'react';
import { navigationStore } from '../../contexts/navigation-store';

function subscribeSearch(listener: () => void) {
  const unsubscribe = navigationStore.subscribe(listener);
  window.addEventListener('popstate', listener);
  return () => {
    unsubscribe();
    window.removeEventListener('popstate', listener);
  };
}

/** The live query string, for the Project page and the sidebar's rows. */
export function useProjectSearch() {
  return useSyncExternalStore(subscribeSearch, () => window.location.search);
}

export function projectPath(slug: string) {
  return `/projects/${encodeURIComponent(slug)}`;
}

/**
 * Open a Project's room at a channel (#4794, #4795): a pushed entry, so Back
 * returns to where the reader came from. A channel is its own room, so the
 * room's unsaved-send guard is asked first.
 */
export function openProjectRoom(slug: string, channelId: string | undefined) {
  navigationStore.runNavigationGuards(() =>
    navigationStore.navigate(projectPath(slug), {
      section: 'room',
      channel: channelId ?? null,
      thread: null,
    }),
  );
}
