import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'vitest';
import { ApnsSender } from '../src/apns.ts';
import {
  signChannelAuth,
  verifyChannelAuth,
} from '../src/apns-channel-auth.ts';
import { parseLiveActivityRequest } from '../src/apns-request.ts';
import { resetProviderTokenCacheForTest } from '../src/apns-token.ts';
import { DAILY_STARTS_PER_DEVICE } from '../src/channel-ledger.ts';
import {
  type ApnsGatewayConfig,
  addressBucket,
  type ExecutionContextLike,
  type GatewayConfig,
  handleRequest,
  type RateLimiter,
} from '../src/gateway.ts';
import { bodyHash, jwkThumbprint } from '../src/station-auth.ts';
import {
  AUDIENCE,
  allow,
  CHANNEL_AUTH_SECRET,
  CHANNEL_ID,
  encodeBody,
  fakeApnsKey,
  fakeLedger,
  fakeServiceAccount,
  IOS_BUNDLE,
  liveActivityBody,
  NOW,
  PACKAGE,
  PUSH_TO_START_TOKEN,
  REGISTRATION_ID,
  SEALED,
  sendBody,
  signRequest,
  stationKey,
} from './helpers.ts';

type Key = Awaited<ReturnType<typeof stationKey>>;
type Event = 'start' | 'update' | 'end';

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

const NEW_CHANNEL = 'n3w+Ch4nNel/Id0123456A==';
const SECRETS = { current: CHANNEL_AUTH_SECRET };

function headerRecord(init: HeadersInit | undefined): Record<string, string> {
  const record: Record<string, string> = {};
  new Headers(init).forEach((value, name) => {
    record[name] = value;
  });
  return record;
}

const kindOf = (call: Recorded) =>
  call.url.includes('api-manage-broadcast')
    ? call.method === 'POST'
      ? 'create'
      : 'delete'
    : call.url.includes('/3/device/')
      ? 'start'
      : call.url.includes('/4/broadcasts/')
        ? 'broadcast'
        : 'other';

/**
 * A fake Apple (and Google, for the FCM route) recording every call. Each
 * APNs kind answers success unless overridden.
 */
function upstream(
  replies: Partial<
    Record<ReturnType<typeof kindOf>, (call: Recorded) => Response>
  > = {},
) {
  const calls: Recorded[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Recorded = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: headerRecord(init?.headers),
      body:
        init?.body instanceof Uint8Array
          ? new TextDecoder().decode(init.body)
          : String(init?.body ?? ''),
    };
    calls.push(call);
    if (call.url === 'https://oauth2.googleapis.com/token')
      return Response.json({ access_token: 'ya29.test', expires_in: 3600 });
    const kind = kindOf(call);
    const reply = replies[kind];
    if (reply) return reply(call);
    if (kind === 'create')
      return new Response(null, {
        status: 201,
        headers: { 'apns-channel-id': NEW_CHANNEL },
      });
    return new Response(null, { status: kind === 'delete' ? 204 : 200 });
  }) as typeof fetch;
  const apple = () => calls.filter((call) => kindOf(call) !== 'other');
  return { calls, apple, fetchImpl };
}

/** A limiter that records its keys under `name` and answers `success`. */
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
  apns: Partial<ApnsGatewayConfig> = {},
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
      channelAuth: SECRETS,
      channelPerIpLimiter: allow,
      channelPerDeviceLimiter: allow,
      channelPerKeyLimiter: allow,
      channelGlobalLimiter: allow,
      channelDeleteLimiter: allow,
      ledger: fakeLedger(),
      ...apns,
    },
    nowSeconds: () => NOW,
    ...overrides,
  };
}

async function post(
  cfg: GatewayConfig,
  path: string,
  value: unknown,
  key: Key,
  options: { ip?: string; ctx?: ExecutionContextLike } = {},
) {
  const body = encodeBody(value);
  return handleRequest(
    new Request(`${AUDIENCE}${path}`, {
      method: 'POST',
      headers: {
        authorization: await signRequest(body, key),
        'cf-connecting-ip': options.ip ?? '203.0.113.7',
      },
      body,
    }),
    cfg,
    options.ctx,
  );
}

async function channelAuth(
  key: Key,
  overrides: { environment?: string; channelId?: string } = {},
  secrets: { current: string } = SECRETS,
) {
  return signChannelAuth(secrets, {
    bundleId: IOS_BUNDLE,
    environment: overrides.environment ?? 'sandbox',
    channelId: overrides.channelId ?? CHANNEL_ID,
    stationKey: await jwkThumbprint(key.publicJwk),
  });
}

/** A live-activity request; update/end carry a valid channelAuth for `key`. */
async function live(
  cfg: GatewayConfig,
  event: Event,
  overrides: Record<string, unknown> = {},
  key?: Key,
) {
  const signer = key ?? (await stationKey());
  const body = liveActivityBody(overrides, event);
  if (event !== 'start' && !('channelAuth' in overrides))
    body.channelAuth = await channelAuth(signer, {
      environment: body.environment as string,
    });
  return post(cfg, '/v1/apns/live-activity', body, signer);
}

async function del(
  cfg: GatewayConfig,
  overrides: Record<string, unknown> = {},
  key?: Key,
) {
  const signer = key ?? (await stationKey());
  const body: Record<string, unknown> = {
    op: 'delete',
    bundleId: IOS_BUNDLE,
    environment: 'sandbox',
    channelId: CHANNEL_ID,
    channelAuth: await channelAuth(signer),
    ...overrides,
  };
  return post(cfg, '/v1/apns/channels', body, signer);
}

/** Captures console.error for the duration of a test. */
let errors: string[] = [];
const originalError = console.error;
beforeEach(() => {
  resetProviderTokenCacheForTest();
  errors = [];
  console.error = (...args: unknown[]) => {
    errors.push(args.join(' '));
  };
});
afterEach(() => {
  console.error = originalError;
});

for (const [environment, host, manage] of [
  [
    'sandbox',
    'https://api.sandbox.push.apple.com',
    'https://api-manage-broadcast.sandbox.push.apple.com:2195',
  ],
  [
    'production',
    'https://api.push.apple.com',
    'https://api-manage-broadcast.push.apple.com:2196',
  ],
] as const) {
  test(`a ${environment} start creates the activity's channel, then pushes to start on it`, async () => {
    const { apple, fetchImpl } = upstream();
    const station = await stationKey();
    const thumbprint = await jwkThumbprint(station.publicJwk);
    const response = await live(
      await config({ fetchImpl }),
      'start',
      { environment },
      station,
    );
    assert.equal(response.status, 200);
    const result = (await response.json()) as Record<string, string>;
    assert.deepEqual(Object.keys(result).sort(), [
      'channelAuth',
      'channelId',
      'result',
    ]);
    assert.equal(result.result, 'sent');
    assert.equal(result.channelId, NEW_CHANNEL);
    assert.equal(
      await verifyChannelAuth(
        SECRETS,
        {
          bundleId: IOS_BUNDLE,
          environment,
          channelId: NEW_CHANNEL,
          stationKey: thumbprint,
        },
        result.channelAuth,
      ),
      'current',
      'the returned channelAuth binds this key to the new channel',
    );

    const [create, start] = apple();
    assert.equal(apple().length, 2);
    assert.equal(create.method, 'POST');
    assert.equal(create.url, `${manage}/1/apps/${IOS_BUNDLE}/channels`);
    assert.deepEqual(JSON.parse(create.body), {
      'message-storage-policy': 1,
      'push-type': 'LiveActivity',
    });
    assert.match(
      create.headers.authorization,
      /^bearer [\w-]+\.[\w-]+\.[\w-]+$/,
    );

    assert.equal(start.method, 'POST');
    assert.equal(start.url, `${host}/3/device/${PUSH_TO_START_TOKEN}`);
    assert.equal(start.headers['apns-push-type'], 'liveactivity');
    assert.equal(
      start.headers['apns-topic'],
      `${IOS_BUNDLE}.push-type.liveactivity`,
    );
    assert.equal(start.headers['apns-priority'], '10');
    assert.equal(start.headers['apns-expiration'], String(NOW + 300));
    assert.equal(start.headers['apns-channel-id'], undefined);
    const aps = JSON.parse(start.body).aps;
    assert.equal(aps.event, 'start');
    assert.equal(aps['input-push-channel'], NEW_CHANNEL);
    assert.deepEqual(aps['content-state'], {
      v: 1,
      rid: REGISTRATION_ID,
      sk: thumbprint,
      sealed: SEALED,
    });
  });

  test(`${environment} update and end broadcast to the channel`, async () => {
    const { apple, fetchImpl } = upstream();
    const cfg = await config({ fetchImpl });
    const update = await live(cfg, 'update', { environment });
    assert.equal(update.status, 200);
    assert.deepEqual(await update.json(), { result: 'sent' });
    assert.equal((await live(cfg, 'end', { environment })).status, 200);
    const [first, second] = apple();
    for (const call of [first, second]) {
      assert.equal(call.method, 'POST');
      assert.equal(call.url, `${host}/4/broadcasts/apps/${IOS_BUNDLE}`);
      assert.equal(call.headers['apns-channel-id'], CHANNEL_ID);
      assert.equal(call.headers['apns-push-type'], 'liveactivity');
      assert.equal(call.headers['apns-topic'], undefined);
      assert.equal(call.headers['apns-expiration'], String(NOW + 300));
    }
    assert.equal(first.headers['apns-priority'], '5');
    assert.equal(second.headers['apns-priority'], '10');
    assert.equal(JSON.parse(first.body).aps.event, 'update');
    assert.equal(JSON.parse(second.body).aps['dismissal-date'], NOW + 900);
  });

  test(`${environment} channel delete goes to the management host`, async () => {
    const { apple, fetchImpl } = upstream();
    const station = await stationKey();
    const response = await del(
      await config({ fetchImpl }),
      {
        environment,
        channelAuth: await channelAuth(station, { environment }),
      },
      station,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { result: 'deleted' });
    const [remove] = apple();
    assert.equal(remove.method, 'DELETE');
    assert.equal(remove.url, `${manage}/1/apps/${IOS_BUNDLE}/channels`);
    assert.equal(remove.headers['apns-channel-id'], CHANNEL_ID);
    assert.equal(remove.body, '');
  });
}

test('a start Apple refuses deletes its channel before answering', async () => {
  const refusals: Array<[string, () => Response, number, string]> = [
    [
      'Unregistered',
      () => Response.json({ reason: 'Unregistered' }, { status: 410 }),
      410,
      'unregistered',
    ],
    [
      'BadDeviceToken',
      () => Response.json({ reason: 'BadDeviceToken' }, { status: 400 }),
      410,
      'unregistered',
    ],
    [
      'DeviceTokenNotForTopic',
      () =>
        Response.json({ reason: 'DeviceTokenNotForTopic' }, { status: 400 }),
      410,
      'unregistered',
    ],
    [
      'BadDate',
      () => Response.json({ reason: 'BadDate' }, { status: 400 }),
      422,
      'rejected',
    ],
    ['500', () => new Response(null, { status: 500 }), 503, 'unavailable'],
  ];
  for (const [label, reply, status, result] of refusals) {
    const { apple, fetchImpl } = upstream({ start: reply });
    const response = await live(await config({ fetchImpl }), 'start');
    assert.equal(response.status, status, label);
    assert.deepEqual(await response.json(), { result }, label);
    const kinds = apple().map(kindOf);
    assert.deepEqual(kinds, ['create', 'start', 'delete'], label);
    assert.equal(apple()[2].headers['apns-channel-id'], NEW_CHANNEL, label);
  }
});

test('a start that never reached Apple still gives its channel back', async () => {
  const { apple, fetchImpl } = upstream({
    start: () => {
      throw new TypeError('network down');
    },
  });
  const response = await live(await config({ fetchImpl }), 'start');
  assert.equal(response.status, 503);
  assert.deepEqual(apple().map(kindOf), ['create', 'start', 'delete']);
});

test('a channel left behind after a refused start is logged', async () => {
  const { fetchImpl } = upstream({
    start: () => Response.json({ reason: 'Unregistered' }, { status: 410 }),
    delete: () => new Response(null, { status: 500 }),
  });
  const response = await live(await config({ fetchImpl }), 'start');
  assert.equal(response.status, 410);
  assert.ok(errors.some((line) => line.includes('channel left behind')));
});

test('no push-to-start is sent when the channel cannot be created', async () => {
  for (const reply of [
    () => Response.json({ reason: 'TooManyChannels' }, { status: 429 }),
    () => new Response(null, { status: 201 }),
    () =>
      new Response(null, {
        status: 201,
        headers: { 'apns-channel-id': 'not a channel id' },
      }),
    () => Response.json({ reason: 'BadRequest' }, { status: 400 }),
  ]) {
    const { apple, fetchImpl } = upstream({ create: reply });
    const response = await live(await config({ fetchImpl }), 'start');
    assert.ok([503, 422].includes(response.status), String(response.status));
    assert.deepEqual(apple().map(kindOf), ['create']);
  }
});

test('an alerting update and an alerting end go out at priority 10 with the fixed alert', async () => {
  const { apple, fetchImpl } = upstream();
  const cfg = await config({ fetchImpl });
  await live(cfg, 'update', { alert: true });
  await live(cfg, 'end', { alert: true });
  for (const call of apple()) {
    assert.equal(call.headers['apns-priority'], '10');
    assert.deepEqual(JSON.parse(call.body).aps.alert, {
      title: 'Station',
      body: 'Agent activity',
      sound: 'default',
    });
  }
  assert.equal(apple().length, 2);
});

test('update, end and delete need a channelAuth for this key and channel', async () => {
  const log: string[] = [];
  const { apple, fetchImpl } = upstream();
  const cfg = await config(
    { fetchImpl, perTokenLimiter: recording(log, 'token') },
    { channelDeleteLimiter: recording(log, 'delete') },
  );
  const station = await stationKey();
  const stranger = await stationKey();
  const wrong = [
    `v1.${'A'.repeat(43)}`,
    // A genuine token, but issued to another key.
    await channelAuth(stranger),
    // A genuine token for another channel.
    await channelAuth(station, { channelId: NEW_CHANNEL }),
    // Signed with a secret the gateway does not hold.
    await channelAuth(
      station,
      {},
      {
        current: 'someone-elses-secret-of-sufficient-length',
      },
    ),
  ];
  for (const token of wrong) {
    for (const response of [
      await live(cfg, 'update', { channelAuth: token }, station),
      await live(cfg, 'end', { channelAuth: token }, station),
      await del(cfg, { channelAuth: token }, station),
    ]) {
      assert.equal(response.status, 403, token);
      assert.deepEqual(await response.json(), {
        result: 'channel-unauthorized',
      });
    }
  }
  assert.equal(apple().length, 0);
  assert.deepEqual(log, [], 'refused before any per-channel limiter');
});

test('a token made with the previous secret still works and is replaced', async () => {
  const previous = 'the-previous-channel-auth-secret-0123456';
  const { apple, fetchImpl } = upstream();
  const cfg = await config(
    { fetchImpl },
    { channelAuth: { current: CHANNEL_AUTH_SECRET, previous } },
  );
  const station = await stationKey();
  const old = await channelAuth(station, {}, { current: previous });
  const response = await live(cfg, 'update', { channelAuth: old }, station);
  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, string>;
  assert.equal(body.result, 'sent');
  assert.equal(body.channelAuth, await channelAuth(station));
  assert.equal(apple().length, 1);

  // A token already on the current secret is not reissued.
  const current = await live(cfg, 'update', {}, station);
  assert.deepEqual(await current.json(), { result: 'sent' });
});

test('maps each APNs answer by reason, not bare status', async () => {
  const apns = (status: number, reason?: string) => () =>
    reason === undefined
      ? new Response(null, { status })
      : Response.json({ reason }, { status });
  const cases: Array<[Event, () => Response, number, string]> = [
    ['update', apns(400, 'BadChannelId'), 410, 'channel-gone'],
    // Apple answers both with 400 (verified 2026-09-24): the reason decides.
    ['end', apns(400, 'ChannelNotRegistered'), 410, 'channel-gone'],
    ['update', apns(410, 'ChannelNotRegistered'), 410, 'channel-gone'],
    // A bare 404 or 410 is not evidence the channel is gone.
    ['update', apns(404), 422, 'rejected'],
    ['end', apns(404, 'BadPath'), 422, 'rejected'],
    ['update', apns(410), 422, 'rejected'],
    ['update', apns(413, 'PayloadTooLarge'), 422, 'rejected'],
    // Device reasons mean nothing for a broadcast.
    ['update', apns(400, 'BadDeviceToken'), 422, 'rejected'],
    ['update', apns(429, 'TooManyProviderTokenUpdates'), 503, 'unavailable'],
    ['end', apns(500, 'InternalServerError'), 503, 'unavailable'],
    ['update', apns(503, 'ServiceUnavailable'), 503, 'unavailable'],
    ['update', apns(403, 'InvalidProviderToken'), 503, 'unavailable'],
    ['end', apns(403, 'ExpiredProviderToken'), 503, 'unavailable'],
  ];
  for (const [event, reply, status, result] of cases) {
    const { fetchImpl } = upstream({ broadcast: reply });
    const response = await live(await config({ fetchImpl }), event);
    const label = `${event} ${reply().status}`;
    assert.equal(response.status, status, label);
    // The upstream reason is never relayed to the caller.
    assert.deepEqual(await response.json(), { result }, label);
  }
  const logged = (text: string) =>
    errors.some(
      (line) => line.includes('gateway fault') && line.includes(text),
    );
  assert.ok(
    logged('InvalidProviderToken'),
    'a refused provider token is logged',
  );
  assert.ok(
    logged('TooManyProviderTokenUpdates'),
    'Apple throttling is logged',
  );
  assert.ok(
    errors.some((line) => line.includes('404') && line.includes('BadPath')),
  );
});

test('delete: an already-gone channel is deleted, a bare 404 is not', async () => {
  // Apple's answer for an unknown or already-deleted channel (verified
  // 2026-09-24) is 404 BadPath; BadChannelId is accepted as well.
  for (const reply of [
    () => Response.json({ reason: 'BadPath' }, { status: 404 }),
    () => Response.json({ reason: 'BadChannelId' }, { status: 400 }),
  ]) {
    const gone = upstream({ delete: reply });
    const deleted = await del(await config({ fetchImpl: gone.fetchImpl }));
    assert.equal(deleted.status, 200);
    assert.deepEqual(await deleted.json(), { result: 'deleted' });
  }

  for (const reply of [
    () => new Response(null, { status: 404 }),
    () => Response.json({ reason: 'NotFound' }, { status: 404 }),
    // BadPath means "gone" only for a delete, whatever the status.
    () => Response.json({ reason: 'BadPath' }, { status: 400 }),
  ]) {
    const bare = upstream({ delete: reply });
    const refused = await del(await config({ fetchImpl: bare.fetchImpl }));
    assert.equal(refused.status, 422);
    assert.deepEqual(await refused.json(), { result: 'rejected' });
  }
  assert.ok(errors.some((line) => line.includes('404')));
});

test('a bundle without the broadcast capability is a gateway configuration fault', async () => {
  const { apple, fetchImpl } = upstream({
    create: () =>
      Response.json({ reason: 'BroadcastFeatureNotEnabled' }, { status: 400 }),
  });
  const response = await live(await config({ fetchImpl }), 'start');
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { result: 'unavailable' });
  // No channel was created, so there is nothing to delete and no start.
  assert.deepEqual(apple().map(kindOf), ['create']);
  assert.ok(
    errors.some(
      (line) =>
        line.includes('configuration fault') &&
        line.includes('BroadcastFeatureNotEnabled'),
    ),
  );
});

test('the channel route no longer creates channels', async () => {
  const { apple, fetchImpl } = upstream();
  const station = await stationKey();
  const response = await post(
    await config({ fetchImpl }),
    '/v1/apns/channels',
    { op: 'create', bundleId: IOS_BUNDLE, environment: 'sandbox' },
    station,
  );
  assert.equal(response.status, 400);
  assert.equal(apple().length, 0);
});

test('starts check the channel ceilings narrowest first and stop at the first refusal', async () => {
  const station = await stationKey();
  const thumbprint = await jwkThumbprint(station.publicJwk);
  const order = ['ip', 'device', 'key', 'global'] as const;
  const names = {
    ip: 'channelPerIpLimiter',
    device: 'channelPerDeviceLimiter',
    key: 'channelPerKeyLimiter',
    global: 'channelGlobalLimiter',
  } as const;
  const deviceKey = await (async () => {
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(PUSH_TO_START_TOKEN),
    );
    return btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/, '');
  })();
  const keys = {
    ip: '203.0.113.7',
    device: deviceKey,
    key: thumbprint,
    global: 'global',
  };
  for (const [index, refused] of order.entries()) {
    const log: string[] = [];
    const { apple, fetchImpl } = upstream();
    const limiters = Object.fromEntries(
      order.map((name) => [
        names[name],
        recording(log, name, name !== refused),
      ]),
    );
    const cfg = await config({ fetchImpl }, limiters);
    const response = await live(cfg, 'start', {}, station);
    assert.equal(response.status, 429, refused);
    assert.deepEqual(
      log,
      order.slice(0, index + 1).map((name) => `${name}:${keys[name]}`),
      `refused at ${refused}: no wider budget spent`,
    );
    assert.equal(apple().length, 0);
  }
});

test('pushes check per-channel, per-key, then global, stopping at the first refusal', async () => {
  const station = await stationKey();
  const order = ['token', 'key', 'global'] as const;
  for (const [index, refused] of order.entries()) {
    const log: string[] = [];
    const { apple, fetchImpl } = upstream();
    const cfg = await config({
      fetchImpl,
      perTokenLimiter: recording(log, 'token', refused !== 'token'),
      perKeyLimiter: recording(log, 'key', refused !== 'key'),
      globalLimiter: recording(log, 'global', refused !== 'global'),
    });
    assert.equal((await live(cfg, 'update', {}, station)).status, 429);
    assert.deepEqual(
      log.map((entry) => entry.split(':')[0]),
      order.slice(0, index + 1),
      refused,
    );
    assert.ok(!log.some((entry) => entry.includes(CHANNEL_ID)), 'hashed');
    assert.equal(apple().length, 0);
  }
});

test('deletes spend only their own per-key ceiling', async () => {
  const log: string[] = [];
  const station = await stationKey();
  const { apple, fetchImpl } = upstream();
  const cfg = await config(
    {
      fetchImpl,
      perTokenLimiter: recording(log, 'token'),
      perKeyLimiter: recording(log, 'key'),
      globalLimiter: recording(log, 'global'),
    },
    {
      channelDeleteLimiter: recording(log, 'delete', false),
      channelGlobalLimiter: recording(log, 'create'),
    },
  );
  assert.equal((await del(cfg, {}, station)).status, 429);
  assert.deepEqual(log, [`delete:${await jwkThumbprint(station.publicJwk)}`]);
  assert.equal(apple().length, 0);
});

test('updates do not spend the channel-creation budget', async () => {
  const log: string[] = [];
  const { fetchImpl } = upstream();
  const cfg = await config(
    { fetchImpl },
    {
      channelPerIpLimiter: recording(log, 'ip', false),
      channelGlobalLimiter: recording(log, 'create', false),
    },
  );
  assert.equal((await live(cfg, 'update')).status, 200);
  assert.deepEqual(log, []);
});

test('the APNs routes answer 503 until APNs is configured, before any work', async () => {
  const { calls, fetchImpl } = upstream();
  const log: string[] = [];
  for (const apns of [null, undefined]) {
    const cfg = await config({
      apns,
      fetchImpl,
      perIpLimiter: recording(log, 'ip'),
    });
    const station = await stationKey();
    assert.equal(
      (await post(cfg, '/v1/apns/live-activity', liveActivityBody(), station))
        .status,
      503,
    );
    assert.equal(
      (await post(cfg, '/v1/apns/channels', { op: 'delete' }, station)).status,
      503,
    );
    // FCM is independent of APNs configuration.
    const fcm = await post(
      cfg,
      '/v1/fcm/send',
      JSON.parse(new TextDecoder().decode(sendBody())),
      station,
    );
    assert.equal(fcm.status, 200);
  }
  assert.equal(calls.filter((call) => call.url.includes('apple')).length, 0);
  assert.equal(log.length, 2, 'only the FCM requests reached the limiter');
});

test('an unusable APNs key is a retryable configuration fault', async () => {
  const { calls, fetchImpl } = upstream();
  const cfg = await config({ fetchImpl });
  assert.ok(cfg.apns);
  cfg.apns.credentials = {
    ...cfg.apns.credentials,
    privateKeyPem:
      '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----',
  };
  assert.equal((await live(cfg, 'start')).status, 503);
  assert.equal(calls.length, 0);
  assert.ok(errors.some((line) => line.includes('configuration fault')));
});

test('the APNs routes share the signed-request checks', async () => {
  const { calls, fetchImpl } = upstream();
  const cfg = await config({ fetchImpl });
  const unsigned = await handleRequest(
    new Request(`${AUDIENCE}/v1/apns/live-activity`, {
      method: 'POST',
      body: encodeBody(liveActivityBody()),
    }),
    cfg,
  );
  assert.equal(unsigned.status, 401);
  assert.equal(
    (await handleRequest(new Request(`${AUDIENCE}/v1/apns/channels`), cfg))
      .status,
    405,
  );
  const invalid = await live(cfg, 'start', { sk: 'forged' });
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), {
    error: 'sk is stamped by the gateway',
  });
  assert.equal(calls.length, 0);
});

test('the provider token is reused across pushes in one window', async () => {
  const { apple, fetchImpl } = upstream();
  const cfg = await config({ fetchImpl });
  await live(cfg, 'start');
  await live(cfg, 'update');
  const tokens = new Set(apple().map((call) => call.headers.authorization));
  assert.equal(apple().length, 3);
  assert.equal(tokens.size, 1);
});

test('an APNs request that outlives its timeout is retryable', async () => {
  let signal: AbortSignal | undefined;
  const hanging = ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      signal = init?.signal ?? undefined;
      signal?.addEventListener('abort', () => reject(signal?.reason));
    })) as typeof fetch;
  const parsed = parseLiveActivityRequest(
    encodeBody(liveActivityBody({}, 'update')),
    [IOS_BUNDLE],
    NOW,
  );
  assert.ok(parsed.ok);
  const sender = new ApnsSender(
    (await fakeApnsKey()).credentials,
    hanging,
    () => NOW,
    20,
  );
  const started = Date.now();
  const outcome = await sender.broadcast(parsed.request, encodeBody({}));
  assert.deepEqual(outcome, { kind: 'unavailable', status: 504 });
  assert.equal(signal?.aborted, true);
  assert.ok(Date.now() - started < 5_000);
});

test('calls the global fetch unbound, as the Workers runtime requires', async () => {
  const original = globalThis.fetch;
  const { apple, fetchImpl } = upstream();
  globalThis.fetch = function (
    this: unknown,
    input: RequestInfo | URL,
    init?: RequestInit,
  ) {
    if (this !== undefined && this !== globalThis) {
      throw new TypeError(
        'Illegal invocation: function called with incorrect `this` reference.',
      );
    }
    return fetchImpl(input, init);
  } as typeof fetch;
  try {
    const response = await live(
      await config({ fetchImpl: undefined }),
      'start',
    );
    assert.equal(response.status, 200);
    assert.equal(apple().length, 2);
  } finally {
    globalThis.fetch = original;
  }
});

const ledgerOf = (cfg: GatewayConfig) =>
  cfg.apns?.ledger as ReturnType<typeof fakeLedger>;

test('a created channel is recorded in the ledger', async () => {
  const { fetchImpl } = upstream();
  const cfg = await config({ fetchImpl });
  const station = await stationKey();
  assert.equal((await live(cfg, 'start', {}, station)).status, 200);
  const [row] = ledgerOf(cfg).rows();
  assert.ok(row, 'recorded');
  assert.equal(row.channel_id, NEW_CHANNEL);
  assert.equal(row.environment, 'sandbox');
  assert.equal(row.bundle_id, IOS_BUNDLE);
  assert.equal(row.created_at, NOW);
  const thumbprint = await jwkThumbprint(station.publicJwk);
  assert.match(String(row.station_key_hash), /^[\w-]{43}$/);
  assert.notEqual(row.station_key_hash, thumbprint, 'the key is hashed');
});

test('a channel given back or deleted leaves the ledger', async () => {
  const refused = upstream({
    start: () => Response.json({ reason: 'BadDeviceToken' }, { status: 400 }),
  });
  const refusedCfg = await config({ fetchImpl: refused.fetchImpl });
  assert.equal((await live(refusedCfg, 'start')).status, 410);
  assert.deepEqual(ledgerOf(refusedCfg).rows(), []);

  const seed = (cfg: GatewayConfig) =>
    ledgerOf(cfg).record({
      environment: 'sandbox',
      bundleId: IOS_BUNDLE,
      channelId: CHANNEL_ID,
      stationKeyHash: 'k',
      deviceHash: 'd',
      createdAt: NOW,
    });
  const { fetchImpl } = upstream();
  const cfg = await config({ fetchImpl });
  await seed(cfg);
  assert.equal((await del(cfg)).status, 200);
  assert.equal(ledgerOf(cfg).has(CHANNEL_ID), false);

  // A delete Apple refuses keeps the row: the channel may still exist.
  const failing = upstream({
    delete: () => new Response(null, { status: 500 }),
  });
  const failingCfg = await config({ fetchImpl: failing.fetchImpl });
  await seed(failingCfg);
  assert.equal((await del(failingCfg)).status, 503);
  assert.equal(ledgerOf(failingCfg).has(CHANNEL_ID), true);
});

test('a start whose channel cannot be recorded gives the channel back and pushes nothing', async () => {
  const { apple, fetchImpl } = upstream();
  const cfg = await config({ fetchImpl });
  // The daily-cap read succeeds; the record after the create fails.
  const ledger = ledgerOf(cfg);
  const record = ledger.record;
  ledger.record = async () => {
    throw new Error('ledger unreachable');
  };
  const response = await live(cfg, 'start');
  ledger.record = record;
  assert.equal(response.status, 503);
  assert.deepEqual(apple().map(kindOf), ['create', 'delete']);
  assert.ok(errors.some((line) => line.includes('ledger write failed')));
});

test('an unreachable ledger refuses starts before any channel is created', async () => {
  const { apple, fetchImpl } = upstream();
  const cfg = await config({ fetchImpl });
  ledgerOf(cfg).state.failing = true;
  const response = await live(cfg, 'start');
  assert.equal(response.status, 503);
  assert.deepEqual(apple(), []);
});

test('each device may create a limited number of channels per UTC day', async () => {
  const { apple, fetchImpl } = upstream();
  const cfg = await config({ fetchImpl });
  const other = 'cd'.repeat(40);
  const station = await stationKey();
  for (let index = 0; index < DAILY_STARTS_PER_DEVICE; index += 1) {
    assert.equal(
      (await live(cfg, 'start', {}, station)).status,
      200,
      `start ${index}`,
    );
  }
  const creates = () =>
    apple().filter((call) => kindOf(call) === 'create').length;
  assert.equal(creates(), DAILY_STARTS_PER_DEVICE);
  const refused = await live(cfg, 'start', {}, station);
  assert.equal(refused.status, 429);
  assert.equal(
    creates(),
    DAILY_STARTS_PER_DEVICE,
    'no channel for the refused start',
  );
  // Another device is unaffected.
  assert.equal(
    (await live(cfg, 'start', { pushToStartToken: other }, station)).status,
    200,
  );
  // The count is per UTC day: tomorrow the device starts afresh.
  const deviceHash = await bodyHash(
    new TextEncoder().encode(PUSH_TO_START_TOKEN),
  );
  const tomorrow = (Math.floor(NOW / 86_400) + 1) * 86_400;
  assert.equal(
    await ledgerOf(cfg).startsToday(deviceHash, NOW),
    DAILY_STARTS_PER_DEVICE,
  );
  assert.equal(await ledgerOf(cfg).startsToday(deviceHash, tomorrow), 0);
});

test('a refused daily cap spends no wider budget, and a refused start still counts', async () => {
  const log: string[] = [];
  const refusedStart = upstream({
    start: () => Response.json({ reason: 'BadDate' }, { status: 400 }),
  });
  const cfg = await config(
    { fetchImpl: refusedStart.fetchImpl },
    {
      channelPerKeyLimiter: recording(log, 'key'),
      channelGlobalLimiter: recording(log, 'global'),
    },
  );
  // Every created channel counts, even when Apple then refuses the start.
  for (let index = 0; index < DAILY_STARTS_PER_DEVICE; index += 1)
    assert.equal((await live(cfg, 'start')).status, 422);
  log.length = 0;
  assert.equal((await live(cfg, 'start')).status, 429);
  assert.deepEqual(log, [], 'refused at the device before key or global');
});

test('the compensating delete runs through waitUntil, past the response', async () => {
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { apple, fetchImpl } = upstream({
    start: () => Response.json({ reason: 'Unregistered' }, { status: 410 }),
    delete: () => new Response(null, { status: 204 }),
  });
  // Apple's delete answers only once released: a response that waited for it
  // would never arrive.
  const gated = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'DELETE') await released;
    return fetchImpl(input, init);
  }) as typeof fetch;
  const cfg = await config({ fetchImpl: gated });
  const deferred: Promise<unknown>[] = [];
  const ctx = { waitUntil: (work: Promise<unknown>) => deferred.push(work) };
  const station = await stationKey();

  const answered = post(
    cfg,
    '/v1/apns/live-activity',
    liveActivityBody(),
    station,
    { ctx },
  );
  const first = await Promise.race([
    answered,
    new Promise<'still waiting'>((resolve) =>
      setTimeout(() => resolve('still waiting'), 2_000),
    ),
  ]);
  if (first === 'still waiting') {
    release();
    await answered;
    assert.fail('the response waited for the compensating delete');
  }
  const response = first;
  assert.equal(response.status, 410);
  assert.equal(deferred.length, 1, 'the delete was handed to waitUntil');
  assert.ok(ledgerOf(cfg).has(NEW_CHANNEL), 'not yet');

  release();
  await Promise.all(deferred);
  assert.deepEqual(apple().map(kindOf), ['create', 'start', 'delete']);
  assert.deepEqual(ledgerOf(cfg).rows(), []);
});

test('client addresses are limited per IPv6 /64, IPv4 as they are', async () => {
  assert.equal(addressBucket('203.0.113.7'), '203.0.113.7');
  assert.equal(addressBucket('2001:db8:1:2:aaaa::1'), '2001:db8:1:2::/64');
  assert.equal(
    addressBucket('2001:0DB8:0001:0002:ffff:ffff:ffff:ffff'),
    '2001:db8:1:2::/64',
  );
  assert.equal(addressBucket('2001:db8::1'), '2001:db8:0:0::/64');
  // IPv4-mapped and NAT64 addresses are one IPv4 client each.
  assert.equal(addressBucket('::ffff:192.0.2.1'), '192.0.2.1');
  assert.equal(addressBucket('::FFFF:c000:0201'), '192.0.2.1');
  assert.equal(addressBucket('64:ff9b::198.51.100.7'), '198.51.100.7');
  assert.equal(addressBucket('64:ff9b::c633:6407'), '198.51.100.7');
  // Other addresses that merely end in an IPv4 are still bucketed by /64.
  assert.equal(addressBucket('2001:db8:1:2::192.0.2.1'), '2001:db8:1:2::/64');
  assert.equal(addressBucket('64:ff9b:1::1'), '64:ff9b:1:0::/64');
  assert.equal(addressBucket('fe80::'), 'fe80:0:0:0::/64');

  const log: string[] = [];
  const cfg = await config(
    { fetchImpl: upstream().fetchImpl, perIpLimiter: recording(log, 'any') },
    { channelPerIpLimiter: recording(log, 'ip') },
  );
  const station = await stationKey();
  for (const ip of [
    '2001:db8:1:2::1',
    '2001:db8:1:2:ffff::9',
    '2001:db8:1:3::1',
  ]) {
    await post(cfg, '/v1/apns/live-activity', liveActivityBody(), station, {
      ip,
    });
  }
  const channelKeys = log.filter((entry) => entry.startsWith('ip:'));
  assert.deepEqual(channelKeys, [
    'ip:2001:db8:1:2::/64',
    'ip:2001:db8:1:2::/64',
    'ip:2001:db8:1:3::/64',
  ]);
  assert.ok(
    log
      .filter((entry) => entry.startsWith('any:'))
      .every((entry) => entry.endsWith('/64')),
    'the pre-work per-address limit uses the same bucket',
  );
});
