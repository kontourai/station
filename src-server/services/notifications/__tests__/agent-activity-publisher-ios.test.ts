/**
 * The publisher's iOS (Live Activity) path end to end: a real pairing
 * registry, push key and both registration files on a temp home, and a fake
 * gateway that verifies the Station signature with the REAL gateway
 * verifier, holds every body to the documented shape
 * (docs/design/notification-delivery.md, "iOS"), keeps its own channels and
 * opens the sealed card the way the widget does.
 *
 * The body shape is asserted here rather than by importing the gateway's
 * iOS parser, which lands separately (#2513 slice A); when both are on
 * main, `expectLiveActivityShape`/`expectChannelShape` should give way to
 * that parser, as the FCM tests use `parseSendRequest`.
 */
import { createDecipheriv } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  NATIVE_PUSH_IOS_BUNDLES,
  NATIVE_PUSH_SEALED_AAD_PREFIX,
} from '@kontourai/station-contracts/native-push';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { verifyStationRequest } from '../../../../deploy/push-gateway/src/station-auth.js';
import { EventBus } from '../../orchestration/event-bus.js';
import { DevicePairingService } from '../../ssh/device-pairing-service.js';
import {
  type AgentActivitySessionRow,
  resolvePushGatewayConfig,
  wireAgentActivityPublisher,
} from '../agent-activity-publisher.js';
import { LIVE_ACTIVITY_ROLLOVER_AFTER_MS } from '../live-activity-planner.js';
import type { NativePushRegistration } from '../native-push-registration-store.js';
import { PushSigningKeyStore } from '../push-signing-key-store.js';

const ENVIRONMENT_ID = '11111111-1111-4111-8111-111111111111';
const GATEWAY = resolvePushGatewayConfig({})!;
const START = Date.parse('2026-09-24T10:00:00.000Z');
const IOS_TOKEN = 'ab'.repeat(40);
const FCM_TOKEN = `fcm-token-${'a'.repeat(60)}`;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

type Answer = { status: number; body?: unknown } | Error;

interface GatewayCall {
  path: string;
  body: Record<string, unknown>;
  /** The widget's view of the sealed card, for live-activity calls. */
  card?: Record<string, string>;
}

const COMMON_KEYS = [
  'alert',
  'bundleId',
  'environment',
  'event',
  'registrationId',
  'sealed',
  'timestamp',
];
const CHANNEL_AUTH = /^v1\.[A-Za-z0-9_-]{43}$/;

/**
 * The documented `/v1/apns/live-activity` body (design REVISION 1), checked
 * at gateway time `nowS`: a start carries no channel; update and end carry
 * the channel and its `channelAuth`.
 */
function expectLiveActivityShape(body: Record<string, unknown>, nowS: number) {
  const extra =
    body.event === 'start'
      ? ['pushToStartToken', 'staleAt']
      : body.event === 'update'
        ? ['channelAuth', 'channelId', 'staleAt']
        : ['channelAuth', 'channelId', 'dismissAt'];
  expect(Object.keys(body).sort()).toEqual([...COMMON_KEYS, ...extra].sort());
  expect(['start', 'update', 'end']).toContain(body.event);
  expect(NATIVE_PUSH_IOS_BUNDLES).toContain(body.bundleId);
  expect(['production', 'sandbox']).toContain(body.environment);
  if (body.event !== 'start') {
    expect(typeof body.channelId).toBe('string');
    expect(body.channelAuth).toMatch(CHANNEL_AUTH);
  }
  expect(body.registrationId).toMatch(/^[A-Za-z0-9_-]{22,64}$/);
  expect(body.sealed).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(String(body.sealed).length).toBeLessThanOrEqual(3400);
  expect(typeof body.alert).toBe('boolean');
  expect(Number.isSafeInteger(body.timestamp)).toBe(true);
  expect(Math.abs(Number(body.timestamp) - nowS)).toBeLessThanOrEqual(120);
  if (body.event === 'start')
    expect(body.pushToStartToken).toMatch(/^[0-9a-f]{64,200}$/);
  if (body.event !== 'end') {
    expect(Number.isSafeInteger(body.staleAt)).toBe(true);
    expect(Number(body.staleAt)).toBeGreaterThan(nowS);
    expect(Number(body.staleAt)).toBeLessThanOrEqual(nowS + 8 * 3600);
  } else {
    expect(Number.isSafeInteger(body.dismissAt)).toBe(true);
    expect(Number(body.dismissAt)).toBeGreaterThanOrEqual(nowS);
    expect(Number(body.dismissAt)).toBeLessThanOrEqual(nowS + 4 * 3600);
  }
}

/** The documented `/v1/apns/channels` body: deletion only. */
function expectChannelShape(body: Record<string, unknown>) {
  expect(Object.keys(body).sort()).toEqual([
    'bundleId',
    'channelAuth',
    'channelId',
    'environment',
    'op',
  ]);
  expect(body.op).toBe('delete');
  expect(NATIVE_PUSH_IOS_BUNDLES).toContain(body.bundleId);
  expect(['production', 'sandbox']).toContain(body.environment);
  expect(body.channelAuth).toMatch(CHANNEL_AUTH);
}

function openCard(sealed: string, registration: NativePushRegistration) {
  const bytes = Buffer.from(sealed, 'base64url');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    Buffer.from(registration.payloadKey, 'base64url'),
    bytes.subarray(0, 12),
  );
  decipher.setAAD(
    Buffer.from(
      `${NATIVE_PUSH_SEALED_AAD_PREFIX}${registration.registrationId}`,
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

function row(
  sessionId: string,
  state: 'running' | 'approval' | 'completed',
  at: number,
): AgentActivitySessionRow {
  return {
    sessionId,
    title: `Session ${sessionId}`,
    project: 'Login App',
    lifecycleState:
      state === 'running'
        ? 'running'
        : state === 'approval'
          ? 'review_pending'
          : 'completed',
    ...(state === 'approval' ? { pendingReview: true } : {}),
    status: state === 'completed' ? 'stopped' : 'running',
    isLoaded: true,
    entry: { key: `${sessionId}:${state}:${at}`, at },
  } as AgentActivitySessionRow;
}

function harness(
  options: {
    homeDir?: string;
    answer?: (call: GatewayCall) => Answer | undefined;
  } = {},
) {
  const homeDir =
    options.homeDir ?? mkdtempSync(join(tmpdir(), 'station-live-activity-'));
  if (!options.homeDir) {
    homes.push(homeDir);
    mkdirSync(join(homeDir, 'security'), { mode: 0o700 });
  }
  const pairing = new DevicePairingService({
    homeDir,
    environmentId: ENVIRONMENT_ID,
  });
  const keys = new PushSigningKeyStore(homeDir, () => pairing.environmentId());
  const eventBus = new EventBus();
  let clock = START;
  let rows: AgentActivitySessionRow[] = [];
  const unreadable = new Set<string>();
  const calls: GatewayCall[] = [];
  /** channelId → the channelAuth the gateway accepts for it. */
  const channels = new Map<string, string>();
  let channelCounter = 0;
  const lastTimestamp = new Map<string, number>();
  const orderViolations: string[] = [];
  const refused: string[] = [];
  const registered = new Map<string, NativePushRegistration>();
  const authFor = (channelId: string) =>
    `v1.${Buffer.from(`auth:${channelId}`)
      .toString('base64url')
      .padEnd(43, 'x')
      .slice(0, 43)}`;
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const bytes = new Uint8Array(
      init.body as Buffer,
    ) as Uint8Array<ArrayBuffer>;
    const auth = await verifyStationRequest({
      authorization: new Headers(init.headers).get('authorization'),
      body: bytes,
      audiences: [GATEWAY.audience],
      nowSeconds: Math.floor(clock / 1000),
    });
    if (!auth.ok) {
      refused.push(auth.reason);
      return new Response('{}', { status: 401 });
    }
    const body = JSON.parse(Buffer.from(bytes).toString('utf8'));
    const call: GatewayCall = { path, body };
    const nowS = Math.floor(clock / 1000);
    if (path === '/v1/apns/live-activity') {
      expectLiveActivityShape(body, nowS);
      const registration = registered.get(String(body.registrationId));
      if (!registration) throw new Error('unknown registrationId');
      call.card = openCard(String(body.sealed), registration);
      const previous = lastTimestamp.get(String(body.registrationId));
      if (previous !== undefined && Number(body.timestamp) <= previous)
        orderViolations.push(`${previous} then ${body.timestamp}`);
      lastTimestamp.set(String(body.registrationId), Number(body.timestamp));
    } else if (path === '/v1/apns/channels') {
      expectChannelShape(body);
    } else if (path !== '/v1/fcm/send') {
      throw new Error(`unexpected gateway path ${path}`);
    }
    calls.push(call);
    const answer = options.answer?.(call);
    if (answer instanceof Error) throw answer;
    if (answer)
      return Response.json(answer.body ?? {}, { status: answer.status });
    if (path === '/v1/fcm/send') return Response.json({});
    const channelId = String(body.channelId);
    if (path === '/v1/apns/channels') {
      if (!channels.has(channelId))
        return Response.json({ result: 'channel-gone' }, { status: 410 });
      if (channels.get(channelId) !== body.channelAuth)
        return Response.json(
          { result: 'channel-unauthorized' },
          { status: 403 },
        );
      channels.delete(channelId);
      return Response.json({ result: 'deleted' });
    }
    if (body.event === 'start') {
      // The gateway creates the activity's channel inside the start.
      channelCounter += 1;
      const created = Buffer.from(`channel-${channelCounter}`).toString(
        'base64',
      );
      channels.set(created, authFor(created));
      return Response.json({
        result: 'sent',
        channelId: created,
        channelAuth: channels.get(created),
      });
    }
    if (!channels.has(channelId))
      return Response.json({ result: 'channel-gone' }, { status: 410 });
    if (channels.get(channelId) !== body.channelAuth)
      return Response.json({ result: 'channel-unauthorized' }, { status: 403 });
    return Response.json({ result: 'sent' });
  });
  const timers: Array<{ fn: () => void; at: number; live: boolean }> = [];
  const warn = vi.fn();
  const publisher = wireAgentActivityPublisher({
    eventBus,
    devicePairing: pairing,
    signingKey: keys,
    sessionReaderFor: (deviceId) =>
      unreadable.has(deviceId)
        ? null
        : { principalId: 'reader', listSessions: async () => rows },
    gateway: GATEWAY,
    logger: { warn },
    fetchImpl: fetchImpl as unknown as typeof fetch,
    now: () => clock,
    windowMs: 1,
    setTimer: (fn, delayMs) => {
      const timer = { fn, at: clock + delayMs, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
  });
  async function pair(name: string) {
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
    return pairing.exchange({
      offerId: offer.offerId,
      proof: offer.challenge,
      requestId: request.requestId,
    }).device.id;
  }
  async function registerIos(name = 'iPhone', token = IOS_TOKEN) {
    const deviceId = await pair(name);
    const key = await keys.loadOrCreate();
    const registration = pairing.setNativePush(
      deviceId,
      {
        token,
        packageName: 'io.kontourai.station',
        platform: 'ios',
        apnsEnvironment: 'production',
      },
      key.thumbprint,
    );
    registered.set(registration.registrationId, registration);
    return { deviceId, registration };
  }
  async function registerAndroid(name = 'Pixel') {
    const deviceId = await pair(name);
    const key = await keys.loadOrCreate();
    const registration = pairing.setNativePush(
      deviceId,
      {
        token: FCM_TOKEN,
        packageName: 'io.kontourai.station',
        platform: 'android',
      },
      key.thumbprint,
    );
    registered.set(registration.registrationId, registration);
    return { deviceId, registration };
  }
  const liveTimers = () => timers.filter((timer) => timer.live);
  const iosFile = () => {
    const path = join(
      homeDir,
      'security',
      'native-push-ios-registrations.json',
    );
    return existsSync(path)
      ? (JSON.parse(readFileSync(path, 'utf8')) as {
          registrations: Record<string, Record<string, unknown>>;
        })
      : null;
  };
  return {
    homeDir,
    pairing,
    calls,
    channels,
    orderViolations,
    refused,
    registered,
    warn,
    publisher,
    fetchImpl,
    registerIos,
    registerAndroid,
    unreadable,
    iosFile,
    setRows(next: AgentActivitySessionRow[]) {
      rows = next;
    },
    /** A lifecycle event, then everything it queued. */
    async change(next: AgentActivitySessionRow[]) {
      rows = next;
      eventBus.emit(SERVER_EVENTS.ORCHESTRATION_EVENT, {
        event: { method: 'turn.started', threadId: 's1' },
      });
      await publisher.drain();
    },
    async flush() {
      publisher.requestFlush();
      await publisher.drain();
    },
    advance(ms: number) {
      clock += ms;
    },
    now: () => clock,
    liveTimers,
    async fireNextTimer() {
      const next = liveTimers().sort((a, b) => a.at - b.at)[0];
      if (!next) throw new Error('no timer armed');
      clock = Math.max(clock, next.at);
      next.live = false;
      next.fn();
      await publisher.drain();
      return next;
    },
    iosCalls: () => calls.filter((call) => call.path.startsWith('/v1/apns/')),
  };
}

const seconds = (ms: number) => Math.floor(ms / 1000);

const kind = (call: GatewayCall) =>
  call.path === '/v1/apns/channels' ? `delete` : String(call.body.event);

describe('agent-activity publisher: iOS Live Activities', () => {
  test('first active card: one start with no channel; the channel the gateway made is kept on the activity', async () => {
    const h = harness();
    const { deviceId, registration } = await h.registerIos();
    await h.change([row('s1', 'running', START - 1000)]);

    expect(h.refused).toEqual([]);
    expect(h.calls).toHaveLength(1);
    const start = h.calls[0];
    expect(start?.path).toBe('/v1/apns/live-activity');
    expect(start?.body).toEqual({
      bundleId: 'io.kontourai.station',
      environment: 'production',
      event: 'start',
      pushToStartToken: IOS_TOKEN,
      registrationId: registration.registrationId,
      sealed: expect.any(String),
      alert: false,
      timestamp: seconds(START),
      staleAt: seconds(START + 2 * HOUR),
    });
    // The same sealed card an Android phone would get.
    expect(start?.card).toMatchObject({
      user_id: ENVIRONMENT_ID,
      active: 'true',
      activity_line_0: 'Working\tSession s1\tLogin App',
    });
    const [channelId] = [...h.channels.keys()];
    expect(h.iosFile()?.registrations[deviceId]).toMatchObject({
      activity: {
        startedAt: START,
        runId: expect.any(String),
        channelId,
        channelAuth: h.channels.get(channelId ?? ''),
      },
    });
    expect(
      existsSync(join(h.homeDir, 'security', 'native-push-registrations.json')),
    ).toBe(false);
    await h.publisher.stop();
  });

  test('later changes update through the channel with its channelAuth; an approval alerts, once', async () => {
    const h = harness();
    await h.registerIos();
    await h.change([row('s1', 'running', START - 1000)]);
    h.advance(10_000);
    await h.change([
      row('s1', 'running', START - 1000),
      row('s2', 'running', START + 5000),
    ]);
    h.advance(10_000);
    await h.change([
      row('s1', 'approval', START + 15_000),
      row('s2', 'running', START + 5000),
    ]);
    expect(h.iosCalls().map((call) => [kind(call), call.body.alert])).toEqual([
      ['start', false],
      ['update', false],
      ['update', true],
    ]);
    const [channelId] = [...h.channels.keys()];
    for (const update of h.iosCalls().slice(1))
      expect(update.body).toMatchObject({
        channelId,
        channelAuth: h.channels.get(channelId ?? ''),
      });
    expect(h.iosCalls().at(-1)?.card).toMatchObject({
      alert_title: 'Approval needed',
    });
    h.advance(10_000);
    await h.change([
      row('s1', 'approval', START + 15_000),
      row('s2', 'running', START + 5000),
    ]);
    expect(h.iosCalls()).toHaveLength(3);
    expect(h.orderViolations).toEqual([]);
    await h.publisher.stop();
  });

  test('finish: ends with the final card, and the channel is deleted only once the dismissal has passed', async () => {
    const h = harness();
    const { deviceId } = await h.registerIos();
    await h.change([row('s1', 'running', START - 1000)]);
    const [channelId] = [...h.channels.keys()];
    h.advance(10_000);
    const finishedAt = h.now();
    await h.change([row('s1', 'completed', finishedAt)]);
    const end = h.iosCalls().at(-1);
    expect(end?.body).toMatchObject({
      event: 'end',
      channelId,
      alert: true,
      timestamp: seconds(finishedAt),
      // min(card expiry = now + 15 min, now + 4 h)
      dismissAt: seconds(finishedAt + 15 * MINUTE),
    });
    expect(end?.card).toMatchObject({
      active: 'false',
      alert_title: 'Agent finished',
    });
    const stored = h.iosFile()?.registrations[deviceId];
    expect(stored?.activity).toBeUndefined();
    expect(stored?.channelDeletes).toEqual([
      {
        bundleId: 'io.kontourai.station',
        environment: 'production',
        channelId,
        channelAuth: h.channels.get(channelId ?? ''),
        deleteAt: seconds(finishedAt + 15 * MINUTE) * 1000,
      },
    ]);
    // Still on screen: nothing deleted yet.
    expect(h.channels.has(channelId ?? '')).toBe(true);
    const fired = await h.fireNextTimer();
    expect(fired.at).toBe(seconds(finishedAt + 15 * MINUTE) * 1000);
    expect(h.iosCalls().at(-1)?.body).toEqual({
      op: 'delete',
      bundleId: 'io.kontourai.station',
      environment: 'production',
      channelId,
      channelAuth: expect.stringMatching(CHANNEL_AUTH),
    });
    expect(h.channels.size).toBe(0);
    expect(
      h.iosFile()?.registrations[deviceId]?.channelDeletes,
    ).toBeUndefined();
    await h.publisher.stop();
  });

  test('a device that loses read access has its activity ended at once and its channel deleted in the same flush', async () => {
    const h = harness();
    const { deviceId } = await h.registerIos();
    await h.change([row('s1', 'running', START - 1000)]);
    h.unreadable.add(deviceId);
    h.advance(10_000);
    await h.change([row('s1', 'running', START - 1000)]);
    const [end, remove] = h.iosCalls().slice(-2);
    expect(end?.body).toMatchObject({
      event: 'end',
      alert: false,
      dismissAt: seconds(h.now()),
    });
    expect(end?.card).toMatchObject({ active: 'false' });
    expect(end?.card?.activity_line_0).toBeUndefined();
    expect(remove?.body.op).toBe('delete');
    expect(h.channels.size).toBe(0);
    expect(h.iosFile()?.registrations[deviceId]?.activity).toBeUndefined();
    await h.publisher.stop();
  });

  test('410 unregistered at start: the registration is cleared; the gateway already dropped the channel', async () => {
    const h = harness({
      answer: (call) =>
        call.body.event === 'start'
          ? { status: 410, body: { result: 'unregistered' } }
          : undefined,
    });
    const { deviceId } = await h.registerIos();
    await h.change([row('s1', 'running', START - 1000)]);
    expect(h.pairing.listNativePushRegistrations()).toEqual([]);
    expect(h.iosFile()?.registrations[deviceId]).toBeUndefined();
    expect(h.iosCalls().map(kind)).toEqual(['start']);
    await h.publisher.stop();
  });

  test.each([
    ['410 channel-gone', 'gone'],
    ['403 channel-unauthorized', 'unauthorized'],
  ] as const)(
    '%s on an update: the activity is forgotten, and the retry starts afresh',
    async (_label, how) => {
      const h = harness();
      const { deviceId } = await h.registerIos();
      await h.change([row('s1', 'running', START - 1000)]);
      const [first] = [...h.channels.keys()];
      if (how === 'gone') h.channels.clear();
      else h.channels.set(first ?? '', `v1.${'Z'.repeat(43)}`);
      h.advance(10_000);
      await h.change([row('s1', 'approval', h.now())]);
      expect(h.iosCalls().map(kind)).toEqual(['start', 'update']);
      expect(h.iosFile()?.registrations[deviceId]?.activity).toBeUndefined();
      // Nothing to delete: the channel is gone or no longer ours.
      expect(
        h.iosFile()?.registrations[deviceId]?.channelDeletes,
      ).toBeUndefined();
      const retry = await h.fireNextTimer();
      expect(retry.at).toBe(START + 10_000 + 5_000);
      expect(h.iosCalls().map(kind)).toEqual(['start', 'update', 'start']);
      expect(h.iosCalls().at(-1)?.body.alert).toBe(true);
      const activity = h.iosFile()?.registrations[deviceId]?.activity as
        | { channelId: string }
        | undefined;
      expect(activity?.channelId).toBeDefined();
      expect(activity?.channelId).not.toBe(first);
      await h.publisher.stop();
    },
  );

  test('a fresh channelAuth in a 200 (secret rotation) is stored and used from then on', async () => {
    const rotated = `v1.${'R'.repeat(43)}`;
    let answered = false;
    const h = harness({
      answer: (call) => {
        if (call.body.event !== 'update' || answered) return undefined;
        answered = true;
        return { status: 200, body: { result: 'sent', channelAuth: rotated } };
      },
    });
    const { deviceId } = await h.registerIos();
    await h.change([row('s1', 'running', START - 1000)]);
    const [channelId] = [...h.channels.keys()];
    h.advance(10_000);
    await h.change([row('s1', 'approval', h.now())]);
    const stored = h.iosFile()?.registrations[deviceId]?.activity as
      | { channelAuth: string }
      | undefined;
    expect(stored?.channelAuth).toBe(rotated);
    // The gateway now only accepts the rotated proof.
    h.channels.set(channelId ?? '', rotated);
    h.advance(10_000);
    await h.change([row('s1', 'running', h.now())]);
    expect(h.iosCalls().at(-1)?.body).toMatchObject({
      event: 'update',
      channelAuth: rotated,
    });
    expect(h.iosFile()?.registrations[deviceId]?.activity).toBeDefined();
    await h.publisher.stop();
  });

  test('a restart resumes the persisted activity: an update through its channel, no second start', async () => {
    const first = harness();
    await first.registerIos();
    await first.change([row('s1', 'running', START - 1000)]);
    await first.publisher.stop();
    const [channelId] = [...first.channels.keys()];
    const channelAuth = first.channels.get(channelId ?? '');

    const restarted = harness({
      homeDir: first.homeDir,
      answer: (call) =>
        call.body.channelId === channelId &&
        call.body.channelAuth === channelAuth
          ? { status: 200, body: { result: 'sent' } }
          : undefined,
    });
    for (const [id, registration] of first.registered)
      restarted.registered.set(id, registration);
    restarted.setRows([row('s1', 'running', START - 1000)]);
    restarted.advance(60_000);
    await restarted.fireNextTimer(); // the boot flush
    expect(restarted.iosCalls().map(kind)).toEqual(['update']);
    expect(restarted.iosCalls()[0]?.body).toMatchObject({
      channelId,
      channelAuth,
    });
    expect(Number(restarted.iosCalls()[0]?.body.timestamp)).toBeGreaterThan(
      Number(first.iosCalls().at(-1)?.body.timestamp),
    );
    await restarted.publisher.stop();
  });

  test('a restart still deletes the channel of an activity ended before it', async () => {
    const first = harness();
    await first.registerIos();
    await first.change([row('s1', 'running', START - 1000)]);
    first.advance(10_000);
    await first.change([row('s1', 'completed', first.now())]);
    await first.publisher.stop();
    const [channelId] = [...first.channels.keys()];

    const restarted = harness({ homeDir: first.homeDir });
    for (const [id, registration] of first.registered)
      restarted.registered.set(id, registration);
    restarted.setRows([row('s1', 'completed', START + 10_000)]);
    restarted.advance(20 * MINUTE);
    await restarted.fireNextTimer(); // the boot flush
    expect(restarted.iosCalls()).toHaveLength(1);
    expect(restarted.iosCalls()[0]?.body).toMatchObject({
      op: 'delete',
      channelId,
      channelAuth: first.channels.get(channelId ?? ''),
    });
    await restarted.publisher.stop();
  });

  test('rollover at 7 h 30 m: end now, delete its channel, start fresh on a new one; timestamps strictly increasing', async () => {
    const h = harness();
    const { deviceId } = await h.registerIos();
    await h.change([row('s1', 'running', START - 1000)]);
    const [first] = [...h.channels.keys()];
    while (h.now() < START + LIVE_ACTIVITY_ROLLOVER_AFTER_MS)
      await h.fireNextTimer();
    const kinds = h.iosCalls().map(kind);
    expect(kinds[0]).toBe('start');
    expect(kinds.slice(-3)).toEqual(['end', 'start', 'delete']);
    expect(kinds.slice(1, -3).every((k) => k === 'update')).toBe(true);
    const [end, start, remove] = h.iosCalls().slice(-3);
    expect(end?.body).toMatchObject({ channelId: first });
    expect(end?.body.dismissAt).toBe(end?.body.timestamp);
    expect(Number(start?.body.timestamp)).toBe(Number(end?.body.timestamp) + 1);
    expect(remove?.body.channelId).toBe(first);
    expect(h.orderViolations).toEqual([]);
    const activity = h.iosFile()?.registrations[deviceId]?.activity as
      | { startedAt: number; channelId: string }
      | undefined;
    expect(activity?.startedAt).toBe(h.now());
    expect(activity?.channelId).not.toBe(first);
    expect([...h.channels.keys()]).toEqual([activity?.channelId]);
    await h.publisher.stop();
  });

  test('pacing and backoff are shared with Android: 3 s per phone, backoff on 429', async () => {
    let busy = 0;
    const h = harness({
      answer: (call) => {
        if (!(busy > 0 && call.body.event === 'update')) return undefined;
        busy -= 1;
        return { status: 429, body: {} };
      },
    });
    await h.registerIos();
    await h.change([row('s1', 'running', START - 1000)]);
    h.advance(1_000);
    await h.change([row('s1', 'approval', h.now())]);
    expect(h.iosCalls()).toHaveLength(1);
    const held = await h.fireNextTimer();
    expect(held.at).toBe(START + 3_000);
    expect(h.iosCalls().at(-1)?.body.event).toBe('update');
    busy = 1;
    h.advance(10_000);
    const before = h.iosCalls().length;
    await h.change([row('s1', 'running', h.now())]);
    expect(h.iosCalls()).toHaveLength(before + 1);
    const retry = await h.fireNextTimer();
    expect(retry.at - (START + 13_000)).toBe(5_000);
    expect(h.iosCalls()).toHaveLength(before + 2);
    expect(h.iosCalls().at(-1)?.body.event).toBe('update');
    await h.publisher.stop();
  });

  test('a channel delete that fails is retried with backoff and stays queued until it succeeds', async () => {
    let failures = 1;
    const h = harness({
      answer: (call) => {
        if (!(call.body.op === 'delete' && failures > 0)) return undefined;
        failures -= 1;
        return { status: 503, body: {} };
      },
    });
    const { deviceId } = await h.registerIos();
    await h.change([row('s1', 'running', START - 1000)]);
    h.unreadable.add(deviceId);
    h.advance(10_000);
    await h.change([row('s1', 'running', START - 1000)]);
    expect(h.iosCalls().map(kind)).toEqual(['start', 'end', 'delete']);
    expect(h.iosFile()?.registrations[deviceId]?.channelDeletes).toHaveLength(
      1,
    );
    const retry = await h.fireNextTimer();
    expect(retry.at).toBe(START + 10_000 + 5_000);
    expect(h.iosCalls().map(kind)).toEqual([
      'start',
      'end',
      'delete',
      'delete',
    ]);
    expect(h.channels.size).toBe(0);
    expect(
      h.iosFile()?.registrations[deviceId]?.channelDeletes,
    ).toBeUndefined();
    await h.publisher.stop();
  });

  test('Android and iOS phones side by side: each gets its own route, Android unchanged', async () => {
    const h = harness();
    await h.registerAndroid();
    await h.registerIos();
    await h.change([row('s1', 'running', START - 1000)]);
    expect(h.calls.map((call) => call.path).sort()).toEqual([
      '/v1/apns/live-activity',
      '/v1/fcm/send',
    ]);
    const fcm = h.calls.find((call) => call.path === '/v1/fcm/send');
    expect(Object.keys(fcm?.body ?? {}).sort()).toEqual([
      'data',
      'packageName',
      'token',
    ]);
    expect(fcm?.body.token).toBe(FCM_TOKEN);
    await h.publisher.stop();
  });
});
