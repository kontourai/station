import type {
  LearningReviewEffect,
  LearningReviewProjection,
  LearningReviewProjectionOutcome,
  LearningReviewStage,
  LearningReviewStageId,
} from '@kontourai/station-contracts/learning-review';
import { LEARNING_REVIEW_STAGE_IDS } from '@kontourai/station-contracts/learning-review';

export type LearningReviewStepState =
  | 'complete'
  | 'waiting'
  | 'attention'
  | 'not-captured'
  | 'restricted'
  | 'unavailable'
  | 'unsupported-version'
  | 'corrupt';

export type LearningEffectConclusion =
  | 'supported'
  | 'countered'
  | 'mixed'
  | 'unresolved'
  | 'not-observed'
  | 'not-captured'
  | 'restricted'
  | 'unavailable'
  | 'unsupported-version'
  | 'corrupt';

export interface LearningReviewStepViewModel {
  id: LearningReviewStageId;
  label: string;
  state: LearningReviewStepState;
  detail: string;
}

export type LearningReviewViewModel =
  | {
      state:
        | 'not-captured'
        | 'restricted'
        | 'unavailable'
        | 'unsupported-version'
        | 'corrupt';
      title: string;
      detail: string;
      steps: readonly [];
    }
  | {
      state: 'ready';
      title: string;
      ownerLabel: string;
      scopeLabel: string;
      currentActivity: 'active' | 'inactive' | 'unknown';
      effectConclusion: LearningEffectConclusion;
      steps: readonly LearningReviewStepViewModel[];
    };

const LABELS: Record<LearningReviewStageId, string> = {
  source: 'Source',
  candidate: 'Candidate',
  evaluation: 'Evaluation',
  decision: 'Decision',
  activation: 'Active revision',
  effect: 'Observed effect',
  retirement: 'Retirement',
};

const GAP_COPY = {
  'not-captured': 'This owner did not capture this stage.',
  restricted: 'This stage is restricted by its owner.',
  unavailable: 'This stage owner is unavailable.',
  'unsupported-version': 'This projection version is unsupported.',
  corrupt: 'This owner returned an invalid projection.',
} as const;

function gapStep<T>(
  id: LearningReviewStageId,
  stage: Exclude<LearningReviewStage<T>, { state: 'available' }>,
): LearningReviewStepViewModel {
  return {
    id,
    label: LABELS[id],
    state: stage.state,
    detail: GAP_COPY[stage.state],
  };
}

function effectConclusion(effect: LearningReviewStage<LearningReviewEffect>) {
  if (effect.state !== 'available') {
    return effect.state;
  }
  const observations = effect.value.observations;
  if (observations.length === 0) return 'not-observed' as const;
  const assessments = new Set(
    observations.map((observation) => observation.assessment),
  );
  if (assessments.has('unresolved')) return 'unresolved' as const;
  if (assessments.has('supported') && assessments.has('countered')) {
    return 'mixed' as const;
  }
  return assessments.has('countered')
    ? ('countered' as const)
    : ('supported' as const);
}

function availableStep(
  id: LearningReviewStageId,
  projection: LearningReviewProjection,
): LearningReviewStepViewModel {
  switch (id) {
    case 'source': {
      const count =
        projection.source.state === 'available'
          ? projection.source.value.length
          : 0;
      return {
        id,
        label: LABELS[id],
        state: count > 0 ? 'complete' : 'not-captured',
        detail:
          count > 0
            ? `${count} source ${count === 1 ? 'record' : 'records'} linked.`
            : 'No source feedback or receipt was captured.',
      };
    }
    case 'candidate':
      return {
        id,
        label: LABELS[id],
        state: 'complete',
        detail:
          projection.candidate.state === 'available'
            ? projection.candidate.value.title
            : '',
      };
    case 'evaluation': {
      const status =
        projection.evaluation.state === 'available'
          ? projection.evaluation.value.status
          : 'pending';
      return {
        id,
        label: LABELS[id],
        state:
          status === 'supported'
            ? 'complete'
            : status === 'pending' || status === 'inconclusive'
              ? 'waiting'
              : 'attention',
        detail: `Owner evaluation: ${status}.`,
      };
    }
    case 'decision': {
      const status =
        projection.decision.state === 'available'
          ? projection.decision.value.status
          : 'proposed';
      return {
        id,
        label: LABELS[id],
        state:
          status === 'approved'
            ? 'complete'
            : status === 'rejected'
              ? 'attention'
              : 'waiting',
        detail: `Owner decision: ${status}.`,
      };
    }
    case 'activation': {
      const status =
        projection.activation.state === 'available'
          ? projection.activation.value.status
          : 'inactive';
      return {
        id,
        label: LABELS[id],
        state: status === 'active' ? 'complete' : 'waiting',
        detail:
          status === 'active'
            ? 'The owner reports this exact revision active.'
            : status === 'superseded'
              ? 'The owner reports this revision superseded.'
              : 'No active revision was reported by the owner.',
      };
    }
    case 'effect': {
      const conclusion = effectConclusion(projection.effect);
      return {
        id,
        label: LABELS[id],
        state:
          conclusion === 'supported'
            ? 'complete'
            : conclusion === 'countered' || conclusion === 'mixed'
              ? 'attention'
              : 'waiting',
        detail:
          conclusion === 'not-observed'
            ? 'No effect observations were captured; impact is unresolved.'
            : `Observed effect: ${conclusion}.`,
      };
    }
    case 'retirement': {
      const retired =
        projection.retirement.state === 'available' &&
        projection.retirement.value.status === 'retired';
      return {
        id,
        label: LABELS[id],
        state: retired ? 'complete' : 'waiting',
        detail: retired
          ? 'The owner reports this learning retired; history is preserved.'
          : 'The owner has not retired this learning.',
      };
    }
  }
}

function step(
  id: LearningReviewStageId,
  projection: LearningReviewProjection,
): LearningReviewStepViewModel {
  const stage = projection[id];
  return stage.state === 'available'
    ? availableStep(id, projection)
    : gapStep(id, stage);
}

function currentActivity(
  projection: LearningReviewProjection,
): 'active' | 'inactive' | 'unknown' {
  if (
    projection.retirement.state === 'available' &&
    projection.retirement.value.status === 'retired'
  ) {
    return 'inactive';
  }
  if (projection.activation.state !== 'available') return 'unknown';
  if (projection.activation.value.status !== 'active') return 'inactive';
  return projection.retirement.state === 'available' &&
    projection.retirement.value.status === 'not-retired'
    ? 'active'
    : 'unknown';
}

export function learningReviewViewModel(
  outcome: LearningReviewProjectionOutcome,
): LearningReviewViewModel {
  if (outcome.state !== 'available') {
    const copy = {
      'not-captured': [
        'Learning not captured',
        'No owner learning record was linked.',
      ],
      restricted: [
        'Learning is restricted',
        'The owner disclosed no protected learning identity.',
      ],
      unavailable: [
        'Learning owner unavailable',
        'Try again when the owning product is available.',
      ],
      'unsupported-version': [
        'Learning version unsupported',
        'Update Station or the owning product.',
      ],
      corrupt: [
        'Learning projection invalid',
        'The owner projection could not be safely read.',
      ],
    } as const;
    return {
      state: outcome.state,
      title: copy[outcome.state][0],
      detail: copy[outcome.state][1],
      steps: [],
    };
  }
  const projection = outcome.projection;
  return {
    state: 'ready',
    title:
      projection.candidate.state === 'available'
        ? projection.candidate.value.title
        : 'Learning review',
    ownerLabel: `${projection.owner.authority} · ${projection.owner.kind}`,
    scopeLabel: `${projection.scope.kind} · ${projection.scope.id}`,
    currentActivity: currentActivity(projection),
    effectConclusion: effectConclusion(projection.effect),
    steps: LEARNING_REVIEW_STAGE_IDS.map((id) => step(id, projection)),
  };
}
