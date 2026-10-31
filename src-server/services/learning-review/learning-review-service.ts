import type {
  KnowledgeLearningIntent,
  KnowledgeLearningProjection,
  KnowledgeLearningReceipt,
  KnowledgeLearningRef,
  KnowledgeLearningScope,
} from '@kontourai/flow-agents/knowledge-learning-contract';
import type {
  LearningReviewDetail,
  LearningReviewIndex,
  LearningReviewIntentInput,
  LearningReviewMutationResult,
  LearningReviewProjection,
  LearningReviewProposalInput,
  LearningReviewReceiptView,
  LearningReviewSourceSelection,
} from '@kontourai/station-contracts/learning-review';

export interface LearningLifecycleOwnerPort {
  version: string;
  authority: string;
  get(scope: KnowledgeLearningScope, id: string): Promise<KnowledgeLearningProjection>;
  list(scope: KnowledgeLearningScope): Promise<{ records: KnowledgeLearningProjection[]; coverage: 'complete' | 'partial' | 'unavailable' }>;
  apply(intent: KnowledgeLearningIntent): Promise<KnowledgeLearningReceipt>;
}
export interface LearningProposalSource {
  scope: KnowledgeLearningScope;
  supporting: KnowledgeLearningRef[];
  counter: KnowledgeLearningRef[];
  conflicts: KnowledgeLearningRef[];
  targets: KnowledgeLearningRef[];
}

/** A request-bound adapter; all storage, decision and activation authority stays with Knowledge Kit. */
export class LearningReviewService {
  constructor(
    private readonly owner: LearningLifecycleOwnerPort,
    private readonly source: (selection: LearningReviewSourceSelection, scope: KnowledgeLearningScope) => Promise<LearningProposalSource | undefined>,
  ) {}

  private receipt(receipt: KnowledgeLearningReceipt): LearningReviewReceiptView {
    return { ref: { authority: this.owner.authority, kind: 'learning-receipt', id: receipt.id, revision: String(receipt.revision) },
      action: receipt.action, actorId: receipt.actorId, at: receipt.at };
  }

  private project(value: KnowledgeLearningProjection, scope: KnowledgeLearningScope): LearningReviewDetail {
    if (value.state !== 'available') return { state: value.state === 'not-found' ? 'not-captured' : value.state };
    const { record, receipts, active } = value;
    if (active && (!record.activation || record.decision?.status !== 'approved' || record.activation.revision !== record.contentRevision || record.retirement || record.supersededBy))
      return { state: 'corrupt' };
    if (record.proposal.scope.kind !== scope.kind || record.proposal.scope.id !== scope.id) return { state: 'restricted' };
    const ref = (id: string, revision: string, kind = 'learning') => ({ authority: this.owner.authority, kind, id, revision });
    const stageReceipt = (id: string) => receipts.find(receipt => receipt.id === id && receipt.learningId === record.id);
    const available = <const T>(data: T) => ({ state: 'available' as const, value: data });
    const gap = { state: 'not-captured' as const };
    const evaluation = record.evaluation && stageReceipt(record.evaluation.receiptId);
    const decision = record.decision && stageReceipt(record.decision.receiptId);
    const activation = record.activation && stageReceipt(record.activation.receiptId);
    const retirement = record.retirement && stageReceipt(record.retirement.receiptId);
    if ((record.evaluation && !evaluation) || (record.decision && !decision) ||
      (record.activation && !activation) || (record.retirement && !retirement) ||
      record.effects.some(effect => !stageReceipt(effect.receiptId))) return { state: 'corrupt' };
    const receiptRef = (receipt: KnowledgeLearningReceipt) => this.receipt(receipt).ref;
    const projection: LearningReviewProjection = {
      schemaVersion: 'station.learning-review/v1', projectionId: record.id,
      owner: ref(record.id, String(record.revision)), scope: record.proposal.scope,
      source: gap,
      candidate: available({ candidateRef: ref(record.id, String(record.revision)), kind: record.proposal.kind,
        title: record.proposal.title, expectedEffect: record.proposal.expectedEffect, scope: record.proposal.scope,
        proposedRevisionRef: ref(record.id, record.contentRevision), supportingRefs: record.proposal.supporting,
        counterRefs: record.proposal.counter, conflictRefs: record.proposal.conflicts, deploymentTargets: record.proposal.targets,
        freshness: { state: 'unknown', ownerUpdatedAt: receipts.at(-1)?.at, observedAt: new Date().toISOString() } }),
      evaluation: record.evaluation && evaluation ? available({ evaluationRef: receiptRef(evaluation), status: record.evaluation.status,
        evidenceRefs: record.evaluation.evidence, evaluatedAt: evaluation.at }) : gap,
      decision: record.decision && decision ? available({ status: record.decision.status, decisionRef: receiptRef(decision),
        receiptRef: receiptRef(decision), decidedAt: decision.at }) : available({ status: 'proposed' }),
      activation: record.activation && activation && (active || record.supersededBy) ? available({
        status: record.supersededBy ? 'superseded' : 'active', activeRevisionRef: ref(record.id, record.activation.revision),
        activatedAt: activation.at, deploymentTargets: record.activation.targets, contributionDisclosures: [],
      }) : available({ status: 'inactive', deploymentTargets: record.proposal.targets, contributionDisclosures: [] }),
      effect: available({ observations: record.effects.map(effect => ({ observationRef: effect.evidence,
        assessment: effect.assessment, observedAt: stageReceipt(effect.receiptId)!.at })) }),
      retirement: record.retirement && retirement ? available({ status: 'retired', retirementRef: receiptRef(retirement),
        receiptRef: receiptRef(retirement), retiredAt: retirement.at, reason: record.retirement.reason }) : available({ status: 'not-retired' }),
    };
    return { state: 'available', id: record.id, revision: record.revision, active, body: record.proposal.body,
      projection, receipts: receipts.map(receipt => this.receipt(receipt)),
      ...(record.supersededBy ? { supersededBy: ref(record.supersededBy.id, record.supersededBy.revision) } : {}) };
  }

  async list(scope: KnowledgeLearningScope): Promise<LearningReviewIndex> {
    if (this.owner.version !== 'knowledge.learning/v1') return { state: 'unsupported-version' };
    const result = await this.owner.list(scope);
    if (result.coverage === 'unavailable') return { state: 'unavailable' };
    const items = result.records.map(item => this.project(item, scope));
    return { state: 'available', items, coverage: result.coverage === 'partial' || items.some(item => item.state !== 'available') ? 'partial' : 'complete' };
  }

  async get(scope: KnowledgeLearningScope, id: string, compareId?: string): Promise<LearningReviewDetail> {
    if (this.owner.version !== 'knowledge.learning/v1') return { state: 'unsupported-version' };
    const detail = this.project(await this.owner.get(scope, id), scope);
    if (detail.state !== 'available' || !compareId || compareId === id) return detail;
    const comparison = this.project(await this.owner.get(scope, compareId), scope);
    if (comparison.state !== 'available') return { ...detail, comparison: { state: comparison.state } };
    if (comparison.projection.candidate.state !== 'available') return { ...detail, comparison: { state: 'corrupt' } };
    return { ...detail, comparison: { state: 'available', ref: comparison.projection.candidate.value.proposedRevisionRef!,
      title: comparison.projection.candidate.value.title, body: comparison.body, active: comparison.active } };
  }

  async propose(scope: KnowledgeLearningScope, input: LearningReviewProposalInput): Promise<LearningReviewMutationResult> {
    if (this.owner.version !== 'knowledge.learning/v1') throw new Error('Learning owner version unsupported');
    const source = await this.source(input.source, scope);
    if (!source || source.scope.kind !== scope.kind || source.scope.id !== scope.id) throw new Error('Learning source unavailable');
    const receipt = await this.owner.apply({ intentId: input.intentId, learningId: input.learningId, expectedRevision: 0,
      scope, action: 'propose', proposal: { kind: input.kind, title: input.title, body: input.body,
        expectedEffect: input.expectedEffect, scope, supporting: source.supporting, counter: source.counter,
        conflicts: source.conflicts, targets: source.targets } });
    return { receipt: this.receipt(receipt), detail: await this.get(scope, input.learningId) };
  }

  async apply(scope: KnowledgeLearningScope, id: string, input: LearningReviewIntentInput): Promise<LearningReviewMutationResult> {
    // The route's closed schema admits only owner intent fields, never host authority.
    if (this.owner.version !== 'knowledge.learning/v1') throw new Error('Learning owner version unsupported');
    const receipt = await this.owner.apply({ ...input, learningId: id, scope });
    return { receipt: this.receipt(receipt), detail: await this.get(scope, id) };
  }
}
