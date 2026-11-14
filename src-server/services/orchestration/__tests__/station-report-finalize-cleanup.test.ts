import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { ContinuationPublicationUncertainError } from '@kontourai/flow-agents/delegation-group-rounds';
import {
  acquireStationHomeMaintenanceLease,
  StationHomeActiveError,
} from '@kontourai/station-shared/station-home-lifecycle';
import { vi } from 'vitest';
import type { RuntimePublicationParticipant } from '../../../runtime/bootstrap/runtime-publication-participant.js';
import { HomeWriterOwner } from '../../ssh/home-writer-owner.js';
import {
  closeFinalizer,
  createFinalizerRuntime,
  finalizeFixture,
  observeNoFinalizerEffects,
  setupFinalizer,
  finalizerTest as test,
} from './delegation-source-fixtures/finalizer.js';

test('original continuation failure stays first when physical Home cleanup fails and the same cleanup retries', async ({
  signal,
}) => {
  const f = await setupFinalizer(signal);
  const noEffects = observeNoFinalizerEffects(f);
  const close = vi.spyOn(
    Reflect.get(f.runtime, 'orchestrationEventStore'),
    'close',
  );
  const original = new Error(
    'controlled original continuation failure after real retention',
  );
  const physical = new Error(
    'controlled physical Home guard quarantine removal failure',
  );
  const retain = f.persistence.retainReportContinuation.bind(f.persistence);
  let retained = false;
  const quarantinePaths: string[] = [];
  const retention = vi
    .spyOn(f.persistence, 'retainReportContinuation')
    .mockImplementation(async (...args) => {
      await retain(...args);
      retained = true;
      throw original;
    });
  const remove = fs.rmSync;
  let failRemoval = true;
  const removal = vi.spyOn(fs, 'rmSync').mockImplementation((path, options) => {
    if (
      retained &&
      String(path).includes('.home-writer.mutation.guard.stale-')
    ) {
      quarantinePaths.push(String(path));
      if (failRemoval) throw physical;
    }
    return remove(path, options);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(finalizeFixture(f), (error) => {
      assert.ok(error instanceof ContinuationPublicationUncertainError);
      assert.equal(error.status, 'publication-unknown');
      const firstLeaves = (value: unknown): unknown =>
        value instanceof AggregateError ? firstLeaves(value.errors[0]) : value;
      assert.equal(firstLeaves(error), original);
      const leaves = (value: unknown): unknown[] =>
        value instanceof AggregateError
          ? value.errors.flatMap(leaves)
          : [value];
      assert.ok(leaves(error).includes(physical));
      return true;
    });
    assert.equal(retained, true);
    assert.ok(quarantinePaths.length > 0);
    assert.equal(new Set(quarantinePaths).size, 1);
    assert.throws(
      () => acquireStationHomeMaintenanceLease(f.h.f.home),
      StationHomeActiveError,
    );
    const owner = await HomeWriterOwner.forHome(f.h.f.home);
    assert.throws(() => owner.runSynchronous(() => undefined), {
      reason: 'busy',
    });
    noEffects();
    await assert.rejects(f.runtime.shutdown(), {
      code: 'runtime_publication_pending',
    });
    assert.equal(close.mock.calls.length, 0);
    assert.throws(() => f.participant.acquire(), {
      code: 'runtime_publication_unavailable',
    });
    const attempts = quarantinePaths.length;
    failRemoval = false;
    await owner.settlePendingCleanup();
    assert.ok(quarantinePaths.length > attempts);
    assert.equal(new Set(quarantinePaths).size, 1);
    owner.runSynchronous(() => undefined);
    await f.runtime.shutdown();
    assert.equal(close.mock.calls.length, 1);
    noEffects();
    const reopened = createFinalizerRuntime(
      { projectHomeDir: f.h.f.home },
      signal,
    );
    try {
      f.setParticipant(
        Reflect.get(
          reopened,
          'runtimePublicationParticipant',
        ) as RuntimePublicationParticipant,
      );
      assert.equal(
        (await f.controller.get(f.groupId)).revision,
        f.held.revision,
      );
      noEffects();
    } finally {
      await reopened.shutdown();
    }
  } finally {
    failRemoval = false;
    noEffects.restore();
    close.mockRestore();
    removal.mockRestore();
    retention.mockRestore();
    syncBuiltinESMExports();
    await closeFinalizer(f);
  }
  const maintenance = acquireStationHomeMaintenanceLease(f.h.f.home);
  maintenance.release();
}, 60_000);
