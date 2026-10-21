import { describe, expect, it } from 'vitest';
import type { KernelResult, TurnDedupReadCommand } from '../commands.js';
import {
  createSqliteKernelHarness,
  KernelCrashError,
  memoryKernelHarness,
  openCrashPointStore,
} from '../testing/index.js';

for (const harness of [memoryKernelHarness, createSqliteKernelHarness()]) {
  describe(`${harness.name} crash wrapper compatibility`, () => {
    it('keeps failure armed across a nonobserved read and rolls back the decision', async () => {
      const location = await harness.createLocation();
      const crash = await openCrashPointStore(location);
      const context = { liveness: () => 'unknown' as const };
      try {
        crash.failNextCommit(new Error('after-decision'));
        const read: Promise<KernelResult<TurnDedupReadCommand>> =
          crash.storage.execute({ type: 'turnDedup.read', key: 'k' }, context);
        expect(await read).toEqual({ kind: 'absent' });
        await expect(
          crash.storage.execute(
            {
              type: 'turnDedup.claim',
              key: 'k',
              now: 1,
              tracking: 'tracked',
              owner: {
                id: 'owner',
                pid: 123,
                identityKind: 'exact',
                birth: 'birth',
              },
            },
            context,
          ),
        ).rejects.toThrow('after-decision');
        expect(
          await crash.storage.execute(
            { type: 'turnDedup.read', key: 'k' },
            context,
          ),
        ).toEqual({ kind: 'absent' });
      } finally {
        await crash.dispose();
        await location.dispose();
      }
    });

    it('rejects an old held call after reopen while forwarding new calls', async () => {
      const location = await harness.createLocation();
      const crash = await openCrashPointStore(location);
      const context = { liveness: () => 'unknown' as const };
      try {
        const held = crash.holdNextCommit();
        const pending = crash.storage.execute(
          {
            type: 'requestKeys.claim',
            id: { callerSessionId: 's', tool: 't', key: 'k' },
            digest: 'original',
            now: 1,
          },
          context,
        );
        const rejection =
          expect(pending).rejects.toBeInstanceOf(KernelCrashError);
        expect((await held.entered).type).toBe('requestKeys.claim');
        await crash.reopen();
        await rejection;
        expect(
          await crash.storage.execute(
            {
              type: 'requestKeys.claim',
              id: { callerSessionId: 's', tool: 't', key: 'k' },
              digest: 'new',
              now: 2,
            },
            context,
          ),
        ).toEqual({ kind: 'claimed' });
      } finally {
        await crash.dispose();
        await location.dispose();
      }
    });
  });
}
