import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'vitest';
import { ApnsSender } from '../src/apns.ts';
import { sweepChannels } from '../src/apns-ledger.ts';
import { resetProviderTokenCacheForTest } from '../src/apns-token.ts';
import { sweep } from '../src/worker.ts';
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

const KEPT = 'KeptKeptKeptKeptKeptKA==';
const ORPHAN_A = 'Orph/nAAAAAAAAAAAAAAAA==';
const ORPHAN_B = 'Orph+nBBBBBBBBBBBBBBBA==';

/** Fake Apple management host: lists `channels` and records deletes. */
function apple(channels: Record<string, unknown[] | null>) {
  const deletes: string[] = [];
  const lists: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/all-channels')) {
      const env = url.includes('.sandbox.') ? 'sandbox' : 'production';
      lists.push(env);
      const listed = channels[env];
      return listed === null
        ? Response.json(
            { reason: 'BroadcastFeatureNotEnabled' },
            { status: 400 },
          )
        : Response.json({ channels: listed ?? [] });
    }
    if (init?.method === 'DELETE') {
      deletes.push(new Headers(init.headers).get('apns-channel-id') ?? '');
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 500 });
  }) as typeof fetch;
  return { deletes, lists, fetchImpl };
}

async function setup(channels: Record<string, unknown[] | null>) {
  const upstream = apple(channels);
  const store = fakeLedger();
  const sender = new ApnsSender(
    (await fakeApnsKey()).credentials,
    upstream.fetchImpl,
  );
  const run = (maxDeletes?: number) =>
    sweepChannels({ store, sender, bundles: [IOS_BUNDLE], maxDeletes });
  return { ...upstream, store, run };
}

let errors: string[] = [];
const originalError = console.error;
afterEach(() => {
  console.error = originalError;
});
beforeEach(() => {
  resetProviderTokenCacheForTest();
  errors = [];
  console.error = (...args: unknown[]) => {
    errors.push(args.join(' '));
  };
});

test('keeps ledgered channels and deletes unrecorded ones on the second sighting', async () => {
  const { store, run, deletes } = await setup({
    sandbox: [KEPT, ORPHAN_A, ORPHAN_B],
  });
  await store.put(`ch:sandbox:${IOS_BUNDLE}:${KEPT}`, '{}');

  const first = await run();
  assert.equal(first.kept, 1);
  assert.equal(first.marked, 2);
  assert.equal(first.deleted, 0);
  assert.deepEqual(
    deletes,
    [],
    'a fresh write may not be visible yet: mark only',
  );

  const second = await run();
  assert.equal(second.kept, 1);
  assert.equal(second.deleted, 2);
  assert.deepEqual(deletes.sort(), [ORPHAN_A, ORPHAN_B].sort());
  assert.equal(
    store.entries.has(`suspect:sandbox:${IOS_BUNDLE}:${ORPHAN_A}`),
    false,
  );
  assert.equal(store.entries.has(`ch:sandbox:${IOS_BUNDLE}:${KEPT}`), true);
});

test('a channel ledgered after being marked is kept', async () => {
  const { store, run, deletes } = await setup({ sandbox: [ORPHAN_A] });
  await run();
  await store.put(`ch:sandbox:${IOS_BUNDLE}:${ORPHAN_A}`, '{}');
  const second = await run();
  assert.equal(second.kept, 1);
  assert.deepEqual(deletes, []);
});

test('ledgers are per environment and bundle', async () => {
  const { store, run, deletes } = await setup({
    sandbox: [KEPT],
    production: [KEPT],
  });
  // Recorded for sandbox only: the production channel of the same id is not.
  await store.put(`ch:sandbox:${IOS_BUNDLE}:${KEPT}`, '{}');
  await run();
  await run();
  assert.deepEqual(deletes, [KEPT]);
});

test('respects the per-run delete cap and leaves the rest for later', async () => {
  const { run, deletes } = await setup({ sandbox: [ORPHAN_A, ORPHAN_B] });
  await run(1);
  const capped = await run(1);
  assert.equal(capped.deleted, 1);
  assert.equal(capped.deferred, 1);
  assert.equal(deletes.length, 1);
  const next = await run(1);
  assert.equal(next.deleted, 1);
  assert.equal(deletes.length, 2);
});

test('deletes nothing when the ledger cannot be read', async () => {
  const { store, run, deletes } = await setup({ sandbox: [ORPHAN_A] });
  await run();
  store.failList = true;
  await assert.rejects(run());
  assert.deepEqual(deletes, []);
});

test('skips an environment whose channels cannot be listed, and unreadable entries', async () => {
  const { run, deletes } = await setup({
    sandbox: [{ unknown: 'shape' }, 42, 'not a channel id'],
    production: null,
  });
  const report = await run();
  assert.deepEqual(report.skipped, [`production:${IOS_BUNDLE}`]);
  assert.equal(report.listed, 0);
  await run();
  assert.deepEqual(deletes, []);
});

test('reads channel ids from object entries too', async () => {
  const { run, deletes } = await setup({
    sandbox: [{ 'apns-channel-id': ORPHAN_A }],
  });
  await run();
  await run();
  assert.deepEqual(deletes, [ORPHAN_A]);
});

test('the scheduled sweep ships dark without the ledger or APNs, and covers every bundle and environment when configured', async () => {
  const upstream = apple({ sandbox: [], production: [] });
  const env = {
    AUDIENCES: AUDIENCE,
    ALLOWED_PACKAGES: 'io.kontourai.station',
    PER_IP_LIMITER: allow,
    GLOBAL_LIMITER: allow,
    PER_KEY_LIMITER: allow,
    PER_TOKEN_LIMITER: allow,
    APNS_AUTH_KEY: (await fakeApnsKey()).credentials.privateKeyPem,
    APNS_TEAM_ID: TEAM_ID,
    APNS_KEY_ID: KEY_ID,
    ALLOWED_IOS_BUNDLES: `${IOS_BUNDLE},io.kontourai.station`,
    APNS_CHANNEL_AUTH_SECRET: CHANNEL_AUTH_SECRET,
    CHANNEL_PER_IP_LIMITER: allow,
    CHANNEL_PER_DEVICE_LIMITER: allow,
    CHANNEL_PER_KEY_LIMITER: allow,
    CHANNEL_GLOBAL_LIMITER: allow,
    CHANNEL_DELETE_LIMITER: allow,
    CHANNEL_LEDGER: fakeLedger(),
  };
  await sweep({ ...env, CHANNEL_LEDGER: undefined }, upstream.fetchImpl);
  await sweep({ ...env, APNS_AUTH_KEY: undefined }, upstream.fetchImpl);
  assert.deepEqual(upstream.lists, []);

  await sweep(env, upstream.fetchImpl);
  assert.deepEqual(upstream.lists, [
    'sandbox',
    'production',
    'sandbox',
    'production',
  ]);
  assert.ok(errors.some((line) => line.includes('apns channel sweep:')));
});
