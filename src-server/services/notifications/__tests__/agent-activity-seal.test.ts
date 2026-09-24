import { createDecipheriv } from 'node:crypto';
import {
  NATIVE_PUSH_SEALED_AAD_PREFIX,
  NATIVE_PUSH_SEALED_TEST_VECTOR as VECTOR,
} from '@kontourai/station-contracts/native-push';
import { describe, expect, test } from 'vitest';
import { sealAgentActivityCard } from '../agent-activity-seal.js';

/** An independent opener, as the phone implements it. */
function open(sealed: string, payloadKey: string, registrationId: string) {
  const bytes = Buffer.from(sealed, 'base64url');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    Buffer.from(payloadKey, 'base64url'),
    bytes.subarray(0, 12),
  );
  decipher.setAAD(
    Buffer.from(`${NATIVE_PUSH_SEALED_AAD_PREFIX}${registrationId}`, 'utf8'),
  );
  decipher.setAuthTag(bytes.subarray(bytes.length - 16));
  return Buffer.concat([
    decipher.update(bytes.subarray(12, bytes.length - 16)),
    decipher.final(),
  ]).toString('utf8');
}

describe('sealAgentActivityCard', () => {
  test('produces exactly the published known-answer vector', () => {
    expect(
      sealAgentActivityCard({
        plaintext: VECTOR.plaintext,
        payloadKey: VECTOR.payloadKey,
        registrationId: VECTOR.registrationId,
        nonce: Buffer.from(VECTOR.nonce, 'base64url'),
      }),
    ).toBe(VECTOR.sealed);
    // The vector's plaintext is a JSON object of strings, as the phone reads it.
    const parsed = JSON.parse(VECTOR.plaintext) as Record<string, unknown>;
    expect(Object.values(parsed).every((v) => typeof v === 'string')).toBe(
      true,
    );
    expect(parsed.activity_line_0).toBe(
      'Approval\tFix the flaky login test\tLogin App',
    );
  });

  test('uses a fresh nonce each time, and opens only for its own registration', () => {
    const input = {
      plaintext: VECTOR.plaintext,
      payloadKey: VECTOR.payloadKey,
      registrationId: VECTOR.registrationId,
    };
    const a = sealAgentActivityCard(input);
    const b = sealAgentActivityCard(input);
    expect(a).not.toBe(b);
    expect(open(a, VECTOR.payloadKey, VECTOR.registrationId)).toBe(
      VECTOR.plaintext,
    );
    expect(() =>
      open(a, VECTOR.payloadKey, 'another-registration-id'),
    ).toThrow();
    const tampered = Buffer.from(a, 'base64url');
    tampered[20] = (tampered[20] ?? 0) ^ 1;
    expect(() =>
      open(
        tampered.toString('base64url'),
        VECTOR.payloadKey,
        VECTOR.registrationId,
      ),
    ).toThrow();
  });

  test('refuses a key that is not 32 bytes', () => {
    expect(() =>
      sealAgentActivityCard({
        plaintext: '{}',
        payloadKey: Buffer.alloc(16).toString('base64url'),
        registrationId: 'r',
      }),
    ).toThrow('invalid payload key');
  });
});
