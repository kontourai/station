import assert from 'node:assert/strict';
import { test } from 'vitest';
import { type GatewayConfig, handleRequest } from '../src/gateway.ts';
import { jwkThumbprint } from '../src/station-auth.ts';
import {
  AUDIENCE,
  allow,
  fakeServiceAccount,
  NOW,
  PACKAGE,
  sendBody,
  signRequest,
  stationKey,
} from './helpers.ts';

interface Recorded {
  url: string;
  body: string;
}

/** Stubs Google's token endpoint and FCM, recording every call. */
function upstream(fcmResponse: () => Response) {
  const calls: Recorded[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: String(init?.body ?? '') });
    if (url === 'https://oauth2.googleapis.com/token') {
      return Response.json({ access_token: 'ya29.test', expires_in: 3600 });
    }
    return fcmResponse();
  }) as typeof fetch;
  return { calls, fetchImpl };
}

async function config(
  overrides: Partial<GatewayConfig> = {},
): Promise<GatewayConfig> {
  return {
    audiences: [AUDIENCE],
    allowedPackages: [PACKAGE],
    // A fresh account object per test: the sender cache is keyed on it.
    serviceAccount: (await fakeServiceAccount()).account,
    perIpLimiter: allow,
    globalLimiter: allow,
    perKeyLimiter: allow,
    perTokenLimiter: allow,
    nowSeconds: () => NOW,
    ...overrides,
  };
}

async function send(
  cfg: GatewayConfig,
  body = sendBody(),
  key?: Awaited<ReturnType<typeof stationKey>>,
) {
  const signer = key ?? (await stationKey());
  return handleRequest(
    new Request(`${AUDIENCE}/v1/fcm/send`, {
      method: 'POST',
      headers: { authorization: await signRequest(body, signer) },
      body,
    }),
    cfg,
  );
}

test('forwards a signed request to FCM as a high-priority, data-only, package-restricted message', async () => {
  const { calls, fetchImpl } = upstream(() =>
    Response.json({ name: 'projects/x/messages/1' }),
  );
  const response = await send(await config({ fetchImpl }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { result: 'sent' });

  const fcm = calls.find((call) => call.url.includes('fcm.googleapis.com'));
  assert.ok(fcm, 'FCM was called');
  assert.equal(
    fcm.url,
    'https://fcm.googleapis.com/v1/projects/kontour-station/messages:send',
  );
  const message = JSON.parse(fcm.body).message;
  assert.equal(
    message.notification,
    undefined,
    'no display notification bypasses the app',
  );
  assert.equal(message.android.priority, 'HIGH');
  assert.equal(message.android.ttl, '300s');
  assert.equal(message.android.restricted_package_name, PACKAGE);
  assert.equal(message.data.station_kind, 'agent_activity');
});

test('forwards a notification with its collapse key, asked priority and an hour to live', async () => {
  const { calls, fetchImpl } = upstream(() => Response.json({}));
  const cfg = await config({ fetchImpl });
  const collapseKey = `n${'a'.repeat(40)}`;
  const message = async (priority?: 'normal') => {
    calls.length = 0;
    const response = await send(
      cfg,
      sendBody({
        data: {
          station_kind: 'station_notification',
          device_id: 'reg-1',
          sealed: 'AAECAwQFBgcICQoL',
        },
        collapseKey,
        ...(priority ? { priority } : {}),
      }),
    );
    assert.equal(response.status, 200);
    const fcm = calls.find((call) => call.url.includes('fcm.googleapis.com'));
    assert.ok(fcm, 'FCM was called');
    return JSON.parse(fcm.body).message;
  };
  const high = await message();
  assert.equal(high.notification, undefined);
  assert.equal(high.android.priority, 'HIGH');
  assert.equal(high.android.ttl, '3600s');
  assert.equal(high.android.collapse_key, collapseKey);
  assert.equal(high.data.station_kind, 'station_notification');
  assert.equal(typeof high.data.station_key, 'string');
  const normal = await message('normal');
  assert.equal(normal.android.priority, 'NORMAL');
});

test('signs the Google assertion with the service account key', async () => {
  const { account, publicKey } = await fakeServiceAccount();
  const { calls, fetchImpl } = upstream(() => Response.json({}));
  await send(await config({ serviceAccount: account, fetchImpl }));
  const assertion = new URLSearchParams(calls[0].body).get('assertion') ?? '';
  const [header, claims, signature] = assertion.split('.');
  const decode = (segment: string) =>
    Uint8Array.from(
      atob(segment.replaceAll('-', '+').replaceAll('_', '/')),
      (c) => c.charCodeAt(0),
    );
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    publicKey,
    decode(signature),
    new TextEncoder().encode(`${header}.${claims}`),
  );
  assert.equal(valid, true);
  const payload = JSON.parse(new TextDecoder().decode(decode(claims)));
  assert.equal(
    payload.scope,
    'https://www.googleapis.com/auth/firebase.messaging',
  );
  assert.equal(payload.iss, account.clientEmail);
});

test('reuses the Google access token across sends', async () => {
  const { calls, fetchImpl } = upstream(() => Response.json({}));
  const cfg = await config({ fetchImpl });
  await send(cfg);
  await send(cfg);
  assert.equal(calls.filter((call) => call.url.includes('oauth2')).length, 1);
  assert.equal(calls.filter((call) => call.url.includes('fcm')).length, 2);
});

test('tells the Station to forget an unregistered token', async () => {
  const { fetchImpl } = upstream(() =>
    Response.json(
      { error: { details: [{ errorCode: 'UNREGISTERED' }] } },
      { status: 404 },
    ),
  );
  const response = await send(await config({ fetchImpl }));
  assert.equal(response.status, 410);
  assert.deepEqual(await response.json(), { result: 'unregistered' });
});

test('distinguishes retryable from permanent FCM failures', async () => {
  const retry = upstream(() => new Response('', { status: 500 }));
  const retryResponse = await send(
    await config({ fetchImpl: retry.fetchImpl }),
  );
  assert.equal(retryResponse.status, 503);
  assert.deepEqual(await retryResponse.json(), { result: 'unavailable' });

  const bad = upstream(() =>
    Response.json(
      { error: { details: [{ errorCode: 'INVALID_ARGUMENT' }] } },
      { status: 400 },
    ),
  );
  const badResponse = await send(await config({ fetchImpl: bad.fetchImpl }));
  assert.equal(badResponse.status, 422);
});

test('never reaches FCM for an unauthenticated or invalid request', async () => {
  const { calls, fetchImpl } = upstream(() => Response.json({}));
  const cfg = await config({ fetchImpl });

  const unsigned = await handleRequest(
    new Request(`${AUDIENCE}/v1/fcm/send`, {
      method: 'POST',
      body: sendBody(),
    }),
    cfg,
  );
  assert.equal(unsigned.status, 401);

  const invalid = await send(
    cfg,
    sendBody({ packageName: 'com.example.other' }),
  );
  assert.equal(invalid.status, 400);
  assert.equal(calls.length, 0);
});

test('rate limits per Station key, keyed by the key thumbprint', async () => {
  const keys: string[] = [];
  const perKeyLimiter = {
    limit: async ({ key }: { key: string }) => {
      keys.push(key);
      return { success: false };
    },
  };
  const { calls, fetchImpl } = upstream(() => Response.json({}));
  const station = await stationKey();
  const response = await send(
    await config({ perKeyLimiter, fetchImpl }),
    sendBody(),
    station,
  );
  assert.equal(response.status, 429);
  assert.deepEqual(keys, [await jwkThumbprint(station.publicJwk)]);
  assert.equal(calls.length, 0);
});

test('unsigned requests never touch the shared global budget', async () => {
  let globalCalls = 0;
  const globalLimiter = {
    limit: async () => {
      globalCalls += 1;
      return { success: true };
    },
  };
  const response = await handleRequest(
    new Request(`${AUDIENCE}/v1/fcm/send`, {
      method: 'POST',
      body: sendBody(),
    }),
    await config({ globalLimiter }),
  );
  assert.equal(response.status, 401);
  assert.equal(
    globalCalls,
    0,
    'junk cannot spend the budget real Stations share',
  );
});

test('limits each client address before doing any work', async () => {
  const keys: string[] = [];
  const perIpLimiter = {
    limit: async ({ key }: { key: string }) => {
      keys.push(key);
      return { success: false };
    },
  };
  const response = await handleRequest(
    new Request(`${AUDIENCE}/v1/fcm/send`, {
      method: 'POST',
      headers: { 'cf-connecting-ip': '203.0.113.9' },
      body: sendBody(),
    }),
    await config({ perIpLimiter }),
  );
  assert.equal(response.status, 429);
  assert.deepEqual(keys, ['203.0.113.9']);
});

test('limits each push token whichever key signs for it', async () => {
  const keys: string[] = [];
  const perTokenLimiter = {
    limit: async ({ key }: { key: string }) => {
      keys.push(key);
      return { success: keys.length < 2 };
    },
  };
  const { fetchImpl } = upstream(() => Response.json({}));
  const cfg = await config({ perTokenLimiter, fetchImpl });
  assert.equal((await send(cfg)).status, 200);
  // A fresh key per request is free; the token limit still applies.
  assert.equal((await send(cfg, sendBody(), await stationKey())).status, 429);
  assert.equal(keys[0], keys[1], 'keyed on the token, not the signing key');
  assert.ok(!keys[0].includes('f'.repeat(20)), 'the raw token is not the key');
});

test('stamps the verified key thumbprint into the payload', async () => {
  const { calls, fetchImpl } = upstream(() => Response.json({}));
  const station = await stationKey();
  await send(await config({ fetchImpl }), sendBody(), station);
  const fcm = calls.find((call) => call.url.includes('fcm'));
  assert.ok(fcm);
  assert.equal(
    JSON.parse(fcm.body).message.data.station_key,
    await jwkThumbprint(station.publicJwk),
  );
});

test('refuses a body larger than the limit even without a content-length', async () => {
  const station = await stationKey();
  const chunk = new Uint8Array(4096);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < 4; i += 1) controller.enqueue(chunk);
      controller.close();
    },
  });
  const response = await handleRequest(
    new Request(`${AUDIENCE}/v1/fcm/send`, {
      method: 'POST',
      headers: { authorization: await signRequest(sendBody(), station) },
      body: stream,
      duplex: 'half',
    } as RequestInit),
    await config(),
  );
  assert.equal(response.status, 413);
});

test('treats an FCM bad-token error as unregistered', async () => {
  const { fetchImpl } = upstream(() =>
    Response.json(
      {
        error: {
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.BadRequest',
              fieldViolations: [{ field: 'message.token' }],
            },
          ],
        },
      },
      { status: 400 },
    ),
  );
  const response = await send(await config({ fetchImpl }));
  assert.equal(response.status, 410);
});

test('retries once with a fresh Google token after a 401', async () => {
  let fcmCalls = 0;
  const { calls, fetchImpl } = upstream(() => {
    fcmCalls += 1;
    return fcmCalls === 1
      ? new Response('', { status: 401 })
      : Response.json({});
  });
  const response = await send(await config({ fetchImpl }));
  assert.equal(response.status, 200);
  assert.equal(calls.filter((call) => call.url.includes('oauth2')).length, 2);
});

test('shares one Google token exchange across concurrent sends', async () => {
  const { calls, fetchImpl } = upstream(() => Response.json({}));
  const cfg = await config({ fetchImpl });
  const results = await Promise.all([send(cfg), send(cfg), send(cfg)]);
  assert.deepEqual(
    results.map((r) => r.status),
    [200, 200, 200],
  );
  assert.equal(calls.filter((call) => call.url.includes('oauth2')).length, 1);
});

test('reports unconfigured delivery, oversize bodies and unknown routes', async () => {
  assert.equal(
    (await send(await config({ serviceAccount: null }))).status,
    503,
  );
  const big = new Uint8Array(9 * 1024);
  assert.equal((await send(await config(), big)).status, 413);
  assert.equal(
    (await handleRequest(new Request(`${AUDIENCE}/nope`), await config()))
      .status,
    404,
  );
  assert.equal(
    (await handleRequest(new Request(`${AUDIENCE}/health`), await config()))
      .status,
    200,
  );
});

test('calls the global fetch unbound, as the Workers runtime requires', async () => {
  // Workers rejects fetch invoked with any other `this` ("Illegal invocation");
  // Node does not, so reproduce the rule here.
  const original = globalThis.fetch;
  const { calls, fetchImpl } = upstream(() => Response.json({}));
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
    const response = await send(await config({ fetchImpl: undefined }));
    assert.equal(response.status, 200);
    assert.equal(calls.filter((call) => call.url.includes('fcm')).length, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test('checks per token, then per key, then global, stopping at the first refusal', async () => {
  const order = ['token', 'key', 'global'] as const;
  for (const [index, refused] of order.entries()) {
    const seen: string[] = [];
    const limiter = (name: (typeof order)[number]) => ({
      limit: async () => {
        seen.push(name);
        return { success: name !== refused };
      },
    });
    const { calls, fetchImpl } = upstream(() => Response.json({}));
    const response = await send(
      await config({
        fetchImpl,
        perTokenLimiter: limiter('token'),
        perKeyLimiter: limiter('key'),
        globalLimiter: limiter('global'),
      }),
    );
    assert.equal(response.status, 429, refused);
    // A request refused narrowly never spends a wider, shared budget.
    assert.deepEqual(seen, order.slice(0, index + 1), refused);
    assert.equal(calls.length, 0);
  }
});
