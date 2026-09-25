/**
 * iOS alerts (#2589) end to end on the Station side: a notification on the
 * EventBus → the REAL delivery wiring (audience, policy, preferences) →
 * ApnsAlertChannel → the REAL push gateway (`handleRequest`: signature,
 * `parseAlertRequest`, payload) → a fake Apple. So a body the gateway would
 * refuse, visible text that is not the fixed vocabulary, or a hideContent
 * surface whose sealed payload still carries the title, fails here.
 */
import { createDecipheriv } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  NATIVE_PUSH_ALERT_SEALED_AAD_PREFIX,
  NATIVE_PUSH_IOS_BUNDLES,
  NATIVE_PUSH_SEALED_AAD_PREFIX,
} from '@kontourai/station-contracts/native-push';
import type { Notification } from '@kontourai/station-contracts/notification';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { wireNotificationDelivery } from '../../../runtime/routes/notification-delivery-wiring.js';
import { EventBus } from '../../orchestration/event-bus.js';
import { DevicePairingService } from '../../ssh/device-pairing-service.js';
import { resolvePushGatewayConfig } from '../agent-activity-publisher.js';
import {
  ApnsAlertChannel,
  apnsAlertCollapseId,
  composeApnsAlertPlaintext,
} from '../delivery/apns-alert-channel.js';
import { PushSigningKeyStore } from '../push-signing-key-store.js';

// Loaded by path at run time, as push-gateway-apns-contract.test.ts does:
// the gateway's `.ts` specifiers are outside Station's test tsconfig, so
// the paths are variables tsc does not follow.
type GatewayConfig = Record<string, unknown>;
const GATEWAY_MODULE = '../../../../deploy/push-gateway/src/gateway.js';
const GATEWAY_REQUEST = '../../../../deploy/push-gateway/src/apns-request.js';
const GATEWAY_HELPERS = '../../../../deploy/push-gateway/test/helpers.js';
const { handleRequest } = (await import(GATEWAY_MODULE)) as {
  handleRequest(request: Request, config: GatewayConfig): Promise<Response>;
};
const { APNS_ALERT_TEXT } = (await import(GATEWAY_REQUEST)) as {
  APNS_ALERT_TEXT: Record<string, { title: string; body: string }>;
};
const { allow, fakeApnsKey, fakeLedger } = (await import(GATEWAY_HELPERS)) as {
  allow: unknown;
  fakeApnsKey(): Promise<{ credentials: unknown }>;
  fakeLedger(): unknown;
};

const ENVIRONMENT_ID = '11111111-1111-4111-8111-111111111111';
const GATEWAY = resolvePushGatewayConfig({})!;
const NOW = Date.parse('2026-09-25T10:00:00.000Z');
const PUSH_TO_START = 'ab'.repeat(40);
const ALERT_TOKEN = 'cd'.repeat(32);
const SECRET_TITLE = 'Approve running `rm -rf /secret-project`';
const SECRET_BODY = 'The agent wants to delete secret-project';
const tempDir = trackTempDirs();

interface AppleCall {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function approval(overrides: Partial<Notification> = {}): Notification {
  return {
    id: 'n-approval',
    // An attention notification the Live Activity card does not announce.
    source: 'device-pairing',
    category: 'pairing-request',
    title: SECRET_TITLE,
    body: SECRET_BODY,
    priority: 'high',
    status: 'delivered',
    scheduledAt: null,
    deliveredAt: new Date(NOW).toISOString(),
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function open(sealed: string, payloadKey: string, aad: string): unknown {
  const bytes = Buffer.from(sealed, 'base64url');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    Buffer.from(payloadKey, 'base64url'),
    bytes.subarray(0, 12),
    { authTagLength: 16 },
  );
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(bytes.subarray(bytes.length - 16));
  return JSON.parse(
    Buffer.concat([
      decipher.update(bytes.subarray(12, bytes.length - 16)),
      decipher.final(),
    ]).toString('utf8'),
  );
}

async function harness(
  options: { alertToken?: string | null; appleReply?: () => Response } = {},
) {
  const homeDir = tempDir('station-apns-alert-');
  mkdirSync(join(homeDir, 'security'), { mode: 0o700 });
  const pairing = new DevicePairingService({
    homeDir,
    environmentId: ENVIRONMENT_ID,
  });
  const keys = new PushSigningKeyStore(homeDir, () => pairing.environmentId());
  const offer = pairing.createOffer({
    endpoint: 'https://station.example.test',
  });
  const pairingRequest = pairing.requestPairing({
    requesterPosition: 'off-box',
    offerId: offer.offerId,
    proof: offer.challenge,
    deviceName: 'iPhone',
  });
  pairing.confirmRequest(pairingRequest.requestId, {
    kind: 'presented-credential',
  });
  const deviceId = pairing.exchange({
    offerId: offer.offerId,
    proof: offer.challenge,
    requestId: pairingRequest.requestId,
  }).device.id;
  const key = await keys.loadOrCreate();
  const alertToken =
    options.alertToken === undefined ? ALERT_TOKEN : options.alertToken;
  const registration = pairing.setNativePush(
    deviceId,
    {
      token: PUSH_TO_START,
      packageName: 'io.kontourai.station',
      platform: 'ios',
      apnsEnvironment: 'production',
      ...(alertToken ? { alertToken } : {}),
    },
    key.thumbprint,
  );

  const appleCalls: AppleCall[] = [];
  const appleFetch = (async (input: string | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => {
      headers[name] = value;
    });
    appleCalls.push({
      url: String(input),
      headers,
      body:
        init?.body instanceof Uint8Array
          ? new TextDecoder().decode(init.body)
          : String(init?.body ?? ''),
    });
    return options.appleReply?.() ?? new Response(null, { status: 200 });
  }) as typeof fetch;
  const apnsKey = await fakeApnsKey();
  const gatewayConfig: GatewayConfig = {
    audiences: [GATEWAY.audience],
    allowedPackages: [],
    serviceAccount: null,
    perIpLimiter: allow,
    globalLimiter: allow,
    perKeyLimiter: allow,
    perTokenLimiter: allow,
    apns: {
      credentials: apnsKey.credentials,
      allowedBundles: [...NATIVE_PUSH_IOS_BUNDLES],
      channelAuth: { current: 'channel-auth-secret-0123456789abcdef0123' },
      channelPerIpLimiter: allow,
      channelPerDeviceLimiter: allow,
      channelPerKeyLimiter: allow,
      channelGlobalLimiter: allow,
      channelDeleteLimiter: allow,
      ledger: fakeLedger(),
      alertPerTokenLimiter: allow,
    },
    fetchImpl: appleFetch,
    nowSeconds: () => Math.floor(NOW / 1000),
  };
  const exchanges: Array<{ status: number; answer: unknown }> = [];
  const stationFetch = vi.fn(async (url: string, init: RequestInit) => {
    const response = await handleRequest(new Request(url, init), gatewayConfig);
    exchanges.push({
      status: response.status,
      answer: await response.clone().json(),
    });
    return response;
  });
  const webPushSend = vi.fn().mockResolvedValue('sent');
  const eventBus = new EventBus();
  const warn = vi.fn();
  const wiring = wireNotificationDelivery({
    enabled: true,
    homeDir,
    eventBus,
    logger: { warn },
    devicePairing: pairing,
    webPushService: { send: webPushSend },
    canUserReadSession: () => true,
    listNotifications: async () => [],
    apnsAlert: {
      devicePairing: pairing,
      signingKey: keys,
      gateway: GATEWAY,
      fetchImpl: stationFetch as unknown as typeof fetch,
      now: () => NOW,
    },
  });
  const iosRecord = () =>
    (
      JSON.parse(
        readFileSync(
          join(homeDir, 'security', 'native-push-ios-registrations.json'),
          'utf8',
        ),
      ) as { registrations: Record<string, Record<string, unknown>> }
    ).registrations[deviceId];
  return {
    pairing,
    keys,
    deviceId,
    registration,
    eventBus,
    wiring,
    appleCalls,
    exchanges,
    stationFetch,
    webPushSend,
    warn,
    iosRecord,
    /** Emits, then waits until the gateway has answered `exchanges` sends. */
    async emit(notification: Notification, exchangesAfter: number) {
      eventBus.emit(
        SERVER_EVENTS.NOTIFICATION_DELIVERED,
        notification as never,
      );
      await vi.waitFor(() => expect(exchanges).toHaveLength(exchangesAfter));
      await settle();
    },
  };
}

/** Long enough for any send the router started to reach the fake Apple. */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe('ApnsAlertChannel through the delivery router and the real gateway', () => {
  test('an approval reaches the phone as a fixed-text alert on the app topic; its words travel only sealed', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    try {
      const h = await harness();
      await h.emit(approval(), 1);
      expect(h.exchanges).toEqual([
        { status: 200, answer: { result: 'sent' } },
      ]);
      expect(h.appleCalls).toHaveLength(1);
      const [call] = h.appleCalls;
      expect(call?.url).toBe(
        `https://api.push.apple.com/3/device/${ALERT_TOKEN}`,
      );
      expect(call?.headers['apns-push-type']).toBe('alert');
      expect(call?.headers['apns-topic']).toBe('io.kontourai.station');
      expect(call?.headers['apns-collapse-id']).toBe(
        apnsAlertCollapseId(ENVIRONMENT_ID, 'n-approval'),
      );
      // Nothing the notification (or an agent) wrote is readable by Apple.
      expect(call?.body).not.toContain('secret-project');
      expect(call?.body).not.toContain('Approve');
      const payload = JSON.parse(call?.body ?? '{}');
      expect(payload.aps).toEqual({
        alert: APNS_ALERT_TEXT.attention,
        sound: 'default',
        'mutable-content': 1,
      });
      const key = h.keys.read();
      expect(payload.station).toMatchObject({
        v: 1,
        rid: h.registration.registrationId,
        sk: key?.thumbprint,
      });
      expect(
        open(
          payload.station.sealed,
          h.registration.payloadKey,
          `${NATIVE_PUSH_ALERT_SEALED_AAD_PREFIX}${h.registration.registrationId}`,
        ),
      ).toEqual({
        user_id: ENVIRONMENT_ID,
        notification_id: 'n-approval',
        urgency: 'attention',
        issued_at: String(NOW),
        title: SECRET_TITLE,
        body: SECRET_BODY,
      });
      // Domain-separated from the card: it does not open as one.
      expect(() =>
        open(
          payload.station.sealed,
          h.registration.payloadKey,
          `${NATIVE_PUSH_SEALED_AAD_PREFIX}${h.registration.registrationId}`,
        ),
      ).toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  test('hideContent: generic fixed text, and the sealed payload carries neither title nor body', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    try {
      const h = await harness();
      h.wiring.preferences.patch({
        perSurface: {
          [`device:${h.deviceId}`]: { minUrgency: 'info', hideContent: true },
        },
      });
      await h.emit(approval(), 1);
      expect(h.appleCalls).toHaveLength(1);
      const payload = JSON.parse(h.appleCalls[0]?.body ?? '{}');
      // Hidden, but still urgent: the privacy setting never quiets it.
      expect(payload.aps.alert).toEqual(APNS_ALERT_TEXT['hidden-urgent']);
      expect(payload.aps.sound).toBe('default');
      expect(h.appleCalls[0]?.headers['apns-priority']).toBe('10');
      expect(
        open(
          payload.station.sealed,
          h.registration.payloadKey,
          `${NATIVE_PUSH_ALERT_SEALED_AAD_PREFIX}${h.registration.registrationId}`,
        ),
      ).toEqual({
        user_id: ENVIRONMENT_ID,
        notification_id: 'n-approval',
        urgency: 'attention',
        issued_at: String(NOW),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test('a registration without an alert token gets no alert; Web Push is unaffected', async () => {
    const h = await harness({ alertToken: null });
    h.eventBus.emit(SERVER_EVENTS.NOTIFICATION_DELIVERED, approval() as never);
    await settle();
    expect(h.webPushSend).not.toHaveBeenCalled();
    expect(h.stationFetch).not.toHaveBeenCalled();
    expect(h.appleCalls).toEqual([]);
  });

  test('hideContent keeps each urgency: failed stays loud, done stays quiet', async () => {
    const h = await harness();
    h.wiring.preferences.patch({
      perSurface: {
        [`device:${h.deviceId}`]: { minUrgency: 'info', hideContent: true },
      },
    });
    const withUrgency = (id: string, urgency: 'failed' | 'done') =>
      approval({
        id,
        category: 'agent-notice',
        metadata: {
          envelope: {
            v: 1,
            source: { kind: 'system', subsystem: 'test' },
            audience: { kind: 'owner' },
            urgency,
            interrupt: 'default',
          },
        },
      });
    await h.emit(withUrgency('n-failed', 'failed'), 1);
    await h.emit(withUrgency('n-done', 'done'), 2);
    const sent = h.appleCalls.map((call) => ({
      aps: JSON.parse(call.body).aps,
      priority: call.headers['apns-priority'],
    }));
    expect(sent).toEqual([
      {
        aps: {
          alert: APNS_ALERT_TEXT['hidden-urgent'],
          sound: 'default',
          'mutable-content': 1,
        },
        priority: '10',
      },
      {
        aps: { alert: APNS_ALERT_TEXT.hidden, 'mutable-content': 1 },
        priority: '5',
      },
    ]);
  });

  // The metadata each producer really stamps (approval-inbox.ts,
  // turn-completion-notifications.ts).
  const orchestration = (category: string) =>
    approval({
      id: `n-${category}`,
      category,
      source:
        category === 'approval-request' ? 'approval-inbox' : 'turn-completion',
      metadata:
        category === 'approval-request'
          ? {
              requestKind: 'orchestration',
              requestKey: 'orchestration:s1:r1',
              sessionId: 's1',
              sessionKind: 'runtime',
              threadId: 's1',
            }
          : {
              sessionId: 's1',
              sessionKind: 'runtime',
              threadId: 's1',
              turnId: 't1',
            },
    });

  test.each([
    'approval-request',
    'turn-completed',
    'turn-stopped',
    'turn-failed',
  ])(
    'an orchestration %s is left to the Live Activity card: no alert push',
    async (category) => {
      const h = await harness();
      h.eventBus.emit(
        SERVER_EVENTS.NOTIFICATION_DELIVERED,
        orchestration(category) as never,
      );
      await settle();
      expect(h.stationFetch).not.toHaveBeenCalled();
      // The same notification in any other category does go out.
      await h.emit(approval({ id: 'n-other' }), 1);
      expect(h.appleCalls).toHaveLength(1);
    },
  );

  const registryApproval = (metadata: Record<string, unknown> = {}) =>
    approval({
      id: 'n-registry',
      source: 'approval-inbox',
      category: 'approval-request',
      metadata: {
        approvalId: 'a1',
        conversationId: 'c1',
        sessionId: 'c1',
        sessionKind: 'managed',
        requestKind: 'registry',
        requestKey: 'approval:a1',
        ...metadata,
      },
    });

  // Each record below differs from a card-alerted one in one clause of
  // `isCardAlerted`, so dropping that clause silences a real alert here.
  test.each([
    ['a plain registry approval (not on the card)', registryApproval()],
    [
      'a registry approval stamped runtime (requestKind registry needs the thread stamp)',
      registryApproval({ sessionKind: 'runtime' }),
    ],
    [
      'a registry approval naming another thread (the stamp must match the session)',
      registryApproval({ orchestrationThreadId: 'c2' }),
    ],
    [
      'an orchestration-kind approval of a non-runtime session (the sessionKind clause)',
      approval({
        id: 'n-managed',
        source: 'approval-inbox',
        category: 'approval-request',
        metadata: {
          requestKind: 'orchestration',
          sessionId: 's1',
          sessionKind: 'managed',
        },
      }),
    ],
  ])('%s still alerts', async (_label, notification) => {
    const h = await harness();
    await h.emit(notification, 1);
    expect(h.appleCalls).toHaveLength(1);
    expect(JSON.parse(h.appleCalls[0]?.body ?? '{}').aps.alert).toEqual(
      APNS_ALERT_TEXT.attention,
    );
  });

  test('the registry twin of a Station-agent approval is left to the card (#2589)', async () => {
    const h = await harness();
    // What approval-inbox.ts writes for a relayed /chat turn's approval.
    h.eventBus.emit(
      SERVER_EVENTS.NOTIFICATION_DELIVERED,
      registryApproval({
        conversationId: 's1',
        sessionId: 's1',
        orchestrationThreadId: 's1',
      }) as never,
    );
    await settle();
    expect(h.stationFetch).not.toHaveBeenCalled();
    await h.emit(approval({ id: 'n-other' }), 1);
    expect(h.appleCalls).toHaveLength(1);
  });

  test('a failure notification uses the failed text; a done one is quiet; info is not carried', async () => {
    const h = await harness();
    const withUrgency = (id: string, urgency: 'failed' | 'done' | 'info') =>
      approval({
        id,
        category: 'agent-notice',
        metadata: {
          envelope: {
            v: 1,
            source: { kind: 'system', subsystem: 'test' },
            audience: { kind: 'owner' },
            urgency,
            interrupt: 'default',
          },
        },
      });
    await h.emit(withUrgency('n-failed', 'failed'), 1);
    await h.emit(withUrgency('n-done', 'done'), 2);
    h.eventBus.emit(
      SERVER_EVENTS.NOTIFICATION_DELIVERED,
      withUrgency('n-info', 'info') as never,
    );
    await settle();
    const texts = h.appleCalls.map((call) => JSON.parse(call.body).aps.alert);
    expect(texts).toEqual([APNS_ALERT_TEXT.failed, APNS_ALERT_TEXT.done]);
    expect(h.appleCalls.map((call) => call.headers['apns-priority'])).toEqual([
      '10',
      '5',
    ]);
  });

  test('a dead alert token (410 unregistered) is dropped; the registration and its ids stay', async () => {
    const h = await harness({
      appleReply: () =>
        Response.json({ reason: 'Unregistered' }, { status: 410 }),
    });
    await h.emit(approval(), 1);
    expect(h.exchanges).toEqual([
      { status: 410, answer: { result: 'unregistered' } },
    ]);
    const record = h.iosRecord();
    expect(record).not.toHaveProperty('alertToken');
    expect(record).toMatchObject({
      token: PUSH_TO_START,
      registrationId: h.registration.registrationId,
    });
    // Nothing more is sent to it.
    h.eventBus.emit(
      SERVER_EVENTS.NOTIFICATION_DELIVERED,
      approval({ id: 'n-second' }) as never,
    );
    await settle();
    expect(h.appleCalls).toHaveLength(1);
  });

  test('a phone re-registered with a new alert token keeps it after a 410 for the old one', async () => {
    const h = await harness();
    const channel = new ApnsAlertChannel({
      devicePairing: h.pairing,
      signingKey: h.keys,
      gateway: GATEWAY,
      logger: { warn: vi.fn() },
      fetchImpl: (async () =>
        Response.json({ result: 'unregistered' }, { status: 410 })) as never,
    });
    const refs = channel.registrations();
    expect(refs).toEqual([
      { surface: `device:${h.deviceId}`, ref: h.deviceId },
    ]);
    // The phone refreshes its token while the old one is in flight.
    h.pairing.setNativePush(
      h.deviceId,
      {
        token: PUSH_TO_START,
        packageName: 'io.kontourai.station',
        platform: 'ios',
        apnsEnvironment: 'production',
        alertToken: 'ef'.repeat(32),
      },
      h.registration.stationKey,
    );
    const outcomes = await channel.deliver(
      approval(),
      {
        v: 1,
        source: { kind: 'system', subsystem: 'approvals' },
        audience: { kind: 'owner' },
        urgency: 'attention',
        interrupt: 'default',
      },
      [
        {
          surface: `device:${h.deviceId}`,
          ref: h.deviceId,
          hideContent: false,
        },
      ],
    );
    expect(outcomes).toEqual([{ ref: h.deviceId, result: 'gone' }]);
    expect(h.iosRecord()?.alertToken).toBe('ef'.repeat(32));
  });

  test('a registration pinned to another push key is not sent to', async () => {
    const h = await harness();
    const other = new ApnsAlertChannel({
      devicePairing: {
        ...h.pairing,
        listNativePushRegistrationsByPlatform: () => ({
          registrations: [
            {
              deviceId: h.deviceId,
              registration: { ...h.registration, stationKey: 'z'.repeat(43) },
            },
          ],
          unreadable: [],
        }),
        clearNativePushAlertToken: vi.fn(),
        environmentId: () => ENVIRONMENT_ID,
      },
      signingKey: h.keys,
      gateway: GATEWAY,
      logger: { warn: vi.fn() },
      fetchImpl: h.stationFetch as never,
    });
    other.registrations();
    const outcomes = await other.deliver(
      approval(),
      {
        v: 1,
        source: { kind: 'system', subsystem: 'approvals' },
        audience: { kind: 'owner' },
        urgency: 'attention',
        interrupt: 'default',
      },
      [
        {
          surface: `device:${h.deviceId}`,
          ref: h.deviceId,
          hideContent: false,
        },
      ],
    );
    expect(outcomes).toEqual([{ ref: h.deviceId, result: 'rejected' }]);
    expect(h.stationFetch).not.toHaveBeenCalled();
  });

  test('dismissing the notification sends nothing more: APNs alerts cannot be retracted', async () => {
    const h = await harness();
    await h.emit(approval(), 1);
    expect(h.appleCalls).toHaveLength(1);
    h.eventBus.emit(
      SERVER_EVENTS.NOTIFICATION_DISMISSED,
      approval({ status: 'dismissed' }) as never,
    );
    await settle();
    expect(h.appleCalls).toHaveLength(1);
  });
});

describe('composeApnsAlertPlaintext', () => {
  test('long text is shortened (body first) to fit the gateway limit once sealed', () => {
    const plaintext = composeApnsAlertPlaintext({
      stationId: ENVIRONMENT_ID,
      notification: {
        id: 'n',
        title: 'T'.repeat(5000),
        body: 'é'.repeat(5000),
      },
      urgency: 'attention',
      hideContent: false,
      now: NOW,
    });
    expect(Buffer.byteLength(plaintext, 'utf8')).toBeLessThanOrEqual(2000);
    const fields = JSON.parse(plaintext) as Record<string, string>;
    expect([...fields.title!].length).toBe(200);
    expect(fields.title!.endsWith('…')).toBe(true);
  });
});
