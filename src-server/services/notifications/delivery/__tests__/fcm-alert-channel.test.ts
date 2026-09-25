/**
 * #2588: the router → FcmAlertChannel path through the PRODUCTION wiring
 * (`wireNotificationDelivery`): a real pairing registry, push key and
 * native push registration on a temp home, a real EventBus, and a fake
 * gateway `fetch` that runs the REAL gateway verifier and request parser and
 * then opens the sealed notification the way the phone does. A message the
 * deployed gateway would refuse, or the phone could not open, fails here.
 */
import { createDecipheriv } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NATIVE_PUSH_NOTIFICATION_AAD_PREFIX } from '@kontourai/station-contracts/native-push';
import type {
  Notification,
  NotificationEnvelopeV1,
} from '@kontourai/station-contracts/notification';
import { defaultNotificationPreferences } from '@kontourai/station-contracts/notification-preferences';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { describe, expect, test, vi } from 'vitest';
import { parseSendRequest } from '../../../../../deploy/push-gateway/src/send-request.js';
import { verifyStationRequest } from '../../../../../deploy/push-gateway/src/station-auth.js';
import { trackTempDirs } from '../../../../__test-utils__/temp-dirs.js';
import { wireNotificationDelivery } from '../../../../runtime/routes/notification-delivery-wiring.js';
import { EventBus } from '../../../orchestration/event-bus.js';
import { DevicePairingService } from '../../../ssh/device-pairing-service.js';
import { resolvePushGatewayConfig } from '../../agent-activity-publisher.js';
import type { NativePushRegistration } from '../../native-push-registration-store.js';
import {
  createNativePushSendFloor,
  NATIVE_PUSH_MIN_SEND_INTERVAL_MS,
} from '../../native-push-send-floor.js';
import { NOTIFICATION_PREFERENCES_FILE } from '../../notification-preferences.js';
import { PushSigningKeyStore } from '../../push-signing-key-store.js';
import { FCM_ALERT_LIFETIME_MS } from '../fcm-alert-channel.js';

const makeTempDir = trackTempDirs();
const ENVIRONMENT_ID = '11111111-1111-4111-8111-111111111111';
const GATEWAY = resolvePushGatewayConfig({})!;
const PACKAGES = ['io.kontourai.station'];
const NOW = Date.parse('2026-09-24T12:00:00.000Z');

interface Sent {
  deviceId: string;
  collapseKey?: string;
  priority?: string;
  data: Record<string, string>;
  plaintext: Record<string, string>;
}

function envelope(
  overrides: Partial<NotificationEnvelopeV1> = {},
): NotificationEnvelopeV1 {
  return {
    v: 1,
    source: { kind: 'agent', sessionId: 'session-1', assurance: 'bound' },
    audience: { kind: 'session-readers', sessionId: 'session-1' },
    urgency: 'attention',
    interrupt: 'default',
    ...overrides,
  };
}

function notification(overrides: Partial<Notification> = {}): Notification {
  return {
    id: '5b0c9a4e-6f1d-4f7a-9b43-0c1e2d3f4a5b',
    source: 'agent',
    category: 'agent-attention',
    title: 'Need approval to run the migration',
    body: 'SECRET_BODY_TEXT in /Users/someone/private-repo',
    priority: 'high',
    status: 'delivered',
    scheduledAt: null,
    deliveredAt: new Date(NOW).toISOString(),
    metadata: { envelope: envelope(), projectSlug: 'login-app' },
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

async function harness(
  options: {
    answer?: number;
    canRead?: (sessionId: string) => boolean;
    hideContentOn?: 'first-phone';
  } = {},
) {
  const homeDir = makeTempDir('station-fcm-alert-');
  mkdirSync(join(homeDir, 'security'), { recursive: true, mode: 0o700 });
  const pairing = new DevicePairingService({
    homeDir,
    environmentId: ENVIRONMENT_ID,
  });
  const keys = new PushSigningKeyStore(homeDir, () => pairing.environmentId());
  const eventBus = new EventBus();
  const clock = { now: NOW };
  const sent: Sent[] = [];
  const refused: string[] = [];
  const registrations = new Map<string, NativePushRegistration>();
  const sleeps: number[] = [];
  /** Every gateway request, so `settle` waits for the real work, not ticks. */
  const inFlight: Promise<unknown>[] = [];
  const answer = async (url: string, init: RequestInit) => {
    expect(url).toBe('https://push.kontourai.io/v1/fcm/send');
    expect(init.redirect).toBe('error');
    const body = new Uint8Array(init.body as Buffer) as Uint8Array<ArrayBuffer>;
    const auth = await verifyStationRequest({
      authorization: new Headers(init.headers).get('authorization'),
      body,
      audiences: ['https://push.kontourai.io'],
      nowSeconds: Math.floor(clock.now / 1000),
    });
    if (!auth.ok) {
      refused.push(auth.reason);
      return new Response('{}', { status: 401 });
    }
    const parsed = parseSendRequest(body, PACKAGES);
    if (!parsed.ok) {
      refused.push(parsed.reason);
      return new Response('{}', { status: 400 });
    }
    const { data, collapseKey, priority } = parsed.request;
    const [deviceId, registration] = [...registrations].find(
      ([, candidate]) => candidate.registrationId === data.device_id,
    ) ?? [undefined, undefined];
    if (!deviceId || !registration) throw new Error('unknown registration');
    sent.push({
      deviceId,
      ...(collapseKey ? { collapseKey } : {}),
      ...(priority ? { priority } : {}),
      data,
      plaintext: open(data.sealed ?? '', registration),
    });
    return new Response('{}', { status: options.answer ?? 200 });
  };
  const fetchImpl = vi.fn((url: string, init: RequestInit) => {
    const response = answer(url, init);
    inFlight.push(response);
    return response;
  });
  const warn = vi.fn();
  async function pairAndRegister(name: string) {
    const offer = pairing.createOffer({
      endpoint: 'https://station.example.test',
    });
    const request = pairing.requestPairing({
      requesterPosition: 'off-box',
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: name,
    });
    pairing.confirmRequest(request.requestId, {
      kind: 'presented-credential',
    });
    const paired = pairing.exchange({
      offerId: offer.offerId,
      proof: offer.challenge,
      requestId: request.requestId,
    });
    const key = await keys.loadOrCreate();
    const registration = pairing.setNativePush(
      paired.device.id,
      {
        token: `fcm-token-${name}-${'a'.repeat(40)}`,
        packageName: 'io.kontourai.station',
        platform: 'android',
      },
      key.thumbprint,
    );
    registrations.set(paired.device.id, registration);
    return paired.device.id;
  }
  const phone = await pairAndRegister('pixel');
  const tablet = await pairAndRegister('tablet');
  if (options.hideContentOn === 'first-phone') {
    const preferences = defaultNotificationPreferences();
    preferences.perSurface[`device:${phone}`] = {
      minUrgency: 'info',
      hideContent: true,
    };
    writeFileSync(
      join(homeDir, NOTIFICATION_PREFERENCES_FILE),
      JSON.stringify(preferences),
      { mode: 0o600 },
    );
  }
  const sendFloor = createNativePushSendFloor();
  const wiring = wireNotificationDelivery({
    enabled: true,
    homeDir,
    eventBus,
    logger: { warn },
    devicePairing: pairing,
    webPushService: { send: vi.fn().mockResolvedValue('sent') },
    canUserReadSession: (sessionId) => options.canRead?.(sessionId) ?? true,
    listNotifications: async () => [],
    fcmAlert: {
      devicePairing: pairing,
      signingKey: keys,
      gateway: GATEWAY,
      sendFloor,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => clock.now,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock.now += ms;
      },
    },
  });
  return {
    pairing,
    eventBus,
    clock,
    sent,
    refused,
    warn,
    sleeps,
    sendFloor,
    phone,
    tablet,
    wiring,
    fetchImpl,
    /**
     * Until every gateway request (including any a floor wait started late)
     * has answered and the channel has handled the answer. The gateway
     * verifier runs on WebCrypto, so a fixed number of ticks is not enough
     * on a loaded host.
     */
    async settle() {
      let seen = -1;
      while (seen !== inFlight.length) {
        seen = inFlight.length;
        await Promise.allSettled(inFlight);
        for (let i = 0; i < 10; i += 1)
          await new Promise((resolve) => setImmediate(resolve));
      }
    },
  };
}

/** Opens a sealed notification as the phone does. */
function open(sealed: string, registration: NativePushRegistration) {
  const bytes = Buffer.from(sealed, 'base64url');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    Buffer.from(registration.payloadKey, 'base64url'),
    bytes.subarray(0, 12),
  );
  decipher.setAAD(
    Buffer.from(
      `${NATIVE_PUSH_NOTIFICATION_AAD_PREFIX}${registration.registrationId}`,
      'utf8',
    ),
  );
  decipher.setAuthTag(bytes.subarray(bytes.length - 16));
  return JSON.parse(
    Buffer.concat([
      decipher.update(bytes.subarray(12, bytes.length - 16)),
      decipher.final(),
    ]).toString('utf8'),
  ) as Record<string, string>;
}

describe('FcmAlertChannel through the delivery router', () => {
  test('an attention notification reaches each registered phone sealed, high priority, with no collapse key', async () => {
    const h = await harness();
    const record = notification();
    h.eventBus.emit(SERVER_EVENTS.NOTIFICATION_DELIVERED, record as never);
    await h.settle();
    expect(h.refused).toEqual([]);
    expect(h.sent.map((s) => s.deviceId).sort()).toEqual(
      [h.phone, h.tablet].sort(),
    );
    const toPhone = h.sent.find((s) => s.deviceId === h.phone)!;
    expect(toPhone.data.station_kind).toBe('station_notification');
    expect(Object.keys(toPhone.data).sort()).toEqual([
      'device_id',
      'sealed',
      'station_kind',
    ]);
    expect(toPhone.priority).toBeUndefined();
    // Non-collapsible: FCM keeps only four collapse keys per offline device.
    expect(toPhone.collapseKey).toBeUndefined();
    expect(toPhone.plaintext).toEqual({
      v: '1',
      user_id: ENVIRONMENT_ID,
      id: record.id,
      kind: 'alert',
      title: record.title,
      body: record.body,
      urgency: 'attention',
      session_id: 'session-1',
      project_slug: 'login-app',
      created_at: String(toPhone.plaintext.created_at),
      expires_at: String(
        Number(toPhone.plaintext.created_at) + FCM_ALERT_LIFETIME_MS,
      ),
    });
    // Nothing readable travels outside the seal.
    expect(JSON.stringify(toPhone.data)).not.toContain('SECRET_BODY_TEXT');
    expect(JSON.stringify(toPhone.data)).not.toContain('migration');
  });

  test('a phone that asked to hide content is never sent the text', async () => {
    const h = await harness({ hideContentOn: 'first-phone' });
    h.eventBus.emit(
      SERVER_EVENTS.NOTIFICATION_DELIVERED,
      notification() as never,
    );
    await h.settle();
    const hidden = h.sent.find((s) => s.deviceId === h.phone)!;
    expect(hidden.plaintext.title).toBe('Station');
    expect(hidden.plaintext.body).toBe('You have a new notification');
    expect(JSON.stringify(hidden.plaintext)).not.toContain('SECRET_BODY_TEXT');
    expect(JSON.stringify(hidden.plaintext)).not.toContain('migration');
    // The other phone did not ask.
    const shown = h.sent.find((s) => s.deviceId === h.tablet)!;
    expect(shown.plaintext.title).toBe('Need approval to run the migration');
  });

  test('read or dismissed elsewhere: each phone that was sent it gets a retract for the same id', async () => {
    for (const settle of ['read', 'dismissed'] as const) {
      const h = await harness();
      const record = notification();
      h.eventBus.emit(SERVER_EVENTS.NOTIFICATION_DELIVERED, record as never);
      await h.settle();
      h.clock.now += 10_000;
      const settled: Notification =
        settle === 'read'
          ? {
              ...record,
              metadata: {
                ...record.metadata,
                envelope: {
                  ...envelope(),
                  readAt: new Date(h.clock.now).toISOString(),
                  readBy: 'local:desk-tab',
                },
              },
            }
          : { ...record, status: 'dismissed' };
      h.eventBus.emit(
        settle === 'read'
          ? SERVER_EVENTS.NOTIFICATION_UPDATED
          : SERVER_EVENTS.NOTIFICATION_DISMISSED,
        settled as never,
      );
      await h.settle();
      const retracts = h.sent.filter((s) => s.plaintext.kind === 'retract');
      expect(retracts.map((s) => s.deviceId).sort(), settle).toEqual(
        [h.phone, h.tablet].sort(),
      );
      for (const retract of retracts) {
        expect(retract.plaintext).toEqual({
          v: '1',
          user_id: ENVIRONMENT_ID,
          id: record.id,
          kind: 'retract',
          created_at: String(h.clock.now),
          expires_at: String(h.clock.now + FCM_ALERT_LIFETIME_MS),
        });
        expect(retract.collapseKey).toBeUndefined();
        expect(retract.priority).toBe('normal');
      }
    }
  });

  test('info and done go at normal priority; failed at high', async () => {
    const h = await harness();
    for (const [urgency, category] of [
      ['info', 'agent-info'],
      ['done', 'agent-done'],
      ['failed', 'agent-failed'],
    ] as const) {
      h.eventBus.emit(
        SERVER_EVENTS.NOTIFICATION_DELIVERED,
        notification({
          id: `n-${urgency}`,
          category,
          metadata: { envelope: envelope({ urgency }) },
        }) as never,
      );
      await h.settle();
    }
    const priorityOf = (id: string) =>
      h.sent.find((s) => s.deviceId === h.phone && s.plaintext.id === id)
        ?.priority;
    expect(priorityOf('n-info')).toBe('normal');
    expect(priorityOf('n-done')).toBe('normal');
    expect(priorityOf('n-failed')).toBeUndefined();
  });

  test('a phone that cannot read the named session gets nothing', async () => {
    const h = await harness({
      canRead: (sessionId) => sessionId !== 'session-1',
    });
    h.eventBus.emit(
      SERVER_EVENTS.NOTIFICATION_DELIVERED,
      notification() as never,
    );
    await h.settle();
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  test('session lifecycle categories the card already alerts for are not carried; other legacy alerts are', async () => {
    const h = await harness();
    const legacy = (id: string, category: string) =>
      notification({
        id,
        category,
        source: 'approval-inbox',
        metadata: { sessionId: 'session-1' },
      });
    for (const category of [
      'approval-request',
      'turn-completed',
      'turn-stopped',
      'turn-failed',
    ])
      h.eventBus.emit(
        SERVER_EVENTS.NOTIFICATION_DELIVERED,
        legacy(`n-${category}`, category) as never,
      );
    await h.settle();
    expect(h.fetchImpl).not.toHaveBeenCalled();
    h.eventBus.emit(
      SERVER_EVENTS.NOTIFICATION_DELIVERED,
      legacy('n-pairing', 'pairing-request') as never,
    );
    await h.settle();
    expect(new Set(h.sent.map((s) => s.plaintext.id))).toEqual(
      new Set(['n-pairing']),
    );
  });

  test('a send inside the per-phone floor waits for its slot instead of being dropped', async () => {
    const h = await harness();
    // The agent-activity card just went to the phone, one second ago.
    h.sendFloor.record(h.phone, h.clock.now - 1_000);
    h.eventBus.emit(
      SERVER_EVENTS.NOTIFICATION_DELIVERED,
      notification() as never,
    );
    await h.settle();
    expect(h.sleeps).toContain(NATIVE_PUSH_MIN_SEND_INTERVAL_MS - 1_000);
    expect(h.sent.map((s) => s.deviceId)).toContain(h.phone);
    // The slot it used is the phone's latest: the next card waits for it.
    expect(h.sendFloor.lastSendAt(h.phone)).toBe(
      NOW - 1_000 + NATIVE_PUSH_MIN_SEND_INTERVAL_MS,
    );
  });

  test('a 410 clears that registration', async () => {
    const h = await harness({ answer: 410 });
    h.eventBus.emit(
      SERVER_EVENTS.NOTIFICATION_DELIVERED,
      notification() as never,
    );
    await h.settle();
    expect(h.pairing.listNativePushRegistrations()).toEqual([]);
  });
});
