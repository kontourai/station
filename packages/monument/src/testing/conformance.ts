import assert from 'node:assert/strict';
import type { KernelCommand, KernelResult } from '../commands.js';
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
export interface KernelConformanceCase {
  readonly name: string;
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
  state: 'lifecycle' | 'prepared' = 'prepared',
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

function interruptedOf(
  result: KernelResult<{ type: 'turnBoundary.reconcile'; now: string }>,
): readonly TurnBoundaryRecord[] {
  assert.equal(result.kind, 'reconciled');
  return result.kind === 'reconciled' ? result.interrupted : [];
}

async function dedupRecord(session: Session, key: string) {
  const read = await session.run({ type: 'turnDedup.read', key });
  return read.kind === 'found' ? read.record : undefined;
}

const durability: KernelConformanceCase[] = [
  {
    name: 'durability: a committed command survives reopen',
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
    name: 'turn dedup: one owner per key; only the owner settles; a resolved key replays',
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
            value: 'x',
          }),
          { kind: 'stale' },
        );
        assert.deepEqual(
          await session.run({
            type: 'turnDedup.resolve',
            key: 'k',
            ownerId: a.id,
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
            value: 'turn-1',
          }),
          { kind: 'applied' },
        );
        assert.deepEqual(
          await session.run({
            type: 'turnDedup.resolve',
            key: 'k',
            ownerId: a.id,
            value: 'turn-2',
          }),
          { kind: 'stale' },
        );
        assert.deepEqual(
          await session.run({
            type: 'turnDedup.release',
            key: 'k',
            ownerId: a.id,
          }),
          { kind: 'stale' },
        );
      }),
  },
  {
    name: 'turn dedup: a released claim can be claimed again',
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
    run: (harness) =>
      withSession(harness, async (session) => {
        const a = session.processes.spawn();
        const b = session.processes.spawn();
        const begin = (key: string, owner: OwnerIdentity) =>
          session.run({
            type: 'turnDedup.beginInvocation',
            key,
            ownerId: owner.id,
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
          value: 't',
        });
        assert.deepEqual(await begin('k', a), { kind: 'refused' });
      }),
  },
  {
    name: 'turn dedup: a dead owner is reclaimed only if it never began its effect',
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
    name: 'turn dedup: forgetPrefix is an exact prefix match',
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
        const first = await session.run({
          type: 'turnBoundary.reconcile',
          now: at(10),
        });
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
        const second = await session.run({
          type: 'turnBoundary.reconcile',
          now: at(11),
        });
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

const requestKeys: KernelConformanceCase[] = [
  {
    name: 'request keys: same digest replays or re-drives; a different digest conflicts',
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
    name: 'request keys: a caller over quota evicts only its own oldest completed rows',
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
const crashPoints: KernelConformanceCase[] = [
  {
    name: 'crash: after a dedup claim is begun, the retry is indeterminate',
    run: (harness) =>
      withSession(harness, async (session) => {
        const first = session.processes.spawn();
        await session.run(claim('k', first));
        assert.deepEqual(
          await session.run({
            type: 'turnDedup.beginInvocation',
            key: 'k',
            ownerId: first.id,
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
          }),
          { kind: 'refused' },
        );
        assert.equal((await dedupRecord(session, 'k'))?.invocation, 'begun');
      }),
  },
  {
    name: 'crash: before a dedup begin commits, the retry reclaims (control)',
    run: (harness) =>
      withSession(harness, async (session) => {
        const first = session.processes.spawn();
        await session.run(claim('k', first));
        const held = session.store.holdNextCommit();
        const begin = session.run({
          type: 'turnDedup.beginInvocation',
          key: 'k',
          ownerId: first.id,
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
        const recovered = await session.run({
          type: 'turnBoundary.reconcile',
          now: at(3),
        });
        assert.deepEqual(recovered, { kind: 'reconciled', interrupted: [] });
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
        const recovered = await session.run({
          type: 'turnBoundary.reconcile',
          now: at(3),
        });
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
        const recovered = await session.run({
          type: 'turnBoundary.reconcile',
          now: at(4),
        });
        const [row] = interruptedOf(recovered);
        assert.equal(row?.state, 'indeterminate');
        assert.equal(row?.providerTurnId, undefined);
      }),
  },
  {
    name: 'crash: a request key whose attempt recorded its decision is re-driven with it',
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
        await assert.rejects(
          session.run({ type: 'turnBoundary.reconcile', now: at(3) }),
        );
        await session.store.reopen();
        assert.deepEqual(
          (await boundaries(session)).map((row) => [row.boundaryId, row.state]),
          [
            ['i', 'invoking'],
            ['p', 'prepared'],
          ],
        );
        const recovered = await session.run({
          type: 'turnBoundary.reconcile',
          now: at(4),
        });
        assert.deepEqual(
          interruptedOf(recovered).map((row) => [row.boundaryId, row.state]),
          [['i', 'indeterminate']],
        );
      }),
  },
  {
    name: 'crash: a terminal whose commit failed neither retires the row nor records the fact',
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

export const kernelConformanceCases: readonly KernelConformanceCase[] =
  Object.freeze([
    ...durability,
    ...turnDedup,
    ...turnBoundary,
    ...requestKeys,
    ...crashPoints,
  ]);

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
