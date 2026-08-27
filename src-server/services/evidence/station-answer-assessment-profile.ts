/**
 * Station's pure declaration for claims that assess one exact answer binding.
 * Surface continues to evaluate evidence and policy; this module only binds a
 * claim to the Station-owned answer identity.
 */
import { createHash } from 'node:crypto';
import type { StationAnswerAssessmentProfileTarget } from '@kontourai/station-contracts/answer-assessment';
import type { StationAnswerBinding } from '@kontourai/station-contracts/task-basis';
import type { TrustBundle } from '@kontourai/surface';

export const STATION_ANSWER_CONTENT_PROFILE = 'station.answer-content/v1';

export function stationAnswerAssessmentTarget(
  binding: StationAnswerBinding,
): string {
  const tuple = JSON.stringify([
    STATION_ANSWER_CONTENT_PROFILE,
    binding.sessionId,
    binding.turnId,
    binding.answer.threadId,
    binding.answer.messageId,
  ]);
  return `station-answer-content-v1-${createHash('sha256').update(tuple).digest('hex')}`;
}

export function stationAnswerAssessmentClaimProfile(
  binding: StationAnswerBinding,
): Pick<
  StationAnswerAssessmentProfileTarget,
  'subjectType' | 'subjectId' | 'claimType' | 'metadata'
> {
  const target = stationAnswerAssessmentTarget(binding);
  return {
    subjectType: 'station.answer-content',
    subjectId: target,
    claimType: STATION_ANSWER_CONTENT_PROFILE,
    metadata: {
      stationAnswerAssessment: {
        version: STATION_ANSWER_CONTENT_PROFILE,
        target,
      },
    },
  };
}

export function stationAnswerAssessmentProfileTarget(
  binding: StationAnswerBinding,
): StationAnswerAssessmentProfileTarget {
  return {
    version: STATION_ANSWER_CONTENT_PROFILE,
    target: stationAnswerAssessmentTarget(binding),
    ...stationAnswerAssessmentClaimProfile(binding),
  };
}

/** True only for the exact Station answer binding, never for answer-like claims. */
export function qualifiesStationAnswerContent(
  bundle: TrustBundle,
  claimId: string,
  binding: StationAnswerBinding,
): boolean {
  const claim = bundle.claims.find((candidate) => candidate.id === claimId);
  if (!claim) return false;
  const target = stationAnswerAssessmentTarget(binding);
  const profile = claim.metadata?.stationAnswerAssessment;
  return (
    claim.subjectType === 'station.answer-content' &&
    claim.subjectId === target &&
    claim.claimType === STATION_ANSWER_CONTENT_PROFILE &&
    typeof profile === 'object' &&
    profile !== null &&
    (profile as { version?: unknown }).version ===
      STATION_ANSWER_CONTENT_PROFILE &&
    (profile as { target?: unknown }).target === target
  );
}
