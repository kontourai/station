import { useConnections } from '@kontourai/station-connect';
import { useEffect } from 'react';
import { usePlatformProfile } from '../platform/PlatformProfileContext';

/**
 * Keeps this phone's agent-activity registration with the active Station
 * current. FCM rotates push tokens while the app is closed and the Android
 * plugin has no `onNewToken` hook, so the app checks on start and whenever it
 * returns to the foreground. The controller does nothing for a Station the
 * person has not turned agent activity on for.
 */
export function AgentActivityRefresher() {
  const { target } = usePlatformProfile();
  const { apiBase, activeConnection } = useConnections();
  const environmentId = activeConnection?.environmentId ?? null;

  useEffect(() => {
    if (target !== 'android' || !environmentId) return;
    let disposed = false;
    const refresh = () => {
      void import('../platform/native/agentActivityRuntime')
        .then((module) => module.agentActivityController())
        .then((controller) => {
          if (disposed || !controller) return;
          return controller.refresh({ environmentId, apiBase });
        })
        .catch((error: unknown) => {
          // The Station may simply be unreachable right now; the next
          // foreground tries again. Say so rather than failing silently.
          console.warn('station: agent activity refresh failed', error);
        });
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    refresh();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [target, environmentId, apiBase]);

  return null;
}
