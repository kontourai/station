import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import fs, { readFileSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import {
  ContinuationPublicationUncertainError,
  DelegationRoundsTransactionParentError,
  DelegationRoundsTransactionUncertainError,
} from '@kontourai/flow-agents/delegation-group-rounds';
import {
  getRuntimeAuthenticatedRequestPrincipal,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../../../security/runtime-request-security.js';
import { HomeWriterUnavailableError } from '../../ssh/home-writer-owner.js';
import { SourceRefusal } from '../delegation-group-source-admission.js';
import * as reportPublication from '../report-rounds-publication.js';
import {
  closeFinalizer,
  finalizeFixture,
  observeFinalTransaction,
  observeNoFinalizerEffects,
  setupFinalizer,
  finalizerTest as test,
} from './delegation-source-fixtures/finalizer.js';
import { requestFor } from './delegation-source-fixtures/report.js';

for (const phase of ['body', 'commit', 'return'] as const) {
  test(`finalizer source preparation remains current through ${phase}`, async ({
    signal,
  }) => {
    const f = await setupFinalizer(signal);
    const locator = join(
      f.h.f.store,
      `snapshot-${f.prepared.envelopes[0].execution_binding.source.source_admission_receipt.id}.json`,
    );
    const bytes = readFileSync(locator);
    const noEffects = observeNoFinalizerEffects(f);
    const observer = observeFinalTransaction(f, phase, () =>
      writeFileSync(locator, '{}'),
    );
    try {
      await assert.rejects(finalizeFixture(f), (error) => {
        if (phase === 'body') {
          assert.ok(error instanceof SourceRefusal);
          assert.equal(error.code, 'flow_location_unavailable');
          return true;
        }
        assert.ok(error instanceof ContinuationPublicationUncertainError);
        assert.equal(error.status, 'publication-unknown');
        const original = error.errors[0];
        assert.ok(
          original instanceof DelegationRoundsTransactionUncertainError,
        );
        assert.equal(
          original.status,
          phase === 'commit'
            ? 'publication-unknown'
            : 'returned-cleanup-unknown',
        );
        assert.equal(
          Reflect.get(original.errors[0], 'code'),
          'flow_location_unavailable',
        );
        return true;
      });
      assert.equal(observer.reached, 1);
      assert.equal(observer.completedBodies, phase === 'body' ? 0 : 1);
      noEffects();
      for (const guard of observer.guards)
        assert.throws(guard, { code: 'rounds_transaction_parent_unavailable' });
    } finally {
      writeFileSync(locator, bytes);
      noEffects.restore();
      observer.restore();
      await closeFinalizer(f);
    }
  }, 60_000);
}

test('prepared finalizer refuses replacement of its captured request authority in flight', async ({
  signal,
}) => {
  const f = await setupFinalizer(signal);
  const request = requestFor(f.h, 'POST');
  const principal = getRuntimeAuthenticatedRequestPrincipal(request);
  assert.ok(principal);
  const noEffects = observeNoFinalizerEffects(f);
  const guards: Array<() => undefined> = [];
  const readLocation = f.h.f.owner.readHistoricalFlowLocation.bind(f.h.f.owner);
  const locations = vi
    .spyOn(f.h.f.owner, 'readHistoricalFlowLocation')
    .mockImplementation(async (input) => {
      const location = await readLocation(input);
      guards.push(location.assertCurrent);
      return location;
    });
  const observer = observeFinalTransaction(f, 'body', () => {
    const active: Array<() => undefined> = [];
    for (const guard of guards) {
      try {
        guard();
        active.push(guard);
      } catch (error) {
        assert.ok(
          error instanceof DelegationRoundsTransactionParentError ||
            (error instanceof HomeWriterUnavailableError &&
              error.reason === 'borrow-unavailable'),
        );
      }
    }
    assert.ok(active.length > 0, 'observe live historical location guards');
    setRuntimeAuthenticatedRequestPrincipal(request, principal);
    for (const guard of active)
      assert.throws(guard, { code: 'authorization_unavailable' });
  });
  try {
    await assert.rejects(finalizeFixture(f, request), {
      code: 'authorization_unavailable',
    });
    assert.equal(observer.reached, 1);
    assert.equal(observer.completedBodies, 0);
    noEffects();
  } finally {
    locations.mockRestore();
    noEffects.restore();
    observer.restore();
    await closeFinalizer(f);
  }
}, 60_000);

test('pass-through final transaction observer reaches body and durable return on valid preparation', async ({
  signal,
}) => {
  const f = await setupFinalizer(signal);
  const noEffects = observeNoFinalizerEffects(f);
  const registry = fs.statSync(
    join(f.h.f.home, 'security', 'paired-devices.json'),
    { bigint: true },
  );
  const open = fs.openSync;
  let measuring = false;
  let registryReads = 0;
  let retiredLocationsVerified = 0;
  const preparing =
    new AsyncLocalStorage<reportPublication.ReportRoundsScope>();
  const locationGuards = new WeakMap<
    reportPublication.ReportRoundsScope,
    Array<() => undefined>
  >();
  const readLocation = f.h.f.owner.readHistoricalFlowLocation.bind(f.h.f.owner);
  const locations = vi
    .spyOn(f.h.f.owner, 'readHistoricalFlowLocation')
    .mockImplementation(async (input) => {
      const scope = preparing.getStore();
      const location = await readLocation(input);
      if (scope) {
        const guards = locationGuards.get(scope) ?? [];
        guards.push(location.assertCurrent);
        locationGuards.set(scope, guards);
      }
      return location;
    });
  const publish = reportPublication.withReportRoundsPublication;
  const interceptPublication: typeof publish = (input, body) =>
    publish(input, (publication) =>
      body({
        ...publication,
        transactionOwner: (options) => ({
          acquire: async (request) => {
            let preparedScope: reportPublication.ReportRoundsScope | undefined;
            const owner = publication.transactionOwner({
              ...options,
              prepare: async (scope) => {
                preparedScope = scope;
                await preparing.run(scope, () => options.prepare?.(scope));
              },
            });
            const transaction = await owner.acquire(request);
            const guards = preparedScope
              ? (locationGuards.get(preparedScope) ?? [])
              : [];
            return {
              ...transaction,
              release: async () => {
                await transaction.release();
                const parent = request.publicationLease;
                if (!parent) return;
                assert.ok(guards.length > 0, 'observe actual child locations');
                parent.assertCurrent();
                const sibling = await parent.flowAdmission.acquire();
                try {
                  sibling.assertCurrent();
                  const before = registryReads;
                  measuring = true;
                  try {
                    for (const guard of guards)
                      assert.throws(guard, {
                        code: 'rounds_transaction_parent_unavailable',
                      });
                  } finally {
                    measuring = false;
                  }
                  assert.equal(
                    registryReads,
                    before,
                    'retired child locations refuse before registry reads while a sibling is live',
                  );
                  retiredLocationsVerified += guards.length;
                } finally {
                  await sibling.release();
                }
              },
            };
          },
        }),
      }),
    );
  const publication = vi
    .spyOn(reportPublication, 'withReportRoundsPublication')
    .mockImplementation(interceptPublication);
  const reads = vi
    .spyOn(fs, 'openSync')
    .mockImplementation((path, flags, mode) => {
      const descriptor = open(path, flags, mode);
      if (measuring) {
        const status = fs.fstatSync(descriptor, { bigint: true });
        if (status.dev === registry.dev && status.ino === registry.ino)
          registryReads++;
      }
      return descriptor;
    });
  syncBuiltinESMExports();
  const observer = observeFinalTransaction(f, 'return', () => {
    const guard = observer.guards[0];
    assert.ok(guard);
    measuring = true;
    try {
      guard();
    } finally {
      measuring = false;
    }
  });
  try {
    const result = await finalizeFixture(f);
    assert.equal(result.result.replayed, false);
    assert.ok(result.group?.continuations[0].receipt);
    assert.equal(observer.reached, 1);
    assert.equal(observer.completedBodies, 1);
    assert.ok(retiredLocationsVerified > 0, 'a real transaction child retired');
    noEffects();
    assert.ok(registryReads > 0, 'the real paired-registry observer must run');
    assert.ok(
      registryReads <= 2,
      `one finalizer guard opened the paired registry ${registryReads} times; maximum 2`,
    );
    const activeReads = registryReads;
    measuring = true;
    try {
      for (const guard of observer.guards)
        assert.throws(guard, { code: 'rounds_transaction_parent_unavailable' });
    } finally {
      measuring = false;
    }
    assert.equal(
      registryReads,
      activeReads,
      'retired guards must refuse before registry reads',
    );
  } finally {
    publication.mockRestore();
    locations.mockRestore();
    noEffects.restore();
    observer.restore();
    reads.mockRestore();
    syncBuiltinESMExports();
    await closeFinalizer(f);
  }
}, 60_000);

test('exact replay rejects unusable winners before historical source access and preserves intent checks', async ({
  signal,
  onTestFinished,
}) => {
  const f = await setupFinalizer(signal);
  onTestFinished(() => closeFinalizer(f));
  const finalized = await finalizeFixture(f);
  const reference = finalized.group?.continuations[0]?.receipt?.reference;
  assert.ok(reference);
  const winner = join(
    f.reportRoot,
    'station-report-flow-observations-v1',
    `${reference.id}.json`,
  );
  const winnerBytes = readFileSync(winner);
  const sourcePaths = new Set(
    f.prepared.envelopes.map((envelope) =>
      join(
        f.h.f.store,
        `snapshot-${envelope.execution_binding.source.source_admission_receipt.id}.json`,
      ),
    ),
  );
  const locator = [...sourcePaths][0];
  assert.ok(locator);
  const locatorBytes = readFileSync(locator);
  const open = fs.openSync;
  let sourceReads = 0;
  let winnerReads = 0;
  const reads = vi
    .spyOn(fs, 'openSync')
    .mockImplementation((path, flags, mode) => {
      if (sourcePaths.has(String(path))) sourceReads++;
      if (String(path) === winner) winnerReads++;
      return open(path, flags, mode);
    });
  syncBuiltinESMExports();
  const noEffects = observeNoFinalizerEffects(f);
  try {
    writeFileSync(winner, '{}');
    sourceReads = 0;
    await assert.rejects(finalizeFixture(f), {
      code: 'rounds_continuation_winner_unavailable',
    });
    assert.equal(
      sourceReads,
      0,
      'unusable retained winner must refuse before source reads',
    );

    writeFileSync(locator, '{}');
    sourceReads = 0;
    await assert.rejects(finalizeFixture(f), {
      code: 'rounds_continuation_winner_unavailable',
    });
    assert.equal(
      sourceReads,
      0,
      'winner failure precedes source failure for this exact replay',
    );
    writeFileSync(locator, locatorBytes);

    winnerReads = 0;
    await assert.rejects(
      f.h.custody.finalizeContinuation(
        f.h.f.context(requestFor(f.h, 'POST')),
        f.groupId,
        {
          operationKey: 'finish',
          expectedRevision: f.held.revision + 1,
          continuationOperationKey: 'lost',
        },
        f.dispatch,
        f.h.f.owner,
        f.participant,
        (historical) => historical.group,
      ),
      { code: 'rounds_intent_conflict' },
    );
    assert.equal(
      winnerReads,
      0,
      'changed replay intent must not probe winner health',
    );

    writeFileSync(winner, winnerBytes);
    writeFileSync(locator, '{}');
    sourceReads = 0;
    await assert.rejects(finalizeFixture(f), {
      code: 'flow_location_unavailable',
    });
    assert.ok(
      sourceReads > 0,
      'valid winner still requires historical source validation',
    );
    writeFileSync(locator, locatorBytes);

    fs.unlinkSync(winner);
    sourceReads = 0;
    await assert.rejects(finalizeFixture(f), {
      code: 'rounds_continuation_winner_unavailable',
    });
    assert.equal(
      sourceReads,
      0,
      'missing retained winner must refuse before source reads',
    );
    noEffects();
  } finally {
    reads.mockRestore();
    syncBuiltinESMExports();
    noEffects.restore();
    writeFileSync(locator, locatorBytes);
    writeFileSync(winner, winnerBytes);
  }
}, 60_000);

test('winner preflight keeps closing request authority and never supplies controller bytes', async ({
  signal,
  onTestFinished,
}) => {
  const f = await setupFinalizer(signal);
  onTestFinished(() => closeFinalizer(f));
  const finalized = await finalizeFixture(f);
  const reference = finalized.group?.continuations[0]?.receipt?.reference;
  assert.ok(reference);
  const winner = join(
    f.reportRoot,
    'station-report-flow-observations-v1',
    `${reference.id}.json`,
  );
  const winnerBytes = readFileSync(winner);
  const load = f.persistence.loadReportContinuation.bind(f.persistence);
  const noEffects = observeNoFinalizerEffects(f);
  try {
    writeFileSync(winner, '{}');
    const request = requestFor(f.h, 'POST');
    const principal = getRuntimeAuthenticatedRequestPrincipal(request);
    assert.ok(principal);
    let rejectedLoadReached = false;
    const rejecting = vi
      .spyOn(f.persistence, 'loadReportContinuation')
      .mockImplementationOnce(async (...args) => {
        try {
          return await load(...args);
        } finally {
          rejectedLoadReached = true;
          setRuntimeAuthenticatedRequestPrincipal(request, principal);
        }
      });
    try {
      await assert.rejects(finalizeFixture(f, request), {
        code: 'authorization_unavailable',
      });
      assert.equal(rejectedLoadReached, true);
    } finally {
      rejecting.mockRestore();
      writeFileSync(winner, winnerBytes);
    }

    let winnerRemoved = false;
    const changing = vi
      .spyOn(f.persistence, 'loadReportContinuation')
      .mockImplementation(async (...args) => {
        const bytes = await load(...args);
        if (!winnerRemoved) {
          fs.unlinkSync(winner);
          winnerRemoved = true;
        }
        return bytes;
      });
    try {
      await assert.rejects(finalizeFixture(f), {
        code: 'rounds_continuation_winner_unavailable',
      });
      assert.equal(winnerRemoved, true);
    } finally {
      changing.mockRestore();
      writeFileSync(winner, winnerBytes);
    }
    noEffects();
  } finally {
    noEffects.restore();
    writeFileSync(winner, winnerBytes);
  }
}, 60_000);
