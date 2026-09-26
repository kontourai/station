import assert from 'node:assert/strict';
import { test } from 'vitest';
import worker, { type Env } from '../src/worker.ts';
import {
  AUDIENCE,
  alertBody,
  allow,
  CHANNEL_AUTH_SECRET,
  fakeApnsKey,
  fakeLedger,
  IOS_BUNDLE,
  KEY_ID,
  signRequest,
  stationKey,
  TEAM_ID,
} from './helpers.ts';

async function fullEnv(): Promise<Env> {
  return {
    AUDIENCES: AUDIENCE,
    ALLOWED_PACKAGES: 'io.kontourai.station',
    PER_IP_LIMITER: allow,
    GLOBAL_LIMITER: allow,
    PER_KEY_LIMITER: allow,
    PER_TOKEN_LIMITER: allow,
    APNS_AUTH_KEY: (await fakeApnsKey()).credentials.privateKeyPem,
    APNS_TEAM_ID: TEAM_ID,
    APNS_KEY_ID: KEY_ID,
    ALLOWED_IOS_BUNDLES: IOS_BUNDLE,
    APNS_CHANNEL_AUTH_SECRET: CHANNEL_AUTH_SECRET,
    CHANNEL_PER_IP_LIMITER: allow,
    CHANNEL_PER_DEVICE_LIMITER: allow,
    CHANNEL_PER_KEY_LIMITER: allow,
    CHANNEL_GLOBAL_LIMITER: allow,
    CHANNEL_DELETE_LIMITER: allow,
    CHANNEL_LEDGER: fakeLedger().namespace,
    ALERT_PER_TOKEN_LIMITER: allow,
  };
}

// Unsigned on purpose: a configured route gets as far as authentication
// (401), an unconfigured one stops at 503 before doing any work.
const statusOf = async (env: Env, path: string) =>
  (
    await worker.fetch(
      new Request(`${AUDIENCE}${path}`, { method: 'POST', body: '{}' }),
      env,
    )
  ).status;

test('with every APNs setting present the routes are live', async () => {
  const env = await fullEnv();
  assert.equal(await statusOf(env, '/v1/apns/live-activity'), 401);
  assert.equal(await statusOf(env, '/v1/apns/channels'), 401);
});

test('APNs ships dark when any setting is missing or unusable', async () => {
  const missing: Array<[keyof Env, string | undefined]> = [
    ['APNS_AUTH_KEY', undefined],
    ['APNS_AUTH_KEY', 'not a key'],
    ['APNS_TEAM_ID', undefined],
    ['APNS_KEY_ID', 'bad'],
    ['ALLOWED_IOS_BUNDLES', ''],
    ['APNS_CHANNEL_AUTH_SECRET', undefined],
    ['APNS_CHANNEL_AUTH_SECRET', 'too-short'],
    ['CHANNEL_PER_IP_LIMITER', undefined],
    ['CHANNEL_PER_DEVICE_LIMITER', undefined],
    ['CHANNEL_PER_KEY_LIMITER', undefined],
    ['CHANNEL_GLOBAL_LIMITER', undefined],
    ['CHANNEL_DELETE_LIMITER', undefined],
    ['CHANNEL_LEDGER', undefined],
  ];
  for (const [name, value] of missing) {
    const env = { ...(await fullEnv()), [name]: value } as Env;
    assert.equal(await statusOf(env, '/v1/apns/live-activity'), 503, name);
    assert.equal(await statusOf(env, '/v1/apns/channels'), 503, name);
  }
});

test('the Worker exports the ChannelLedger Durable Object that wrangler.jsonc binds', async () => {
  const module = await import('../src/worker.ts');
  assert.equal(typeof module.ChannelLedger, 'function');
  const { readFile } = await import('node:fs/promises');
  const wrangler = await readFile(
    new URL('../wrangler.jsonc', import.meta.url),
    'utf8',
  );
  assert.match(
    wrangler,
    /"bindings":\s*\[\{\s*"name":\s*"CHANNEL_LEDGER",\s*"class_name":\s*"ChannelLedger"\s*\}\]/,
  );
  assert.match(wrangler, /"new_sqlite_classes":\s*\["ChannelLedger"\]/);
  assert.doesNotMatch(wrangler, /kv_namespaces/);
});

test('the alert route needs its own per-token ceiling binding; the other APNs routes do not', async () => {
  // Signed, with a body the parser refuses: a configured alert route gets
  // as far as parsing (400), one without its ceiling stops at 503.
  const body = new TextEncoder().encode(
    JSON.stringify(alertBody({ kind: 'nope' })),
  );
  const alertStatus = async (env: Env) =>
    (
      await worker.fetch(
        new Request(`${AUDIENCE}/v1/apns/alert`, {
          method: 'POST',
          headers: {
            authorization: await signRequest(body, await stationKey(), {
              claims: {
                iat: Math.floor(Date.now() / 1000),
                exp: Math.floor(Date.now() / 1000) + 60,
              },
            }),
          },
          body,
        }),
        env,
      )
    ).status;
  const env = await fullEnv();
  assert.equal(await alertStatus(env), 400);
  const without = { ...env, ALERT_PER_TOKEN_LIMITER: undefined } as Env;
  assert.equal(await alertStatus(without), 503);
  assert.equal(await statusOf(without, '/v1/apns/live-activity'), 401);
  const { readFile } = await import('node:fs/promises');
  const wrangler = await readFile(
    new URL('../wrangler.jsonc', import.meta.url),
    'utf8',
  );
  assert.match(wrangler, /"name":\s*"ALERT_PER_TOKEN_LIMITER"/);
});
