import {
  NATIVE_DEVICE_PROOF_LIFETIME_SECONDS,
  NATIVE_DEVICE_PROOF_MAX_LENGTH,
  NATIVE_DEVICE_PROOF_REQUEST_PURPOSE,
  NATIVE_DEVICE_PROOF_TYPE,
  NATIVE_DEVICE_PROOF_VERSION,
  type NativeDeviceBindingSnapshot,
  type NativeDeviceProofPublicKey,
} from '@kontourai/station-contracts/native-device-proof';
import { z } from 'zod/v3';

/**
 * Custody boundary for the native Device proof key. The private key stays in
 * native platform custody; this facade exposes only the public JWK and an
 * ES256 (P-1363, 64-byte) signature over exact bytes.
 */
export interface NativeDeviceProofSigner {
  readonly publicKey: NativeDeviceProofPublicKey;
  /** ES256, IEEE-P1363 signature bytes over the exact `header.payload` input. */
  sign(input: Uint8Array): Promise<Uint8Array>;
}

const opaque = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const audience = z
  .string()
  .url()
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === 'https:' ||
          (url.protocol === 'http:' &&
            ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) &&
        url.origin === value &&
        !url.username &&
        !url.password
      );
    } catch {
      return false;
    }
  });
const surfaceSchema = z
  .object({
    kind: z.literal('station-native'),
    appIdentifier: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/),
    channel: z.enum(['dev', 'stable', 'beta', 'nightly']),
    clientInstanceId: z.string().uuid(),
    keyThumbprint: opaque,
  })
  .strict();
const bindingSchema = z
  .object({
    stationId: z.string().uuid(),
    stationAudience: audience,
    deviceId: z.string().uuid(),
    bindingId: z.string().uuid(),
    deviceProofKeyThumbprint: opaque,
    surface: surfaceSchema,
    peerNonce: opaque,
  })
  .strict();

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const encode = (value: unknown) =>
  base64url(new TextEncoder().encode(JSON.stringify(value)));

function canonicalPath(value: string): string {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    /[\\#\r\n\0]/.test(value) ||
    value.length > 2048
  )
    throw new Error('Native Device proof request path is invalid.');
  const parsed = new URL(value, 'https://station.invalid');
  if (parsed.pathname + parsed.search !== value)
    throw new Error('Native Device proof request path is not canonical.');
  return value;
}

/** RFC 7638 thumbprint so the signer can be matched to the approved binding. */
async function jwkThumbprint(publicKey: NativeDeviceProofPublicKey) {
  return base64url(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(
          JSON.stringify({
            crv: publicKey.crv,
            kty: publicKey.kty,
            x: publicKey.x,
            y: publicKey.y,
          }),
        ),
      ),
    ),
  );
}

/**
 * Builds a one-use ES256 compact JWS binding the approved native Device
 * binding to one exact request: uppercase method, path including query, and
 * SHA-256 of the exact transmitted body bytes. Fails closed on any invalid,
 * expired-scope or mismatched input; there is no credential input, storage or
 * transport here.
 */
export async function createNativeDeviceRequestProof(
  signer: NativeDeviceProofSigner,
  binding: NativeDeviceBindingSnapshot,
  request: { method: string; path: string; body: Uint8Array },
): Promise<string> {
  const snapshot = bindingSchema.parse(binding);
  const publicKey = z
    .object({
      kty: z.literal('EC'),
      crv: z.literal('P-256'),
      x: opaque,
      y: opaque,
    })
    .strict()
    .parse(signer.publicKey);
  const thumbprint = await jwkThumbprint(publicKey);
  if (thumbprint !== snapshot.deviceProofKeyThumbprint)
    throw new Error(
      'Native device proof key does not match the approved binding thumbprint.',
    );
  const method = request.method.toUpperCase();
  if (!/^[A-Z]{1,16}$/.test(method))
    throw new Error('Native device proof requires an alphabetic HTTP method.');
  const path = canonicalPath(request.path);
  if (
    !(request.body instanceof Uint8Array) ||
    request.body.byteLength > 16 * 1024
  )
    throw new Error(
      'Native Device proof request body exceeds the channel pilot limit.',
    );
  const body = new Uint8Array(request.body);
  const iat = Math.floor(Date.now() / 1000);
  const protectedHeader = encode({
    alg: 'ES256',
    typ: NATIVE_DEVICE_PROOF_TYPE,
  });
  const payload = encode({
    version: NATIVE_DEVICE_PROOF_VERSION,
    aud: snapshot.stationAudience,
    purpose: NATIVE_DEVICE_PROOF_REQUEST_PURPOSE,
    stationId: snapshot.stationId,
    deviceId: snapshot.deviceId,
    bindingId: snapshot.bindingId,
    deviceProofKeyThumbprint: snapshot.deviceProofKeyThumbprint,
    surface: snapshot.surface,
    peerNonce: snapshot.peerNonce,
    htm: method,
    htu: path,
    bodySha256: base64url(
      new Uint8Array(await crypto.subtle.digest('SHA-256', body)),
    ),
    jti: base64url(crypto.getRandomValues(new Uint8Array(16))),
    iat,
    exp: iat + NATIVE_DEVICE_PROOF_LIFETIME_SECONDS,
  });
  const input = `${protectedHeader}.${payload}`;
  // A 64-byte P1363 signature occupies 86 base64url characters plus the dot.
  if (input.length + 87 > NATIVE_DEVICE_PROOF_MAX_LENGTH)
    throw new Error('Native device proof exceeds the compact JWS size limit.');
  const signature = await signer.sign(new TextEncoder().encode(input));
  if (signature.byteLength !== 64)
    throw new Error(
      'Native device proof signer returned an incompatible signature.',
    );
  return `${input}.${base64url(signature)}`;
}
