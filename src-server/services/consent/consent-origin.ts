/**
 * `STATION_TRUSTED_CONSENT_ORIGIN` — the exact HTTPS origin Station issues for
 * consent review URLs when the consent listener is reached through an HTTPS
 * mapping (for example a second Tailscale Serve mapping). Unset, nothing
 * changes: review URLs stay `http://<request host>:<consent port>`.
 *
 * Parsed once at startup. A malformed value is a startup error, never a
 * silent fallback: an operator who set it expects HTTPS review URLs, and
 * quietly issuing plain-http ones would hide the mistake.
 */
import { isIP } from 'node:net';

export const TRUSTED_CONSENT_ORIGIN_ENV = 'STATION_TRUSTED_CONSENT_ORIGIN';

/**
 * `https://` (8) + a 253-character DNS name + `:65535` (6). Anything longer
 * cannot be a valid origin, so it is refused rather than truncated.
 */
export const MAX_TRUSTED_CONSENT_ORIGIN_LENGTH = 267;

export class TrustedConsentOriginError extends Error {
  constructor(reason: string) {
    super(
      `Invalid ${TRUSTED_CONSENT_ORIGIN_ENV}: ${reason}. Expected an exact HTTPS origin such as https://station.example.ts.net or https://station.example.ts.net:8443.`,
    );
    this.name = 'TrustedConsentOriginError';
  }
}

/**
 * Returns the canonical origin, or `null` when the setting is unset or empty.
 * Throws {@link TrustedConsentOriginError} for any other value that is not
 * exactly an https origin on a DNS name.
 */
export function parseTrustedConsentOrigin(
  raw: string | undefined,
): string | null {
  if (raw === undefined || raw === '') return null;
  if (raw.length > MAX_TRUSTED_CONSENT_ORIGIN_LENGTH) {
    throw new TrustedConsentOriginError(
      `the value is longer than ${MAX_TRUSTED_CONSENT_ORIGIN_LENGTH} characters`,
    );
  }
  if (raw.includes('*')) {
    throw new TrustedConsentOriginError('wildcards are not allowed');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TrustedConsentOriginError('the value is not a URL');
  }
  if (url.protocol !== 'https:') {
    throw new TrustedConsentOriginError('the scheme must be https');
  }
  if (url.username !== '' || url.password !== '') {
    throw new TrustedConsentOriginError('userinfo is not allowed');
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new TrustedConsentOriginError(
      'a path, query or fragment is not allowed',
    );
  }
  // WebAuthn relying-party IDs must be domains (design decision D10), and a
  // TLS name cannot be an address. `URL` brackets IPv6 and canonicalises
  // numeric IPv4 spellings, so strip the brackets before asking.
  const bareHost = url.hostname.replace(/^\[|\]$/g, '');
  if (bareHost === '' || isIP(bareHost) !== 0) {
    throw new TrustedConsentOriginError(
      'an IP address is not allowed; use a DNS name',
    );
  }
  // Port 0 is "any port" to a listener, never a mapped HTTPS port, and a
  // trailing-dot FQDN is a different origin string from the dotless name the
  // browser and WebAuthn derive from the app host.
  if (url.port === '0') {
    throw new TrustedConsentOriginError('port 0 is not allowed');
  }
  if (bareHost.endsWith('.')) {
    throw new TrustedConsentOriginError(
      'a trailing dot in the host is not allowed',
    );
  }
  // Exact comparison with the canonical serialisation catches trailing junk,
  // a trailing slash, uppercase, whitespace and a spelled-out default port.
  if (raw !== url.origin) {
    throw new TrustedConsentOriginError(`use the canonical form ${url.origin}`);
  }
  return url.origin;
}
