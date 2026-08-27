import type {
  ReviewedSourceContributionGapCode,
  SessionInventoryGroup,
  SurfaceAnswerContributionRow,
} from '@kontourai/station-contracts/session-inventory';
import type { StationBasisProjection } from '@kontourai/station-contracts/task-basis';
import type { ContributionReadV2 } from '@kontourai/surface/basis';

const FIELDWORK_REVIEWED_SOURCE_REF =
  /^fieldwork-reviewed-source:v1:[a-f0-9]{64}$/;
const SAFE_CONTRIBUTION_GAPS = new Set<ReviewedSourceContributionGapCode>([
  'reviewed-source-review-not-accepted',
  'reviewed-source-review-not-captured',
  'reviewed-source-currentness-unknown',
  'reviewed-source-drifted',
  'reviewed-source-capture-comparison-unavailable',
  'reviewed-source-claim-not-verified',
]);

/**
 * Pure transport adapter for the one resolved Fieldwork contribution.  It
 * deliberately accepts no plugin, URL, path, or evidence payload and never
 * turns Surface's S/E/A/C facts into support by implication.
 */
export function reviewedSourceSessionInventoryRow(input: {
  sessionId: string;
  turnId: string;
  answerReferenceId: string;
  contribution: ContributionReadV2 | undefined;
  basis: StationBasisProjection;
}): SurfaceAnswerContributionRow | undefined {
  const read = input.contribution;
  if (
    read?.owner.authority !== '@kontourai/fieldwork' ||
    read.state !== 'available' ||
    read.value.length !== 1
  )
    return undefined;
  const item = read.value[0];
  if (
    item?.role !== 'source' ||
    item.ref.authority !== '@kontourai/fieldwork' ||
    item.ref.kind !== 'reviewed-web-source' ||
    !FIELDWORK_REVIEWED_SOURCE_REF.test(item.ref.exactRef) ||
    item.context.kind !== 'reviewed-source' ||
    item.answer.threadId !== input.sessionId ||
    item.answer.messageId !== input.answerReferenceId ||
    !matchesBasisAnswer(input.basis, input.sessionId, input.answerReferenceId)
  )
    return undefined;
  const contributionGaps = safeContributionGaps(item.gaps);
  if (!contributionGaps) return undefined;
  return {
    kind: 'surface-answer-contribution',
    key: `reviewed-source:${item.ref.exactRef}`,
    owner: { owner: '@kontourai/fieldwork', id: 'reviewed-source/v1' },
    // v1 has no safe transport binding for Surface's C edge. Never infer a
    // citation, counter, or support relation from internal S/E/A/C facts.
    relations: ['contributed-to'],
    sessionId: input.sessionId,
    turnId: input.turnId,
    answerReferenceId: input.answerReferenceId,
    reviewedSource: {
      exactRef: item.ref
        .exactRef as SurfaceAnswerContributionRow['reviewedSource']['exactRef'],
      review: item.context.review,
      currentness: item.context.currentness,
      checkedAt: item.context.checkedAt,
      assessmentRevision: item.context.assessmentRevision,
    },
    contributionGaps,
  };
}

/** Preserve the reviewed owner's closed read state when no row is publishable. */
export function reviewedSourceSessionInventoryGroup(input: {
  sessionId: string;
  turnId: string;
  answerReferenceId: string;
  contribution: ContributionReadV2 | undefined;
  basis: StationBasisProjection;
}): SessionInventoryGroup {
  const row = reviewedSourceSessionInventoryRow(input);
  if (row)
    return {
      id: 'sources',
      owner: row.owner,
      state: 'available',
      count: { kind: 'exact', value: 1 },
      items: [row],
      gaps: [],
    };
  const read = input.contribution;
  const state =
    read?.owner.authority === '@kontourai/fieldwork'
      ? read.state === 'restricted'
        ? 'restricted'
        : read.state === 'corrupt' || read.state === 'stale'
          ? 'corrupt'
          : read.state === 'unsupported-version'
            ? 'unsupported-version'
            : read.state === 'unavailable'
              ? 'unavailable'
              : 'not-captured'
      : 'not-captured';
  return {
    id: 'sources',
    owner: { owner: '@kontourai/fieldwork', id: 'reviewed-source/v1' },
    state,
    items: [],
    gaps: [{ kind: state }],
  } as SessionInventoryGroup;
}

function safeContributionGaps(
  value:
    | readonly { code: string; message: string; metadata?: unknown }[]
    | undefined,
): readonly ReviewedSourceContributionGapCode[] | undefined {
  const gaps = value ?? [];
  if (
    gaps.length > SAFE_CONTRIBUTION_GAPS.size ||
    gaps.some(
      (gap) =>
        !SAFE_CONTRIBUTION_GAPS.has(
          gap.code as ReviewedSourceContributionGapCode,
        ) || gap.metadata !== undefined,
    )
  )
    return undefined;
  const codes = gaps.map(
    (gap) => gap.code as ReviewedSourceContributionGapCode,
  );
  return new Set(codes).size === codes.length ? codes : undefined;
}

function matchesBasisAnswer(
  basis: StationBasisProjection,
  sessionId: string,
  answerReferenceId: string,
): boolean {
  return (
    basis.answer.state === 'available' &&
    basis.answer.value.ref.threadId === sessionId &&
    basis.answer.value.ref.messageId === answerReferenceId
  );
}
