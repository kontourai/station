import { useEffect, useState } from 'react';
import { usePlatformProfile } from '../platform/PlatformProfileContext';
import { Button } from './Button';

/** Register independently of push permission and before the network access gate. */
export function WebOfflineShell() {
  const profile = usePlatformProfile();
  const [updateReady, setUpdateReady] = useState(false);
  useEffect(() => {
    const worker = navigator.serviceWorker;
    if (profile.isTauri || !worker || !import.meta.env.PROD) return;
    let registration: ServiceWorkerRegistration | undefined;
    let cancelled = false;
    let controlled = !!worker.controller;
    const changed = () => {
      if (controlled) setUpdateReady(true);
      controlled = true;
    };
    worker.addEventListener('controllerchange', changed);
    void worker
      .register('/sw.js', { updateViaCache: 'none' })
      .then((value) => {
        if (cancelled) return;
        registration = value;
        void value.update().catch(() => {});
      })
      .catch(() => {});
    const refresh = () => {
      if (document.visibilityState === 'visible')
        void registration?.update().catch(() => {});
    };
    document.addEventListener('visibilitychange', refresh);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', refresh);
      worker.removeEventListener('controllerchange', changed);
    };
  }, [profile.isTauri]);
  return (
    updateReady && (
      <aside className="offline-reading-launcher" role="status">
        <Button onClick={() => window.location.reload()}>
          Reload to update
        </Button>
      </aside>
    )
  );
}
