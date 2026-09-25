import { useEffect } from 'react';
import { useApiBase } from '../contexts/ApiBaseContext';

/**
 * Mount once, in App: reports this document's focus for notification routing
 * (#2585). Only this effect lives in the entry chunk; the reporter itself
 * loads on mount (see `focusReporter.ts`).
 */
export function useFocusReporter(): void {
  const { apiBase } = useApiBase();
  useEffect(() => {
    let stop: (() => void) | undefined;
    let unmounted = false;
    void import('./focusReporter')
      .then((module) => {
        if (!unmounted) stop = module.startStationFocusReporter(apiBase);
      })
      .catch(() => {
        /* Presence is advisory; a failed chunk load changes nothing else. */
      });
    return () => {
      unmounted = true;
      stop?.();
    };
  }, [apiBase]);
}
