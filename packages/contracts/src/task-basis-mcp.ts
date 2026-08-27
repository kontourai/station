/**
 * Bounded, Station-owned transport pages for an already-authorized whole-task
 * Basis collection. Surface remains the authority for every answer projection.
 */
import {
  isStationBasisId,
  parseStationBasisProjection,
  parseStationTaskBasisCollection,
  parseStationTaskBasisKeptGateEvaluation,
  parseStationTaskBasisKeptToolResult,
  type StationTaskBasisCollection,
  type StationTaskBasisCollectionAnswer,
  type StationTaskBasisCollectionGap,
  type StationTaskBasisCollectionItem,
  type StationTaskBasisKeptGateEvaluation,
  type StationTaskBasisKeptToolResult,
} from './task-basis.js';
import { MAX_TASK_REFERENCES_PER_TASK } from './task-graph.js';

export const STATION_TASK_BASIS_MCP_PAGE_VERSION =
  'station.task-basis-mcp-page/v3' as const;
export const STATION_TASK_BASIS_MCP_MAX_ANSWERS = 8;
export const STATION_TASK_BASIS_MCP_MAX_UNASSOCIATED = 16;
export const STATION_TASK_BASIS_MCP_MAX_KEPT_TOOL_RESULTS = 16;
export const STATION_TASK_BASIS_MCP_MAX_KEPT_GATE_EVALUATIONS = 16;
export const STATION_TASK_BASIS_MCP_MAX_GAPS = 3;
export const STATION_TASK_BASIS_MCP_MAX_SERIALIZED_BYTES = 128 * 1024;

export interface StationTaskBasisMcpOffsets {
  /**
   * In-memory slice positions only. They are not a portable authorization or
   * stable across a fresh collection read; #4311 owns descriptor-pinned resume.
   */
  answerOffset: number;
  unassociatedOffset: number;
  keptToolResultOffset: number;
  keptGateEvaluationOffset: number;
}

export interface StationTaskBasisMcpPage {
  version: typeof STATION_TASK_BASIS_MCP_PAGE_VERSION;
  status: 'available';
  taskId: string;
  offsets: StationTaskBasisMcpOffsets;
  answers: StationTaskBasisCollectionAnswer[];
  unassociated: StationTaskBasisCollectionItem[];
  keptToolResults: StationTaskBasisKeptToolResult[];
  keptGateEvaluations: StationTaskBasisKeptGateEvaluation[];
  gaps: StationTaskBasisCollectionGap[];
  continuation?: { offsets: StationTaskBasisMcpOffsets };
}

export interface StationTaskBasisMcpUnavailablePage {
  version: typeof STATION_TASK_BASIS_MCP_PAGE_VERSION;
  status: 'unavailable';
  taskId: string;
  offsets: StationTaskBasisMcpOffsets;
  reason: 'page-size-exceeded';
}

export type StationTaskBasisMcpPageResult =
  | StationTaskBasisMcpPage
  | StationTaskBasisMcpUnavailablePage;

/**
 * Parses an untrusted page without evaluating accessors. Every answer is
 * independently parsed by Surface; no whole-task standing is derived here.
 */
export function parseStationTaskBasisMcpPage(
  value: unknown,
): StationTaskBasisMcpPageResult | null {
  try {
    const root = snapshotRecord(value, [
      'version',
      'status',
      'taskId',
      'offsets',
      'answers',
      'unassociated',
      'keptToolResults',
      'keptGateEvaluations',
      'gaps',
      'continuation',
      'reason',
    ]);
    if (
      !root ||
      root.version !== STATION_TASK_BASIS_MCP_PAGE_VERSION ||
      !isStationBasisId(root.taskId)
    )
      return null;
    const offsets = parseOffsets(root.offsets);
    if (!offsets) return null;
    if (root.status === 'unavailable')
      return root.reason === 'page-size-exceeded' &&
        !hasOwn(root, 'answers') &&
        !hasOwn(root, 'unassociated') &&
        !hasOwn(root, 'keptToolResults') &&
        !hasOwn(root, 'keptGateEvaluations') &&
        !hasOwn(root, 'gaps') &&
        !hasOwn(root, 'continuation')
        ? {
            version: STATION_TASK_BASIS_MCP_PAGE_VERSION,
            status: 'unavailable',
            taskId: root.taskId,
            offsets,
            reason: 'page-size-exceeded',
          }
        : null;
    if (
      root.status !== 'available' ||
      hasOwn(root, 'reason') ||
      !hasOwn(root, 'answers') ||
      !hasOwn(root, 'unassociated') ||
      !hasOwn(root, 'keptToolResults') ||
      !hasOwn(root, 'keptGateEvaluations') ||
      !hasOwn(root, 'gaps')
    )
      return null;
    const answers = snapshotArray(
      root.answers,
      STATION_TASK_BASIS_MCP_MAX_ANSWERS,
    );
    const unassociated = snapshotArray(
      root.unassociated,
      STATION_TASK_BASIS_MCP_MAX_UNASSOCIATED,
    );
    const keptToolResults = snapshotArray(
      root.keptToolResults,
      STATION_TASK_BASIS_MCP_MAX_KEPT_TOOL_RESULTS,
    );
    const keptGateEvaluations = snapshotArray(
      root.keptGateEvaluations,
      STATION_TASK_BASIS_MCP_MAX_KEPT_GATE_EVALUATIONS,
    );
    const gaps = snapshotArray(root.gaps, STATION_TASK_BASIS_MCP_MAX_GAPS);
    if (
      !answers ||
      !unassociated ||
      !keptToolResults ||
      !keptGateEvaluations ||
      !gaps
    )
      return null;
    const collection = parseStationTaskBasisCollection({
      version: 'station.task-basis-collection/v4',
      taskId: root.taskId,
      answers,
      unassociated,
      // A page can include a kept result associated with an answer from a
      // prior page. Complete collection parsing rightly verifies that global
      // association; paginated transport must not pretend this page is whole.
      keptToolResults: [],
      keptGateEvaluations: [],
      gaps,
    });
    if (
      !collection ||
      collection.gaps.length !== gaps.length ||
      hasDuplicates(collection)
    )
      return null;
    const parsedKeptToolResults = keptToolResults.map(
      parseStationTaskBasisKeptToolResult,
    );
    const parsedKeptGateEvaluations = keptGateEvaluations.map(
      parseStationTaskBasisKeptGateEvaluation,
    );
    if (
      parsedKeptToolResults.some((result) => !result) ||
      hasDuplicateKeptToolResults(
        parsedKeptToolResults as StationTaskBasisKeptToolResult[],
      ) ||
      parsedKeptGateEvaluations.some((evaluation) => !evaluation) ||
      new Set(
        (parsedKeptGateEvaluations as StationTaskBasisKeptGateEvaluation[]).map(
          (evaluation) => evaluation.referenceId,
        ),
      ).size !== parsedKeptGateEvaluations.length
    )
      return null;
    const parsedAnswers = parseProjections(collection.answers);
    if (
      !parsedAnswers ||
      offsets.answerOffset + parsedAnswers.length > 64 ||
      offsets.unassociatedOffset + collection.unassociated.length > 64 ||
      offsets.keptToolResultOffset + parsedKeptToolResults.length >
        MAX_TASK_REFERENCES_PER_TASK ||
      offsets.keptGateEvaluationOffset + parsedKeptGateEvaluations.length >
        MAX_TASK_REFERENCES_PER_TASK
    )
      return null;
    const continuation = !hasOwn(root, 'continuation')
      ? undefined
      : parseContinuation(
          root.continuation,
          offsets,
          collection,
          parsedKeptToolResults.length,
          parsedKeptGateEvaluations.length,
        );
    if (hasOwn(root, 'continuation') && !continuation) return null;
    const page: StationTaskBasisMcpPage = {
      version: STATION_TASK_BASIS_MCP_PAGE_VERSION,
      status: 'available',
      taskId: root.taskId,
      offsets,
      answers: parsedAnswers,
      unassociated: [...collection.unassociated],
      keptToolResults:
        parsedKeptToolResults as StationTaskBasisKeptToolResult[],
      keptGateEvaluations:
        parsedKeptGateEvaluations as StationTaskBasisKeptGateEvaluation[],
      gaps: [...collection.gaps],
      ...(continuation ? { continuation } : {}),
    };
    return serializedBytes(page) <= STATION_TASK_BASIS_MCP_MAX_SERIALIZED_BYTES
      ? page
      : null;
  } catch {
    return null;
  }
}

/** Builds the next deterministic page from an already-authorized collection. */
export function buildStationTaskBasisMcpPage(
  collection: unknown,
  requestedOffsets: Partial<StationTaskBasisMcpOffsets> = {},
  options: { byteBudget?: number } = {},
): StationTaskBasisMcpPageResult | null {
  try {
    const byteBudget =
      options.byteBudget ?? STATION_TASK_BASIS_MCP_MAX_SERIALIZED_BYTES;
    if (
      !Number.isSafeInteger(byteBudget) ||
      byteBudget < 512 ||
      byteBudget > STATION_TASK_BASIS_MCP_MAX_SERIALIZED_BYTES
    )
      return null;
    const raw = snapshotRecord(collection, [
      'version',
      'taskId',
      'answers',
      'unassociated',
      'keptToolResults',
      'keptGateEvaluations',
      'gaps',
    ]);
    const rawAnswers = raw ? snapshotArray(raw.answers, 64) : null;
    const rawUnassociated = raw ? snapshotArray(raw.unassociated, 64) : null;
    const rawKeptToolResults = raw
      ? snapshotArray(raw.keptToolResults, MAX_TASK_REFERENCES_PER_TASK)
      : null;
    const rawKeptGateEvaluations = raw
      ? snapshotArray(raw.keptGateEvaluations, MAX_TASK_REFERENCES_PER_TASK)
      : null;
    const rawGaps = raw
      ? snapshotArray(raw.gaps, STATION_TASK_BASIS_MCP_MAX_GAPS)
      : null;
    const source =
      raw &&
      rawAnswers &&
      rawUnassociated &&
      rawKeptToolResults &&
      rawKeptGateEvaluations &&
      rawGaps
        ? parseStationTaskBasisCollection({
            version: raw.version,
            taskId: raw.taskId,
            answers: rawAnswers,
            unassociated: rawUnassociated,
            keptToolResults: rawKeptToolResults,
            keptGateEvaluations: rawKeptGateEvaluations,
            gaps: rawGaps,
          })
        : null;
    if (
      !source ||
      !rawGaps ||
      source.gaps.length !== rawGaps.length ||
      hasDuplicates(source)
    )
      return null;
    const answers = parseProjections(source.answers);
    if (!answers) return null;
    const offsets = normalizeOffsets(requestedOffsets, source);
    if (!offsets) return null;
    const terminal = buildTerminalPageIfBounded(
      source,
      answers,
      offsets,
      byteBudget,
    );
    if (terminal) return terminal;
    const page: StationTaskBasisMcpPage = {
      version: STATION_TASK_BASIS_MCP_PAGE_VERSION,
      status: 'available',
      taskId: source.taskId,
      offsets,
      answers: [],
      unassociated: [],
      keptToolResults: [],
      keptGateEvaluations: [],
      // Gaps are identity-free, mandatory context rather than a paged stream.
      gaps: [...source.gaps],
    };
    setContinuation(page, source, offsets);
    appendBounded(
      page.answers,
      answers,
      offsets.answerOffset,
      (answer) => ({
        ...answer,
      }),
      page,
      'answers',
      source,
      offsets,
      byteBudget,
    );
    if (page.answers.length === answers.length - offsets.answerOffset)
      appendBounded(
        page.unassociated,
        source.unassociated,
        offsets.unassociatedOffset,
        (item) => item,
        page,
        'unassociated',
        source,
        offsets,
        byteBudget,
      );
    if (
      page.answers.length === answers.length - offsets.answerOffset &&
      page.unassociated.length ===
        source.unassociated.length - offsets.unassociatedOffset
    )
      appendBounded(
        page.keptToolResults,
        source.keptToolResults,
        offsets.keptToolResultOffset,
        (item) => ({
          ...item,
          ref: { ...item.ref },
          associatedAnswerReferenceIds: [...item.associatedAnswerReferenceIds],
        }),
        page,
        'keptToolResults',
        source,
        offsets,
        byteBudget,
      );
    if (
      page.answers.length === answers.length - offsets.answerOffset &&
      page.unassociated.length ===
        source.unassociated.length - offsets.unassociatedOffset &&
      page.keptToolResults.length ===
        source.keptToolResults.length - offsets.keptToolResultOffset
    )
      appendBounded(
        page.keptGateEvaluations,
        source.keptGateEvaluations,
        offsets.keptGateEvaluationOffset,
        (item) => ({ ...item, evaluation: structuredClone(item.evaluation) }),
        page,
        'keptGateEvaluations',
        source,
        offsets,
        byteBudget,
      );
    if (serializedBytes(page) > byteBudget)
      return unavailable(source.taskId, offsets);
    const next = nextOffsets(page, offsets);
    if (hasRemaining(next, source)) {
      if (sameOffsets(next, offsets))
        return unavailable(source.taskId, offsets);
      page.continuation = { offsets: next };
    } else {
      delete page.continuation;
    }
    return serializedBytes(page) <= byteBudget
      ? page
      : unavailable(source.taskId, offsets);
  } catch {
    return null;
  }
}

/**
 * A final page can be smaller than an intermediate page carrying a
 * continuation. Evaluate that exact terminal shape before greedy paging.
 */
function buildTerminalPageIfBounded(
  source: StationTaskBasisCollection,
  answers: readonly StationTaskBasisCollectionAnswer[],
  offsets: StationTaskBasisMcpOffsets,
  byteBudget: number,
): StationTaskBasisMcpPage | null {
  const remainingAnswers = answers.length - offsets.answerOffset;
  const remainingUnassociated =
    source.unassociated.length - offsets.unassociatedOffset;
  const remainingKeptToolResults =
    source.keptToolResults.length - offsets.keptToolResultOffset;
  const remainingKeptGateEvaluations =
    source.keptGateEvaluations.length - offsets.keptGateEvaluationOffset;
  if (
    remainingAnswers > STATION_TASK_BASIS_MCP_MAX_ANSWERS ||
    remainingUnassociated > STATION_TASK_BASIS_MCP_MAX_UNASSOCIATED ||
    remainingKeptToolResults > STATION_TASK_BASIS_MCP_MAX_KEPT_TOOL_RESULTS ||
    remainingKeptGateEvaluations >
      STATION_TASK_BASIS_MCP_MAX_KEPT_GATE_EVALUATIONS
  )
    return null;
  const page: StationTaskBasisMcpPage = {
    version: STATION_TASK_BASIS_MCP_PAGE_VERSION,
    status: 'available',
    taskId: source.taskId,
    offsets,
    answers: answers.slice(offsets.answerOffset),
    unassociated: [...source.unassociated.slice(offsets.unassociatedOffset)],
    keptToolResults: source.keptToolResults
      .slice(offsets.keptToolResultOffset)
      .map((item) => ({
        ...item,
        ref: { ...item.ref },
        associatedAnswerReferenceIds: [...item.associatedAnswerReferenceIds],
      })),
    keptGateEvaluations: source.keptGateEvaluations
      .slice(offsets.keptGateEvaluationOffset)
      .map((item) => ({
        ...item,
        evaluation: structuredClone(item.evaluation),
      })),
    gaps: [...source.gaps],
  };
  return serializedBytes(page) <= byteBudget ? page : null;
}

function appendBounded<T>(
  target: T[],
  source: readonly T[],
  offset: number,
  copy: (value: T) => T,
  page: StationTaskBasisMcpPage,
  key: 'answers' | 'unassociated' | 'keptToolResults' | 'keptGateEvaluations',
  collection: StationTaskBasisCollection,
  offsets: StationTaskBasisMcpOffsets,
  byteBudget: number,
): void {
  const maximum =
    key === 'answers'
      ? STATION_TASK_BASIS_MCP_MAX_ANSWERS
      : key === 'unassociated'
        ? STATION_TASK_BASIS_MCP_MAX_UNASSOCIATED
        : STATION_TASK_BASIS_MCP_MAX_KEPT_TOOL_RESULTS;
  const boundedMaximum =
    key === 'keptGateEvaluations'
      ? STATION_TASK_BASIS_MCP_MAX_KEPT_GATE_EVALUATIONS
      : maximum;
  for (
    let index = offset;
    index < source.length && target.length < boundedMaximum;
    index += 1
  ) {
    target.push(copy(source[index]!));
    setContinuation(page, collection, offsets);
    if (serializedBytes(page) > byteBudget) {
      target.pop();
      setContinuation(page, collection, offsets);
      return;
    }
  }
}

function nextOffsets(
  page: StationTaskBasisMcpPage,
  offsets: StationTaskBasisMcpOffsets,
): StationTaskBasisMcpOffsets {
  return {
    answerOffset: offsets.answerOffset + page.answers.length,
    unassociatedOffset: offsets.unassociatedOffset + page.unassociated.length,
    keptToolResultOffset:
      offsets.keptToolResultOffset + page.keptToolResults.length,
    keptGateEvaluationOffset:
      offsets.keptGateEvaluationOffset + page.keptGateEvaluations.length,
  };
}

function setContinuation(
  page: StationTaskBasisMcpPage,
  collection: StationTaskBasisCollection,
  offsets: StationTaskBasisMcpOffsets,
): void {
  const next = nextOffsets(page, offsets);
  if (hasRemaining(next, collection)) page.continuation = { offsets: next };
  else delete page.continuation;
}

function parseProjections(
  answers: readonly StationTaskBasisCollectionAnswer[],
): StationTaskBasisCollectionAnswer[] | null {
  const parsed = answers.map((answer) => {
    const projection = parseStationBasisProjection(answer.projection);
    return projection
      ? {
          answerReferenceId: answer.answerReferenceId,
          projection,
        }
      : null;
  });
  return parsed.some((answer) => !answer)
    ? null
    : (parsed as StationTaskBasisCollectionAnswer[]);
}

function normalizeOffsets(
  value: unknown,
  source: StationTaskBasisCollection,
): StationTaskBasisMcpOffsets | null {
  const input = snapshotRecord(value, [
    'answerOffset',
    'unassociatedOffset',
    'keptToolResultOffset',
    'keptGateEvaluationOffset',
  ]);
  if (!input) return null;
  const answerOffset = input.answerOffset ?? 0;
  const unassociatedOffset = input.unassociatedOffset ?? 0;
  const keptToolResultOffset = input.keptToolResultOffset ?? 0;
  const keptGateEvaluationOffset = input.keptGateEvaluationOffset ?? 0;
  if (
    !isOffset(answerOffset) ||
    !isOffset(unassociatedOffset) ||
    !isOffset(keptToolResultOffset) ||
    !isOffset(keptGateEvaluationOffset)
  )
    return null;
  const offsets: StationTaskBasisMcpOffsets = {
    answerOffset,
    unassociatedOffset,
    keptToolResultOffset,
    keptGateEvaluationOffset,
  };
  return validOffsets(offsets, source) ? offsets : null;
}

function parseOffsets(value: unknown): StationTaskBasisMcpOffsets | null {
  const offsets = snapshotRecord(value, [
    'answerOffset',
    'unassociatedOffset',
    'keptToolResultOffset',
    'keptGateEvaluationOffset',
  ]);
  return offsets &&
    isOffset(offsets.answerOffset) &&
    isOffset(offsets.unassociatedOffset) &&
    isOffset(offsets.keptToolResultOffset) &&
    isOffset(offsets.keptGateEvaluationOffset) &&
    offsets.answerOffset <= 64 &&
    offsets.unassociatedOffset <= 64 &&
    offsets.keptToolResultOffset <= MAX_TASK_REFERENCES_PER_TASK &&
    offsets.keptGateEvaluationOffset <= MAX_TASK_REFERENCES_PER_TASK
    ? {
        answerOffset: offsets.answerOffset,
        unassociatedOffset: offsets.unassociatedOffset,
        keptToolResultOffset: offsets.keptToolResultOffset,
        keptGateEvaluationOffset: offsets.keptGateEvaluationOffset,
      }
    : null;
}

function parseContinuation(
  value: unknown,
  offsets: StationTaskBasisMcpOffsets,
  collection: StationTaskBasisCollection,
  keptToolResultCount: number,
  keptGateEvaluationCount: number,
): { offsets: StationTaskBasisMcpOffsets } | null {
  const data = snapshotRecord(value, ['offsets']);
  const next = data ? parseOffsets(data.offsets) : null;
  return next &&
    isOffset(next.answerOffset) &&
    isOffset(next.unassociatedOffset) &&
    isOffset(next.keptToolResultOffset) &&
    isOffset(next.keptGateEvaluationOffset) &&
    next.answerOffset <= 64 &&
    next.unassociatedOffset <= 64 &&
    next.keptToolResultOffset <= MAX_TASK_REFERENCES_PER_TASK &&
    next.keptGateEvaluationOffset <= MAX_TASK_REFERENCES_PER_TASK &&
    next.answerOffset === offsets.answerOffset + collection.answers.length &&
    next.unassociatedOffset ===
      offsets.unassociatedOffset + collection.unassociated.length &&
    next.keptToolResultOffset ===
      offsets.keptToolResultOffset + keptToolResultCount &&
    next.keptGateEvaluationOffset ===
      offsets.keptGateEvaluationOffset + keptGateEvaluationCount &&
    !sameOffsets(next, offsets)
    ? { offsets: next }
    : null;
}

function validOffsets(
  offsets: StationTaskBasisMcpOffsets,
  source: StationTaskBasisCollection,
): boolean {
  return (
    isOffset(offsets.answerOffset) &&
    isOffset(offsets.unassociatedOffset) &&
    offsets.answerOffset <= source.answers.length &&
    offsets.unassociatedOffset <= source.unassociated.length &&
    offsets.keptToolResultOffset <= source.keptToolResults.length &&
    offsets.keptGateEvaluationOffset <= source.keptGateEvaluations.length
  );
}

function isOffset(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function hasRemaining(
  offsets: StationTaskBasisMcpOffsets,
  source: StationTaskBasisCollection,
): boolean {
  return (
    offsets.answerOffset < source.answers.length ||
    offsets.unassociatedOffset < source.unassociated.length ||
    offsets.keptToolResultOffset < source.keptToolResults.length ||
    offsets.keptGateEvaluationOffset < source.keptGateEvaluations.length
  );
}

function sameOffsets(
  left: StationTaskBasisMcpOffsets,
  right: StationTaskBasisMcpOffsets,
): boolean {
  return (
    left.answerOffset === right.answerOffset &&
    left.unassociatedOffset === right.unassociatedOffset &&
    left.keptToolResultOffset === right.keptToolResultOffset &&
    left.keptGateEvaluationOffset === right.keptGateEvaluationOffset
  );
}

function hasDuplicates(collection: StationTaskBasisCollection): boolean {
  const answerIds = new Set<string>();
  const itemIds = new Set<string>();
  const gapStates = new Set<string>();
  for (const answer of collection.answers) {
    if (answerIds.has(answer.answerReferenceId)) return true;
    answerIds.add(answer.answerReferenceId);
  }
  for (const item of collection.unassociated) {
    const id =
      item.kind === 'task-output'
        ? JSON.stringify(['task-output', item.taskId, item.outputId])
        : JSON.stringify([
            'answer-binding',
            item.binding.sessionId,
            item.binding.turnId,
            item.binding.answer.messageId,
          ]);
    if (itemIds.has(id)) return true;
    itemIds.add(id);
  }
  for (const gap of collection.gaps) {
    if (gapStates.has(gap.state)) return true;
    gapStates.add(gap.state);
  }
  return false;
}

function hasDuplicateKeptToolResults(
  results: readonly StationTaskBasisKeptToolResult[],
): boolean {
  const references = new Set<string>();
  const resultRefs = new Set<string>();
  for (const result of results) {
    if (references.has(result.referenceId)) return true;
    references.add(result.referenceId);
    const key = JSON.stringify([result.ref.threadId, result.ref.resultId]);
    if (resultRefs.has(key)) return true;
    resultRefs.add(key);
  }
  return false;
}

function serializedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function unavailable(
  taskId: string,
  offsets: StationTaskBasisMcpOffsets,
): StationTaskBasisMcpUnavailablePage {
  return {
    version: STATION_TASK_BASIS_MCP_PAGE_VERSION,
    status: 'unavailable',
    taskId,
    offsets,
    reason: 'page-size-exceeded',
  };
}

function hasOwn(value: object, key: string): boolean {
  return Reflect.apply(Object.prototype.hasOwnProperty, value, [
    key,
  ]) as boolean;
}

function snapshotRecord(
  value: unknown,
  expected: readonly string[],
): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Reflect.ownKeys(value).sort((left, right) =>
    String(left).localeCompare(String(right)),
  );
  if (keys.some((key) => typeof key !== 'string')) return null;
  const output: Record<string, unknown> = {};
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) continue;
    if (!descriptor.enumerable || !('value' in descriptor)) return null;
    output[key] = descriptor.value;
  }
  return keys.every((key) => typeof key === 'string' && expected.includes(key))
    ? output
    : null;
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
  const result: unknown[] = [];
  for (let index = 0; index < length.value; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor)) return null;
    result.push(descriptor.value);
  }
  return result;
}
