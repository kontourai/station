/**
 * Station's host boundary for Surface Basis. Standing, regions, parsing and
 * composition are deliberately owned by Surface Basis.
 */

import {
  type GateEvaluationReadProjection,
  parseGateEvaluationReadResult,
} from '@kontourai/flow/gate-evaluation-contract';
import type { BasisProjection } from '@kontourai/surface/basis';
import {
  type BasisContributionRef,
  composeBasisProjectionV2,
  parseBasisComposition,
  parseBasisProjection,
  parseBasisProjectionV2,
  SURFACE_BASIS_VERSION,
} from '@kontourai/surface/basis';
import {
  createObservedMessageIdentity,
  createThreadAnswerRef,
  parseThreadAnswerRef,
  type ThreadAnswerRef,
} from '@kontourai/thread/answer';
import { MAX_TASK_REFERENCES_PER_TASK } from './task-graph.js';

export const STATION_ANSWER_BINDING_VERSION =
  'station-answer-binding/v1' as const;
export const STATION_TASK_BASIS_COLLECTION_VERSION =
  'station.task-basis-collection/v4' as const;
export const STATION_BASIS_MAX_ID_BYTES = 1_024;

export interface StationAnswerBinding {
  version: typeof STATION_ANSWER_BINDING_VERSION;
  sessionId: string;
  turnId: string;
  answer: ThreadAnswerRef;
}

/**
 * Uses the same descriptor-safe scalar boundary as public parsing. A hostile
 * object cannot execute a getter merely by asking Station to construct a ref.
 */
export function createStationAnswerBinding(input: {
  sessionId: string;
  turnId: string;
  messageId: string;
}): StationAnswerBinding {
  const data = snapshotRecord(input, ['sessionId', 'turnId', 'messageId']);
  if (
    !data ||
    !isStationBasisId(data.sessionId) ||
    !isStationBasisId(data.turnId) ||
    !isStationBasisId(data.messageId)
  )
    throw new TypeError('Station answer binding requires exact non-empty ids');
  return {
    version: STATION_ANSWER_BINDING_VERSION,
    sessionId: data.sessionId,
    turnId: data.turnId,
    answer: createThreadAnswerRef(
      createObservedMessageIdentity(data.sessionId, data.messageId),
    ),
  };
}

/** Fail closed without evaluating accessors or hostile proxy traps. */
export function parseStationAnswerBinding(
  value: unknown,
): StationAnswerBinding | null {
  try {
    const data = snapshotRecord(value, [
      'version',
      'sessionId',
      'turnId',
      'answer',
    ]);
    if (
      !data ||
      data.version !== STATION_ANSWER_BINDING_VERSION ||
      !isStationBasisId(data.sessionId) ||
      !isStationBasisId(data.turnId)
    )
      return null;
    const answerData = snapshotRecord(data.answer, [
      'authority',
      'schemaVersion',
      'kind',
      'standing',
      'threadId',
      'messageId',
    ]);
    if (!answerData) return null;
    const answer = parseThreadAnswerRef(answerData);
    return answer.threadId === data.sessionId &&
      isStationBasisId(answer.messageId)
      ? {
          version: STATION_ANSWER_BINDING_VERSION,
          sessionId: data.sessionId,
          turnId: data.turnId,
          answer,
        }
      : null;
  } catch {
    return null;
  }
}

export interface StationTaskBasisCollection {
  version: typeof STATION_TASK_BASIS_COLLECTION_VERSION;
  taskId: string;
  answers: readonly StationTaskBasisCollectionAnswer[];
  unassociated: readonly StationTaskBasisCollectionItem[];
  keptToolResults: readonly StationTaskBasisKeptToolResult[];
  /**
   * A separate retained Process stream. It is never associated with answers
   * and never contributes a Task-wide standing.
   */
  keptGateEvaluations: readonly StationTaskBasisKeptGateEvaluation[];
  gaps: readonly StationTaskBasisCollectionGap[];
}

export interface StationTaskBasisKeptGateEvaluation {
  referenceId: string;
  kept: true;
  evaluation: GateEvaluationReadProjection;
}

export interface StationTaskBasisKeptToolResult {
  referenceId: string;
  ref: Extract<
    import('@kontourai/surface/basis').BasisContributionRef,
    { authority: '@kontourai/thread'; kind: 'result' }
  >;
  kept: true;
  associatedAnswerReferenceIds: readonly string[];
}

export type StationTaskBasisCollectionItem =
  | { kind: 'task-output'; taskId: string; outputId: string; kept: true }
  | { kind: 'answer-binding'; binding: StationAnswerBinding; kept: true };

export interface StationTaskBasisCollectionAnswer {
  answerReferenceId: string;
  projection: StationBasisProjection;
}

/** Surface v2 adds the owner-authenticated reviewed-source arm. */
export type StationBasisProjection =
  | BasisProjection
  | ReturnType<typeof composeBasisProjectionV2>;

/** Surface remains the parser authority for both closed Basis wires. */
export function parseStationBasisProjection(
  value: unknown,
): StationBasisProjection | null {
  const v1 = parseBasisProjection(value);
  if (v1.ok) return v1.value;
  const v2 = parseBasisProjectionV2(value);
  return v2.ok ? v2.value : null;
}

export type StationTaskBasisCollectionGap = {
  state: 'restricted' | 'corrupt' | 'unavailable';
  /** An opaque Process owner availability observation, never an answer gap. */
  scope?: 'process';
};

/** Parses Station envelope fields; Surface parses every projection. */
export function parseStationTaskBasisCollection(
  value: unknown,
): StationTaskBasisCollection | null {
  try {
    const data = snapshotRecord(value, [
      'version',
      'taskId',
      'answers',
      'unassociated',
      'keptToolResults',
      'keptGateEvaluations',
      'gaps',
    ]);
    if (
      !data ||
      data.version !== STATION_TASK_BASIS_COLLECTION_VERSION ||
      !isStationBasisId(data.taskId)
    )
      return null;
    const taskId = data.taskId;
    const answers = snapshotArray(data.answers, 64);
    const unassociated = snapshotArray(data.unassociated, 64);
    const keptToolResults = snapshotArray(
      data.keptToolResults,
      MAX_TASK_REFERENCES_PER_TASK,
    );
    const keptGateEvaluations = snapshotArray(
      data.keptGateEvaluations,
      MAX_TASK_REFERENCES_PER_TASK,
    );
    const rawGaps = snapshotArray(data.gaps, 3);
    if (
      !answers ||
      !unassociated ||
      !keptToolResults ||
      !keptGateEvaluations ||
      !rawGaps
    )
      return null;
    const parsedAnswers = answers.map(parseCollectionAnswer);
    const items = unassociated.map((item) => parseCollectionItem(item, taskId));
    const results = keptToolResults.map(parseStationTaskBasisKeptToolResult);
    const evaluations = keptGateEvaluations.map(
      parseStationTaskBasisKeptGateEvaluation,
    );
    const gaps = rawGaps.map(parseCollectionGap);
    if (
      parsedAnswers.some((answer) => !answer) ||
      items.some((item) => !item) ||
      gaps.some((gap) => !gap) ||
      results.some((result) => !result) ||
      evaluations.some((evaluation) => !evaluation)
    )
      return null;
    const answerIds = new Set(
      (parsedAnswers as StationTaskBasisCollectionAnswer[]).map(
        (answer) => answer.answerReferenceId,
      ),
    );
    if (
      new Set(
        (parsedAnswers as StationTaskBasisCollectionAnswer[]).map(
          (answer) => answer.answerReferenceId,
        ),
      ).size !== parsedAnswers.length ||
      new Set(
        (results as StationTaskBasisKeptToolResult[]).map(
          (result) => result.referenceId,
        ),
      ).size !== results.length ||
      new Set(
        (evaluations as StationTaskBasisKeptGateEvaluation[]).map(
          (evaluation) => evaluation.referenceId,
        ),
      ).size !== evaluations.length ||
      new Set(
        (results as StationTaskBasisKeptToolResult[]).map((result) =>
          resultTupleKey(result.ref),
        ),
      ).size !== results.length ||
      !hasExactExecutionAssociations(
        parsedAnswers as StationTaskBasisCollectionAnswer[],
        results as StationTaskBasisKeptToolResult[],
        answerIds,
      )
    )
      return null;
    return {
      version: STATION_TASK_BASIS_COLLECTION_VERSION,
      taskId,
      answers: parsedAnswers as StationTaskBasisCollectionAnswer[],
      unassociated: items as StationTaskBasisCollectionItem[],
      keptToolResults: results as StationTaskBasisKeptToolResult[],
      keptGateEvaluations: evaluations as StationTaskBasisKeptGateEvaluation[],
      gaps: [
        ...new Map(
          gaps.map((gap) => [`${gap!.scope ?? 'answers'}:${gap!.state}`, gap!]),
        ).values(),
      ],
    };
  } catch {
    return null;
  }
}

/** Flow owns the published projection grammar; Station only retains identity. */
export function parseStationTaskBasisKeptGateEvaluation(
  value: unknown,
): StationTaskBasisKeptGateEvaluation | null {
  const data = snapshotRecord(value, ['referenceId', 'kept', 'evaluation']);
  if (data?.kept !== true || !isStationBasisId(data.referenceId)) return null;
  const parsed = parseGateEvaluationReadResult({
    status: 'found',
    evaluation: data.evaluation,
  });
  return parsed?.status === 'found'
    ? {
        referenceId: data.referenceId,
        kept: true,
        evaluation: parsed.evaluation,
      }
    : null;
}

/**
 * Parses one kept-result descriptor without assuming its associations are
 * present in this payload. Paginated readers use this narrow parser; complete
 * collection parsing below proves associations against every available answer.
 */
export function parseStationTaskBasisKeptToolResult(
  value: unknown,
): StationTaskBasisKeptToolResult | null {
  const data = snapshotRecord(value, [
    'referenceId',
    'ref',
    'kept',
    'associatedAnswerReferenceIds',
  ]);
  if (data?.kept !== true || !isStationBasisId(data.referenceId)) return null;
  const associated = snapshotArray(data.associatedAnswerReferenceIds, 64);
  if (!associated?.every(isStationBasisId)) return null;
  if (new Set(associated).size !== associated.length) return null;
  // Surface owns the exact published contribution-ref grammar. Its public
  // parser snapshots before inspecting fields, so this never evaluates a
  // hostile getter on a producer-owned ref.
  const ref = parseSurfaceResultContributionRef(data.ref);
  if (!ref) return null;
  return {
    referenceId: data.referenceId,
    ref,
    kept: true,
    associatedAnswerReferenceIds: associated,
  };
}

function parseSurfaceResultContributionRef(
  value: unknown,
): StationTaskBasisKeptToolResult['ref'] | null {
  const parsed = parseBasisComposition({
    version: SURFACE_BASIS_VERSION,
    answer: {
      owner: { authority: '@kontourai/thread' },
      state: 'available',
      observedAt: '2026-01-01T00:00:00.000Z',
      value: {
        ref: {
          authority: '@kontourai/thread',
          schemaVersion: '1.2.0',
          kind: 'assistant-message',
          standing: 'observed',
          threadId: 'station-kept-result-parser',
          messageId: 'station-kept-result-parser',
        },
        fact: 'answer-observed',
        observedAt: '2026-01-01T00:00:00.000Z',
      },
    },
    assessment: {
      owner: { authority: '@kontourai/surface' },
      state: 'not-captured',
      observedAt: '2026-01-01T00:00:00.000Z',
    },
    contributions: [
      {
        owner: { authority: '@kontourai/thread' },
        state: 'available',
        observedAt: '2026-01-01T00:00:00.000Z',
        value: [
          {
            ref: value,
            answer: {
              authority: '@kontourai/thread',
              schemaVersion: '1.2.0',
              kind: 'assistant-message',
              standing: 'observed',
              threadId: 'station-kept-result-parser',
              messageId: 'station-kept-result-parser',
            },
            role: 'execution',
            context: {
              kind: 'thread-result',
              name: 'result',
              terminalStatus: 'unknown',
              truncatedParts: 0,
              omittedParts: 0,
            },
            gaps: [],
          },
        ],
      },
    ],
  });
  if (!parsed.ok) return null;
  const contribution = parsed.value.contributions.find(
    (item) => item.owner.authority === '@kontourai/thread',
  );
  const ref =
    contribution?.state === 'available' ? contribution.value[0]?.ref : null;
  return ref &&
    ref.authority === '@kontourai/thread' &&
    ref.schemaVersion === '1.2.0' &&
    ref.kind === 'result'
    ? (ref as Extract<
        BasisContributionRef,
        { authority: '@kontourai/thread'; kind: 'result' }
      >)
    : null;
}

function resultTupleKey(ref: StationTaskBasisKeptToolResult['ref']): string {
  return JSON.stringify([ref.threadId, ref.resultId]);
}

function hasExactExecutionAssociations(
  answers: readonly StationTaskBasisCollectionAnswer[],
  results: readonly StationTaskBasisKeptToolResult[],
  answerIds: ReadonlySet<string>,
): boolean {
  const executionByAnswer = new Map<string, Set<string>>();
  for (const answer of answers) {
    const projection = parseStationBasisProjection(answer.projection);
    if (!projection) return false;
    const execution = new Set<string>();
    for (const item of projection.regions.execution) {
      const ref = item.ref;
      if (
        ref.authority === '@kontourai/thread' &&
        ref.schemaVersion === '1.2.0' &&
        ref.kind === 'result'
      )
        execution.add(resultTupleKey(ref));
    }
    executionByAnswer.set(answer.answerReferenceId, execution);
  }
  return results.every((result) =>
    result.associatedAnswerReferenceIds.every(
      (answerId) =>
        answerIds.has(answerId) &&
        executionByAnswer.get(answerId)?.has(resultTupleKey(result.ref)),
    ),
  );
}

function parseCollectionAnswer(
  value: unknown,
): StationTaskBasisCollectionAnswer | null {
  const data = snapshotRecord(value, ['answerReferenceId', 'projection']);
  return data && isStationBasisId(data.answerReferenceId)
    ? {
        answerReferenceId: data.answerReferenceId,
        projection: data.projection as StationBasisProjection,
      }
    : null;
}

/** Well-formed Unicode and bounded UTF-8 before allocating an encoder buffer. */
export function isStationBasisId(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > STATION_BASIS_MAX_ID_BYTES
  )
    return false;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return (
    new TextEncoder().encode(value).byteLength <= STATION_BASIS_MAX_ID_BYTES
  );
}

function parseCollectionItem(
  value: unknown,
  taskId: string,
): StationTaskBasisCollectionItem | null {
  const base = snapshotRecord(value, ['kind', 'taskId', 'outputId', 'kept']);
  if (
    base &&
    base.kind === 'task-output' &&
    base.taskId === taskId &&
    base.kept === true &&
    isStationBasisId(base.outputId)
  )
    return { kind: 'task-output', taskId, outputId: base.outputId, kept: true };
  const bindingItem = snapshotRecord(value, ['kind', 'binding', 'kept']);
  if (
    bindingItem &&
    bindingItem.kind === 'answer-binding' &&
    bindingItem.kept === true
  ) {
    const binding = parseStationAnswerBinding(bindingItem.binding);
    return binding ? { kind: 'answer-binding', binding, kept: true } : null;
  }
  return null;
}

function parseCollectionGap(
  value: unknown,
): StationTaskBasisCollectionGap | null {
  const data =
    snapshotRecord(value, ['state', 'scope']) ??
    snapshotRecord(value, ['state']);
  if (
    !data ||
    typeof data.state !== 'string' ||
    !['restricted', 'corrupt', 'unavailable'].includes(data.state) ||
    (data.scope !== undefined && data.scope !== 'process')
  )
    return null;
  return {
    state: data.state as StationTaskBasisCollectionGap['state'],
    ...(data.scope === 'process' ? { scope: 'process' as const } : {}),
  };
}

/** Own enumerable data properties only: no getters, inherited state, or proxy trust. */
function snapshotRecord(
  value: unknown,
  expected: readonly string[],
): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Reflect.ownKeys(value).sort((left, right) =>
    String(left).localeCompare(String(right)),
  );
  const wanted = [...expected].sort();
  if (
    keys.length !== wanted.length ||
    keys.some((key, index) => typeof key !== 'string' || key !== wanted[index])
  )
    return null;
  const output: Record<string, unknown> = {};
  for (const key of wanted) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) return null;
    output[key] = descriptor.value;
  }
  return output;
}

function snapshotArray(value: unknown, maximum: number): unknown[] | null {
  if (!Array.isArray(value)) return null;
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    !length ||
    !('value' in length) ||
    !Number.isSafeInteger(length.value) ||
    length.value > maximum
  )
    return null;
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== length.value + 1 ||
    keys.some(
      (key) =>
        key !== 'length' &&
        (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(key)),
    )
  )
    return null;
  const output: unknown[] = [];
  for (let index = 0; index < length.value; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor)) return null;
    output.push(descriptor.value);
  }
  return output;
}
