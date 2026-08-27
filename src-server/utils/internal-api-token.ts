import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const INTERNAL_API_TOKEN_KEY = Symbol.for('station.internalApiToken');

type InternalGlobal = typeof globalThis & {
  [INTERNAL_API_TOKEN_KEY]?: string;
};

export const INTERNAL_API_TOKEN_HEADER = 'x-station-internal-token';
export const INTERNAL_PROXY_CALLER_HEADER = 'x-station-proxy-caller';
export const INTERNAL_INGRESS_IDENTITY_HEADER = 'x-station-ingress-identity';
/** Canonical tenant selected by the Station-owned UI ingress proxy. */
export const INTERNAL_TENANT_HEADER = 'x-station-internal-tenant';
/**
 * The address Station's own loopback UI proxy saw its directly connected
 * client at (station#1490). Attested, never relayed: the proxy strips any
 * client-supplied copy before setting its own, and a reader must accept it
 * only alongside a trusted {@link INTERNAL_API_TOKEN_HEADER} from a loopback
 * direct peer.
 *
 * It exists because the proxy hop otherwise erases the one fact pairing
 * approval depends on. Everything arriving through the proxy reaches the API
 * from 127.0.0.1, so a phone on the LAN and the operator's own browser become
 * the same request, and `x-station-proxy-caller` cannot stand in for it: that
 * header answers "was the client loopback?", whose negation is exactly the
 * self-dial the off-box predicate exists to refuse.
 */
export const INTERNAL_PROXY_PEER_HEADER = 'x-station-proxy-peer';
/**
 * The `Host` the BROWSER used, as seen by Station's own loopback UI proxy
 * before it rewrote `Host` to the upstream address (station#3752). Attested
 * exactly like {@link INTERNAL_PROXY_PEER_HEADER}: the proxy strips any
 * client-supplied copy before setting its own, and a reader must accept it
 * only alongside a trusted {@link INTERNAL_API_TOKEN_HEADER} from a loopback
 * direct peer.
 *
 * It exists because a URL minted for the browser — today the consent review
 * URL — must name the host the BROWSER is talking to, not the upstream the
 * proxy dialled. Deriving it from the proxied `Host` produced
 * `http://127.0.0.1:<consentPort>/consent/<id>` for a browser on
 * `http://localhost:<uiPort>`, and cookies are scoped by HOST: the
 * transaction cookie set under `localhost` was never sent to `127.0.0.1`, so
 * the review page refused every operator with "Sign in to Station first" and
 * no plugin could be granted trusted access at all.
 *
 * This is not `x-forwarded-host`, which any direct caller can spell and which
 * `public-ingress-origin.ts` rightly refuses to trust. It is only ever read
 * across the attested proxy hop.
 */
export const INTERNAL_PROXY_FORWARDED_HOST_HEADER =
  'x-station-proxy-forwarded-host';
export const INTERNAL_API_TOKEN_ENV = 'STATION_INTERNAL_API_TOKEN';

export interface VerifiedIngressIdentity {
  provider: 'tailscale-serve';
  login: string;
  displayName?: string;
}

export function getInternalApiToken(): string {
  const globalState = globalThis as InternalGlobal;
  if (!globalState[INTERNAL_API_TOKEN_KEY]) {
    globalState[INTERNAL_API_TOKEN_KEY] =
      process.env[INTERNAL_API_TOKEN_ENV] ??
      randomBytes(32).toString('base64url');
  }
  return globalState[INTERNAL_API_TOKEN_KEY]!;
}

export function isTrustedInternalApiToken(
  candidate: string | undefined,
): boolean {
  if (typeof candidate !== 'string') return false;
  const candidateDigest = createHash('sha256').update(candidate).digest();
  const expectedDigest = createHash('sha256')
    .update(getInternalApiToken())
    .digest();
  return timingSafeEqual(candidateDigest, expectedDigest);
}

/**
 * Decode identity produced by Station's own loopback UI proxy. The public
 * proxy removes this header from callers before creating it, and its sibling
 * backend connection is authenticated with the per-boot internal token.
 */
export function readVerifiedIngressIdentity(
  environment: unknown,
  headers: { identity?: string; token?: string },
): VerifiedIngressIdentity | undefined {
  if (
    !isLoopbackEnvironment(environment) ||
    !isTrustedInternalApiToken(headers.token) ||
    !headers.identity ||
    headers.identity.length > 1_024 ||
    !/^[A-Za-z0-9_-]+$/.test(headers.identity)
  ) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(
      Buffer.from(headers.identity, 'base64url').toString('utf8'),
    );
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort().join(',');
    if (keys !== 'login,provider' && keys !== 'displayName,login,provider') {
      return undefined;
    }
    if (
      record.provider !== 'tailscale-serve' ||
      typeof record.login !== 'string' ||
      !isSafeIdentityText(record.login, 254) ||
      (record.displayName !== undefined &&
        (typeof record.displayName !== 'string' ||
          !isSafeIdentityText(record.displayName, 128)))
    ) {
      return undefined;
    }
    return {
      provider: 'tailscale-serve',
      login: record.login,
      ...(typeof record.displayName === 'string'
        ? { displayName: record.displayName }
        : {}),
    };
  } catch {
    return undefined;
  }
}

function isSafeIdentityText(value: string, maxLength: number): boolean {
  return (
    value === value.trim() &&
    value.length > 0 &&
    value.length <= maxLength &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  );
}

function isLoopbackEnvironment(environment: unknown): boolean {
  if (!environment || typeof environment !== 'object') return false;
  const incoming = (environment as { incoming?: unknown }).incoming;
  if (!incoming || typeof incoming !== 'object') return false;
  const socket = (incoming as { socket?: unknown }).socket;
  if (!socket || typeof socket !== 'object') return false;
  const address = (socket as { remoteAddress?: unknown }).remoteAddress;
  if (typeof address !== 'string') return false;
  const normalized = address.trim().toLowerCase();
  return (
    normalized === '::1' ||
    normalized === '0:0:0:0:0:0:0:1' ||
    normalized.startsWith('127.') ||
    normalized.startsWith('::ffff:127.')
  );
}
