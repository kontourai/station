const REMOTE_BUNDLES_ALLOWED_KEY_PREFIX =
  'station:plugin-registry:remote-bundles-allowed';

const listeners = new Set<() => void>();

export function remotePluginBundlesAllowedKey(connectionId: string): string {
  return `${REMOTE_BUNDLES_ALLOWED_KEY_PREFIX}:${connectionId}`;
}

function consentedOrigin(apiBase: string): string | null {
  try {
    return new URL(apiBase).origin;
  } catch {
    return null;
  }
}

/** Storage is optional browser capability; an unavailable store is never consent. */
export function remotePluginBundlesAllowed(
  connectionId: string,
  apiBase: string,
): boolean {
  const origin = consentedOrigin(apiBase);
  if (!origin) return false;
  try {
    return (
      window.localStorage.getItem(
        remotePluginBundlesAllowedKey(connectionId),
      ) === origin
    );
  } catch {
    return false;
  }
}

export function setRemotePluginBundlesAllowed(
  connectionId: string,
  apiBase: string,
  allowed: boolean,
): boolean {
  const origin = consentedOrigin(apiBase);
  if (!origin) return false;
  try {
    const key = remotePluginBundlesAllowedKey(connectionId);
    if (allowed) {
      window.localStorage.setItem(key, origin);
      if (window.localStorage.getItem(key) !== origin) return false;
    } else {
      window.localStorage.removeItem(key);
      // Root-window bundle code has the same localStorage authority as Station,
      // so this store cannot defend consent from a previously enabled bundle.
      // archive#2456's iframe isolation is the needed architectural boundary.
      if (window.localStorage.getItem(key) === origin) return false;
    }
  } catch {
    return false;
  }
  for (const listener of listeners) listener();
  return true;
}

export function subscribeRemotePluginBundleConsent(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Exported seam so revoke behavior is directly testable without navigation. */
export function reloadAfterRemotePluginBundleRevoke(): void {
  window.location.reload();
}
