import assert from 'node:assert/strict';
import { test } from 'node:test';
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
    perKeyLimiter: allow,
    globalLimiter: allow,
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
  assert.equal(message.android.restricted_package_name, PACKAGE);
  assert.equal(message.data.station_kind, 'agent_activity');
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
  assert.deepEqual(await retryResponse.json(), {
    result: 'unavailable',
    upstreamStatus: 500,
  });

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

test('applies the global cap before checking signatures', async () => {
  const globalLimiter = { limit: async () => ({ success: false }) };
  const response = await handleRequest(
    new Request(`${AUDIENCE}/v1/fcm/send`, {
      method: 'POST',
      body: sendBody(),
    }),
    await config({ globalLimiter }),
  );
  assert.equal(response.status, 429);
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
