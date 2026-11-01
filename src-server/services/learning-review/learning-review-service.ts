import type {
  KnowledgeLearningIntent,
  KnowledgeLearningProjection,
  KnowledgeLearningReceipt,
  KnowledgeLearningRef,
  KnowledgeLearningScope,
} from '@kontourai/flow-agents/knowledge-learning-contract';
import type {
  LearningReviewContributionDisclosure,
  LearningReviewDetail,
  LearningReviewEvidenceView,
  LearningReviewIndex,
  LearningReviewIntentInput,
  LearningReviewMutationResult,
  LearningReviewPreparedSource,
  LearningReviewProjection,
  LearningReviewProposalInput,
  LearningReviewReceiptView,
  LearningReviewRevisionRef,
  LearningReviewSourceSelection,
} from '@kontourai/station-contracts/learning-review';

export interface LearningLifecycleOwnerPort {
  version: string;
  authority: string;
  get(
    scope: KnowledgeLearningScope,
    id: string,
  ): Promise<KnowledgeLearningProjection>;
  list(scope: KnowledgeLearningScope): Promise<{
    records: KnowledgeLearningProjection[];
    coverage: 'complete' | 'partial' | 'unavailable';
  }>;
  apply(intent: KnowledgeLearningIntent): Promise<KnowledgeLearningReceipt>;
}
export interface LearningProposalSource {
  scope: KnowledgeLearningScope;
  supporting: KnowledgeLearningRef[];
  counter: KnowledgeLearningRef[];
  conflicts: KnowledgeLearningRef[];
  targets: KnowledgeLearningRef[];
}

function requirePreparedSource(
  selection: LearningReviewSourceSelection,
  expected: LearningReviewRevisionRef | undefined,
  source: LearningProposalSource,
) {
  if (!expected && selection.kind !== 'rated-feedback') return;
  if (
    !expected ||
    !source.supporting.some(
      (reference) =>
        reference.authority === expected.authority &&
        reference.kind === expected.kind &&
        reference.id === expected.id &&
        reference.revision === expected.revision,
    )
  )
    throw Object.assign(
      new Error('Learning source changed. Prepare it again.'),
      { code: 'stale' },
    );
}

/** A request-bound adapter; all storage, decision and activation authority stays with Knowledge Kit. */
export class LearningReviewService {
  constructor(
    private readonly owner: LearningLifecycleOwnerPort,
    private readonly source: (
      selection: LearningReviewSourceSelection,
      scope: KnowledgeLearningScope,
    ) => Promise<LearningProposalSource | undefined>,
    private readonly inspectSource?: (
      reference: KnowledgeLearningRef,
      scope: KnowledgeLearningScope,
    ) => Promise<
      | {
          title: string;
          text: string;
          capturedAt?: string;
          truncated?: boolean;
        }
      | undefined
    >,
    private readonly contributions?: (
      scope: KnowledgeLearningScope,
      ref: LearningReviewRevisionRef,
    ) => Promise<LearningReviewContributionDisclosure[]>,
  ) {}

  private receipt(
    receipt: KnowledgeLearningReceipt,
  ): LearningReviewReceiptView {
    return {
      ref: {
        authority: this.owner.authority,
        kind: 'learning-receipt',
        id: receipt.id,
        revision: String(receipt.revision),
      },
      action: receipt.action,
      actorId: receipt.actorId,
      at: receipt.at,
    };
  }

  private project(
    value: KnowledgeLearningProjection,
    scope: KnowledgeLearningScope,
  ): LearningReviewDetail {
    if (value.state !== 'available')
      return {
        state: value.state === 'not-found' ? 'not-captured' : value.state,
      };
    const { record, receipts, active } = value;
    if (
      active &&
      (!record.activation ||
        record.decision?.status !== 'approved' ||
        record.activation.revision !== record.contentRevision ||
        record.retirement ||
        record.supersededBy)
    )
      return { state: 'corrupt' };
    if (
      record.proposal.scope.kind !== scope.kind ||
      record.proposal.scope.id !== scope.id
    )
      return { state: 'restricted' };
    const ref = (id: string, revision: string, kind = 'learning') => ({
      authority: this.owner.authority,
      kind,
      id,
      revision,
    });
    const stageReceipt = (id: string) =>
      receipts.find(
        (receipt) => receipt.id === id && receipt.learningId === record.id,
      );
    const available = <const T>(data: T) => ({
      state: 'available' as const,
      value: data,
    });
    const gap = { state: 'not-captured' as const };
    const evaluation =
      record.evaluation && stageReceipt(record.evaluation.receiptId);
    const decision = record.decision && stageReceipt(record.decision.receiptId);
    const activation =
      record.activation && stageReceipt(record.activation.receiptId);
    const retirement =
      record.retirement && stageReceipt(record.retirement.receiptId);
    if (
      (record.evaluation && !evaluation) ||
      (record.decision && !decision) ||
      (record.activation && !activation) ||
      (record.retirement && !retirement) ||
      record.effects.some((effect) => !stageReceipt(effect.receiptId))
    )
      return { state: 'corrupt' };
    const receiptRef = (receipt: KnowledgeLearningReceipt) =>
      this.receipt(receipt).ref;
    const projection: LearningReviewProjection = {
      schemaVersion: 'station.learning-review/v1',
      projectionId: record.id,
      owner: ref(record.id, String(record.revision)),
      scope: record.proposal.scope,
      source: gap,
      candidate: available({
        candidateRef: ref(record.id, String(record.revision)),
        kind: record.proposal.kind,
        title: record.proposal.title,
        expectedEffect: record.proposal.expectedEffect,
        scope: record.proposal.scope,
        proposedRevisionRef: ref(record.id, record.contentRevision),
        supportingRefs: record.proposal.supporting,
        counterRefs: record.proposal.counter,
        conflictRefs: record.proposal.conflicts,
        deploymentTargets: record.proposal.targets,
        freshness: {
          state: 'unknown',
          ownerUpdatedAt: receipts.at(-1)?.at,
          observedAt: new Date().toISOString(),
        },
      }),
      evaluation:
        record.evaluation && evaluation
          ? available({
              evaluationRef: receiptRef(evaluation),
              status: record.evaluation.status,
              evidenceRefs: record.evaluation.evidence,
              evaluatedAt: evaluation.at,
            })
          : gap,
      decision:
        record.decision && decision
          ? available({
              status: record.decision.status,
              decisionRef: receiptRef(decision),
              receiptRef: receiptRef(decision),
              decidedAt: decision.at,
            })
          : available({ status: 'proposed' }),
      activation:
        record.activation &&
        activation &&
        (active || record.supersededBy || record.retirement)
          ? available({
              status: record.supersededBy
                ? 'superseded'
                : record.retirement
                  ? 'retired'
                  : 'active',
              activeRevisionRef: ref(record.id, record.activation.revision),
              activatedAt: activation.at,
              deploymentTargets: record.activation.targets,
              contributionDisclosures: [],
            })
          : available({
              status: 'inactive',
              deploymentTargets: record.proposal.targets,
              contributionDisclosures: [],
            }),
      effect: available({
        observations: record.effects.map((effect) => ({
          observationRef: effect.evidence,
          assessment: effect.assessment,
          observedAt: stageReceipt(effect.receiptId)!.at,
        })),
      }),
      retirement:
        record.retirement && retirement
          ? available({
              status: 'retired',
              retirementRef: receiptRef(retirement),
              receiptRef: receiptRef(retirement),
              retiredAt: retirement.at,
              reason: record.retirement.reason,
            })
          : available({ status: 'not-retired' }),
    };
    return {
      state: 'available',
      id: record.id,
      revision: record.revision,
      active,
      body: record.proposal.body,
      projection,
      receipts: receipts.map((receipt) => this.receipt(receipt)),
      ...(record.supersededBy
        ? {
            supersededBy: ref(
              record.supersededBy.id,
              record.supersededBy.revision,
            ),
          }
        : {}),
    };
  }

  async list(scope: KnowledgeLearningScope): Promise<LearningReviewIndex> {
    if (this.owner.version !== 'knowledge.learning/v1')
      return { state: 'unsupported-version' };
    const result = await this.owner.list(scope);
    if (result.coverage === 'unavailable') return { state: 'unavailable' };
    const items = result.records.map((item) => this.project(item, scope));
    return {
      state: 'available',
      items,
      coverage:
        result.coverage === 'partial' ||
        items.some((item) => item.state !== 'available')
          ? 'partial'
          : 'complete',
    };
  }

  async get(
    scope: KnowledgeLearningScope,
    id: string,
    compareId?: string,
  ): Promise<LearningReviewDetail> {
    if (this.owner.version !== 'knowledge.learning/v1')
      return { state: 'unsupported-version' };
    const value = await this.owner.get(scope, id);
    let detail = this.project(value, scope);
    if (
      detail.state === 'available' &&
      detail.projection.activation.state === 'available' &&
      detail.projection.activation.value.status !== 'inactive'
    ) {
      const activation = detail.projection.activation.value;
      let disclosures: LearningReviewContributionDisclosure[] = [];
      let coverage: 'up-to-100-recent-task-turns' | 'unavailable' =
        'unavailable';
      if (this.contributions) {
        try {
          disclosures = await this.contributions(
            scope,
            activation.activeRevisionRef,
          );
          coverage = 'up-to-100-recent-task-turns';
        } catch {
          coverage = 'unavailable';
        }
        if (
          disclosures.length > 100 ||
          disclosures.some(
            (disclosure) =>
              disclosure.activeRevisionRef.authority !==
                activation.activeRevisionRef.authority ||
              disclosure.activeRevisionRef.kind !==
                activation.activeRevisionRef.kind ||
              disclosure.activeRevisionRef.id !==
                activation.activeRevisionRef.id ||
              disclosure.activeRevisionRef.revision !==
                activation.activeRevisionRef.revision ||
              (disclosure.coordinate &&
                disclosure.coordinate.turnId !== disclosure.turnRef.id),
          )
        )
          return { state: 'corrupt' };
        const after = await this.owner.get(scope, id);
        if (after.state !== 'available') return this.project(after, scope);
        if (
          value.state !== 'available' ||
          after.record.revision !== value.record.revision ||
          after.record.contentRevision !== value.record.contentRevision
        )
          return { state: 'unavailable' };
      }
      detail = {
        ...detail,
        contributionCoverage: coverage,
        projection: {
          ...detail.projection,
          activation: {
            state: 'available',
            value: { ...activation, contributionDisclosures: disclosures },
          },
        },
      };
    }
    if (detail.state !== 'available' || !compareId || compareId === id)
      return detail;
    const comparison = this.project(
      await this.owner.get(scope, compareId),
      scope,
    );
    if (comparison.state !== 'available')
      return { ...detail, comparison: { state: comparison.state } };
    if (comparison.projection.candidate.state !== 'available')
      return { ...detail, comparison: { state: 'corrupt' } };
    return {
      ...detail,
      comparison: {
        state: 'available',
        ref: comparison.projection.candidate.value.proposedRevisionRef!,
        title: comparison.projection.candidate.value.title,
        body: comparison.body,
        active: comparison.active,
      },
    };
  }

  async prepare(
    scope: KnowledgeLearningScope,
    selection: LearningReviewSourceSelection,
  ): Promise<LearningReviewPreparedSource> {
    if (this.owner.version !== 'knowledge.learning/v1')
      return { state: 'unsupported-version' };
    const source = await this.source(selection, scope);
    if (
      !source ||
      source.scope.kind !== scope.kind ||
      source.scope.id !== scope.id ||
      source.supporting.length !== 1
    )
      return { state: 'restricted' };
    const reference = source.supporting[0]!;
    const content = await this.inspectSource?.(reference, scope);
    if (!content || content.title.length > 240 || content.text.length > 16384)
      return { state: 'unavailable' };
    const after = await this.source(selection, scope);
    if (
      !after ||
      after.scope.kind !== scope.kind ||
      after.scope.id !== scope.id ||
      !after.supporting.some(
        (ref) =>
          ref.authority === reference.authority &&
          ref.kind === reference.kind &&
          ref.id === reference.id &&
          ref.revision === reference.revision,
      )
    )
      return { state: 'restricted' };
    return {
      state: 'available',
      projectId: scope.id,
      ref: reference,
      title: content.title,
      body: content.text,
      ...(content.truncated ? { truncated: true } : {}),
    };
  }

  async inspect(
    scope: KnowledgeLearningScope,
    id: string,
    reference: KnowledgeLearningRef,
  ): Promise<LearningReviewEvidenceView> {
    if (this.owner.version !== 'knowledge.learning/v1')
      return { state: 'unsupported-version' };
    const matches = (value: KnowledgeLearningProjection) => {
      if (
        value.state !== 'available' ||
        value.record.proposal.scope.kind !== scope.kind ||
        value.record.proposal.scope.id !== scope.id
      )
        return false;
      const record = value.record;
      return [
        ...record.proposal.supporting,
        ...record.proposal.counter,
        ...record.proposal.conflicts,
        ...record.proposal.targets,
        ...(record.evaluation?.evidence ?? []),
        ...record.effects.map((effect) => effect.evidence),
      ].some(
        (ref) =>
          ref.authority === reference.authority &&
          ref.kind === reference.kind &&
          ref.id === reference.id &&
          ref.revision === reference.revision,
      );
    };
    const before = await this.owner.get(scope, id);
    if (before.state !== 'available')
      return {
        state: before.state === 'not-found' ? 'not-captured' : before.state,
      };
    if (!matches(before)) return { state: 'restricted' };
    const source = await this.inspectSource?.(reference, scope);
    if (!source || source.title.length > 240 || source.text.length > 16384)
      return { state: 'unavailable' };
    const after = await this.owner.get(scope, id);
    if (!matches(after))
      return {
        state: after.state === 'restricted' ? 'restricted' : 'unavailable',
      };
    return { state: 'available', ref: { ...reference }, ...source };
  }

  async propose(
    scope: KnowledgeLearningScope,
    input: LearningReviewProposalInput,
  ): Promise<LearningReviewMutationResult> {
    if (this.owner.version !== 'knowledge.learning/v1')
      throw new Error('Learning owner version unsupported');
    const source = await this.source(input.source, scope);
    if (
      !source ||
      source.scope.kind !== scope.kind ||
      source.scope.id !== scope.id
    )
      throw new Error('Learning source unavailable');
    requirePreparedSource(input.source, input.expectedSourceRef, source);
    const receipt = await this.owner.apply({
      intentId: input.intentId,
      learningId: input.learningId,
      expectedRevision: 0,
      scope,
      action: 'propose',
      proposal: {
        kind: input.kind,
        title: input.title,
        body: input.body,
        expectedEffect: input.expectedEffect,
        scope,
        supporting: source.supporting,
        counter: source.counter,
        conflicts: source.conflicts,
        targets: source.targets,
      },
    });
    return {
      receipt: this.receipt(receipt),
      detail: await this.get(scope, input.learningId),
    };
  }

  async apply(
    scope: KnowledgeLearningScope,
    id: string,
    input: LearningReviewIntentInput,
  ): Promise<LearningReviewMutationResult> {
    // The route's closed schema admits only owner intent fields, never host authority.
    if (this.owner.version !== 'knowledge.learning/v1')
      throw new Error('Learning owner version unsupported');
    let receipt: KnowledgeLearningReceipt;
    if (input.action === 'observe-effect' && 'source' in input) {
      const source = await this.source(input.source, scope);
      if (
        !source ||
        source.scope.kind !== scope.kind ||
        source.scope.id !== scope.id ||
        source.supporting.length !== 1
      )
        throw new Error('Effect source unavailable');
      requirePreparedSource(input.source, input.expectedSourceRef, source);
      receipt = await this.owner.apply({
        intentId: input.intentId,
        expectedRevision: input.expectedRevision,
        learningId: id,
        scope,
        action: 'observe-effect',
        assessment: input.assessment,
        evidence: source.supporting[0]!,
      });
    } else
      receipt = await this.owner.apply({ ...input, learningId: id, scope });
    return {
      receipt: this.receipt(receipt),
      detail: await this.get(scope, id),
    };
  }
}
