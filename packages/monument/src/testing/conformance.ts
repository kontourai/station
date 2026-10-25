import assert from 'node:assert/strict';
import type {
  KernelCommand,
  KernelResult,
  TurnBoundaryReconcileCommand,
} from '../commands.js';
import { planTurnBoundaryReconcile } from '../decisions/turn-boundary.js';
import type { OwnerIdentity } from '../owner.js';
import type { CommitParticipant, KernelLimits } from '../port.js';
import type { RequestKeyId, TurnBoundaryRecord } from '../records.js';
import {
  type CrashPointStore,
  KernelCrashError,
  type KernelStorageHarness,
  openCrashPointStore,
} from './crash-point-store.js';
import {
  createFakeProcessTable,
  type FakeProcessTable,
} from './process-table.js';

/**
 * The exported conformance suite. Every case opens a fresh location from the
 * harness, so an adapter registers once and runs all of it. Cases use
 * `node:assert` only, so any runner can drive them; see
 * {@link registerKernelConformance} for Vitest, Jest or `node:test`.
 */
/** The machines a case drives. A host that keeps only some runs only those. */
export type KernelConformanceArea =
  | 'turnDedup'
  | 'turnBoundary'
  | 'requestKeys'
  | 'steerReceipts'
  | 'inbox';

export interface KernelConformanceCase {
  readonly name: string;
  /** Every machine the case uses, durability cases included. */
  readonly areas: readonly KernelConformanceArea[];
  run(harness: KernelStorageHarness): Promise<void>;
}

interface Session {
  readonly store: CrashPointStore;
  readonly processes: FakeProcessTable;
  run<C extends KernelCommand>(command: C): Promise<KernelResult<C>>;
}

async function withSession(
  harness: KernelStorageHarness,
  body: (session: Session) => Promise<void>,
  options: {
    readonly limits?: Partial<KernelLimits>;
    readonly participants?: readonly CommitParticipant<never>[];
  } = {},
): Promise<void> {
  const location = await harness.createLocation();
  try {
    const store = await openCrashPointStore(location, {
      ...(options.participants ? { participants: options.participants } : {}),
    });
    const processes = createFakeProcessTable();
    try {
      await body({
        store,
        processes,
        run: (command) =>
          store.storage.execute(command, {
            liveness: processes.liveness,
            ...(options.limits ? { limits: options.limits } : {}),
          }),
      });
    } finally {
      await store.dispose();
    }
  } finally {
    await location.dispose();
  }
}

const at = (second: number): string =>
  `2026-01-01T00:00:${String(second).padStart(2, '0')}.000Z`;

const requestKey = (key: string, callerSessionId = 'caller'): RequestKeyId => ({
  callerSessionId,
  tool: 'send',
  key,
});

const claim = (
  key: string,
  owner: OwnerIdentity,
  now = 1,
  tracking: 'tracked' | 'untracked' = 'tracked',
) => ({ type: 'turnDedup.claim', key, owner, now, tracking }) as const;

const create = (
  boundaryId: string,
  threadId: string,
  owner: OwnerIdentity,
  now: string,
  state: 'lifecycle' | 'reserved' | 'prepared' = 'prepared',
  purpose: 'turn' | 'task-dispatch' = 'turn',
) =>
  ({
    type: 'turnBoundary.create',
    boundaryId,
    threadId,
    state,
    purpose,
    owner,
    now,
  }) as const;

const transition = (
  boundaryId: string,
  owner: OwnerIdentity,
  from: TurnBoundaryRecord['state'][],
  to: 'invoking' | 'accepted' | 'indeterminate',
  now: string,
  providerTurnId?: string,
) =>
  ({
    type: 'turnBoundary.transition',
    boundaryId,
    ownerId: owner.id,
    from,
    to,
    now,
    ...(providerTurnId ? { providerTurnId } : {}),
  }) as const;

const recordAccepted = (
  boundaryId: string,
  threadId: string,
  providerTurnId: string,
  owner: OwnerIdentity,
  now: string,
) =>
  ({
    type: 'turnBoundary.recordAccepted',
    boundaryId,
    threadId,
    providerTurnId,
    owner,
    now,
  }) as const;

async function boundaries(session: Session): Promise<TurnBoundaryRecord[]> {
  const listed = await session.run({ type: 'turnBoundary.list' });
  assert.equal(listed.kind, 'records');
  const records = listed.kind === 'records' ? listed.records : [];
  return [...records].sort((a, b) => (a.boundaryId < b.boundaryId ? -1 : 1));
}

async function boundary(
  session: Session,
  boundaryId: string,
): Promise<TurnBoundaryRecord | undefined> {
  return (await boundaries(session)).find(
    (row) => row.boundaryId === boundaryId,
  );
}

/**
 * How a host reconciles: list the rows, probe each process once outside the
 * transaction, then commit the verdicts guarded by each row's `updatedAt`.
 */
async function reconcile(session: Session, now: string) {
  const listed = await session.run({ type: 'turnBoundary.list' });
  assert.equal(listed.kind, 'records');
  return session.run(
    planTurnBoundaryReconcile(
      listed.kind === 'records' ? listed.records : [],
      { probe: session.processes.probe },
      now,
    ),
  );
}

function interruptedOf(
  result: KernelResult<TurnBoundaryReconcileCommand>,
): readonly TurnBoundaryRecord[] {
  assert.equal(result.kind, 'reconciled');
  return result.kind === 'reconciled' ? result.interrupted : [];
}

async function dedupRecord(session: Session, key: string) {
  const read = await session.run({ type: 'turnDedup.read', key });
  return read.kind === 'found' ? read.record : undefined;
}

/** Claim a key and resolve it, as one finished turn. */
async function settleDedup(
  session: Session,
  owner: OwnerIdentity,
  key: string,
  now: number,
): Promise<void> {
  assert.deepEqual(await session.run(claim(key, owner, now)), {
    kind: 'claimed',
    reclaimed: false,
  });
  await session.run({
    type: 'turnDedup.resolve',
    key,
    ownerId: owner.id,
    now,
    value: `v-${key}`,
  });
}

const durability: KernelConformanceCase[] = [
  {
    name: 'durability: a committed command survives reopen',
    areas: ['turnDedup'],
    run: (harness) =>
      withSession(harness, async (session) => {
        const owner = session.processes.spawn();
        assert.deepEqual(await session.run(claim('k', owner)), {
          kind: 'claimed',
          reclaimed: false,
        });
        await session.store.reopen();
        const record = await dedupRecord(session, 'k');
        assert.equal(record?.owner?.id, owner.id);
        assert.equal(record?.invocation, 'pending');
        assert.equal(record?.value, null);
      }),
  },
  {
    name: 'durability: a failed commit leaves no partial state, including after reopen',
    areas: ['requestKeys'],
    run: (harness) =>
      withSession(
        harness,
        async (session) => {
          await session.run({
            type: 'requestKeys.claim',
            id: requestKey('old'),
            digest: 'd',
            now: 0,
          });
          await session.run({
            type: 'requestKeys.complete',
            id: requestKey('old'),
            result: 'r',
          });
          session.store.failNextCommit();
          // This claim's TTL purge deletes `old` and then inserts `new`;
          // the injected failure lands after both writes.
          await assert.rejects(
            session.run({
              type: 'requestKeys.claim',
              id: requestKey('new'),
              digest: 'd',
              now: 100,
            }),
            /Injected commit failure/,
          );
          await session.store.reopen();
          assert.deepEqual(
            await session.run({
              type: 'requestKeys.claim',
              id: requestKey('old'),
              digest: 'd',
              now: 1,
            }),
            { kind: 'replay', result: 'r' },
          );
          assert.deepEqual(
            await session.run({
              type: 'requestKeys.claim',
              id: requestKey('new'),
              digest: 'd',
              now: 1,
            }),
            { kind: 'claimed' },
          );
        },
        { limits: { requestKeyTtlMs: 10 } },
      ),
  },
  {
    name: 'durability: a participant refusal writes nothing',
    areas: ['turnDedup'],
    run: (harness) =>
      withSession(
        harness,
        async (session) => {
          const owner = session.processes.spawn();
          assert.deepEqual(await session.run(claim('blocked', owner)), {
            kind: 'refused',
            participant: 'guard',
            reason: 'sealed',
          });
          assert.equal(await dedupRecord(session, 'blocked'), undefined);
        },
        {
          participants: [
            {
              name: 'guard',
              admit: (command) =>
                command.type === 'turnDedup.claim' && command.key === 'blocked'
                  ? { refuse: 'sealed' }
                  : undefined,
            },
          ],
        },
      ),
  },
  {
    name: 'durability: participants commit inside the transaction with the result',
    areas: ['turnDedup'],
    run: async (harness) => {
      const seen: string[] = [];
      await withSession(
        harness,
        async (session) => {
          const owner = session.processes.spawn();
          await session.run(claim('k', owner));
          await session.run(claim('k', session.processes.spawn()));
          assert.deepEqual(seen, [
            'turnDedup.claim:claimed',
            'turnDedup.claim:contended',
          ]);
        },
        {
          participants: [
            {
              name: 'projection',
              commit: ({ command, result }) => {
                seen.push(`${command.type}:${result.kind}`);
              },
            },
          ],
        },
      );
    },
  },
  {
    name: 'durability: a closed storage refuses commands',
    areas: ['turnDedup'],
    run: (harness) =>
      withSession(harness, async (session) => {
        await session.store.storage.close();
        await assert.rejects(
          session.run({ type: 'turnDedup.read', key: 'k' }),
          (error: Error) => error.name === 'KernelStorageClosedError',
        );
      }),
  },
  {
    name: "durability: a command cannot run inside another command's transaction",
    areas: ['turnDedup'],
    run: async (harness) => {
      let current: Session | undefined;
      let nested: Promise<unknown> | undefined;
      await withSession(
        harness,
        async (session) => {
          current = session;
          const owner = session.processes.spawn();
          assert.deepEqual(await session.run(claim('outer', owner)), {
            kind: 'claimed',
            reclaimed: false,
          });
          assert.ok(nested, 'the participant ran');
          await assert.rejects(nested);
          assert.equal(await dedupRecord(session, 'inner'), undefined);
          assert.equal(
            (await dedupRecord(session, 'outer'))?.owner?.id,
            owner.id,
          );
        },
        {
          participants: [
            {
              name: 'nester',
              commit: ({ command }) => {
                if (
                  current &&
                  command.type === 'turnDedup.claim' &&
                  command.key === 'outer'
                ) {
                  nested = current.run(
                    claim('inner', current.processes.spawn()),
                  );
                  // Keep an early rejection from being reported as unhandled.
                  nested.catch(() => {});
                }
              },
            },
          ],
        },
      );
    },
  },
];

const turnDedup: KernelConformanceCase[] = [
  {
    name: 'turn dedup: input conflict precedes contention, replay and dead-owner reclaim across restart',
    areas: ['turnDedup'],
    run: (harness) =>
      withSession(harness, async (session) => {
        const owner = session.processes.spawn();
        const contender = session.processes.spawn();
        const original = { ...claim('digest', owner), inputDigest: 'v1:A' };
        assert.equal((await session.run(original)).kind, 'claimed');
        const changed = { ...claim('digest', contender), inputDigest: 'v1:B' };
        assert.deepEqual(await session.run(changed), { kind: 'conflict' });
        session.processes.kill(owner);
        assert.deepEqual(await session.run(changed), { kind: 'conflict' });
        assert.deepEqual(await session.run({ ...original, owner: contender }), {
          kind: 'claimed',
          reclaimed: true,
        });
        await session.run({
          type: 'turnDedup.resolve',
          key: 'digest',
          ownerId: contender.id,
          value: 'turn-A',
          now: 3,
        });
        await session.store.reopen();
        assert.deepEqual(await session.run(changed), { kind: 'conflict' });
        assert.deepEqual(await session.run(original), {
          kind: 'resolved',
          value: 'turn-A',
        });
        assert.equal(
          (await dedupRecord(session, 'digest'))?.inputDigest,
          'v1:A',
        );
        // Reclaiming legacy input must never turn the retry into original proof.
        const legacyOwner = session.processes.spawn();
        await session.run(claim('legacy-input', legacyOwner));
        session.processes.kill(legacyOwner);
        await session.run({
          ...claim('legacy-input', contender),
          inputDigest: 'v1:B',
        });
        assert.equal(
          (await dedupRecord(session, 'legacy-input'))?.inputDigest,
          undefined,
        );
      }),
  },
  {
    name: 'turn dedup: one owner per key; only the owner settles; a resolved key replays',
    areas: ['turnDedup'],
    run: (harness) =>
      withSession(harness, async (session) => {
        const a = session.processes.spawn();
        const b = session.processes.spawn();
        assert.deepEqual(await session.run(claim('k', a)), {
          kind: 'claimed',
          reclaimed: false,
        });
        assert.deepEqual(await session.run(claim('k', b)), {
          kind: 'contended',
        });
        assert.deepEqual(
          await session.run({
            type: 'turnDedup.resolve',
            key: 'k',
            ownerId: b.id,
            now: 1,
            value: 'x',
          }),
          { kind: 'stale' },
        );
        assert.deepEqual(
          await session.run({
            type: 'turnDedup.resolve',
            key: 'k',
            ownerId: a.id,
            now: 1,
            value: 'turn-1',
          }),
          { kind: 'applied' },
        );
        assert.deepEqual(await session.run(claim('k', b)), {
          kind: 'resolved',
          value: 'turn-1',
        });
        // A retry after a lost acknowledgement: same owner, same value.
        assert.deepEqual(
          await session.run({
            type: 'turnDedup.resolve',
            key: 'k',
            ownerId: a.id,
            now: 1,
            value: 'turn-1',
          }),
          { kind: 'applied' },
        );
        assert.deepEqual(
          await session.run({
            type: 'turnDedup.resolve',
            key: 'k',
            ownerId: a.id,
            now: 1,
            value: 'turn-2',
          }),
          { kind: 'stale' },
        );
        assert.deepEqual(
          await session.run({
            type: 'turnDedup.release',
            key: 'k',
            ownerId: a.id,
            now: 1,
          }),
          { kind: 'stale' },
        );
      }),
  },
  {
    name: 'turn dedup: a released claim can be claimed again',
    areas: ['turnDedup'],
    run: (harness) =>
      withSession(harness, async (session) => {
        const a = session.processes.spawn();
        const b = session.processes.spawn();
        await session.run(claim('k', a));
        assert.deepEqual(
          await session.run({
            type: 'turnDedup.release',
            key: 'k',
            ownerId: a.id,
            now: 1,
          }),
          { kind: 'applied' },
        );
        assert.deepEqual(await session.run(claim('k', b)), {
          kind: 'claimed',
          reclaimed: false,
        });
      }),
  },
  {
    name: "turn dedup: beginInvocation needs the owner's pending or begun claim",
    areas: ['turnDedup'],
    run: (harness) =>
      withSession(harness, async (session) => {
        const a = session.processes.spawn();
        const b = session.processes.spawn();
        const begin = (key: string, owner: OwnerIdentity) =>
          session.run({
            type: 'turnDedup.beginInvocation',
            key,
            ownerId: owner.id,
            now: 1,
          });
        assert.deepEqual(await begin('absent', a), { kind: 'refused' });
        await session.run(claim('k', a));
        assert.deepEqual(await begin('k', b), { kind: 'refused' });
        assert.deepEqual(await begin('k', a), { kind: 'applied' });
        assert.deepEqual(await begin('k', a), { kind: 'applied' });
        assert.equal((await dedupRecord(session, 'k'))?.invocation, 'begun');
        await session.run(claim('untracked', a, 1, 'untracked'));
        assert.deepEqual(await begin('untracked', a), { kind: 'refused' });
        await session.run({
          type: 'turnDedup.resolve',
          key: 'k',
          ownerId: a.id,
          now: 1,
          value: 't',
        });
        assert.deepEqual(await begin('k', a), { kind: 'refused' });
      }),
  },
  {
    name: 'turn dedup: a dead owner is reclaimed only if it never began its effect',
    areas: ['turnDedup'],
    run: (harness) =>
      withSession(harness, async (session) => {
        const dead = session.processes.spawn();
        const next = session.processes.spawn();
        await session.run(claim('pending', dead));
        await session.run(claim('begun', dead));
        await session.run({
          type: 'turnDedup.beginInvocation',
          key: 'begun',
          ownerId: dead.id,
          now: 1,
        });
        await session.run(claim('untracked', dead, 1, 'untracked'));
        session.processes.kill(dead);
        assert.deepEqual(await session.run(claim('pending', next)), {
          kind: 'claimed',
          reclaimed: true,
        });
        assert.deepEqual(await session.run(claim('begun', next)), {
          kind: 'indeterminate',
        });
        assert.deepEqual(await session.run(claim('untracked', next)), {
          kind: 'claimed',
          reclaimed: true,
        });
        // Indeterminate is never cleared by asking again.
        assert.deepEqual(await session.run(claim('begun', next)), {
          kind: 'indeterminate',
        });
      }),
  },
  {
    name: 'turn dedup: an unobservable owner is never freed; a reused pid is',
    areas: ['turnDedup'],
    run: (harness) =>
      withSession(harness, async (session) => {
        const hidden = session.processes.spawn();
        const reused = session.processes.spawn();
        const next = session.processes.spawn();
        await session.run(claim('hidden', hidden));
        await session.run(claim('reused', reused));
        session.processes.makeUnobservable(hidden);
        session.processes.reusePid(reused);
        assert.deepEqual(await session.run(claim('hidden', next)), {
          kind: 'contended',
        });
        assert.deepEqual(await session.run(claim('reused', next)), {
          kind: 'claimed',
          reclaimed: true,
        });
      }),
  },
  {
    name: 'turn dedup: retention evicts the oldest resolved rows and never an unresolved one',
    areas: ['turnDedup'],
    run: (harness) =>
      withSession(
        harness,
        async (session) => {
          const a = session.processes.spawn();
          const resolve = (key: string) =>
            session.run({
              type: 'turnDedup.resolve',
              key,
              ownerId: a.id,
              now: 1,
              value: `v-${key}`,
            });
          await session.run(claim('k1', a, 1));
          await resolve('k1');
          await session.run(claim('k2', a, 2));
          await resolve('k2');
          await session.run(claim('k3', a, 3));
          assert.equal(await dedupRecord(session, 'k1'), undefined);
          assert.equal((await dedupRecord(session, 'k2'))?.value, 'v-k2');
          await session.run(claim('k4', a, 4));
          assert.equal(await dedupRecord(session, 'k2'), undefined);
          await session.run(claim('k5', a, 5));
          for (const key of ['k3', 'k4', 'k5'])
            assert.equal((await dedupRecord(session, key))?.value, null);
        },
        { limits: { turnDedupMaxEntries: 2 } },
      ),
  },
  {
    name: 'turn dedup: a resolved floor preserves replay under unresolved pressure',
    areas: ['turnDedup'],
    run: (harness) => {
      const limits = { turnDedupMaxEntries: 2, turnDedupMinResolvedEntries: 2 };
      return withSession(
        harness,
        async (session) => {
          const live = session.processes.spawn();
          const begun = session.processes.spawn();
          const pending = session.processes.spawn();
          const next = session.processes.spawn();
          await session.run(claim('live', live, 1));
          await session.run(claim('begun', begun, 2));
          await session.run({
            type: 'turnDedup.beginInvocation',
            key: 'begun',
            ownerId: begun.id,
            now: 2,
          });
          await session.run(claim('pending-dead', pending, 3));
          session.processes.kill(begun);
          session.processes.kill(pending);
          await settleDedup(session, live, 'r1', 4);
          await settleDedup(session, live, 'r2', 5);
          assert.equal((await dedupRecord(session, 'r1'))?.value, 'v-r1');
          assert.equal((await dedupRecord(session, 'r2'))?.value, 'v-r2');
          await settleDedup(session, live, 'r3', 6);
          assert.deepEqual(
            await session.run({ type: 'turnDedup.read', key: 'r1' }),
            { kind: 'expired', expiredAt: 6 },
          );
          assert.equal((await dedupRecord(session, 'r2'))?.value, 'v-r2');
          assert.equal((await dedupRecord(session, 'r3'))?.value, 'v-r3');
          assert.deepEqual(await session.run(claim('live', next, 7)), {
            kind: 'contended',
          });
          assert.deepEqual(await session.run(claim('begun', next, 7)), {
            kind: 'indeterminate',
          });
          assert.deepEqual(await session.run(claim('pending-dead', next, 7)), {
            kind: 'claimed',
            reclaimed: true,
          });
          await session.store.reopen();
          assert.deepEqual(await session.run(claim('r1', next, 8)), {
            kind: 'expired',
          });
          assert.deepEqual(await session.run(claim('r2', next, 8)), {
            kind: 'resolved',
            value: 'v-r2',
          });
          assert.deepEqual(await session.run(claim('r3', next, 8)), {
            kind: 'resolved',
            value: 'v-r3',
          });
          assert.deepEqual(await session.run(claim('live', next, 8)), {
            kind: 'contended',
          });
          assert.deepEqual(await session.run(claim('begun', next, 8)), {
            kind: 'indeterminate',
          });
          assert.equal(
            (await dedupRecord(session, 'pending-dead'))?.owner?.id,
            next.id,
          );
        },
        { limits },
      );
    },
  },
  {
    name: 'turn dedup: an evicted key answers expired, and only that key',
    areas: ['turnDedup'],
    run: (harness) =>
      withSession(
        harness,
        async (session) => {
          const a = session.processes.spawn();
          const settle = (key: string, now: number) =>
            settleDedup(session, a, key, now);
          await settle('k1', 1);
          await settle('k2', 2);
          await settle('k3', 3);
          // k1, the oldest resolved row, was evicted and left its key.
          assert.equal(await dedupRecord(session, 'k1'), undefined);
          assert.deepEqual(
            await session.run({ type: 'turnDedup.read', key: 'k1' }),
            {
              kind: 'expired',
              expiredAt: 3,
            },
          );
          // Never claimable again, by anyone, and it changes nothing.
          for (const owner of [a, session.processes.spawn()])
            assert.deepEqual(await session.run(claim('k1', owner, 4)), {
              kind: 'expired',
            });
          assert.deepEqual(
            await session.run({
              type: 'turnDedup.beginInvocation',
              key: 'k1',
              ownerId: a.id,
              now: 4,
            }),
            { kind: 'refused' },
          );
          assert.deepEqual(
            await session.run({
              type: 'turnDedup.resolve',
              key: 'k1',
              ownerId: a.id,
              now: 4,
              value: 'again',
            }),
            { kind: 'stale' },
          );
          assert.deepEqual(
            await session.run({ type: 'turnDedup.read', key: 'k1' }),
            {
              kind: 'expired',
              expiredAt: 3,
            },
          );
          // Other keys are untouched, and a tombstone holds no capacity: a
          // fresh key claims, and the rows still evict only past the cap.
          assert.deepEqual(await session.run(claim('fresh', a, 5)), {
            kind: 'claimed',
            reclaimed: false,
          });
          assert.equal((await dedupRecord(session, 'k3'))?.value, 'v-k3');
          await session.store.reopen();
          assert.deepEqual(await session.run(claim('k1', a, 6)), {
            kind: 'expired',
          });
        },
        { limits: { turnDedupMaxEntries: 2 } },
      ),
  },
  {
    name: 'turn dedup: a tombstone under a retention rule is forgotten once old, and no other is',
    areas: ['turnDedup'],
    run: (harness) =>
      withSession(
        harness,
        async (session) => {
          const a = session.processes.spawn();
          const settle = (key: string, now: number) =>
            settleDedup(session, a, key, now);
          // Both are evicted at 3 and 4 by the two later keys.
          await settle('chat:a', 1);
          await settle('thread:a', 2);
          await settle('chat:b', 3);
          await settle('thread:b', 4);
          const expired = (key: string) =>
            session
              .run({ type: 'turnDedup.read', key })
              .then((read) => read.kind === 'expired');
          assert.equal(await expired('chat:a'), true);
          assert.equal(await expired('thread:a'), true);
          // A write exactly maxAgeMs after the eviction keeps it: the bound
          // is strict.
          await session.run(claim('w1', a, 3 + 10));
          assert.equal(await expired('chat:a'), true);
          // One millisecond later, the next write forgets it, and only
          // the keys the rule names. The key is then new again.
          await session.run(claim('w2', a, 3 + 10 + 1));
          assert.equal(await expired('chat:a'), false);
          assert.equal(await expired('thread:a'), true);
          assert.deepEqual(await session.run(claim('chat:a', a, 20)), {
            kind: 'claimed',
            reclaimed: false,
          });
          // A read does not run retention.
          assert.equal(await expired('thread:a'), true);
          assert.deepEqual(await session.run(claim('thread:a', a, 10_000)), {
            kind: 'expired',
          });
        },
        {
          limits: {
            turnDedupMaxEntries: 2,
            turnDedupTombstoneRetention: [{ keyPrefix: 'chat:', maxAgeMs: 10 }],
          },
        },
      ),
  },
  {
    name: 'turn dedup: forgetting a prefix forgets the tombstones under it too',
    areas: ['turnDedup'],
    run: (harness) =>
      withSession(
        harness,
        async (session) => {
          const a = session.processes.spawn();
          const settle = (key: string, now: number) =>
            settleDedup(session, a, key, now);
          for (const [index, key] of ['a::1', 'b::1', 'a::2', 'b::2'].entries())
            await settle(key, index + 1);
          // a::1 and b::1 were evicted; a::2 and b::2 are rows.
          assert.deepEqual(
            await session.run({
              type: 'turnDedup.forgetPrefix',
              prefix: 'a::',
            }),
            { kind: 'applied', removed: 2 },
          );
          assert.deepEqual(await session.run(claim('a::1', a, 9)), {
            kind: 'claimed',
            reclaimed: false,
          });
          assert.deepEqual(await session.run(claim('b::1', a, 9)), {
            kind: 'expired',
          });
        },
        { limits: { turnDedupMaxEntries: 2 } },
      ),
  },
  {
    name: 'turn dedup: forgetPrefix is an exact prefix match',
    areas: ['turnDedup'],
    run: (harness) =>
      withSession(harness, async (session) => {
        const a = session.processes.spawn();
        for (const key of ['a::1', 'a::2', 'ab::1', 'x%', 'xy'])
          await session.run(claim(key, a));
        assert.deepEqual(
          await session.run({ type: 'turnDedup.forgetPrefix', prefix: 'a::' }),
          { kind: 'applied', removed: 2 },
        );
        assert.deepEqual(
          await session.run({ type: 'turnDedup.forgetPrefix', prefix: 'x%' }),
          { kind: 'applied', removed: 1 },
        );
        assert.notEqual(await dedupRecord(session, 'ab::1'), undefined);
        assert.notEqual(await dedupRecord(session, 'xy'), undefined);
        // Thread ids may hold NUL or characters outside the BMP.
        for (const key of [
          'n\u0000a::1',
          'n\u0000b::1',
          '\u{1f600}::1',
          '\u{1f600}x::1',
        ])
          await session.run(claim(key, a));
        assert.deepEqual(
          await session.run({
            type: 'turnDedup.forgetPrefix',
            prefix: 'n\u0000a::',
          }),
          { kind: 'applied', removed: 1 },
        );
        assert.deepEqual(
          await session.run({
            type: 'turnDedup.forgetPrefix',
            prefix: '\u{1f600}::',
          }),
          { kind: 'applied', removed: 1 },
        );
        // An empty prefix would forget every key, and a lone surrogate is
        // encoded differently by each storage: both are refused.
        for (const prefix of ['', 'a\ud83d'])
          await assert.rejects(
            session.run({ type: 'turnDedup.forgetPrefix', prefix }),
            RangeError,
          );
        assert.notEqual(await dedupRecord(session, 'n\u0000b::1'), undefined);
        assert.notEqual(await dedupRecord(session, '\u{1f600}x::1'), undefined);
      }),
  },
];

const turnBoundary: KernelConformanceCase[] = [
  {
    name: 'turn boundary: a pending, invoking or lifecycle row occupies its thread',
    areas: ['turnBoundary'],
    run: (harness) =>
      withSession(harness, async (session) => {
        const a = session.processes.spawn();
        assert.deepEqual(await session.run(create('b1', 't1', a, at(1))), {
          kind: 'applied',
        });
        assert.deepEqual(await session.run(create('b2', 't1', a, at(1))), {
          kind: 'busy',
        });
        assert.deepEqual(
          await session.run(create('l1', 't1', a, at(1), 'lifecycle')),
          { kind: 'busy' },
        );
        // Re-creating one's own row is an idempotent retry.
        assert.deepEqual(await session.run(create('b1', 't1', a, at(1))), {
          kind: 'applied',
        });
        assert.deepEqual(await session.run(create('b3', 't2', a, at(1))), {
          kind: 'applied',
        });
        assert.deepEqual(
          await session.run(create('l3', 't3', a, at(1), 'lifecycle')),
          { kind: 'applied' },
        );
        assert.deepEqual(await session.run(create('b4', 't3', a, at(1))), {
          kind: 'busy',
        });
      }),
  },
  {
    name: 'turn boundary: transitions are owner-only, from-guarded and idempotent on exact retry',
    areas: ['turnBoundary'],
    run: (harness) =>
      withSession(harness, async (session) => {
        const a = session.processes.spawn();
        const b = session.processes.spawn();
        await session.run(create('b1', 't', a, at(1)));
        assert.deepEqual(
          await session.run(
            transition('b1', b, ['prepared'], 'invoking', at(2)),
          ),
          { kind: 'stale' },
        );
        assert.deepEqual(
          await session.run(
            transition('b1', a, ['prepared'], 'invoking', at(2)),
          ),
          { kind: 'applied' },
        );
        assert.deepEqual(
          await session.run(
            transition('b1', a, ['prepared'], 'invoking', at(2)),
          ),
          { kind: 'applied' },
        );
        assert.deepEqual(
          await session.run(
            transition('b1', a, ['prepared'], 'invoking', at(3)),
          ),
          { kind: 'stale' },
        );
        assert.deepEqual(
          await session.run(
            transition('b1', a, ['invoking'], 'accepted', at(4), 'p1'),
          ),
          { kind: 'applied' },
        );
        const row = await boundary(session, 'b1');
        assert.equal(row?.state, 'accepted');
        assert.equal(row?.providerTurnId, 'p1');
        assert.equal(row?.updatedAt, at(4));
        assert.equal(row?.createdAt, at(1));
      }),
  },
  {
    name: 'turn boundary: accepting a provider turn the thread saw terminate is ambiguous',
    areas: ['turnBoundary'],
    run: (harness) =>
      withSession(harness, async (session) => {
        const a = session.processes.spawn();
        await session.run({
          type: 'turnBoundary.observeTerminal',
          threadId: 't',
          providerTurnId: 'p1',
          sessionTerminal: false,
          terminalCreatedAt: at(1),
        });
        await session.run(create('b1', 't', a, at(2)));
        await session.run(transition('b1', a, ['prepared'], 'invoking', at(3)));
        assert.deepEqual(
          await session.run(
            transition('b1', a, ['invoking'], 'accepted', at(4), 'p1'),
          ),
          { kind: 'ambiguous' },
        );
        const row = await boundary(session, 'b1');
        assert.equal(row?.state, 'indeterminate');
        assert.equal(row?.providerTurnId, 'p1');
      }),
  },
  {
    name: 'turn boundary: accepting a provider turn another row holds is ambiguous',
    areas: ['turnBoundary'],
    run: (harness) =>
      withSession(harness, async (session) => {
        const a = session.processes.spawn();
        await session.run(recordAccepted('b0', 't', 'p1', a, at(1)));
        await session.run(create('b1', 't', a, at(2)));
        await session.run(transition('b1', a, ['prepared'], 'invoking', at(3)));
        assert.deepEqual(
          await session.run(
            transition('b1', a, ['invoking'], 'accepted', at(4), 'p1'),
          ),
          { kind: 'ambiguous' },
        );
        assert.deepEqual(
          await session.run(
            transition('b1', a, ['indeterminate'], 'accepted', at(5), 'p2'),
          ),
          { kind: 'applied' },
        );
      }),
  },
  {
    name: 'turn boundary: remove is guarded by owner, state, updatedAt and owner death',
    areas: ['turnBoundary'],
    run: (harness) =>
      withSession(harness, async (session) => {
        const a = session.processes.spawn();
        const b = session.processes.spawn();
        const remove = (
          extra: {
            ownerId?: string;
            from?: TurnBoundaryRecord['state'][];
            ifUpdatedAt?: string;
            onlyIfOwnerDead?: boolean;
          } = {},
        ) =>
          session.run({
            type: 'turnBoundary.remove',
            boundaryId: 'b1',
            ownerId: a.id,
            from: ['invoking'],
            ...extra,
          });
        assert.deepEqual(await remove({}), { kind: 'applied' });
        await session.run(create('b1', 't', a, at(1)));
        await session.run(transition('b1', a, ['prepared'], 'invoking', at(2)));
        assert.deepEqual(await remove({ ownerId: b.id }), { kind: 'stale' });
        assert.deepEqual(await remove({ from: ['prepared'] }), {
          kind: 'stale',
        });
        assert.deepEqual(await remove({ ifUpdatedAt: at(1) }), {
          kind: 'stale',
        });
        assert.deepEqual(await remove({ onlyIfOwnerDead: true }), {
          kind: 'busy',
        });
        session.processes.kill(a);
        assert.deepEqual(
          await remove({ onlyIfOwnerDead: true, ifUpdatedAt: at(2) }),
          { kind: 'applied' },
        );
        assert.equal(await boundary(session, 'b1'), undefined);
      }),
  },
  {
    name: 'turn boundary: a thread holds at most the accepted capacity',
    areas: ['turnBoundary'],
    run: (harness) =>
      withSession(
        harness,
        async (session) => {
          const a = session.processes.spawn();
          for (const id of ['a1', 'a2'])
            assert.deepEqual(
              await session.run(recordAccepted(id, 't', id, a, at(1))),
              { kind: 'applied' },
            );
          assert.deepEqual(
            await session.run(recordAccepted('a3', 't', 'a3', a, at(1))),
            { kind: 'busy' },
          );
          assert.deepEqual(await session.run(create('b1', 't', a, at(1))), {
            kind: 'busy',
          });
        },
        { limits: { turnBoundaryAcceptedCapacity: 2 } },
      ),
  },
  {
    name: 'turn boundary: a terminal retires only the rows it ends',
    areas: ['turnBoundary'],
    run: (harness) =>
      withSession(harness, async (session) => {
        const a = session.processes.spawn();
        // A turn terminal retires its own accepted row, created no later.
        await session.run(recordAccepted('a1', 't', 'p1', a, at(1)));
        await session.run(recordAccepted('a2', 't', 'p2', a, at(1)));
        await session.run(recordAccepted('a3', 't', 'p1', a, at(5)));
        await session.run({
          type: 'turnBoundary.observeTerminal',
          threadId: 't',
          providerTurnId: 'p1',
          sessionTerminal: false,
          terminalCreatedAt: at(3),
        });
        assert.deepEqual(
          (await boundaries(session))
            .filter((row) => row.threadId === 't')
            .map((row) => row.boundaryId),
          ['a2', 'a3'],
        );
        // A session terminal retires every turn row, but not a task
        // dispatch, a lifecycle claim, or a newer row.
        await session.run(
          create('d1', 'u', a, at(1), 'prepared', 'task-dispatch'),
        );
        await session.run(recordAccepted('u1', 'u', 'q1', a, at(1)));
        await session.run(recordAccepted('u2', 'u', 'q2', a, at(9)));
        await session.run(create('l1', 'v', a, at(1), 'lifecycle'));
        await session.run(recordAccepted('v1', 'v', 'r1', a, at(1)));
        for (const threadId of ['u', 'v'])
          await session.run({
            type: 'turnBoundary.observeTerminal',
            threadId,
            sessionTerminal: true,
            terminalCreatedAt: at(5),
          });
        assert.deepEqual(
          (await boundaries(session))
            .filter((row) => row.threadId !== 't')
            .map((row) => row.boundaryId),
          ['d1', 'l1', 'u2'],
        );
        // A retained prefix in a retained state keeps its rows; the rest of
        // the thread retires.
        await session.run(recordAccepted('keep:w1', 'w', 's1', a, at(1)));
        await session.run(recordAccepted('drop:w2', 'w', 's2', a, at(1)));
        const wRows = async () =>
          (await boundaries(session))
            .filter((row) => row.threadId === 'w')
            .map((row) => row.boundaryId);
        await session.run({
          type: 'turnBoundary.observeTerminal',
          threadId: 'w',
          sessionTerminal: true,
          terminalCreatedAt: at(5),
          retain: { boundaryIdPrefixes: ['keep:'], states: ['accepted'] },
        });
        assert.deepEqual(await wRows(), ['keep:w1']);
        // The same prefix in a state not retained retires.
        await session.run({
          type: 'turnBoundary.observeTerminal',
          threadId: 'w',
          sessionTerminal: true,
          terminalCreatedAt: at(5),
          retain: { boundaryIdPrefixes: ['keep:'], states: ['invoking'] },
        });
        assert.deepEqual(await wRows(), []);
        // `retire: false` records the fact and retires nothing.
        await session.run({
          type: 'turnBoundary.observeTerminal',
          threadId: 't',
          providerTurnId: 'p2',
          sessionTerminal: false,
          terminalCreatedAt: at(9),
          retire: false,
        });
        assert.notEqual(await boundary(session, 'a2'), undefined);
        // ...but the fact is recorded: accepting that turn id later is
        // ambiguous, as for any terminal the thread has seen.
        await session.run({
          type: 'turnBoundary.observeTerminal',
          threadId: 'z',
          providerTurnId: 'pz',
          sessionTerminal: false,
          terminalCreatedAt: at(1),
          retire: false,
        });
        await session.run(create('bz', 'z', a, at(2)));
        await session.run(transition('bz', a, ['prepared'], 'invoking', at(3)));
        assert.deepEqual(
          await session.run(
            transition('bz', a, ['invoking'], 'accepted', at(4), 'pz'),
          ),
          { kind: 'ambiguous' },
        );
      }),
  },
  {
    name: 'turn boundary: a lifecycle claim alone is no possible effect',
    areas: ['turnBoundary'],
    run: (harness) =>
      withSession(harness, async (session) => {
        const a = session.processes.spawn();
        await session.run(create('l1', 't', a, at(1), 'lifecycle'));
        assert.deepEqual(
          await session.run({
            type: 'turnBoundary.hasPossibleEffect',
            threadId: 't',
          }),
          { kind: 'available', active: false },
        );
        await session.run(create('b1', 'u', a, at(1)));
        assert.deepEqual(
          await session.run({
            type: 'turnBoundary.hasPossibleEffect',
            threadId: 'u',
          }),
          { kind: 'available', active: true },
        );
      }),
  },
  {
    name: "turn boundary: reconcile settles only dead owners' rows",
    areas: ['turnBoundary'],
    run: (harness) =>
      withSession(harness, async (session) => {
        const dead = session.processes.spawn();
        const live = session.processes.spawn();
        const hidden = session.processes.spawn();
        await session.run(create('prepared', 't1', dead, at(1)));
        await session.run(create('invoking', 't2', dead, at(1)));
        await session.run(
          transition('invoking', dead, ['prepared'], 'invoking', at(2)),
        );
        await session.run(recordAccepted('accepted', 't3', 'p', dead, at(1)));
        await session.run(create('lifecycle', 't4', dead, at(1), 'lifecycle'));
        await session.run(create('live', 't5', live, at(1)));
        await session.run(
          transition('live', live, ['prepared'], 'invoking', at(2)),
        );
        await session.run(create('hidden', 't6', hidden, at(1)));
        await session.run(
          transition('hidden', hidden, ['prepared'], 'invoking', at(2)),
        );
        session.processes.kill(dead);
        session.processes.makeUnobservable(hidden);
        const first = await reconcile(session, at(10));
        assert.equal(first.kind, 'reconciled');
        const reported = interruptedOf(first);
        assert.deepEqual(
          reported.map((row) => [row.boundaryId, row.state]).sort(),
          [
            ['accepted', 'accepted'],
            ['invoking', 'indeterminate'],
          ],
        );
        assert.deepEqual(
          (await boundaries(session)).map((row) => [row.boundaryId, row.state]),
          [
            ['accepted', 'accepted'],
            ['hidden', 'invoking'],
            ['invoking', 'indeterminate'],
            ['live', 'invoking'],
          ],
        );
        assert.equal((await boundary(session, 'invoking'))?.updatedAt, at(10));
        // A row left unresolved is reported again until its owner retires it.
        const second = await reconcile(session, at(11));
        assert.deepEqual(
          interruptedOf(second)
            .map((row) => row.boundaryId)
            .sort(),
          ['accepted', 'invoking'],
        );
      }),
  },
  {
    name: 'turn boundary: forgetting a thread retires its rows and terminal facts, not its lifecycle claim',
    areas: ['turnBoundary'],
    run: (harness) =>
      withSession(harness, async (session) => {
        const a = session.processes.spawn();
        await session.run({
          type: 'turnBoundary.observeTerminal',
          threadId: 't',
          providerTurnId: 'p1',
          sessionTerminal: false,
          terminalCreatedAt: at(1),
        });
        await session.run(recordAccepted('a1', 't', 'p9', a, at(1)));
        await session.run(create('l1', 'w', a, at(1), 'lifecycle'));
        await session.run({ type: 'turnBoundary.forgetThread', threadId: 't' });
        await session.run({ type: 'turnBoundary.forgetThread', threadId: 'w' });
        assert.deepEqual(
          (await boundaries(session)).map((row) => row.boundaryId),
          ['l1'],
        );
        await session.run(create('b1', 't', a, at(2)));
        await session.run(transition('b1', a, ['prepared'], 'invoking', at(3)));
        assert.deepEqual(
          await session.run(
            transition('b1', a, ['invoking'], 'accepted', at(4), 'p1'),
          ),
          { kind: 'applied' },
        );
      }),
  },
];

turnBoundary.push({
  name: 'turn boundary: reconcile probes each process once and acts only on rows it saw unchanged',
  areas: ['turnBoundary'],
  run: (harness) =>
    withSession(harness, async (session) => {
      const dead = session.processes.spawn();
      const other = session.processes.spawn();
      await session.run(create('i1', 't1', dead, at(1)));
      await session.run(
        transition('i1', dead, ['prepared'], 'invoking', at(2)),
      );
      await session.run(create('i2', 't2', dead, at(1)));
      await session.run(
        transition('i2', dead, ['prepared'], 'invoking', at(2)),
      );
      await session.run(create('p3', 't3', other, at(1)));
      session.processes.kill(dead);
      session.processes.kill(other);
      const probed: number[] = [];
      const listed = await session.run({ type: 'turnBoundary.list' });
      const plan = planTurnBoundaryReconcile(
        listed.kind === 'records' ? listed.records : [],
        {
          probe: (pid) => {
            probed.push(pid);
            return session.processes.probe(pid);
          },
        },
        at(5),
      );
      assert.deepEqual(probed.sort(), [dead.pid, other.pid].sort());
      // i2 moves on after the probe and before the commit.
      await session.run(
        transition('i2', dead, ['invoking'], 'accepted', at(6), 'p2'),
      );
      const result = await session.run(plan);
      assert.deepEqual(
        interruptedOf(result).map((row) => [row.boundaryId, row.state]),
        [['i1', 'indeterminate']],
      );
      assert.deepEqual(
        (await boundaries(session)).map((row) => [row.boundaryId, row.state]),
        [
          ['i1', 'indeterminate'],
          ['i2', 'accepted'],
        ],
      );
    }),
});

turnBoundary.push({
  name: 'turn boundary: reconcile leaves alone a row recreated under the same id and timestamps by another process',
  areas: ['turnBoundary'],
  run: (harness) =>
    withSession(harness, async (session) => {
      const dead = session.processes.spawn({ identityKind: 'unverified' });
      await session.run(create('b', 't', dead, at(1)));
      session.processes.kill(dead);
      const listed = await session.run({ type: 'turnBoundary.list' });
      const plan = planTurnBoundaryReconcile(
        listed.kind === 'records' ? listed.records : [],
        { probe: session.processes.probe },
        at(5),
      );
      // The row is removed and recreated with the same id, owner id and
      // timestamps, but by a live process.
      await session.run({
        type: 'turnBoundary.remove',
        boundaryId: 'b',
        ownerId: dead.id,
        from: ['prepared'],
      });
      const live = {
        ...session.processes.spawn({ identityKind: 'unverified' }),
        id: dead.id,
      };
      await session.run(create('b', 't', live, at(1)));
      const result = await session.run(plan);
      assert.deepEqual(interruptedOf(result), []);
      assert.equal((await boundary(session, 'b'))?.owner.pid, live.pid);
    }),
});

turnBoundary.push({
  name: 'turn boundary: reconcile leaves alone a row recreated by the same owner at another createdAt',
  areas: ['turnBoundary'],
  run: (harness) =>
    withSession(harness, async (session) => {
      const dead = session.processes.spawn();
      await session.run(create('b', 't', dead, at(1)));
      await session.run(transition('b', dead, ['prepared'], 'invoking', at(2)));
      session.processes.kill(dead);
      const listed = await session.run({ type: 'turnBoundary.list' });
      const plan = planTurnBoundaryReconcile(
        listed.kind === 'records' ? listed.records : [],
        { probe: session.processes.probe },
        at(5),
      );
      // Same id and the same full owner, created again at the old row's
      // updatedAt: only createdAt tells the rows apart.
      await session.run({
        type: 'turnBoundary.remove',
        boundaryId: 'b',
        ownerId: dead.id,
        from: ['invoking'],
      });
      await session.run(create('b', 't', dead, at(2)));
      const result = await session.run(plan);
      assert.deepEqual(interruptedOf(result), []);
      assert.equal((await boundary(session, 'b'))?.state, 'prepared');
    }),
});

const preparedIntent = {
  invocationId: 'invocation-a',
  inputDigest: 'input-bytes-a',
  intentDigest: 'envelope-a',
  bodyRef: 'opaque:body-a',
  dedupKey: 'prepared-key',
} as const;

async function prepareIntent(session: Session) {
  const owner = session.processes.spawn();
  const dedupOwner = session.processes.spawn();
  assert.deepEqual(await session.run(claim('prepared-key', dedupOwner)), {
    kind: 'claimed',
    reclaimed: false,
  });
  assert.deepEqual(
    await session.run(create('intent', 't', owner, at(1), 'reserved')),
    { kind: 'applied' },
  );
  const command = {
    type: 'turnBoundary.prepare',
    boundaryId: 'intent',
    ownerId: owner.id,
    dedupOwnerId: dedupOwner.id,
    intent: preparedIntent,
    now: at(2),
  } as const;
  assert.deepEqual(await session.run(command), { kind: 'applied' });
  return { owner, dedupOwner, command };
}

turnBoundary.push(
  {
    name: 'prepared intent: failed keyless preparation leaves its reservation, and ordinary cleanup retains captured input',
    areas: ['turnBoundary'],
    run: (harness) =>
      withSession(harness, async (session) => {
        const owner = session.processes.spawn();
        await session.run(create('keyless', 't', owner, at(1), 'reserved'));
        const intent = {
          invocationId: 'keyless-i',
          inputDigest: 'keyless-d',
          intentDigest: 'keyless-e',
          bodyRef: 'keyless-body',
        };
        const prepare = {
          type: 'turnBoundary.prepare',
          boundaryId: 'keyless',
          ownerId: owner.id,
          intent,
          now: at(2),
        } as const;
        session.store.failNextCommit();
        await assert.rejects(session.run(prepare), /Injected commit failure/);
        await session.store.reopen();
        assert.equal((await boundary(session, 'keyless'))?.state, 'reserved');
        assert.equal((await boundary(session, 'keyless'))?.intent, undefined);
        assert.deepEqual(await session.run(prepare), { kind: 'applied' });
        intent.bodyRef = 'mutated-caller-reference';
        await session.store.reopen();
        assert.equal(
          (await boundary(session, 'keyless'))?.intent?.bodyRef,
          'keyless-body',
        );
        assert.deepEqual(
          await session.run({
            type: 'turnBoundary.remove',
            boundaryId: 'keyless',
            ownerId: owner.id,
            from: ['prepared'],
          }),
          { kind: 'stale' },
        );
        assert.deepEqual(
          await session.run({
            type: 'turnBoundary.beginInvocation',
            boundaryId: 'keyless',
            ownerId: owner.id,
            intent: { ...intent, bodyRef: 'keyless-body' },
            now: at(3),
          }),
          { kind: 'applied' },
        );
      }),
  },
  ...(
    [
      'boundary-unknown',
      'dedup-unknown',
      'boundary-live',
      'dedup-live',
    ] as const
  ).map(
    (control): KernelConformanceCase => ({
      name: `prepared intent: ${control} independently blocks owner transfer`,
      areas: ['turnBoundary', 'turnDedup'],
      run: (harness) =>
        withSession(harness, async (session) => {
          const { owner, dedupOwner } = await prepareIntent(session);
          const blocked = control.startsWith('boundary') ? owner : dedupOwner;
          const dead = control.startsWith('boundary') ? dedupOwner : owner;
          session.processes.kill(dead);
          if (control.endsWith('unknown'))
            session.processes.makeUnobservable(blocked);
          const successor = session.processes.spawn();
          assert.deepEqual(
            await session.run({
              type: 'turnBoundary.resumePrepared',
              boundaryId: 'intent',
              intent: preparedIntent,
              observed: {
                owner,
                createdAt: at(1),
                updatedAt: at(2),
                verdict: 'dead',
              },
              owner: successor,
              dedup: {
                previousOwner: dedupOwner,
                createdAt: 1,
                updatedAt: at(2),
                owner: successor,
              },
              now: at(3),
            }),
            { kind: 'refused' },
          );
          assert.equal((await boundary(session, 'intent'))?.owner.id, owner.id);
          const linked = await session.run({
            type: 'turnDedup.read',
            key: 'prepared-key',
          });
          assert.equal(
            linked.kind === 'found' && linked.record.owner?.id,
            dedupOwner.id,
          );
        }),
    }),
  ),
  {
    name: 'prepared intent: immutable preparation and pending dedup link survive reopen',
    areas: ['turnBoundary', 'turnDedup'],
    run: (harness) =>
      withSession(harness, async (session) => {
        const { owner, dedupOwner, command } = await prepareIntent(session);
        await session.store.reopen();
        assert.deepEqual(await session.run({ ...command, now: at(3) }), {
          kind: 'applied',
        });
        for (const field of [
          'invocationId',
          'inputDigest',
          'intentDigest',
          'bodyRef',
          'dedupKey',
        ] as const)
          assert.deepEqual(
            await session.run({
              ...command,
              intent: { ...preparedIntent, [field]: 'changed' },
            }),
            { kind: 'conflict' },
          );
        assert.deepEqual(
          (await boundary(session, 'intent'))?.intent,
          preparedIntent,
        );
        assert.equal((await boundary(session, 'intent'))?.updatedAt, at(2));
        const key = await session.run({
          type: 'turnDedup.read',
          key: 'prepared-key',
        });
        assert.equal(key.kind, 'found');
        if (key.kind !== 'found')
          throw new Error('Expected linked pending key');
        assert.equal(key.record.preparedInvocationId, 'invocation-a');
        assert.equal(key.record.invocation, 'pending');
        session.processes.kill(owner);
        session.processes.kill(dedupOwner);
        assert.deepEqual(
          await session.run(claim('prepared-key', session.processes.spawn())),
          { kind: 'prepared', invocationId: 'invocation-a' },
        );
        assert.deepEqual(
          await session.run({
            type: 'turnDedup.release',
            key: 'prepared-key',
            ownerId: dedupOwner.id,
            now: 4,
          }),
          { kind: 'stale' },
        );
        assert.deepEqual(
          await session.run({
            type: 'turnDedup.beginInvocation',
            key: 'prepared-key',
            ownerId: dedupOwner.id,
            now: 4,
          }),
          { kind: 'refused' },
        );
        assert.deepEqual(
          await session.run(
            transition('intent', owner, ['prepared'], 'invoking', at(4)),
          ),
          { kind: 'stale' },
        );
        assert.deepEqual(
          (await boundary(session, 'intent'))?.intent,
          preparedIntent,
        );
      }),
  },
  {
    name: 'prepared intent: atomic begin requires exact facts and rolls both writes back on failure',
    areas: ['turnBoundary', 'turnDedup'],
    run: (harness) =>
      withSession(harness, async (session) => {
        const { owner, dedupOwner } = await prepareIntent(session);
        const begin = {
          type: 'turnBoundary.beginInvocation',
          boundaryId: 'intent',
          ownerId: owner.id,
          dedupOwnerId: dedupOwner.id,
          intent: preparedIntent,
          now: at(3),
        } as const;
        for (const bad of [
          { ...begin, ownerId: 'wrong' },
          { ...begin, dedupOwnerId: 'wrong' },
          { ...begin, intent: { ...preparedIntent, intentDigest: 'wrong' } },
        ])
          assert.deepEqual(await session.run(bad), { kind: 'refused' });
        const held = session.store.holdNextCommit();
        const lost = assert.rejects(session.run(begin), KernelCrashError);
        await held.entered;
        await session.store.crash();
        await lost;
        await session.store.reopen();
        session.store.failNextCommit();
        await assert.rejects(session.run(begin), /Injected commit failure/);
        await session.store.reopen();
        assert.equal((await boundary(session, 'intent'))?.state, 'prepared');
        const pending = await session.run({
          type: 'turnDedup.read',
          key: 'prepared-key',
        });
        assert.equal(
          pending.kind === 'found' && pending.record.invocation,
          'pending',
        );
        assert.deepEqual(await session.run(begin), { kind: 'applied' });
        await session.store.reopen();
        assert.equal((await boundary(session, 'intent'))?.state, 'invoking');
        const begun = await session.run({
          type: 'turnDedup.read',
          key: 'prepared-key',
        });
        assert.equal(
          begun.kind === 'found' && begun.record.invocation,
          'begun',
        );
        assert.deepEqual(await session.run(begin), { kind: 'applied' });
        assert.deepEqual(
          await session.run({
            type: 'turnBoundary.prepare',
            boundaryId: 'intent',
            ownerId: owner.id,
            dedupOwnerId: dedupOwner.id,
            intent: preparedIntent,
            now: at(4),
          }),
          { kind: 'stale' },
        );
      }),
  },
  {
    name: 'prepared intent: explicit resume compares both owners and revisions, never takes live or unknown owners',
    areas: ['turnBoundary', 'turnDedup'],
    run: (harness) =>
      withSession(harness, async (session) => {
        const { owner, dedupOwner } = await prepareIntent(session);
        const row = await boundary(session, 'intent');
        assert.ok(row);
        const successor = session.processes.spawn();
        const successorDedup = session.processes.spawn();
        const resume = {
          type: 'turnBoundary.resumePrepared',
          boundaryId: 'intent',
          intent: preparedIntent,
          observed: {
            owner,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            verdict: 'dead',
          },
          owner: successor,
          dedup: {
            previousOwner: dedupOwner,
            createdAt: 1,
            updatedAt: at(2),
            owner: successorDedup,
          },
          now: at(5),
        } as const;
        assert.deepEqual(await session.run(resume), { kind: 'refused' });
        session.processes.kill(owner);
        assert.deepEqual(await session.run(resume), { kind: 'refused' });
        session.processes.makeUnobservable(dedupOwner);
        assert.deepEqual(await session.run(resume), { kind: 'refused' });
        // An independently dead exact dedup owner is required; use a second fixture below.
        assert.equal((await boundary(session, 'intent'))?.owner.id, owner.id);
      }),
  },
  {
    name: 'prepared intent: dead-owner resume preserves intent and cannot run again after begin',
    areas: ['turnBoundary', 'turnDedup'],
    run: (harness) =>
      withSession(harness, async (session) => {
        const { owner, dedupOwner } = await prepareIntent(session);
        session.processes.reusePid(owner);
        session.processes.kill(dedupOwner);
        const row = await boundary(session, 'intent');
        assert.ok(row);
        const successor = session.processes.spawn();
        const successorDedup = session.processes.spawn();
        const resume = {
          type: 'turnBoundary.resumePrepared',
          boundaryId: 'intent',
          intent: preparedIntent,
          observed: {
            owner,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            verdict: 'dead',
          },
          owner: successor,
          dedup: {
            previousOwner: dedupOwner,
            createdAt: 1,
            updatedAt: at(2),
            owner: successorDedup,
          },
          now: at(5),
        } as const;
        for (const bad of [
          { ...resume, observed: { ...resume.observed, updatedAt: at(9) } },
          {
            ...resume,
            observed: { ...resume.observed, owner: { ...owner, pid: 99 } },
          },
          { ...resume, dedup: { ...resume.dedup, createdAt: 99 } },
          { ...resume, dedup: { ...resume.dedup, updatedAt: at(9) } },
          {
            ...resume,
            dedup: {
              ...resume.dedup,
              previousOwner: { ...dedupOwner, pid: 99 },
            },
          },
          { ...resume, intent: { ...preparedIntent, inputDigest: 'wrong' } },
        ])
          assert.deepEqual(await session.run(bad), { kind: 'refused' });
        session.store.failNextCommit();
        await assert.rejects(session.run(resume), /Injected commit failure/);
        await session.store.reopen();
        assert.equal((await boundary(session, 'intent'))?.owner.id, owner.id);
        assert.deepEqual(await session.run(resume), { kind: 'applied' });
        await session.store.reopen();
        assert.deepEqual(
          (await boundary(session, 'intent'))?.intent,
          preparedIntent,
        );
        assert.equal(
          (await boundary(session, 'intent'))?.owner.id,
          successor.id,
        );
        assert.deepEqual(await session.run(resume), { kind: 'refused' });
        assert.deepEqual(
          await session.run({
            type: 'turnBoundary.beginInvocation',
            boundaryId: 'intent',
            ownerId: successor.id,
            dedupOwnerId: successorDedup.id,
            intent: preparedIntent,
            now: at(6),
          }),
          { kind: 'applied' },
        );
        session.processes.kill(successor);
        session.processes.kill(successorDedup);
        const recovery = await reconcile(session, at(7));
        assert.equal(recovery.kind, 'reconciled');
        if (recovery.kind !== 'reconciled')
          throw new Error('Expected recovery');
        assert.deepEqual(recovery.resumable, []);
        assert.equal(recovery.interrupted[0]?.state, 'indeterminate');
        assert.deepEqual(recovery.interrupted[0]?.intent, preparedIntent);
        assert.deepEqual(
          await session.run({
            ...resume,
            observed: {
              ...resume.observed,
              owner: successor,
              updatedAt: at(7),
            },
            dedup: { ...resume.dedup, previousOwner: successorDedup },
          }),
          { kind: 'refused' },
        );
      }),
  },
  {
    name: 'prepared intent: reconcile separates resumable intent from abandoned reservations and legacy preparation',
    areas: ['turnBoundary', 'turnDedup'],
    run: (harness) =>
      withSession(harness, async (session) => {
        const { owner, dedupOwner } = await prepareIntent(session);
        await session.run(create('reserved', 'r', owner, at(1), 'reserved'));
        await session.run(create('legacy', 'l', owner, at(1)));
        await session.run(
          create('dispatch', 'd', owner, at(1), 'prepared', 'task-dispatch'),
        );
        session.processes.kill(owner);
        session.processes.kill(dedupOwner);
        await session.store.reopen();
        const result = await reconcile(session, at(8));
        assert.equal(result.kind, 'reconciled');
        if (result.kind !== 'reconciled') throw new Error('Expected recovery');
        assert.deepEqual(result.interrupted, []);
        assert.deepEqual(
          result.resumable.map((candidate) => candidate.boundaryId),
          ['intent'],
        );
        assert.deepEqual(
          (await boundaries(session)).map((candidate) => candidate.boundaryId),
          ['intent'],
        );
        assert.deepEqual(result.resumable[0]?.intent, preparedIntent);
      }),
  },
);

for (const type of [
  'turnBoundary.cancelPrepared',
  'turnBoundary.recordDefinitiveRefusal',
] as const) {
  const refused = type === 'turnBoundary.recordDefinitiveRefusal';
  const disposition = refused ? 'definitively-refused' : 'cancelled';
  const settlement = (owner: OwnerIdentity, dedupOwner: OwnerIdentity) => ({
    type,
    boundaryId: 'intent',
    intent: preparedIntent,
    settlementId: 'settlement-a',
    now: at(5),
    boundary: { owner, createdAt: at(1), updatedAt: refused ? at(3) : at(2) },
    dedup: { owner: dedupOwner, createdAt: 1, updatedAt: at(2) },
  });
  turnBoundary.push({
    name: `prepared settlement: ${disposition} retains audit, acknowledges exactly, and frees only active capacity`,
    areas: ['turnBoundary', 'turnDedup'],
    run: (harness) =>
      withSession(
        harness,
        async (session) => {
          const { owner, dedupOwner } = await prepareIntent(session);
          if (refused)
            assert.deepEqual(
              await session.run({
                type: 'turnBoundary.beginInvocation',
                boundaryId: 'intent',
                ownerId: owner.id,
                dedupOwnerId: dedupOwner.id,
                intent: preparedIntent,
                now: at(3),
              }),
              { kind: 'applied' },
            );
          const command = settlement(owner, dedupOwner);
          for (const bad of [
            {
              ...command,
              boundary: { ...command.boundary, owner: { ...owner, pid: 90 } },
            },
            { ...command, boundary: { ...command.boundary, createdAt: at(9) } },
            { ...command, boundary: { ...command.boundary, updatedAt: at(9) } },
            {
              ...command,
              dedup: { ...command.dedup, owner: { ...dedupOwner, pid: 90 } },
            },
            { ...command, dedup: { ...command.dedup, createdAt: 90 } },
            { ...command, dedup: { ...command.dedup, updatedAt: at(9) } },
            {
              ...command,
              intent: { ...preparedIntent, bodyRef: 'changed-body' },
            },
          ])
            assert.deepEqual(await session.run(bad), { kind: 'refused' });
          const before = await boundary(session, 'intent');
          session.store.failNextCommit();
          await assert.rejects(session.run(command), /Injected commit failure/);
          await session.store.reopen();
          assert.deepEqual(await boundary(session, 'intent'), before);
          assert.equal(
            (await dedupRecord(session, 'prepared-key'))?.settlement,
            undefined,
          );
          assert.deepEqual(await session.run(command), { kind: 'applied' });
          await session.store.reopen();
          const expected = {
            id: 'settlement-a',
            disposition,
            at: at(5),
            boundaryId: 'intent',
            boundary: command.boundary,
            dedup: command.dedup,
          };
          assert.deepEqual(
            (await boundary(session, 'intent'))?.settlement,
            expected,
          );
          assert.deepEqual(
            (await boundary(session, 'intent'))?.intent,
            preparedIntent,
          );
          assert.equal((await boundary(session, 'intent'))?.state, 'settled');
          assert.deepEqual(
            (await dedupRecord(session, 'prepared-key'))?.settlement,
            expected,
          );
          assert.equal(
            (await dedupRecord(session, 'prepared-key'))?.value,
            null,
          );
          assert.deepEqual(await session.run(command), { kind: 'applied' });
          for (const bad of [
            { ...command, now: at(6) },
            { ...command, settlementId: 'another-settlement' },
            { ...command, boundary: { ...command.boundary, updatedAt: at(9) } },
            {
              ...command,
              intent: { ...preparedIntent, inputDigest: 'different-input' },
            },
          ])
            assert.deepEqual(await session.run(bad), { kind: 'refused' });
          session.processes.kill(owner);
          session.processes.kill(dedupOwner);
          assert.deepEqual(
            await session.run(claim('prepared-key', session.processes.spawn())),
            {
              kind: 'settled',
              disposition,
              invocationId: 'invocation-a',
              settlementId: 'settlement-a',
            },
          );
          assert.deepEqual(
            await session.run({
              type: 'turnDedup.release',
              key: 'prepared-key',
              ownerId: dedupOwner.id,
              now: 6,
            }),
            { kind: 'stale' },
          );
          assert.deepEqual(
            await session.run({
              type: 'turnDedup.beginInvocation',
              key: 'prepared-key',
              ownerId: dedupOwner.id,
              now: 6,
            }),
            { kind: 'refused' },
          );
          assert.deepEqual(
            await session.run({
              type: 'turnDedup.resolve',
              key: 'prepared-key',
              ownerId: dedupOwner.id,
              value: 'not-a-provider-turn',
              now: 6,
            }),
            { kind: 'stale' },
          );
          assert.deepEqual(
            await session.run({
              type: 'turnBoundary.remove',
              boundaryId: 'intent',
              ownerId: owner.id,
              from: ['settled'],
            }),
            { kind: 'stale' },
          );
          assert.deepEqual(
            await session.run(
              transition('intent', owner, ['settled'], 'invoking', at(6)),
            ),
            { kind: 'stale' },
          );
          assert.deepEqual(
            await session.run({
              type: 'turnBoundary.hasPossibleEffect',
              threadId: 't',
            }),
            { kind: 'available', active: false },
          );
          const recovered = await reconcile(session, at(6));
          assert.deepEqual(recovered, {
            kind: 'reconciled',
            interrupted: [],
            resumable: [],
          });
          await session.run({
            type: 'turnBoundary.observeTerminal',
            threadId: 't',
            sessionTerminal: true,
            terminalCreatedAt: at(7),
          });
          assert.deepEqual(
            (await boundary(session, 'intent'))?.settlement,
            expected,
          );
          if (!refused) {
            assert.deepEqual(
              await session.run({
                type: 'turnDedup.forgetPrefix',
                prefix: 'prepared-key',
              }),
              { kind: 'applied', removed: 1 },
            );
            assert.deepEqual(
              (await boundary(session, 'intent'))?.settlement,
              expected,
            );
            assert.deepEqual(await session.run(command), { kind: 'refused' });
            assert.deepEqual(
              await session.run(
                claim('prepared-key', session.processes.spawn(), 8),
              ),
              { kind: 'claimed', reclaimed: false },
            );
            assert.deepEqual(
              await session.run({
                type: 'turnBoundary.beginInvocation',
                boundaryId: 'intent',
                ownerId: owner.id,
                dedupOwnerId: dedupOwner.id,
                intent: preparedIntent,
                now: at(8),
              }),
              { kind: 'refused' },
            );
          }
          const next = session.processes.spawn();
          assert.deepEqual(
            await session.run(
              create(
                'lifecycle-after-settlement',
                't',
                next,
                at(8),
                'lifecycle',
              ),
            ),
            { kind: 'applied' },
          );
          await session.run({
            type: 'turnBoundary.remove',
            boundaryId: 'lifecycle-after-settlement',
            ownerId: next.id,
            from: ['lifecycle'],
          });
          assert.deepEqual(
            await session.run(
              recordAccepted('next', 't', 'provider-next', next, at(9)),
            ),
            { kind: 'applied' },
          );
          assert.deepEqual(
            await session.run(
              recordAccepted(
                'over-capacity',
                't',
                'provider-other',
                next,
                at(9),
              ),
            ),
            { kind: 'busy' },
          );
          await session.run({
            type: 'turnBoundary.forgetThread',
            threadId: 't',
          });
          assert.deepEqual(await boundaries(session), []);
        },
        { limits: { turnBoundaryAcceptedCapacity: 1 } },
      ),
  });
  turnBoundary.push({
    name: `prepared settlement: ${disposition} independently refuses the wrong keyless boundary stage and legacy inputless rows`,
    areas: ['turnBoundary', 'turnDedup'],
    run: (harness) =>
      withSession(harness, async (session) => {
        const owner = session.processes.spawn();
        const intent = {
          invocationId: 'stage-only',
          inputDigest: 'stage-input',
          intentDigest: 'stage-options',
          bodyRef: 'stage-body',
        };
        assert.deepEqual(
          await session.run(create('intent', 't', owner, at(1), 'reserved')),
          { kind: 'applied' },
        );
        assert.deepEqual(
          await session.run({
            type: 'turnBoundary.prepare',
            boundaryId: 'intent',
            ownerId: owner.id,
            intent,
            now: at(2),
          }),
          { kind: 'applied' },
        );
        if (!refused)
          assert.deepEqual(
            await session.run({
              type: 'turnBoundary.beginInvocation',
              boundaryId: 'intent',
              ownerId: owner.id,
              intent,
              now: at(3),
            }),
            { kind: 'applied' },
          );
        const command = {
          type,
          boundaryId: 'intent',
          intent,
          settlementId: 'stage-only-settlement',
          now: at(5),
          boundary: {
            owner,
            createdAt: at(1),
            updatedAt: refused ? at(2) : at(3),
          },
        };
        const before = await boundary(session, 'intent');
        assert.equal(before?.state, refused ? 'prepared' : 'invoking');
        assert.equal(before?.updatedAt, command.boundary.updatedAt);
        assert.deepEqual(await session.run(command), {
          kind: 'refused',
        });
        assert.deepEqual(await boundary(session, 'intent'), before);
        await session.run(create('legacy', 'u', owner, at(1)));
        assert.deepEqual(
          await session.run({
            ...command,
            boundaryId: 'legacy',
            boundary: { ...command.boundary, updatedAt: at(1) },
          }),
          { kind: 'refused' },
        );
        assert.deepEqual(
          await session.run({
            type: 'turnBoundary.remove',
            boundaryId: 'legacy',
            ownerId: owner.id,
            from: ['prepared'],
          }),
          { kind: 'applied' },
        );
      }),
  });
}

turnBoundary.push({
  name: 'prepared settlement: keyless cancellation keeps the opaque audit without inventing a dedup key',
  areas: ['turnBoundary'],
  run: (harness) =>
    withSession(harness, async (session) => {
      const owner = session.processes.spawn();
      const intent = {
        invocationId: 'keyless',
        inputDigest: 'bytes',
        intentDigest: 'options',
        bodyRef: 'host-owned-body',
      };
      await session.run(create('keyless', 't', owner, at(1), 'reserved'));
      await session.run({
        type: 'turnBoundary.prepare',
        boundaryId: 'keyless',
        ownerId: owner.id,
        intent,
        now: at(2),
      });
      const command = {
        type: 'turnBoundary.cancelPrepared',
        boundaryId: 'keyless',
        intent,
        settlementId: 'cancel-keyless',
        now: at(4),
        boundary: { owner, createdAt: at(1), updatedAt: at(2) },
      } as const;
      assert.deepEqual(await session.run(command), { kind: 'applied' });
      await session.store.reopen();
      assert.deepEqual(await session.run(command), { kind: 'applied' });
      assert.deepEqual((await boundary(session, 'keyless'))?.intent, intent);
      assert.equal(
        (await boundary(session, 'keyless'))?.settlement?.dedup,
        undefined,
      );
      assert.deepEqual(
        await session.run({
          type: 'turnBoundary.hasPossibleEffect',
          threadId: 't',
        }),
        { kind: 'available', active: false },
      );
    }),
});

const requestKeys: KernelConformanceCase[] = [
  {
    name: 'request keys: same digest replays or re-drives; a different digest conflicts',
    areas: ['requestKeys'],
    run: (harness) =>
      withSession(harness, async (session) => {
        const claimKey = (digest: string) =>
          session.run({
            type: 'requestKeys.claim',
            id: requestKey('k'),
            digest,
            now: 1,
          });
        assert.deepEqual(await claimKey('d'), { kind: 'claimed' });
        assert.deepEqual(await claimKey('d'), { kind: 'unresolved' });
        assert.deepEqual(
          await session.run({
            type: 'requestKeys.recordDecision',
            id: requestKey('k'),
            decision: 'steer',
          }),
          { kind: 'applied' },
        );
        assert.deepEqual(await claimKey('d'), {
          kind: 'unresolved',
          decision: 'steer',
        });
        assert.deepEqual(await claimKey('other'), { kind: 'conflict' });
        await session.run({
          type: 'requestKeys.complete',
          id: requestKey('k'),
          result: '{"ok":true}',
        });
        assert.deepEqual(await claimKey('d'), {
          kind: 'replay',
          result: '{"ok":true}',
        });
      }),
  },
  {
    name: 'request keys: only an unresolved key is released; writes to a missing key say so',
    areas: ['requestKeys'],
    run: (harness) =>
      withSession(harness, async (session) => {
        const id = requestKey('k');
        const claimKey = () =>
          session.run({ type: 'requestKeys.claim', id, digest: 'd', now: 1 });
        await claimKey();
        assert.deepEqual(
          await session.run({ type: 'requestKeys.release', id }),
          {
            kind: 'released',
          },
        );
        assert.deepEqual(await claimKey(), { kind: 'claimed' });
        await session.run({ type: 'requestKeys.complete', id, result: 'r' });
        assert.deepEqual(
          await session.run({ type: 'requestKeys.release', id }),
          {
            kind: 'kept',
          },
        );
        const missing = requestKey('missing');
        assert.deepEqual(
          await session.run({ type: 'requestKeys.release', id: missing }),
          { kind: 'missing' },
        );
        assert.deepEqual(
          await session.run({
            type: 'requestKeys.complete',
            id: missing,
            result: 'r',
          }),
          { kind: 'missing' },
        );
        assert.deepEqual(
          await session.run({
            type: 'requestKeys.recordDecision',
            id: missing,
            decision: 'x',
          }),
          { kind: 'missing' },
        );
      }),
  },
  {
    name: 'request keys: a completed key past its TTL is forgotten',
    areas: ['requestKeys'],
    run: (harness) =>
      withSession(
        harness,
        async (session) => {
          const old = requestKey('old');
          await session.run({
            type: 'requestKeys.claim',
            id: old,
            digest: 'd',
            now: 0,
          });
          await session.run({
            type: 'requestKeys.complete',
            id: old,
            result: 'r',
          });
          assert.deepEqual(
            await session.run({
              type: 'requestKeys.claim',
              id: old,
              digest: 'different',
              now: 20,
            }),
            { kind: 'claimed' },
          );
        },
        { limits: { requestKeyTtlMs: 10 } },
      ),
  },
  {
    name: 'request keys: an unresolved key past its TTL is kept and re-driven, and holds no quota slot',
    areas: ['requestKeys'],
    run: (harness) =>
      withSession(
        harness,
        async (session) => {
          const claimKey = (key: string, now: number, caller = 'c') =>
            session.run({
              type: 'requestKeys.claim',
              id: requestKey(key, caller),
              digest: 'd',
              now,
            });
          for (const key of ['stuck', 'stuck2'])
            assert.deepEqual(await claimKey(key, 0), { kind: 'claimed' });
          await session.run({
            type: 'requestKeys.recordDecision',
            id: requestKey('stuck', 'c'),
            decision: 'steer',
          });
          // At exactly the TTL both rows still hold a slot of the caller's
          // quota of two, and neither may be evicted: the caller is full.
          assert.deepEqual(await claimKey('a', 10), {
            kind: 'capacity',
            scope: 'caller',
          });
          // One millisecond later they are kept but hold no slot.
          assert.deepEqual(await claimKey('a', 11), { kind: 'claimed' });
          assert.deepEqual(await claimKey('b', 12), { kind: 'claimed' });
          assert.deepEqual(await claimKey('c', 13), {
            kind: 'capacity',
            scope: 'caller',
          });
          // The store-wide backstop of three does not count them either: a
          // and b are the only counted rows, so one more caller fits.
          assert.deepEqual(await claimKey('k', 13, 'o1'), { kind: 'claimed' });
          assert.deepEqual(await claimKey('k', 13, 'o2'), {
            kind: 'capacity',
            scope: 'store',
          });
          // A kept row is never answered as new, however old: it re-drives
          // with its decision.
          assert.deepEqual(await claimKey('stuck', 1_000_000), {
            kind: 'unresolved',
            decision: 'steer',
          });
        },
        {
          limits: {
            requestKeyTtlMs: 10,
            requestKeyMaxRowsPerCaller: 2,
            requestKeyMaxRows: 3,
          },
        },
      ),
  },
  {
    name: 'request keys: a caller over quota evicts only its own oldest completed rows',
    areas: ['requestKeys'],
    run: (harness) =>
      withSession(
        harness,
        async (session) => {
          const claimKey = (key: string, now: number, caller = 'c') =>
            session.run({
              type: 'requestKeys.claim',
              id: requestKey(key, caller),
              digest: 'd',
              now,
            });
          const complete = (key: string) =>
            session.run({
              type: 'requestKeys.complete',
              id: requestKey(key, 'c'),
              result: `r-${key}`,
            });
          await claimKey('k1', 1);
          await complete('k1');
          await claimKey('k2', 2);
          await complete('k2');
          assert.deepEqual(await claimKey('k3', 3), { kind: 'claimed' });
          // k1, the oldest, was evicted; k2 still replays.
          assert.deepEqual(await claimKey('k2', 4), {
            kind: 'replay',
            result: 'r-k2',
          });
          assert.deepEqual(await claimKey('k4', 5), { kind: 'claimed' });
          assert.deepEqual(await claimKey('k5', 6), {
            kind: 'capacity',
            scope: 'caller',
          });
          assert.deepEqual(await claimKey('k1', 7, 'other'), {
            kind: 'claimed',
          });
        },
        { limits: { requestKeyMaxRowsPerCaller: 2 } },
      ),
  },
  {
    name: 'request keys: the store-wide backstop refuses instead of evicting',
    areas: ['requestKeys'],
    run: (harness) =>
      withSession(
        harness,
        async (session) => {
          for (const caller of ['c1', 'c2'])
            assert.deepEqual(
              await session.run({
                type: 'requestKeys.claim',
                id: requestKey('k', caller),
                digest: 'd',
                now: 1,
              }),
              { kind: 'claimed' },
            );
          assert.deepEqual(
            await session.run({
              type: 'requestKeys.claim',
              id: requestKey('k', 'c3'),
              digest: 'd',
              now: 1,
            }),
            { kind: 'capacity', scope: 'store' },
          );
        },
        { limits: { requestKeyMaxRows: 2 } },
      ),
  },
];

/**
 * Crash points. Each one stops the "process" at a commit boundary, reopens
 * the location, and checks the decision the restarted process gets.
 */
const submit = (
  key: string,
  options: { inboxId?: string; digest?: string; now?: number } = {},
) =>
  ({
    type: 'inbox.submit',
    inboxId: options.inboxId ?? 'conversation',
    key,
    kind: 'follow-up',
    digest: options.digest ?? `digest-${key}`,
    payload: `payload-${key}`,
    now: options.now ?? 1,
  }) as const;

const claimNext = (placement = 'session-a', inboxId = 'conversation') =>
  ({ type: 'inbox.claimNext', inboxId, placement, now: 2 }) as const;

const settle = (
  key: string,
  to: 'placed' | 'unconfirmed' | 'refused',
  outcome: string | null = null,
) =>
  ({
    type: 'inbox.settle',
    inboxId: 'conversation',
    key,
    to,
    outcome,
    now: 3,
  }) as const;

async function inboxEntries(session: Session, inboxId = 'conversation') {
  const listed = await session.run({ type: 'inbox.list', inboxId });
  assert.equal(listed.kind, 'entries');
  return listed.kind === 'entries' ? listed.entries : [];
}

/** The `kind` and the entry's key and state, for compact assertions. */
function claimedKey(result: KernelResult<KernelCommand>): string {
  assert.ok('entry' in result, `expected an entry, got ${result.kind}`);
  const { entry } = result as { entry: { key: string; state: string } };
  return `${result.kind}:${entry.key}:${entry.state}`;
}

const inbox: KernelConformanceCase[] = [
  {
    name: 'inbox: a submission is idempotent by key, and a different digest conflicts',
    areas: ['inbox'],
    run: (harness) =>
      withSession(harness, async (session) => {
        const first = await session.run(submit('k'));
        assert.equal(first.kind, 'accepted');
        assert.equal(first.kind === 'accepted' && first.requeued, false);
        assert.equal(claimedKey(first), 'accepted:k:queued');
        const again = await session.run(submit('k', { now: 5 }));
        assert.equal(claimedKey(again), 'existing:k:queued');
        assert.deepEqual(await session.run(submit('k', { digest: 'other' })), {
          kind: 'conflict',
        });
        const entries = await inboxEntries(session);
        assert.equal(entries.length, 1);
        assert.equal(entries[0]?.payload, 'payload-k');
        assert.equal(entries[0]?.updatedAt, 1);
      }),
  },
  {
    name: 'inbox: the head is placed first, and one entry is in flight at a time',
    areas: ['inbox'],
    run: (harness) =>
      withSession(harness, async (session) => {
        await session.run(submit('a'));
        await session.run(submit('b'));
        assert.deepEqual(await session.run(claimNext('other', 'empty')), {
          kind: 'empty',
        });
        const claimed = await session.run(claimNext());
        assert.equal(claimedKey(claimed), 'claimed:a:placing');
        assert.equal(
          claimed.kind === 'claimed' && claimed.entry.placement,
          'session-a',
        );
        assert.equal(
          claimedKey(await session.run(claimNext())),
          'in-flight:a:placing',
        );
        assert.equal(
          (await session.run(settle('a', 'placed', 'turn-1'))).kind,
          'applied',
        );
        assert.equal(
          claimedKey(await session.run(claimNext())),
          'claimed:b:placing',
        );
        const entries = await inboxEntries(session);
        assert.deepEqual(
          entries.map((entry) => [entry.key, entry.state, entry.outcome]),
          [
            ['a', 'placed', 'turn-1'],
            ['b', 'placing', null],
          ],
        );
      }),
  },
  {
    name: 'inbox: only a placing entry settles or releases; release keeps the pin only when asked',
    areas: ['inbox'],
    run: (harness) =>
      withSession(harness, async (session) => {
        await session.run(submit('a'));
        assert.deepEqual(await session.run(settle('a', 'placed')), {
          kind: 'stale',
        });
        const release = (keepPlacement: boolean) =>
          session.run({
            type: 'inbox.release',
            inboxId: 'conversation',
            key: 'a',
            keepPlacement,
            now: 4,
          });
        assert.deepEqual(await release(false), { kind: 'stale' });
        await session.run(claimNext('session-a'));
        const kept = await release(true);
        assert.equal(kept.kind === 'applied' && kept.entry.state, 'queued');
        assert.equal(
          kept.kind === 'applied' && kept.entry.placement,
          'session-a',
        );
        // A pinned head keeps its own placement, not the claimant's.
        const reclaimed = await session.run(claimNext('session-b'));
        assert.equal(
          reclaimed.kind === 'claimed' && reclaimed.entry.placement,
          'session-a',
        );
        const cleared = await release(false);
        assert.equal(
          cleared.kind === 'applied' && cleared.entry.placement,
          null,
        );
        const fresh = await session.run(claimNext('session-b'));
        assert.equal(
          fresh.kind === 'claimed' && fresh.entry.placement,
          'session-b',
        );
        assert.equal(
          (await session.run(settle('a', 'refused', 'no'))).kind,
          'applied',
        );
        assert.deepEqual(await session.run(settle('a', 'placed')), {
          kind: 'stale',
        });
      }),
  },
  {
    name: 'inbox: an unconfirmed head blocks the inbox until it is cancelled',
    areas: ['inbox'],
    run: (harness) =>
      withSession(harness, async (session) => {
        await session.run(submit('a'));
        await session.run(submit('b'));
        await session.run(claimNext());
        await session.run(settle('a', 'unconfirmed'));
        assert.equal(
          claimedKey(await session.run(claimNext())),
          'blocked:a:unconfirmed',
        );
        const cancel = (key: string) =>
          session.run({
            type: 'inbox.cancel',
            inboxId: 'conversation',
            key,
            now: 9,
          });
        assert.equal(claimedKey(await cancel('a')), 'cancelled:a:cancelled');
        assert.equal(
          claimedKey(await session.run(claimNext())),
          'claimed:b:placing',
        );
      }),
  },
  {
    name: 'inbox: a refused entry does not block, and cancel answers by state',
    areas: ['inbox'],
    run: (harness) =>
      withSession(harness, async (session) => {
        const cancel = (key: string) =>
          session.run({
            type: 'inbox.cancel',
            inboxId: 'conversation',
            key,
            now: 9,
          });
        await session.run(submit('a'));
        await session.run(submit('b'));
        await session.run(submit('c'));
        await session.run(claimNext());
        await session.run(settle('a', 'refused', 'gone'));
        assert.equal(
          claimedKey(await session.run(claimNext())),
          'claimed:b:placing',
        );
        assert.equal(claimedKey(await cancel('b')), 'in-flight:b:placing');
        await session.run(settle('b', 'placed', 'turn'));
        assert.equal(claimedKey(await cancel('b')), 'placed:b:placed');
        assert.equal(claimedKey(await cancel('c')), 'cancelled:c:cancelled');
        assert.equal(claimedKey(await cancel('c')), 'cancelled:c:cancelled');
        assert.equal(claimedKey(await cancel('a')), 'cancelled:a:cancelled');
        assert.deepEqual(await cancel('missing'), { kind: 'missing' });
        assert.deepEqual(await session.run(claimNext()), { kind: 'empty' });
      }),
  },
  {
    name: 'inbox: a refused or cancelled key submitted again is queued again at the tail',
    areas: ['inbox'],
    run: (harness) =>
      withSession(harness, async (session) => {
        await session.run(submit('a'));
        await session.run(submit('b'));
        await session.run({
          type: 'inbox.cancel',
          inboxId: 'conversation',
          key: 'a',
          now: 3,
        });
        const again = await session.run(submit('a', { now: 4 }));
        assert.equal(again.kind === 'accepted' && again.requeued, true);
        assert.equal(claimedKey(again), 'accepted:a:queued');
        assert.equal(
          claimedKey(await session.run(claimNext())),
          'claimed:b:placing',
        );
        await session.run(settle('b', 'placed'));
        // A placed key is never queued again.
        assert.equal(
          claimedKey(await session.run(submit('b'))),
          'existing:b:placed',
        );
        assert.equal(
          claimedKey(await session.run(claimNext())),
          'claimed:a:placing',
        );
      }),
  },
  {
    name: 'inbox: an inbox past its unsettled limit refuses; settled entries do not count',
    areas: ['inbox'],
    run: (harness) =>
      withSession(
        harness,
        async (session) => {
          await session.run(submit('a'));
          await session.run(submit('b'));
          assert.deepEqual(await session.run(submit('c')), {
            kind: 'capacity',
            limit: 2,
          });
          // Another inbox has its own limit.
          assert.equal(
            (await session.run(submit('c', { inboxId: 'elsewhere' }))).kind,
            'accepted',
          );
          await session.run(claimNext());
          await session.run(settle('a', 'placed'));
          assert.equal((await session.run(submit('c'))).kind, 'accepted');
          assert.equal((await inboxEntries(session)).length, 3);
        },
        { limits: { inboxMaxUnsettled: 2 } },
      ),
  },
  {
    name: 'inbox: a settled entry past retention is forgotten on the next submit',
    areas: ['inbox'],
    run: (harness) =>
      withSession(
        harness,
        async (session) => {
          await session.run(submit('old', { now: 0 }));
          await session.run(submit('waiting', { now: 0 }));
          await session.run(claimNext());
          await session.run(settle('old', 'placed'));
          await session.run(submit('new', { now: 100 }));
          assert.deepEqual(
            (await inboxEntries(session)).map((entry) => entry.key),
            ['waiting', 'new'],
          );
        },
        { limits: { inboxSettledRetentionMs: 10 } },
      ),
  },
  {
    name: 'inbox: listOpen returns every unsettled entry of every inbox, in order',
    areas: ['inbox'],
    run: (harness) =>
      withSession(harness, async (session) => {
        await session.run(submit('z1', { inboxId: 'z' }));
        await session.run(submit('a1', { inboxId: 'a' }));
        await session.run(submit('a2', { inboxId: 'a' }));
        await session.run(submit('a3', { inboxId: 'a' }));
        await session.run(claimNext('s', 'a'));
        await session.run({
          type: 'inbox.settle',
          inboxId: 'a',
          key: 'a1',
          to: 'placed',
          outcome: null,
          now: 3,
        });
        await session.run({
          type: 'inbox.cancel',
          inboxId: 'a',
          key: 'a3',
          now: 3,
        });
        const open = await session.run({ type: 'inbox.listOpen' });
        assert.deepEqual(
          open.kind === 'entries'
            ? open.entries.map((entry) => `${entry.inboxId}/${entry.key}`)
            : [],
          ['a/a2', 'z/z1'],
        );
        assert.deepEqual(
          await session.run({ type: 'inbox.read', inboxId: 'a', key: 'nope' }),
          { kind: 'absent' },
        );
      }),
  },
  {
    name: 'inbox: only an unconfirmed entry is resolved, to placed or back to the queue',
    areas: ['inbox'],
    run: (harness) =>
      withSession(harness, async (session) => {
        const resolve = (key: string, to: 'placed' | 'queued') =>
          session.run({
            type: 'inbox.resolveUnconfirmed',
            inboxId: 'conversation',
            key,
            to,
            outcome: `{"by":"${to}"}`,
            now: 9,
          });
        await session.run(submit('a'));
        await session.run(submit('b'));
        assert.deepEqual(await resolve('a', 'placed'), { kind: 'stale' });
        await session.run(claimNext('session-a'));
        await session.run(settle('a', 'unconfirmed'));
        assert.equal(
          claimedKey(await session.run(claimNext())),
          'blocked:a:unconfirmed',
        );
        const requeued = await resolve('a', 'queued');
        assert.equal(
          requeued.kind === 'applied' && requeued.entry.placement,
          null,
        );
        assert.equal(
          claimedKey(await session.run(claimNext('session-b'))),
          'claimed:a:placing',
        );
        await session.run(settle('a', 'unconfirmed'));
        const placed = await resolve('a', 'placed');
        assert.equal(placed.kind === 'applied' && placed.entry.state, 'placed');
        assert.equal(
          claimedKey(await session.run(claimNext())),
          'claimed:b:placing',
        );
        assert.deepEqual(await resolve('missing', 'queued'), { kind: 'stale' });
      }),
  },
  {
    name: 'inbox: forget removes one inbox, settled entries included, and no other',
    areas: ['inbox'],
    run: (harness) =>
      withSession(harness, async (session) => {
        await session.run(submit('a'));
        await session.run(submit('b'));
        await session.run(claimNext());
        await session.run(settle('a', 'placed'));
        await session.run(submit('x', { inboxId: 'other' }));
        assert.deepEqual(
          await session.run({ type: 'inbox.forget', inboxId: 'conversation' }),
          { kind: 'applied', removed: 2 },
        );
        assert.deepEqual(await inboxEntries(session), []);
        assert.equal((await inboxEntries(session, 'other')).length, 1);
        // A forgotten key is new again.
        assert.equal(
          (await session.run(submit('a', { digest: 'new' }))).kind,
          'accepted',
        );
      }),
  },
];

const crashPoints: KernelConformanceCase[] = [
  {
    name: 'crash: the same inbox key submitted across a restart is one entry',
    areas: ['inbox'],
    run: (harness) =>
      withSession(harness, async (session) => {
        assert.equal((await session.run(submit('k'))).kind, 'accepted');
        await session.store.crash();
        await session.store.reopen();
        assert.equal(
          claimedKey(await session.run(submit('k', { now: 7 }))),
          'existing:k:queued',
        );
        assert.equal((await inboxEntries(session)).length, 1);
      }),
  },
  {
    name: 'crash: an inbox submit that never committed leaves nothing (control)',
    areas: ['inbox'],
    run: (harness) =>
      withSession(harness, async (session) => {
        session.store.failNextCommit();
        await assert.rejects(
          session.run(submit('k')),
          /Injected commit failure/,
        );
        await session.store.reopen();
        assert.deepEqual(await inboxEntries(session), []);
        assert.equal((await session.run(submit('k'))).kind, 'accepted');
      }),
  },
  {
    name: 'crash: an entry claimed before a crash is in flight after it, never claimed afresh',
    areas: ['inbox'],
    run: (harness) =>
      withSession(harness, async (session) => {
        await session.run(submit('a'));
        await session.run(submit('b'));
        await session.run(claimNext('session-a'));
        await session.store.crash();
        await session.store.reopen();
        const open = await session.run({ type: 'inbox.listOpen' });
        assert.deepEqual(
          open.kind === 'entries'
            ? open.entries.map((entry) => [
                entry.key,
                entry.state,
                entry.placement,
              ])
            : [],
          [
            ['a', 'placing', 'session-a'],
            ['b', 'queued', null],
          ],
        );
        assert.equal(
          claimedKey(await session.run(claimNext('session-b'))),
          'in-flight:a:placing',
        );
      }),
  },
  {
    name: 'crash: after a dedup claim is begun, the retry is indeterminate',
    areas: ['turnDedup'],
    run: (harness) =>
      withSession(harness, async (session) => {
        const first = session.processes.spawn();
        await session.run(claim('k', first));
        assert.deepEqual(
          await session.run({
            type: 'turnDedup.beginInvocation',
            key: 'k',
            ownerId: first.id,
            now: 1,
          }),
          { kind: 'applied' },
        );
        await session.store.crash();
        session.processes.kill(first);
        await session.store.reopen();
        const retry = session.processes.spawn();
        assert.deepEqual(await session.run(claim('k', retry)), {
          kind: 'indeterminate',
        });
        assert.deepEqual(
          await session.run({
            type: 'turnDedup.beginInvocation',
            key: 'k',
            ownerId: retry.id,
            now: 1,
          }),
          { kind: 'refused' },
        );
        assert.equal((await dedupRecord(session, 'k'))?.invocation, 'begun');
      }),
  },
  {
    name: 'crash: before a dedup begin commits, the retry reclaims (control)',
    areas: ['turnDedup'],
    run: (harness) =>
      withSession(harness, async (session) => {
        const first = session.processes.spawn();
        await session.run(claim('k', first));
        const held = session.store.holdNextCommit();
        const begin = session.run({
          type: 'turnDedup.beginInvocation',
          key: 'k',
          ownerId: first.id,
          now: 1,
        });
        assert.equal((await held.entered).type, 'turnDedup.beginInvocation');
        await session.store.crash();
        await assert.rejects(begin, KernelCrashError);
        session.processes.kill(first);
        await session.store.reopen();
        assert.deepEqual(
          await session.run(claim('k', session.processes.spawn())),
          { kind: 'claimed', reclaimed: true },
        );
      }),
  },
  {
    name: 'crash: a dedup begin whose commit failed leaves the claim pending',
    areas: ['turnDedup'],
    run: (harness) =>
      withSession(harness, async (session) => {
        const first = session.processes.spawn();
        await session.run(claim('k', first));
        session.store.failNextCommit();
        await assert.rejects(
          session.run({
            type: 'turnDedup.beginInvocation',
            key: 'k',
            ownerId: first.id,
            now: 1,
          }),
        );
        assert.equal((await dedupRecord(session, 'k'))?.invocation, 'pending');
        await session.store.crash();
        session.processes.kill(first);
        await session.store.reopen();
        assert.deepEqual(
          await session.run(claim('k', session.processes.spawn())),
          { kind: 'claimed', reclaimed: true },
        );
      }),
  },
  {
    name: 'crash: between prepared and invoking, recovery removes the row and frees the thread',
    areas: ['turnBoundary'],
    run: (harness) =>
      withSession(harness, async (session) => {
        const first = session.processes.spawn();
        await session.run(create('b1', 't', first, at(1)));
        const held = session.store.holdNextCommit();
        const invoking = session.run(
          transition('b1', first, ['prepared'], 'invoking', at(2)),
        );
        await held.entered;
        await session.store.crash();
        await assert.rejects(invoking, KernelCrashError);
        session.processes.kill(first);
        await session.store.reopen();
        const recovered = await reconcile(session, at(3));
        assert.deepEqual(recovered, {
          kind: 'reconciled',
          interrupted: [],
          resumable: [],
        });
        assert.deepEqual(await boundaries(session), []);
        assert.deepEqual(
          await session.run(
            create('b2', 't', session.processes.spawn(), at(4)),
          ),
          { kind: 'applied' },
        );
      }),
  },
  {
    name: 'crash: after invoking, recovery reports the turn indeterminate and holds the thread',
    areas: ['turnBoundary'],
    run: (harness) =>
      withSession(harness, async (session) => {
        const first = session.processes.spawn();
        const next = session.processes.spawn();
        await session.run(create('b1', 't', first, at(1)));
        await session.run(
          transition('b1', first, ['prepared'], 'invoking', at(2)),
        );
        await session.store.crash();
        session.processes.kill(first);
        await session.store.reopen();
        const recovered = await reconcile(session, at(3));
        assert.deepEqual(
          interruptedOf(recovered).map((row) => [row.boundaryId, row.state]),
          [['b1', 'indeterminate']],
        );
        assert.deepEqual(await session.run(create('b2', 't', next, at(4))), {
          kind: 'busy',
        });
        assert.deepEqual(
          await session.run({
            type: 'turnBoundary.remove',
            boundaryId: 'b1',
            ownerId: first.id,
            from: ['indeterminate'],
          }),
          { kind: 'applied' },
        );
        assert.deepEqual(await session.run(create('b2', 't', next, at(5))), {
          kind: 'applied',
        });
      }),
  },
  {
    name: 'crash: before an acceptance commits, recovery reports indeterminate, not accepted',
    areas: ['turnBoundary'],
    run: (harness) =>
      withSession(harness, async (session) => {
        const first = session.processes.spawn();
        await session.run(create('b1', 't', first, at(1)));
        await session.run(
          transition('b1', first, ['prepared'], 'invoking', at(2)),
        );
        const held = session.store.holdNextCommit();
        const accepted = session.run(
          transition('b1', first, ['invoking'], 'accepted', at(3), 'p1'),
        );
        await held.entered;
        await session.store.crash();
        await assert.rejects(accepted, KernelCrashError);
        session.processes.kill(first);
        await session.store.reopen();
        const recovered = await reconcile(session, at(4));
        const [row] = interruptedOf(recovered);
        assert.equal(row?.state, 'indeterminate');
        assert.equal(row?.providerTurnId, undefined);
      }),
  },
  {
    name: 'crash: a request key whose attempt recorded its decision is re-driven with it',
    areas: ['requestKeys'],
    run: (harness) =>
      withSession(harness, async (session) => {
        const id = requestKey('k');
        await session.run({
          type: 'requestKeys.claim',
          id,
          digest: 'd',
          now: 1,
        });
        await session.run({
          type: 'requestKeys.recordDecision',
          id,
          decision: 'deliver',
        });
        await session.store.crash();
        await session.store.reopen();
        assert.deepEqual(
          await session.run({
            type: 'requestKeys.claim',
            id,
            digest: 'd',
            now: 2,
          }),
          { kind: 'unresolved', decision: 'deliver' },
        );
      }),
  },
  {
    name: 'crash: a request key whose decision never committed is unresolved without one',
    areas: ['requestKeys'],
    run: (harness) =>
      withSession(harness, async (session) => {
        const id = requestKey('k');
        await session.run({
          type: 'requestKeys.claim',
          id,
          digest: 'd',
          now: 1,
        });
        const held = session.store.holdNextCommit();
        const decision = session.run({
          type: 'requestKeys.recordDecision',
          id,
          decision: 'deliver',
        });
        await held.entered;
        await session.store.crash();
        await assert.rejects(decision, KernelCrashError);
        await session.store.reopen();
        assert.deepEqual(
          await session.run({
            type: 'requestKeys.claim',
            id,
            digest: 'd',
            now: 2,
          }),
          { kind: 'unresolved' },
        );
      }),
  },
];

crashPoints.push(
  {
    name: 'crash: a reconcile whose commit failed changes no row',
    areas: ['turnBoundary'],
    run: (harness) =>
      withSession(harness, async (session) => {
        const dead = session.processes.spawn();
        await session.run(create('p', 't1', dead, at(1)));
        await session.run(create('i', 't2', dead, at(1)));
        await session.run(
          transition('i', dead, ['prepared'], 'invoking', at(2)),
        );
        session.processes.kill(dead);
        session.store.failNextCommit();
        await assert.rejects(reconcile(session, at(3)));
        await session.store.reopen();
        assert.deepEqual(
          (await boundaries(session)).map((row) => [row.boundaryId, row.state]),
          [
            ['i', 'invoking'],
            ['p', 'prepared'],
          ],
        );
        const recovered = await reconcile(session, at(4));
        assert.deepEqual(
          interruptedOf(recovered).map((row) => [row.boundaryId, row.state]),
          [['i', 'indeterminate']],
        );
      }),
  },
  {
    name: 'crash: a terminal whose commit failed neither retires the row nor records the fact',
    areas: ['turnBoundary'],
    run: (harness) =>
      withSession(harness, async (session) => {
        const a = session.processes.spawn();
        await session.run(recordAccepted('a1', 't', 'p1', a, at(1)));
        const observe = {
          type: 'turnBoundary.observeTerminal',
          threadId: 't',
          providerTurnId: 'p1',
          sessionTerminal: false,
          terminalCreatedAt: at(2),
        } as const;
        session.store.failNextCommit();
        await assert.rejects(session.run(observe));
        await session.store.reopen();
        assert.equal((await boundary(session, 'a1'))?.state, 'accepted');
        // The fact was not recorded either: once a1 is gone, accepting p1 on
        // a new row of the same thread is not ambiguous.
        await session.run({
          type: 'turnBoundary.remove',
          boundaryId: 'a1',
          ownerId: a.id,
          from: ['accepted'],
        });
        await session.run(create('b', 't', a, at(3)));
        await session.run(transition('b', a, ['prepared'], 'invoking', at(4)));
        assert.deepEqual(
          await session.run(
            transition('b', a, ['invoking'], 'accepted', at(5), 'p1'),
          ),
          { kind: 'applied' },
        );
        await session.run({ ...observe, terminalCreatedAt: at(6) });
        assert.equal(await boundary(session, 'b'), undefined);
      }),
  },
);

/** Invocation terminal contracts share the real public command boundary. */
const invocationTerminals: readonly KernelConformanceCase[] = [
  {
    name: 'invocation terminal: engine-opened acknowledgement refuses an otherwise matching accepted intent row',
    areas: ['turnBoundary'],
    run: (harness) =>
      withSession(harness, async (session) => {
        const owner = session.processes.spawn();
        const intent = {
          invocationId: 'B',
          inputDigest: 'input',
          intentDigest: 'envelope',
          bodyRef: 'body',
        };
        assert.deepEqual(
          await session.run(create('b', 't', owner, at(10), 'reserved')),
          { kind: 'applied' },
        );
        assert.deepEqual(
          await session.run({
            type: 'turnBoundary.prepare',
            boundaryId: 'b',
            ownerId: owner.id,
            intent,
            now: at(11),
          }),
          { kind: 'applied' },
        );
        assert.deepEqual(
          await session.run({
            type: 'turnBoundary.beginInvocation',
            boundaryId: 'b',
            ownerId: owner.id,
            intent,
            now: at(12),
          }),
          { kind: 'applied' },
        );
        const expected = await boundary(session, 'b');
        assert.ok(expected);
        assert.deepEqual(
          await session.run({
            type: 'turnBoundary.acceptInvocation',
            expected,
            providerTurnId: 'N',
            now: at(13),
          }),
          { kind: 'accepted' },
        );
        const accepted = await boundary(session, 'b');
        assert.deepEqual(accepted, {
          ...expected,
          state: 'accepted',
          providerTurnId: 'N',
          updatedAt: at(13),
        });
        assert.deepEqual(
          await session.run(recordAccepted('b', 't', 'N', owner, at(13))),
          { kind: 'busy' },
        );
        assert.deepEqual(await boundary(session, 'b'), accepted);
        assert.deepEqual(
          await session.run(
            recordAccepted('legacy', 'legacy-thread', 'N', owner, at(13)),
          ),
          { kind: 'applied' },
        );
        const legacy = await boundary(session, 'legacy');
        assert.deepEqual(
          await session.run(
            recordAccepted('legacy', 'legacy-thread', 'N', owner, at(13)),
          ),
          { kind: 'applied' },
        );
        assert.deepEqual(await boundary(session, 'legacy'), legacy);
      }),
  },

  {
    name: 'invocation terminal: early backward-clock retirement survives reopen and exact ownership retries',
    areas: ['turnBoundary', 'turnDedup'],
    run: (harness) =>
      withSession(harness, async (session) => {
        const owner = session.processes.spawn();
        const dedupOwner = session.processes.spawn();
        const intent = {
          invocationId: 'B',
          inputDigest: 'input',
          intentDigest: 'envelope',
          bodyRef: 'opaque:body',
          dedupKey: 'k',
        };
        assert.deepEqual(await session.run(claim('k', dedupOwner)), {
          kind: 'claimed',
          reclaimed: false,
        });
        assert.deepEqual(
          await session.run(create('b', 't', owner, at(10), 'reserved')),
          { kind: 'applied' },
        );
        assert.deepEqual(
          await session.run({
            type: 'turnBoundary.prepare',
            boundaryId: 'b',
            ownerId: owner.id,
            dedupOwnerId: dedupOwner.id,
            intent,
            now: at(11),
          }),
          { kind: 'applied' },
        );
        assert.deepEqual(
          await session.run({
            type: 'turnBoundary.beginInvocation',
            boundaryId: 'b',
            ownerId: owner.id,
            dedupOwnerId: dedupOwner.id,
            intent,
            now: at(12),
          }),
          { kind: 'applied' },
        );
        const expected: TurnBoundaryRecord = {
          boundaryId: 'b',
          threadId: 't',
          purpose: 'turn',
          state: 'invoking',
          owner,
          createdAt: at(10),
          updatedAt: at(12),
          intent,
        };
        const dedup = await session.run({ type: 'turnDedup.read', key: 'k' });
        assert.equal(dedup.kind, 'found');
        if (dedup.kind !== 'found') throw new Error('begun dedup prerequisite');
        const command = {
          type: 'turnBoundary.acceptInvocation',
          expected,
          expectedDedup: dedup.record,
          providerTurnId: 'N',
          now: at(13),
        } as const;
        const terminal = {
          threadId: 't',
          invocationId: 'B',
          terminalEventId: 'eB',
          terminalCreatedAt: at(1),
          retire: true,
        };
        assert.deepEqual(
          await session.run({
            type: 'turnBoundary.observeTerminal',
            ...terminal,
            sessionTerminal: false,
          }),
          { kind: 'applied' },
        );
        assert.equal(await boundary(session, 'b'), undefined);
        await session.store.reopen();
        assert.deepEqual(await session.run(command), {
          kind: 'terminal',
          terminal,
        });
        assert.deepEqual(await session.run(command), {
          kind: 'terminal',
          terminal,
        });
        const changes: TurnBoundaryRecord[] = [
          { ...expected, owner: { ...owner, id: 'other' } },
          { ...expected, owner: { ...owner, pid: owner.pid + 1 } },
          {
            ...expected,
            owner: {
              id: owner.id,
              pid: owner.pid,
              identityKind: 'exact',
              birth: 'other',
            },
          },
          { ...expected, createdAt: at(9) },
          { ...expected, updatedAt: at(11) },
          { ...expected, createdSequence: 7 },
          { ...expected, providerTurnId: 'N' },
          { ...expected, boundaryId: 'other' },
          { ...expected, threadId: 'other' },
          ...['invocationId', 'inputDigest', 'intentDigest', 'bodyRef'].map(
            (field) => ({
              ...expected,
              intent: { ...intent, [field]: 'changed' },
            }),
          ),
        ];
        for (const changed of changes)
          assert.deepEqual(
            await session.run({ ...command, expected: changed }),
            { kind: 'stale' },
          );
        for (const changed of [
          { ...dedup.record, createdAt: 9 },
          { ...dedup.record, preparedUpdatedAt: at(9) },
          { ...dedup.record, owner: { ...dedupOwner, id: 'other' } },
          { ...dedup.record, invocation: 'pending' as const },
          { ...dedup.record, value: 'N' },
        ])
          assert.deepEqual(
            await session.run({ ...command, expectedDedup: changed }),
            { kind: 'stale' },
          );
        assert.deepEqual(
          await session.run({
            type: 'turnDedup.resolve',
            key: 'k',
            ownerId: dedupOwner.id,
            value: 'N',
            now: 20,
          }),
          { kind: 'applied' },
        );
        assert.deepEqual(await session.run(command), {
          kind: 'terminal',
          terminal,
        });
        assert.deepEqual(
          await session.run({ type: 'turnDedup.forgetPrefix', prefix: 'k' }),
          { kind: 'applied', removed: 1 },
        );
        assert.deepEqual(await session.run(command), { kind: 'stale' });
      }),
  },
  {
    name: 'invocation terminal: old and untagged native facts cannot retire or make a new invocation ambiguous',
    areas: ['turnBoundary'],
    run: (harness) =>
      withSession(harness, async (session) => {
        const owner = session.processes.spawn();
        const intent = {
          invocationId: 'B',
          inputDigest: 'input',
          intentDigest: 'envelope',
          bodyRef: 'body',
        };
        const prior = { ...intent, invocationId: 'A' };
        assert.deepEqual(
          await session.run(create('a', 't', owner, at(1), 'reserved')),
          { kind: 'applied' },
        );
        assert.deepEqual(
          await session.run({
            type: 'turnBoundary.prepare',
            boundaryId: 'a',
            ownerId: owner.id,
            intent: prior,
            now: at(2),
          }),
          { kind: 'applied' },
        );
        assert.deepEqual(
          await session.run({
            type: 'turnBoundary.beginInvocation',
            boundaryId: 'a',
            ownerId: owner.id,
            intent: prior,
            now: at(3),
          }),
          { kind: 'applied' },
        );
        const priorExpected = await boundary(session, 'a');
        assert.ok(priorExpected);
        assert.deepEqual(
          await session.run({
            type: 'turnBoundary.acceptInvocation',
            expected: priorExpected,
            providerTurnId: 'N',
            now: at(4),
          }),
          { kind: 'accepted' },
        );
        assert.deepEqual(
          await session.run({
            type: 'turnBoundary.observeTerminal',
            threadId: 't',
            invocationId: 'A',
            terminalEventId: 'eA',
            providerTurnId: 'N',
            terminalCreatedAt: at(59),
            sessionTerminal: false,
          }),
          { kind: 'applied' },
        );
        assert.equal(await boundary(session, 'a'), undefined);
        assert.deepEqual(
          await session.run(create('b', 't', owner, at(10), 'reserved')),
          { kind: 'applied' },
        );
        assert.deepEqual(
          await session.run({
            type: 'turnBoundary.prepare',
            boundaryId: 'b',
            ownerId: owner.id,
            intent,
            now: at(11),
          }),
          { kind: 'applied' },
        );
        assert.deepEqual(
          await session.run({
            type: 'turnBoundary.beginInvocation',
            boundaryId: 'b',
            ownerId: owner.id,
            intent,
            now: at(12),
          }),
          { kind: 'applied' },
        );
        const expected = await boundary(session, 'b');
        assert.ok(expected);
        for (const extra of [
          { invocationId: 'A', terminalEventId: 'eA' },
          {},
        ]) {
          assert.deepEqual(
            await session.run({
              type: 'turnBoundary.observeTerminal',
              threadId: 't',
              providerTurnId: 'N',
              terminalCreatedAt: at(59),
              sessionTerminal: false,
              ...extra,
            }),
            { kind: 'applied' },
          );
          assert.deepEqual(await boundary(session, 'b'), expected);
        }
        const command = {
          type: 'turnBoundary.acceptInvocation',
          expected,
          providerTurnId: 'N',
          now: at(13),
        } as const;
        assert.deepEqual(await session.run(command), { kind: 'accepted' });
        const accepted = await boundary(session, 'b');
        assert.deepEqual(accepted, {
          ...expected,
          state: 'accepted',
          providerTurnId: 'N',
          updatedAt: at(13),
        });
        for (const extra of [
          { invocationId: 'A', terminalEventId: 'eA' },
          {},
        ]) {
          assert.deepEqual(
            await session.run({
              type: 'turnBoundary.observeTerminal',
              threadId: 't',
              providerTurnId: 'N',
              terminalCreatedAt: at(59),
              sessionTerminal: false,
              ...extra,
            }),
            { kind: 'applied' },
          );
          assert.deepEqual(await boundary(session, 'b'), accepted);
        }
        await session.store.reopen();
        assert.deepEqual(await session.run(command), { kind: 'accepted' });
        assert.deepEqual(
          await session.run({
            type: 'turnBoundary.observeTerminal',
            threadId: 't',
            invocationId: 'B',
            terminalEventId: 'e0',
            terminalCreatedAt: at(1),
            sessionTerminal: false,
          }),
          { kind: 'applied' },
        );
        assert.deepEqual(await boundary(session, 'b'), accepted);
        assert.deepEqual(await session.run(command), { kind: 'accepted' });
        const terminal = {
          threadId: 't',
          invocationId: 'B',
          providerTurnId: 'N',
          terminalEventId: 'eN',
          terminalCreatedAt: at(1),
          retire: true,
        };
        assert.deepEqual(
          await session.run({
            type: 'turnBoundary.observeTerminal',
            ...terminal,
            sessionTerminal: false,
          }),
          { kind: 'applied' },
        );
        assert.equal(await boundary(session, 'b'), undefined);
        await session.store.reopen();
        assert.deepEqual(await session.run(command), {
          kind: 'terminal',
          terminal,
        });
        assert.deepEqual(await session.run({ ...command, now: at(14) }), {
          kind: 'stale',
        });
        assert.deepEqual(
          await session.run({
            type: 'turnBoundary.observeTerminal',
            ...terminal,
            terminalEventId: 'eM',
            providerTurnId: 'M',
            sessionTerminal: false,
          }),
          { kind: 'applied' },
        );
        assert.deepEqual(await session.run(command), { kind: 'stale' });
        assert.equal(await boundary(session, 'b'), undefined);
      }),
  },
  {
    name: 'invocation terminal: keyless prepared guard, generic acceptance refusal and conservative E=Q precedence',
    areas: ['turnBoundary'],
    run: (harness) =>
      withSession(harness, async (session) => {
        const owner = session.processes.spawn();
        const intent = {
          invocationId: 'B',
          inputDigest: 'input',
          intentDigest: 'envelope',
          bodyRef: 'body',
        };
        assert.deepEqual(
          await session.run(create('b', 't', owner, at(10), 'reserved')),
          { kind: 'applied' },
        );
        assert.deepEqual(
          await session.run({
            type: 'turnBoundary.prepare',
            boundaryId: 'b',
            ownerId: owner.id,
            intent,
            now: at(11),
          }),
          { kind: 'applied' },
        );
        const prepared = await boundary(session, 'b');
        assert.deepEqual(
          await session.run({
            type: 'turnBoundary.observeTerminal',
            threadId: 't',
            invocationId: 'B',
            terminalEventId: 'prepared',
            providerTurnId: 'N',
            terminalCreatedAt: at(59),
            sessionTerminal: false,
          }),
          { kind: 'applied' },
        );
        assert.deepEqual(await boundary(session, 'b'), prepared);
        assert.deepEqual(
          await session.run({
            type: 'turnBoundary.beginInvocation',
            boundaryId: 'b',
            ownerId: owner.id,
            intent,
            now: at(12),
          }),
          { kind: 'applied' },
        );
        assert.deepEqual(
          await session.run(
            transition('b', owner, ['invoking'], 'accepted', at(13), 'N'),
          ),
          { kind: 'stale' },
        );
        assert.deepEqual(
          await session.run(
            transition('b', owner, ['invoking'], 'indeterminate', at(14), 'N'),
          ),
          { kind: 'applied' },
        );
        const expected = await boundary(session, 'b');
        assert.ok(expected);
        // A distinct invocation isolates image precedence from the prepared event above.
        assert.deepEqual(
          await session.run({
            type: 'turnBoundary.forgetThread',
            threadId: 't',
          }),
          { kind: 'applied' },
        );
        assert.deepEqual(
          await session.run(create('b', 't', owner, at(10), 'reserved')),
          { kind: 'applied' },
        );
        assert.deepEqual(
          await session.run({
            type: 'turnBoundary.prepare',
            boundaryId: 'b',
            ownerId: owner.id,
            intent,
            now: at(11),
          }),
          { kind: 'applied' },
        );
        assert.deepEqual(
          await session.run({
            type: 'turnBoundary.beginInvocation',
            boundaryId: 'b',
            ownerId: owner.id,
            intent,
            now: at(12),
          }),
          { kind: 'applied' },
        );
        assert.deepEqual(
          await session.run(
            transition('b', owner, ['invoking'], 'indeterminate', at(14), 'N'),
          ),
          { kind: 'applied' },
        );
        const command = {
          type: 'turnBoundary.acceptInvocation',
          expected,
          providerTurnId: 'N',
          now: at(14),
        } as const;
        assert.deepEqual(await session.run(command), { kind: 'ambiguous' });
        assert.deepEqual(await session.run(command), { kind: 'ambiguous' });
        assert.deepEqual(await boundary(session, 'b'), expected);
        assert.deepEqual(
          await session.run({
            type: 'turnBoundary.observeTerminal',
            threadId: 't',
            invocationId: 'B',
            providerTurnId: 'N',
            terminalEventId: 'e',
            terminalCreatedAt: at(1),
            sessionTerminal: false,
          }),
          { kind: 'applied' },
        );
        assert.equal(await boundary(session, 'b'), undefined);
        assert.equal((await session.run(command)).kind, 'terminal');
      }),
  },
  {
    name: 'invocation terminal: a real simultaneous accepted collision stays ambiguous after competitor removal',
    areas: ['turnBoundary'],
    run: (harness) =>
      withSession(harness, async (session) => {
        const owner = session.processes.spawn();
        assert.deepEqual(
          await session.run(recordAccepted('other', 't', 'N', owner, at(1))),
          { kind: 'applied' },
        );
        const intent = {
          invocationId: 'B',
          inputDigest: 'input',
          intentDigest: 'envelope',
          bodyRef: 'body',
        };
        assert.deepEqual(
          await session.run(create('b', 't', owner, at(10), 'reserved')),
          { kind: 'applied' },
        );
        assert.deepEqual(
          await session.run({
            type: 'turnBoundary.prepare',
            boundaryId: 'b',
            ownerId: owner.id,
            intent,
            now: at(11),
          }),
          { kind: 'applied' },
        );
        assert.deepEqual(
          await session.run({
            type: 'turnBoundary.beginInvocation',
            boundaryId: 'b',
            ownerId: owner.id,
            intent,
            now: at(12),
          }),
          { kind: 'applied' },
        );
        const expected = await boundary(session, 'b');
        assert.ok(expected);
        const command = {
          type: 'turnBoundary.acceptInvocation',
          expected,
          providerTurnId: 'N',
          now: at(13),
        } as const;
        assert.deepEqual(await session.run(command), { kind: 'ambiguous' });
        const ambiguous = await boundary(session, 'b');
        assert.deepEqual(
          await session.run({
            type: 'turnBoundary.remove',
            boundaryId: 'other',
            ownerId: owner.id,
            from: ['accepted'],
          }),
          { kind: 'applied' },
        );
        await session.store.reopen();
        assert.deepEqual(await session.run(command), { kind: 'ambiguous' });
        assert.deepEqual(await boundary(session, 'b'), ambiguous);
      }),
  },
];

const steerReceipts: readonly KernelConformanceCase[] = [
  {
    name: 'steer receipts: malformed Unicode cannot read, claim, confirm or erase a replacement identity',
    areas: ['steerReceipts'],
    run: (harness) =>
      withSession(harness, async (session) => {
        const key = {
          threadId: '\ufffd',
          clientInputId: '\ufffd',
          inputDigest: '\ufffd',
        };
        for (const field of [
          'threadId',
          'clientInputId',
          'inputDigest',
        ] as const) {
          await assert.rejects(
            session.run({
              type: 'steerReceipts.claim',
              ...key,
              [field]: '\ud800',
            }),
            /well-formed Unicode/,
          );
          assert.deepEqual(
            await session.run({ type: 'steerReceipts.read', ...key }),
            { kind: 'absent' },
          );
        }
        await session.run({ type: 'steerReceipts.claim', ...key });
        for (const field of [
          'threadId',
          'clientInputId',
          'inputDigest',
        ] as const) {
          await assert.rejects(
            session.run({
              type: 'steerReceipts.read',
              ...key,
              [field]: '\udc00',
            }),
            /well-formed Unicode/,
          );
          await assert.rejects(
            session.run({
              type: 'steerReceipts.confirm',
              ...key,
              [field]: '\ud800',
              confirmedTurnId: 'turn',
            }),
            /well-formed Unicode/,
          );
        }
        await assert.rejects(
          session.run({
            type: 'steerReceipts.confirm',
            ...key,
            confirmedTurnId: '\udc00',
          }),
          /well-formed Unicode/,
        );
        await assert.rejects(
          session.run({
            type: 'steerReceipts.forgetThread',
            threadId: '\ud800',
          }),
          /well-formed Unicode/,
        );
        await session.store.reopen();
        assert.deepEqual(
          await session.run({ type: 'steerReceipts.read', ...key }),
          { kind: 'indeterminate' },
        );
      }),
  },
  {
    name: 'steer receipts: valid Unicode and NUL survive without normalization',
    areas: ['steerReceipts'],
    run: (harness) =>
      withSession(harness, async (session) => {
        const key = {
          threadId: 'e\u0301\0🙂',
          clientInputId: '你好\0🙂',
          inputDigest: 'digest\0🙂',
        };
        const other = { ...key, threadId: 'é\0🙂' };
        for (const input of [key, other])
          assert.deepEqual(
            await session.run({ type: 'steerReceipts.claim', ...input }),
            { kind: 'claimed' },
          );
        assert.deepEqual(
          await session.run({
            type: 'steerReceipts.confirm',
            ...key,
            confirmedTurnId: 'turn\0🙂',
          }),
          { kind: 'applied' },
        );
        await session.store.reopen();
        assert.deepEqual(
          await session.run({ type: 'steerReceipts.read', ...key }),
          { kind: 'confirmed', turnId: 'turn\0🙂' },
        );
        assert.deepEqual(
          await session.run({
            type: 'steerReceipts.forgetThread',
            threadId: key.threadId,
          }),
          { kind: 'applied', removed: 1 },
        );
        assert.deepEqual(
          await session.run({ type: 'steerReceipts.read', ...other }),
          { kind: 'indeterminate' },
        );
      }),
  },

  {
    name: 'steer receipts: pending and confirmed identity survive reopen without reclaim',
    areas: ['steerReceipts'],
    run: (harness) =>
      withSession(harness, async (session) => {
        const key = {
          threadId: 'thread',
          clientInputId: 'input',
          inputDigest: 'digest-a',
        };
        assert.deepEqual(
          await session.run({ type: 'steerReceipts.read', ...key }),
          { kind: 'absent' },
        );
        assert.deepEqual(
          await session.run({ type: 'steerReceipts.claim', ...key }),
          { kind: 'claimed' },
        );
        await session.store.reopen();
        assert.deepEqual(
          await session.run({ type: 'steerReceipts.read', ...key }),
          { kind: 'indeterminate' },
        );
        assert.deepEqual(
          await session.run({ type: 'steerReceipts.claim', ...key }),
          { kind: 'occupied' },
        );
        assert.deepEqual(
          await session.run({
            type: 'steerReceipts.confirm',
            ...key,
            inputDigest: 'digest-b',
            confirmedTurnId: 'wrong',
          }),
          { kind: 'stale' },
        );
        assert.deepEqual(
          await session.run({
            type: 'steerReceipts.confirm',
            ...key,
            confirmedTurnId: 'turn',
          }),
          { kind: 'applied' },
        );
        await session.store.reopen();
        assert.deepEqual(
          await session.run({ type: 'steerReceipts.read', ...key }),
          { kind: 'confirmed', turnId: 'turn' },
        );
        assert.deepEqual(
          await session.run({
            type: 'steerReceipts.read',
            ...key,
            inputDigest: 'digest-b',
          }),
          { kind: 'indeterminate' },
        );
        assert.deepEqual(
          await session.run({
            type: 'steerReceipts.confirm',
            ...key,
            confirmedTurnId: 'replacement',
          }),
          { kind: 'stale' },
        );
        assert.deepEqual(
          await session.run({
            type: 'steerReceipts.claim',
            ...key,
            inputDigest: 'digest-b',
          }),
          { kind: 'occupied' },
        );
        assert.deepEqual(
          await session.run({ type: 'steerReceipts.read', ...key }),
          { kind: 'confirmed', turnId: 'turn' },
        );
      }),
  },
  {
    name: 'steer receipts: failed writes roll back and forgetting is thread scoped',
    areas: ['steerReceipts'],
    run: (harness) =>
      withSession(harness, async (session) => {
        const key = {
          threadId: 'thread',
          clientInputId: 'input',
          inputDigest: 'digest',
        };
        session.store.failNextCommit(new KernelCrashError());
        await assert.rejects(
          session.run({ type: 'steerReceipts.claim', ...key }),
          KernelCrashError,
        );
        await session.store.reopen();
        assert.deepEqual(
          await session.run({ type: 'steerReceipts.read', ...key }),
          { kind: 'absent' },
        );
        await session.run({ type: 'steerReceipts.claim', ...key });
        await session.run({
          type: 'steerReceipts.claim',
          ...key,
          threadId: 'other',
        });
        session.store.failNextCommit(new KernelCrashError());
        await assert.rejects(
          session.run({
            type: 'steerReceipts.confirm',
            ...key,
            confirmedTurnId: 'turn',
          }),
          KernelCrashError,
        );
        await session.store.reopen();
        assert.deepEqual(
          await session.run({ type: 'steerReceipts.read', ...key }),
          { kind: 'indeterminate' },
        );
        assert.deepEqual(
          await session.run({
            type: 'steerReceipts.forgetThread',
            threadId: 'thread',
          }),
          { kind: 'applied', removed: 1 },
        );
        await session.store.reopen();
        assert.deepEqual(
          await session.run({ type: 'steerReceipts.read', ...key }),
          { kind: 'absent' },
        );
        assert.deepEqual(
          await session.run({
            type: 'steerReceipts.read',
            ...key,
            threadId: 'other',
          }),
          { kind: 'indeterminate' },
        );
      }),
  },
];

export const kernelConformanceCases: readonly KernelConformanceCase[] =
  Object.freeze([
    ...durability,
    ...steerReceipts,
    ...turnDedup,
    ...turnBoundary,
    ...requestKeys,
    ...inbox,
    ...crashPoints,
    ...invocationTerminals,
  ]);

/**
 * The cases that use only the given machines, for a storage that keeps only
 * those (a host that binds its own tables for them and has no turn boundaries,
 * say). An adapter that keeps every machine runs every case.
 */
export function kernelConformanceCasesFor(
  areas: readonly KernelConformanceArea[],
): readonly KernelConformanceCase[] {
  return kernelConformanceCases.filter((entry) =>
    entry.areas.every((area) => areas.includes(area)),
  );
}

export interface KernelConformanceOutcome {
  readonly name: string;
  readonly error?: unknown;
}

/** Run every case without a test runner; failures are returned, not thrown. */
export async function runKernelConformance(
  harness: KernelStorageHarness,
  cases: readonly KernelConformanceCase[] = kernelConformanceCases,
): Promise<KernelConformanceOutcome[]> {
  const outcomes: KernelConformanceOutcome[] = [];
  for (const entry of cases) {
    try {
      await entry.run(harness);
      outcomes.push({ name: entry.name });
    } catch (error) {
      outcomes.push({ name: entry.name, error });
    }
  }
  return outcomes;
}

/**
 * The shape Vitest, Jest and `node:test` share. With Vitest:
 *
 * ```ts
 * import { describe, it } from 'vitest';
 * registerKernelConformance({ describe, it }, myHarness);
 * ```
 */
export interface KernelConformanceRunner {
  describe(name: string, body: () => void): unknown;
  it(name: string, body: () => Promise<void>): unknown;
}

export function registerKernelConformance(
  runner: KernelConformanceRunner,
  harness: KernelStorageHarness,
  cases: readonly KernelConformanceCase[] = kernelConformanceCases,
): void {
  runner.describe(`monument conformance: ${harness.name}`, () => {
    for (const entry of cases) runner.it(entry.name, () => entry.run(harness));
  });
}
