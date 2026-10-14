import { useApiBase } from '../contexts/ApiBaseContext';
import { usePlatformProfile } from '../platform/PlatformProfileContext';
import { useBundledServerStatus } from '../platform/useBundledServerStatus';

function sameBase(left: string, right: string): boolean {
  return left.replace(/\/+$/, '') === right.replace(/\/+$/, '');
}

/**
 * Whether the Station this app talks to keeps running when the app closes.
 * `false` when it is the desktop's own Station that stops with the app,
 * `undefined` while the desktop host has not reported it yet. Only `true`
 * permits telling the user it is safe to close the app.
 */
export function useStationOutlivesApp(): boolean | undefined {
  const profile = usePlatformProfile();
  const { apiBase } = useApiBase();
  const bundled = useBundledServerStatus(profile.supervisesBundledServer);
  // Web and mobile reach a Station that runs elsewhere.
  if (!profile.supervisesBundledServer) return true;
  if (!bundled) return undefined;
  if (!bundled.apiBase || !sameBase(bundled.apiBase, apiBase)) return true;
  return bundled.canRunInBackground;
}
