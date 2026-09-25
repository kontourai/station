/**
 * `POST /v1/apns/alert`: a regular alert push to one device, for iOS
 * notification delivery (#2589). Held to the Live Activity route's rules:
 * signed, rate limited per device token, per key and globally, fixed text
 * only, and the Station key stamped by the gateway.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'vitest';
import { APNS_ALERT_TEXT, parseAlertRequest } from '../src/apns-request.ts';
import { resetProviderTokenCacheForTest } from '../src/apns-token.ts';
import {
  type GatewayConfig,
  handleRequest,
  type RateLimiter,
} from '../src/gateway.ts';
import { bodyHash, jwkThumbprint } from '../src/station-auth.ts';
import {
  AUDIENCE,
  alertBody,
  allow,
  CHANNEL_AUTH_SECRET,
  COLLAPSE_ID,
  DEVICE_TOKEN,
  encodeBody,
  fakeApnsKey,
  fakeLedger,
  fakeServiceAccount,
  IOS_BUNDLE,
  NOW,
  PACKAGE,
  REGISTRATION_ID,
  SEALED,
  signRequest,
  stationKey,
} from './helpers.ts';

type Key = Awaited<ReturnType<typeof stationKey>>;

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

/** A fake Apple that records every call and answers `reply` (default 200). */
function upstream(reply: () => Response = () => new Response(null)) {
  const calls: Recorded[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => {
      headers[name] = value;
    });
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body:
        init?.body instanceof Uint8Array
          ? new TextDecoder().decode(init.body)
          : String(init?.body ?? ''),
    });
    return reply();
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function recording(log: string[], name: string, success = true): RateLimiter {
  return {
    limit: async ({ key }) => {
      log.push(`${name}:${key}`);
      return { success };
    },
  };
}

async function config(
  overrides: Partial<GatewayConfig> = {},
): Promise<GatewayConfig> {
  return {
    audiences: [AUDIENCE],
    allowedPackages: [PACKAGE],
    serviceAccount: (await fakeServiceAccount()).account,
    perIpLimiter: allow,
    globalLimiter: allow,
    perKeyLimiter: allow,
    perTokenLimiter: allow,
    apns: {
      credentials: (await fakeApnsKey()).credentials,
      allowedBundles: [IOS_BUNDLE],
      channelAuth: { current: CHANNEL_AUTH_SECRET },
      channelPerIpLimiter: allow,
      channelPerDeviceLimiter: allow,
      channelPerKeyLimiter: allow,
      channelGlobalLimiter: allow,
      channelDeleteLimiter: allow,
      ledger: fakeLedger(),
    },
    nowSeconds: () => NOW,
    ...overrides,
  };
}

async function post(cfg: GatewayConfig, value: unknown, key?: Key) {
  const body = encodeBody(value);
  return handleRequest(
    new Request(`${AUDIENCE}/v1/apns/alert`, {
      method: 'POST',
      headers: {
        authorization: await signRequest(body, key ?? (await stationKey())),
        'cf-connecting-ip': '203.0.113.7',
      },
      body,
    }),
    cfg,
  );
}

beforeEach(() => resetProviderTokenCacheForTest());
let errors: string[] = [];
const originalError = console.error;
beforeEach(() => {
  errors = [];
  console.error = (...args: unknown[]) => {
    errors.push(args.join(' '));
  };
});
afterEach(() => {
  console.error = originalError;
});

for (const [environment, host] of [
  ['sandbox', 'https://api.sandbox.push.apple.com'],
  ['production', 'https://api.push.apple.com'],
] as const) {
  test(`a ${environment} alert goes to the device as a regular alert push on the app's topic`, async () => {
    const { calls, fetchImpl } = upstream();
    const station = await stationKey();
    const response = await post(
      await config({ fetchImpl }),
      alertBody({ environment }),
      station,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { result: 'sent' });
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call.method, 'POST');
    assert.equal(call.url, `${host}/3/device/${DEVICE_TOKEN}`);
    assert.equal(call.headers['apns-push-type'], 'alert');
    // The app's own topic: not the Live Activity topic, not the extension.
    assert.equal(call.headers['apns-topic'], IOS_BUNDLE);
    assert.equal(call.headers['apns-priority'], '10');
    assert.equal(call.headers['apns-collapse-id'], COLLAPSE_ID);
    assert.equal(call.headers['apns-expiration'], String(NOW + 3600));
    assert.match(call.headers.authorization ?? '', /^bearer /);
    assert.deepEqual(JSON.parse(call.body), {
      aps: {
        alert: APNS_ALERT_TEXT.attention,
        sound: 'default',
        'mutable-content': 1,
      },
      station: {
        v: 1,
        rid: REGISTRATION_ID,
        sk: await jwkThumbprint(station.publicJwk),
        sealed: SEALED,
      },
    });
  });
}

test('the visible text is fixed per kind; quiet kinds do not sound and may wait', async () => {
  for (const kind of ['attention', 'failed', 'done', 'hidden'] as const) {
    const { calls, fetchImpl } = upstream();
    const response = await post(
      await config({ fetchImpl }),
      alertBody({ kind }),
    );
    assert.equal(response.status, 200, kind);
    const aps = JSON.parse(calls[0].body).aps;
    assert.deepEqual(aps.alert, APNS_ALERT_TEXT[kind], kind);
    assert.equal(aps['mutable-content'], 1, kind);
    const urgent = kind === 'attention' || kind === 'failed';
    assert.equal(aps.sound, urgent ? 'default' : undefined, kind);
    assert.equal(calls[0].headers['apns-priority'], urgent ? '10' : '5', kind);
  }
});

test('no caller-supplied text, alert, sound or station key reaches Apple', async () => {
  const { calls, fetchImpl } = upstream();
  const cfg = await config({ fetchImpl });
  for (const extra of [
    { title: 'Approve rm -rf /' },
    { body: 'anything' },
    { alert: { title: 'x', body: 'y' } },
    { aps: { alert: 'x' } },
    { sound: 'default' },
    { sk: 'forged' },
    { station: { sk: 'forged' } },
  ]) {
    const response = await post(cfg, alertBody(extra));
    assert.equal(response.status, 400, JSON.stringify(extra));
  }
  assert.equal(calls.length, 0);
});

test('refuses unknown kinds and malformed routing before any work', async () => {
  const { calls, fetchImpl } = upstream();
  const cfg = await config({ fetchImpl });
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ kind: 'info' }, 'unsupported kind'],
    [{ kind: 'Agent says: approve now' }, 'unsupported kind'],
    [{ bundleId: 'com.example.other' }, 'bundle is not a Station app'],
    [{ environment: 'staging' }, 'invalid environment'],
    [{ deviceToken: 'zz'.repeat(32) }, 'invalid deviceToken'],
    [{ deviceToken: 'ab'.repeat(31) }, 'invalid deviceToken'],
    [{ deviceToken: `${DEVICE_TOKEN}/../x` }, 'invalid deviceToken'],
    [{ registrationId: 'short' }, 'invalid registrationId'],
    [{ collapseId: 'x'.repeat(65) }, 'invalid collapseId'],
    [{ collapseId: 'has space in it!!' }, 'invalid collapseId'],
    [{ sealed: 'not base64url!' }, 'invalid sealed'],
    [{ sealed: 'S'.repeat(3001) }, 'invalid sealed'],
    [{ collapseId: undefined }, 'missing collapseId'],
  ];
  for (const [overrides, reason] of cases) {
    const response = await post(cfg, alertBody(overrides));
    assert.equal(response.status, 400, reason);
    assert.deepEqual(await response.json(), { error: reason });
  }
  const notJson = await handleRequest(
    new Request(`${AUDIENCE}/v1/apns/alert`, {
      method: 'POST',
      headers: {
        authorization: await signRequest(
          new TextEncoder().encode('nope'),
          await stationKey(),
        ),
      },
      body: 'nope',
    }),
    cfg,
  );
  assert.equal(notJson.status, 400);
  assert.equal(calls.length, 0);
});

test('an upper-case device token is addressed in lower case', async () => {
  const parsed = parseAlertRequest(
    encodeBody(alertBody({ deviceToken: 'CD'.repeat(32) })),
    [IOS_BUNDLE],
  );
  assert.ok(parsed.ok);
  assert.equal(parsed.request.deviceToken, DEVICE_TOKEN);
});

test('an unsigned or wrongly signed alert never reaches Apple or the limiters', async () => {
  const log: string[] = [];
  const { calls, fetchImpl } = upstream();
  const cfg = await config({
    fetchImpl,
    perTokenLimiter: recording(log, 'token'),
    perKeyLimiter: recording(log, 'key'),
    globalLimiter: recording(log, 'global'),
  });
  const body = encodeBody(alertBody());
  const unsigned = await handleRequest(
    new Request(`${AUDIENCE}/v1/apns/alert`, { method: 'POST', body }),
    cfg,
  );
  assert.equal(unsigned.status, 401);
  // Signed over a different body: the body hash does not match.
  const other = encodeBody(alertBody({ kind: 'done' }));
  const mismatched = await handleRequest(
    new Request(`${AUDIENCE}/v1/apns/alert`, {
      method: 'POST',
      headers: { authorization: await signRequest(other, await stationKey()) },
      body,
    }),
    cfg,
  );
  assert.equal(mismatched.status, 401);
  assert.equal(
    (await handleRequest(new Request(`${AUDIENCE}/v1/apns/alert`), cfg)).status,
    405,
  );
  assert.equal(calls.length, 0);
  assert.deepEqual(log, []);
});

test('checks per device token, per key, then global, stopping at the first refusal', async () => {
  const station = await stationKey();
  const thumbprint = await jwkThumbprint(station.publicJwk);
  const tokenHash = await bodyHash(new TextEncoder().encode(DEVICE_TOKEN));
  const order = ['token', 'key', 'global'] as const;
  for (const [index, refused] of order.entries()) {
    const log: string[] = [];
    const { calls, fetchImpl } = upstream();
    const cfg = await config({
      fetchImpl,
      perTokenLimiter: recording(log, 'token', refused !== 'token'),
      perKeyLimiter: recording(log, 'key', refused !== 'key'),
      globalLimiter: recording(log, 'global', refused !== 'global'),
    });
    const response = await post(cfg, alertBody(), station);
    assert.equal(response.status, 429, refused);
    assert.deepEqual(
      log,
      [`token:${tokenHash}`, `key:${thumbprint}`, 'global:global'].slice(
        0,
        index + 1,
      ),
      refused,
    );
    assert.equal(calls.length, 0);
  }
});

test('an alert does not spend the channel-creation budget', async () => {
  const log: string[] = [];
  const { fetchImpl } = upstream();
  const cfg = await config({ fetchImpl });
  assert.ok(cfg.apns);
  cfg.apns.channelPerIpLimiter = recording(log, 'c-ip', false);
  cfg.apns.channelPerDeviceLimiter = recording(log, 'c-device', false);
  cfg.apns.channelPerKeyLimiter = recording(log, 'c-key', false);
  cfg.apns.channelGlobalLimiter = recording(log, 'c-global', false);
  cfg.apns.channelDeleteLimiter = recording(log, 'c-delete', false);
  assert.equal((await post(cfg, alertBody())).status, 200);
  assert.deepEqual(log, []);
});

test("maps Apple's answers: a dead token is unregistered, config faults retryable", async () => {
  const cases: Array<[Response, number, string]> = [
    [
      Response.json({ reason: 'Unregistered' }, { status: 410 }),
      410,
      'unregistered',
    ],
    [
      Response.json({ reason: 'BadDeviceToken' }, { status: 400 }),
      410,
      'unregistered',
    ],
    [
      Response.json({ reason: 'DeviceTokenNotForTopic' }, { status: 400 }),
      410,
      'unregistered',
    ],
    [
      Response.json({ reason: 'PayloadTooLarge' }, { status: 413 }),
      422,
      'rejected',
    ],
    [
      Response.json({ reason: 'TopicDisallowed' }, { status: 400 }),
      422,
      'rejected',
    ],
    [
      Response.json({ reason: 'InvalidProviderToken' }, { status: 403 }),
      503,
      'unavailable',
    ],
    [
      Response.json({ reason: 'TooManyRequests' }, { status: 429 }),
      503,
      'unavailable',
    ],
    [new Response(null, { status: 500 }), 503, 'unavailable'],
  ];
  for (const [reply, status, result] of cases) {
    const { fetchImpl } = upstream(() => reply.clone());
    const response = await post(await config({ fetchImpl }), alertBody());
    assert.equal(response.status, status, result);
    assert.deepEqual(await response.json(), { result });
  }
});

test('answers 503 until APNs is configured, before any limiter or Apple', async () => {
  const log: string[] = [];
  const { calls, fetchImpl } = upstream();
  for (const apns of [null, undefined]) {
    const cfg = await config({
      apns,
      fetchImpl,
      perIpLimiter: recording(log, 'ip'),
    });
    assert.equal((await post(cfg, alertBody())).status, 503);
  }
  assert.deepEqual(log, []);
  assert.equal(calls.length, 0);
});
