import {
  NATIVE_DEVICE_PROOF_LIFETIME_SECONDS,
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
        url.protocol === 'https:' &&
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
    appIdentifier: z.string().min(1).max(256),
    channel: z.enum(['dev', 'stable', 'beta', 'nightly']),
    clientInstanceId: z.string().min(1).max(256),
    keyThumbprint: opaque,
  })
  .strict();
const bindingSchema = z
  .object({
    stationId: z.string().min(1),
    stationAudience: audience,
    deviceId: z.string().min(1),
    bindingId: z.string().uuid(),
    surface: surfaceSchema,
    peerNonce: z.string().min(1).max(256),
  })
  .strict();

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const encode = (value: unknown) =>
  base64url(new TextEncoder().encode(JSON.stringify(value)));

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
  if (thumbprint !== snapshot.surface.keyThumbprint)
    throw new Error(
      'Native device proof key does not match the approved binding thumbprint.',
    );
  const method = request.method.toUpperCase();
  if (!/^[A-Z]+$/.test(method))
    throw new Error('Native device proof requires an alphabetic HTTP method.');
  const path = request.path;
  if (!path.startsWith('/') || /\s/.test(path) || path.includes('#'))
    throw new Error(
      'Native device proof requires an absolute request path without fragment.',
    );
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
    surface: snapshot.surface,
    peerNonce: snapshot.peerNonce,
    htm: method,
    htu: path,
    bodySha256: base64url(
      new Uint8Array(
        await crypto.subtle.digest('SHA-256', new Uint8Array(request.body)),
      ),
    ),
    jti: base64url(crypto.getRandomValues(new Uint8Array(16))),
    iat,
    exp: iat + NATIVE_DEVICE_PROOF_LIFETIME_SECONDS,
  });
  const input = `${protectedHeader}.${payload}`;
  const signature = await signer.sign(new TextEncoder().encode(input));
  if (signature.byteLength !== 64)
    throw new Error(
      'Native device proof signer returned an incompatible signature.',
    );
  return `${input}.${base64url(signature)}`;
}
