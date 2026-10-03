import { isLoopbackUrl } from './connectionProfile';

/**
 * Steer manual host entry toward the identity-bearing HTTPS path.
 *
 * Station device-pairing bearers gain the ingress-injected WhoIs identity only
 * when a host is reached over its HTTPS address (e.g. a Tailscale-serve
 * `https://station.foo.ts.net`); a raw `http://IP` bypasses that identity flow.
 * So when a user types a bare address with no scheme we default it to `https`,
 * while still honoring an explicitly typed `http://` (raw LAN/direct access
 * stays valid and unblocked).
 *
 * - Trims surrounding whitespace.
 * - Keeps the input verbatim when it already carries a URL scheme
 *   (`http://`, `https://`, or any `scheme://`).
 * - Prepends `https://` when no scheme is present, so `station.foo.ts.net` and
 *   `myhost:3151` both resolve over HTTPS.
 *
 * Callers still pass the result to `new URL(...)` and handle invalid input.
 */
export function normalizeHostInput(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  // Already scheme-qualified (http://, https://, tauri://, …) — keep as typed.
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

/**
 * True when `url` is cleartext HTTP to a non-loopback host — a raw IP or a
 * remote hostname reached over `http://`. This is the case where the identity
 * and encryption benefits of HTTPS apply, so callers surface a non-blocking
 * "prefer HTTPS" hint. Loopback (`localhost`/`127.0.0.1`/`[::1]`), any HTTPS
 * URL, and unparseable input all return false.
 */
export function isCleartextNonLoopback(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:') return false;
    return !isLoopbackUrl(url);
  } catch {
    return false;
  }
}

/** Match native credential custody's numeric-loopback HTTP exception. */
export function httpConnectionConsentRequired(address: string): boolean {
  try {
    const url = new URL(address);
    if (url.protocol !== 'http:') return false;
    // A served Station keeps its same-origin browser session. Native shells
    // have a separate app origin and must satisfy credential custody instead.
    if (typeof window !== 'undefined' && url.origin === window.location.origin)
      return false;
    // Native credential custody exempts numeric loopback, not DNS names.
    return !(
      /^127(?:\.\d{1,3}){3}$/.test(url.hostname) || url.hostname === '[::1]'
    );
  } catch {
    return false;
  }
}

/** Exact device-approved HTTP origin; absence always keeps HTTPS required. */
export function httpDevelopmentOrigin(address: string): string | undefined {
  if (!httpConnectionConsentRequired(address)) return undefined;
  try {
    const origin = new URL(address).origin;
    return localStorage.getItem(`station-http-development:${origin}`) ===
      'allowed'
      ? origin
      : undefined;
  } catch {
    return undefined;
  }
}
