// Verifies the signed envelope a Station attaches to every push request.
//
// A Station signs each request with its own P-256 push key (ES256 JWS) and
// carries the public JWK in the protected header. The gateway keeps no Station
// registry: it trusts the key only to the extent of rate limiting by its
// thumbprint. What stops a stranger from pushing to a phone is the phone
// itself, which drops payloads whose per-registration id does not match the
// one its own Station configured (see AgentNotifications.receive).

export const PUSH_JWT_TYPE = 'station-push+jwt';
const MAX_LIFETIME_SECONDS = 120;
const CLOCK_SKEW_SECONDS = 60;

export type StationAuthResult =
  | { ok: true; keyThumbprint: string }
  | { ok: false; reason: string };

type Bytes = Uint8Array<ArrayBuffer>;

export interface PushJwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
}

const encoder = new TextEncoder();

export function base64UrlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

function base64UrlDecode(value: string): Bytes | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  const padded =
    value.replaceAll('-', '+').replaceAll('_', '/') +
    '='.repeat((4 - (value.length % 4)) % 4);
  try {
    return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function decodeJson(segment: string): Record<string, unknown> | null {
  const bytes = base64UrlDecode(segment);
  if (!bytes) return null;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function publicJwk(value: unknown): PushJwk | null {
  if (!value || typeof value !== 'object') return null;
  const jwk = value as Record<string, unknown>;
  // A private component in the header means the Station leaked its key; refuse
  // rather than silently accept a request signed by a now-public key.
  if ('d' in jwk) return null;
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256') return null;
  if (typeof jwk.x !== 'string' || typeof jwk.y !== 'string') return null;
  if (
    base64UrlDecode(jwk.x)?.length !== 32 ||
    base64UrlDecode(jwk.y)?.length !== 32
  )
    return null;
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
}

/** RFC 7638 thumbprint: the stable identity of a Station push key. */
export async function jwkThumbprint(jwk: PushJwk): Promise<string> {
  const canonical = `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`;
  return base64UrlEncode(
    await crypto.subtle.digest('SHA-256', encoder.encode(canonical)),
  );
}

export async function bodyHash(body: Bytes): Promise<string> {
  return base64UrlEncode(await crypto.subtle.digest('SHA-256', body));
}

export async function verifyStationRequest(input: {
  authorization: string | null;
  body: Bytes;
  audiences: readonly string[];
  nowSeconds: number;
}): Promise<StationAuthResult> {
  const match =
    /^Station ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(
      input.authorization ?? '',
    );
  if (!match)
    return { ok: false, reason: 'missing or malformed Station authorization' };
  const [, headerSegment, payloadSegment, signatureSegment] = match;

  const header = decodeJson(headerSegment);
  if (!header || header.alg !== 'ES256' || header.typ !== PUSH_JWT_TYPE) {
    return { ok: false, reason: 'unsupported token header' };
  }
  const jwk = publicJwk(header.jwk);
  if (!jwk)
    return { ok: false, reason: 'header must carry a public P-256 jwk' };

  const signature = base64UrlDecode(signatureSegment);
  // JWS ES256 signatures are raw r||s, which is also what WebCrypto verifies.
  if (!signature || signature.length !== 64)
    return { ok: false, reason: 'bad signature encoding' };
  const key = await crypto.subtle.importKey(
    'jwk',
    { ...jwk, ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  const signed = encoder.encode(`${headerSegment}.${payloadSegment}`);
  const valid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    signature,
    signed,
  );
  if (!valid) return { ok: false, reason: 'signature does not verify' };

  const claims = decodeJson(payloadSegment);
  if (!claims) return { ok: false, reason: 'unreadable claims' };
  if (typeof claims.aud !== 'string' || !input.audiences.includes(claims.aud)) {
    return { ok: false, reason: 'wrong audience' };
  }
  const { iat, exp } = claims;
  if (typeof iat !== 'number' || typeof exp !== 'number')
    return { ok: false, reason: 'iat and exp are required' };
  if (exp - iat > MAX_LIFETIME_SECONDS || exp <= iat)
    return { ok: false, reason: 'token lifetime out of range' };
  if (iat > input.nowSeconds + CLOCK_SKEW_SECONDS)
    return { ok: false, reason: 'token issued in the future' };
  if (exp < input.nowSeconds - CLOCK_SKEW_SECONDS)
    return { ok: false, reason: 'token expired' };
  // Binding the body into the signature is what makes the token single-purpose:
  // a captured token cannot carry a different message.
  if (claims.bsh !== (await bodyHash(input.body)))
    return { ok: false, reason: 'body does not match token' };

  return { ok: true, keyThumbprint: await jwkThumbprint(jwk) };
}
