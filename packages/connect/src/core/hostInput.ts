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
