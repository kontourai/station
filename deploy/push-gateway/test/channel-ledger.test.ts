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
const channel = (
  channelId: string,
  createdAt = NOW,
  deviceHash = 'device',
) => ({
  ...scope,
  channelId,
  stationKeyHash: 'key',
  deviceHash,
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

test('counts each device’s recorded channels per UTC day', async () => {
  const ledger = fakeLedger();
  const dayStart = Math.floor(NOW / 86_400) * 86_400;
  await ledger.record(channel('a', dayStart));
  await ledger.record(channel('b', dayStart + 86_399));
  await ledger.record(channel('c', dayStart, 'other device'));
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
  assert.equal(ledger.has('kept', 'production'), false, 'purged');
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
