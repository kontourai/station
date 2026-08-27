import { useEffect } from 'react';
import {
  BANNER_IDS,
  BANNER_PRIORITY,
  bannerStore,
} from '../contexts/banner-store';

export function MobileConnectionBanner({ onOpen }: { onOpen: () => void }) {
  useEffect(() => {
    bannerStore.present({
      id: BANNER_IDS.deviceConnection,
      priority: BANNER_PRIORITY.setup,
      tone: 'info',
      badge: 'No Station connected',
      message:
        'Connect this device to a Station when you are ready. Local settings and cached work remain available.',
      actions: [{ label: 'Connect to a Station', onClick: onOpen }],
    });
    return () => bannerStore.dismiss(BANNER_IDS.deviceConnection);
  }, [onOpen]);
  return null;
}
