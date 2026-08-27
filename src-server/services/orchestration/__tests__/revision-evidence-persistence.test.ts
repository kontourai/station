import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalizeForDigest } from '@kontourai/station-contracts/fleet-routing-receipt';
import { afterEach, describe, expect, test } from 'vitest';
import type {
  RevisionAttributionAuthority,
  RevisionAttributionBinding,
} from '../../../domain/revision-bound-evidence.js';
import { RevisionEvidenceModule } from '../../../domain/revision-bound-evidence.js';
import {
  SHARED_WORKING_STATE_SCHEMA_VERSION,
  SharedWorkingState,
  type WorkingStateScope,
} from '../../../domain/shared-working-state.js';
import { EventStore } from '../event-store.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (
    path: string,
  ) => {
    exec(sql: string): void;
    prepare(sql: string): {
      run(...values: unknown[]): unknown;
      get(...values: unknown[]): unknown;
    };
    close(): void;
  };
};
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function databasePath() {
  const directory = mkdtempSync(join(tmpdir(), 'station-revision-evidence-'));
  directories.push(directory);
  return join(directory, 'orchestration.sqlite');
}

const scope: WorkingStateScope = {
  projectId: 'project-1',
  taskId: 'task-1',
  documentId: 'document-1',
};

function authority(
  grants: Map<string, WorkingStateScope>,
  authorityVersion = 'v1',
): RevisionAttributionAuthority {
  const bound = (input: RevisionAttributionBinding) =>
    createHash('sha256')
      .update(
        JSON.stringify(
          canonicalizeForDigest({ authorityVersion, binding: input }),
        ),
      )
      .digest('hex');
  return {
    resolve: ({ scope: requestedScope, requestId }) => {
      const granted = grants.get(requestId);
      if (
        !granted ||
        granted.projectId !== requestedScope.projectId ||
        granted.taskId !== requestedScope.taskId ||
        granted.documentId !== requestedScope.documentId
      )
        return { outcome: 'unavailable' };
      return {
        outcome: 'resolved',
        actor: { actorId: 'server-agent', kind: 'agent' as const },
        correlation: {
          projectId: granted.projectId,
          taskId: granted.taskId,
          agentSessionId: 'session-1',
          runId: 'run-1',
        },
      };
    },
    attest: (input) => ({
      outcome: 'attested',
      attestation: `${authorityVersion}:${bound(input)}`,
    }),
    verify: ({ attestation, ...binding }) => ({
      outcome:
        attestation === `${authorityVersion}:${bound(binding)}`
          ? 'verified'
          : 'unavailable',
    }),
  };
}

function receiptCount(path: string): number {
  const database = new DatabaseSync(path);
  const row = database
    .prepare('SELECT COUNT(*) AS count FROM revision_evidence_receipts')
    .get() as { count: number };
  database.close();
  return row.count;
}

function settledSnapshot(forScope = scope, text = 'durable revision') {
  const state = new SharedWorkingState({ scope: forScope });
  const applied = state.apply(
    {
      schemaVersion: SHARED_WORKING_STATE_SCHEMA_VERSION,
      operationId: `op:${text}`,
      documentId: forScope.documentId,
      replicaId: 'replica-1',
      actor: { actorId: 'actor-1', kind: 'human' },
      parents: [],
      authorizationEpoch: 1,
      kind: 'insert',
      after: null,
      text,
    },
    { scope: forScope, epoch: 1, allowedActorIds: new Set(['actor-1']) },
  );
  expect(applied.outcome).toBe('applied');
  return state.snapshot();
}

describe('EventStore revision evidence persistence', () => {
  test('restart-resolves an exact immutable receipt and only projects a scope-bound link view', () => {
    const path = databasePath();
    const grants = new Map([['request-1', scope]]);
    const firstStore = new EventStore(path);
    const first = firstStore.createRevisionEvidenceModule({
      attribution: authority(grants),
    });
    const frozen = first.freeze({
      snapshot: settledSnapshot(),
      parents: [],
      requestId: 'request-1',
    });
    expect(frozen.outcome).toBe('committed');
    if (frozen.outcome !== 'committed') throw new Error('expected receipt');
    const revisionId = frozen.revision.revisionId;
    expect(firstStore.close()).toEqual({ kind: 'closed' });

    const restartedStore = new EventStore(path);
    const restarted = restartedStore.createRevisionEvidenceModule({
      attribution: authority(grants),
    });
    expect(
      restarted.resolveEvidence({ revisionId, verification: 'verified' }),
    ).toEqual({
      state: 'AVAILABLE',
      revision: frozen.revision,
    });
    const link = restarted.reader().resolve({ scope, revisionId });
    expect(link).toMatchObject({
      state: 'AVAILABLE',
      revision: {
        revisionId,
        text: 'durable revision',
        parents: [],
        correlation: { agentSessionId: 'session-1', runId: 'run-1' },
      },
    });
    expect(link).not.toHaveProperty('revision.snapshot');
    expect(link).not.toHaveProperty('revision.attributionAttestation');
    expect(
      restarted.reader().resolve({
        scope: { ...scope, documentId: 'other-document' },
        revisionId,
      }),
    ).toEqual({ state: 'UNAVAILABLE', reason: 'wrong_scope', revisionId });
    expect(restartedStore.close()).toEqual({ kind: 'closed' });
  });

  test('retains exact duplicate truth, rejects cross-scope parent topology, and never silently prunes capacity', () => {
    const path = databasePath();
    const otherScope = { ...scope, documentId: 'document-2' };
    const grants = new Map([
      ['one', scope],
      ['two', otherScope],
    ]);
    const store = new EventStore(path);
    const evidence = store.createRevisionEvidenceModule({
      attribution: authority(grants),
      maxRevisions: 1,
    });
    const first = evidence.freeze({
      snapshot: settledSnapshot(),
      parents: [],
      requestId: 'one',
    });
    expect(first.outcome).toBe('committed');
    if (first.outcome !== 'committed') throw new Error('expected receipt');
    expect(
      evidence.freeze({
        snapshot: settledSnapshot(),
        parents: [],
        requestId: 'one',
      }),
    ).toMatchObject({
      outcome: 'duplicate',
      revision: { revisionId: first.revision.revisionId },
    });
    expect(
      evidence.freeze({
        snapshot: settledSnapshot(otherScope, 'other'),
        parents: [first.revision.revisionId],
        requestId: 'two',
      }),
    ).toEqual({ outcome: 'rejected', reason: 'wrong_scope' });
    expect(
      evidence.freeze({
        snapshot: settledSnapshot(scope, 'capacity'),
        parents: [],
        requestId: 'one',
      }),
    ).toEqual({ outcome: 'rejected', reason: 'capacity_exceeded' });
    expect(store.close()).toEqual({ kind: 'closed' });
  });

  test('fails closed after corrupt bytes or incompatible authority on a later process', () => {
    const path = databasePath();
    const grants = new Map([['request-1', scope]]);
    const store = new EventStore(path);
    const evidence = store.createRevisionEvidenceModule({
      attribution: authority(grants),
    });
    const frozen = evidence.freeze({
      snapshot: settledSnapshot(),
      parents: [],
      requestId: 'request-1',
    });
    expect(frozen.outcome).toBe('committed');
    if (frozen.outcome !== 'committed') throw new Error('expected receipt');
    expect(store.close()).toEqual({ kind: 'closed' });

    const tamper = new DatabaseSync(path);
    tamper
      .prepare('UPDATE revision_evidence_receipts SET record_digest = ?')
      .run('forged-digest');
    tamper.close();
    const corruptStore = new EventStore(path);
    const corrupt = corruptStore.createRevisionEvidenceModule({
      attribution: authority(grants),
    });
    expect(
      corrupt.resolveEvidence({
        revisionId: frozen.revision.revisionId,
        verification: 'verified',
      }),
    ).toEqual({
      state: 'UNAVAILABLE',
      reason: 'revision_unavailable',
      revisionId: frozen.revision.revisionId,
    });
    expect(corrupt.revision(frozen.revision.revisionId)).toEqual({
      state: 'UNAVAILABLE',
      reason: 'revision_unavailable',
      revisionId: frozen.revision.revisionId,
    });
    expect(corrupt.exportPortable()).toEqual({
      state: 'UNAVAILABLE',
      reason: 'revision_unavailable',
    });
    expect(corrupt.resolveProposedChange({})).toEqual({
      state: 'UNAVAILABLE',
      reason: 'revision_unavailable',
    });
    grants.set('request-2', scope);
    expect(
      corrupt.freeze({
        snapshot: settledSnapshot(scope, 'must-not-append-after-corruption'),
        parents: [],
        requestId: 'request-2',
      }),
    ).toEqual({ outcome: 'rejected', reason: 'persistence_unavailable' });
    expect(corruptStore.close()).toEqual({ kind: 'closed' });
    expect(receiptCount(path)).toBe(1);

    const authorityPath = databasePath();
    const authorityStore = new EventStore(authorityPath);
    const authorityEvidence = authorityStore.createRevisionEvidenceModule({
      attribution: authority(grants),
    });
    const authorityFrozen = authorityEvidence.freeze({
      snapshot: settledSnapshot(scope, 'authority-bound'),
      parents: [],
      requestId: 'request-1',
    });
    expect(authorityFrozen.outcome).toBe('committed');
    if (authorityFrozen.outcome !== 'committed')
      throw new Error('expected authority receipt');
    expect(authorityStore.close()).toEqual({ kind: 'closed' });
    const incompatibleStore = new EventStore(authorityPath);
    const incompatible = incompatibleStore.createRevisionEvidenceModule({
      attribution: {
        ...authority(grants),
        verify: () => ({ outcome: 'unavailable' }),
      },
    });
    expect(
      incompatible.resolveEvidence({
        revisionId: authorityFrozen.revision.revisionId,
        verification: 'verified',
      }),
    ).toEqual({
      state: 'UNAVAILABLE',
      reason: 'revision_unavailable',
      revisionId: authorityFrozen.revision.revisionId,
    });
    expect(incompatibleStore.close()).toEqual({ kind: 'closed' });
  });

  test('refuses a freeze before writing when the active authority cannot validate the ledger', () => {
    const path = databasePath();
    const grants = new Map([
      ['request-1', scope],
      ['request-2', scope],
    ]);
    const firstStore = new EventStore(path);
    const first = firstStore.createRevisionEvidenceModule({
      attribution: authority(grants, 'authority-v1'),
    });
    expect(
      first.freeze({
        snapshot: settledSnapshot(scope, 'authority-v1-record'),
        parents: [],
        requestId: 'request-1',
      }).outcome,
    ).toBe('committed');
    expect(firstStore.close()).toEqual({ kind: 'closed' });

    const secondStore = new EventStore(path);
    const second = secondStore.createRevisionEvidenceModule({
      attribution: authority(grants, 'authority-v2'),
    });
    expect(
      second.freeze({
        snapshot: settledSnapshot(scope, 'must-not-append-under-v2'),
        parents: [],
        requestId: 'request-2',
      }),
    ).toEqual({ outcome: 'rejected', reason: 'persistence_unavailable' });
    expect(secondStore.close()).toEqual({ kind: 'closed' });
    expect(receiptCount(path)).toBe(1);
  });

  test.each([
    ['record_digest', 'x'.repeat(4_096)],
    ['project_id', 'p'.repeat(4_096)],
  ])(
    'SQL-preflights oversized %s text before paged restore',
    (column, value) => {
      const path = databasePath();
      const grants = new Map([['request-1', scope]]);
      const firstStore = new EventStore(path);
      const first = firstStore.createRevisionEvidenceModule({
        attribution: authority(grants),
      });
      expect(
        first.freeze({
          snapshot: settledSnapshot(),
          parents: [],
          requestId: 'request-1',
        }).outcome,
      ).toBe('committed');
      expect(firstStore.close()).toEqual({ kind: 'closed' });
      const tamper = new DatabaseSync(path);
      tamper
        .prepare(`UPDATE revision_evidence_receipts SET ${column} = ?`)
        .run(value);
      tamper.close();
      const restartedStore = new EventStore(path);
      const restarted = restartedStore.createRevisionEvidenceModule({
        attribution: authority(grants),
      });
      expect(restarted.exportPortable()).toEqual({
        state: 'UNAVAILABLE',
        reason: 'revision_unavailable',
      });
      expect(restartedStore.close()).toEqual({ kind: 'closed' });
    },
  );

  test('returns duplicate truth after a process loses the post-commit response', () => {
    const path = databasePath();
    const grants = new Map([['request-1', scope]]);
    let loseResponse = true;
    const firstStore = new EventStore(path);
    const first = firstStore.createRevisionEvidenceModule({
      attribution: authority(grants),
      unavailableAfterCommitOnce: () => {
        if (!loseResponse) return false;
        loseResponse = false;
        return true;
      },
    });
    const recovered = first.freeze({
      snapshot: settledSnapshot(),
      parents: [],
      requestId: 'request-1',
    });
    expect(recovered).toMatchObject({ outcome: 'duplicate' });
    expect(
      first.freeze({
        snapshot: settledSnapshot(),
        parents: [],
        requestId: 'request-1',
      }),
    ).toMatchObject({ outcome: 'duplicate' });
    expect(firstStore.close()).toEqual({ kind: 'closed' });

    const retryStore = new EventStore(path);
    const retry = retryStore.createRevisionEvidenceModule({
      attribution: authority(grants),
    });
    expect(
      retry.freeze({
        snapshot: settledSnapshot(),
        parents: [],
        requestId: 'request-1',
      }),
    ).toMatchObject({ outcome: 'duplicate' });
    expect(retryStore.close()).toEqual({ kind: 'closed' });
  });

  test('independent EventStore instances sharing one home cannot fork one revision identity', () => {
    const path = databasePath();
    const grants = new Map([['request-1', scope]]);
    const leftStore = new EventStore(path);
    const rightStore = new EventStore(path);
    const left = leftStore.createRevisionEvidenceModule({
      attribution: authority(grants),
    });
    const right = rightStore.createRevisionEvidenceModule({
      attribution: authority(grants),
    });
    const input = {
      snapshot: settledSnapshot(scope, 'one shared receipt'),
      parents: [],
      requestId: 'request-1',
    };
    const first = left.freeze(input);
    const second = right.freeze(input);
    expect(first.outcome).toBe('committed');
    expect(second.outcome).toBe('duplicate');
    if (first.outcome !== 'committed' || second.outcome !== 'duplicate')
      throw new Error('expected exact single durable identity');
    expect(second.revision.revisionId).toBe(first.revision.revisionId);
    expect(leftStore.close()).toEqual({ kind: 'closed' });
    expect(rightStore.close()).toEqual({ kind: 'closed' });
  });

  test('a live peer reader refreshes a revision committed after its module opened', () => {
    const path = databasePath();
    const grants = new Map([['request-1', scope]]);
    const writerStore = new EventStore(path);
    const readerStore = new EventStore(path);
    const writer = writerStore.createRevisionEvidenceModule({
      attribution: authority(grants),
    });
    const reader = readerStore.createRevisionEvidenceModule({
      attribution: authority(grants),
    });
    const committed = writer.freeze({
      snapshot: settledSnapshot(scope, 'peer-visible'),
      parents: [],
      requestId: 'request-1',
    });
    expect(committed.outcome).toBe('committed');
    if (committed.outcome !== 'committed') throw new Error('expected commit');
    expect(
      reader
        .reader()
        .resolve({ scope, revisionId: committed.revision.revisionId }),
    ).toMatchObject({
      state: 'AVAILABLE',
      revision: {
        revisionId: committed.revision.revisionId,
        text: 'peer-visible',
      },
    });
    expect(writerStore.close()).toEqual({ kind: 'closed' });
    expect(readerStore.close()).toEqual({ kind: 'closed' });
  });

  test('durably imports one atomic canonical batch and restores it after restart', () => {
    const path = databasePath();
    const grants = new Map([
      ['one', scope],
      ['two', scope],
    ]);
    const source = new RevisionEvidenceModule({
      attribution: authority(grants),
    });
    expect(
      source.freeze({
        snapshot: settledSnapshot(scope, 'portable-one'),
        parents: [],
        requestId: 'one',
      }).outcome,
    ).toBe('committed');
    expect(
      source.freeze({
        snapshot: settledSnapshot(scope, 'portable-two'),
        parents: [],
        requestId: 'two',
      }).outcome,
    ).toBe('committed');
    const bundle = source.exportPortable();
    if ('state' in bundle) throw new Error('expected portable bundle');

    const firstStore = new EventStore(path);
    const first = firstStore.createRevisionEvidenceModule({
      attribution: authority(grants),
    });
    expect(first.importPortable(bundle)).toEqual({
      outcome: 'imported',
      revisions: 2,
    });
    expect(first.importPortable(bundle)).toEqual({
      outcome: 'duplicate',
      revisions: 0,
    });
    expect(firstStore.close()).toEqual({ kind: 'closed' });
    const restartedStore = new EventStore(path);
    const restarted = restartedStore.createRevisionEvidenceModule({
      attribution: authority(grants),
    });
    expect(restarted.exportPortable()).toEqual(bundle);
    expect(restartedStore.close()).toEqual({ kind: 'closed' });
  });

  test('retries a peer barrier and reports the exact inserted count from the winning transaction', () => {
    const path = databasePath();
    const grants = new Map([
      ['one', scope],
      ['two', scope],
    ]);
    const source = new RevisionEvidenceModule({
      attribution: authority(grants),
    });
    expect(
      source.freeze({
        snapshot: settledSnapshot(scope, 'barrier-one'),
        parents: [],
        requestId: 'one',
      }).outcome,
    ).toBe('committed');
    const peerBundle = source.exportPortable();
    if ('state' in peerBundle) throw new Error('expected peer bundle');
    expect(
      source.freeze({
        snapshot: settledSnapshot(scope, 'barrier-two'),
        parents: [],
        requestId: 'two',
      }).outcome,
    ).toBe('committed');
    const bundle = source.exportPortable();
    if ('state' in bundle) throw new Error('expected portable bundle');

    const peerStore = new EventStore(path);
    const peer = peerStore.createRevisionEvidenceModule({
      attribution: authority(grants),
    });
    let peerOutcome: ReturnType<typeof peer.importPortable> | undefined;
    const contenderStore = new EventStore(path);
    const contender = contenderStore.createRevisionEvidenceModule({
      attribution: authority(grants),
      beforePersistOnce: () => {
        peerOutcome = peer.importPortable(peerBundle);
      },
    });
    expect(contender.importPortable(bundle)).toEqual({
      outcome: 'imported',
      revisions: 1,
    });
    expect(peerOutcome).toEqual({ outcome: 'imported', revisions: 1 });
    expect(contender.importPortable(bundle)).toEqual({
      outcome: 'duplicate',
      revisions: 0,
    });
    expect(receiptCount(path)).toBe(2);
    expect(contenderStore.close()).toEqual({ kind: 'closed' });
    expect(peerStore.close()).toEqual({ kind: 'closed' });
  });

  test('enforces aggregate escaped portable bytes before commit', () => {
    const path = databasePath();
    const grants = new Map([
      ['one', scope],
      ['two', scope],
    ]);
    const source = new RevisionEvidenceModule({
      attribution: authority(grants),
    });
    const firstInput = {
      snapshot: settledSnapshot(scope, 'escaped\n\\\tvalue'),
      parents: [],
      requestId: 'one',
    };
    const secondInput = {
      snapshot: settledSnapshot(scope, 'second escaped\n\\\tvalue'),
      parents: [],
      requestId: 'two',
    };
    expect(source.freeze(firstInput).outcome).toBe('committed');
    const firstBundle = source.exportPortable();
    if ('state' in firstBundle) throw new Error('expected first bundle');
    const exactFirstBytes = Buffer.byteLength(
      JSON.stringify(firstBundle),
      'utf8',
    );

    const store = new EventStore(path);
    const evidence = store.createRevisionEvidenceModule({
      attribution: authority(grants),
      maxImportBytes: exactFirstBytes,
    });
    expect(evidence.freeze(firstInput).outcome).toBe('committed');
    expect(evidence.freeze(secondInput)).toEqual({
      outcome: 'rejected',
      reason: 'capacity_exceeded',
    });
    const retained = evidence.exportPortable();
    expect(retained).toEqual(firstBundle);
    expect(store.close()).toEqual({ kind: 'closed' });
  });

  test('aligns durable count with the stricter import-entry restore bound', () => {
    const path = databasePath();
    const grants = new Map([
      ['one', scope],
      ['two', scope],
    ]);
    const store = new EventStore(path);
    const evidence = store.createRevisionEvidenceModule({
      attribution: authority(grants),
      maxRevisions: 2,
      maxImportEntries: 1,
    });
    expect(
      evidence.freeze({
        snapshot: settledSnapshot(scope, 'one'),
        parents: [],
        requestId: 'one',
      }).outcome,
    ).toBe('committed');
    expect(
      evidence.freeze({
        snapshot: settledSnapshot(scope, 'two'),
        parents: [],
        requestId: 'two',
      }),
    ).toEqual({ outcome: 'rejected', reason: 'capacity_exceeded' });
    expect(store.close()).toEqual({ kind: 'closed' });
  });

  test('restores a ledger spanning multiple bounded SQLite pages', () => {
    const path = databasePath();
    const grants = new Map<string, WorkingStateScope>();
    const source = new RevisionEvidenceModule({
      attribution: authority(grants),
    });
    for (let index = 0; index < 33; index += 1) {
      const requestId = `page-${index}`;
      grants.set(requestId, scope);
      expect(
        source.freeze({
          snapshot: settledSnapshot(scope, `page record ${index}`),
          parents: [],
          requestId,
        }).outcome,
      ).toBe('committed');
    }
    const bundle = source.exportPortable();
    if ('state' in bundle) throw new Error('expected portable bundle');
    const firstStore = new EventStore(path);
    const first = firstStore.createRevisionEvidenceModule({
      attribution: authority(grants),
    });
    expect(first.importPortable(bundle)).toEqual({
      outcome: 'imported',
      revisions: 33,
    });
    expect(firstStore.close()).toEqual({ kind: 'closed' });
    const restartedStore = new EventStore(path);
    const restarted = restartedStore.createRevisionEvidenceModule({
      attribution: authority(grants),
    });
    expect(restarted.exportPortable()).toEqual(bundle);
    expect(restartedStore.close()).toEqual({ kind: 'closed' });
  });

  test('fences every retained read and write capability after EventStore close', () => {
    const path = databasePath();
    const grants = new Map([['request-1', scope]]);
    const store = new EventStore(path);
    const evidence = store.createRevisionEvidenceModule({
      attribution: authority(grants),
      proposedChanges: { find: () => undefined },
    });
    const committed = evidence.freeze({
      snapshot: settledSnapshot(),
      parents: [],
      requestId: 'request-1',
    });
    expect(committed.outcome).toBe('committed');
    if (committed.outcome !== 'committed') throw new Error('expected commit');
    const revisionId = committed.revision.revisionId;
    const reader = evidence.reader();
    expect(store.close()).toEqual({ kind: 'closed' });
    expect(reader.resolve({ scope, revisionId })).toEqual({
      state: 'UNAVAILABLE',
      reason: 'revision_unavailable',
      revisionId,
    });
    expect(evidence.revision(revisionId)).toEqual({
      state: 'UNAVAILABLE',
      reason: 'revision_unavailable',
      revisionId,
    });
    expect(evidence.exportPortable()).toEqual({
      state: 'UNAVAILABLE',
      reason: 'revision_unavailable',
    });
    expect(evidence.resolveProposedChange({})).toEqual({
      state: 'UNAVAILABLE',
      reason: 'revision_unavailable',
    });
    expect(
      evidence.freeze({
        snapshot: settledSnapshot(),
        parents: [],
        requestId: 'request-1',
      }),
    ).toEqual({ outcome: 'rejected', reason: 'persistence_unavailable' });
  });

  test('a reentrant verify close during reader restore cannot repopulate or disclose cached evidence', () => {
    const path = databasePath();
    const grants = new Map([['request-1', scope]]);
    const seedStore = new EventStore(path);
    const seed = seedStore.createRevisionEvidenceModule({
      attribution: authority(grants),
    });
    const committed = seed.freeze({
      snapshot: settledSnapshot(),
      parents: [],
      requestId: 'request-1',
    });
    expect(committed.outcome).toBe('committed');
    if (committed.outcome !== 'committed') throw new Error('expected commit');
    expect(seedStore.close()).toEqual({ kind: 'closed' });

    const base = authority(grants);
    let verifies = 0;
    const readStore = new EventStore(path);
    const evidence = readStore.createRevisionEvidenceModule({
      attribution: {
        ...base,
        verify: (input) => {
          const result = base.verify(input);
          verifies += 1;
          if (verifies === 2) readStore.close();
          return result;
        },
      },
    });
    const result = evidence.reader().resolve({
      scope,
      revisionId: committed.revision.revisionId,
    });
    expect(result).toEqual({
      state: 'UNAVAILABLE',
      reason: 'revision_unavailable',
      revisionId: committed.revision.revisionId,
    });
    expect(JSON.stringify(result)).not.toContain('snapshot');
    expect(evidence.exportPortable()).toEqual({
      state: 'UNAVAILABLE',
      reason: 'revision_unavailable',
    });
  });

  test('EventStore owns and fences a reentrant close during initial restore', () => {
    const path = databasePath();
    const grants = new Map([['request-1', scope]]);
    const seedStore = new EventStore(path);
    const seed = seedStore.createRevisionEvidenceModule({
      attribution: authority(grants),
    });
    expect(
      seed.freeze({
        snapshot: settledSnapshot(),
        parents: [],
        requestId: 'request-1',
      }).outcome,
    ).toBe('committed');
    expect(seedStore.close()).toEqual({ kind: 'closed' });

    const base = authority(grants);
    const restoreStore = new EventStore(path);
    const evidence = restoreStore.createRevisionEvidenceModule({
      attribution: {
        ...base,
        verify: (input) => {
          const result = base.verify(input);
          restoreStore.close();
          return result;
        },
      },
    });
    expect(evidence.exportPortable()).toEqual({
      state: 'UNAVAILABLE',
      reason: 'revision_unavailable',
    });
    expect(
      evidence.reader().resolve({
        scope,
        revisionId: `revision-evidence-v1:${'1'.repeat(64)}`,
      }),
    ).toMatchObject({ state: 'UNAVAILABLE' });
  });

  test('a reentrant attest close refuses freeze before persistence', () => {
    const path = databasePath();
    const grants = new Map([['request-1', scope]]);
    const base = authority(grants);
    const store = new EventStore(path);
    const evidence = store.createRevisionEvidenceModule({
      attribution: {
        ...base,
        attest: (input) => {
          const result = base.attest(input);
          store.close();
          return result;
        },
      },
    });
    expect(
      evidence.freeze({
        snapshot: settledSnapshot(),
        parents: [],
        requestId: 'request-1',
      }),
    ).toEqual({ outcome: 'rejected', reason: 'persistence_unavailable' });
    expect(receiptCount(path)).toBe(0);
    expect(evidence.exportPortable()).toEqual({
      state: 'UNAVAILABLE',
      reason: 'revision_unavailable',
    });
  });

  test('a post-commit reentrant close returns unavailable without caching and remains recoverable', () => {
    const path = databasePath();
    const grants = new Map([['request-1', scope]]);
    const store = new EventStore(path);
    const evidence = store.createRevisionEvidenceModule({
      attribution: authority(grants),
      afterPersistCommitOnce: () => {
        store.close();
      },
    });
    const snapshot = settledSnapshot(scope, 'committed-before-close');
    const expected = new RevisionEvidenceModule({
      attribution: authority(grants),
    }).freeze({ snapshot, parents: [], requestId: 'request-1' });
    expect(expected.outcome).toBe('committed');
    if (expected.outcome !== 'committed') throw new Error('expected identity');
    expect(
      evidence.freeze({ snapshot, parents: [], requestId: 'request-1' }),
    ).toEqual({
      outcome: 'rejected',
      reason: 'persistence_unavailable',
    });
    expect(receiptCount(path)).toBe(1);
    expect(
      evidence
        .reader()
        .resolve({ scope, revisionId: expected.revision.revisionId }),
    ).toEqual({
      state: 'UNAVAILABLE',
      reason: 'revision_unavailable',
      revisionId: expected.revision.revisionId,
    });

    const recoveredStore = new EventStore(path);
    const recovered = recoveredStore.createRevisionEvidenceModule({
      attribution: authority(grants),
    });
    expect(
      recovered.resolveEvidence({
        revisionId: expected.revision.revisionId,
        verification: 'verified',
      }),
    ).toMatchObject({ state: 'AVAILABLE' });
    expect(recoveredStore.close()).toEqual({ kind: 'closed' });
  });

  test('a reentrant verify close rejects import without writing or retaining snapshots', () => {
    const path = databasePath();
    const grants = new Map([['request-1', scope]]);
    const base = authority(grants);
    const source = new RevisionEvidenceModule({ attribution: base });
    expect(
      source.freeze({
        snapshot: settledSnapshot(),
        parents: [],
        requestId: 'request-1',
      }).outcome,
    ).toBe('committed');
    const bundle = source.exportPortable();
    if ('state' in bundle) throw new Error('expected portable bundle');

    const store = new EventStore(path);
    const evidence = store.createRevisionEvidenceModule({
      attribution: {
        ...base,
        verify: (input) => {
          const result = base.verify(input);
          store.close();
          return result;
        },
      },
    });
    expect(evidence.importPortable(bundle)).toEqual({
      outcome: 'rejected',
      reason: 'persistence_unavailable',
    });
    expect(receiptCount(path)).toBe(0);
    expect(evidence.exportPortable()).toEqual({
      state: 'UNAVAILABLE',
      reason: 'revision_unavailable',
    });
  });

  test('a reentrant proposed-change lookup close cannot return AVAILABLE', () => {
    const path = databasePath();
    const grants = new Map([['request-1', scope]]);
    const store = new EventStore(path);
    const evidence = store.createRevisionEvidenceModule({
      attribution: authority(grants),
      proposedChanges: {
        find: () => {
          store.close();
          return undefined;
        },
      },
    });
    expect(
      evidence.resolveProposedChange({
        proposedChangeId: 'change-1',
        beforeRevisionId: `revision-evidence-v1:${'1'.repeat(64)}`,
        afterRevisionId: `revision-evidence-v1:${'2'.repeat(64)}`,
      }),
    ).toEqual({ state: 'UNAVAILABLE', reason: 'revision_unavailable' });
    expect(evidence.exportPortable()).toEqual({
      state: 'UNAVAILABLE',
      reason: 'revision_unavailable',
    });
  });
});
