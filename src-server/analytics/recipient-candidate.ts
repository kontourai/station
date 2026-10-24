import {
  createHash,
  createPublicKey,
  type KeyObject,
  sign,
  verify,
} from 'node:crypto';
import {
  ANALYTICS_RECIPIENT_CANDIDATE_PROTOCOL,
  type AnalyticsRecipientCandidate,
  type AnalyticsSourceEnrollmentIntent,
} from '@kontourai/station-contracts/usage-export';
import { z } from 'zod/v3';
import {
  analyticsOriginSchema,
  enrollmentIdentity,
  enrollmentIntentSchema,
  enrollmentOperationId,
} from './source-enrollment-protocol.js';

const coordinate = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/)
  .refine(
    (value) => Buffer.from(value, 'base64url').toString('base64url') === value,
  );
export const recipientEncryptionKeySchema = z
  .object({ kty: z.literal('OKP'), crv: z.literal('X25519'), x: coordinate })
  .strict();
export const recipientProofKeySchema = z
  .object({ kty: z.literal('OKP'), crv: z.literal('Ed25519'), x: coordinate })
  .strict();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const claimsSchema = z
  .object({
    protocol: z.literal(ANALYTICS_RECIPIENT_CANDIDATE_PROTOCOL),
    recipientId: enrollmentOperationId,
    sourceOperationId: enrollmentOperationId,
    sourceStationId: enrollmentIdentity,
    sourceIntentSha256: hash,
    proposedSourceOrigin: analyticsOriginSchema,
    destinationStationId: enrollmentIdentity,
    proposedDestinationOrigin: analyticsOriginSchema,
    recipientPrincipalId: enrollmentIdentity,
    recipientBindingSha256: hash,
    encryptionKey: recipientEncryptionKeySchema,
    proofKey: recipientProofKeySchema,
    createdAt: z.number().int().nonnegative().refine(Number.isSafeInteger),
    expiresAt: z.number().int().nonnegative().refine(Number.isSafeInteger),
  })
  .strict()
  .refine(
    (value) =>
      value.expiresAt > value.createdAt &&
      value.expiresAt - value.createdAt <= 300_000,
  );
export const recipientCandidateSchema = z
  .object({
    claims: claimsSchema,
    signature: z
      .string()
      .regex(/^[A-Za-z0-9_-]{86}$/)
      .refine(
        (value) =>
          Buffer.from(value, 'base64url').toString('base64url') === value,
      ),
  })
  .strict();
export const recipientCandidateInput = z
  .object({
    operationId: enrollmentOperationId,
    proposedSourceOrigin: analyticsOriginSchema,
    sourceIntent: enrollmentIntentSchema.refine(
      (value) => value.phase === 'prepared',
    ),
  })
  .strict();

export function analyticsIntentDigest(
  intent: AnalyticsSourceEnrollmentIntent,
): string {
  return createHash('sha256')
    .update(JSON.stringify(enrollmentIntentSchema.parse(intent)))
    .digest('hex');
}
function bytes(claims: z.infer<typeof claimsSchema>) {
  return Buffer.from(
    `${ANALYTICS_RECIPIENT_CANDIDATE_PROTOCOL}\n${JSON.stringify(claimsSchema.parse(claims))}`,
  );
}
export function signRecipientCandidate(
  claims: z.infer<typeof claimsSchema>,
  key: KeyObject,
): AnalyticsRecipientCandidate {
  const parsed = claimsSchema.parse(claims);
  return {
    claims: parsed,
    signature: sign(null, bytes(parsed), key).toString('base64url'),
  };
}
/** Signature integrity only. The result remains an unapproved key candidate. */
export function verifyRecipientCandidateSignature(
  value: unknown,
): AnalyticsRecipientCandidate {
  try {
    const candidate = recipientCandidateSchema.parse(value);
    const key = createPublicKey({
      key: candidate.claims.proofKey,
      format: 'jwk',
    });
    if (
      !verify(
        null,
        bytes(candidate.claims),
        key,
        Buffer.from(candidate.signature, 'base64url'),
      )
    )
      throw new Error('Invalid signature');
    return candidate;
  } catch {
    throw new Error('Analytics recipient candidate is invalid');
  }
}
export function recipientConfirmationCode(
  value: AnalyticsRecipientCandidate,
): string {
  const code = createHash('sha256')
    .update(bytes(value.claims))
    .digest('hex')
    .slice(0, 12)
    .toUpperCase();
  return [code.slice(0, 4), code.slice(4, 8), code.slice(8)].join('-');
}
