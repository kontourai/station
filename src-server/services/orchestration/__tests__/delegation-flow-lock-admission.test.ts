import assert from 'node:assert/strict';
import { join } from 'node:path';
import * as Flow from '@kontourai/flow';
import { afterEach, test, vi } from 'vitest';
import { createReportFlow } from './delegation-source-fixtures/flow.js';
import { deferred } from './delegation-source-fixtures/sdk.js';
import {
  fixture,
  selection,
  subject,
} from './delegation-source-fixtures/source.js';

vi.mock('@kontourai/flow', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kontourai/flow')>();
  return {
    ...actual,
    withRunMutationLock: vi.fn(actual.withRunMutationLock),
    loadRun: vi.fn(actual.loadRun),
  };
});
afterEach(async () => {
  const actual =
    await vi.importActual<typeof import('@kontourai/flow')>('@kontourai/flow');
  vi.mocked(Flow.withRunMutationLock).mockImplementation(
    actual.withRunMutationLock,
  );
  vi.mocked(Flow.loadRun).mockImplementation(actual.loadRun);
});

for (const method of ['head', 'claim'] as const) {
  test.each([
    { separate: false, abort: false, pending: 1 },
    { separate: true, abort: false, pending: 1 },
    { separate: false, abort: true, pending: 1 },
    ...(method === 'head'
      ? [{ separate: false, abort: false, pending: 128 }]
      : []),
  ])(
    `source-owned Flow ${method} admission serializes one run before its timed lock and rechecks queued authority (%j)`,
    async (control) => {
      const f = await fixture();
      const firstId = 'host-first';
      const secondId = control.separate ? 'host-second' : firstId;
      await createReportFlow(f, firstId, [{ id: 'left' }, { id: 'right' }]);
      if (control.separate)
        await Flow.startRun(join(f.repo, 'report-flow.json'), {
          cwd: f.repo,
          runId: secondId,
        });
      const abort = new AbortController();
      const request = f.request('/api/orchestration/chat', {
        signal: abort.signal,
      });
      const secondSubject = { ...subject, workItemId: 'second-seat' };
      const a = await f.owner.captureSnapshot(f.context(), subject, selection);
      const b = await f.owner.captureSnapshot(
        f.context(request),
        secondSubject,
        selection,
      );
      const first = await f.owner.prepareFlowSnapshot(
        f.context(),
        subject,
        a.capability,
        firstId,
      );
      const second = await f.owner.prepareFlowSnapshot(
        f.context(request),
        secondSubject,
        b.capability,
        secondId,
      );
      const firstClaim =
        method === 'claim'
          ? await Flow.claimReadyStep(firstId, {
              cwd: f.repo,
              step_id: 'left',
              actor: first.topology.actor,
              claim_id: 'host-left',
              liveness_id: 'live-left',
              lease_seconds: 300,
            })
          : null;
      const secondClaim =
        method === 'claim'
          ? await Flow.claimReadyStep(secondId, {
              cwd: f.repo,
              step_id: 'right',
              actor: second.topology.actor,
              claim_id: 'host-right',
              liveness_id: 'live-right',
              lease_seconds: 300,
            })
          : null;
      const firstHead = (await first.readSchedule()).runHead;
      const secondHead = (await second.readSchedule()).runHead;
      const entered = deferred<void>();
      const release = deferred<void>();
      const actual =
        await vi.importActual<typeof import('@kontourai/flow')>(
          '@kontourai/flow',
        );
      const nativeLock = actual.withRunMutationLock;
      const nativeLoad = actual.loadRun;
      let firstRead = true;
      let firstReleased = false;
      let lockEntries = 0;
      let launches = 0;
      const lock: typeof Flow.withRunMutationLock = async (...args) => {
        const ordinal = ++lockEntries;
        if (ordinal === 2 && !control.abort)
          assert.equal(
            firstReleased,
            !control.separate,
            'another host call entered the timed shared lock before its predecessor released',
          );
        try {
          return await nativeLock(...args);
        } finally {
          if (ordinal === 1) firstReleased = true;
        }
      };
      vi.mocked(Flow.withRunMutationLock).mockImplementation(lock);
      vi.mocked(Flow.loadRun).mockImplementation(async (...args) => {
        if (firstRead) {
          firstRead = false;
          entered.resolve();
          await release.promise;
        }
        return nativeLoad(...args);
      });
      const one = firstClaim
        ? first.withCurrentClaim(firstClaim.claim, () => ({
            value: ++launches,
          }))
        : first.withCurrentHead(firstHead, () => ({ value: ++launches }));
      try {
        await entered.promise;
        if (control.pending === 128) {
          const pending = Array.from({ length: 127 }, () =>
            second.withCurrentHead(secondHead, () => ({ value: ++launches })),
          );
          const overflow = second.withCurrentHead(secondHead, () => ({
            value: ++launches,
          }));
          const capacity = assert.rejects(overflow, /flow_mutation_capacity/);
          const settled = Promise.allSettled([one, ...pending]);
          release.resolve();
          assert.ok(
            (await settled).every((entry) => entry.status === 'fulfilled'),
          );
          await capacity;
          assert.equal(lockEntries, 128);
          assert.equal(launches, 128);
          return;
        }
        const two = secondClaim
          ? second.withCurrentClaim(secondClaim.claim, () => ({
              value: ++launches,
            }))
          : second.withCurrentHead(secondHead, () => ({ value: ++launches }));
        const results = Promise.allSettled([one, two]);
        if (control.abort) abort.abort(Error('queued request revoked'));
        release.resolve();
        const settled = await results;
        assert.equal(settled[0].status, 'fulfilled');
        assert.equal(
          settled[1].status,
          control.abort ? 'rejected' : 'fulfilled',
        );
        assert.equal(lockEntries, control.abort ? 1 : 2);
        assert.equal(launches, control.abort ? 1 : 2);
        if (control.abort) {
          if (firstClaim)
            await first.withCurrentClaim(firstClaim.claim, () => ({
              value: ++launches,
            }));
          else
            await first.withCurrentHead(firstHead, () => ({
              value: ++launches,
            }));
          assert.equal(launches, 2);
        }
      } finally {
        release.resolve();
        await one.catch(() => undefined);
        f.owner.releaseSnapshot(a.capability);
        f.owner.releaseSnapshot(b.capability);
      }
    },
  );
}
