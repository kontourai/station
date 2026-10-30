import assert from 'node:assert/strict';
import { test } from 'vitest';
import { PortableGroupPreparation } from '../portable-group-preparation.js';
import {
  newGrant,
  requestFor,
  setup,
} from './delegation-source-fixtures/report.js';

test('a later operator request re-admits the signed V2 source and rejects tampering before provider effects', async () => {
  const h = await setup();
  const owner = new PortableGroupPreparation(h.preparationOwners);
  const handle = await owner.prepare(h.f.context(), h.input);
  const admission = owner.admission(handle, h.f.req);
  const initial = owner.read(handle, h.f.req);
  assert.equal(initial.spec.schemaVersion, '2.0');
  owner.close(handle);
  const later = requestFor(h, 'POST');
  const resumed = await owner.readmit(h.f.context(later), admission);
  try {
    assert.deepEqual(owner.read(resumed, later).spec, initial.spec);
    for (const grant of initial.root.execution_grants) {
      assert.deepEqual(
        owner.currentExecutionBinding(resumed, later, grant.grant_id),
        {
          runtime: grant.runtime,
          source: grant.source,
          flow_binding: grant.flow_binding,
        },
      );
    }
    const altered = structuredClone(admission);
    altered.payload.intent.members[0].brief = 'tampered';
    await assert.rejects(() =>
      owner.readmit(h.f.context(requestFor(h, 'POST')), altered),
    );
    const foreign = requestFor(h, 'POST', newGrant(h).credential);
    await assert.rejects(() => owner.readmit(h.f.context(foreign), admission));
    assert.equal(h.rawFetch.mock.calls.length, 0);
  } finally {
    owner.close(resumed);
  }
});

test('a failed preparation releases the operation key for a corrected intent', async () => {
  const h = await setup();
  const owner = new PortableGroupPreparation(h.preparationOwners);
  await assert.rejects(
    () => owner.prepare(h.f.context(), { ...h.input, deadlineAt: 0 }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'group_preparation_unavailable',
  );
  const prepared = await owner.prepare(h.f.context(), h.input);
  try {
    assert.equal(owner.read(prepared, h.f.req).spec.schemaVersion, '2.0');
    assert.equal(h.rawFetch.mock.calls.length, 0);
  } finally {
    owner.close(prepared);
  }
});
