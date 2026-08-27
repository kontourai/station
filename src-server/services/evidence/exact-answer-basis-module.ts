/**
 * Runtime-composed exact-answer Basis read.
 *
 * This is the one place that sequences Thread, Surface assessment, retained
 * narrative, and reviewed-source owners.  Callers receive their already
 * authorized projection; they never re-open an owner to populate a side view.
 */

import type { StationBasisProjection } from '@kontourai/station-contracts/task-basis';
import type { SessionReadAuthority } from '@kontourai/station-contracts/tenancy';
import type {
  ContributionRead,
  ContributionReadV2,
} from '@kontourai/surface/basis';
import type { SessionAnswerBasisQueryOutcome } from '../orchestration/session-query-module.js';
import { composeAuthorizedSessionAnswerBasis } from '../projects/task-basis-module.js';
import type { ExactAnswerAssessmentRead } from './answer-assessment-module.js';

type FoundAnswer = Extract<SessionAnswerBasisQueryOutcome, { status: 'found' }>;

export type ExactAnswerBasisReadOutcome =
  | {
      status: 'found';
      answer: FoundAnswer;
      projection: StationBasisProjection;
      reviewedSource?: ContributionReadV2;
    }
  | { status: 'not-found' }
  | { status: 'unavailable' };

export interface ExactAnswerBasisModule {
  read(input: {
    sessionId: string;
    turnId: string;
    authority: SessionReadAuthority;
    current: () => boolean;
  }): Promise<ExactAnswerBasisReadOutcome>;
}

/**
 * The owner adapters are constructor-composed after all of their concrete
 * owners exist. Hosted deployments retain the authorized Thread answer, but
 * never select personal evidence owners when no tenant adapter is supplied.
 */
export function createExactAnswerBasisModule(input: {
  hosted: () => boolean;
  canReadSession: (
    sessionId: string,
    authority: SessionReadAuthority,
  ) => boolean;
  readAnswer: (
    sessionId: string,
    turnId: string,
    authority: SessionReadAuthority,
  ) => Promise<SessionAnswerBasisQueryOutcome | undefined>;
  readAssessment: (input: {
    authorizedAnswer: FoundAnswer;
    authority: SessionReadAuthority;
    current: () => boolean;
  }) => Promise<ExactAnswerAssessmentRead>;
  readNarrative: (input: {
    authorizedAnswer: FoundAnswer;
    authority: SessionReadAuthority;
    current: () => boolean;
  }) => Promise<ContributionRead>;
  readReviewedSource: (input: {
    answer: FoundAnswer;
    assessment: ExactAnswerAssessmentRead;
    authority: SessionReadAuthority;
    current: () => boolean;
  }) => Promise<ContributionReadV2 | undefined>;
  tenantEvidence?: {
    readAssessment: (input: {
      authorizedAnswer: FoundAnswer;
      authority: SessionReadAuthority;
      current: () => boolean;
    }) => Promise<ExactAnswerAssessmentRead>;
    readNarrative?: (input: {
      authorizedAnswer: FoundAnswer;
      authority: SessionReadAuthority;
      current: () => boolean;
    }) => Promise<ContributionRead>;
    readReviewedSource?: (input: {
      answer: FoundAnswer;
      assessment: ExactAnswerAssessmentRead;
      authority: SessionReadAuthority;
      current: () => boolean;
    }) => Promise<ContributionReadV2 | undefined>;
  };
}): ExactAnswerBasisModule {
  const authorized = (
    sessionId: string,
    authority: SessionReadAuthority,
    current: () => boolean,
  ) => current() && input.canReadSession(sessionId, authority);
  return {
    async read({ sessionId, turnId, authority, current }) {
      if (!authorized(sessionId, authority, current))
        return { status: 'not-found' };
      const answer = await input.readAnswer(sessionId, turnId, authority);
      if (!authorized(sessionId, authority, current))
        return { status: 'not-found' };
      if (
        !answer ||
        answer.status === 'not-found' ||
        answer.status === 'corrupt'
      )
        return { status: 'not-found' };
      if (answer.status !== 'found') return { status: 'unavailable' };

      const evidence = input.hosted() ? input.tenantEvidence : input;
      const assessment = evidence
        ? await evidence.readAssessment({
            authorizedAnswer: answer,
            authority,
            current,
          })
        : {
            assessment: {
              owner: { authority: '@kontourai/surface' as const },
              state: 'not-captured' as const,
              observedAt: answer.observedAt,
            },
          };
      if (!authorized(sessionId, authority, current))
        return { status: 'not-found' };
      const narrative = evidence?.readNarrative
        ? await evidence.readNarrative({
            authorizedAnswer: answer,
            authority,
            current,
          })
        : undefined;
      if (!authorized(sessionId, authority, current))
        return { status: 'not-found' };
      const reviewedSource = evidence?.readReviewedSource
        ? await evidence.readReviewedSource({
            answer,
            assessment,
            authority,
            current,
          })
        : input.hosted()
          ? ({
              owner: { authority: '@kontourai/fieldwork' },
              state: 'unavailable',
              observedAt: answer.observedAt,
            } as ContributionReadV2)
          : undefined;
      if (!authorized(sessionId, authority, current))
        return { status: 'not-found' };
      return {
        status: 'found',
        answer,
        projection: composeAuthorizedSessionAnswerBasis(
          answer,
          assessment.assessment,
          narrative,
          reviewedSource,
        ) as StationBasisProjection,
        ...(reviewedSource ? { reviewedSource } : {}),
      };
    },
  };
}
