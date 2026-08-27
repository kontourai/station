import { useSyncExternalStore } from 'react';
import { routeTransitionStore } from './route-transition-store';

/** The surface id whose route outlet is currently suspended, or `null`. */
export function usePendingRouteSurfaceId(): string | null {
  return useSyncExternalStore(
    routeTransitionStore.subscribe,
    routeTransitionStore.getSnapshot,
    routeTransitionStore.getSnapshot,
  );
}
