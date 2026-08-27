const CSP_NONCE_PATTERN = /^[A-Za-z0-9+/_=-]+$/;
const TAURI_SCRIPT_NONCE_TOKEN = '__TAURI_SCRIPT_NONCE__';

function validNonce(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value !== TAURI_SCRIPT_NONCE_TOKEN &&
    CSP_NONCE_PATTERN.test(value)
  );
}

/**
 * The nonce the DESKTOP shell's CSP carries, read from the marker element
 * Tauri rewrites at serve time (`src-ui/index.html`).
 *
 * There is deliberately no HTTP-shell branch left here. That shell used to
 * publish its per-response nonce as `window.__STATION_CSP_NONCE__` so plugin
 * bundles could be fetched as bytes and executed inline under it; it no longer
 * does (station#4287), because a nonce readable by page code is a nonce every
 * plugin bundle can reuse on an undeclared remote script. Its bundles load by
 * same-origin URL instead and need no nonce.
 *
 * The desktop shell cannot do that: its window is Tauri's asset origin
 * (`WebviewUrl::App("index.html")`), the bundle lives on the supervised
 * server's loopback origin, so `'self'` does not admit the URL — see
 * `PluginRegistry.loadScript`. Until the desktop host serves plugin bundles
 * from its own origin, that path still needs this value.
 */
export function resolveCspNonce(
  documentRef: Document = document,
): string | undefined {
  const tauriNonce = documentRef.querySelector<HTMLScriptElement>(
    'script[data-station-csp-nonce][nonce]',
  )?.nonce;
  return validNonce(tauriNonce) ? tauriNonce : undefined;
}
