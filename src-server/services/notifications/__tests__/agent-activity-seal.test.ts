import { createDecipheriv } from 'node:crypto';
import { readFileSync } from 'node:fs';
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

  // The phone's Kotlin test (AgentSealTest.opensTheStationsKnownAnswerVector)
  // carries its own copy of this vector, because the Gradle test cannot import
  // TypeScript. CI runs that test (desktop-rust.yml, #2516), but it only proves
  // the phone opens ITS copy; this pins the copy to the Station's, so changing
  // either side without the other fails here.
  test("is the vector the phone's Kotlin test opens", () => {
    const kotlin = readFileSync(
      new URL(
        '../../../../src-desktop/plugins/agent-activity/android/src/test/java/io/kontourai/station/agentactivity/AgentSealTest.kt',
        import.meta.url,
      ),
      'utf8',
    );
    const literal = (pattern: RegExp) => {
      const match = pattern.exec(kotlin);
      if (!match?.[1]) throw new Error(`AgentSealTest.kt: no ${pattern}`);
      return match[1];
    };
    const sealedPieces = literal(
      /val stationSealed =\s*((?:"[^"]*"\s*\+?\s*)+)/,
    )
      .match(/"([^"]*)"/g)
      ?.map((piece) => piece.slice(1, -1));
    expect(sealedPieces?.join('')).toBe(VECTOR.sealed);
    expect(literal(/val payloadKey = "([^"]*)"/)).toBe(VECTOR.payloadKey);
    expect(literal(/unseal\(payloadKey, "([^"]*)", stationSealed\)/)).toBe(
      VECTOR.registrationId,
    );
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
