import { createHash, createPublicKey } from 'node:crypto';
import { NATIVE_RELAY_ENROLLMENT_VERSION } from '@kontourai/station-contracts/native-relay-enrollment';
import canonicalize from 'canonicalize';
import { z } from 'zod';

export const nativeEnrollmentOpaque = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const uuid = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const nativeEnrollmentSurfaceSchema = z
  .object({
    kind: z.literal('station-native'),
    appIdentifier: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/u),
    channel: z.enum(['dev', 'stable', 'beta', 'nightly']),
    clientInstanceId: uuid,
    keyThumbprint: nativeEnrollmentOpaque,
  })
  .strict();
export const nativeEnrollmentScopeSchema = z
  .object({
    stationId: uuid,
    enrollmentId: uuid,
    routingGeneration: integer.positive(),
  })
  .strict();
const nativeEnrollmentPublicKeySchema = z
  .object({
    kty: z.literal('EC'),
    crv: z.literal('P-256'),
    x: nativeEnrollmentOpaque,
    y: nativeEnrollmentOpaque,
  })
  .strict()
  .refine((key) => {
    try {
      const exported = createPublicKey({ key, format: 'jwk' }).export({
        format: 'jwk',
      });
      return exported.x === key.x && exported.y === key.y;
    } catch {
      return false;
    }
  });
export const nativeEnrollmentRecipientSchema = z
  .object({
    suite: z
      .object({ kem: z.literal(16), kdf: z.literal(1), aead: z.literal(1) })
      .strict(),
    publicKey: z.string().regex(/^[A-Za-z0-9_-]{87}$/u),
  })
  .strict()
  .refine((recipient) => {
    const bytes = Buffer.from(recipient.publicKey, 'base64url');
    return (
      bytes.length === 65 &&
      bytes[0] === 4 &&
      bytes.toString('base64url') === recipient.publicKey &&
      nativeEnrollmentPublicKeySchema.safeParse({
        kty: 'EC',
        crv: 'P-256',
        x: bytes.subarray(1, 33).toString('base64url'),
        y: bytes.subarray(33).toString('base64url'),
      }).success
    );
  });
export const nativeEnrollmentBindingSchema = z
  .object({
    stationId: uuid,
    stationAudience: z.string().url().max(2048),
    scope: nativeEnrollmentScopeSchema,
    surface: nativeEnrollmentSurfaceSchema,
    peerNonce: nativeEnrollmentOpaque,
    enrollmentId: nativeEnrollmentOpaque,
    reservedDeviceId: uuid,
    recipient: nativeEnrollmentRecipientSchema,
  })
  .strict();
export const nativeEnrollmentCandidateSchema = z
  .object({
    version: z.literal('station-native-device-binding-candidate/v1'),
    stationId: uuid,
    deviceId: uuid,
    bindingId: uuid,
    surface: nativeEnrollmentSurfaceSchema,
    deviceProofJwk: nativeEnrollmentPublicKeySchema,
    deviceProofKeyThumbprint: nativeEnrollmentOpaque,
  })
  .strict()
  .refine((candidate) => {
    const key = candidate.deviceProofJwk;
    const thumbprint = createHash('sha256')
      .update(
        JSON.stringify({ crv: key.crv, kty: key.kty, x: key.x, y: key.y }),
      )
      .digest('base64url');
    return (
      thumbprint === candidate.deviceProofKeyThumbprint &&
      thumbprint !== candidate.surface.keyThumbprint
    );
  });
export const nativeEnrollmentChallengeSchema = nativeEnrollmentBindingSchema
  .extend({
    version: z.literal(NATIVE_RELAY_ENROLLMENT_VERSION),
    nonce: nativeEnrollmentOpaque,
    expiresAt: integer.positive(),
    clientAttemptId: nativeEnrollmentOpaque,
    responsePeerNonce: nativeEnrollmentOpaque,
    requestedScope: z.literal('orchestration:read'),
    registrationAvailable: z.boolean(),
    stationSigningGeneration: integer.positive(),
  })
  .strict();
export const nativeEnrollmentReceiptSchema = z
  .object({
    version: z.literal(NATIVE_RELAY_ENROLLMENT_VERSION),
    state: z.literal('active'),
    enrollmentId: nativeEnrollmentOpaque,
    deviceId: uuid,
    bindingId: uuid,
    receiptDigest: nativeEnrollmentOpaque,
    receiptExpiresAt: integer.positive(),
    binding: nativeEnrollmentBindingSchema,
    candidate: nativeEnrollmentCandidateSchema,
    deviceReceipt: z
      .object({
        version: z.literal('station-native-device-proof-self-receipt/v1'),
        currentDeviceBinding: z.literal(true),
        binding: z
          .object({
            stationId: uuid,
            deviceId: uuid,
            bindingId: uuid,
            surface: nativeEnrollmentSurfaceSchema,
            deviceProofJwk: nativeEnrollmentPublicKeySchema,
            deviceProofKeyThumbprint: nativeEnrollmentOpaque,
            state: z.literal('active'),
            createdAt: integer.positive(),
            approvedAt: integer.positive(),
          })
          .strict(),
      })
      .strict(),
    responsePeerNonce: nativeEnrollmentOpaque,
    stationSigningGeneration: integer.positive(),
  })
  .strict();
export const nativeEnrollmentStatusSchema = z
  .object({
    version: z.literal(NATIVE_RELAY_ENROLLMENT_VERSION),
    state: z.enum(['pending', 'cancelled', 'expired', 'revoked']),
    binding: nativeEnrollmentBindingSchema,
    candidate: nativeEnrollmentCandidateSchema,
    responsePeerNonce: nativeEnrollmentOpaque,
    observedAt: integer.positive(),
    stationSigningGeneration: integer.positive(),
  })
  .strict();
export const nativeEnrollmentProofSchema = nativeEnrollmentBindingSchema
  .extend({
    version: z.literal(NATIVE_RELAY_ENROLLMENT_VERSION),
    requestedScope: z.literal('orchestration:read'),
    purpose: z.enum([
      'login',
      'register',
      'finalize',
      'activate',
      'status',
      'cancel',
    ]),
    candidate: nativeEnrollmentCandidateSchema,
    nonce: nativeEnrollmentOpaque,
    htm: z.literal('POST'),
    htu: z.string().max(2048),
    payloadSha256: nativeEnrollmentOpaque,
    jti: nativeEnrollmentOpaque,
    iat: integer,
    exp: integer,
  })
  .strict();

export function nativeEnrollmentCanonical(value: unknown): string {
  const encoded = canonicalize(value);
  if (encoded === undefined) throw new Error('native_enrollment_invalid');
  return encoded;
}
export function nativeEnrollmentPayloadDigest(value: unknown): string {
  return createHash('sha256')
    .update(nativeEnrollmentCanonical(value))
    .digest('base64url');
}
