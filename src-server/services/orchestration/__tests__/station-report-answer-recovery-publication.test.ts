import assert from 'node:assert/strict';
import { join } from 'node:path';
import { prepareFileMutationOwner } from '@kontourai/station-shared/lifecycle-events';
import { test, vi } from 'vitest';
import { StationDelegationPersistence } from '../delegation-group-persistence.js';
import { EventStore } from '../event-store.js';
import { StationReportGroupRuntime } from '../station-report-group-runtime.js';
import { requestFor } from './delegation-source-fixtures/report.js';
import { recoveryFixture } from './report-recovery-fixture.js';

test('input answer recovery retains runtime storage and Home through its preparation read', async () => {
  const { h, owners, orchestration, eventStore, runtimeOwner } =
    await recoveryFixture();
  const ownStore: unknown = Reflect.get(
    runtimeOwner,
    'orchestrationEventStore',
  );
  assert.ok(ownStore instanceof EventStore);
  const events: string[] = [];
  const originalClose = ownStore.close.bind(ownStore);
  const close = vi.spyOn(ownStore, 'close').mockImplementation(() => {
    const value = originalClose();
    events.push('store-close');
    return value;
  });
  const missing = 'missing-input-answer-group';
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const originalRead =
    StationDelegationPersistence.prototype.readReportAdmission;
  let missingReads = 0;
  const read = vi
    .spyOn(StationDelegationPersistence.prototype, 'readReportAdmission')
    .mockImplementation(async function (
      this: StationDelegationPersistence,
      ...args
    ) {
      const result = await originalRead.apply(this, args);
      if (args[0] === missing) {
        assert.equal(result, null);
        missingReads++;
        enter();
        await gate;
      }
      return result;
    });
  const probe = await prepareFileMutationOwner(
    join(h.f.home, 'security', '.home-writer.mutation'),
  );
  const runtime = new StationReportGroupRuntime(owners);
  const pending = runtime.syncAfterInput(
    h.f.context(requestFor(h, 'POST')),
    missing,
    {
      operationKey: 'sync-missing-answer',
      seatId: 'left',
      expectedRevision: 0,
      flowHead: 'a'.repeat(64),
      renewalOperationKey: 'missing-renewal',
    },
  );
  void pending.then(
    () => events.push('call-settled'),
    () => events.push('call-settled'),
  );
  try {
    await Promise.race([
      entered,
      pending.then(() => {
        throw new Error('input sync returned before its actual admission read');
      }),
    ]);
    assert.equal(missingReads, 1);
    const physical = probe.tryAcquire();
    if (physical.kind === 'acquired') await physical.lease.release();
    let shutdownFailure: unknown;
    try {
      await runtimeOwner.shutdown();
    } catch (error) {
      shutdownFailure = error;
    }
    const closesWhilePending = close.mock.calls.length;
    release();
    await assert.rejects(pending, { code: 'group_custody_unavailable' });
    await runtimeOwner.shutdown();
    assert.ok(
      shutdownFailure instanceof Error,
      'shutdown must refuse while input-answer preparation is admitted',
    );
    assert.equal(
      'code' in shutdownFailure ? shutdownFailure.code : undefined,
      'runtime_publication_pending',
    );
    assert.equal(closesWhilePending, 0);
    assert.equal(
      physical.kind,
      'busy',
      'answer-recovery read must keep its exact Home custody through return',
    );
    assert.equal(close.mock.calls.length, 1);
    assert.ok(events.indexOf('store-close') > events.indexOf('call-settled'));
    assert.equal(h.rawFetch.mock.calls.length, 0);
  } finally {
    release();
    await pending.catch(() => {});
    read.mockRestore();
    try {
      await orchestration.shutdown();
    } finally {
      eventStore.close();
      try {
        await runtimeOwner.shutdown();
      } finally {
        close.mockRestore();
        await probe.close();
      }
    }
  }
});
