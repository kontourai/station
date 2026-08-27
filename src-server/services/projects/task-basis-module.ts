import { parseTaskTurnReference } from '@kontourai/station-contracts';
import {
  parseStationBasisProjection,
  STATION_TASK_BASIS_COLLECTION_VERSION,
  type StationBasisProjection,
  type StationTaskBasisCollection,
  type StationTaskBasisCollectionGap,
} from '@kontourai/station-contracts/task-basis';
import type { SessionReadAuthority } from '@kontourai/station-contracts/tenancy';
import {
  type BasisCompositionInput,
  type BasisCompositionInputV2,
  type BasisContribution,
  type BasisContributionRef,
  type BasisProjection,
  type ContributionRead,
  type ContributionReadV2,
  composeBasisProjection,
  composeBasisProjectionV2,
  parseBasisComposition,
  parseBasisCompositionV2,
  parseBasisProjection,
  SURFACE_BASIS_V2_VERSION,
  SURFACE_BASIS_VERSION,
  type SurfaceAssessmentRead,
} from '@kontourai/surface/basis';
import type { ExactAnswerAssessmentRead } from '../evidence/answer-assessment-module.js';
import type {
  SessionAnswerBasisQueryOutcome,
  SessionQueryModule,
} from '../orchestration/session-query-module.js';
import type {
  TaskGateEvaluationReferenceRead,
  TaskToolResultReferenceRead,
} from './task-tool-result-reference-read-adapter.js';

export type StationBasisResult =
  | BasisProjection
  | ReturnType<typeof composeBasisProjectionV2>
  | StationTaskBasisCollection;
export interface TaskBasisQueryModule {
  read(input: {
    taskId: string;
    answerReferenceId?: string;
    authority: SessionReadAuthority;
    /** Required for the protected Process owner adapter on whole collections. */
    request?: Request;
  }): Promise<
    | { status: 'found'; data: StationBasisResult }
    | { status: 'not-found' }
    | { status: 'unavailable' }
  >;
}

type ReferenceLink = { id: unknown; targetId: unknown };
const MAX_REFS = 64;
const MAX_ID_BYTES = 1_024;

/**
 * Converts authorized Station owner facts into Surface's pure input. This is
 * the only Station-to-Surface semantic seam: no Task Keep or output relation
 * can alter Surface standing.
 */
export function composeAuthorizedSessionAnswerBasis(
  answer: Extract<SessionAnswerBasisQueryOutcome, { status: 'found' }>,
  assessment: SurfaceAssessmentRead = {
    owner: { authority: '@kontourai/surface' },
    state: 'not-captured',
    observedAt: answer.observedAt,
  },
  narrative?: ContributionRead,
  reviewedSource?: ContributionReadV2,
): BasisProjection | ReturnType<typeof composeBasisProjectionV2> {
  const input: BasisCompositionInput = {
    version: SURFACE_BASIS_VERSION,
    answer: {
      owner: { authority: '@kontourai/thread' },
      state: 'available',
      observedAt: answer.observedAt,
      value: {
        ref: answer.binding.answer,
        fact: 'answer-observed',
        observedAt: answer.observedAt,
      },
    },
    assessment,
    contributions: [
      {
        owner: { authority: '@kontourai/station' },
        state: 'available',
        observedAt: answer.observedAt,
        value: answer.inputs.flatMap(
          (item) => inputContribution(answer, item) ?? [],
        ),
      },
      ...(narrative ? [narrative] : []),
      {
        owner: { authority: '@kontourai/thread' },
        state: 'available',
        observedAt: answer.observedAt,
        value: answer.results.flatMap(
          (item) => resultContribution(answer, item) ?? [],
        ),
      },
    ],
  };
  // Surface owns total parsing and standing. Host context is pre-sanitized so
  // malformed owner display fields cannot turn one Task answer into a 500.
  const parsed = parseBasisComposition(input);
  const projection = composeBasisProjection(parsed.ok ? parsed.value : input);
  const roundTrip = parseBasisProjection(projection);
  const legacy = roundTrip.ok ? roundTrip.value : composeBasisProjection(input);
  if (!reviewedSource) return legacy;
  const v2: BasisCompositionInputV2 = {
    version: SURFACE_BASIS_V2_VERSION,
    answer: legacy.answer,
    assessment: legacy.assessment,
    contributions: [...input.contributions, reviewedSource],
  };
  const parsedV2 = parseBasisCompositionV2(v2);
  const projectionV2 = composeBasisProjectionV2(
    parsedV2.ok ? parsedV2.value : v2,
  );
  return projectionV2;
}

export function createTaskBasisQueryModule(input: {
  taskGraph: {
    readTaskTurnReferenceScope(taskId: string): { projectId: string } | null;
    readTaskTurnReferenceLinks(taskId: string): readonly ReferenceLink[] | null;
    readTaskAnswerNarrativePin?(
      taskId: string,
      turnTargetId: string,
    ): number | undefined;
  };
  sessionQueries: Pick<SessionQueryModule, 'readAnswerBasis'>;
  outputs: { list(taskId: string): Promise<readonly { id: unknown }[]> };
  toolResultReferences: TaskToolResultReferenceRead;
  /** Constructor-composed owner adapter; Task never reads Flow directly. */
  gateEvaluationReferences?: TaskGateEvaluationReferenceRead;
  /** One exact owner resolver; whole-Task never searches for assessments. */
  readAssessment?: (input: {
    answer: Extract<SessionAnswerBasisQueryOutcome, { status: 'found' }>;
    authority: SessionReadAuthority;
    taskId: string;
    answerReferenceId: string;
  }) => Promise<ExactAnswerAssessmentRead>;
  /** Exact producer source arm; Task never discovers sources itself. */
  readReviewedSource?: (input: {
    answer: Extract<SessionAnswerBasisQueryOutcome, { status: 'found' }>;
    assessment: ExactAnswerAssessmentRead | undefined;
    authority: SessionReadAuthority;
    taskId: string;
    answerReferenceId: string;
  }) => Promise<ContributionReadV2 | undefined>;
  /** Task reads resolve only their private pin, never a mutable association head. */
  readNarrative?: (input: {
    answer: Extract<SessionAnswerBasisQueryOutcome, { status: 'found' }>;
    authority: SessionReadAuthority;
    taskId: string;
    answerReferenceId: string;
    associationRevision?: number;
    request?: Request;
  }) => Promise<ContributionRead>;
}): TaskBasisQueryModule {
  return {
    async read({ taskId, answerReferenceId, authority, request }) {
      if (
        !id(taskId) ||
        (answerReferenceId !== undefined && !id(answerReferenceId))
      )
        return { status: 'not-found' };
      const scope = input.taskGraph.readTaskTurnReferenceScope(taskId);
      const source = input.taskGraph.readTaskTurnReferenceLinks(taskId);
      if (!scope) return { status: 'not-found' };
      if (!source || source.length > MAX_REFS) return { status: 'not-found' };
      const links = [...source]
        .filter((link) => id(link.id) && id(link.targetId))
        .sort((a, b) => String(a.id).localeCompare(String(b.id)));
      if (answerReferenceId && links.length !== source.length)
        return { status: 'not-found' };
      const selected = answerReferenceId
        ? links.filter((link) => link.id === answerReferenceId)
        : links;
      if (answerReferenceId && selected.length !== 1)
        return { status: 'not-found' };
      const answers: {
        answerReferenceId: string;
        projection: StationBasisProjection;
      }[] = [];
      const gaps = new Set<StationTaskBasisCollectionGap['state']>();
      if (!answerReferenceId && links.length !== source.length)
        gaps.add('corrupt');
      for (const link of selected) {
        const tuple = parseTaskTurnReference(String(link.targetId));
        if (!tuple) {
          if (answerReferenceId) return { status: 'not-found' };
          gaps.add('corrupt');
          continue;
        }
        const answer = await input.sessionQueries.readAnswerBasis?.(
          {
            type: 'answer-basis',
            threadId: tuple.sessionId,
            turnId: tuple.turnId,
          },
          authority,
        );
        if (answer?.status === 'unavailable') {
          if (answerReferenceId) return { status: 'unavailable' };
          gaps.add('unavailable');
          continue;
        }
        if (answer?.status === 'corrupt') {
          if (answerReferenceId) return { status: 'not-found' };
          gaps.add('corrupt');
          continue;
        }
        if (
          answer?.status !== 'found' ||
          (answer.projectSlug !== undefined &&
            answer.projectSlug !== scope.projectId)
        ) {
          if (answerReferenceId) return { status: 'not-found' };
          gaps.add('restricted');
          continue;
        }
        try {
          const assessed = input.readAssessment
            ? await input.readAssessment({
                answer,
                authority,
                taskId,
                answerReferenceId: link.id as string,
              })
            : undefined;
          const assessment = assessed?.assessment;
          const narrative = input.readNarrative
            ? await input.readNarrative({
                answer,
                authority,
                taskId,
                answerReferenceId: link.id as string,
                associationRevision:
                  input.taskGraph.readTaskAnswerNarrativePin?.(
                    taskId,
                    link.targetId as string,
                  ),
                request,
              })
            : undefined;
          const reviewedSource = input.readReviewedSource
            ? await input.readReviewedSource({
                answer,
                assessment: assessed,
                authority,
                taskId,
                answerReferenceId: link.id as string,
              })
            : undefined;
          answers.push({
            answerReferenceId: link.id as string,
            projection: composeAuthorizedSessionAnswerBasis(
              answer,
              assessment,
              narrative,
              reviewedSource,
            ),
          });
        } catch {
          if (answerReferenceId) return { status: 'unavailable' };
          gaps.add('corrupt');
        }
      }
      if (answerReferenceId)
        return answers.length === 1
          ? { status: 'found', data: answers[0]!.projection }
          : { status: 'not-found' };
      let outputs: readonly { id: unknown }[];
      try {
        outputs = await input.outputs.list(taskId);
      } catch {
        outputs = [];
        gaps.add('unavailable');
      }
      const unassociated = outputs
        .flatMap((output) =>
          id(output.id)
            ? [
                {
                  kind: 'task-output' as const,
                  taskId,
                  outputId: output.id,
                  kept: true as const,
                },
              ]
            : [],
        )
        .sort((a, b) => a.outputId.localeCompare(b.outputId));
      if (unassociated.length !== outputs.length) gaps.add('corrupt');
      const kept = await input.toolResultReferences.read({ taskId, authority });
      if (kept.status === 'unavailable') gaps.add('unavailable');
      else if (kept.status === 'not-found') gaps.add('restricted');
      else {
        for (const gap of kept.gaps ?? []) gaps.add(gap.state);
      }
      const uniqueKept =
        kept.status === 'found'
          ? [
              ...new Map(
                kept.references.map((item) => [
                  JSON.stringify([item.ref.threadId, item.ref.resultId]),
                  item,
                ]),
              ).values(),
            ]
          : [];
      if (
        kept.status === 'found' &&
        uniqueKept.length !== kept.references.length
      )
        gaps.add('corrupt');
      const keptToolResults =
        kept.status === 'found'
          ? uniqueKept.map(({ referenceId, ref }) => ({
              referenceId,
              ref,
              kept: true as const,
              associatedAnswerReferenceIds: answers
                .filter(({ projection }) => executionContains(projection, ref))
                .map(({ answerReferenceId }) => answerReferenceId),
            }))
          : [];
      const gateEvaluations =
        !answerReferenceId && input.gateEvaluationReferences && request
          ? await input.gateEvaluationReferences.read({ taskId, request })
          : undefined;
      const processGaps: StationTaskBasisCollectionGap[] =
        gateEvaluations?.status === 'unavailable'
          ? [{ state: 'unavailable', scope: 'process' }]
          : gateEvaluations?.status === 'not-found'
            ? [{ state: 'restricted', scope: 'process' }]
            : (gateEvaluations?.gaps ?? []).map((gap) => ({
                state: gap.state,
                scope: 'process' as const,
              }));
      return {
        status: 'found',
        data: {
          version: STATION_TASK_BASIS_COLLECTION_VERSION,
          taskId,
          answers,
          unassociated,
          keptToolResults,
          keptGateEvaluations:
            gateEvaluations?.status === 'found'
              ? gateEvaluations.references.map((reference) => ({
                  referenceId: reference.referenceId,
                  kept: true as const,
                  evaluation: reference.evaluation,
                }))
              : [],
          gaps: [
            ...[...gaps].sort().map((state) => ({ state })),
            ...processGaps,
          ],
        } as StationTaskBasisCollection,
      };
    },
  };
}

function executionContains(
  projection: StationBasisProjection,
  ref: Extract<
    BasisContributionRef,
    { authority: '@kontourai/thread'; kind: 'result' }
  >,
): boolean {
  const parsed = parseStationBasisProjection(projection);
  return (
    parsed?.regions.execution.some(
      (item) =>
        item.ref.authority === '@kontourai/thread' &&
        item.ref.schemaVersion === '1.2.0' &&
        item.ref.kind === 'result' &&
        item.ref.threadId === ref.threadId &&
        item.ref.resultId === ref.resultId,
    ) ?? false
  );
}

type FoundAnswer = Extract<SessionAnswerBasisQueryOutcome, { status: 'found' }>;
type InputContribution = BasisContribution<
  Extract<
    BasisContributionRef,
    { authority: '@kontourai/station'; kind: 'input' }
  >
>;
type ResultContribution = BasisContribution<
  Extract<
    BasisContributionRef,
    { authority: '@kontourai/thread'; kind: 'result' }
  >
>;

function inputContribution(
  answer: FoundAnswer,
  item: FoundAnswer['inputs'][number],
): InputContribution | null {
  if (!id(item.eventId)) return null;
  const promptExcerpt = safeContextScalar(item.prompt, 512);
  const inputKind =
    item.kind === 'initial' || item.kind === 'steer' || item.kind === 'unknown'
      ? item.kind
      : 'unknown';
  const attachmentCount = Array.isArray(item.attachments)
    ? Math.min(item.attachments.length, 1_000_000_000)
    : 0;
  return {
    ref: {
      authority: '@kontourai/station',
      schemaVersion: '1',
      kind: 'input',
      sessionId: answer.sessionId,
      eventId: item.eventId,
    },
    answer: answer.binding.answer,
    role: 'input',
    context: {
      kind: 'station-input',
      inputKind,
      ...(promptExcerpt ? { promptExcerpt } : {}),
      attachmentCount,
    },
    ...(item.prompt && !promptExcerpt
      ? {
          gaps: [
            {
              code: 'owner-context-not-captured',
              message: 'Station input context was not captured safely.',
            },
          ],
        }
      : {}),
  };
}

function resultContribution(
  answer: FoundAnswer,
  item: FoundAnswer['results'][number],
): ResultContribution | null {
  if (!id(item.result.resultId)) return null;
  const name = safeContextScalar(item.result.name, 512) ?? 'unknown';
  const terminalStatus =
    safeContextScalar(item.result.terminalStatus, 64) ?? 'unknown';
  const textParts = Array.isArray(item.result.content)
    ? item.result.content.filter((part) => part.type === 'text').length
    : 0;
  return {
    ref: {
      authority: '@kontourai/thread',
      schemaVersion: '1.2.0',
      kind: 'result',
      threadId: answer.sessionId,
      resultId: item.result.resultId,
    },
    answer: answer.binding.answer,
    role: 'execution',
    context: {
      kind: 'thread-result',
      name,
      terminalStatus,
      textParts,
      truncatedParts: item.result.truncated ? item.result.omittedParts : 0,
      omittedParts: item.result.omittedParts,
    },
    ...((name === 'unknown' || terminalStatus === 'unknown') &&
    (item.result.name !== 'unknown' || item.result.terminalStatus !== 'unknown')
      ? {
          gaps: [
            {
              code: 'owner-context-not-captured',
              message: 'Thread result context was not captured safely.',
            },
          ],
        }
      : {}),
  };
}

/** Conservative subset of Surface's inert display scalar contract. */
function safeContextScalar(
  value: unknown,
  maximumBytes: number,
): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  let bytes = 0;
  let output = '';
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return null;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      const previous = value.charCodeAt(index - 1);
      if (previous < 0xd800 || previous > 0xdbff) return null;
    }
    const codePoint = value.codePointAt(index)!;
    if (
      codePoint < 0x20 ||
      codePoint === 0x7f ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    )
      return null;
    const token = String.fromCodePoint(codePoint);
    const tokenBytes = Buffer.byteLength(token, 'utf8');
    if (bytes + tokenBytes > maximumBytes) break;
    output += token;
    bytes += tokenBytes;
    if (codePoint > 0xffff) index += 1;
  }
  return output || null;
}

function id(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= MAX_ID_BYTES
  );
}
