import type { KnowledgeLearningProjection } from '@kontourai/flow-agents/knowledge-learning-contract';

export const scope = { kind: 'project' as const, id: 'project-id' };
export const evidence = {
  authority: 'station',
  kind: 'task-standing',
  id: 'task/decision/key',
  revision: '3',
};
export const proposal: Extract<
  KnowledgeLearningProjection,
  { state: 'available' }
> = {
  state: 'available',
  active: false,
  record: {
    id: 'learning-one',
    revision: 1,
    contentRevision: 'c'.repeat(64),
    createdAt: '2026-10-30T10:00:00.000Z',
    effects: [],
    proposal: {
      kind: 'guideline',
      title: 'Keep evidence',
      body: 'Proposed guidance',
      expectedEffect: 'Fewer lost receipts',
      scope,
      supporting: [evidence],
      counter: [],
      conflicts: [],
      targets: [{ ...evidence, kind: 'project-context', id: scope.id }],
    },
  },
  receipts: [
    {
      id: 'receipt-propose',
      intentId: 'intent-propose',
      requestDigest: 'd'.repeat(64),
      learningId: 'learning-one',
      revision: 1,
      action: 'propose',
      actorId: 'person:reviewer',
      at: '2026-10-30T10:00:00.000Z',
    },
  ],
};

export function activatedLearningProjection() {
  const active = structuredClone(proposal);
  active.active = true;
  active.record.revision = 4;
  active.record.evaluation = {
    status: 'supported',
    evidence: [evidence],
    receiptId: 'active-evaluate',
  };
  active.record.decision = {
    status: 'approved',
    rationale: 'Reviewed',
    receiptId: 'active-approve',
  };
  active.record.activation = {
    revision: active.record.contentRevision,
    targets: active.record.proposal.targets,
    receiptId: 'active-activate',
  };
  active.receipts = (
    ['propose', 'evaluate', 'approve', 'activate'] as const
  ).map((action, index) => ({
    ...proposal.receipts[0]!,
    id: `active-${action}`,
    intentId: `active-${action}`,
    revision: index + 1,
    action,
  }));
  return active;
}
