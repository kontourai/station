// Proof that a Station key was handed a broadcast channel by this gateway.
//
// Channel ids reach the Station, the phone and Apple; anyone else who learned
// one could otherwise end, alert or delete someone's Live Activity. The
// gateway answers a successful start with `channelAuth`, an HMAC over the
// channel's routing and the verified key thumbprint, and requires it on every
// later update, end and delete. The gateway still stores nothing: the secret
// is a Worker secret, and rotation accepts the previous one for a while.

import { base64UrlEncode } from './station-auth.ts';

const PREFIX = 'v1.';
const DOMAIN = 'station-apns-channel:v1';
/** A secret shorter than this is treated as not configured. */
const MIN_SECRET_LENGTH = 32;

export interface ChannelAuthSecrets {
  current: string;
  /** Still accepted during rotation; a match earns a fresh token. */
  previous?: string;
}

export interface ChannelBinding {
  bundleId: string;
  environment: string;
  channelId: string;
  /** The verified signing key's RFC 7638 thumbprint. */
  stationKey: string;
}

export function parseChannelAuthSecrets(
  current: string | undefined,
  previous: string | undefined,
): ChannelAuthSecrets | null {
  if (!current || current.length < MIN_SECRET_LENGTH) return null;
  return previous && previous.length >= MIN_SECRET_LENGTH
    ? { current, previous }
    : { current };
}

const encoder = new TextEncoder();

function message(binding: ChannelBinding): Uint8Array<ArrayBuffer> {
  return encoder.encode(
    [
      DOMAIN,
      binding.bundleId,
      binding.environment,
      binding.channelId,
      binding.stationKey,
    ].join('\n'),
  );
}

function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function signChannelAuth(
  secrets: ChannelAuthSecrets,
  binding: ChannelBinding,
): Promise<string> {
  const mac = await crypto.subtle.sign(
    'HMAC',
    await hmacKey(secrets.current),
    message(binding),
  );
  return PREFIX + base64UrlEncode(mac);
}

function decodeMac(token: string): Uint8Array<ArrayBuffer> | null {
  if (!token.startsWith(PREFIX)) return null;
  const value = token.slice(PREFIX.length);
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
  const bytes = Uint8Array.from(
    atob(`${value.replaceAll('-', '+').replaceAll('_', '/')}=`),
    (c) => c.charCodeAt(0),
  );
  // Only the canonical encoding: one MAC must not have two spellings.
  return base64UrlEncode(bytes) === value ? bytes : null;
}

/**
 * `current` when the token was made with the current secret, `previous` when
 * with the rotated-out one (the caller should hand back a fresh token), and
 * null when it proves nothing. Comparison is crypto.subtle.verify, which is
 * constant-time.
 */
export async function verifyChannelAuth(
  secrets: ChannelAuthSecrets,
  binding: ChannelBinding,
  token: string,
): Promise<'current' | 'previous' | null> {
  const mac = decodeMac(token);
  if (!mac) return null;
  const data = message(binding);
  if (
    await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secrets.current),
      mac,
      data,
    )
  )
    return 'current';
  if (
    secrets.previous &&
    (await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secrets.previous),
      mac,
      data,
    ))
  )
    return 'previous';
  return null;
}
