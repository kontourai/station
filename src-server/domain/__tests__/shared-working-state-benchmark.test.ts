import { describe, expect, test } from 'vitest';
import {
  type InsertTextOperation,
  SHARED_WORKING_STATE_SCHEMA_VERSION,
  SharedWorkingState,
  type WorkingStateScope,
  type WorkingStateWriteAuthorization,
} from '../shared-working-state.js';

const scope: WorkingStateScope = {
  projectId: 'benchmark-project',
  taskId: 'benchmark-task',
  documentId: 'benchmark-document',
};
const authorization: WorkingStateWriteAuthorization = {
  scope,
  epoch: 1,
  allowedActorIds: new Set(['benchmark-actor']),
};

function operation(index: number, after: string | null): InsertTextOperation {
  return {
    schemaVersion: SHARED_WORKING_STATE_SCHEMA_VERSION,
    operationId: `benchmark-${String(index).padStart(3, '0')}`,
    documentId: scope.documentId,
    replicaId: 'benchmark-replica',
    actor: { actorId: 'benchmark-actor', kind: 'agent' },
    parents:
      index === 0 ? [] : [`benchmark-${String(index - 1).padStart(3, '0')}`],
    authorizationEpoch: authorization.epoch,
    kind: 'insert',
    after,
    text: 'x',
  };
}

describe('shared working-state benchmark fixture', () => {
  test('reports apply cost and snapshot/resync payload sizes', () => {
    const state = new SharedWorkingState({ scope });
    const baseRevision = state.revision;
    const startedAt = performance.now();
    let after: string | null = null;
    for (let index = 0; index < 100; index += 1) {
      const next = operation(index, after);
      state.apply(next, authorization);
      after = `${next.operationId}:0`;
    }
    const applyMs = performance.now() - startedAt;
    const snapshotBytes = Buffer.byteLength(
      JSON.stringify(state.snapshot()),
      'utf8',
    );
    const resync = state.resync(baseRevision, 100, [1]);
    const deltaBytes = Buffer.byteLength(JSON.stringify(resync), 'utf8');
    const report = { operationCount: 100, applyMs, snapshotBytes, deltaBytes };

    // Deliberately no wall-clock ceiling: this fixture reports a portable
    // baseline instead of turning host load into a correctness failure.
    expect(report).toMatchObject({
      operationCount: 100,
      snapshotBytes: expect.any(Number),
      deltaBytes: expect.any(Number),
    });
    expect(report.applyMs).toBeGreaterThanOrEqual(0);
    expect(report.snapshotBytes).toBeGreaterThan(0);
    expect(report.deltaBytes).toBeGreaterThan(0);
    process.stdout.write(
      `[shared-working-state benchmark] ${JSON.stringify(report)}\n`,
    );
  });
});
