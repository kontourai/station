import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BANNER_IDS,
  BANNER_PRIORITY,
  bannerStore,
} from '../contexts/banner-store';
import { checkForDesktopUpdate } from '../platform/native/desktopUpdate';
import { usePlatformProfile } from '../platform/PlatformProfileContext';

interface AvailableDesktopUpdate {
  version: string;
  install: () => Promise<void>;
}

/**
 * The desktop shell's own self-update (station#575) — distinct from
 * `CoreUpdateLaunchCheck`, which reports whether the *connected Station* is
 * behind, not whether this native binary is. Rhymes with that component's
 * shape (a launch-only check presenting through the shared banner slot) but
 * checks a different thing through a different mechanism: the Tauri updater
 * plugin, which is only even registered on a build whose config carries
 * updater endpoints (see `desktopUpdate.ts`).
 *
 * Launch check only — no polling loop. A failed check never raises a
 * banner: it is indistinguishable here from "this build has no update
 * channel", which is correct, ordinary state for a dev build or a channel
 * whose endpoint has not shipped yet.
 */
export function DesktopUpdateLaunchCheck() {
  const { isDesktop } = usePlatformProfile();
  const [available, setAvailable] = useState<AvailableDesktopUpdate | null>(
    null,
  );
  const [installFailure, setInstallFailure] = useState<string | null>(null);
  const installing = useRef(false);

  useEffect(() => {
    if (!isDesktop) return;
    let active = true;
    void checkForDesktopUpdate().then((outcome) => {
      if (!active || outcome.status !== 'update-available') return;
      setAvailable({ version: outcome.version, install: outcome.install });
    });
    return () => {
      active = false;
    };
  }, [isDesktop]);

  const install = useCallback(() => {
    if (!available || installing.current) return;
    installing.current = true;
    setInstallFailure(null);
    void available
      .install()
      .catch((error: unknown) => {
        setInstallFailure(
          error instanceof Error
            ? error.message
            : 'Station could not install the update.',
        );
      })
      .finally(() => {
        installing.current = false;
      });
  }, [available]);

  useEffect(() => {
    if (!available) {
      bannerStore.dismiss(BANNER_IDS.desktopUpdateAvailable);
      return;
    }
    bannerStore.present({
      id: BANNER_IDS.desktopUpdateAvailable,
      priority: BANNER_PRIORITY.info,
      tone: 'info',
      ariaLive: 'polite',
      message: `Station ${available.version} is available.`,
      occurrence: available.version,
      dismissible: true,
      actions: [{ label: 'Install and restart', onClick: install }],
    });
    return () => {
      bannerStore.dismiss(BANNER_IDS.desktopUpdateAvailable);
    };
  }, [available, install]);

  useEffect(() => {
    if (!installFailure) {
      bannerStore.dismiss(BANNER_IDS.desktopUpdateInstallFailure);
      return;
    }
    bannerStore.present({
      id: BANNER_IDS.desktopUpdateInstallFailure,
      priority: BANNER_PRIORITY.info,
      tone: 'error',
      message: `Station could not install the update: ${installFailure}`,
      occurrence: installFailure,
      dismissible: true,
      actions: [{ label: 'Try again', onClick: install }],
    });
    return () => {
      bannerStore.dismiss(BANNER_IDS.desktopUpdateInstallFailure);
    };
  }, [installFailure, install]);

  return null;
}
