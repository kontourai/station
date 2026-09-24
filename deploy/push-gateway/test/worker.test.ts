import assert from 'node:assert/strict';
import { test } from 'vitest';
import worker, { type Env } from '../src/worker.ts';
import {
  AUDIENCE,
  allow,
  CHANNEL_AUTH_SECRET,
  fakeApnsKey,
  fakeLedger,
  IOS_BUNDLE,
  KEY_ID,
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
    CHANNEL_LEDGER: fakeLedger(),
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
