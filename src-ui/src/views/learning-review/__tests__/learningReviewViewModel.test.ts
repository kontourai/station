import {
  LEARNING_REVIEW_SCHEMA_VERSION,
  type LearningReviewProjection,
  type LearningReviewProjectionOutcome,
} from '@kontourai/station-contracts/learning-review';
import { describe, expect, test } from 'vitest';
import { learningReviewViewModel } from '../learningReviewViewModel';

const ref = (kind: string, id: string, revision?: string) => ({
  authority: 'learning-owner',
  kind,
  id,
  ...(revision ? { revision } : {}),
});

const revisionRef = (kind: string, id: string, revision: string) => ({
  authority: 'learning-owner',
  kind,
  id,
  revision,
});

function projection(
  overrides: Partial<LearningReviewProjection> = {},
): LearningReviewProjection {
  return {
    schemaVersion: LEARNING_REVIEW_SCHEMA_VERSION,
    projectionId: 'learning-review-1',
    owner: ref('learning', 'learning-1', '4'),
    scope: { kind: 'project', id: 'station' },
    source: {
      state: 'available',
      value: [
        {
          sourceRef: ref('feedback-receipt', 'receipt-1'),
          kind: 'feedback',
          capturedAt: '2026-09-03T12:00:00.000Z',
          relation: 'contributed',
        },
      ],
    },
    candidate: {
      state: 'available',
      value: {
        candidateRef: ref('candidate', 'candidate-1'),
        kind: 'skill',
        title: 'Preserve exact evidence identity',
        expectedEffect: 'Fewer reviews cite stale evidence.',
        scope: { kind: 'project', id: 'station' },
        proposedRevisionRef: revisionRef('skill', 'evidence-review', '5'),
        currentRevisionRef: revisionRef('skill', 'evidence-review', '4'),
        supportingRefs: [ref('receipt', 'receipt-1')],
        counterRefs: [],
        conflictRefs: [],
        deploymentTargets: [ref('skill-target', 'reviewers')],
        freshness: {
          state: 'current',
          observedAt: '2026-09-03T12:01:00.000Z',
          ownerUpdatedAt: '2026-09-03T12:00:30.000Z',
        },
      },
    },
    evaluation: {
      state: 'available',
      value: {
        evaluationRef: ref('evaluation', 'evaluation-1'),
        status: 'supported',
        evidenceRefs: [ref('evaluation-receipt', 'evaluation-receipt-1')],
        evaluatedAt: '2026-09-03T12:02:00.000Z',
      },
    },
    decision: {
      state: 'available',
      value: {
        status: 'approved',
        decisionRef: ref('decision', 'decision-1'),
        receiptRef: ref('decision-receipt', 'decision-receipt-1'),
        decidedAt: '2026-09-03T12:03:00.000Z',
      },
    },
    activation: { state: 'not-captured' },
    effect: { state: 'available', value: { observations: [] } },
    retirement: {
      state: 'available',
      value: { status: 'not-retired' },
    },
    ...overrides,
  };
}

const available = (
  value: LearningReviewProjection,
): LearningReviewProjectionOutcome => ({
  state: 'available',
  projection: value,
});

describe('learningReviewViewModel', () => {
  test('never presents an approved decision as an active revision', () => {
    const result = learningReviewViewModel(available(projection()));
    expect(result).toMatchObject({
      state: 'ready',
      currentActivity: 'unknown',
      effectConclusion: 'not-observed',
    });
    if (result.state !== 'ready') throw new Error('expected ready projection');
    expect(result.steps.find((step) => step.id === 'activation')).toMatchObject(
      {
        state: 'not-captured',
        detail: 'This owner did not capture this stage.',
      },
    );
  });

  test('requires at least one supporting observation before effect reads supported', () => {
    const empty = learningReviewViewModel(available(projection()));
    expect(empty).toMatchObject({ effectConclusion: 'not-observed' });
    if (empty.state !== 'ready') throw new Error('expected ready projection');
    expect(empty.steps.find((step) => step.id === 'effect')).toMatchObject({
      state: 'waiting',
      detail: 'No effect observations were captured; impact is unresolved.',
    });

    const supported = learningReviewViewModel(
      available(
        projection({
          effect: {
            state: 'available',
            value: {
              observations: [
                {
                  observationRef: ref('effect-observation', 'observation-1'),
                  assessment: 'supported',
                  observedAt: '2026-09-04T12:00:00.000Z',
                },
              ],
            },
          },
        }),
      ),
    );
    expect(supported).toMatchObject({ effectConclusion: 'supported' });
  });

  test('keeps counter, mixed, and unresolved observations distinct', () => {
    const outcome = (
      assessments: Array<'supported' | 'countered' | 'unresolved'>,
    ) =>
      learningReviewViewModel(
        available(
          projection({
            effect: {
              state: 'available',
              value: {
                observations: assessments.map((assessment, index) => ({
                  observationRef: ref(
                    'effect-observation',
                    `observation-${index}`,
                  ),
                  assessment,
                  observedAt: '2026-09-04T12:00:00.000Z',
                })),
              },
            },
          }),
        ),
      );
    expect(outcome(['countered'])).toMatchObject({
      effectConclusion: 'countered',
    });
    expect(outcome(['supported', 'countered'])).toMatchObject({
      effectConclusion: 'mixed',
    });
    expect(outcome(['supported', 'unresolved'])).toMatchObject({
      effectConclusion: 'unresolved',
    });
  });

  test('preserves historical activation while retirement ends current activity', () => {
    const result = learningReviewViewModel(
      available(
        projection({
          activation: {
            state: 'available',
            value: {
              status: 'active',
              activeRevisionRef: revisionRef('skill', 'evidence-review', '5'),
              activatedAt: '2026-09-03T12:04:00.000Z',
              deploymentTargets: [ref('skill-target', 'reviewers')],
              contributionDisclosures: [
                {
                  turnRef: ref('turn', 'turn-1'),
                  activeRevisionRef: revisionRef(
                    'skill',
                    'evidence-review',
                    '5',
                  ),
                },
              ],
            },
          },
          retirement: {
            state: 'available',
            value: {
              status: 'retired',
              retirementRef: ref('retirement', 'retirement-1'),
              receiptRef: ref('retirement-receipt', 'retirement-receipt-1'),
              retiredAt: '2026-09-05T12:00:00.000Z',
              reason: 'Counter evidence exceeded the owner threshold.',
            },
          },
        }),
      ),
    );
    expect(result).toMatchObject({
      state: 'ready',
      currentActivity: 'inactive',
    });
    if (result.state !== 'ready') throw new Error('expected ready projection');
    expect(result.steps.find((step) => step.id === 'activation')).toMatchObject(
      {
        state: 'complete',
      },
    );
    expect(result.steps.find((step) => step.id === 'retirement')).toMatchObject(
      {
        state: 'complete',
        detail:
          'The owner reports this learning retired; history is preserved.',
      },
    );
  });

  test('requires explicit not-retired truth before reporting current activity', () => {
    const activeRevision = {
      state: 'available' as const,
      value: {
        status: 'active' as const,
        activeRevisionRef: revisionRef('skill', 'evidence-review', '5'),
        activatedAt: '2026-09-03T12:04:00.000Z',
        deploymentTargets: [ref('skill-target', 'reviewers')],
        contributionDisclosures: [],
      },
    };
    const confirmed = learningReviewViewModel(
      available(
        projection({
          activation: activeRevision,
          retirement: {
            state: 'available',
            value: { status: 'not-retired' },
          },
        }),
      ),
    );
    expect(confirmed).toMatchObject({ currentActivity: 'active' });

    for (const state of [
      'not-captured',
      'restricted',
      'unavailable',
      'unsupported-version',
      'corrupt',
    ] as const) {
      const result = learningReviewViewModel(
        available(
          projection({
            activation: activeRevision,
            retirement: { state },
          }),
        ),
      );
      expect(result).toMatchObject({ currentActivity: 'unknown' });
    }
  });

  test('renders top-level access gaps without owner identity', () => {
    for (const state of [
      'not-captured',
      'restricted',
      'unavailable',
    ] as const) {
      const result = learningReviewViewModel({ state });
      expect(result.state).toBe(state);
      expect(result.steps).toEqual([]);
      expect(JSON.stringify(result)).not.toContain('learning-owner');
    }
  });

  test('preserves the complete lifecycle order and partial stage gaps', () => {
    const result = learningReviewViewModel(
      available(
        projection({
          evaluation: { state: 'restricted' },
          decision: { state: 'unavailable' },
        }),
      ),
    );
    if (result.state !== 'ready') throw new Error('expected ready projection');
    expect(result.steps.map((step) => step.id)).toEqual([
      'source',
      'candidate',
      'evaluation',
      'decision',
      'activation',
      'effect',
      'retirement',
    ]);
    expect(result.steps.find((step) => step.id === 'evaluation')).toMatchObject(
      {
        state: 'restricted',
      },
    );
    expect(result.steps.find((step) => step.id === 'decision')).toMatchObject({
      state: 'unavailable',
    });
  });

  test('preserves corrupt and unsupported-version partial gaps exactly', () => {
    const result = learningReviewViewModel(
      available(
        projection({
          source: { state: 'unsupported-version' },
          effect: { state: 'corrupt' },
        }),
      ),
    );
    expect(result).toMatchObject({
      state: 'ready',
      effectConclusion: 'corrupt',
    });
    if (result.state !== 'ready') throw new Error('expected ready projection');
    expect(result.steps.find((step) => step.id === 'source')).toMatchObject({
      state: 'unsupported-version',
      detail: 'This projection version is unsupported.',
    });
    expect(result.steps.find((step) => step.id === 'effect')).toMatchObject({
      state: 'corrupt',
      detail: 'This owner returned an invalid projection.',
    });
  });
});
