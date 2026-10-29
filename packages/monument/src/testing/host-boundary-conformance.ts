import assert from 'node:assert/strict';
import type { KernelStorage, KernelTerminalFacts } from '../port.js';
import type { KernelStorageLocation } from './crash-point-store.js';

/** A host supplies its durable head independently of the kernel commands. */
export interface HostBoundaryConformanceHarness {
  createLocation(
    facts: Required<
      Pick<KernelTerminalFacts, 'terminalSeen' | 'terminalSequence'>
    > &
      Pick<KernelTerminalFacts, 'retiredBoundaryIds'>,
  ): Promise<
    KernelStorageLocation & {
      setCreationSequence(sequence: number): Promise<void>;
    }
  >;
}

/** Portable cases for hosts that bind a creation fence and authoritative facts.
 * Unlike the default-table suite, these require the host's sequence source. */
export const hostBoundaryConformanceCases = [
  { name: 'earlier terminal keeps the boundary', sequence: 16, retained: true },
  { name: 'equal terminal keeps the boundary', sequence: 17, retained: true },
  {
    name: 'later terminal retires despite a backward clock',
    sequence: 18,
    retained: false,
  },
  {
    name: 'missing persisted terminal fails closed',
    sequence: undefined,
    retained: true,
  },
].map(({ name, sequence, retained }) => ({
  name: `host boundary sequence: ${name}`,
  async run(harness: HostBoundaryConformanceHarness): Promise<void> {
    const location = await harness.createLocation({
      terminalSeen: () => false,
      terminalSequence: (thread, id) =>
        thread === 'thread' && id === 'terminal' ? sequence : undefined,
    });
    let storage: KernelStorage | undefined;
    try {
      await location.setCreationSequence(17);
      storage = await location.open();
      const owner = {
        id: 'owner',
        pid: 123,
        identityKind: 'unverified',
      } as const;
      const context = { liveness: () => 'unknown' as const };
      assert.deepEqual(
        await storage.execute(
          {
            type: 'turnBoundary.create',
            boundaryId: 'boundary',
            threadId: 'thread',
            state: 'prepared',
            purpose: 'turn',
            owner,
            now: '2040',
          },
          context,
        ),
        { kind: 'applied' },
      );
      await location.setCreationSequence(99);
      assert.deepEqual(
        await storage.execute(
          {
            type: 'turnBoundary.transition',
            boundaryId: 'boundary',
            ownerId: owner.id,
            from: ['prepared'],
            to: 'invoking',
            now: '2041',
          },
          context,
        ),
        { kind: 'applied' },
      );
      await storage.close();
      storage = await location.open();
      const before = await storage.execute(
        { type: 'turnBoundary.list' },
        context,
      );
      assert.equal(before.kind, 'records');
      if (before.kind !== 'records')
        throw new Error('Expected boundary records');
      assert.equal(before.records[0]?.createdSequence, 17);
      assert.deepEqual(
        await storage.execute(
          {
            type: 'turnBoundary.observeTerminal',
            threadId: 'thread',
            sessionTerminal: true,
            terminalEventId: 'terminal',
            terminalCreatedAt: '2030',
          },
          context,
        ),
        { kind: 'applied' },
      );
      const after = await storage.execute(
        { type: 'turnBoundary.list' },
        context,
      );
      assert.equal(after.kind, 'records');
      if (after.kind !== 'records')
        throw new Error('Expected boundary records');
      assert.equal(after.records.length, retained ? 1 : 0);
    } finally {
      await storage?.close();
      await location.dispose();
    }
  },
}));

hostBoundaryConformanceCases.push({
  name: 'host boundary facts: acceptance reads the fixed authority and observation never needs a default terminal table',
  async run(harness: HostBoundaryConformanceHarness): Promise<void> {
    const location = await harness.createLocation({
      terminalSeen: (thread, turn) =>
        thread === 'other' && turn === 'host-terminal',
      terminalSequence: () => undefined,
    });
    let storage: KernelStorage | undefined;
    try {
      await location.setCreationSequence(0);
      storage = await location.open();
      const owner = {
        id: 'owner',
        pid: 123,
        identityKind: 'unverified',
      } as const;
      const context = { liveness: () => 'unknown' as const };
      for (const [threadId, turn] of [
        ['thread', 'observed'],
        ['other', 'host-terminal'],
      ]) {
        const boundaryId = threadId;
        await storage.execute(
          {
            type: 'turnBoundary.observeTerminal',
            threadId,
            providerTurnId: turn,
            sessionTerminal: false,
            terminalCreatedAt: '2020',
          },
          context,
        );
        assert.deepEqual(
          await storage.execute(
            {
              type: 'turnBoundary.create',
              boundaryId,
              threadId,
              state: 'prepared',
              purpose: 'turn',
              owner,
              now: '2030',
            },
            context,
          ),
          { kind: 'applied' },
        );
        await storage.execute(
          {
            type: 'turnBoundary.transition',
            boundaryId,
            ownerId: owner.id,
            from: ['prepared'],
            to: 'invoking',
            now: '2031',
          },
          context,
        );
        assert.deepEqual(
          await storage.execute(
            {
              type: 'turnBoundary.transition',
              boundaryId,
              ownerId: owner.id,
              from: ['invoking'],
              to: 'accepted',
              providerTurnId: turn,
              now: '2032',
            },
            context,
          ),
          { kind: threadId === 'other' ? 'ambiguous' : 'applied' },
        );
      }
    } finally {
      await storage?.close();
      await location.dispose();
    }
  },
});

hostBoundaryConformanceCases.push({
  name: 'host boundary projection: polling filters live facts while listing and recovery retain raw rows across reopen',
  async run(harness: HostBoundaryConformanceHarness): Promise<void> {
    let retired: readonly string[] = [];
    const location = await harness.createLocation({
      terminalSeen: () => false,
      terminalSequence: () => undefined,
      retiredBoundaryIds: (thread) => (thread === 'thread' ? retired : []),
    });
    let storage: KernelStorage | undefined;
    try {
      await location.setCreationSequence(0);
      storage = await location.open();
      const owner = {
        id: 'owner',
        pid: 123,
        identityKind: 'unverified',
      } as const;
      const context = { liveness: () => 'unknown' as const };
      for (const threadId of ['thread', 'other']) {
        assert.deepEqual(
          await storage.execute(
            {
              type: 'turnBoundary.create',
              boundaryId: threadId,
              threadId,
              state: 'prepared',
              purpose: 'turn',
              owner,
              now: '2030',
            },
            context,
          ),
          { kind: 'applied' },
        );
        assert.deepEqual(
          await storage.execute(
            {
              type: 'turnBoundary.transition',
              boundaryId: threadId,
              ownerId: owner.id,
              from: ['prepared'],
              to: 'invoking',
              now: '2031',
            },
            context,
          ),
          { kind: 'applied' },
        );
      }
      assert.deepEqual(
        await storage.execute(
          {
            type: 'turnBoundary.hasPossibleEffect',
            threadId: 'thread',
          },
          context,
        ),
        { kind: 'available', active: true },
      );
      retired = ['thread', 'other'];
      assert.deepEqual(
        await storage.execute(
          {
            type: 'turnBoundary.hasPossibleEffect',
            threadId: 'thread',
          },
          context,
        ),
        { kind: 'available', active: false },
      );
      assert.deepEqual(
        await storage.execute(
          {
            type: 'turnBoundary.hasPossibleEffect',
            threadId: 'other',
          },
          context,
        ),
        { kind: 'available', active: true },
      );
      const listed = await storage.execute(
        { type: 'turnBoundary.list' },
        context,
      );
      assert.equal(listed.kind, 'records');
      if (listed.kind !== 'records') throw new Error('Expected raw records');
      assert.deepEqual(listed.records.map((row) => row.boundaryId).sort(), [
        'other',
        'thread',
      ]);
      const recovered = await storage.execute(
        {
          type: 'turnBoundary.reconcile',
          now: '2032',
          observed: listed.records.map((row) => ({
            boundaryId: row.boundaryId,
            owner: row.owner,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            verdict: 'dead' as const,
          })),
        },
        context,
      );
      assert.equal(recovered.kind, 'reconciled');
      if (recovered.kind !== 'reconciled')
        throw new Error('Expected raw recovery');
      assert.deepEqual(
        recovered.interrupted.map((row) => [row.boundaryId, row.state]).sort(),
        [
          ['other', 'indeterminate'],
          ['thread', 'indeterminate'],
        ],
      );
      await storage.close();
      storage = await location.open();
      assert.deepEqual(
        await storage.execute(
          {
            type: 'turnBoundary.hasPossibleEffect',
            threadId: 'thread',
          },
          context,
        ),
        { kind: 'available', active: false },
      );
      retired = [];
      assert.deepEqual(
        await storage.execute(
          {
            type: 'turnBoundary.hasPossibleEffect',
            threadId: 'thread',
          },
          context,
        ),
        { kind: 'available', active: true },
      );
    } finally {
      await storage?.close();
      await location.dispose();
    }
  },
});
