import { expect, test } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { MemoryErasureIntentStore } from '../memory-erasure-intent.js';

const makeTempDir = trackTempDirs();

test('a recorded erasure intent survives reopening under the same idempotency key', async () => {
  const home = makeTempDir('memory-erasure-intent-');
  const intent = {
    version: 1 as const,
    purgeId: 'purge-1',
    rootId: 'root-1',
    ownerId: 'human:owner',
    registrationId: 'registration-1',
    targetKind: 'record' as const,
    targetId: 'record-1',
    revision: 'rev1:confirmed',
    impact: {
      purged: ['record-1'],
      cascaded: ['record-2'],
      survivors: [],
      referrers: [],
      alreadyPurged: [],
      proposalsRejected: [],
      proposalsScrubbed: [],
      proposalsBlocked: [],
    },
  };
  let store = new MemoryErasureIntentStore(home);
  expect(store.submit(intent).kind).toBe('accepted');
  expect(store.submit(intent).kind).toBe('existing');
  expect(store.submit({ ...intent, targetId: 'different' }).kind).toBe(
    'conflict',
  );
  expect(store.claimNext(intent.rootId, intent.purgeId).kind).toBe('claimed');
  await store.close();

  store = new MemoryErasureIntentStore(home);
  try {
    const open = store.open();
    expect(open.kind).toBe('entries');
    if (open.kind !== 'entries') throw new Error('Expected open intents');
    expect(open.entries).toHaveLength(1);
    expect(open.entries[0].state).toBe('placing');
    expect(store.decode(open.entries[0])).toEqual(intent);
    expect(() =>
      store.decode({
        ...open.entries[0],
        payload: open.entries[0].payload.replace('record-1', 'record-9'),
      }),
    ).toThrow('Memory erasure intent is corrupt.');
    expect(store.claimNext(intent.rootId, intent.purgeId).kind).toBe(
      'in-flight',
    );
    expect(
      store.settle(intent.rootId, intent.purgeId, 'placed', 'done').kind,
    ).toBe('applied');
    expect(store.open()).toMatchObject({ kind: 'entries', entries: [] });
  } finally {
    await store.close();
  }
});
