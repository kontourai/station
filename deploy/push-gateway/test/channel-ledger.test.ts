import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  CHANNEL_LIFETIME_SECONDS,
  UNRECORDED_GRACE_SECONDS,
} from '../src/channel-ledger.ts';
import { fakeLedger, IOS_BUNDLE, NOW } from './helpers.ts';

// The real ChannelLedger class and SQL, over node:sqlite, through the same
// fetch protocol the Worker uses.
const scope = { environment: 'production', bundleId: IOS_BUNDLE };
const channel = (channelId: string, createdAt = NOW) => ({
  ...scope,
  channelId,
  stationKeyHash: 'key',
  createdAt,
});

test('records and forgets channels per environment and bundle', async () => {
  const ledger = fakeLedger();
  await ledger.record(channel('a'));
  assert.equal(ledger.has('a', 'production'), true);
  assert.equal(ledger.has('a', 'sandbox'), false);
  await ledger.forget({ ...scope, channelId: 'a' });
  assert.equal(ledger.has('a', 'production'), false);
  // Forgetting an unknown channel is harmless.
  await ledger.forget({ ...scope, channelId: 'never' });
});

test('counts each device’s accepted starts per UTC day', async () => {
  const ledger = fakeLedger();
  const dayStart = Math.floor(NOW / 86_400) * 86_400;
  // Recording a channel alone counts nothing.
  await ledger.record(channel('a', dayStart));
  assert.equal(await ledger.startsToday('device', dayStart), 0);
  await ledger.countStart('device', dayStart);
  await ledger.countStart('device', dayStart + 86_399);
  await ledger.countStart('other device', dayStart);
  assert.equal(await ledger.startsToday('device', dayStart + 10), 2);
  assert.equal(await ledger.startsToday('other device', dayStart), 1);
  assert.equal(await ledger.startsToday('device', dayStart + 86_400), 0);
  assert.equal(await ledger.startsToday('device', dayStart - 1), 0);
});

test('triage: recorded, new, waiting and due, with expiry', async () => {
  const ledger = fakeLedger();
  await ledger.record(channel('kept'));
  const first = await ledger.triage(scope, ['kept', 'orphan'], NOW);
  assert.deepEqual(first, { recorded: 1, due: [], waiting: 1 });
  const due = await ledger.triage(
    scope,
    ['kept', 'orphan'],
    NOW + UNRECORDED_GRACE_SECONDS,
  );
  assert.deepEqual(due, { recorded: 1, due: ['orphan'], waiting: 0 });
  // Apple no longer lists the orphan: its first sighting is forgotten, so a
  // channel reappearing later gets a fresh grace.
  await ledger.triage(scope, ['kept'], NOW + UNRECORDED_GRACE_SECONDS);
  const back = await ledger.triage(
    scope,
    ['kept', 'orphan'],
    NOW + UNRECORDED_GRACE_SECONDS + 1,
  );
  assert.deepEqual(back.due, []);
  // Past its lifetime the record no longer counts.
  const expired = await ledger.triage(
    scope,
    ['kept'],
    NOW + CHANNEL_LIFETIME_SECONDS,
  );
  assert.deepEqual(expired, { recorded: 0, due: [], waiting: 1 });
  // Not yet purged (the sweep purges once per run), but it no longer counts.
  assert.equal(ledger.has('kept', 'production'), true);
});

test('the object refuses an unknown operation', async () => {
  const ledger = fakeLedger();
  const stub = ledger.namespace.get(ledger.namespace.idFromName('x'));
  const response = await stub.fetch(
    new Request('https://channel-ledger/', {
      method: 'POST',
      body: JSON.stringify({ op: 'drop tables' }),
    }),
  );
  assert.equal(response.status, 400);
});

test('the purge removes only expired rows, and old day counts', async () => {
  const ledger = fakeLedger();
  await ledger.record(channel('old', NOW - CHANNEL_LIFETIME_SECONDS));
  await ledger.record(channel('live', NOW - 60));
  await ledger.countStart('device', NOW - 3 * 86_400);
  await ledger.countStart('device', NOW);
  await ledger.purge(NOW);
  assert.equal(ledger.has('old', 'production'), false);
  assert.equal(ledger.has('live', 'production'), true);
  assert.equal(await ledger.startsToday('device', NOW - 3 * 86_400), 0);
  assert.equal(await ledger.startsToday('device', NOW), 1);
});

test('malformed operations are refused and change nothing', async () => {
  const ledger = fakeLedger();
  await ledger.triage(scope, ['orphan'], NOW);
  const stub = ledger.namespace.get(ledger.namespace.idFromName('x'));
  const send = (body: unknown) =>
    stub.fetch(
      new Request('https://channel-ledger/', {
        method: 'POST',
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
    );
  for (const body of [
    'not json',
    { op: 'triage', scope, listed: 'orphan', nowSeconds: NOW },
    { op: 'triage', scope, listed: [42], nowSeconds: NOW },
    { op: 'triage', scope, nowSeconds: NOW },
    {
      op: 'triage',
      scope: { environment: 'production' },
      listed: [],
      nowSeconds: NOW,
    },
    { op: 'triage', scope, listed: [], nowSeconds: '1' },
    { op: 'record', channel: { ...scope, channelId: 'x' } },
    { op: 'forget', channel: scope },
    { op: 'countStart', deviceHash: '', nowSeconds: NOW },
    { op: 'purge' },
  ]) {
    assert.equal((await send(body)).status, 400, JSON.stringify(body));
  }
  // The scope's first sighting survived every malformed triage.
  const later = await ledger.triage(
    scope,
    ['orphan'],
    NOW + UNRECORDED_GRACE_SECONDS,
  );
  assert.deepEqual(later.due, ['orphan']);
});

test('no ledger statement scans a table (every one uses an index)', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { ChannelLedgerStore } = await import('../src/channel-ledger.ts');
  const db = new DatabaseSync(':memory:');
  const statements = new Map<string, Array<string | number | null>>();
  const store = new ChannelLedgerStore({
    exec: (query, ...bindings) => {
      if (!/^\s*CREATE/i.test(query)) statements.set(query, bindings);
      const rows = db.prepare(query).all(...bindings) as Array<
        Record<string, unknown>
      >;
      return { toArray: () => rows };
    },
  });
  // Every operation the object performs.
  store.record(channel('c'));
  store.countStart('device', NOW);
  store.startsToday('device', NOW);
  store.triage(scope, ['c', 'x'], NOW);
  store.triage(scope, ['c'], NOW);
  store.forget({ ...scope, channelId: 'c' });
  store.purge(NOW);
  assert.ok(statements.size >= 10, `saw ${statements.size} statements`);
  for (const [query, bindings] of statements) {
    const plan = (
      db.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...bindings) as Array<{
        detail: string;
      }>
    ).map((step) => step.detail);
    assert.ok(
      !plan.some((detail) => detail.startsWith('SCAN')),
      `${query.replace(/\s+/g, ' ')} -> ${plan.join(' | ')}`,
    );
  }
});
