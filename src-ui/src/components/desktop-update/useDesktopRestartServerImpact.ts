import { useApiBase } from '../../contexts/ApiBaseContext';
import { usePlatformProfile } from '../../platform/PlatformProfileContext';
import { useBundledServerStatus } from '../../platform/useBundledServerStatus';
import {
  type DesktopRestartServerImpact,
  desktopRestartServerImpact,
} from './restartImpact';

/** What restarting the desktop app does to this window's Station server. */
export function useDesktopRestartServerImpact(): DesktopRestartServerImpact {
  const profile = usePlatformProfile();
  const { apiBase } = useApiBase();
  const bundled = useBundledServerStatus(profile.supervisesBundledServer);
  return desktopRestartServerImpact({
    supervisesBundledServer: profile.supervisesBundledServer,
    bundled,
    apiBase,
  });
}
