import assert from 'node:assert/strict';
import { HomeWriterOwner } from '../../ssh/home-writer-owner.js';
import {
  closeFinalizer,
  finalizeFixture,
  observeFinalTransaction,
  observeNoFinalizerEffects,
  setupFinalizer,
  finalizerTest as test,
} from './delegation-source-fixtures/finalizer.js';

test('request abort after the authentic finalizer parent is borrowed refuses without another effect', async ({
  signal,
}) => {
  const f = await setupFinalizer(signal);
  const abort = new AbortController();
  const reason = new DOMException(
    'controlled in-flight finalizer abort',
    'AbortError',
  );
  const request = f.h.f.request('/api/orchestration/report-groups', {
    signal: abort.signal,
  });
  const noEffects = observeNoFinalizerEffects(f);
  const observer = observeFinalTransaction(f, 'body', () =>
    abort.abort(reason),
  );
  try {
    await assert.rejects(
      finalizeFixture(f, request),
      (error) => error === reason,
    );
    assert.equal(observer.reached, 1);
    assert.equal(observer.completedBodies, 0);
    noEffects();
    assert.equal((await f.controller.get(f.groupId)).revision, f.held.revision);
    (await HomeWriterOwner.forHome(f.h.f.home)).runSynchronous(() => undefined);
    for (const guard of observer.guards)
      assert.throws(guard, { code: 'rounds_transaction_parent_unavailable' });
  } finally {
    noEffects.restore();
    observer.restore();
    await closeFinalizer(f);
  }
}, 60_000);
