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
  'channelId',
  'environment',
  'event',
  'registrationId',
  'sealed',
  'timestamp',
];

/** The documented `/v1/apns/live-activity` body, checked at gateway time `nowS`. */
function expectLiveActivityShape(body: Record<string, unknown>, nowS: number) {
  const extra =
    body.event === 'start'
      ? ['pushToStartToken', 'staleAt']
      : body.event === 'update'
        ? ['staleAt']
        : ['dismissAt'];
  expect(Object.keys(body).sort()).toEqual([...COMMON_KEYS, ...extra].sort());
  expect(['start', 'update', 'end']).toContain(body.event);
  expect(NATIVE_PUSH_IOS_BUNDLES).toContain(body.bundleId);
  expect(['production', 'sandbox']).toContain(body.environment);
  expect(typeof body.channelId).toBe('string');
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

/** The documented `/v1/apns/channels` body. */
function expectChannelShape(body: Record<string, unknown>) {
  expect(Object.keys(body).sort()).toEqual(
    body.op === 'create'
      ? ['bundleId', 'environment', 'op']
      : ['bundleId', 'channelId', 'environment', 'op'],
  );
  expect(['create', 'delete']).toContain(body.op);
  expect(NATIVE_PUSH_IOS_BUNDLES).toContain(body.bundleId);
  expect(['production', 'sandbox']).toContain(body.environment);
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
  const channels = new Set<string>();
  let channelCounter = 0;
  const lastTimestamp = new Map<string, number>();
  const orderViolations: string[] = [];
  const refused: string[] = [];
  const registered = new Map<string, NativePushRegistration>();
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
    if (path === '/v1/apns/channels' && body.op === 'create') {
      channelCounter += 1;
      const channelId = Buffer.from(`channel-${channelCounter}`).toString(
        'base64',
      );
      channels.add(channelId);
      return Response.json({ result: 'created', channelId });
    }
    if (path === '/v1/apns/channels') {
      channels.delete(String(body.channelId));
      return Response.json({ result: 'deleted' });
    }
    if (
      path === '/v1/apns/live-activity' &&
      !channels.has(String(body.channelId))
    )
      return Response.json({ result: 'channel-gone' }, { status: 410 });
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

describe('agent-activity publisher: iOS Live Activities', () => {
  test('first active card: creates the channel, then starts the activity through it', async () => {
    const h = harness();
    const { deviceId, registration } = await h.registerIos();
    await h.change([row('s1', 'running', START - 1000)]);

    expect(h.refused).toEqual([]);
    const [create, start, ...rest] = h.calls;
    expect(rest).toEqual([]);
    expect(create?.path).toBe('/v1/apns/channels');
    expect(create?.body).toEqual({
      op: 'create',
      bundleId: 'io.kontourai.station',
      environment: 'production',
    });
    const channelId = [...h.channels][0];
    expect(start?.path).toBe('/v1/apns/live-activity');
    expect(start?.body).toEqual({
      bundleId: 'io.kontourai.station',
      environment: 'production',
      event: 'start',
      pushToStartToken: IOS_TOKEN,
      channelId,
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
    // Channel and activity persisted to the iOS file.
    expect(h.iosFile()?.registrations[deviceId]).toMatchObject({
      channelId,
      activity: { startedAt: START, runId: expect.any(String) },
    });
    expect(
      existsSync(join(h.homeDir, 'security', 'native-push-registrations.json')),
    ).toBe(false);
    await h.publisher.stop();
  });

  test('a later change updates the same channel; an approval updates with an alert, once', async () => {
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
    const events = h
      .iosCalls()
      .map((call) => [
        call.path === '/v1/apns/channels'
          ? `channel:${call.body.op}`
          : call.body.event,
        call.body.alert,
      ]);
    expect(events).toEqual([
      ['channel:create', undefined],
      ['start', false],
      ['update', false],
      ['update', true],
    ]);
    const approval = h.iosCalls().at(-1);
    expect(approval?.card).toMatchObject({ alert_title: 'Approval needed' });
    // Nothing new: no further request, and the alert is not raised again.
    h.advance(10_000);
    await h.change([
      row('s1', 'approval', START + 15_000),
      row('s2', 'running', START + 5000),
    ]);
    expect(h.iosCalls()).toHaveLength(4);
    expect(h.orderViolations).toEqual([]);
    await h.publisher.stop();
  });

  test('finish: ends with the final card, dismissed at its expiry, alerting the finish', async () => {
    const h = harness();
    const { deviceId } = await h.registerIos();
    await h.change([row('s1', 'running', START - 1000)]);
    h.advance(10_000);
    const finishedAt = h.now();
    await h.change([row('s1', 'completed', finishedAt)]);
    const end = h.iosCalls().at(-1);
    expect(end?.body).toMatchObject({
      event: 'end',
      alert: true,
      timestamp: seconds(finishedAt),
      // min(card expiry = now + 15 min, now + 4 h)
      dismissAt: seconds(finishedAt + 15 * MINUTE),
    });
    expect(end?.card).toMatchObject({
      active: 'false',
      alert_title: 'Agent finished',
    });
    expect(h.iosFile()?.registrations[deviceId]?.activity).toBeUndefined();
    // The channel stays for the next activity.
    expect(h.iosFile()?.registrations[deviceId]?.channelId).toBeDefined();
    // Finished and ended: nothing more is sent for this card.
    h.advance(10_000);
    await h.flush();
    expect(h.iosCalls().at(-1)).toBe(end);
    await h.publisher.stop();
  });

  test('a device that loses read access has its activity ended at once', async () => {
    const h = harness();
    const { deviceId } = await h.registerIos();
    await h.change([row('s1', 'running', START - 1000)]);
    h.unreadable.add(deviceId);
    h.advance(10_000);
    await h.change([row('s1', 'running', START - 1000)]);
    const end = h.iosCalls().at(-1);
    expect(end?.body).toMatchObject({
      event: 'end',
      alert: false,
      dismissAt: seconds(h.now()),
    });
    // No session content survives on the ended activity.
    expect(end?.card).toMatchObject({ active: 'false' });
    expect(end?.card?.activity_line_0).toBeUndefined();
    expect(h.iosFile()?.registrations[deviceId]?.activity).toBeUndefined();
    await h.publisher.stop();
  });

  test('410 unregistered: the registration is cleared and its channel deleted', async () => {
    let dead = false;
    const h = harness({
      answer: (call) =>
        dead && call.body.event === 'update'
          ? { status: 410, body: { result: 'unregistered' } }
          : undefined,
    });
    const { deviceId } = await h.registerIos();
    await h.change([row('s1', 'running', START - 1000)]);
    const channelId = [...h.channels][0];
    dead = true;
    h.advance(10_000);
    await h.change([row('s1', 'approval', h.now())]);
    expect(h.pairing.listNativePushRegistrations()).toEqual([]);
    expect(h.iosFile()?.registrations[deviceId]).toBeUndefined();
    expect(h.iosCalls().at(-1)?.body).toEqual({
      op: 'delete',
      bundleId: 'io.kontourai.station',
      environment: 'production',
      channelId,
    });
    expect(h.channels.size).toBe(0);
    await h.publisher.stop();
  });

  test('410 channel-gone: the channel and activity are forgotten, and the next flush starts over on a new channel', async () => {
    const h = harness();
    const { deviceId } = await h.registerIos();
    await h.change([row('s1', 'running', START - 1000)]);
    const first = [...h.channels][0];
    // Apple dropped the channel.
    h.channels.clear();
    h.advance(10_000);
    await h.change([row('s1', 'approval', h.now())]);
    expect(h.iosCalls().at(-1)?.body.event).toBe('update');
    expect(h.iosFile()?.registrations[deviceId]?.channelId).toBeUndefined();
    expect(h.iosFile()?.registrations[deviceId]?.activity).toBeUndefined();
    // The backoff timer retries: new channel, then a start (not an update).
    const before = h.iosCalls().length;
    await h.fireNextTimer();
    const retried = h.iosCalls().slice(before);
    expect(retried.map((call) => call.body.op ?? call.body.event)).toEqual([
      'create',
      'start',
    ]);
    const second = [...h.channels][0];
    expect(second).not.toBe(first);
    expect(retried[1]?.body.channelId).toBe(second);
    expect(retried[1]?.body.alert).toBe(true);
    expect(h.iosFile()?.registrations[deviceId]?.channelId).toBe(second);
    await h.publisher.stop();
  });

  test('a restart resumes the persisted activity: an update to the same channel, no second start or channel', async () => {
    const first = harness();
    await first.registerIos();
    await first.change([row('s1', 'running', START - 1000)]);
    await first.publisher.stop();
    const channelId = [...first.channels][0];

    const restarted = harness({
      homeDir: first.homeDir,
      answer: (call) =>
        call.path === '/v1/apns/live-activity' &&
        call.body.channelId === channelId
          ? { status: 200, body: { result: 'sent' } }
          : undefined,
    });
    for (const [id, registration] of first.registered)
      restarted.registered.set(id, registration);
    // The same sessions, still running.
    restarted.setRows([row('s1', 'running', START - 1000)]);
    restarted.advance(60_000);
    await restarted.fireNextTimer(); // the boot flush
    expect(restarted.iosCalls().map((call) => call.body.event)).toEqual([
      'update',
    ]);
    expect(restarted.iosCalls()[0]?.body.channelId).toBe(channelId);
    // Its timestamp still follows the one sent before the restart.
    expect(Number(restarted.iosCalls()[0]?.body.timestamp)).toBeGreaterThan(
      Number(first.iosCalls().at(-1)?.body.timestamp),
    );
    await restarted.publisher.stop();
  });

  test('rollover: after 7 h 30 m an unchanged activity is ended and started again, timestamps strictly increasing', async () => {
    const h = harness();
    const { deviceId } = await h.registerIos();
    const rows = [row('s1', 'running', START - 1000)];
    await h.change(rows);
    // Refreshes and the rollover arrive on their own timers.
    while (h.now() < START + LIVE_ACTIVITY_ROLLOVER_AFTER_MS)
      await h.fireNextTimer();
    const kinds = h.iosCalls().map((call) => call.body.op ?? call.body.event);
    expect(kinds.slice(0, 2)).toEqual(['create', 'start']);
    expect(kinds.slice(-2)).toEqual(['end', 'start']);
    expect(kinds.slice(2, -2).every((kind) => kind === 'update')).toBe(true);
    const [end, start] = h.iosCalls().slice(-2);
    expect(end?.body.dismissAt).toBe(end?.body.timestamp);
    expect(Number(start?.body.timestamp)).toBe(Number(end?.body.timestamp) + 1);
    expect(h.orderViolations).toEqual([]);
    expect(h.iosFile()?.registrations[deviceId]?.activity).toMatchObject({
      startedAt: h.now(),
    });
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
    // A change inside the 3 s interval is held for the timer.
    h.advance(1_000);
    await h.change([row('s1', 'approval', h.now())]);
    expect(h.iosCalls()).toHaveLength(2);
    const held = await h.fireNextTimer();
    expect(held.at).toBe(START + 3_000);
    expect(h.iosCalls().at(-1)?.body.event).toBe('update');
    // 429: retried with backoff (5 s), not at once.
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

  test('a channel that cannot be created is retried with backoff and no start is sent', async () => {
    let failures = 1;
    const h = harness({
      answer: (call) => {
        if (!(call.body.op === 'create' && failures > 0)) return undefined;
        failures -= 1;
        return { status: 503, body: {} };
      },
    });
    await h.registerIos();
    await h.change([row('s1', 'running', START - 1000)]);
    expect(h.iosCalls().map((call) => call.body.op ?? call.body.event)).toEqual(
      ['create'],
    );
    await h.fireNextTimer();
    expect(h.iosCalls().map((call) => call.body.op ?? call.body.event)).toEqual(
      ['create', 'create', 'start'],
    );
    await h.publisher.stop();
  });

  test('Android and iOS phones side by side: each gets its own route, Android unchanged', async () => {
    const h = harness();
    await h.registerAndroid();
    await h.registerIos();
    await h.change([row('s1', 'running', START - 1000)]);
    const paths = h.calls.map((call) => call.path).sort();
    expect(paths).toEqual([
      '/v1/apns/channels',
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
