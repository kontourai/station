import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { z } from 'zod/v3';
import { recipientProofKeySchema } from './recipient-candidate.js';
import {
  type SourceCredentialPayload,
  sourceCredentialHash,
} from './source-credential.js';
import {
  enrollmentIdentity,
  enrollmentOperationId,
} from './source-enrollment-protocol.js';

const DOMAIN = 'station-analytics-delivery-proof/v1';
const claimsSchema = z
  .object({
    protocol: z.literal(DOMAIN),
    sourceApprovalId: enrollmentOperationId,
    sourceStationId: enrollmentIdentity,
    recipientId: enrollmentOperationId,
    recipientBindingSha256: z.string().regex(/^[a-f0-9]{64}$/),
    revision: z.number().int().positive().refine(Number.isSafeInteger),
    credentialSha256: z.string().regex(/^[a-f0-9]{64}$/),
    expiresAt: z.string().datetime(),
  })
  .strict();
export const sourceDeliveryProofSchema = z
  .object({
    claims: claimsSchema,
    signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
  })
  .strict();
const bytes = (claims: z.infer<typeof claimsSchema>) =>
  Buffer.from(`${DOMAIN}\n${JSON.stringify(claimsSchema.parse(claims))}`);
/** Confirms receiving proof-key and decrypted credential possession; not a fresh per-request signature. */
export function createSourceDeliveryProof(
  value: SourceCredentialPayload,
  privateKey: string,
) {
  const claims = claimsSchema.parse({
    protocol: DOMAIN,
    sourceApprovalId: value.sourceApprovalId,
    sourceStationId: value.sourceStationId,
    recipientId: value.recipientId,
    recipientBindingSha256: value.recipientBindingSha256,
    revision: value.revision,
    credentialSha256: sourceCredentialHash(value.credential),
    expiresAt: value.expiresAt,
  });
  return {
    claims,
    signature: sign(null, bytes(claims), createPrivateKey(privateKey)).toString(
      'base64url',
    ),
  };
}
export function verifySourceDeliveryProof(
  value: unknown,
  publicKey: z.infer<typeof recipientProofKeySchema>,
) {
  try {
    const proof = sourceDeliveryProofSchema.parse(value);
    if (
      !verify(
        null,
        bytes(proof.claims),
        createPublicKey({
          key: recipientProofKeySchema.parse(publicKey),
          format: 'jwk',
        }),
        Buffer.from(proof.signature, 'base64url'),
      )
    )
      throw new Error('Invalid proof');
    return proof.claims;
  } catch {
    throw new Error('Source delivery proof is invalid');
  }
}
