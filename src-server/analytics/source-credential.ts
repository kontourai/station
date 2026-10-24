import { createHash, createPrivateKey } from 'node:crypto';
import type { AnalyticsSourceCredentialDelivery } from '@kontourai/station-contracts/usage-export';
import { CompactEncrypt, compactDecrypt, importJWK } from 'jose';
import { z } from 'zod/v3';
import { recipientEncryptionKeySchema } from './recipient-candidate.js';
import {
  enrollmentIdentity,
  enrollmentIntentSchema,
  enrollmentOperationId,
} from './source-enrollment-protocol.js';

export const sourceCredentialPayloadSchema = z
  .object({
    protocol: z.literal('station-analytics-source-credential/v1'),
    profile: z.literal('canonical-usage-export/v1'),
    sourceApprovalId: enrollmentOperationId,
    sourceOperationId: enrollmentOperationId,
    sourceStationId: enrollmentIdentity,
    destinationStationId: enrollmentIdentity,
    sourceIntentSha256: z.string().regex(/^[a-f0-9]{64}$/),
    recipientId: enrollmentOperationId,
    recipientBindingSha256: z.string().regex(/^[a-f0-9]{64}$/),
    revision: z.number().int().positive().refine(Number.isSafeInteger),
    expiresAt: z.string().datetime(),
    scope: z.enum(['individual', 'personal-account']),
    retention: enrollmentIntentSchema.shape.retention,
    credential: z.string().regex(/^stax_[A-Za-z0-9_-]{43}$/),
  })
  .strict();
export type SourceCredentialPayload = z.infer<
  typeof sourceCredentialPayloadSchema
>;
export const sourceCredentialDeliverySchema = sourceCredentialPayloadSchema
  .pick({
    sourceApprovalId: true,
    sourceOperationId: true,
    sourceStationId: true,
    destinationStationId: true,
    recipientId: true,
    revision: true,
    expiresAt: true,
  })
  .extend({
    protocol: z.literal('station-analytics-source-delivery/v1'),
    envelope: z
      .string()
      .min(1)
      .max(16 * 1024),
    exportAuthority: z.literal(false),
  })
  .strict();
const TYPE = 'station-analytics-source-credential+jwe';
const encoded = (value: string) =>
  Buffer.from(value, 'hex').toString('base64url');
export function sourceCredentialHash(credential: string): string {
  return createHash('sha256').update(credential).digest('hex');
}
export async function sealSourceCredential(
  payload: SourceCredentialPayload,
  publicKey: z.infer<typeof recipientEncryptionKeySchema>,
): Promise<AnalyticsSourceCredentialDelivery> {
  const value = sourceCredentialPayloadSchema.parse(payload);
  const envelope = await new CompactEncrypt(
    new TextEncoder().encode(JSON.stringify(value)),
  )
    .setProtectedHeader({
      alg: 'ECDH-ES',
      enc: 'A256GCM',
      typ: TYPE,
      kid: value.recipientId,
      apu: encoded(value.sourceIntentSha256),
      apv: encoded(value.recipientBindingSha256),
    })
    .encrypt(
      await importJWK(recipientEncryptionKeySchema.parse(publicKey), 'ECDH-ES'),
    );
  return {
    protocol: 'station-analytics-source-delivery/v1',
    sourceApprovalId: value.sourceApprovalId,
    sourceOperationId: value.sourceOperationId,
    sourceStationId: value.sourceStationId,
    destinationStationId: value.destinationStationId,
    recipientId: value.recipientId,
    revision: value.revision,
    expiresAt: value.expiresAt,
    envelope,
    exportAuthority: false,
  };
}
/** Decryption establishes recipient-key possession, not source identity or permission. */
export async function openSourceCredential(
  delivery: AnalyticsSourceCredentialDelivery,
  privateKey: string,
): Promise<SourceCredentialPayload> {
  try {
    const wire = sourceCredentialDeliverySchema.parse(delivery);
    const { plaintext, protectedHeader: header } = await compactDecrypt(
      wire.envelope,
      createPrivateKey(privateKey),
      {
        keyManagementAlgorithms: ['ECDH-ES'],
        contentEncryptionAlgorithms: ['A256GCM'],
      },
    );
    if (plaintext.length > 8192) throw new Error('Oversized credential');
    const value = sourceCredentialPayloadSchema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)),
    );
    if (
      header.typ !== TYPE ||
      header.kid !== value.recipientId ||
      header.apu !== encoded(value.sourceIntentSha256) ||
      header.apv !== encoded(value.recipientBindingSha256) ||
      value.sourceApprovalId !== wire.sourceApprovalId ||
      value.sourceOperationId !== wire.sourceOperationId ||
      value.sourceStationId !== wire.sourceStationId ||
      value.destinationStationId !== wire.destinationStationId ||
      value.recipientId !== wire.recipientId ||
      value.revision !== wire.revision ||
      value.expiresAt !== wire.expiresAt
    )
      throw new Error('Credential binding changed');
    return value;
  } catch {
    throw new Error('Source credential delivery is invalid');
  }
}
