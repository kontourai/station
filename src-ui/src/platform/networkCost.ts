import { useSyncExternalStore } from 'react';
import {
  iosNetworkConstrained,
  subscribeIosNetworkCost,
} from './native/iosNetworkCost';

type NetworkInformation = EventTarget & {
  saveData?: boolean;
  metered?: boolean;
};

function connection(): NetworkInformation | undefined {
  return (navigator as Navigator & { connection?: NetworkInformation })
    .connection;
}

function constrained(): boolean {
  if (iosNetworkConstrained()) return true;
  const info = connection();
  if (info?.saveData === true || info?.metered === true) return true;
  try {
    return window.StationAndroidInsets?.networkCost?.() === 'metered';
  } catch {
    return false;
  }
}

function subscribe(changed: () => void): () => void {
  const stopIos = subscribeIosNetworkCost(changed);
  const info = connection();
  info?.addEventListener('change', changed);
  window.addEventListener('station-network-cost-change', changed);
  document.addEventListener('visibilitychange', changed);
  return () => {
    stopIos();
    info?.removeEventListener('change', changed);
    window.removeEventListener('station-network-cost-change', changed);
    document.removeEventListener('visibilitychange', changed);
  };
}

/** Only explicit data-saving/metered signals slow optional polling. Unknown is unchanged. */
export function useConstrainedNetwork(): boolean {
  return useSyncExternalStore(subscribe, constrained, () => false);
}
