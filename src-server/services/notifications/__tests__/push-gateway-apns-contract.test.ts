/**
 * The Station's iOS publisher against the REAL push gateway: every request
 * the publisher sends (start, update, end, channel delete, with and without
 * an alert, after a channel-secret rotation) goes through the gateway's own
 * `handleRequest` — signature check, `parseLiveActivityRequest` /
 * `parseChannelRequest`, channelAuth, APNs payload — to a fake Apple, and
 * every answer the gateway builds from Apple's (sent with a channel, 410
 * unregistered and channel-gone, 403 channel-unauthorized, 422, 503, a fresh
 * channelAuth on rotation) comes back to the publisher. A body the gateway
 * would refuse, or an answer the Station misreads, fails here.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NATIVE_PUSH_IOS_BUNDLES } from '@kontourai/station-contracts/native-push';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { EventBus } from '../../orchestration/event-bus.js';
import { DevicePairingService } from '../../ssh/device-pairing-service.js';
import {
  type AgentActivitySessionRow,
  resolvePushGatewayConfig,
  wireAgentActivityPublisher,
} from '../agent-activity-publisher.js';
import { PushSigningKeyStore } from '../push-signing-key-store.js';

// The gateway's sources import each other with `.ts` specifiers, which its
// own tsconfig allows and Station's test tsconfig does not. So the two
// modules this test drives are loaded by path at run time and typed here by
// the members it uses; `tsc -p deploy/push-gateway/tsconfig.json` checks
// the gateway itself.
interface ChannelAuthSecrets {
  current: string;
  previous?: string;
}
type GatewayConfig = Record<string, unknown>;
const GATEWAY_MODULE = '../../../../deploy/push-gateway/src/gateway.js';
const GATEWAY_HELPERS = '../../../../deploy/push-gateway/test/helpers.js';
const { handleRequest } = (await import(GATEWAY_MODULE)) as {
  handleRequest(request: Request, config: GatewayConfig): Promise<Response>;
};
const { allow, fakeApnsKey, fakeLedger } = (await import(GATEWAY_HELPERS)) as {
  allow: unknown;
  fakeApnsKey(): Promise<{ credentials: unknown }>;
  fakeLedger(): unknown;
};

const ENVIRONMENT_ID = '11111111-1111-4111-8111-111111111111';
const GATEWAY = resolvePushGatewayConfig({})!;
const START = Date.parse('2026-09-24T10:00:00.000Z');
const IOS_TOKEN = 'ab'.repeat(40);
const SECRET_A = 'channel-auth-secret-A-0123456789abcdef0123';
const SECRET_B = 'channel-auth-secret-B-0123456789abcdef0123';
const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

type AppleKind = 'create' | 'delete' | 'start' | 'broadcast';
type AppleReply = (body: string) => Response | undefined;

const appleKind = (url: string, method: string): AppleKind | 'other' =>
  url.includes('api-manage-broadcast')
    ? method === 'POST'
      ? 'create'
      : 'delete'
    : url.includes('/3/device/')
      ? 'start'
      : url.includes('/4/broadcasts/')
        ? 'broadcast'
        : 'other';

const appleError = (status: number, reason: string) =>
  Response.json({ reason }, { status });

function row(state: 'running' | 'approval' | 'completed', at: number) {
  return {
    sessionId: 's1',
    title: 'Fix the login test',
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
    entry: { key: `s1:${state}:${at}`, at },
  } as AgentActivitySessionRow;
}

async function harness() {
  const homeDir = mkdtempSync(join(tmpdir(), 'station-apns-contract-'));
  homes.push(homeDir);
  mkdirSync(join(homeDir, 'security'), { mode: 0o700 });
  const pairing = new DevicePairingService({
    homeDir,
    environmentId: ENVIRONMENT_ID,
  });
  const keys = new PushSigningKeyStore(homeDir, () => pairing.environmentId());
  const eventBus = new EventBus();
  let clock = START;
  let rows: AgentActivitySessionRow[] = [];
  const secrets: { value: ChannelAuthSecrets } = {
    value: { current: SECRET_A },
  };
  // Fake Apple: every kind succeeds unless a reply is queued for it.
  const appleReplies: Partial<Record<AppleKind, AppleReply[]>> = {};
  const appleCalls: Array<{ kind: AppleKind; body: string }> = [];
  let channelCounter = 0;
  const appleFetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    const kind = appleKind(url, init?.method ?? 'GET');
    if (kind === 'other') throw new Error(`unexpected upstream ${url}`);
    const body =
      init?.body instanceof Uint8Array
        ? new TextDecoder().decode(init.body)
        : String(init?.body ?? '');
    appleCalls.push({ kind, body });
    const reply = appleReplies[kind]?.shift()?.(body);
    if (reply) return reply;
    if (kind === 'create') {
      channelCounter += 1;
      return new Response(null, {
        status: 201,
        headers: {
          'apns-channel-id': Buffer.from(
            `apple-channel-${channelCounter}`,
          ).toString('base64'),
        },
      });
    }
    return new Response(null, { status: kind === 'delete' ? 204 : 200 });
  }) as typeof fetch;
  const apnsKey = await fakeApnsKey();
  const ledger = fakeLedger();
  const gatewayConfig = (): GatewayConfig => ({
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
      channelAuth: secrets.value,
      channelPerIpLimiter: allow,
      channelPerDeviceLimiter: allow,
      channelPerKeyLimiter: allow,
      channelGlobalLimiter: allow,
      channelDeleteLimiter: allow,
      ledger,
    },
    fetchImpl: appleFetch,
    nowSeconds: () => Math.floor(clock / 1000),
  });
  /** Every exchange between the Station and the real gateway. */
  const exchanges: Array<{
    path: string;
    request: Record<string, unknown>;
    status: number;
    answer: Record<string, unknown>;
  }> = [];
  const stationFetch = vi.fn(async (url: string, init: RequestInit) => {
    const response = await handleRequest(
      new Request(url, init),
      gatewayConfig(),
    );
    const answer = (await response.clone().json()) as Record<string, unknown>;
    exchanges.push({
      path: new URL(url).pathname,
      request: JSON.parse(
        Buffer.from(init.body as Uint8Array).toString('utf8'),
      ),
      status: response.status,
      answer,
    });
    return response;
  });
  const timers: Array<{ fn: () => void; at: number; live: boolean }> = [];
  const warn = vi.fn();
  const publisher = wireAgentActivityPublisher({
    eventBus,
    devicePairing: pairing,
    signingKey: keys,
    sessionReaderFor: () => ({
      principalId: 'reader',
      listSessions: async () => rows,
    }),
    gateway: GATEWAY,
    logger: { warn },
    fetchImpl: stationFetch as unknown as typeof fetch,
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
  const registration = pairing.setNativePush(
    deviceId,
    {
      token: IOS_TOKEN,
      packageName: 'io.kontourai.station',
      platform: 'ios',
      apnsEnvironment: 'production',
    },
    key.thumbprint,
  );
  const iosRecord = () =>
    (
      JSON.parse(
        readFileSync(
          join(homeDir, 'security', 'native-push-ios-registrations.json'),
          'utf8',
        ),
      ) as { registrations: Record<string, Record<string, unknown>> }
    ).registrations[deviceId];
  const liveTimers = () => timers.filter((timer) => timer.live);
  return {
    pairing,
    deviceId,
    registration,
    secrets,
    appleReplies,
    appleCalls,
    exchanges,
    warn,
    publisher,
    iosRecord,
    liveTimers,
    advance(ms: number) {
      clock += ms;
    },
    now: () => clock,
    async change(next: AgentActivitySessionRow[]) {
      rows = next;
      eventBus.emit(SERVER_EVENTS.ORCHESTRATION_EVENT, {
        event: { method: 'turn.started', threadId: 's1' },
      });
      await publisher.drain();
    },
    async fireNextTimer() {
      const next = liveTimers().sort((a, b) => a.at - b.at)[0];
      if (!next) throw new Error('no timer armed');
      clock = Math.max(clock, next.at);
      next.live = false;
      next.fn();
      await publisher.drain();
      return next;
    },
    /** The gateway refused no body as malformed or unsigned. */
    expectEveryRequestParsed() {
      expect(
        exchanges.filter(
          (entry) => entry.status === 400 || entry.status === 401,
        ),
      ).toEqual([]);
    },
  };
}

const activityOf = (record: Record<string, unknown> | undefined) =>
  record?.activity as
    | { channelId: string; channelAuth: string; lastTimestamp: number }
    | undefined;

describe('Station iOS publisher against the real push gateway', () => {
  test('the gateway allows exactly the iOS bundles the Station registers', () => {
    const wrangler = readFileSync(
      join(process.cwd(), 'deploy/push-gateway/wrangler.jsonc'),
      'utf8',
    );
    const allowed = /"ALLOWED_IOS_BUNDLES":\s*"([^"]*)"/.exec(wrangler)?.[1];
    expect(allowed?.split(',').sort()).toEqual(
      [...NATIVE_PUSH_IOS_BUNDLES].sort(),
    );
  });

  test('start, update, alerting update, end with an alert, and the channel delete are all accepted, and the start answer is stored', async () => {
    const h = await harness();
    await h.change([row('running', START - 1000)]);
    const [start] = h.exchanges;
    expect(start?.status).toBe(200);
    expect(start?.answer).toEqual({
      result: 'sent',
      channelId: expect.any(String),
      channelAuth: expect.stringMatching(/^v1\.[A-Za-z0-9_-]{43}$/),
    });
    expect(activityOf(h.iosRecord())).toMatchObject({
      channelId: start?.answer.channelId,
      channelAuth: start?.answer.channelAuth,
    });
    h.advance(10_000);
    await h.change([
      row('running', START - 1000),
      { ...row('running', START + 5000), sessionId: 's2', title: 'Second' },
    ]);
    h.advance(10_000);
    await h.change([row('approval', h.now())]);
    h.advance(10_000);
    await h.change([row('completed', h.now())]);
    // The channel is deleted once the finished card's dismissal has passed.
    while (h.liveTimers().length > 0) await h.fireNextTimer();
    h.expectEveryRequestParsed();
    expect(
      h.exchanges.map((entry) => [
        entry.request.event ?? entry.request.op,
        entry.request.alert,
        entry.status,
        entry.answer.result,
      ]),
    ).toEqual([
      ['start', false, 200, 'sent'],
      ['update', false, 200, 'sent'],
      ['update', true, 200, 'sent'],
      ['end', true, 200, 'sent'],
      ['delete', undefined, 200, 'deleted'],
    ]);
    expect(h.appleCalls.map((call) => call.kind)).toEqual([
      'create',
      'start',
      'broadcast',
      'broadcast',
      'broadcast',
      'delete',
    ]);
    expect(h.iosRecord()?.activity).toBeUndefined();
    expect(h.iosRecord()?.channelDeletes).toBeUndefined();
    await h.publisher.stop();
  });

  test('a secret rotation: the fresh channelAuth in a 200 is stored and accepted under the new secret alone', async () => {
    const h = await harness();
    await h.change([row('running', START - 1000)]);
    const first = activityOf(h.iosRecord())?.channelAuth;
    h.secrets.value = { current: SECRET_B, previous: SECRET_A };
    h.advance(10_000);
    await h.change([row('approval', h.now())]);
    const rotated = h.exchanges.at(-1)?.answer.channelAuth;
    expect(rotated).toEqual(expect.stringMatching(/^v1\./));
    expect(rotated).not.toBe(first);
    expect(activityOf(h.iosRecord())?.channelAuth).toBe(rotated);
    h.secrets.value = { current: SECRET_B };
    h.advance(10_000);
    await h.change([row('running', h.now())]);
    expect(h.exchanges.at(-1)).toMatchObject({
      status: 200,
      answer: { result: 'sent' },
    });
    h.expectEveryRequestParsed();
    await h.publisher.stop();
  });

  test('403 channel-unauthorized (the secret changed outright): the activity is forgotten and the retry starts afresh', async () => {
    const h = await harness();
    await h.change([row('running', START - 1000)]);
    h.secrets.value = { current: SECRET_B };
    h.advance(10_000);
    await h.change([row('approval', h.now())]);
    expect(h.exchanges.at(-1)).toMatchObject({
      status: 403,
      answer: { result: 'channel-unauthorized' },
    });
    expect(h.iosRecord()?.activity).toBeUndefined();
    await h.fireNextTimer();
    expect(h.exchanges.at(-1)).toMatchObject({
      request: { event: 'start' },
      status: 200,
      answer: { result: 'sent' },
    });
    expect(activityOf(h.iosRecord())?.channelAuth).toBe(
      h.exchanges.at(-1)?.answer.channelAuth,
    );
    h.expectEveryRequestParsed();
    await h.publisher.stop();
  });

  test('410 channel-gone (Apple: ChannelNotRegistered): the activity is forgotten and the retry starts afresh', async () => {
    const h = await harness();
    await h.change([row('running', START - 1000)]);
    h.appleReplies.broadcast = [() => appleError(400, 'ChannelNotRegistered')];
    h.advance(10_000);
    await h.change([row('approval', h.now())]);
    expect(h.exchanges.at(-1)).toMatchObject({
      status: 410,
      answer: { result: 'channel-gone' },
    });
    expect(h.iosRecord()?.activity).toBeUndefined();
    await h.fireNextTimer();
    expect(h.exchanges.at(-1)?.request.event).toBe('start');
    expect(activityOf(h.iosRecord())).toBeDefined();
    h.expectEveryRequestParsed();
    await h.publisher.stop();
  });

  test('410 unregistered at start (Apple: Unregistered): the registration is cleared, and the gateway already gave the channel back', async () => {
    const h = await harness();
    h.appleReplies.start = [() => appleError(410, 'Unregistered')];
    await h.change([row('running', START - 1000)]);
    expect(h.exchanges).toHaveLength(1);
    expect(h.exchanges[0]).toMatchObject({
      status: 410,
      answer: { result: 'unregistered' },
    });
    expect(h.pairing.listNativePushRegistrations()).toEqual([]);
    expect(h.appleCalls.map((call) => call.kind)).toEqual([
      'create',
      'start',
      'delete',
    ]);
    await h.publisher.stop();
  });

  test('422 rejected (Apple: BadDate): the card is done with, not retried', async () => {
    const h = await harness();
    await h.change([row('running', START - 1000)]);
    h.appleReplies.broadcast = [() => appleError(400, 'BadDate')];
    h.advance(10_000);
    await h.change([row('approval', h.now())]);
    expect(h.exchanges.at(-1)).toMatchObject({
      status: 422,
      answer: { result: 'rejected' },
    });
    const sent = h.exchanges.length;
    // Only the card's own refresh remains: nothing is re-sent at once.
    expect(
      Math.min(...h.liveTimers().map((timer) => timer.at)) - h.now(),
    ).toBeGreaterThan(60 * 60_000);
    expect(h.exchanges).toHaveLength(sent);
    expect(activityOf(h.iosRecord())).toBeDefined();
    await h.publisher.stop();
  });

  test('503 unavailable (Apple: 503): retried with backoff and then sent', async () => {
    const h = await harness();
    await h.change([row('running', START - 1000)]);
    h.appleReplies.broadcast = [() => appleError(503, 'ServiceUnavailable')];
    h.advance(10_000);
    await h.change([row('approval', h.now())]);
    expect(h.exchanges.at(-1)).toMatchObject({
      status: 503,
      answer: { result: 'unavailable' },
    });
    const retry = await h.fireNextTimer();
    expect(retry.at).toBe(START + 10_000 + 5_000);
    expect(h.exchanges.at(-1)).toMatchObject({
      request: { event: 'update', alert: true },
      status: 200,
    });
    h.expectEveryRequestParsed();
    await h.publisher.stop();
  });

  test('a revoked iPhone: the retirement end and the channel delete are accepted', async () => {
    const h = await harness();
    await h.change([row('running', START - 1000)]);
    h.advance(10_000);
    h.pairing.revokeDevice(h.deviceId, 'operator-credential');
    await h.publisher.drain();
    expect(
      h.exchanges
        .slice(1)
        .map((entry) => [
          entry.request.event ?? entry.request.op,
          entry.status,
          entry.answer.result,
        ]),
    ).toEqual([
      ['end', 200, 'sent'],
      ['delete', 200, 'deleted'],
    ]);
    h.expectEveryRequestParsed();
    await h.publisher.stop();
  });
});
