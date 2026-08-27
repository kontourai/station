import { createHash } from 'node:crypto';
import { canonicalizeForDigest } from '@kontourai/station-contracts/fleet-routing-receipt';
import type { ProposedChange } from '@kontourai/station-contracts/proposed-change';
import { describe, expect, test } from 'vitest';
import {
  type EvidenceRevisionId,
  type RevisionAttributionAuthority,
  type RevisionAttributionBinding,
  RevisionEvidenceModule,
} from '../revision-bound-evidence.js';
import {
  type InsertTextOperation,
  SHARED_WORKING_STATE_SCHEMA_VERSION,
  SharedWorkingState,
  type WorkingStateScope,
  type WorkingStateWriteAuthorization,
} from '../shared-working-state.js';

const scope: WorkingStateScope = {
  projectId: 'project-1',
  taskId: 'task-1',
  documentId: 'document-1',
};
const authoritativeActor = { actorId: 'server-actor', kind: 'agent' as const };

function authorization(forScope = scope): WorkingStateWriteAuthorization {
  return {
    scope: forScope,
    epoch: 1,
    allowedActorIds: new Set(['actor-1', 'actor-2']),
  };
}

function insert(
  operationId: string,
  actorId: string,
  text: string,
  forScope = scope,
  parents: readonly string[] = [],
  after: string | null = null,
): InsertTextOperation {
  return {
    schemaVersion: SHARED_WORKING_STATE_SCHEMA_VERSION,
    operationId,
    documentId: forScope.documentId,
    replicaId: `replica-${actorId}`,
    actor: { actorId, kind: actorId === 'actor-1' ? 'human' : 'agent' },
    parents,
    authorizationEpoch: 1,
    kind: 'insert',
    after,
    text,
  };
}

interface ServerAttribution {
  readonly scope: WorkingStateScope;
  readonly actor?: typeof authoritativeActor;
  readonly agentSessionId?: string;
  readonly runId?: string;
  readonly proposedChangeId?: string;
}

function authority(
  grants: Map<string, ServerAttribution>,
  options: { nondeterministicAttestations?: boolean } = {},
): RevisionAttributionAuthority {
  let nonce = 0;
  const receipt = ({
    revisionId,
    parents,
    scope,
    sharedRevision,
    actor,
    correlation,
    canonicalPayload,
  }: RevisionAttributionBinding) =>
    `attestation-v1:${createHash('sha256')
      .update(
        JSON.stringify(
          canonicalizeForDigest({
            revisionId,
            parents,
            scope,
            sharedRevision,
            actor,
            correlation,
            canonicalPayload,
          }),
        ),
      )
      .digest('hex')}`;
  return {
    resolve: ({ scope: resolvedScope, requestId }) => {
      const grant = grants.get(requestId);
      if (!grant || grant.scope.documentId !== resolvedScope.documentId)
        return { outcome: 'unavailable' };
      const actor = grant.actor ?? authoritativeActor;
      const correlation = {
        projectId: grant.scope.projectId,
        taskId: grant.scope.taskId,
        ...(grant.agentSessionId === undefined
          ? {}
          : { agentSessionId: grant.agentSessionId }),
        ...(grant.runId === undefined ? {} : { runId: grant.runId }),
        ...(grant.proposedChangeId === undefined
          ? {}
          : { proposedChangeId: grant.proposedChangeId }),
      };
      return {
        outcome: 'resolved',
        actor,
        correlation,
      };
    },
    attest: (input) => ({
      outcome: 'attested',
      attestation: `${receipt(input)}:${
        options.nondeterministicAttestations ? ++nonce : 'stable'
      }`,
    }),
    verify: (input) => ({
      outcome: input.attestation.startsWith(`${receipt(input)}:`)
        ? 'verified'
        : 'unavailable',
    }),
  };
}

function ledger(grants: Map<string, ServerAttribution>, options = {}) {
  return new RevisionEvidenceModule({
    attribution: authority(grants),
    ...options,
  });
}

function grant(
  grants: Map<string, ServerAttribution>,
  requestId: string,
  forScope: WorkingStateScope,
  proposedChangeId?: string,
) {
  grants.set(requestId, {
    scope: forScope,
    agentSessionId: 'session-1',
    runId: 'run-1',
    ...(proposedChangeId ? { proposedChangeId } : {}),
  });
}

function commit(
  grants: Map<string, ServerAttribution>,
  target: RevisionEvidenceModule,
  state: SharedWorkingState,
  requestId: string,
  parents: readonly EvidenceRevisionId[] = [],
  proposedChangeId?: string,
) {
  grant(grants, requestId, state.scope, proposedChangeId);
  const outcome = target.freeze({
    snapshot: state.snapshot(),
    parents,
    requestId,
    // These forged fields are deliberately ignored by the implementation.
    actor: { actorId: 'forged', kind: 'human' },
    correlation: { projectId: 'forged', taskId: 'forged', runId: 'forged' },
  });
  expect(outcome.outcome).toBe('committed');
  if (outcome.outcome !== 'committed') throw new Error('expected commit');
  return outcome.revision;
}

function proposedChange(
  status: ProposedChange['status'],
  content = { before: 'before', after: 'before after' },
): ProposedChange {
  return {
    id: 'change-1',
    sessionId: 'session-1',
    projectId: scope.projectId,
    path: '/owned-by-proposed-change-service',
    changeType: 'modify',
    contentKind: 'text',
    baseSnapshot: { content: content.before, hash: 'base-hash' },
    proposedSnapshot: { content: content.after, hash: 'proposed-hash' },
    createdAt: '2026-08-16T00:00:00.000Z',
    updatedAt: '2026-08-16T00:00:00.000Z',
    sourceRuntime: 'station',
    status,
    decisions:
      status === 'pending'
        ? []
        : [
            {
              id: 'decision-1',
              changeId: 'change-1',
              decision: status,
              reason: 'human reviewed exact immutable content',
              actorType: 'human',
              actorId: 'reviewer-1',
              decidedAt: '2026-08-16T00:00:00.000Z',
            },
          ],
    ...(status === 'superseded' ? { supersededById: 'change-2' } : {}),
  };
}

describe('RevisionEvidenceModule', () => {
  test('rebuilds a canonical settled snapshot, strips caller fields, and stores authority attribution', () => {
    const grants = new Map<string, ServerAttribution>();
    const left = new SharedWorkingState({ scope });
    const right = new SharedWorkingState({ scope });
    for (const operation of [
      insert('op-z', 'actor-1', 'Z'),
      insert('op-ä', 'actor-2', 'A'),
    ])
      left.apply(operation, authorization());
    for (const operation of [
      insert('op-ä', 'actor-2', 'A'),
      insert('op-z', 'actor-1', 'Z'),
    ])
      right.apply(operation, authorization());
    const reversed = structuredClone(right.snapshot()) as unknown as {
      atoms: unknown[];
      knownOperations: unknown[];
      scope: WorkingStateScope & { path: string };
    };
    reversed.atoms.reverse();
    reversed.knownOperations.reverse();
    reversed.scope.path = '/Users/private/path';
    grant(grants, 'left', scope);
    grant(grants, 'right', scope);
    const first = ledger(grants).freeze({
      snapshot: left.snapshot(),
      parents: [],
      requestId: 'left',
      actor: { actorId: 'forged', kind: 'human' },
      correlation: { projectId: 'forged', taskId: 'forged' },
    });
    const second = ledger(grants).freeze({
      snapshot: reversed,
      parents: [],
      requestId: 'right',
      actor: { actorId: 'forged-2', kind: 'human', hidden: 'ignored' },
      correlation: {
        projectId: 'forged',
        taskId: 'forged',
        workingDirectory: '/secret',
      },
    });
    expect(first).toMatchObject({ outcome: 'committed' });
    expect(second).toMatchObject({ outcome: 'committed' });
    if (first.outcome !== 'committed' || second.outcome !== 'committed')
      throw new Error('expected commits');
    expect(second.revision.revisionId).toBe(first.revision.revisionId);
    expect(first.revision.actor).toEqual(authoritativeActor);
    expect(first.revision.correlation).toMatchObject({
      agentSessionId: 'session-1',
      runId: 'run-1',
    });
    expect(JSON.stringify(first.revision)).not.toContain('forged');
    expect(JSON.stringify(first.revision)).not.toContain('private');
  });

  test('keeps revision identity deterministic while authorities issue distinct valid attestations', () => {
    const grants = new Map<string, ServerAttribution>();
    const state = new SharedWorkingState({ scope });
    state.apply(insert('op-a', 'actor-1', 'attested'), authorization());
    const nondeterministicAuthority = authority(grants, {
      nondeterministicAttestations: true,
    });
    const firstSource = new RevisionEvidenceModule({
      attribution: nondeterministicAuthority,
    });
    const secondSource = new RevisionEvidenceModule({
      attribution: nondeterministicAuthority,
    });
    const first = commit(grants, firstSource, state, 'first');
    const second = commit(grants, secondSource, state, 'second');
    expect(first.revisionId).toBe(second.revisionId);
    expect(first.attributionAttestation).not.toBe(
      second.attributionAttestation,
    );
    const bundle = firstSource.exportPortable();
    if ('state' in bundle) throw new Error('expected portable bundle');
    expect(ledger(grants).importPortable(bundle)).toEqual({
      outcome: 'imported',
      revisions: 1,
    });
    const tamperedId = structuredClone(bundle);
    (tamperedId.revisions[0] as { revisionId: EvidenceRevisionId }).revisionId =
      'revision-evidence-v1:0000000000000000000000000000000000000000000000000000000000000000';
    expect(ledger(grants).importPortable(tamperedId)).toEqual({
      outcome: 'rejected',
      reason: 'identity_collision',
    });
    const tamperedParents = structuredClone(bundle);
    (
      tamperedParents.revisions[0] as unknown as {
        parents: EvidenceRevisionId[];
      }
    ).parents = [
      'revision-evidence-v1:0000000000000000000000000000000000000000000000000000000000000000',
    ];
    expect(ledger(grants).importPortable(tamperedParents)).toEqual({
      outcome: 'rejected',
      reason: 'identity_collision',
    });
  });

  test('rejects missing or mismatched server attribution and deferred snapshots', () => {
    const grants = new Map<string, ServerAttribution>();
    const state = new SharedWorkingState({ scope });
    state.apply(insert('op-a', 'actor-1', 'safe'), authorization());
    expect(
      new RevisionEvidenceModule().freeze({
        snapshot: state.snapshot(),
        parents: [],
        requestId: 'none',
      }),
    ).toEqual({ outcome: 'rejected', reason: 'attribution_unavailable' });
    grants.set('wrong', { scope: { ...scope, taskId: 'other' } });
    expect(
      ledger(grants).freeze({
        snapshot: state.snapshot(),
        parents: [],
        requestId: 'wrong',
      }),
    ).toEqual({ outcome: 'rejected', reason: 'attribution_mismatch' });
    const deferred = new SharedWorkingState({ scope });
    deferred.apply(
      insert('child', 'actor-1', 'c', scope, ['root'], 'root:0'),
      authorization(),
    );
    grant(grants, 'deferred', scope);
    expect(
      ledger(grants).freeze({
        snapshot: deferred.snapshot(),
        parents: [],
        requestId: 'deferred',
      }),
    ).toEqual({ outcome: 'rejected', reason: 'pending_state' });
  });

  test('requires exact scope for parents and freezes only bounded authority-derived records', () => {
    const grants = new Map<string, ServerAttribution>();
    const otherScope = { ...scope, documentId: 'document-2' };
    const other = new SharedWorkingState({ scope: otherScope });
    other.apply(
      insert('other', 'actor-1', 'x', otherScope),
      authorization(otherScope),
    );
    const target = ledger(grants);
    const parent = commit(grants, target, other, 'other');
    const current = new SharedWorkingState({ scope });
    current.apply(insert('current', 'actor-1', 'four'), authorization());
    grant(grants, 'current', scope);
    expect(
      target.freeze({
        snapshot: current.snapshot(),
        parents: [parent.revisionId],
        requestId: 'current',
      }),
    ).toEqual({ outcome: 'rejected', reason: 'wrong_scope' });
    expect(
      ledger(grants, { maxTextBytes: 3 }).freeze({
        snapshot: current.snapshot(),
        parents: [],
        requestId: 'current',
      }),
    ).toEqual({ outcome: 'rejected', reason: 'capacity_exceeded' });
  });

  test('derives an available diff only from approved canonical change content, ancestry, and authority links', () => {
    const grants = new Map<string, ServerAttribution>();
    let canonical = proposedChange('pending');
    const target = ledger(grants, {
      proposedChanges: {
        find: () => canonical,
        runIdFor: () => 'run-1',
      },
    });
    const state = new SharedWorkingState({ scope });
    state.apply(insert('op-a', 'actor-1', 'before'), authorization());
    const before = commit(grants, target, state, 'before', [], 'change-1');
    state.apply(insert('op-b', 'actor-2', ' after'), authorization());
    const after = commit(
      grants,
      target,
      state,
      'after',
      [before.revisionId],
      'change-1',
    );
    const binding = {
      proposedChangeId: 'change-1',
      beforeRevisionId: before.revisionId,
      afterRevisionId: after.revisionId,
    };
    expect(target.resolveProposedChange(binding)).toEqual({
      state: 'UNVERIFIED',
      reason: 'proposed_change_pending',
    });
    canonical = proposedChange('approved');
    expect(target.resolveProposedChange(binding)).toMatchObject({
      state: 'AVAILABLE',
      change: {
        status: 'approved',
        sessionId: 'session-1',
        baseSnapshot: { hash: 'base-hash' },
        proposedSnapshot: { hash: 'proposed-hash' },
        decision: {
          decision: 'approved',
          reason: 'human reviewed exact immutable content',
        },
      },
      diff: { removed: '', added: ' after' },
    });
    canonical = new Proxy(proposedChange('approved'), {
      get(target, property, receiver) {
        if (property === 'decisions')
          return [target.decisions[0], target.decisions[0]];
        return Reflect.get(target, property, receiver);
      },
    });
    expect(target.resolveProposedChange(binding)).toEqual({
      state: 'UNVERIFIED',
      reason: 'malformed_proposed_change',
    });
    canonical = proposedChange('rejected');
    expect(target.resolveProposedChange(binding)).toEqual({
      state: 'UNAVAILABLE',
      reason: 'proposed_change_rejected',
    });
  });

  test('rejects unrelated ancestors, correlation/session/run, and canonical content mismatch', () => {
    const grants = new Map<string, ServerAttribution>();
    const target = ledger(grants, {
      proposedChanges: {
        find: () => proposedChange('approved'),
        runIdFor: () => 'run-1',
      },
    });
    const state = new SharedWorkingState({ scope });
    state.apply(insert('one', 'actor-1', 'before'), authorization());
    const before = commit(grants, target, state, 'one', [], 'other-change');
    state.apply(insert('two', 'actor-2', ' after'), authorization());
    const after = commit(
      grants,
      target,
      state,
      'two',
      [before.revisionId],
      'other-change',
    );
    expect(
      target.resolveProposedChange({
        proposedChangeId: 'change-1',
        beforeRevisionId: before.revisionId,
        afterRevisionId: after.revisionId,
      }),
    ).toEqual({ state: 'UNVERIFIED', reason: 'binding_mismatch' });
    const unrelated = new SharedWorkingState({ scope });
    unrelated.apply(
      insert('unrelated', 'actor-1', 'before after'),
      authorization(),
    );
    const unrelatedRevision = commit(
      grants,
      target,
      unrelated,
      'unrelated',
      [],
      'change-1',
    );
    expect(
      target.resolveProposedChange({
        proposedChangeId: 'change-1',
        beforeRevisionId: before.revisionId,
        afterRevisionId: unrelatedRevision.revisionId,
      }),
    ).toEqual({ state: 'UNVERIFIED', reason: 'binding_mismatch' });
  });

  test('uses create/delete null snapshot semantics without inventing hash semantics', () => {
    const grants = new Map<string, ServerAttribution>();
    let canonical = proposedChange('approved', {
      before: '',
      after: 'created',
    });
    canonical = {
      ...canonical,
      changeType: 'create',
      baseSnapshot: { content: '', hash: 'not-null-base' },
    };
    const target = ledger(grants, {
      proposedChanges: { find: () => canonical },
    });
    const state = new SharedWorkingState({ scope });
    const before = commit(grants, target, state, 'empty', [], 'change-1');
    state.apply(insert('created', 'actor-1', 'created'), authorization());
    const after = commit(
      grants,
      target,
      state,
      'created',
      [before.revisionId],
      'change-1',
    );
    expect(
      target.resolveProposedChange({
        proposedChangeId: 'change-1',
        beforeRevisionId: before.revisionId,
        afterRevisionId: after.revisionId,
      }),
    ).toEqual({ state: 'UNVERIFIED', reason: 'binding_mismatch' });
    canonical = { ...canonical, baseSnapshot: null };
    expect(
      target.resolveProposedChange({
        proposedChangeId: 'change-1',
        beforeRevisionId: before.revisionId,
        afterRevisionId: after.revisionId,
      }),
    ).toMatchObject({ state: 'AVAILABLE', change: { baseSnapshot: null } });
    canonical = {
      ...proposedChange('approved', { before: 'created', after: '' }),
      changeType: 'delete',
      proposedSnapshot: { content: '', hash: 'not-null-proposed' },
    };
    state.apply(
      {
        schemaVersion: SHARED_WORKING_STATE_SCHEMA_VERSION,
        operationId: 'deleted',
        documentId: scope.documentId,
        replicaId: 'replica-actor-1',
        actor: { actorId: 'actor-1', kind: 'human' },
        parents: ['created'],
        authorizationEpoch: 1,
        kind: 'delete',
        target: [
          'created:0',
          'created:1',
          'created:2',
          'created:3',
          'created:4',
          'created:5',
          'created:6',
        ],
      },
      authorization(),
    );
    const deleted = commit(
      grants,
      target,
      state,
      'deleted',
      [after.revisionId],
      'change-1',
    );
    expect(
      target.resolveProposedChange({
        proposedChangeId: 'change-1',
        beforeRevisionId: after.revisionId,
        afterRevisionId: deleted.revisionId,
      }),
    ).toEqual({ state: 'UNVERIFIED', reason: 'binding_mismatch' });
    canonical = { ...canonical, proposedSnapshot: null };
    expect(
      target.resolveProposedChange({
        proposedChangeId: 'change-1',
        beforeRevisionId: after.revisionId,
        afterRevisionId: deleted.revisionId,
      }),
    ).toMatchObject({
      state: 'AVAILABLE',
      change: { proposedSnapshot: null },
    });
  });

  test('bounds entry count before structural traversal and keeps portable imports defensive', () => {
    const grants = new Map<string, ServerAttribution>();
    const state = new SharedWorkingState({ scope });
    state.apply(insert('op-a', 'actor-1', 'portable'), authorization());
    const source = ledger(grants);
    const revision = commit(grants, source, state, 'portable');
    const bundle = source.exportPortable();
    if ('state' in bundle) throw new Error('expected portable bundle');
    expect(
      ledger(grants, { maxImportEntries: 1 }).importPortable({
        ...bundle,
        revisions: [bundle.revisions[0], bundle.revisions[0]],
      }),
    ).toEqual({ outcome: 'rejected', reason: 'capacity_exceeded' });
    const escaped = {
      schemaVersion: 1,
      revisions: [{ text: '\u0000"\\'.repeat(40) }],
    };
    const exactBytes = Buffer.byteLength(JSON.stringify(escaped), 'utf8');
    expect(
      ledger(grants, { maxImportBytes: exactBytes - 1 }).importPortable(
        escaped,
      ),
    ).toEqual({ outcome: 'rejected', reason: 'capacity_exceeded' });
    const nulEscapes = '\u0000'.repeat(50);
    const hugeRaw = 'x'.repeat(100_000);
    const siblingFirst = 'a'.repeat(60);
    const siblingHuge = 'y'.repeat(100_000);
    const originalCharCodeAt = String.prototype.charCodeAt;
    let nulReads = 0;
    let rawReads = 0;
    let siblingFirstReads = 0;
    let siblingHugeReads = 0;
    String.prototype.charCodeAt = function instrumentedCharCodeAt(
      index: number,
    ): number {
      const receiver = this.valueOf();
      if (receiver === nulEscapes) nulReads += 1;
      if (receiver === hugeRaw) rawReads += 1;
      if (receiver === siblingFirst) siblingFirstReads += 1;
      if (receiver === siblingHuge) siblingHugeReads += 1;
      return originalCharCodeAt.call(this, index);
    };
    try {
      expect(
        ledger(grants, { maxImportBytes: 100 }).importPortable({
          schemaVersion: 1,
          revisions: [{ text: nulEscapes }],
        }),
      ).toEqual({ outcome: 'rejected', reason: 'capacity_exceeded' });
      expect(nulReads).toBeLessThan(50);
      expect(
        ledger(grants, { maxImportBytes: 128 }).importPortable({
          schemaVersion: 1,
          revisions: [{ text: hugeRaw }],
        }),
      ).toEqual({ outcome: 'rejected', reason: 'capacity_exceeded' });
      expect(rawReads).toBeLessThanOrEqual(128);
      expect(
        ledger(grants, { maxImportBytes: 100 }).importPortable({
          schemaVersion: 1,
          revisions: [siblingFirst, siblingHuge],
        }),
      ).toEqual({ outcome: 'rejected', reason: 'capacity_exceeded' });
      expect(siblingFirstReads).toBe(60);
      expect(siblingFirstReads + siblingHugeReads).toBeLessThanOrEqual(100);
      expect(siblingHugeReads).toBeLessThan(40);
    } finally {
      String.prototype.charCodeAt = originalCharCodeAt;
    }
    const sparse = {
      schemaVersion: 1,
      revisions: new Array(2),
    };
    const sparseBytes = Buffer.byteLength(JSON.stringify(sparse), 'utf8');
    expect(
      ledger(grants, { maxImportBytes: sparseBytes - 1 }).importPortable(
        sparse,
      ),
    ).toEqual({ outcome: 'rejected', reason: 'capacity_exceeded' });
    let numericReads = 0;
    const oversized = new Proxy(new Array(4_097), {
      get(target, property, receiver) {
        if (/^\d+$/.test(String(property))) numericReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    expect(
      ledger(grants, { maxImportEntries: 4_097 }).importPortable({
        schemaVersion: 1,
        revisions: oversized,
      }),
    ).toEqual({ outcome: 'rejected', reason: 'capacity_exceeded' });
    expect(numericReads).toBe(0);
    const recovered = ledger(grants);
    expect(recovered.importPortable(bundle)).toEqual({
      outcome: 'imported',
      revisions: 1,
    });
    expect(
      recovered.resolveEvidence({
        revisionId: revision.revisionId,
        verification: 'verified',
      }),
    ).toMatchObject({ state: 'AVAILABLE' });
    const forged = structuredClone(bundle) as any;
    const record = forged.revisions[0];
    record.actor.actorId = 'forged-actor';
    record.correlation.agentSessionId = 'forged-session';
    record.correlation.runId = 'forged-run';
    record.revisionId = `revision-evidence-v1:${createHash('sha256')
      .update(
        JSON.stringify(
          canonicalizeForDigest({
            schemaVersion: 1,
            sharedRevision: record.sharedRevision,
            scope: record.scope,
            snapshot: record.snapshot,
            actor: record.actor,
            parents: record.parents,
            correlation: record.correlation,
          }),
        ),
      )
      .digest('hex')}`;
    expect(ledger(grants).importPortable(forged)).toEqual({
      outcome: 'rejected',
      reason: 'attribution_unverified',
    });
    expect(new RevisionEvidenceModule().importPortable(bundle)).toEqual({
      outcome: 'rejected',
      reason: 'attribution_unverified',
    });
  });
});
