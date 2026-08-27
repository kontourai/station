import {
  parseStationTaskBasisCollection,
  StationTaskBasisCollection,
  StationTaskBasisCollectionGap,
  StationTaskBasisCollectionItem,
  StationTaskBasisKeptGateEvaluation,
} from '@kontourai/station-contracts/task-basis';
import {
  parseStationTaskBasisMcpPage,
  type StationTaskBasisMcpPage,
  type StationTaskBasisMcpPageResult,
} from '@kontourai/station-contracts/task-basis-mcp';
import {
  type BasisPanelViewModel,
  buildBasisPanelViewModel,
} from '@kontourai/surface/basis/view';

export const STATION_TASK_BASIS_COLLECTION_VIEW_VERSION =
  'station.task-basis-collection-view/v1' as const;

/**
 * The caller deliberately declares which authorized transport it has. This
 * module never guesses an envelope shape or imports an MCP client.
 */
export type StationTaskBasisCollectionViewSource =
  | { kind: 'authorized-collection'; collection: StationTaskBasisCollection }
  | { kind: 'bounded-page'; page: StationTaskBasisMcpPageResult };

export interface StationTaskBasisCollectionAnswerView {
  answerReferenceId: string;
  panel: BasisPanelViewModel;
}

/**
 * A display-only projection of Flow's retained receipt.  The Flow reader has
 * already made every semantic decision here; Basis Pane only keeps its exact
 * fields together for both the native and portable renderers.
 */
export interface StationTaskBasisCollectionGateEvaluationView {
  referenceId: string;
  gateId: string;
  originalVerdict: StationTaskBasisKeptGateEvaluation['evaluation']['originalVerdict'];
  currentStanding: StationTaskBasisKeptGateEvaluation['evaluation']['currentStanding'];
  evaluatedAt: string;
  validityAsOf: string;
  /** Human-readable UTC rendering of Flow's exact validity observation. */
  validityAsOfLabel: string;
  validityScope: 'retained-immutable-bundle';
  externalRevocation: 'not-observed';
  ref: StationTaskBasisKeptGateEvaluation['evaluation']['ref'];
  previousRef?: StationTaskBasisKeptGateEvaluation['evaluation']['previousRef'];
  currentPersistedGateRef?: StationTaskBasisKeptGateEvaluation['evaluation']['currentPersistedGateRef'];
  exceptionId?: string;
  routeBack?: StationTaskBasisKeptGateEvaluation['evaluation']['routeBack'];
  selectedEvidence: StationTaskBasisKeptGateEvaluation['evaluation']['selectedEvidence'];
}

export interface StationTaskBasisCollectionChrome {
  noAggregateStandingNotice: 'Whole Task has no aggregate standing.';
  availabilityHeading: 'Availability';
  availability: readonly {
    state: StationTaskBasisCollectionGap['state'];
    scope?: 'process';
    message: string;
  }[];
  keptAnswersHeading: 'Kept answers';
  noAnswersMessage: 'No kept answers are currently available.';
  unassociatedHeading: 'Kept in Task, not associated with an answer';
  unassociatedItems: readonly { id: string; label: string }[];
  keptToolResultsHeading: 'Kept tool results';
  keptToolResultItems: readonly {
    id: string;
    label: string;
    associationMessage: string | null;
  }[];
  keptGateEvaluationsHeading: 'Process / Kept gate evaluations';
  noKeptGateEvaluationsMessage: 'No kept gate evaluations are currently available.';
}

export interface StationTaskBasisCollectionAvailableView {
  version: typeof STATION_TASK_BASIS_COLLECTION_VIEW_VERSION;
  status: 'available';
  taskId: string;
  /** Exact server order; selection identity is never derived from a title. */
  answers: readonly StationTaskBasisCollectionAnswerView[];
  /** Station chrome only: these state-only entries reveal no hidden identity. */
  availabilityGaps: readonly StationTaskBasisCollectionGap[];
  /** Retained Station records not associated with a returned answer. */
  unassociated: readonly StationTaskBasisCollectionItem[];
  /** Kept execution results, rendered as Station-owned identity chrome only. */
  keptToolResults: StationTaskBasisCollection['keptToolResults'];
  /** Separate Flow-owned Process receipts; never contribute to answer or Task standing. */
  keptGateEvaluations: readonly StationTaskBasisCollectionGateEvaluationView[];
  chrome: StationTaskBasisCollectionChrome;
  /** Present only for a bounded page that has more server-owned entries. */
  continuation: StationTaskBasisMcpPage['continuation'] | null;
}

export interface StationTaskBasisCollectionUnavailableView {
  version: typeof STATION_TASK_BASIS_COLLECTION_VIEW_VERSION;
  status: 'unavailable';
  reason: 'invalid-envelope' | 'page-size-exceeded';
}

export type StationTaskBasisCollectionView =
  | StationTaskBasisCollectionAvailableView
  | StationTaskBasisCollectionUnavailableView;

const invalid = (): StationTaskBasisCollectionUnavailableView => ({
  version: STATION_TASK_BASIS_COLLECTION_VIEW_VERSION,
  status: 'unavailable',
  reason: 'invalid-envelope',
});

/**
 * Builds Station's collection chrome while delegating every answer semantic to
 * Surface's total panel builder. This is React- and network-free by design.
 */
export function buildStationTaskBasisCollectionView(
  input: unknown,
): StationTaskBasisCollectionView {
  try {
    const source = parseSource(input);
    if (!source) return invalid();
    if (source.kind === 'authorized-collection') {
      const collection = parseStationTaskBasisCollection(source.payload);
      return collection ? fromCollection(collection) : invalid();
    }
    const page = parseStationTaskBasisMcpPage(source.payload);
    if (!page) return invalid();
    if (page.status === 'unavailable') {
      return {
        version: STATION_TASK_BASIS_COLLECTION_VIEW_VERSION,
        status: 'unavailable',
        reason: page.reason,
      };
    }
    return fromPage(page);
  } catch {
    return invalid();
  }
}

function fromCollection(
  collection: StationTaskBasisCollection,
): StationTaskBasisCollectionView {
  return available(collection, null);
}

function fromPage(
  page: StationTaskBasisMcpPage,
): StationTaskBasisCollectionView {
  return available(page, page.continuation ?? null);
}

function available(
  collection: Pick<
    StationTaskBasisCollection,
    | 'taskId'
    | 'answers'
    | 'unassociated'
    | 'keptToolResults'
    | 'keptGateEvaluations'
    | 'gaps'
  >,
  continuation: StationTaskBasisMcpPage['continuation'] | null,
): StationTaskBasisCollectionView {
  if (!hasUniqueAnswerReferences(collection.answers)) return invalid();
  const availableAnswerReferences = new Set(
    collection.answers.map((answer) => answer.answerReferenceId),
  );
  return {
    version: STATION_TASK_BASIS_COLLECTION_VIEW_VERSION,
    status: 'available',
    taskId: collection.taskId,
    answers: collection.answers.map((answer) => ({
      answerReferenceId: answer.answerReferenceId,
      panel: buildBasisPanelViewModel(answer.projection),
    })),
    availabilityGaps: collection.gaps.map((gap) => ({ ...gap })),
    unassociated: collection.unassociated,
    keptToolResults: collection.keptToolResults,
    keptGateEvaluations: collection.keptGateEvaluations.map((item) => ({
      referenceId: item.referenceId,
      gateId: item.evaluation.ref.gateId,
      originalVerdict: item.evaluation.originalVerdict,
      currentStanding: item.evaluation.currentStanding,
      evaluatedAt: item.evaluation.evaluatedAt,
      validityAsOf: item.evaluation.validityAsOf,
      validityAsOfLabel: formatReceiptTime(item.evaluation.validityAsOf),
      validityScope: item.evaluation.validityScope,
      externalRevocation: item.evaluation.externalRevocation,
      ref: item.evaluation.ref,
      ...(item.evaluation.previousRef
        ? { previousRef: item.evaluation.previousRef }
        : {}),
      ...(item.evaluation.currentPersistedGateRef
        ? { currentPersistedGateRef: item.evaluation.currentPersistedGateRef }
        : {}),
      ...(item.evaluation.exceptionId
        ? { exceptionId: item.evaluation.exceptionId }
        : {}),
      ...(item.evaluation.routeBack
        ? { routeBack: item.evaluation.routeBack }
        : {}),
      selectedEvidence: item.evaluation.selectedEvidence,
    })),
    chrome: {
      noAggregateStandingNotice: 'Whole Task has no aggregate standing.',
      availabilityHeading: 'Availability',
      availability: collection.gaps.map((gap) => ({
        state: gap.state,
        ...(gap.scope === 'process' ? { scope: 'process' as const } : {}),
        message:
          gap.scope === 'process'
            ? `Some kept Process context is ${gap.state}.`
            : `Some kept answer context is ${gap.state}.`,
      })),
      keptAnswersHeading: 'Kept answers',
      noAnswersMessage: 'No kept answers are currently available.',
      unassociatedHeading: 'Kept in Task, not associated with an answer',
      unassociatedItems: collection.unassociated.map((item, index) => ({
        id:
          item.kind === 'task-output'
            ? `task-output:${item.outputId}`
            : `answer-binding:${item.binding.sessionId}:${item.binding.turnId}:${index}`,
        label:
          item.kind === 'task-output'
            ? `Task output ${item.outputId}`
            : `Answer reference for session ${item.binding.sessionId}, turn ${item.binding.turnId}`,
      })),
      keptToolResultsHeading: 'Kept tool results',
      keptToolResultItems: collection.keptToolResults.map((result) => {
        const associationMessage = result.associatedAnswerReferenceIds.some(
          (answerReferenceId) =>
            availableAnswerReferences.has(answerReferenceId),
        )
          ? null
          : result.associatedAnswerReferenceIds.length
            ? 'Associated with an answer on another page.'
            : 'Not associated with an available answer.';
        return {
          id: `kept-tool-result:${result.referenceId}`,
          label: `Kept tool result ${result.referenceId}`,
          associationMessage,
        };
      }),
      keptGateEvaluationsHeading: 'Process / Kept gate evaluations',
      noKeptGateEvaluationsMessage:
        'No kept gate evaluations are currently available.',
    },
    continuation,
  };
}

function formatReceiptTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(date)} UTC`;
}

function hasUniqueAnswerReferences(
  answers: readonly { answerReferenceId: string }[],
): boolean {
  return (
    new Set(answers.map((answer) => answer.answerReferenceId)).size ===
    answers.length
  );
}

function parseSource(
  input: unknown,
): { kind: 'authorized-collection' | 'bounded-page'; payload: unknown } | null {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      return null;
    const keys = Reflect.ownKeys(input);
    if (
      keys.length !== 2 ||
      !keys.every((key) => typeof key === 'string') ||
      !keys.includes('kind') ||
      !(keys.includes('collection') || keys.includes('page'))
    )
      return null;
    const kind = Object.getOwnPropertyDescriptor(input, 'kind');
    if (!kind?.enumerable || !('value' in kind)) return null;
    if (kind.value === 'authorized-collection') {
      const collection = Object.getOwnPropertyDescriptor(input, 'collection');
      return collection?.enumerable && 'value' in collection
        ? { kind: kind.value, payload: collection.value }
        : null;
    }
    if (kind.value === 'bounded-page') {
      const page = Object.getOwnPropertyDescriptor(input, 'page');
      return page?.enumerable && 'value' in page
        ? { kind: kind.value, payload: page.value }
        : null;
    }
    return null;
  } catch {
    return null;
  }
}
