import assert from 'node:assert/strict';
import type { KernelContext, KernelStorage } from '../port.js';
import type { KernelStorageLocation } from './crash-point-store.js';

/** A host supplies its durable head independently of the kernel commands. */
export interface HostBoundaryConformanceHarness {
  createLocation(
    facts: Required<Pick<KernelContext, 'terminalSeen' | 'terminalSequence'>>,
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
