import { useSyncExternalStore } from 'react';

type NetworkInformation = EventTarget & {
  saveData?: boolean;
  metered?: boolean;
};

function connection(): NetworkInformation | undefined {
  return (navigator as Navigator & { connection?: NetworkInformation })
    .connection;
}

function constrained(): boolean {
  const info = connection();
  if (info?.saveData === true || info?.metered === true) return true;
  try {
    return window.StationAndroidInsets?.networkCost?.() === 'metered';
  } catch {
    return false;
  }
}

function subscribe(changed: () => void): () => void {
  const info = connection();
  info?.addEventListener('change', changed);
  window.addEventListener('station-network-cost-change', changed);
  document.addEventListener('visibilitychange', changed);
  return () => {
    info?.removeEventListener('change', changed);
    window.removeEventListener('station-network-cost-change', changed);
    document.removeEventListener('visibilitychange', changed);
  };
}

/** Only explicit data-saving/metered signals slow optional polling. Unknown is unchanged. */
export function useConstrainedNetwork(): boolean {
  return useSyncExternalStore(subscribe, constrained, () => false);
}
