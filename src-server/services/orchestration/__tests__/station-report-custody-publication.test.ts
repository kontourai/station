import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { FileAuthorizationLedger } from '@kontourai/dispatch';
import { claimableMultiCursorSteps, loadRun } from '@kontourai/flow';
import { DelegationRoundsTransactionUncertainError } from '@kontourai/flow-agents/delegation-group-rounds';
import { prepareFileMutationOwner } from '@kontourai/station-shared/lifecycle-events';
import { test, vi } from 'vitest';
import {
  bindRuntimeLocalOperator,
  getRuntimeAuthenticatedRequestPrincipal,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../../../security/runtime-request-security.js';
import {
  HomeWriterOwner,
  HomeWriterUnavailableError,
} from '../../ssh/home-writer-owner.js';
import { StationDelegationPersistence } from '../delegation-group-persistence.js';
import { withReportRoundsPublication } from '../report-rounds-publication.js';
import { StationReportGroupRuntime } from '../station-report-group-runtime.js';
import { createReportFlow } from './delegation-source-fixtures/flow.js';
import { recoveryFixture } from './report-recovery-fixture.js';

function leaves(error: unknown): unknown[] {
  return error instanceof AggregateError ||
    error instanceof DelegationRoundsTransactionUncertainError
    ? error.errors.flatMap(leaves)
    : [error];
}

function hasReturnedCleanupFailure(error: unknown): boolean {
  if (error instanceof DelegationRoundsTransactionUncertainError)
    return (
      error.status === 'returned-cleanup-unknown' ||
      error.errors.some(hasReturnedCleanupFailure)
    );
  return (
    error instanceof AggregateError &&
    error.errors.some(hasReturnedCleanupFailure)
  );
}

test.each([
  'intent-return',
  'admission-return',
  'final-lookup',
  'intent-return-abort',
  'admission-return-abort',
  'admission-cleanup',
  'admission-body-cleanup',
] as const)('report creation retains exact custody during %s', async (mode) => {
  const { h, owners, orchestration, eventStore, runtimeOwner, adapter } =
    await recoveryFixture();
  try {
    const flow = await createReportFlow(h.f, 'custody-prerequisite', [
      { id: 'prerequisite' },
      { id: 'left', needs: ['prerequisite'] },
    ]);
    const run = await loadRun(flow.runId, h.f.repo);
    assert.deepEqual(claimableMultiCursorSteps(run.definition, run.state), [
      'prerequisite',
    ]);
    const input = {
      ...h.input,
      members: h.input.members.slice(0, 1),
      maxConcurrent: 1,
      flow: { runId: flow.runId, steps: { left: 'left' } },
      continuation: {
        attemptsPerMember: 1,
        maxRounds: 1,
        maxSyncs: 0,
        maxRenewals: 0,
        maxEvaluations: 0,
        maxRecoveries: 0,
      },
    };
    const abort = new AbortController();
    const request = new Request(h.f.req, { signal: abort.signal });
    const principal = getRuntimeAuthenticatedRequestPrincipal(h.f.req);
    assert.ok(principal);
    setRuntimeAuthenticatedRequestPrincipal(request, principal);
    bindRuntimeLocalOperator(request);
    const stopped = Error('controlled stop after real custody retention');
    const cleanupFailure = Error(
      'controlled initial custody retirement failure',
    );
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let targetReturns = 0;
    let blockRelease = false;
    let faultedPath: string | undefined;
    const failedRetirements: string[] = [];
    const remove = fs.rmSync;
    const removal = vi
      .spyOn(fs, 'rmSync')
      .mockImplementation((path, options) => {
        if (
          blockRelease &&
          String(path).startsWith(
            join(h.f.home, 'security', '.home-writer.mutation.guard.stale-'),
          ) &&
          (faultedPath === undefined || String(path) === faultedPath)
        ) {
          faultedPath = String(path);
          failedRetirements.push(String(path));
          throw cleanupFailure;
        }
        return remove(path, options);
      });
    syncBuiltinESMExports();
    const afterReturn = async (kind: 'intent' | 'admission') => {
      if (!mode.startsWith(`${kind}-`)) return;
      targetReturns++;
      enter();
      if (mode.endsWith('-abort')) {
        abort.abort(stopped);
      } else if (mode.endsWith('-cleanup')) {
        blockRelease = true;
        if (mode === 'admission-body-cleanup') throw stopped;
      } else {
        await gate;
        throw stopped;
      }
    };
    const retainIntent =
      StationDelegationPersistence.prototype.retainReportIntent;
    const intent = vi
      .spyOn(StationDelegationPersistence.prototype, 'retainReportIntent')
      .mockImplementation(async function (
        this: StationDelegationPersistence,
        ...args
      ) {
        const result = await retainIntent.apply(this, args);
        await afterReturn('intent');
        return result;
      });
    const retainAdmission =
      StationDelegationPersistence.prototype.retainReportAdmission;
    const admission = vi
      .spyOn(StationDelegationPersistence.prototype, 'retainReportAdmission')
      .mockImplementation(async function (
        this: StationDelegationPersistence,
        ...args
      ) {
        const result = await retainAdmission.apply(this, args);
        await afterReturn('admission');
        return result;
      });
    const listAdmissions =
      StationDelegationPersistence.prototype.listReportAdmissions;
    const inventory = vi
      .spyOn(StationDelegationPersistence.prototype, 'listReportAdmissions')
      .mockImplementation(async function (
        this: StationDelegationPersistence,
        ...args
      ) {
        const records = await listAdmissions.apply(this, args);
        if (
          mode === 'final-lookup' &&
          records.some(
            (record) =>
              record.data.root.revisions.policy.id === input.operationId,
          )
        ) {
          targetReturns++;
          enter();
          await gate;
        }
        return records;
      });
    const starts = vi.spyOn(adapter, 'startSession');
    const reserve = vi.spyOn(FileAuthorizationLedger.prototype, 'reserve');
    const probe = await prepareFileMutationOwner(
      join(h.f.home, 'security', '.home-writer.mutation'),
    );
    const runtime = new StationReportGroupRuntime(owners);
    const pending = runtime.create(h.f.context(request), input);
    void pending.catch(() => {});
    try {
      await Promise.race([
        entered,
        pending.then(() => {
          throw Error('create returned before the real custody boundary');
        }),
      ]);
      if (mode.endsWith('-cleanup')) {
        await assert.rejects(pending, (error: unknown) => {
          assert.ok(error instanceof DelegationRoundsTransactionUncertainError);
          const failures = leaves(error);
          assert.ok(failures.includes(cleanupFailure));
          if (mode === 'admission-cleanup')
            assert.ok(hasReturnedCleanupFailure(error));
          if (mode === 'admission-body-cleanup')
            assert.equal(failures[0], stopped);
          return true;
        });
        const beforeShutdown = failedRetirements.length;
        assert.ok(
          beforeShutdown > 0,
          'the actual Home retirement fault must run',
        );
        const homeOwner = await HomeWriterOwner.forHome(h.f.home);
        let bodyRan = false;
        assert.throws(
          () =>
            homeOwner.runSynchronous(() => {
              bodyRan = true;
            }),
          (error: unknown) =>
            error instanceof HomeWriterUnavailableError &&
            error.reason === 'busy' &&
            error.operationRan === false,
        );
        assert.equal(bodyRan, false);
        await assert.rejects(runtimeOwner.shutdown(), {
          code: 'runtime_publication_pending',
        });
        assert.ok(failedRetirements.length > beforeShutdown);
        assert.equal(new Set(failedRetirements).size, 1);
        blockRelease = false;
        await runtimeOwner.shutdown();
      } else if (mode.endsWith('-abort')) {
        await assert.rejects(pending, (error: unknown) => {
          assert.ok(error instanceof DelegationRoundsTransactionUncertainError);
          assert.equal(error.status, 'returned-cleanup-unknown');
          assert.ok(leaves(error).includes(stopped));
          return true;
        });
      } else {
        const held = probe.tryAcquire();
        if (held.kind === 'acquired') await held.lease.release();
        release();
        if (mode === 'final-lookup') {
          const created = await pending;
          assert.equal(created.replayed, false);
          assert.equal(created.group.revision, 1);
          assert.equal(created.group.execution, 'idle');
          assert.ok(
            created.group.members.every(
              (member) => member.attempts.length === 0,
            ),
          );
        } else {
          await assert.rejects(pending, (error: unknown) => error === stopped);
        }
        assert.equal(
          held.kind,
          'busy',
          'actual custody return must retain Home',
        );
      }
      assert.equal(targetReturns, 1);
      assert.equal(starts.mock.calls.length, 0);
      assert.equal(reserve.mock.calls.length, 0);
      assert.equal(h.rawFetch.mock.calls.length, 0);
      const released = probe.tryAcquire();
      assert.equal(released.kind, 'acquired');
      if (released.kind === 'acquired') await released.lease.release();
    } finally {
      blockRelease = false;
      release();
      await pending.catch(() => {});
      inventory.mockRestore();
      admission.mockRestore();
      intent.mockRestore();
      removal.mockRestore();
      syncBuiltinESMExports();
      const homeOwner = await HomeWriterOwner.forHome(h.f.home);
      await homeOwner.settlePendingCleanup();
      starts.mockRestore();
      reserve.mockRestore();
      await probe.close();
    }
  } finally {
    try {
      await orchestration.shutdown();
    } finally {
      eventStore.close();
      await runtimeOwner.shutdown();
    }
  }
});

test('custody metadata admission keeps physical Home ownership bounded and refuses withdrawn grants', async () => {
  const { h, orchestration, eventStore, runtimeOwner, owners } =
    await recoveryFixture();
  const lock = join(h.f.home, 'security', '.home-writer.mutation');
  const link = fs.linkSync;
  let holds = 0;
  const observe = vi.spyOn(fs, 'linkSync').mockImplementation((from, to) => {
    if (String(to) === lock) holds++;
    return link(from, to);
  });
  syncBuiltinESMExports();
  try {
    const read = () =>
      withReportRoundsPublication(
        {
          participant: owners.publicationParticipant,
          home: h.f.home,
          signal: h.f.req.signal,
        },
        (publication) =>
          h.custody.inspectForMutation(
            h.f.context(),
            'missing-metadata-group',
            publication,
          ),
      );
    assert.equal(await read(), null);
    assert.ok(
      holds > 0,
      'the observer must see actual physical Home acquisition',
    );
    assert.ok(
      holds <= 8,
      `custody metadata admission took ${holds} physical Home holds; maximum 8 (re-measure before changing the bound)`,
    );
    h.f.environment.devicePairing.revokeDevice(
      h.f.paired.device.id,
      'operator-credential',
    );
    await assert.rejects(read, { code: 'group_custody_unavailable' });
    assert.equal(h.rawFetch.mock.calls.length, 0);
  } finally {
    observe.mockRestore();
    syncBuiltinESMExports();
    try {
      await orchestration.shutdown();
    } finally {
      eventStore.close();
      await runtimeOwner.shutdown();
    }
  }
});
