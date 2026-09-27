import { createDecipheriv } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  NATIVE_PUSH_ALERT_SEALED_TEST_VECTOR as ALERT_VECTOR,
  NATIVE_PUSH_ALERT_SEALED_AAD_PREFIX,
  NATIVE_PUSH_NOTIFICATION_AAD_PREFIX,
  NATIVE_PUSH_SEALED_AAD_PREFIX,
  NATIVE_PUSH_NOTIFICATION_TEST_VECTOR as NOTIFICATION_VECTOR,
  NATIVE_PUSH_SEALED_TEST_VECTOR as VECTOR,
} from '@kontourai/station-contracts/native-push';
import { describe, expect, test } from 'vitest';
import {
  sealAgentActivityCard,
  sealApnsAlert,
  sealStationNotification,
} from '../agent-activity-seal.js';
import { composeApnsAlertPlaintext } from '../delivery/apns-alert-channel.js';

/** An independent opener, as the phone implements it. */
function open(
  sealed: string,
  payloadKey: string,
  registrationId: string,
  aadPrefix = NATIVE_PUSH_SEALED_AAD_PREFIX,
) {
  const bytes = Buffer.from(sealed, 'base64url');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    Buffer.from(payloadKey, 'base64url'),
    bytes.subarray(0, 12),
  );
  decipher.setAAD(Buffer.from(`${aadPrefix}${registrationId}`, 'utf8'));
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

/** The phone's copy of a vector, as its Kotlin test spells it. */
function kotlinTest(name: string) {
  return readFileSync(
    new URL(
      `../../../../src-desktop/plugins/agent-activity/android/src/test/java/io/kontourai/station/agentactivity/${name}`,
      import.meta.url,
    ),
    'utf8',
  );
}

describe('sealStationNotification (#2588)', () => {
  test('produces exactly the published known-answer vector', () => {
    expect(
      sealStationNotification({
        plaintext: NOTIFICATION_VECTOR.plaintext,
        payloadKey: NOTIFICATION_VECTOR.payloadKey,
        registrationId: NOTIFICATION_VECTOR.registrationId,
        nonce: Buffer.from(NOTIFICATION_VECTOR.nonce, 'base64url'),
      }),
    ).toBe(NOTIFICATION_VECTOR.sealed);
    const parsed = JSON.parse(NOTIFICATION_VECTOR.plaintext) as Record<
      string,
      unknown
    >;
    expect(Object.values(parsed).every((v) => typeof v === 'string')).toBe(
      true,
    );
  });

  test('a notification never opens as a card, nor a card as a notification', () => {
    const input = {
      plaintext: '{"v":"1"}',
      payloadKey: VECTOR.payloadKey,
      registrationId: VECTOR.registrationId,
    };
    const notification = sealStationNotification(input);
    expect(
      open(
        notification,
        VECTOR.payloadKey,
        VECTOR.registrationId,
        NATIVE_PUSH_NOTIFICATION_AAD_PREFIX,
      ),
    ).toBe(input.plaintext);
    expect(() =>
      open(notification, VECTOR.payloadKey, VECTOR.registrationId),
    ).toThrow();
    expect(() =>
      open(
        sealAgentActivityCard(input),
        VECTOR.payloadKey,
        VECTOR.registrationId,
        NATIVE_PUSH_NOTIFICATION_AAD_PREFIX,
      ),
    ).toThrow();
  });

  // As for the card: the Kotlin test cannot import TypeScript, so this pins
  // its copy (StationNotificationsTest.opensTheStationsNotificationVector)
  // to the contract's.
  test("is the vector the phone's Kotlin test opens", () => {
    const kotlin = kotlinTest('StationNotificationsTest.kt');
    const literal = (pattern: RegExp) => {
      const match = pattern.exec(kotlin);
      if (!match?.[1])
        throw new Error(`StationNotificationsTest.kt: no ${pattern}`);
      return match[1];
    };
    const sealedPieces = literal(
      /val stationSealed =\s*((?:"[^"]*"\s*\+?\s*)+)/,
    )
      .match(/"([^"]*)"/g)
      ?.map((piece) => piece.slice(1, -1));
    expect(sealedPieces?.join('')).toBe(NOTIFICATION_VECTOR.sealed);
    expect(literal(/val payloadKey = "([^"]*)"/)).toBe(
      NOTIFICATION_VECTOR.payloadKey,
    );
    expect(literal(/val registrationId = "([^"]*)"/)).toBe(
      NOTIFICATION_VECTOR.registrationId,
    );
    // And the phone binds the same AAD prefix the Station seals under.
    expect(
      /const val NOTIFICATION_AAD_PREFIX = "([^"]*)"/.exec(
        readFileSync(
          new URL(
            '../../../../src-desktop/plugins/agent-activity/android/src/main/java/io/kontourai/station/agentactivity/StationNotifications.kt',
            import.meta.url,
          ),
          'utf8',
        ),
      )?.[1],
    ).toBe(NATIVE_PUSH_NOTIFICATION_AAD_PREFIX);
  });
});

describe('the sealed iOS alert (#2590)', () => {
  test('produces exactly the published alert known-answer vector', () => {
    expect(
      sealApnsAlert({
        plaintext: ALERT_VECTOR.plaintext,
        payloadKey: ALERT_VECTOR.payloadKey,
        registrationId: ALERT_VECTOR.registrationId,
        nonce: Buffer.from(ALERT_VECTOR.nonce, 'base64url'),
      }),
    ).toBe(ALERT_VECTOR.sealed);
    expect(
      open(
        ALERT_VECTOR.sealed,
        ALERT_VECTOR.payloadKey,
        ALERT_VECTOR.registrationId,
        NATIVE_PUSH_ALERT_SEALED_AAD_PREFIX,
      ),
    ).toBe(ALERT_VECTOR.plaintext);
    // The alert domain is what separates it from a card under the same key.
    expect(() =>
      open(
        ALERT_VECTOR.sealed,
        ALERT_VECTOR.payloadKey,
        ALERT_VECTOR.registrationId,
      ),
    ).toThrow();
  });

  test("the vector's plaintext is exactly what the alert composer writes", () => {
    expect(
      composeApnsAlertPlaintext({
        stationId: '11111111-1111-4111-8111-111111111111',
        notification: {
          id: 'notif-0001',
          title: 'Approval needed',
          body: 'Fix the flaky login test · Login App',
        },
        urgency: 'attention',
        hideContent: false,
        now: 1_800_000_000_000,
      }),
    ).toBe(ALERT_VECTOR.plaintext);
  });

  // The Swift host tests do not run in CI, and cannot import TypeScript, so
  // the extension's opener test carries its own copy of the vector; this
  // pins that copy to the contract's.
  test("is the vector the Notification Service Extension's Swift test opens", () => {
    const swift = readFileSync(
      new URL(
        '../../../../src-desktop/plugins/agent-activity/ios/Tests/StationNotificationServiceCoreTests/SealedAlertTests.swift',
        import.meta.url,
      ),
      'utf8',
    );
    const literal = (name: string) => {
      const match = new RegExp(
        `static let ${name} =\\s*(?:"([^"]*)"|#"(.*)"#)`,
      ).exec(swift);
      const value = match?.[1] ?? match?.[2];
      if (value === undefined)
        throw new Error(`SealedAlertTests.swift: no ${name}`);
      return value;
    };
    expect(literal('payloadKey')).toBe(ALERT_VECTOR.payloadKey);
    expect(literal('registrationId')).toBe(ALERT_VECTOR.registrationId);
    expect(literal('nonce')).toBe(ALERT_VECTOR.nonce);
    expect(literal('plaintext')).toBe(ALERT_VECTOR.plaintext);
    expect(literal('sealed')).toBe(ALERT_VECTOR.sealed);
  });
});
