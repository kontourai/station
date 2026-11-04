/** Owner-neutral, read-only learning review projection. */
export const LEARNING_REVIEW_SCHEMA_VERSION =
  'station.learning-review/v1' as const;

export const LEARNING_REVIEW_STAGE_IDS = [
  'source',
  'candidate',
  'evaluation',
  'decision',
  'activation',
  'effect',
  'retirement',
] as const;

export type LearningReviewStageId = (typeof LEARNING_REVIEW_STAGE_IDS)[number];

/** Exact owner record reference. Station preserves it but never interprets it. */
export interface LearningReviewOwnerRef {
  readonly authority: string;
  readonly kind: string;
  readonly id: string;
  readonly revision?: string;
}

/** Owner record reference whose exact revision is part of the identity. */
export interface LearningReviewRevisionRef extends LearningReviewOwnerRef {
  readonly revision: string;
}

export interface LearningReviewScope {
  readonly kind: 'global' | 'project' | 'agent' | 'session';
  readonly id: string;
}

/**
 * A restricted or unavailable owner carries no projection or identity. This is
 * intentionally a top-level union rather than nullable owner fields.
 */
export type LearningReviewProjectionOutcome =
  | {
      readonly state: 'available';
      readonly projection: LearningReviewProjection;
    }
  | { readonly state: 'not-captured' }
  | { readonly state: 'restricted' }
  | { readonly state: 'unavailable' }
  | { readonly state: 'unsupported-version' }
  | { readonly state: 'corrupt' };

/** Partial owner projections preserve an exact gap instead of inventing data. */
export type LearningReviewStage<T> =
  | { readonly state: 'available'; readonly value: T }
  | { readonly state: 'not-captured' }
  | { readonly state: 'restricted' }
  | { readonly state: 'unavailable' }
  | { readonly state: 'unsupported-version' }
  | { readonly state: 'corrupt' };

export interface LearningReviewSource {
  readonly sourceRef: LearningReviewOwnerRef;
  readonly kind: 'feedback' | 'receipt' | 'observation';
  readonly capturedAt: string;
  readonly relation: 'contributed' | 'countered' | 'context';
}

export interface LearningReviewFreshness {
  readonly state: 'current' | 'stale' | 'unknown';
  readonly ownerUpdatedAt?: string;
  readonly observedAt: string;
}

export interface LearningReviewCandidate {
  readonly candidateRef: LearningReviewOwnerRef;
  readonly kind: 'skill' | 'claim' | 'guideline' | 'rule' | 'evaluation';
  readonly title: string;
  readonly expectedEffect: string;
  readonly scope: LearningReviewScope;
  readonly proposedRevisionRef?: LearningReviewRevisionRef;
  readonly currentRevisionRef?: LearningReviewRevisionRef;
  readonly supportingRefs: readonly LearningReviewOwnerRef[];
  readonly counterRefs: readonly LearningReviewOwnerRef[];
  readonly conflictRefs: readonly LearningReviewOwnerRef[];
  readonly deploymentTargets: readonly LearningReviewOwnerRef[];
  readonly freshness: LearningReviewFreshness;
}

export interface LearningReviewEvaluation {
  readonly evaluationRef: LearningReviewOwnerRef;
  readonly status:
    | 'pending'
    | 'supported'
    | 'countered'
    | 'mixed'
    | 'inconclusive';
  readonly evidenceRefs: readonly LearningReviewOwnerRef[];
  readonly evaluatedAt?: string;
}

export type LearningReviewDecision =
  | {
      readonly status: 'proposed' | 'deferred';
      readonly decisionRef?: LearningReviewOwnerRef;
    }
  | {
      readonly status: 'approved' | 'rejected';
      readonly decisionRef: LearningReviewOwnerRef;
      /** Owner decision receipt; transport acknowledgement is not enough. */
      readonly receiptRef: LearningReviewOwnerRef;
      readonly decidedAt: string;
    };

export interface LearningReviewContributionDisclosure {
  readonly coordinate?: {
    conversationId: string;
    sessionId: string;
    turnId: string;
  };
  readonly turnRef: LearningReviewOwnerRef;
  readonly activeRevisionRef: LearningReviewRevisionRef;
}

export type LearningReviewActivation =
  | {
      readonly status: 'inactive';
      readonly deploymentTargets: readonly LearningReviewOwnerRef[];
      readonly contributionDisclosures: readonly [];
    }
  | {
      readonly status: 'active' | 'superseded' | 'retired';
      readonly activeRevisionRef: LearningReviewRevisionRef;
      readonly activatedAt: string;
      readonly deploymentTargets: readonly LearningReviewOwnerRef[];
      readonly contributionDisclosures: readonly LearningReviewContributionDisclosure[];
    };

export interface LearningReviewEffectObservation {
  readonly observationRef: LearningReviewOwnerRef;
  readonly assessment: 'supported' | 'countered' | 'unresolved';
  readonly observedAt: string;
}

export interface LearningReviewEffect {
  /** An empty array means not observed, never success. */
  readonly observations: readonly LearningReviewEffectObservation[];
}

export type LearningReviewRetirement =
  | { readonly status: 'not-retired' }
  | {
      readonly status: 'retired';
      readonly retirementRef: LearningReviewOwnerRef;
      readonly receiptRef: LearningReviewOwnerRef;
      readonly retiredAt: string;
      readonly reason: string;
    };

export interface LearningReviewProjection {
  readonly schemaVersion: typeof LEARNING_REVIEW_SCHEMA_VERSION;
  readonly projectionId: string;
  /** Owner of the projection, not Station. */
  readonly owner: LearningReviewOwnerRef;
  readonly scope: LearningReviewScope;
  readonly source: LearningReviewStage<readonly LearningReviewSource[]>;
  readonly candidate: LearningReviewStage<LearningReviewCandidate>;
  readonly evaluation: LearningReviewStage<LearningReviewEvaluation>;
  readonly decision: LearningReviewStage<LearningReviewDecision>;
  readonly activation: LearningReviewStage<LearningReviewActivation>;
  readonly effect: LearningReviewStage<LearningReviewEffect>;
  readonly retirement: LearningReviewStage<LearningReviewRetirement>;
}

/** Read-only source inspection; no candidate, deployment scope, or learning activation is implied. */
export type LearningSourceObservation =
  | {
      state: 'observed';
      kind: 'source-only';
      source: {
        rootId: string;
        recordId: string;
        adapterId: 'kit-default-store';
        type: string;
        title: string;
        category: string;
        body: string;
        provenance: {
          agent: string;
          source_ids?: string[];
          session_id?: string;
          note?: string;
        };
        created_at: string;
        updated_at: string;
        /** Omitted source status stays omitted; it is never learning activation. */
        status?: 'active' | 'implemented' | 'retired';
      };
      observation: {
        observedAt: string;
        contentDigest: string;
        ownerRevision: 'unknown';
        consistency: 'non-atomic';
        transactionState: 'unknown';
      };
    }
  | {
      state:
        | 'restricted'
        | 'unsupported'
        | 'missing'
        | 'busy'
        | 'corrupt'
        | 'unavailable'
        | 'invalid-input'
        | 'over-budget';
    };

export const LEARNING_REVIEW_PROJECT_HEADER =
  'x-station-learning-project-id' as const;
export const LEARNING_REVIEW_PREVIEW = 'learning-lifecycle-review' as const;
export type LearningReviewAction =
  | 'evaluate'
  | 'approve'
  | 'reject'
  | 'activate'
  | 'observe-effect'
  | 'retire'
  | 'supersede';
export interface LearningReviewReceiptView {
  ref: LearningReviewRevisionRef;
  action: string;
  actorId: string;
  at: string;
}
export type LearningReviewDetail =
  | {
      state: 'available';
      id: string;
      revision: number;
      active: boolean;
      body: string;
      projection: LearningReviewProjection;
      receipts: LearningReviewReceiptView[];
      contributionCoverage?: 'up-to-100-recent-task-turns' | 'unavailable';
      supersededBy?: LearningReviewRevisionRef;
      comparison?:
        | {
            state: 'available';
            ref: LearningReviewRevisionRef;
            title: string;
            body: string;
            active: boolean;
          }
        | {
            state:
              | 'not-captured'
              | 'restricted'
              | 'unavailable'
              | 'unsupported-version'
              | 'corrupt';
          };
    }
  | {
      state:
        | 'not-captured'
        | 'restricted'
        | 'unavailable'
        | 'unsupported-version'
        | 'corrupt';
    };
export type LearningReviewIndex =
  | {
      state: 'available';
      items: LearningReviewDetail[];
      coverage: 'complete' | 'partial';
    }
  | { state: 'restricted' | 'unavailable' | 'unsupported-version' | 'corrupt' };
export type LearningReviewSourceSelection =
  | {
      kind: 'task-standing';
      taskId: string;
      taskCreatedAt: string;
      recordKind: 'decision' | 'dead-end';
      key: string;
      version: number;
    }
  | {
      kind: 'rated-feedback';
      conversationId: string;
      turnId: string;
      ratingId: string;
    };
export interface LearningReviewProposalInput {
  expectedSourceRef?: LearningReviewRevisionRef;
  intentId: string;
  learningId: string;
  source: LearningReviewSourceSelection;
  kind: LearningReviewCandidate['kind'];
  title: string;
  body: string;
  expectedEffect: string;
}
export type LearningReviewIntentInput = {
  intentId: string;
  expectedRevision: number;
} & (
  | {
      action: 'evaluate';
      status: Exclude<LearningReviewEvaluation['status'], 'pending'>;
      evidence: LearningReviewRevisionRef[];
    }
  | { action: 'approve' | 'reject'; rationale: string }
  | { action: 'activate' }
  | {
      action: 'observe-effect';
      assessment: LearningReviewEffectObservation['assessment'];
      evidence: LearningReviewRevisionRef;
    }
  | {
      action: 'observe-effect';
      assessment: LearningReviewEffectObservation['assessment'];
      source: LearningReviewSourceSelection;
      expectedSourceRef?: LearningReviewRevisionRef;
    }
  | { action: 'retire'; reason: string }
  | { action: 'supersede'; replacementId: string; replacementRevision: string }
);
export interface LearningReviewMutationResult {
  receipt: LearningReviewReceiptView;
  detail: LearningReviewDetail;
}

export type LearningReviewEvidenceView =
  | {
      state: 'available';
      ref: LearningReviewRevisionRef;
      title: string;
      text: string;
      capturedAt?: string;
      truncated?: boolean;
    }
  | {
      state:
        | 'not-captured'
        | 'restricted'
        | 'unavailable'
        | 'unsupported-version'
        | 'corrupt';
    };

/** Exact approved guidance retained in a Task's bounded first-turn context. */
export interface LearningReviewTaskContext {
  readonly text: string;
  readonly contributions: readonly LearningReviewRevisionRef[];
}

/** Validate persisted contribution references before attributing a model input. */
export function parseLearningContextContributions(
  value: unknown,
): readonly LearningReviewRevisionRef[] | undefined {
  if (!Array.isArray(value) || value.length > 64) return undefined;
  const refs: LearningReviewRevisionRef[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      return undefined;
    const fields = item as Record<string, unknown>;
    if (
      Object.keys(fields).length !== 4 ||
      ['authority', 'kind', 'id', 'revision'].some(
        (key) =>
          typeof fields[key] !== 'string' ||
          fields[key].length === 0 ||
          fields[key].length > 512,
      )
    )
      return undefined;
    refs.push({
      authority: fields.authority as string,
      kind: fields.kind as string,
      id: fields.id as string,
      revision: fields.revision as string,
    });
  }
  return refs;
}

export type LearningReviewPreparedSource =
  | {
      state: 'available';
      projectId: string;
      ref: LearningReviewRevisionRef;
      title: string;
      body: string;
      truncated?: boolean;
    }
  | { state: 'restricted' | 'unavailable' | 'unsupported-version' | 'corrupt' };
