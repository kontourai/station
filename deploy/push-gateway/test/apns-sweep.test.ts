import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'vitest';
import { ApnsSender } from '../src/apns.ts';
import {
  MAX_SWEEP_DELETES,
  MAX_SWEEP_SUBREQUESTS,
  parseSweepScopes,
  type SweepScope,
  sweepChannels,
} from '../src/apns-sweep.ts';
import { resetProviderTokenCacheForTest } from '../src/apns-token.ts';
import { UNRECORDED_GRACE_SECONDS } from '../src/channel-ledger.ts';
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
      const channelId = new Headers(init.headers).get('apns-channel-id') ?? '';
      deletes.push(channelId);
      // Like Apple, a deleted channel is no longer listed.
      const listed = channels[`${environment}:${bundle}`];
      if (Array.isArray(listed))
        channels[`${environment}:${bundle}`] = listed.filter(
          (entry) => entry !== channelId,
        );
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
  const ledger = fakeLedger();
  const sender = new ApnsSender(
    (await fakeApnsKey()).credentials,
    upstream.fetchImpl,
  );
  let now = NOW;
  /** One sweep run, a cron tick after the previous one unless told. */
  const run = (
    options: {
      maxDeletes?: number;
      maxSubrequests?: number;
      after?: number;
    } = {},
  ) => {
    now += options.after ?? TICK;
    return sweepChannels({
      ledger,
      sender,
      scopes,
      nowSeconds: now,
      maxDeletes: options.maxDeletes,
      maxSubrequests: options.maxSubrequests,
    });
  };
  /** Records a channel as the gateway would, at the current sweep time. */
  const record = (channelId: string, scope: SweepScope = sandbox()) =>
    ledger.record({
      ...scope,
      channelId,
      stationKeyHash: 'k',
      createdAt: now,
    });
  return { ...upstream, ledger, run, record, clock: () => now };
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

test('keeps recorded channels and deletes unrecorded ones after the grace', async () => {
  const { record, run, deletes } = await setup({
    [`sandbox:${IOS_BUNDLE}`]: [KEPT, ORPHAN_A, ORPHAN_B],
  });
  await record(KEPT);

  const first = await run();
  assert.equal(first.kept, 1);
  assert.equal(first.waiting, 2, 'unrecorded channels are noticed first');
  assert.deepEqual(deletes, []);

  const second = await run();
  assert.equal(second.kept, 1);
  assert.equal(second.deleted, 2);
  assert.deepEqual(deletes.sort(), [ORPHAN_A, ORPHAN_B].sort());
});

test('an unrecorded channel inside the grace is not deleted', async () => {
  const { run, deletes } = await setup({
    [`sandbox:${IOS_BUNDLE}`]: [ORPHAN_A],
  });
  await run();
  const early = await run({ after: UNRECORDED_GRACE_SECONDS - 1 });
  assert.equal(early.deleted, 0);
  assert.equal(early.waiting, 1);
  assert.deepEqual(deletes, []);
  const due = await run({ after: 1 });
  assert.equal(due.deleted, 1);
  assert.deepEqual(deletes, [ORPHAN_A]);
});

test('a channel recorded during its grace (the create-to-record window) is kept', async () => {
  const { record, run, deletes } = await setup({
    [`sandbox:${IOS_BUNDLE}`]: [ORPHAN_A],
  });
  await run();
  await record(ORPHAN_A);
  const second = await run();
  assert.equal(second.kept, 1);
  assert.deepEqual(deletes, []);
});

test('a record expires after 12 hours and the channel is then reclaimed', async () => {
  const { record, run, deletes } = await setup({
    [`sandbox:${IOS_BUNDLE}`]: [KEPT],
  });
  await record(KEPT);
  assert.equal((await run({ after: 12 * 3600 - 60 })).kept, 1);
  // Past its lifetime the record is purged: noticed, then deleted.
  assert.equal((await run({ after: 120 })).waiting, 1);
  await run();
  assert.deepEqual(deletes, [KEPT]);
});

test('sweeps only the configured scopes, each against its own records', async () => {
  const production = {
    environment: 'production',
    bundleId: IOS_BUNDLE,
  } as const;
  const { record, run, deletes, lists } = await setup(
    {
      [`sandbox:${IOS_BUNDLE}`]: [KEPT],
      [`production:${IOS_BUNDLE}`]: [KEPT],
      [`production:${OTHER_BUNDLE}`]: [ORPHAN_A],
    },
    [sandbox(), production],
  );
  // Recorded for sandbox only: the production channel of the same id is not.
  await record(KEPT);
  await run();
  await run();
  assert.deepEqual(deletes, [KEPT]);
  assert.ok(
    !lists.includes(`production:${OTHER_BUNDLE}`),
    'an unswept scope is never even listed',
  );
});

test('a run stays within its subrequest and delete caps and leaves the rest', async () => {
  const many = Array.from(
    { length: 60 },
    (_, index) => `${String(index).padStart(4, '0')}BBBBBBBBBBBBBBBBBB==`,
  );
  const second = Array.from(
    { length: 5 },
    (_, index) => `${String(index).padStart(4, '0')}CCCCCCCCCCCCCCCCCC==`,
  );
  const { ledger, run, deletes, lists, fetchImpl } = await setup(
    {
      [`sandbox:${IOS_BUNDLE}`]: many,
      [`sandbox:${OTHER_BUNDLE}`]: second,
    },
    [sandbox(), sandbox(OTHER_BUNDLE)],
  );
  void fetchImpl;
  await run();
  const before = {
    apple: lists.length + deletes.length,
    ledger: ledger.state.requests,
  };
  const capped = await run();
  const spent =
    lists.length +
    deletes.length -
    before.apple +
    ledger.state.requests -
    before.ledger;
  assert.ok(spent <= MAX_SWEEP_SUBREQUESTS, `spent ${spent}`);
  assert.ok(capped.deleted <= MAX_SWEEP_DELETES, `deleted ${capped.deleted}`);
  assert.equal(capped.deleted, MAX_SWEEP_DELETES);
  assert.ok(capped.deferred > 0);
  // Later runs finish the backlog.
  await run();
  await run();
  assert.equal(new Set(deletes).size, 65);

  // A tighter budget: nothing past it, scopes left whole for the next run.
  const tight = await setup(
    { [`sandbox:${IOS_BUNDLE}`]: many, [`sandbox:${OTHER_BUNDLE}`]: second },
    [sandbox(), sandbox(OTHER_BUNDLE)],
  );
  await tight.run();
  const beforeTight =
    tight.lists.length + tight.deletes.length + tight.ledger.state.requests;
  const report = await tight.run({ maxSubrequests: 5 });
  const tightSpent =
    tight.lists.length +
    tight.deletes.length +
    tight.ledger.state.requests -
    beforeTight;
  assert.equal(tightSpent, 5);
  // One purge, one list and one triage, then two deletes.
  assert.equal(report.deleted, 2);
});

test('purges expired records once per run, not once per scope', async () => {
  const { ledger, run } = await setup(
    {
      [`sandbox:${IOS_BUNDLE}`]: [ORPHAN_A],
      [`sandbox:${OTHER_BUNDLE}`]: [ORPHAN_B],
    },
    [sandbox(), sandbox(OTHER_BUNDLE)],
  );
  let purges = 0;
  const purge = ledger.purge;
  ledger.purge = async (now) => {
    purges += 1;
    return purge(now);
  };
  await run();
  assert.equal(purges, 1);
  await run();
  assert.equal(purges, 2);
});

test('one failing scope does not stop the others', async () => {
  const { ledger, run, deletes } = await setup(
    {
      [`sandbox:${IOS_BUNDLE}`]: [ORPHAN_A],
      [`sandbox:${OTHER_BUNDLE}`]: [ORPHAN_B],
    },
    [sandbox(), sandbox(OTHER_BUNDLE)],
  );
  await run();
  // The ledger fails for the first scope from now on.
  const triage = ledger.triage;
  ledger.triage = async (scope, listed, now) => {
    if (scope.bundleId === IOS_BUNDLE) throw new Error('ledger unreachable');
    return triage(scope, listed, now);
  };
  const report = await run();
  assert.deepEqual(report.skipped, [`sandbox:${IOS_BUNDLE}`]);
  assert.deepEqual(deletes, [ORPHAN_B], 'the healthy scope was still swept');
  assert.ok(errors.some((line) => line.includes('ledger unreachable')));
});

test('deletes nothing when the ledger cannot be read', async () => {
  const { ledger, run, deletes } = await setup({
    [`sandbox:${IOS_BUNDLE}`]: [ORPHAN_A],
  });
  await run();
  ledger.state.failing = true;
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
    await run();
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
    CHANNEL_LEDGER: fakeLedger().namespace,
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
