import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ContinuationPublicationUncertainError,
  DelegationRoundsTransactionUncertainError,
} from '@kontourai/flow-agents/delegation-group-rounds';
import {
  getRuntimeAuthenticatedRequestPrincipal,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../../../security/runtime-request-security.js';
import { SourceRefusal } from '../delegation-group-source-admission.js';
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
  const observer = observeFinalTransaction(f, 'body', () =>
    setRuntimeAuthenticatedRequestPrincipal(request, principal),
  );
  try {
    await assert.rejects(finalizeFixture(f, request), {
      code: 'authorization_unavailable',
    });
    assert.equal(observer.reached, 1);
    assert.equal(observer.completedBodies, 0);
    noEffects();
  } finally {
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
  const observer = observeFinalTransaction(f, 'return', () => {});
  try {
    const result = await finalizeFixture(f);
    assert.equal(result.result.replayed, false);
    assert.ok(result.group?.continuations[0].receipt);
    assert.equal(observer.reached, 1);
    assert.equal(observer.completedBodies, 1);
    noEffects();
    for (const guard of observer.guards)
      assert.throws(guard, { code: 'rounds_transaction_parent_unavailable' });
  } finally {
    noEffects.restore();
    observer.restore();
    await closeFinalizer(f);
  }
}, 60_000);
