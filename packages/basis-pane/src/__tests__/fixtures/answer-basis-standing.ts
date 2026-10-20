/**
 * Exact-answer Basis projections for each Surface standing, composed through
 * Surface's own public composer. Surface, not these fixtures, derives the
 * standing and its label: a fixture only chooses the observed inputs (answer
 * state, assessment state, policy outcome) that lead Surface there.
 */
import {
  type BasisProjection,
  composeBasisProjection,
} from '@kontourai/surface/basis';

export type AnswerBasisStandingFixture =
  | 'execution-only'
  | 'policy-met'
  | 'assessed-with-gaps'
  | 'unresolved';

const observedAt = '2026-10-19T16:10:00.000Z';

function answerRef(sessionId: string, messageId: string) {
  return {
    authority: '@kontourai/thread',
    schemaVersion: '1.2.0',
    kind: 'assistant-message',
    standing: 'observed',
    threadId: sessionId,
    messageId,
  } as const;
}

function assessment(policyMet: boolean) {
  return {
    owner: { authority: '@kontourai/surface' },
    state: 'available',
    observedAt,
    value: {
      version: 'surface.answer-assessment/v2',
      ref: {
        authority: '@kontourai/surface',
        schemaVersion: 'surface.answer-assessment/v2',
        kind: 'answer-assessment',
        bundleId: 'fixture-bundle',
        claimId: 'fixture-claim',
      },
      found: true,
      bundle: {
        id: 'fixture-bundle',
        schemaVersion: 3,
        source: 'Station chip fixture',
        generatedAt: observedAt,
      },
      claim: {
        id: 'fixture-claim',
        subject: { subjectType: 'answer', subjectId: 'fixture-message' },
        status: 'verified',
        freshness: { asOf: observedAt, expiresAt: null, stale: false },
      },
      policy: policyMet
        ? {
            version: 'surface.answer-assessment-policy/v1',
            id: 'fixture-policy',
            evaluatedAt: observedAt,
            outcome: 'satisfied',
            satisfied: true,
            reasons: [],
          }
        : null,
      evidence: {
        entails: [
          {
            id: 'fixture-entails',
            label: 'Entailing evidence',
            sourceRef: 'fixture-source',
            locator: null,
            observedAt,
            supportStrength: 'entails',
            result: 'passed',
            blocksClaim: false,
          },
        ],
        cited: [],
        undeclared: [],
        counterevidence: [],
      },
      derivation: { available: true, directInputs: [] },
      gaps: [],
    },
  } as const;
}

export function answerBasisProjection(
  standing: AnswerBasisStandingFixture,
  sessionId = 'agent:1792425046978',
  messageId = 'fixture-message',
): BasisProjection {
  return composeBasisProjection({
    version: 'surface.basis-projection/v1',
    answer:
      standing === 'unresolved'
        ? {
            owner: { authority: '@kontourai/thread' },
            state: 'unavailable',
            observedAt,
          }
        : {
            owner: { authority: '@kontourai/thread' },
            state: 'available',
            observedAt,
            value: {
              ref: answerRef(sessionId, messageId),
              fact: 'answer-observed',
              observedAt,
            },
          },
    assessment:
      standing === 'policy-met' || standing === 'assessed-with-gaps'
        ? assessment(standing === 'policy-met')
        : {
            owner: { authority: '@kontourai/surface' },
            state: 'not-captured',
            observedAt,
          },
    contributions: [],
  } as Parameters<typeof composeBasisProjection>[0]);
}
