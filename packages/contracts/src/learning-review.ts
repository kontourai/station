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
      readonly status: 'active' | 'superseded';
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
