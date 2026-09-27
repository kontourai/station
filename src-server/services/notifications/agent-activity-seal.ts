/**
 * Seals a payload to one registered phone: AES-256-GCM under that
 * registration's own payload key, a fresh 12-byte random nonce, a 128-bit
 * tag, and the registrationId bound in as additional authenticated data
 * after a per-kind prefix. The push gateway and FCM/APNs carry only the
 * result and routing data. Format: `@kontourai/station-contracts/native-push`
 * — the agent-activity card (`NATIVE_PUSH_SEALED_AAD_PREFIX`,
 * `NATIVE_PUSH_SEALED_TEST_VECTOR`), an Android Station notification
 * (`NATIVE_PUSH_NOTIFICATION_AAD_PREFIX`,
 * `NATIVE_PUSH_NOTIFICATION_TEST_VECTOR`) and an iOS notification alert
 * (`NATIVE_PUSH_ALERT_SEALED_AAD_PREFIX`). The prefix keeps one kind from
 * opening as another.
 */
import { createCipheriv, randomBytes } from 'node:crypto';
import {
  NATIVE_PUSH_ALERT_SEALED_AAD_PREFIX,
  NATIVE_PUSH_NOTIFICATION_AAD_PREFIX,
  NATIVE_PUSH_SEALED_AAD_PREFIX,
} from '@kontourai/station-contracts/native-push';

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

interface SealInput {
  /** One JSON object of strings. */
  plaintext: string;
  payloadKey: string;
  registrationId: string;
  /** Tests only: a fixed nonce for the known-answer vector. */
  nonce?: Buffer;
}

function seal(aadPrefix: string, input: SealInput): string {
  const key = Buffer.from(input.payloadKey, 'base64url');
  if (key.length !== KEY_BYTES) throw new Error('invalid payload key');
  const nonce = input.nonce ?? randomBytes(NONCE_BYTES);
  if (nonce.length !== NONCE_BYTES) throw new Error('invalid nonce');
  const cipher = createCipheriv('aes-256-gcm', key, nonce, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(Buffer.from(`${aadPrefix}${input.registrationId}`, 'utf8'));
  const ciphertext = Buffer.concat([
    cipher.update(input.plaintext, 'utf8'),
    cipher.final(),
  ]);
  return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString(
    'base64url',
  );
}

export function sealAgentActivityCard(input: SealInput): string {
  return seal(NATIVE_PUSH_SEALED_AAD_PREFIX, input);
}

/** Android (#2588): a Station notification delivered over FCM. */
export function sealStationNotification(input: SealInput): string {
  return seal(NATIVE_PUSH_NOTIFICATION_AAD_PREFIX, input);
}

/** iOS (#2589): a notification alert delivered over APNs. */
export function sealApnsAlert(input: SealInput): string {
  return seal(NATIVE_PUSH_ALERT_SEALED_AAD_PREFIX, input);
}
