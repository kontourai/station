import assert from 'node:assert/strict';
import { beforeEach, test } from 'vitest';
import { resetProviderTokenCacheForTest } from '../src/apns-token.ts';
import { type GatewayConfig, handleRequest } from '../src/gateway.ts';
import { jwkThumbprint } from '../src/station-auth.ts';
import {
  AUDIENCE,
  allow,
  CHANNEL_ID,
  encodeBody,
  fakeApnsKey,
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

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function headerRecord(init: HeadersInit | undefined): Record<string, string> {
  const record: Record<string, string> = {};
  new Headers(init).forEach((value, name) => {
    record[name] = value;
  });
  return record;
}

/** Stubs every upstream, recording each call; `reply` answers APNs calls. */
function upstream(
  reply: (call: Recorded) => Response = () => new Response(null),
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
    return reply(call);
  }) as typeof fetch;
  return { calls, fetchImpl };
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
      channelGlobalLimiter: allow,
      channelPerKeyLimiter: allow,
    },
    nowSeconds: () => NOW,
    ...overrides,
  };
}

async function post(
  cfg: GatewayConfig,
  path: string,
  value: unknown,
  key?: Awaited<ReturnType<typeof stationKey>>,
) {
  const body = encodeBody(value);
  return handleRequest(
    new Request(`${AUDIENCE}${path}`, {
      method: 'POST',
      headers: {
        authorization: await signRequest(body, key ?? (await stationKey())),
      },
      body,
    }),
    cfg,
  );
}

const live = (
  cfg: GatewayConfig,
  value: unknown,
  key?: Awaited<ReturnType<typeof stationKey>>,
) => post(cfg, '/v1/apns/live-activity', value, key);
const channel = (
  cfg: GatewayConfig,
  value: unknown,
  key?: Awaited<ReturnType<typeof stationKey>>,
) => post(cfg, '/v1/apns/channels', value, key);

beforeEach(() => resetProviderTokenCacheForTest());

for (const [environment, host] of [
  ['sandbox', 'https://api.sandbox.push.apple.com'],
  ['production', 'https://api.push.apple.com'],
] as const) {
  test(`push-to-start goes to the ${environment} device endpoint with the liveactivity topic`, async () => {
    const { calls, fetchImpl } = upstream();
    const station = await stationKey();
    const response = await live(
      await config({ fetchImpl }),
      liveActivityBody({ environment }),
      station,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { result: 'sent' });
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call.method, 'POST');
    assert.equal(call.url, `${host}/3/device/${PUSH_TO_START_TOKEN}`);
    assert.equal(call.headers['apns-push-type'], 'liveactivity');
    assert.equal(
      call.headers['apns-topic'],
      `${IOS_BUNDLE}.push-type.liveactivity`,
    );
    assert.equal(call.headers['apns-priority'], '10');
    assert.equal(call.headers['apns-expiration'], String(NOW + 300));
    assert.equal(call.headers['apns-channel-id'], undefined);
    assert.match(call.headers.authorization, /^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    const aps = JSON.parse(call.body).aps;
    assert.equal(aps.event, 'start');
    assert.equal(aps['input-push-channel'], CHANNEL_ID);
    assert.deepEqual(aps['content-state'], {
      v: 1,
      rid: REGISTRATION_ID,
      sk: await jwkThumbprint(station.publicJwk),
      sealed: SEALED,
    });
  });

  test(`update and end broadcast to the ${environment} channel endpoint`, async () => {
    const { calls, fetchImpl } = upstream();
    const cfg = await config({ fetchImpl });
    assert.equal((await live(cfg, liveActivityBody({}, 'update'))).status, 200);
    assert.equal(
      (await live(cfg, liveActivityBody({ environment }, 'end'))).status,
      200,
    );
    const [update, end] = calls;
    assert.equal(
      update.url,
      `https://api.sandbox.push.apple.com/4/broadcasts/apps/${IOS_BUNDLE}`,
    );
    assert.equal(end.url, `${host}/4/broadcasts/apps/${IOS_BUNDLE}`);
    for (const call of [update, end]) {
      assert.equal(call.method, 'POST');
      assert.equal(call.headers['apns-channel-id'], CHANNEL_ID);
      assert.equal(call.headers['apns-push-type'], 'liveactivity');
      assert.equal(call.headers['apns-topic'], undefined);
      assert.equal(call.headers['apns-expiration'], String(NOW + 300));
    }
    assert.equal(update.headers['apns-priority'], '5');
    assert.equal(end.headers['apns-priority'], '10');
    assert.equal(JSON.parse(update.body).aps.event, 'update');
    assert.equal(JSON.parse(end.body).aps['dismissal-date'], NOW + 900);
  });

  test(`creates and deletes channels on the ${environment} management host`, async () => {
    const port = environment === 'production' ? 2196 : 2195;
    const manage = `https://api-manage-broadcast${environment === 'production' ? '' : '.sandbox'}.push.apple.com:${port}`;
    const { calls, fetchImpl } = upstream((call) =>
      call.method === 'POST'
        ? new Response(null, {
            status: 201,
            headers: { 'apns-channel-id': CHANNEL_ID },
          })
        : new Response(null, { status: 204 }),
    );
    const cfg = await config({ fetchImpl });
    const base = { bundleId: IOS_BUNDLE, environment };
    const created = await channel(cfg, { op: 'create', ...base });
    assert.equal(created.status, 200);
    assert.deepEqual(await created.json(), {
      result: 'created',
      channelId: CHANNEL_ID,
    });
    const deleted = await channel(cfg, {
      op: 'delete',
      ...base,
      channelId: CHANNEL_ID,
    });
    assert.equal(deleted.status, 200);
    assert.deepEqual(await deleted.json(), { result: 'deleted' });

    const [create, remove] = calls;
    assert.equal(create.method, 'POST');
    assert.equal(create.url, `${manage}/1/apps/${IOS_BUNDLE}/channels`);
    assert.deepEqual(JSON.parse(create.body), {
      'message-storage-policy': 1,
      'push-type': 'LiveActivity',
    });
    assert.equal(create.headers['apns-channel-id'], undefined);
    assert.equal(remove.method, 'DELETE');
    assert.equal(remove.url, `${manage}/1/apps/${IOS_BUNDLE}/channels`);
    assert.equal(remove.headers['apns-channel-id'], CHANNEL_ID);
    assert.equal(remove.body, '');
    for (const call of calls)
      assert.match(call.headers.authorization, /^bearer /);
  });
}

test('an alerting update goes out at priority 10', async () => {
  const { calls, fetchImpl } = upstream();
  await live(
    await config({ fetchImpl }),
    liveActivityBody({ alert: true }, 'update'),
  );
  assert.equal(calls[0].headers['apns-priority'], '10');
  assert.deepEqual(JSON.parse(calls[0].body).aps.alert, {
    title: 'Station',
    body: 'Agent activity',
    sound: 'default',
  });
});

test('maps each APNs answer to the contract outcome', async () => {
  const apns = (status: number, reason?: string) => () =>
    reason === undefined
      ? new Response(null, { status })
      : Response.json({ reason }, { status });
  const cases: Array<[string, () => Response, number, string]> = [
    ['start', apns(410, 'Unregistered'), 410, 'unregistered'],
    ['start', apns(400, 'BadDeviceToken'), 410, 'unregistered'],
    ['start', apns(400, 'DeviceTokenNotForTopic'), 410, 'unregistered'],
    ['update', apns(400, 'BadChannelId'), 410, 'channel-gone'],
    ['update', apns(410, 'ChannelNotRegistered'), 410, 'channel-gone'],
    ['end', apns(404), 410, 'channel-gone'],
    ['update', apns(413, 'PayloadTooLarge'), 422, 'rejected'],
    ['start', apns(400, 'BadDate'), 422, 'rejected'],
    ['update', apns(429, 'TooManyRequests'), 503, 'unavailable'],
    ['start', apns(500, 'InternalServerError'), 503, 'unavailable'],
    ['update', apns(503, 'ServiceUnavailable'), 503, 'unavailable'],
    ['start', apns(403, 'InvalidProviderToken'), 503, 'unavailable'],
    ['update', apns(403, 'ExpiredProviderToken'), 503, 'unavailable'],
  ];
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => errors.push(args.join(' '));
  try {
    for (const [event, reply, status, result] of cases) {
      const { fetchImpl } = upstream(reply);
      const response = await live(
        await config({ fetchImpl }),
        liveActivityBody({}, event as 'start' | 'update' | 'end'),
      );
      const label = `${event} ${reply().status}`;
      assert.equal(response.status, status, label);
      // The upstream reason is never relayed to the caller.
      assert.deepEqual(await response.json(), { result }, label);
    }
  } finally {
    console.error = original;
  }
  assert.ok(
    errors.some(
      (line) =>
        line.includes('configuration fault') &&
        line.includes('InvalidProviderToken'),
    ),
    'a refused provider token is logged as a configuration fault',
  );
});

test('an unreachable APNs is retryable', async () => {
  const fetchImpl = (async () => {
    throw new TypeError('network down');
  }) as typeof fetch;
  const response = await live(await config({ fetchImpl }), liveActivityBody());
  assert.equal(response.status, 503);
});

test('channel outcomes: already-gone deletes succeed, failures do not leak', async () => {
  const base = { bundleId: IOS_BUNDLE, environment: 'sandbox' };
  const del = { op: 'delete', ...base, channelId: CHANNEL_ID };
  const gone = upstream(() =>
    Response.json({ reason: 'BadChannelId' }, { status: 400 }),
  );
  assert.deepEqual(
    await (
      await channel(await config({ fetchImpl: gone.fetchImpl }), del)
    ).json(),
    {
      result: 'deleted',
    },
  );
  const missing = upstream(() => new Response(null, { status: 404 }));
  assert.equal(
    (await channel(await config({ fetchImpl: missing.fetchImpl }), del)).status,
    200,
  );

  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => errors.push(args.join(' '));
  try {
    // A create that succeeds without a usable id cannot be handed back.
    for (const header of [null, 'not a channel id']) {
      const odd = upstream(
        () =>
          new Response(null, {
            status: 201,
            headers: header ? { 'apns-channel-id': header } : {},
          }),
      );
      const response = await channel(
        await config({ fetchImpl: odd.fetchImpl }),
        {
          op: 'create',
          ...base,
        },
      );
      assert.equal(response.status, 503);
    }
    const quota = upstream(() =>
      Response.json({ reason: 'TooManyChannels' }, { status: 429 }),
    );
    assert.equal(
      (
        await channel(await config({ fetchImpl: quota.fetchImpl }), {
          op: 'create',
          ...base,
        })
      ).status,
      503,
    );
    const denied = upstream(() =>
      Response.json({ reason: 'InvalidProviderToken' }, { status: 403 }),
    );
    const response = await channel(
      await config({ fetchImpl: denied.fetchImpl }),
      {
        op: 'create',
        ...base,
      },
    );
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { result: 'unavailable' });
  } finally {
    console.error = original;
  }
});

test('the APNs routes answer 503 until APNs is configured, before any work', async () => {
  const { calls, fetchImpl } = upstream();
  let limited = 0;
  const perIpLimiter = {
    limit: async () => {
      limited += 1;
      return { success: true };
    },
  };
  for (const apns of [null, undefined]) {
    const cfg = await config({ apns, fetchImpl, perIpLimiter });
    assert.equal((await live(cfg, liveActivityBody())).status, 503);
    assert.equal(
      (
        await channel(cfg, {
          op: 'create',
          bundleId: IOS_BUNDLE,
          environment: 'sandbox',
        })
      ).status,
      503,
    );
    // FCM is independent of APNs configuration.
    const fcm = await post(
      cfg,
      '/v1/fcm/send',
      JSON.parse(new TextDecoder().decode(sendBody())),
    );
    assert.equal(fcm.status, 200);
  }
  assert.equal(calls.filter((call) => call.url.includes('apple')).length, 0);
  assert.equal(limited, 2, 'only the FCM requests reached the limiter');
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
  const original = console.error;
  console.error = () => {};
  try {
    assert.equal((await live(cfg, liveActivityBody())).status, 503);
  } finally {
    console.error = original;
  }
  assert.equal(calls.length, 0);
});

test('the APNs routes share the signed-request checks and limits', async () => {
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
  const refusePerKey = { limit: async () => ({ success: false }) };
  assert.equal(
    (
      await live(
        await config({ fetchImpl, perKeyLimiter: refusePerKey }),
        liveActivityBody(),
      )
    ).status,
    429,
  );
  const invalid = await live(cfg, liveActivityBody({ sk: 'forged' }));
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), {
    error: 'sk is stamped by the gateway',
  });
  assert.equal(calls.length, 0);
});

test('limits each push by its device token or channel, hashed', async () => {
  const keys: string[] = [];
  const perTokenLimiter = {
    limit: async ({ key }: { key: string }) => {
      keys.push(key);
      return { success: false };
    },
  };
  const { calls, fetchImpl } = upstream();
  const cfg = await config({ fetchImpl, perTokenLimiter });
  assert.equal((await live(cfg, liveActivityBody())).status, 429);
  assert.equal((await live(cfg, liveActivityBody({}, 'update'))).status, 429);
  assert.equal((await live(cfg, liveActivityBody({}, 'end'))).status, 429);
  assert.equal(calls.length, 0);
  assert.notEqual(keys[0], keys[1], 'start is keyed on the device token');
  assert.equal(keys[1], keys[2], 'update and end share the channel key');
  assert.ok(
    !keys.some(
      (key) => key.includes(PUSH_TO_START_TOKEN) || key === CHANNEL_ID,
    ),
  );
});

test('channel management has its own global and per-key ceilings', async () => {
  const station = await stationKey();
  const create = { op: 'create', bundleId: IOS_BUNDLE, environment: 'sandbox' };
  const seen: string[] = [];
  const refuse = (name: string) => ({
    limit: async ({ key }: { key: string }) => {
      seen.push(`${name}:${key}`);
      return { success: false };
    },
  });
  const { calls, fetchImpl } = upstream();

  const globalCfg = await config({ fetchImpl });
  assert.ok(globalCfg.apns);
  globalCfg.apns.channelGlobalLimiter = refuse('global');
  assert.equal((await channel(globalCfg, create, station)).status, 429);

  const perKeyCfg = await config({ fetchImpl });
  assert.ok(perKeyCfg.apns);
  perKeyCfg.apns.channelPerKeyLimiter = refuse('key');
  assert.equal((await channel(perKeyCfg, create, station)).status, 429);

  assert.deepEqual(seen, [
    'global:global',
    `key:${await jwkThumbprint(station.publicJwk)}`,
  ]);
  assert.equal(calls.length, 0);

  // Pushes do not spend the channel budget.
  const pushCfg = await config({ fetchImpl });
  assert.ok(pushCfg.apns);
  pushCfg.apns.channelGlobalLimiter = refuse('global');
  pushCfg.apns.channelPerKeyLimiter = refuse('key');
  assert.equal(
    (await live(pushCfg, liveActivityBody({}, 'update'))).status,
    200,
  );
});

test('the provider token is reused across pushes in one window', async () => {
  const { calls, fetchImpl } = upstream();
  const cfg = await config({ fetchImpl });
  await live(cfg, liveActivityBody());
  await live(cfg, liveActivityBody({}, 'update'));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers.authorization, calls[1].headers.authorization);
});

test('calls the global fetch unbound, as the Workers runtime requires', async () => {
  const original = globalThis.fetch;
  const { calls, fetchImpl } = upstream();
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
      liveActivityBody(),
    );
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = original;
  }
});
