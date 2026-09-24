/**
 * Seals an agent-activity card to one registered phone: AES-256-GCM under
 * that registration's own payload key, a fresh 12-byte random nonce, a
 * 128-bit tag, and the registrationId bound in as additional authenticated
 * data. The push gateway and FCM carry only the result and routing data.
 * Format: `@kontourai/station-contracts/native-push`
 * (`NATIVE_PUSH_SEALED_AAD_PREFIX`, `NATIVE_PUSH_SEALED_TEST_VECTOR`).
 */
import { createCipheriv, randomBytes } from 'node:crypto';
import { NATIVE_PUSH_SEALED_AAD_PREFIX } from '@kontourai/station-contracts/native-push';

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
/** nonce + tag: what sealing adds to the plaintext before base64url. */
export const SEAL_OVERHEAD_BYTES = NONCE_BYTES + TAG_BYTES;

export function sealAgentActivityCard(input: {
  /** The card fields, serialized as one JSON object of strings. */
  plaintext: string;
  payloadKey: string;
  registrationId: string;
  /** Tests only: a fixed nonce for the known-answer vector. */
  nonce?: Buffer;
}): string {
  const key = Buffer.from(input.payloadKey, 'base64url');
  if (key.length !== KEY_BYTES) throw new Error('invalid payload key');
  const nonce = input.nonce ?? randomBytes(NONCE_BYTES);
  if (nonce.length !== NONCE_BYTES) throw new Error('invalid nonce');
  const cipher = createCipheriv('aes-256-gcm', key, nonce, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(
    Buffer.from(
      `${NATIVE_PUSH_SEALED_AAD_PREFIX}${input.registrationId}`,
      'utf8',
    ),
  );
  const ciphertext = Buffer.concat([
    cipher.update(input.plaintext, 'utf8'),
    cipher.final(),
  ]);
  return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString(
    'base64url',
  );
}
