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
import {
  resolvePushGatewayConfig,
  wireAgentActivityPublisher,
} from '../../agent-activity-publisher.js';
import type { NativePushRegistration } from '../../native-push-registration-store.js';
import {
  createNativePushSendFloor,
  NATIVE_PUSH_MIN_SEND_INTERVAL_MS,
} from '../../native-push-send-floor.js';
import { NOTIFICATION_PREFERENCES_FILE } from '../../notification-preferences.js';
import { PushSigningKeyStore } from '../../push-signing-key-store.js';
import {
  FCM_ALERT_LIFETIME_MS,
  FcmAlertChannel,
  type FcmAlertDevicePairing,
} from '../fcm-alert-channel.js';

const makeTempDir = trackTempDirs();
const ENVIRONMENT_ID = '11111111-1111-4111-8111-111111111111';
const GATEWAY = resolvePushGatewayConfig({})!;
const PACKAGES = ['io.kontourai.station'];
const NOW = Date.parse('2026-09-24T12:00:00.000Z');

interface Sent {
  deviceId: string;
  /** The clock when the gateway received it. */
  at: number;
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
    /** Floor waits stay pending until `releaseSleep`, as real time would. */
    manualSleep?: boolean;
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
  const heldSleeps: Array<{ ms: number; resolve: () => void }> = [];
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
      at: clock.now,
      ...(collapseKey ? { collapseKey } : {}),
      ...(priority ? { priority } : {}),
      data,
      // A card (from the publisher in the shared-floor test) is sealed
      // under the card's AAD; only its routing is looked at here.
      plaintext:
        data.station_kind === 'agent_activity'
          ? {}
          : open(data.sealed ?? '', registration),
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
      sleep: (ms) => {
        sleeps.push(ms);
        if (!options.manualSleep) {
          clock.now += ms;
          return Promise.resolve();
        }
        return new Promise<void>((resolve) => heldSleeps.push({ ms, resolve }));
      },
    },
  });
  return {
    pairing,
    keys,
    eventBus,
    clock,
    sent,
    refused,
    warn,
    sleeps,
    heldSleeps,
    /** Lets the oldest held floor wait end, the clock moving by its length. */
    async releaseSleep() {
      const held = heldSleeps.shift();
      if (!held) throw new Error('no floor wait is held');
      clock.now += held.ms;
      held.resolve();
      await this.settle();
    },
    sendFloor,
    phone,
    tablet,
    wiring,
    fetchImpl,
    registrations,
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

  test("an orchestration session's approval and turn endings are the card's; a registry approval and other alerts are carried", async () => {
    const h = await harness();
    // As approval-inbox.ts and turn-completion-notifications.ts stamp them.
    const orchestration = (id: string, category: string) =>
      notification({
        id,
        category,
        source: 'approval-inbox',
        metadata: {
          sessionId: 'session-1',
          sessionKind: 'runtime',
          threadId: 'session-1',
          ...(category === 'approval-request'
            ? { requestKind: 'orchestration' }
            : {}),
        },
      });
    for (const category of [
      'approval-request',
      'turn-completed',
      'turn-stopped',
      'turn-failed',
    ])
      h.eventBus.emit(
        SERVER_EVENTS.NOTIFICATION_DELIVERED,
        orchestration(`n-${category}`, category) as never,
      );
    await h.settle();
    expect(h.fetchImpl).not.toHaveBeenCalled();
    // A registry approval (a managed-agent tool call) is never on the card.
    h.eventBus.emit(
      SERVER_EVENTS.NOTIFICATION_DELIVERED,
      notification({
        id: 'n-registry',
        category: 'approval-request',
        source: 'approval-inbox',
        metadata: {
          approvalId: 'approval-1',
          conversationId: 'session-1',
          sessionId: 'session-1',
          sessionKind: 'managed',
          requestKind: 'registry',
        },
      }) as never,
    );
    // No writer produces this today, but a registry request is carried
    // whatever session kind it names: requestKind decides on its own.
    h.eventBus.emit(
      SERVER_EVENTS.NOTIFICATION_DELIVERED,
      notification({
        id: 'n-registry-runtime',
        category: 'approval-request',
        source: 'approval-inbox',
        metadata: {
          sessionId: 'session-1',
          sessionKind: 'runtime',
          requestKind: 'registry',
        },
      }) as never,
    );
    // Nor is a record that does not say it is orchestration-backed.
    h.eventBus.emit(
      SERVER_EVENTS.NOTIFICATION_DELIVERED,
      notification({
        id: 'n-unmarked',
        category: 'approval-request',
        source: 'approval-inbox',
        metadata: { sessionId: 'session-1' },
      }) as never,
    );
    // Nor is a runtime orchestration record that names no session: the card
    // is keyed by session, so nothing ties it to a card entry (a duplicate
    // beats a silenced alert). No writer produces one today.
    for (const [id, sessionId] of [
      ['n-runtime-no-session', undefined],
      ['n-runtime-empty-session', ''],
    ] as const)
      h.eventBus.emit(
        SERVER_EVENTS.NOTIFICATION_DELIVERED,
        notification({
          id,
          category: 'approval-request',
          source: 'approval-inbox',
          metadata: {
            ...(sessionId === undefined ? {} : { sessionId }),
            sessionKind: 'runtime',
            requestKind: 'orchestration',
          },
        }) as never,
      );
    h.eventBus.emit(
      SERVER_EVENTS.NOTIFICATION_DELIVERED,
      notification({
        id: 'n-pairing',
        category: 'pairing-request',
        source: 'device-pairing',
        metadata: { sessionId: 'session-1' },
      }) as never,
    );
    await h.settle();
    expect(
      new Set(
        h.sent.filter((s) => s.deviceId === h.phone).map((s) => s.plaintext.id),
      ),
    ).toEqual(
      new Set([
        'n-registry',
        'n-registry-runtime',
        'n-unmarked',
        'n-runtime-no-session',
        'n-runtime-empty-session',
        'n-pairing',
      ]),
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

  describe('the per-phone queue behind the floor', () => {
    const attention = (id: string, title = 'Attention') =>
      notification({ id, title, body: undefined });
    const info = (id: string) =>
      notification({
        id,
        title: `Info ${id}`,
        body: undefined,
        category: 'agent-info',
        metadata: { envelope: envelope({ urgency: 'info' }) },
      });
    test('an alert read while it waits for its slot is never sent, and neither is a retract for it', async () => {
      const h = await harness({ manualSleep: true });
      // The card just went to both phones.
      h.sendFloor.record(h.phone, h.clock.now);
      h.sendFloor.record(h.tablet, h.clock.now);
      const record = notification();
      h.eventBus.emit(SERVER_EVENTS.NOTIFICATION_DELIVERED, record as never);
      await h.settle();
      expect(h.sent).toEqual([]);
      h.eventBus.emit(SERVER_EVENTS.NOTIFICATION_UPDATED, {
        ...record,
        metadata: {
          ...record.metadata,
          envelope: {
            ...envelope(),
            readAt: new Date(h.clock.now).toISOString(),
            readBy: 'local:desk-tab',
          },
        },
      } as never);
      await h.settle();
      await h.releaseSleep();
      await h.releaseSleep();
      // The phone never saw it, so there is nothing to take back.
      expect(h.sent).toEqual([]);
    });

    test('created_at and expires_at are stamped when the slot comes, not when it was queued', async () => {
      const h = await harness({ manualSleep: true });
      h.sendFloor.record(h.phone, h.clock.now - 1_000);
      h.eventBus.emit(
        SERVER_EVENTS.NOTIFICATION_DELIVERED,
        notification() as never,
      );
      await h.settle();
      const queuedAt = h.clock.now;
      await h.releaseSleep();
      const toPhone = h.sent.find((s) => s.deviceId === h.phone)!;
      expect(Number(toPhone.plaintext.created_at)).toBe(queuedAt + 2_000);
      expect(Number(toPhone.plaintext.expires_at)).toBe(
        queuedAt + 2_000 + FCM_ALERT_LIFETIME_MS,
      );
    });

    test('a newer send for the same id replaces the waiting one', async () => {
      const h = await harness({ manualSleep: true });
      h.sendFloor.record(h.phone, h.clock.now);
      h.sendFloor.record(h.tablet, h.clock.now);
      h.eventBus.emit(
        SERVER_EVENTS.NOTIFICATION_DELIVERED,
        attention('n-1', 'First') as never,
      );
      await h.settle();
      h.eventBus.emit(
        SERVER_EVENTS.NOTIFICATION_DELIVERED,
        attention('n-1', 'Edited') as never,
      );
      await h.settle();
      while (h.heldSleeps.length > 0) await h.releaseSleep();
      const toPhone = h.sent.filter((s) => s.deviceId === h.phone);
      expect(toPhone.map((s) => s.plaintext.title)).toEqual(['Edited']);
    });

    test('a burst keeps at most the cap waiting by dropping the oldest info, never attention', async () => {
      const h = await harness({ manualSleep: true });
      h.sendFloor.record(h.phone, h.clock.now);
      h.sendFloor.record(h.tablet, h.clock.now);
      const ids: string[] = [];
      for (let i = 0; i < 4; i += 1) ids.push(`a-${i}`);
      for (let i = 0; i < 8; i += 1) ids.push(`i-${i}`);
      for (const id of ids)
        h.eventBus.emit(
          SERVER_EVENTS.NOTIFICATION_DELIVERED,
          (id.startsWith('a-') ? attention(id) : info(id)) as never,
        );
      await h.settle();
      while (h.heldSleeps.length > 0) await h.releaseSleep();
      const toPhone = h.sent
        .filter((s) => s.deviceId === h.phone)
        .map((s) => s.plaintext.id);
      // 12 queued, cap 8: the four oldest info alerts are dropped.
      expect(toPhone).toEqual([
        'a-0',
        'a-1',
        'a-2',
        'a-3',
        'i-4',
        'i-5',
        'i-6',
        'i-7',
      ]);
      expect(
        h.warn.mock.calls.filter(([message]) =>
          String(message).includes('dropped a waiting info notification'),
        ),
      ).toHaveLength(8);
      // Attention alone is never dropped, whatever the queue holds.
      const all = await harness({ manualSleep: true });
      all.sendFloor.record(all.phone, all.clock.now);
      for (let i = 0; i < 12; i += 1)
        all.eventBus.emit(
          SERVER_EVENTS.NOTIFICATION_DELIVERED,
          attention(`a-${i}`) as never,
        );
      await all.settle();
      while (all.heldSleeps.length > 0) await all.releaseSleep();
      expect(all.sent.filter((s) => s.deviceId === all.phone)).toHaveLength(12);
    });

    test('once the card has been held back twice, the queue leaves it the next slot', async () => {
      const h = await harness({ manualSleep: true });
      const start = h.clock.now;
      h.sendFloor.record(h.phone, start);
      h.sendFloor.deferCard(h.phone);
      h.sendFloor.deferCard(h.phone);
      h.eventBus.emit(
        SERVER_EVENTS.NOTIFICATION_DELIVERED,
        notification() as never,
      );
      await h.settle();
      // It waits two intervals without reserving: the slot at +3 s is free.
      expect(h.heldSleeps.find(() => true)?.ms).toBe(
        2 * NATIVE_PUSH_MIN_SEND_INTERVAL_MS,
      );
      expect(h.sendFloor.lastSendAt(h.phone)).toBe(start);
      // The card takes it meanwhile.
      h.sendFloor.recordCard(h.phone, start + NATIVE_PUSH_MIN_SEND_INTERVAL_MS);
      await h.releaseSleep();
      while (h.heldSleeps.length > 0) await h.releaseSleep();
      const toPhone = h.sent.find((s) => s.deviceId === h.phone)!;
      expect(Number(toPhone.plaintext.created_at)).toBe(
        start + 2 * NATIVE_PUSH_MIN_SEND_INTERVAL_MS,
      );
      // It yields once per deferral count, not on every send after.
      expect(h.sendFloor.takeCardYield(h.phone)).toBe(false);
    });

    /** A channel over the harness's phones, as a restarted Station builds it. */
    const freshChannel = (
      h: Awaited<ReturnType<typeof harness>>,
      options: {
        sleep?: (ms: number) => Promise<void>;
        devicePairing?: FcmAlertDevicePairing;
      } = {},
    ) =>
      new FcmAlertChannel({
        devicePairing: options.devicePairing ?? h.pairing,
        signingKey: h.keys,
        gateway: GATEWAY,
        sendFloor: h.sendFloor,
        logger: { warn: vi.fn() },
        fetchImpl: h.fetchImpl as unknown as typeof fetch,
        now: () => h.clock.now,
        sleep: options.sleep ?? (async () => {}),
      });
    const onPhone = (h: Awaited<ReturnType<typeof harness>>) => ({
      surface: `device:${h.phone}` as const,
      ref: h.phone,
      hideContent: false,
    });
    const readOf = (record: Notification): Notification => ({
      ...record,
      metadata: {
        ...record.metadata,
        envelope: {
          ...(record.metadata?.envelope as NotificationEnvelopeV1),
          readAt: new Date(NOW).toISOString(),
          readBy: 'local:desk-tab',
        },
      },
    });

    test('after a restart an id it has never seen is still retracted', async () => {
      const h = await harness();
      // Alert Z went out before the restart; the new process knows nothing.
      const outcomes = await freshChannel(h).retract('Z', [onPhone(h)]);
      await h.settle();
      expect(outcomes).toBeUndefined();
      expect(
        h.sent.map((s) => [s.deviceId, s.plaintext.kind, s.plaintext.id]),
      ).toEqual([[h.phone, 'retract', 'Z']]);
    });

    test('a waiting re-show of an id already sent is removed by a read, and the retract still goes', async () => {
      const h = await harness({ manualSleep: true });
      const record = notification({ title: 'First version' });
      h.eventBus.emit(SERVER_EVENTS.NOTIFICATION_DELIVERED, record as never);
      await h.settle();
      // Edited while unread: a second version waits for the next slot.
      const edited = { ...record, title: 'Edited version' };
      h.eventBus.emit(SERVER_EVENTS.NOTIFICATION_UPDATED, edited as never);
      await h.settle();
      h.eventBus.emit(
        SERVER_EVENTS.NOTIFICATION_UPDATED,
        readOf(edited) as never,
      );
      await h.settle();
      while (h.heldSleeps.length > 0) await h.releaseSleep();
      expect(
        h.sent
          .filter((s) => s.deviceId === h.phone)
          .map((s) => [s.plaintext.kind, s.plaintext.title]),
      ).toEqual([
        ['alert', 'First version'],
        ['retract', undefined],
      ]);
    });

    test('an id the queue dropped is retracted again once a later version of it was sent', async () => {
      const h = await harness({ manualSleep: true });
      h.sendFloor.record(h.phone, h.clock.now);
      h.sendFloor.record(h.tablet, h.clock.now);
      const records = Array.from({ length: 9 }, (_, i) => info(`i-${i}`));
      for (const record of records)
        h.eventBus.emit(SERVER_EVENTS.NOTIFICATION_DELIVERED, record as never);
      await h.settle();
      // i-0 was dropped at the cap. Delivered again, it is sent this time.
      h.eventBus.emit(
        SERVER_EVENTS.NOTIFICATION_DELIVERED,
        records[0] as never,
      );
      await h.settle();
      while (h.heldSleeps.length > 0) await h.releaseSleep();
      expect(
        h.sent.some((s) => s.deviceId === h.phone && s.plaintext.id === 'i-0'),
      ).toBe(true);
      h.eventBus.emit(
        SERVER_EVENTS.NOTIFICATION_UPDATED,
        readOf(records[0] as Notification) as never,
      );
      await h.settle();
      while (h.heldSleeps.length > 0) await h.releaseSleep();
      expect(
        h.sent
          .filter((s) => s.deviceId === h.phone && s.plaintext.id === 'i-0')
          .map((s) => s.plaintext.kind),
      ).toEqual(['alert', 'retract']);
    });

    test('a retract that empties the queue gives the reserved slot back', async () => {
      const h = await harness({ manualSleep: true });
      const start = h.clock.now;
      h.sendFloor.record(h.phone, start);
      h.sendFloor.record(h.tablet, start);
      const record = info('i-only');
      h.eventBus.emit(SERVER_EVENTS.NOTIFICATION_DELIVERED, record as never);
      await h.settle();
      expect(h.sendFloor.lastSendAt(h.phone)).toBe(
        start + NATIVE_PUSH_MIN_SEND_INTERVAL_MS,
      );
      h.eventBus.emit(
        SERVER_EVENTS.NOTIFICATION_UPDATED,
        readOf(record) as never,
      );
      await h.settle();
      // The reserved slot is released, so a card sent from now on is not
      // held back by a send that will not happen. (A card update already
      // deferred for that slot keeps its retry timer.)
      expect(h.sendFloor.lastSendAt(h.phone)).toBe(start);
      while (h.heldSleeps.length > 0) await h.releaseSleep();
      expect(h.sent).toEqual([]);
    });

    test('a re-show of a sent alert dropped at the cap is still retracted by a read', async () => {
      const h = await harness({ manualSleep: true });
      const record = info('i-x');
      h.eventBus.emit(SERVER_EVENTS.NOTIFICATION_DELIVERED, record as never);
      await h.settle();
      expect(
        h.sent.some((s) => s.deviceId === h.phone && s.plaintext.id === 'i-x'),
      ).toBe(true);
      // Edited while unread: the re-show waits for the next slot...
      const edited = { ...record, title: 'Edited' };
      h.eventBus.emit(SERVER_EVENTS.NOTIFICATION_UPDATED, edited as never);
      await h.settle();
      // ...and eight more info alerts push it out at the cap.
      for (let i = 0; i < 8; i += 1)
        h.eventBus.emit(
          SERVER_EVENTS.NOTIFICATION_DELIVERED,
          info(`i-${i}`) as never,
        );
      await h.settle();
      expect(
        h.warn.mock.calls.filter(([message]) =>
          String(message).includes('dropped a waiting info notification'),
        ).length,
      ).toBeGreaterThan(0);
      // The first version is on the phone: the read must take it back.
      h.eventBus.emit(
        SERVER_EVENTS.NOTIFICATION_UPDATED,
        readOf(edited) as never,
      );
      await h.settle();
      while (h.heldSleeps.length > 0) await h.releaseSleep();
      expect(
        h.sent
          .filter((s) => s.deviceId === h.phone && s.plaintext.id === 'i-x')
          .map((s) => [s.plaintext.kind, s.plaintext.title]),
      ).toEqual([
        ['alert', 'Info i-x'],
        ['retract', undefined],
      ]);
    });

    test('a failed registrations read forgets nothing: a sent alert is still retracted after its re-show is dropped', async () => {
      for (const failure of ['throws', 'android-unreadable'] as const) {
        const h = await harness();
        let failing = false;
        const devicePairing: FcmAlertDevicePairing = {
          listNativePushRegistrationsByPlatform: () => {
            if (!failing)
              return h.pairing.listNativePushRegistrationsByPlatform();
            const error = new Error('registrations are unreadable');
            if (failure === 'throws') throw error;
            return {
              registrations: [],
              unreadable: [{ platform: 'android', error }],
            };
          },
          clearNativePush: (...args) => h.pairing.clearNativePush(...args),
          environmentId: () => h.pairing.environmentId(),
        };
        const held: Array<() => void> = [];
        let holding = false;
        const channel = freshChannel(h, {
          devicePairing,
          sleep: () =>
            holding
              ? new Promise<void>((resolve) => held.push(resolve))
              : Promise.resolve(),
        });
        const send = (id: string, title: string) =>
          channel.deliver(
            { ...info(id), title },
            envelope({ urgency: 'info' }),
            [onPhone(h)],
          );
        expect((await send('i-x', 'First'))[0]?.result, failure).toBe('sent');
        // A routed notification lists registrations while the read fails.
        failing = true;
        expect(channel.registrations(), failure).toEqual([]);
        failing = false;
        // The edited re-show waits, then is dropped at the cap.
        holding = true;
        const waiting = [
          send('i-x', 'Edited'),
          ...Array.from({ length: 8 }, (_, i) => send(`i-${i}`, 'Other')),
        ];
        expect((await waiting[0])?.[0]?.result, failure).toBe('suppressed');
        const retract = channel.retract('i-x', [onPhone(h)]);
        holding = false;
        for (const resolve of held.splice(0)) resolve();
        await Promise.all([...waiting, retract]);
        await h.settle();
        expect(
          h.sent
            .filter((s) => s.plaintext.id === 'i-x')
            .map((s) => [s.plaintext.kind, s.plaintext.title]),
          failure,
        ).toEqual([
          ['alert', 'First'],
          ['retract', undefined],
        ]);
      }
    });

    test('a phone that unregistered forgets what was dropped for it', async () => {
      const h = await harness();
      const held: Array<() => void> = [];
      let holding = true;
      const channel = freshChannel(h, {
        sleep: () =>
          holding
            ? new Promise<void>((resolve) => held.push(resolve))
            : Promise.resolve(),
      });
      h.sendFloor.record(h.phone, h.clock.now);
      // Nine info alerts to a phone its floor holds: the first is dropped.
      const waiting = Array.from({ length: 9 }, (_, i) =>
        channel.deliver(info(`i-${i}`), envelope({ urgency: 'info' }), [
          onPhone(h),
        ]),
      );
      expect((await waiting[0])?.[0]?.result).toBe('suppressed');
      // Without unregistering, its retract is not sent.
      await channel.retract('i-0', [onPhone(h)]);
      expect(h.fetchImpl).not.toHaveBeenCalled();
      // The phone turns agent activity off and on again.
      const previous = h.registrations.get(h.phone)!;
      h.pairing.clearNativePush(h.phone);
      channel.registrations();
      expect(
        h.pairing
          .listNativePushRegistrations()
          .some(({ deviceId }) => deviceId === h.phone),
      ).toBe(false);
      // Its waiting sends end unsent.
      holding = false;
      for (const resolve of held.splice(0)) resolve();
      await Promise.all(waiting);
      const key = await h.keys.loadOrCreate();
      h.registrations.set(
        h.phone,
        h.pairing.setNativePush(
          h.phone,
          {
            token: previous.token,
            packageName: 'io.kontourai.station',
            platform: 'android',
          },
          key.thumbprint,
        ),
      );
      channel.registrations();
      await channel.retract('i-0', [onPhone(h)]);
      await h.settle();
      expect(
        h.sent.map((s) => [s.plaintext.kind, s.plaintext.id]),
      ).toContainEqual(['retract', 'i-0']);
    });

    test('reading alerts the queue dropped sends no retract, and a following attention alert is not delayed (#2588 probe)', async () => {
      const h = await harness({ manualSleep: true });
      const start = h.clock.now;
      h.sendFloor.record(h.phone, start);
      h.sendFloor.record(h.tablet, start);
      const records = Array.from({ length: 20 }, (_, i) => info(`i-${i}`));
      for (const record of records)
        h.eventBus.emit(SERVER_EVENTS.NOTIFICATION_DELIVERED, record as never);
      await h.settle();
      // Read all twenty elsewhere.
      for (const record of records)
        h.eventBus.emit(SERVER_EVENTS.NOTIFICATION_UPDATED, {
          ...record,
          metadata: {
            envelope: {
              ...envelope({ urgency: 'info' }),
              readAt: new Date(h.clock.now).toISOString(),
              readBy: 'local:desk-tab',
            },
          },
        } as never);
      await h.settle();
      h.eventBus.emit(
        SERVER_EVENTS.NOTIFICATION_DELIVERED,
        attention('a-after') as never,
      );
      await h.settle();
      while (h.heldSleeps.length > 0) await h.releaseSleep();
      const toPhone = h.sent.filter((s) => s.deviceId === h.phone);
      expect(toPhone.map((s) => [s.plaintext.kind, s.plaintext.id])).toEqual([
        ['alert', 'a-after'],
      ]);
      // It takes the very next slot.
      expect(toPhone[0]?.at).toBe(start + NATIVE_PUSH_MIN_SEND_INTERVAL_MS);
    });

    test('a retract goes to a phone the alert was actually sent to', async () => {
      const h = await harness({ manualSleep: true });
      const record = info('i-sent');
      h.eventBus.emit(SERVER_EVENTS.NOTIFICATION_DELIVERED, record as never);
      await h.settle();
      h.eventBus.emit(SERVER_EVENTS.NOTIFICATION_DISMISSED, {
        ...record,
        status: 'dismissed',
      } as never);
      await h.settle();
      while (h.heldSleeps.length > 0) await h.releaseSleep();
      expect(
        h.sent
          .filter((s) => s.deviceId === h.phone)
          .map((s) => s.plaintext.kind),
      ).toEqual(['alert', 'retract']);
    });

    test('the card and the channel over one floor never send to a phone less than an interval apart', async () => {
      const h = await harness({ manualSleep: true });
      const start = h.clock.now;
      const timers: Array<{ fn: () => void; at: number; live: boolean }> = [];
      let phase: 'running' | 'review_pending' = 'running';
      const publisher = wireAgentActivityPublisher({
        eventBus: h.eventBus,
        devicePairing: h.pairing,
        signingKey: h.keys,
        sendFloor: h.sendFloor,
        sessionReaderFor: () => ({
          principalId: 'reader',
          listSessions: async () => [
            {
              sessionId: 'session-1',
              title: 'Migration',
              lifecycleState: phase,
              status: 'running',
              isLoaded: true,
              hasActiveTurn: true,
              ...(phase === 'review_pending' ? { pendingReview: true } : {}),
            } as never,
          ],
        }),
        gateway: GATEWAY,
        logger: { warn: vi.fn() },
        fetchImpl: h.fetchImpl as unknown as typeof fetch,
        now: () => h.clock.now,
        windowMs: 1,
        setTimer: (fn, delayMs) => {
          const timer = { fn, at: h.clock.now + delayMs, live: true };
          timers.push(timer);
          return () => {
            timer.live = false;
          };
        },
      });
      const lifecycle = () =>
        h.eventBus.emit(SERVER_EVENTS.ORCHESTRATION_EVENT, {
          event: { method: 'session.state-changed', threadId: 'session-1' },
        } as never);
      const flush = async () => {
        await publisher.drain();
        await h.settle();
      };
      // The card goes first.
      lifecycle();
      await flush();
      // A notification comes at once, and waits for the phone's next slot.
      h.eventBus.emit(
        SERVER_EVENTS.NOTIFICATION_DELIVERED,
        notification() as never,
      );
      await h.settle();
      await h.releaseSleep();
      // The card changes while that slot is still the phone's latest.
      phase = 'review_pending';
      lifecycle();
      await flush();
      // Its retry fires when its slot comes.
      while (
        !h.sent.some((s) => s.deviceId === h.phone && s.at > start + 3_000)
      ) {
        const next = timers
          .filter((timer) => timer.live)
          .sort((a, b) => a.at - b.at)[0];
        if (!next) throw new Error('no publisher timer armed');
        h.clock.now = Math.max(h.clock.now, next.at);
        next.live = false;
        next.fn();
        await flush();
      }
      const toPhone = h.sent.filter((s) => s.deviceId === h.phone);
      expect(toPhone.map((s) => [s.data.station_kind, s.at - start])).toEqual([
        ['agent_activity', 0],
        ['station_notification', NATIVE_PUSH_MIN_SEND_INTERVAL_MS],
        ['agent_activity', 2 * NATIVE_PUSH_MIN_SEND_INTERVAL_MS],
      ]);
      await publisher.stop();
    });
  });
});

describe('FcmAlertChannel without a sendable registration', () => {
  test('takes no floor slot for a phone it cannot send to', async () => {
    const sendFloor = createNativePushSendFloor();
    const sleep = vi.fn(async () => {});
    const fetchImpl = vi.fn();
    const channel = new FcmAlertChannel({
      devicePairing: {
        listNativePushRegistrationsByPlatform: () => ({
          registrations: [],
          unreadable: [],
        }),
        clearNativePush: vi.fn(),
        environmentId: () => ENVIRONMENT_ID,
      },
      signingKey: { read: () => null },
      gateway: GATEWAY,
      sendFloor,
      logger: { warn: vi.fn() },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
      sleep,
    });
    sendFloor.record('gone-phone', NOW);
    const target = {
      surface: 'device:gone-phone' as const,
      ref: 'gone-phone',
      hideContent: false,
    };
    const outcomes = await Promise.all([
      channel.deliver(notification({ id: 'n-1' }), envelope(), [target]),
      channel.deliver(notification({ id: 'n-2' }), envelope(), [target]),
    ]);
    expect(outcomes.flat().map((o) => o.result)).toEqual([
      'suppressed',
      'suppressed',
    ]);
    expect(sleep).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(sendFloor.lastSendAt('gone-phone')).toBe(NOW);
  });
});
