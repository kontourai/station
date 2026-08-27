import { describe, expect, test } from 'vitest';
import {
  compareWorkingStateIds,
  createSharedWorkingState,
  type InsertTextOperation,
  negotiateSharedWorkingStateVersion,
  SHARED_WORKING_STATE_SCHEMA_VERSION,
  SharedWorkingState,
  type TextDocumentOperation,
  type WorkingStateScope,
  type WorkingStateWriteAuthorization,
} from '../shared-working-state.js';

const scope: WorkingStateScope = {
  projectId: 'project-1',
  taskId: 'task-1',
  documentId: 'document-1',
};
const authorization: WorkingStateWriteAuthorization = {
  scope,
  epoch: 4,
  allowedActorIds: new Set(['actor-a', 'actor-b']),
};

function insert(
  operationId: string,
  actorId: string,
  after: string | null,
  text: string,
  parents: readonly string[] = [],
  epoch = authorization.epoch,
): InsertTextOperation {
  return {
    schemaVersion: SHARED_WORKING_STATE_SCHEMA_VERSION,
    operationId,
    documentId: scope.documentId,
    replicaId: `replica-${actorId}`,
    actor: {
      actorId,
      kind: actorId === 'actor-a' ? 'human' : 'agent',
      displayLabel: 'untrusted label',
    },
    parents,
    authorizationEpoch: epoch,
    kind: 'insert',
    after,
    text,
    attribution: {
      projectId: scope.projectId,
      taskId: scope.taskId,
      correlationId: 'corr-1',
    },
  };
}

const operations: readonly TextDocumentOperation[] = [
  insert('op-a', 'actor-a', null, 'A'),
  insert('op-b', 'actor-b', null, 'B'),
  insert('op-c', 'actor-a', 'op-a:0', 'c', ['op-a']),
  {
    schemaVersion: SHARED_WORKING_STATE_SCHEMA_VERSION,
    operationId: 'op-delete-b',
    documentId: scope.documentId,
    replicaId: 'replica-actor-a',
    actor: { actorId: 'actor-a', kind: 'human' },
    parents: ['op-b'],
    authorizationEpoch: authorization.epoch,
    kind: 'delete',
    target: ['op-b:0'],
  },
];

describe('SharedWorkingState', () => {
  test('deterministically converges byte-identical text and revision through adversarial delivery', () => {
    const left = new SharedWorkingState({ scope });
    const rightPorts = createSharedWorkingState({ scope });
    const right = rightPorts.live;

    // Left receives a duplicate and a delayed dependent operation. Right is
    // partitioned, then reconnects with a distinct permutation and replay mode.
    expect(left.apply(operations[2], authorization)).toMatchObject({
      outcome: 'deferred',
    });
    left.apply(operations[0], authorization);
    left.apply(operations[1], authorization);
    left.apply(operations[1], authorization);
    left.apply(operations[3], authorization);

    rightPorts.recovery.replay(operations[3]);
    rightPorts.recovery.replay(operations[1]);
    rightPorts.recovery.replay(operations[2]);
    expect(rightPorts.recovery.replay(operations[0])).toMatchObject({
      outcome: 'replayed',
      releasedOperationIds: ['op-c'],
    });

    expect(left.text()).toBe('Ac');
    expect(right.text()).toBe(left.text());
    expect(right.revision).toBe(left.revision);
    expect(Buffer.from(right.text())).toEqual(Buffer.from(left.text()));
  });

  test('reconnect returns bounded delta or a provable snapshot after its replay window', () => {
    const state = new SharedWorkingState({ scope });
    const base = state.revision;
    state.apply(operations[0], authorization);
    state.apply(operations[1], authorization);

    expect(state.resync(base, 2, [1])).toMatchObject({
      outcome: 'delta',
      operations: [operations[0], operations[1]],
    });
    expect(state.resync(base, 1, [1]).outcome).toBe('snapshot');
    expect(state.resync(base, 2, [99])).toEqual({
      outcome: 'unsupported_version',
      supportedVersions: [1],
    });

    const beforeCompaction = state.revision;
    const snapshot = state.compact();
    expect(snapshot.revision).toBe(beforeCompaction);
    expect(new SharedWorkingState({ scope, snapshot }).revision).toBe(
      beforeCompaction,
    );
    expect(state.resync(base, 10, [1]).outcome).toBe('snapshot');
  });

  test('fails closed for stale writers, unauthorized actors, malformed and unsupported input', () => {
    const state = new SharedWorkingState({ scope });
    const operation = insert('op-guard', 'actor-a', null, 'x');
    expect(
      state.apply(operation, {
        ...authorization,
        epoch: authorization.epoch + 1,
      }),
    ).toEqual({ outcome: 'rejected', reason: 'stale_writer' });
    expect(
      state.apply(operation, {
        ...authorization,
        allowedActorIds: new Set(['actor-b']),
      }),
    ).toEqual({ outcome: 'rejected', reason: 'unauthorized' });
    expect(state.apply({ ...operation, text: '' }, authorization)).toEqual({
      outcome: 'rejected',
      reason: 'malformed',
    });
    expect(
      state.apply({ ...operation, schemaVersion: 2 }, authorization),
    ).toEqual({
      outcome: 'rejected',
      reason: 'unsupported_version',
    });
  });

  test('negotiates the Station schema and does not silently downlevel', () => {
    expect(negotiateSharedWorkingStateVersion([2, 1])).toBe(1);
    expect(negotiateSharedWorkingStateVersion([2])).toBeNull();
  });

  test('uses UTF-16 code-unit ordering independent of locale and delivery order', () => {
    expect(['op-ä', 'op-z', 'op-Ω'].sort(compareWorkingStateIds)).toEqual([
      'op-z',
      'op-ä',
      'op-Ω',
    ]);
    const international = [
      insert('op-ä', 'actor-a', null, 'A'),
      insert('op-z', 'actor-b', null, 'Z'),
      insert('op-Ω', 'actor-a', null, 'O'),
    ];
    const left = new SharedWorkingState({ scope });
    const right = new SharedWorkingState({ scope });
    for (const operation of international) left.apply(operation, authorization);
    for (const operation of [...international].reverse()) {
      right.apply(operation, authorization);
    }
    expect(left.text()).toBe('ZAO');
    expect(right.text()).toBe(left.text());
    expect(right.revision).toBe(left.revision);
  });

  test('revalidates live deferred work on release while trusted recovery replays admitted history', () => {
    const state = new SharedWorkingState({ scope });
    const child = insert('op-child', 'actor-a', 'op-parent:0', 'c', [
      'op-parent',
    ]);
    expect(state.apply(child, authorization)).toMatchObject({
      outcome: 'deferred',
    });
    const currentAuthorization: WorkingStateWriteAuthorization = {
      ...authorization,
      epoch: 5,
    };
    const parent = insert('op-parent', 'actor-a', null, 'p', [], 5);
    expect(state.apply(parent, currentAuthorization)).toMatchObject({
      outcome: 'applied',
      released: [
        {
          operationId: 'op-child',
          outcome: 'rejected',
          reason: 'stale_writer',
        },
      ],
    });
    expect(state.text()).toBe('p');

    const source = new SharedWorkingState({ scope });
    const base = source.revision;
    source.apply(insert('op-replayed', 'actor-a', null, 'r'), authorization);
    const delta = source.resync(base, 1, [1]);
    expect(delta.outcome).toBe('delta');
    const recoveringPorts = createSharedWorkingState({ scope });
    const recovering = recoveringPorts.live;
    if (delta.outcome === 'delta') {
      for (const operation of delta.operations) {
        expect(recoveringPorts.recovery.replay(operation)).toMatchObject({
          outcome: 'replayed',
        });
      }
    }
    expect(recovering.revision).toBe(source.revision);
    expect(recovering.text()).toBe('r');
  });

  test('preserves deferred causal work through compaction and snapshot restore', () => {
    const deferred = insert('op-deferred', 'actor-a', 'op-root:0', 'd', [
      'op-root',
    ]);
    const root = insert('op-root', 'actor-a', null, 'r');
    const original = new SharedWorkingState({ scope });
    original.apply(deferred, authorization);
    const restored = new SharedWorkingState({
      scope,
      snapshot: original.compact(),
    });
    expect(restored.apply(root, authorization)).toMatchObject({
      releasedOperationIds: ['op-deferred'],
    });
    original.apply(root, authorization);
    expect(restored.text()).toBe('rd');
    expect(restored.revision).toBe(original.revision);
  });

  test('defensively clones operations, deltas, and snapshots and rejects ID equivocation', () => {
    const state = new SharedWorkingState({ scope });
    const mutable = insert('op-mutable', 'actor-a', null, 'm') as {
      text: string;
      actor: { displayLabel?: string };
    } & InsertTextOperation;
    state.apply(mutable, authorization);
    mutable.text = 'corrupt' as never;
    mutable.actor.displayLabel = 'also corrupt';
    expect(state.text()).toBe('m');
    expect(
      state.apply({ ...mutable, text: 'different' }, authorization),
    ).toEqual({
      outcome: 'rejected',
      reason: 'operation_equivocation',
    });
    const base = new SharedWorkingState({ scope }).revision;
    const delta = state.resync(base, 1, [1]);
    expect(delta.outcome).toBe('delta');
    if (delta.outcome === 'delta') {
      (delta.operations[0] as { text: string }).text = 'mutated-return';
    }
    expect(state.resync(base, 1, [1])).toMatchObject({
      operations: [expect.objectContaining({ text: 'm' })],
    });
    const snapshot = state.snapshot();
    (snapshot.atoms[0] as { value: string }).value = 'x';
    expect(state.text()).toBe('m');
  });

  test('treats display and correlation metadata changes as the same effect, not equivocation', () => {
    const state = new SharedWorkingState({ scope });
    const operation = insert('op-metadata', 'actor-a', null, 'm');
    expect(state.apply(operation, authorization).outcome).toBe('applied');
    expect(
      state.apply(
        {
          ...operation,
          actor: { ...operation.actor, displayLabel: 'renamed display' },
          attribution: {
            projectId: scope.projectId,
            taskId: scope.taskId,
            agentSessionId: 'different-session-correlation',
            runId: 'different-run-correlation',
          },
        },
        authorization,
      ),
    ).toMatchObject({ outcome: 'duplicate' });
  });

  test('validates malformed envelopes and hostile snapshots without throwing from apply', () => {
    const state = new SharedWorkingState({ scope });
    expect(() => state.apply({ actor: null }, authorization)).not.toThrow();
    expect(state.apply({ actor: null }, authorization)).toEqual({
      outcome: 'rejected',
      reason: 'malformed',
    });
    state.apply(insert('op-snapshot', 'actor-a', null, 's'), authorization);
    const snapshot = state.snapshot();
    const faults = [
      { ...snapshot, checkpointRevision: 'not-the-revision' },
      { ...snapshot, atoms: [{ ...snapshot.atoms[0], after: 'missing' }] },
      {
        ...snapshot,
        atoms: [{ ...snapshot.atoms[0], after: snapshot.atoms[0].id }],
      },
      { ...snapshot, atoms: [{ ...snapshot.atoms[0], deleted: 'false' }] },
      { ...snapshot, knownOperations: [] },
      {
        ...snapshot,
        knownOperations: [
          ...snapshot.knownOperations,
          snapshot.knownOperations[0],
        ],
      },
    ];
    for (const fault of faults) {
      expect(
        () => new SharedWorkingState({ scope, snapshot: fault as never }),
      ).toThrow();
    }
  });

  test('enforces a retained replay window and projects large text iteratively', () => {
    const state = new SharedWorkingState({ scope, maxRetainedOperations: 1 });
    const oldRevision = state.revision;
    state.apply(insert('op-window-root', 'actor-a', null, 'r'), authorization);
    state.apply(
      insert('op-window-next', 'actor-a', 'op-window-root:0', 'n', [
        'op-window-root',
      ]),
      authorization,
    );
    expect(state.resync(oldRevision, 100, [1]).outcome).toBe('snapshot');

    const large = new SharedWorkingState({ scope });
    const text = 'x'.repeat(20_000);
    large.apply(insert('op-large', 'actor-a', null, text), authorization);
    expect(large.text()).toBe(text);
  });

  test('binds deferred payloads into revisions, resync, and snapshot integrity', () => {
    const source = createSharedWorkingState({ scope });
    const peer = new SharedWorkingState({ scope });
    const child = insert(
      'op-pending-child',
      'actor-a',
      'op-pending-root:0',
      'c',
      ['op-pending-root'],
    );
    source.live.apply(child, authorization);
    expect(source.live.text()).toBe(peer.text());
    expect(source.live.revision).not.toBe(peer.revision);
    const update = source.live.resync(peer.revision, 10, [1]);
    expect(update.outcome).toBe('snapshot');
    if (update.outcome !== 'snapshot')
      throw new Error('expected pending snapshot');
    const snapshot = update.snapshot;
    const recovered = createSharedWorkingState({ scope, snapshot });
    const tampered = structuredClone(snapshot);
    (tampered.deferred[0].operation as { text: string }).text = 'tampered';
    expect(
      () => new SharedWorkingState({ scope, snapshot: tampered }),
    ).toThrow();

    const root = insert('op-pending-root', 'actor-a', null, 'r');
    source.live.apply(root, authorization);
    recovered.live.apply(root, authorization);
    expect(recovered.live.text()).toBe('rc');
    expect(recovered.live.revision).toBe(source.live.revision);
  });

  test('promotes matching live-deferred delta facts and snapshots rejected settlement', () => {
    const source = createSharedWorkingState({ scope });
    const peer = createSharedWorkingState({ scope });
    const child = insert('op-delta-child', 'actor-a', 'op-delta-root:0', 'c', [
      'op-delta-root',
    ]);
    source.live.apply(child, authorization);
    peer.live.apply(child, authorization);
    const pendingRevision = peer.live.revision;
    source.live.apply(
      insert('op-delta-root', 'actor-a', null, 'r'),
      authorization,
    );
    const delta = source.live.resync(pendingRevision, 2, [1]);
    expect(delta.outcome).toBe('delta');
    if (delta.outcome === 'delta') {
      expect(delta.operations).toHaveLength(2);
      for (const operation of delta.operations) peer.recovery.replay(operation);
    }
    expect(peer.live.text()).toBe('rc');
    expect(peer.live.revision).toBe(source.live.revision);

    const rejectedSource = createSharedWorkingState({ scope });
    const rejectedPeer = createSharedWorkingState({ scope });
    const rejectedChild = insert(
      'op-rejected-child',
      'actor-a',
      'op-rejected-root:0',
      'c',
      ['op-rejected-root'],
    );
    rejectedSource.live.apply(rejectedChild, authorization);
    rejectedPeer.live.apply(rejectedChild, authorization);
    const rejectedPendingRevision = rejectedPeer.live.revision;
    const epochFive: WorkingStateWriteAuthorization = {
      ...authorization,
      epoch: 5,
    };
    rejectedSource.live.apply(
      insert('op-rejected-root', 'actor-a', null, 'r', [], 5),
      epochFive,
    );
    expect(
      rejectedSource.live.resync(rejectedPendingRevision, 10, [1]).outcome,
    ).toBe('snapshot');
  });

  test('uses a replay checkpoint barrier when rejection follows a full retained history', () => {
    const options = { scope, maxRetainedOperations: 1 };
    const source = createSharedWorkingState(options);
    const peer = createSharedWorkingState(options);
    const seed = insert('op-barrier-seed', 'actor-a', null, 's');
    source.live.apply(seed, authorization);
    peer.live.apply(seed, authorization);
    const child = insert(
      'op-barrier-child',
      'actor-a',
      'op-barrier-root:0',
      'c',
      ['op-barrier-root'],
    );
    source.live.apply(child, authorization);
    peer.live.apply(child, authorization);
    const peerPendingRevision = peer.live.revision;
    const epochTwo: WorkingStateWriteAuthorization = {
      ...authorization,
      epoch: 2,
    };
    source.live.apply(
      insert('op-barrier-root', 'actor-a', null, 'r', [], 2),
      epochTwo,
    );
    const update = source.live.resync(peerPendingRevision, 10, [1]);
    expect(update.outcome).toBe('snapshot');
    if (update.outcome !== 'snapshot')
      throw new Error('expected barrier snapshot');
    const restored = createSharedWorkingState({
      scope,
      snapshot: update.snapshot,
    });
    expect(restored.live.revision).toBe(source.live.revision);
    expect(restored.live.text()).toBe(source.live.text());
  });

  test('reconciles live and trusted deferred dependencies in both directions', () => {
    const liveChildFirst = createSharedWorkingState({ scope });
    expect('replay' in liveChildFirst.live).toBe(false);
    expect(Object.keys(liveChildFirst.live)).toEqual([]);
    expect(
      (liveChildFirst.live as unknown as Record<string, unknown>).core,
    ).toBeUndefined();
    const child = insert(
      'op-cross-live-child',
      'actor-a',
      'op-cross-live-root:0',
      'c',
      ['op-cross-live-root'],
    );
    const root = insert('op-cross-live-root', 'actor-a', null, 'r');
    liveChildFirst.live.apply(child, authorization);
    expect(liveChildFirst.recovery.replay(root)).toMatchObject({
      outcome: 'replayed',
    });
    // No grant was supplied to recovery, so ready live work remains explicit
    // and the snapshot itself is always restorable.
    const restored = createSharedWorkingState({
      scope,
      snapshot: liveChildFirst.live.snapshot(),
    });
    expect(restored.recovery.reconcile(authorization)).toEqual([
      { operationId: 'op-cross-live-child', outcome: 'applied' },
    ]);
    expect(restored.live.text()).toBe('rc');

    const trustedChildFirst = createSharedWorkingState({ scope });
    const trustedChild = insert(
      'op-cross-trusted-child',
      'actor-a',
      'op-cross-trusted-root:0',
      'c',
      ['op-cross-trusted-root'],
    );
    const trustedRoot = insert('op-cross-trusted-root', 'actor-a', null, 'r');
    trustedChildFirst.recovery.replay(trustedChild);
    expect(
      trustedChildFirst.live.apply(trustedRoot, authorization),
    ).toMatchObject({
      releasedOperationIds: ['op-cross-trusted-child'],
    });
    expect(trustedChildFirst.live.text()).toBe('rc');
  });

  test('fails closed for Unicode, self dependencies, and bounded deferred admission', () => {
    const state = new SharedWorkingState({
      scope,
      maxDeferredOperations: 1,
      maxDeferredBytes: 2_048,
    });
    expect(
      state.apply(
        insert('op-surrogate', 'actor-a', null, '\ud800'),
        authorization,
      ),
    ).toEqual({ outcome: 'rejected', reason: 'malformed' });
    expect(
      state.apply(
        insert('op-self', 'actor-a', 'op-self:0', 'x'),
        authorization,
      ),
    ).toEqual({ outcome: 'rejected', reason: 'malformed' });
    expect(
      state.apply(
        insert('op-limit-one', 'actor-a', 'op-missing:0', 'a', ['op-missing']),
        authorization,
      ).outcome,
    ).toBe('deferred');
    expect(
      state.apply(
        insert('op-limit-two', 'actor-a', 'op-other:0', 'b', ['op-other']),
        authorization,
      ),
    ).toEqual({ outcome: 'rejected', reason: 'deferred_limit_exceeded' });
    const bytesBound = new SharedWorkingState({
      scope,
      maxDeferredOperations: 2,
      maxDeferredBytes: 1,
    });
    expect(
      bytesBound.apply(
        insert('op-byte-bound', 'actor-a', 'op-byte-root:0', 'b', [
          'op-byte-root',
        ]),
        authorization,
      ),
    ).toEqual({ outcome: 'rejected', reason: 'deferred_limit_exceeded' });
    const snapshot = new SharedWorkingState({ scope }).snapshot();
    (snapshot as { atoms: unknown }).atoms = [
      { id: 'op-unicode:0', after: null, value: '\ud800', deleted: false },
    ] as never;
    expect(() => new SharedWorkingState({ scope, snapshot })).toThrow();
  });

  test('restores a large predecessor graph without recursive validation', () => {
    const state = new SharedWorkingState({ scope });
    state.apply(
      insert('op-restore-large', 'actor-a', null, 'x'.repeat(20_000)),
      authorization,
    );
    const snapshot = state.snapshot();
    const restored = new SharedWorkingState({ scope, snapshot });
    expect(restored.text()).toHaveLength(20_000);
    expect(restored.revision).toBe(state.revision);
  });
});
