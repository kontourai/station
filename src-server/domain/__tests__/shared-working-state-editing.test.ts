import { describe, expect, test } from 'vitest';
import {
  MAX_COLLABORATIVE_EDIT_BATCH_BYTES,
  MAX_COLLABORATIVE_EDIT_OPERATION_BYTES,
} from '../../../src-shared/collaborative-edit-limits.js';
import {
  type InsertTextOperation,
  SHARED_WORKING_STATE_SCHEMA_VERSION,
  SharedWorkingState,
  type WorkingStateScope,
  type WorkingStateWriteAuthorization,
} from '../shared-working-state.js';
import {
  createSharedWorkingStateEditingCapability,
  MAX_SHARED_EDIT_TEXT_CODE_UNITS,
  sharedWorkingStateEditBatchDigest,
} from '../shared-working-state-editing.js';

const scope: WorkingStateScope = {
  projectId: 'project-a',
  taskId: 'task-a',
  documentId: 'document-a',
};
const authorization: WorkingStateWriteAuthorization = {
  scope,
  epoch: 1,
  allowedActorIds: new Set(['human-a', 'remote']),
};

function insert(
  operationId: string,
  text: string,
  after: string | null = null,
  actorId = 'human-a',
): InsertTextOperation {
  return {
    schemaVersion: SHARED_WORKING_STATE_SCHEMA_VERSION,
    operationId,
    documentId: scope.documentId,
    replicaId: `replica-${actorId}`,
    actor: { actorId, kind: 'human' },
    parents: [],
    authorizationEpoch: 1,
    kind: 'insert',
    after,
    text,
  };
}

function fixture(text: string) {
  const state = new SharedWorkingState({ scope });
  if (text) state.apply(insert('seed', text), authorization);
  let sequence = 0;
  const capability = createSharedWorkingStateEditingCapability({
    scope,
    snapshot: () => state.snapshot(),
    authorization: () => authorization,
    actor: () => ({ actorId: 'human-a', kind: 'human' }),
    replicaId: 'replica-human-a',
    nextIntentId: () => `intent-${++sequence}`,
  });
  return { state, capability };
}

function applyBatch(
  state: SharedWorkingState,
  operations: readonly Parameters<SharedWorkingState['apply']>[0][],
) {
  return operations.map((operation) => state.apply(operation, authorization));
}

function oldFnv32(value: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

describe('SharedWorkingStateEditingCapability', () => {
  test('uses canonical SHA-256 batch identity rather than the known FNV32 collision', () => {
    const left = insert('same-id', 'collision-4pvu');
    const right = insert('same-id', 'collision-b3ea');
    // These equal-length texts collide under the prior FNV32 JSON digest.
    expect(oldFnv32(JSON.stringify([left]))).toBe(
      oldFnv32(JSON.stringify([right])),
    );
    expect(
      sharedWorkingStateEditBatchDigest({
        intentId: 'intent-a',
        scope,
        operations: [left],
      }),
    ).not.toBe(
      sharedWorkingStateEditBatchDigest({
        intentId: 'intent-a',
        scope,
        operations: [right],
      }),
    );
  });

  test('keeps batch digest stable for equivalent effects, not display/correlation insertion order', () => {
    const base = insert('effect-a', 'text');
    const observed = {
      ...base,
      actor: { ...base.actor, displayLabel: 'Changed label' },
      attribution: { correlationId: 'later-correlation' },
    };
    const identity = {
      intentId: 'intent-a',
      scope,
      operations: [base],
    };
    expect(sharedWorkingStateEditBatchDigest(identity)).toBe(
      sharedWorkingStateEditBatchDigest({
        ...identity,
        operations: [observed],
      }),
    );
    expect(sharedWorkingStateEditBatchDigest(identity)).toBe(
      sharedWorkingStateEditBatchDigest({ ...identity, operations: [base] }),
    );
  });
  test.each([
    ['abc', 'aXbc', 'insert'],
    ['abc', 'ac', 'delete'],
    ['abc', 'aXYZc', 'replacement'],
  ])(
    'plans exact %s -> %s %s batch whose preview equals applied operations',
    (before, after) => {
      const { state, capability } = fixture(before);
      const planned = capability.plan({
        currentText: before,
        desiredText: after,
        selection: { anchor: after.length, focus: after.length },
        pending: [],
      });
      expect(planned.outcome).toBe('planned');
      if (planned.outcome !== 'planned') return;
      const outcomes = applyBatch(state, planned.batch.operations);
      expect(outcomes.every((entry) => entry.outcome === 'applied')).toBe(true);
      expect(state.text()).toBe(after);
      expect(planned.batch.optimistic).toEqual({
        text: after,
        workingStateRevision: state.revision,
      });
      expect(Object.isFrozen(planned.batch.operations)).toBe(true);
      expect(Object.isFrozen(planned.batch.operations[0])).toBe(true);
    },
  );

  test('replaces a shared suffix independently of causal sibling ID ordering', () => {
    const before = 'Owner and peer share this durable text.';
    const after = 'The Station agent settled this authoritative shared edit.';
    const state = new SharedWorkingState({ scope });
    state.apply(insert('m', before), authorization);
    const capability = createSharedWorkingStateEditingCapability({
      scope,
      snapshot: () => state.snapshot(),
      authorization: () => authorization,
      actor: () => ({ actorId: 'human-a', kind: 'agent' }),
      replicaId: 'agent-replica',
      // `n` sorts after the existing `m` causal branch. The old planner left
      // the common "t." suffix visible and therefore moved it before insert.
      nextIntentId: () => 'n',
    });
    const planned = capability.plan({
      currentText: before,
      desiredText: after,
      selection: { anchor: after.length, focus: after.length },
      pending: [],
    });
    if (planned.outcome !== 'planned')
      throw new Error(
        planned.outcome === 'refused' ? planned.reason : planned.outcome,
      );
    applyBatch(state, planned.batch.operations);
    expect(state.text()).toBe(after);
    expect(planned.batch.optimistic.text).toBe(after);
  });

  test('plans and applies 129+ deletion targets over exact atom IDs', () => {
    const before = 'x'.repeat(129);
    const { state, capability } = fixture(before);
    const planned = capability.plan({
      currentText: before,
      desiredText: '',
      selection: { anchor: 0, focus: 0 },
      pending: [],
    });
    if (planned.outcome !== 'planned') throw new Error('expected plan');
    expect(planned.batch.operations).toHaveLength(1);
    expect(planned.batch.operations[0]).toMatchObject({
      kind: 'delete',
      target: expect.arrayContaining(['seed:0', 'seed:128']),
    });
    applyBatch(state, planned.batch.operations);
    expect(state.text()).toBe('');
  });

  test('chunks the declared maximum text fixture by serialized operation bytes', () => {
    const before = 'x'.repeat(MAX_SHARED_EDIT_TEXT_CODE_UNITS);
    const { capability } = fixture(before);
    const planned = capability.plan({
      currentText: before,
      desiredText: '',
      selection: { anchor: 0, focus: 0 },
      pending: [],
    });
    if (planned.outcome !== 'planned') throw new Error('expected plan');
    expect(planned.batch.operations.length).toBeGreaterThan(1);
    const operationBytes = planned.batch.operations.map(
      (operation) =>
        new TextEncoder().encode(JSON.stringify(operation)).byteLength,
    );
    expect(
      operationBytes.every(
        (bytes) => bytes <= MAX_COLLABORATIVE_EDIT_OPERATION_BYTES,
      ),
    ).toBe(true);
    expect(
      operationBytes.reduce((total, bytes) => total + bytes, 0),
    ).toBeLessThanOrEqual(MAX_COLLABORATIVE_EDIT_BATCH_BYTES);
    // plan's optimistic projection comes only from replaying these same
    // operations through SharedWorkingState. Reapplying them to the fixture
    // would duplicate the maximum-size production work without proving a new
    // chunking boundary.
    expect(planned.batch.optimistic.text).toBe('');
  });

  test('is Unicode-scalar safe for emoji and refuses malformed or split-surrogate edits', () => {
    const { capability } = fixture('a😀b');
    expect(
      capability.plan({
        currentText: 'a😀b',
        desiredText: 'aXb',
        selection: { anchor: 2, focus: 2 },
        pending: [],
      }),
    ).toMatchObject({ outcome: 'planned' });
    expect(
      capability.plan({
        currentText: 'a😀b',
        desiredText: 'a😀b',
        selection: { anchor: 2, focus: 2 },
        pending: [],
      }),
    ).toMatchObject({ outcome: 'refused' });
    expect(
      capability.plan({
        currentText: 'a😀b',
        desiredText: `a${String.fromCharCode(0xd800)}b`,
        selection: { anchor: 1, focus: 1 },
        pending: [],
      }),
    ).toMatchObject({ outcome: 'refused' });
  });

  test('refuses a post-delete selection outside the desired document', () => {
    const { capability } = fixture('abc');
    expect(
      capability.plan({
        currentText: 'abc',
        desiredText: 'ac',
        selection: { anchor: 3, focus: 3 },
        pending: [],
      }),
    ).toMatchObject({ outcome: 'refused' });
  });

  test('clones and validates actor attribution without freezing injected objects', () => {
    const state = new SharedWorkingState({ scope });
    state.apply(insert('seed', 'abc'), authorization);
    const actor = {
      actorId: 'human-a',
      kind: 'human' as const,
      displayLabel: 'Original',
    };
    const attribution = {
      projectId: scope.projectId,
      taskId: scope.taskId,
      correlationId: 'correlation-a',
    };
    const capability = createSharedWorkingStateEditingCapability({
      scope,
      snapshot: () => state.snapshot(),
      authorization: () => authorization,
      actor: () => actor,
      attribution: () => attribution,
      replicaId: 'replica-human-a',
      nextIntentId: () => 'intent-clone',
    });
    const planned = capability.plan({
      currentText: 'abc',
      desiredText: 'aXbc',
      selection: { anchor: 2, focus: 2 },
      pending: [],
    });
    if (planned.outcome !== 'planned') throw new Error('expected plan');
    expect(Object.isFrozen(actor)).toBe(false);
    expect(Object.isFrozen(attribution)).toBe(false);
    actor.displayLabel = 'Mutated later';
    attribution.correlationId = 'mutated-later';
    expect(planned.batch.operations[0]?.actor.displayLabel).toBe('Original');
    expect(planned.batch.operations[0]?.attribution?.correlationId).toBe(
      'correlation-a',
    );
    expect(Object.isFrozen(planned.batch.operations[0]?.actor)).toBe(true);
  });

  test('deletes only planned base atoms so a remote insertion inside the range survives', () => {
    const { state, capability } = fixture('abc');
    const planned = capability.plan({
      currentText: 'abc',
      desiredText: '',
      selection: { anchor: 0, focus: 0 },
      pending: [],
    });
    if (planned.outcome !== 'planned') throw new Error('expected plan');
    state.apply(
      insert('remote-inside', 'R', 'seed:1', 'remote'),
      authorization,
    );
    applyBatch(state, planned.batch.operations);
    expect(state.text()).toBe('R');
  });

  test('converges same-position ties and preserves disjoint remote/local insertion', () => {
    const left = fixture('ab');
    const planned = left.capability.plan({
      currentText: 'ab',
      desiredText: 'aLb',
      selection: { anchor: 2, focus: 2 },
      pending: [],
    });
    if (planned.outcome !== 'planned') throw new Error('expected plan');
    const remote = insert('remote-tie', 'R', 'seed:0', 'remote');
    const right = new SharedWorkingState({
      scope,
      snapshot: left.state.snapshot(),
    });
    left.state.apply(remote, authorization);
    applyBatch(left.state, planned.batch.operations);
    applyBatch(right, planned.batch.operations);
    right.apply(remote, authorization);
    expect(left.state.text()).toBe(right.text());
    expect(left.state.revision).toBe(right.revision);
    expect(left.state.text()).toContain('L');
    expect(left.state.text()).toContain('R');

    const append = fixture('ab');
    const appendPlan = append.capability.plan({
      currentText: 'ab',
      desiredText: 'abL',
      selection: { anchor: 3, focus: 3 },
      pending: [],
    });
    if (appendPlan.outcome !== 'planned') throw new Error('expected append');
    append.state.apply(
      insert('remote-prefix', 'R', null, 'remote'),
      authorization,
    );
    applyBatch(append.state, appendPlan.batch.operations);
    expect(append.state.text()).toContain('R');
    expect(append.state.text()).toContain('L');
  });

  test('supports reordered/duplicate replacement operations and exact partial projection', () => {
    const { state, capability } = fixture('abc');
    const planned = capability.plan({
      currentText: 'abc',
      desiredText: 'aXYZc',
      selection: { anchor: 4, focus: 4 },
      pending: [],
    });
    if (planned.outcome !== 'planned') throw new Error('expected replacement');
    expect(planned.batch.operations).toHaveLength(2);
    const [remove, add] = planned.batch.operations;
    expect(state.apply(add, authorization).outcome).toBe('deferred');
    expect(state.apply(add, authorization).outcome).toBe('duplicate');
    expect(state.apply(remove, authorization)).toMatchObject({
      outcome: 'applied',
      releasedOperationIds: [add.operationId],
    });
    expect(state.text()).toBe('aXYZc');
    expect(
      capability.projectPending({
        pending: [{ intentId: planned.batch.intentId, operations: [] }],
      }),
    ).toMatchObject({ outcome: 'projected', text: 'aXYZc' });
  });

  test('maps authoritative cursor boundaries through exact pending insert and delete batches', () => {
    const inserted = fixture('abcd');
    const insertPlan = inserted.capability.plan({
      currentText: 'abcd',
      desiredText: 'Xabcd',
      selection: { anchor: 1, focus: 1 },
      pending: [],
    });
    if (insertPlan.outcome !== 'planned') throw new Error('expected insert');
    expect(
      inserted.capability.transformSelection({
        workingStateRevision: inserted.state.revision,
        selection: { anchor: 2, focus: 2 },
        pending: [
          {
            intentId: insertPlan.batch.intentId,
            operations: insertPlan.batch.operations,
          },
        ],
      }),
    ).toMatchObject({
      outcome: 'projected',
      text: 'Xabcd',
      selection: { anchor: 3, focus: 3 },
    });

    const deleted = fixture('abcd');
    const deletePlan = deleted.capability.plan({
      currentText: 'abcd',
      desiredText: 'acd',
      selection: { anchor: 1, focus: 1 },
      pending: [],
    });
    if (deletePlan.outcome !== 'planned') throw new Error('expected delete');
    expect(
      deleted.capability.transformSelection({
        workingStateRevision: deleted.state.revision,
        selection: { anchor: 3, focus: 3 },
        pending: [
          {
            intentId: deletePlan.batch.intentId,
            operations: deletePlan.batch.operations,
          },
        ],
      }),
    ).toMatchObject({
      outcome: 'projected',
      text: 'acd',
      selection: { anchor: 2, focus: 2 },
    });
  });
});
