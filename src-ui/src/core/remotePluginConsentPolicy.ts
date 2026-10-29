export function isLoopbackPluginOrigin(apiBase: string): boolean {
  try {
    const url = new URL(apiBase);
    return (
      url.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

export function remotePluginConsentRequired(
  apiBase: string,
  nativeHost: boolean,
  remoteProfile: boolean,
): boolean {
  return (
    Boolean(apiBase) &&
    (nativeHost || typeof window === 'undefined') &&
    ((nativeHost && remoteProfile) || !isLoopbackPluginOrigin(apiBase))
  );
}
