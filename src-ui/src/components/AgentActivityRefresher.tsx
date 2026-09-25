import { useConnections } from '@kontourai/station-connect';
import { useEffect } from 'react';
import { useNavigationActions } from '../contexts/NavigationContext';
import type { NativeEventSubscription } from '../platform/native/types';
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

/**
 * Opens the session an agent-activity card or alert tap names (#2515). The
 * Android plugin holds the tap's route until asked: on start (a tap that
 * launched the app) and on its `launchRoute` nudge (a tap while the app
 * runs). The route is navigated to only when it is for the connected
 * Station and well formed (`agentActivitySessionTarget`); otherwise the tap
 * just opened the app.
 */
export function AgentActivityLaunchRoutes() {
  const { target } = usePlatformProfile();
  const { activeConnection } = useConnections();
  const { navigate } = useNavigationActions();
  const environmentId = activeConnection?.environmentId ?? null;

  useEffect(() => {
    if (target !== 'android' || !environmentId) return;
    let disposed = false;
    let subscription: NativeEventSubscription | undefined;
    const adapter = import('../platform/native').then(
      (module) => module.nativePlatformPromise,
    );
    const take = () => {
      void Promise.all([adapter, import('../platform/native/agentActivity')])
        .then(([native, module]) => {
          if (disposed) return;
          return module.openAgentActivityLaunchRoute(
            native,
            environmentId,
            navigate,
          );
        })
        .catch((error: unknown) => {
          console.warn('station: agent activity launch route failed', error);
        });
    };
    void adapter.then((native) => {
      if (disposed) return;
      // Listen first, then take once the listener is registered: a tap
      // between the two is either already pending or announced.
      const launchRoutes = native.subscribeToAgentActivityLaunchRoutes(take);
      subscription = launchRoutes;
      void launchRoutes.ready.then(() => {
        if (!disposed) take();
      });
    });
    return () => {
      disposed = true;
      subscription?.dispose();
    };
  }, [target, environmentId, navigate]);

  return null;
}
