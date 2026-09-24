import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'vitest';
import { ApnsSender } from '../src/apns.ts';
import {
  MIN_MARK_AGE_SECONDS,
  parseSweepScopes,
  type SweepScope,
  sweepChannels,
} from '../src/apns-ledger.ts';
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
  NOW,
  TEAM_ID,
} from './helpers.ts';

const KEPT = 'KeptKeptKeptKeptKeptKA==';
const ORPHAN_A = 'Orph/nAAAAAAAAAAAAAAAA==';
const ORPHAN_B = 'Orph+nBBBBBBBBBBBBBBBA==';
const OTHER_BUNDLE = 'io.kontourai.station';
/** The cron interval: each run in these tests is one tick later. */
const TICK = 15 * 60;

type Listing = unknown[] | null | (() => Response);

/**
 * Fake Apple management host. `channels` is keyed `<environment>:<bundle>`:
 * an array lists those channels, null answers an error, a function answers
 * whatever it returns.
 */
function apple(channels: Record<string, Listing>) {
  const deletes: string[] = [];
  const lists: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const environment = url.includes('.sandbox.') ? 'sandbox' : 'production';
    const bundle = /\/1\/apps\/([^/]+)\//.exec(url)?.[1] ?? '';
    if (url.endsWith('/all-channels')) {
      lists.push(`${environment}:${bundle}`);
      const listed = channels[`${environment}:${bundle}`];
      if (typeof listed === 'function') return listed();
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

const sandbox = (bundleId = IOS_BUNDLE): SweepScope => ({
  environment: 'sandbox',
  bundleId,
});

async function setup(
  channels: Record<string, Listing>,
  scopes: SweepScope[] = [sandbox()],
) {
  const upstream = apple(channels);
  const store = fakeLedger();
  const sender = new ApnsSender(
    (await fakeApnsKey()).credentials,
    upstream.fetchImpl,
  );
  let now = NOW;
  /** One sweep run, a cron tick after the previous one unless told. */
  const run = (
    options: { maxDeletes?: number; maxMarks?: number; after?: number } = {},
  ) => {
    now += options.after ?? TICK;
    return sweepChannels({
      store,
      sender,
      scopes,
      nowSeconds: now,
      maxDeletes: options.maxDeletes,
      maxMarks: options.maxMarks,
    });
  };
  return { ...upstream, store, run };
}

const key = (channelId: string, scope = 'sandbox') =>
  `ch:${scope}:${IOS_BUNDLE}:${channelId}`;

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

test('keeps ledgered channels and deletes unrecorded ones once their mark is old enough', async () => {
  const { store, run, deletes } = await setup({
    [`sandbox:${IOS_BUNDLE}`]: [KEPT, ORPHAN_A, ORPHAN_B],
  });
  await store.put(key(KEPT), '{}');

  const first = await run();
  assert.equal(first.kept, 1);
  assert.equal(first.marked, 2);
  assert.equal(first.deleted, 0);
  assert.deepEqual(deletes, [], 'a fresh write may not be visible yet');
  const mark = store.entries.get(`suspect:sandbox:${IOS_BUNDLE}:${ORPHAN_A}`);
  assert.deepEqual(mark?.metadata, { markedAt: NOW + TICK });

  const second = await run();
  assert.equal(second.kept, 1);
  assert.equal(second.deleted, 2);
  assert.deepEqual(deletes.sort(), [ORPHAN_A, ORPHAN_B].sort());
  assert.equal(
    store.entries.has(`suspect:sandbox:${IOS_BUNDLE}:${ORPHAN_A}`),
    false,
  );
  assert.equal(store.entries.has(key(KEPT)), true);
});

test('a second sighting inside ten minutes of the mark deletes nothing', async () => {
  const { run, deletes } = await setup({
    [`sandbox:${IOS_BUNDLE}`]: [ORPHAN_A],
  });
  await run();
  // Two runs close together (a retried cron, overlapping invocations).
  const early = await run({ after: MIN_MARK_AGE_SECONDS - 1 });
  assert.equal(early.deleted, 0);
  assert.equal(early.marked, 0, 'the original mark is kept, not renewed');
  assert.deepEqual(deletes, []);
  const due = await run({ after: 1 });
  assert.equal(due.deleted, 1);
  assert.deepEqual(deletes, [ORPHAN_A]);
});

test('a channel ledgered after being marked is kept', async () => {
  const { store, run, deletes } = await setup({
    [`sandbox:${IOS_BUNDLE}`]: [ORPHAN_A],
  });
  await run();
  await store.put(key(ORPHAN_A), '{}');
  const second = await run();
  assert.equal(second.kept, 1);
  assert.deepEqual(deletes, []);
});

test('sweeps only the configured scopes, each against its own ledger', async () => {
  const { store, run, deletes, lists } = await setup(
    {
      [`sandbox:${IOS_BUNDLE}`]: [KEPT],
      [`production:${IOS_BUNDLE}`]: [KEPT],
      [`production:${OTHER_BUNDLE}`]: [ORPHAN_A],
    },
    [sandbox(), { environment: 'production', bundleId: IOS_BUNDLE }],
  );
  // Recorded for sandbox only: the production channel of the same id is not.
  await store.put(key(KEPT), '{}');
  await run();
  await run();
  assert.deepEqual(deletes, [KEPT]);
  assert.ok(
    !lists.includes(`production:${OTHER_BUNDLE}`),
    'an unswept scope is never even listed',
  );
});

test('respects the per-run delete cap and leaves the rest for later', async () => {
  const { run, deletes } = await setup({
    [`sandbox:${IOS_BUNDLE}`]: [ORPHAN_A, ORPHAN_B],
  });
  await run({ maxDeletes: 1 });
  const capped = await run({ maxDeletes: 1 });
  assert.equal(capped.deleted, 1);
  assert.equal(capped.deferred, 1);
  assert.equal(deletes.length, 1);
  const next = await run({ maxDeletes: 1 });
  assert.equal(next.deleted, 1);
  assert.equal(deletes.length, 2);
});

test('respects the per-run mark cap', async () => {
  const { store, run } = await setup({
    [`sandbox:${IOS_BUNDLE}`]: [KEPT, ORPHAN_A, ORPHAN_B],
  });
  const capped = await run({ maxMarks: 2 });
  assert.equal(capped.marked, 2);
  assert.equal(capped.deferred, 1);
  const marks = [...store.entries.keys()].filter((name) =>
    name.startsWith('suspect:'),
  );
  assert.equal(marks.length, 2);
  const next = await run({ maxMarks: 2 });
  assert.equal(next.marked, 1, 'the deferred channel is marked next run');
});

test('one failing scope does not stop the others', async () => {
  const { store, run, deletes } = await setup(
    {
      [`sandbox:${IOS_BUNDLE}`]: [ORPHAN_A],
      [`sandbox:${OTHER_BUNDLE}`]: [ORPHAN_B],
    },
    [sandbox(), sandbox(OTHER_BUNDLE)],
  );
  await run();
  // The ledger read for the first scope fails from now on.
  const list = store.list.bind(store);
  store.list = async (options: { prefix: string; cursor?: string }) => {
    if (options.prefix.includes(IOS_BUNDLE)) throw new Error('kv list failed');
    return list(options);
  };
  const report = await run();
  assert.deepEqual(report.skipped, [`sandbox:${IOS_BUNDLE}`]);
  assert.deepEqual(deletes, [ORPHAN_B], 'the healthy scope was still swept');
  assert.ok(errors.some((line) => line.includes('kv list failed')));
});

test('deletes nothing in a scope whose ledger cannot be read', async () => {
  const { store, run, deletes } = await setup({
    [`sandbox:${IOS_BUNDLE}`]: [ORPHAN_A],
  });
  await run();
  store.failList = true;
  const report = await run();
  assert.deepEqual(report.skipped, [`sandbox:${IOS_BUNDLE}`]);
  assert.deepEqual(deletes, []);
});

test('skips a scope whose channels cannot be listed, and unreadable entries', async () => {
  const { run, deletes } = await setup(
    {
      [`sandbox:${IOS_BUNDLE}`]: [{ unknown: 'shape' }, 42, 'not a channel id'],
      [`production:${IOS_BUNDLE}`]: null,
    },
    [sandbox(), { environment: 'production', bundleId: IOS_BUNDLE }],
  );
  const report = await run();
  assert.deepEqual(report.skipped, [`production:${IOS_BUNDLE}`]);
  assert.equal(report.listed, 0);
  await run();
  assert.deepEqual(deletes, []);
});

test('reads channel ids from object entries too', async () => {
  const { run, deletes } = await setup({
    [`sandbox:${IOS_BUNDLE}`]: [{ 'apns-channel-id': ORPHAN_A }],
  });
  await run();
  await run();
  assert.deepEqual(deletes, [ORPHAN_A]);
});

test('logs a channel list that may be paged', async () => {
  const round = Array.from(
    { length: 1000 },
    (_, index) => `${String(index).padStart(4, '0')}AAAAAAAAAAAAAAAAAA==`,
  );
  const cases: Array<[Listing, boolean]> = [
    [() => Response.json({ channels: [KEPT], next: 'cursor' }), true],
    [round, true],
    [round.slice(0, 999), false],
    [[KEPT], false],
  ];
  for (const [listing, logged] of cases) {
    errors = [];
    const { run } = await setup({ [`sandbox:${IOS_BUNDLE}`]: listing });
    await run({ maxMarks: 0 });
    assert.equal(
      errors.some((line) => line.includes('may be paged')),
      logged,
      typeof listing === 'function' ? 'extra key' : String(listing?.length),
    );
  }
});

test('SWEEP_SCOPES names environment:bundle pairs the gateway serves', () => {
  const allowed = [IOS_BUNDLE, OTHER_BUNDLE];
  assert.deepEqual(
    parseSweepScopes(
      ` production:${IOS_BUNDLE}, sandbox:${OTHER_BUNDLE} ,`,
      allowed,
    ),
    [
      { environment: 'production', bundleId: IOS_BUNDLE },
      { environment: 'sandbox', bundleId: OTHER_BUNDLE },
    ],
  );
  for (const bad of [
    'staging:io.kontourai.station',
    'production:com.example.other',
    'io.kontourai.station',
  ]) {
    assert.deepEqual(parseSweepScopes(bad, allowed), [], bad);
  }
  assert.deepEqual(parseSweepScopes(undefined, allowed), []);
});

async function workerEnv() {
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
    ALLOWED_IOS_BUNDLES: `${IOS_BUNDLE},${OTHER_BUNDLE}`,
    APNS_CHANNEL_AUTH_SECRET: CHANNEL_AUTH_SECRET,
    SWEEP_SCOPES: `production:${IOS_BUNDLE},production:${OTHER_BUNDLE}`,
    CHANNEL_PER_IP_LIMITER: allow,
    CHANNEL_PER_DEVICE_LIMITER: allow,
    CHANNEL_PER_KEY_LIMITER: allow,
    CHANNEL_GLOBAL_LIMITER: allow,
    CHANNEL_DELETE_LIMITER: allow,
    CHANNEL_LEDGER: fakeLedger(),
  };
}

test('the scheduled sweep ships dark, and otherwise covers exactly SWEEP_SCOPES', async () => {
  const upstream = apple({});
  const env = await workerEnv();
  await sweep({ ...env, CHANNEL_LEDGER: undefined }, upstream.fetchImpl, NOW);
  await sweep({ ...env, APNS_AUTH_KEY: undefined }, upstream.fetchImpl, NOW);
  await sweep({ ...env, SWEEP_SCOPES: undefined }, upstream.fetchImpl, NOW);
  assert.deepEqual(upstream.lists, []);

  await sweep(env, upstream.fetchImpl, NOW);
  assert.deepEqual(upstream.lists, [
    `production:${IOS_BUNDLE}`,
    `production:${OTHER_BUNDLE}`,
  ]);
  assert.ok(errors.some((line) => line.includes('apns channel sweep:')));
});
