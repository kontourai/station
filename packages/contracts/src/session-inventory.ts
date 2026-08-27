import type { SessionOutputItem } from './session-outputs.js';
import {
  parseStationAnswerBinding,
  parseStationBasisProjection,
  type StationAnswerBinding,
  type StationBasisProjection,
} from './task-basis.js';

/** Closed, metadata-only Session inventory transport. */
export const SESSION_INVENTORY_V1 = 'station.session-inventory/v1' as const;
export const SESSION_INVENTORY_PREVIEW_MAX_ITEMS = 20;
export const SESSION_INVENTORY_PREVIEW_MAX_PER_GROUP = 2;
export const SESSION_INVENTORY_PAGE_MAX_ITEMS = 20;
export const SESSION_INVENTORY_MAX_SERIALIZED_BYTES = 128 * 1024;

export const SESSION_INVENTORY_GROUP_IDS = [
  'inputs',
  'sources',
  'execution',
  'decisions',
  'outputs',
  'verification-delivery',
  'live-now',
  'kept',
  'attention',
  'resources',
] as const;
export type SessionInventoryGroupId =
  (typeof SESSION_INVENTORY_GROUP_IDS)[number];
export type SessionInventoryScope =
  | { kind: 'current-answer'; sessionId: string; turnId: string }
  | { kind: 'whole-session'; sessionId: string }
  | { kind: 'kept-in-task'; sessionId: string; taskId: string };
export type OwnerRef = { owner: string; id: string };
export type SessionInventoryRelation =
  | 'provided-to'
  | 'observed-during'
  | 'produced-by'
  | 'contributed-to'
  | 'cites'
  | 'supports'
  | 'counters'
  | 'checked-by'
  | 'delivered-by'
  | 'supersedes'
  | 'stale'
  | 'kept-in-task';
export type SessionInventoryGap = {
  kind:
    | 'not-captured'
    | 'restricted'
    | 'unavailable'
    | 'unsupported-version'
    | 'corrupt';
  /** Closed ownership boundary; never a free-form diagnostic. */
  code?:
    | 'session-source-index-not-captured'
    | 'task-source-provenance-not-captured';
};
export type SessionInventoryGroupState =
  | 'available'
  | 'empty'
  | 'not-captured'
  | 'restricted'
  | 'unavailable'
  | 'unsupported-version'
  | 'corrupt';
export type SessionInventoryCount = {
  kind: 'exact' | 'at-least';
  value: number;
};

type RowBase<K extends string> = {
  kind: K;
  key: string;
  owner: OwnerRef;
  relations: readonly SessionInventoryRelation[];
};
export type ThreadAuthoredInputRow = RowBase<'thread-authored-input'> & {
  sessionId: string;
  eventId: string;
  turnId: string;
  inputKind: 'message' | 'steer' | 'attachment';
  attachmentDescriptors: readonly {
    kind: 'attachment';
    name: string;
    mediaType: string;
    length: number;
  }[];
};
export type SurfaceAnswerContributionRow =
  RowBase<'surface-answer-contribution'> & {
    sessionId: string;
    turnId: string;
    answerReferenceId: string;
    /** Exact reviewed-source metadata only: no URL, path, body, or labels. */
    reviewedSource: {
      /** Fieldwork's published opaque reviewed-source identity. */
      exactRef: `fieldwork-reviewed-source:v1:${string}`;
      review: 'accepted' | 'not-accepted' | 'not-captured';
      currentness: 'current' | 'drifted' | 'unknown';
      checkedAt: string;
      assessmentRevision: number;
    };
    /**
     * Surface/Fieldwork's closed source-attention facts only.  A row never
     * carries a message, URL, path, plugin name, or arbitrary owner payload.
     */
    contributionGaps: readonly ReviewedSourceContributionGapCode[];
  };
export const REVIEWED_SOURCE_CONTRIBUTION_GAP_CODES = [
  'reviewed-source-review-not-accepted',
  'reviewed-source-review-not-captured',
  'reviewed-source-currentness-unknown',
  'reviewed-source-drifted',
  'reviewed-source-capture-comparison-unavailable',
  'reviewed-source-claim-not-verified',
] as const;
export type ReviewedSourceContributionGapCode =
  (typeof REVIEWED_SOURCE_CONTRIBUTION_GAP_CODES)[number];
const REVIEWED_SOURCE_EXACT_REF = /^fieldwork-reviewed-source:v1:[a-f0-9]{64}$/;
export type FlowAgentsNarrativeRow = RowBase<'flow-agents-narrative'> & {
  sessionId: string;
  eventId: string;
  narrativeRef: string;
  capturedAt: string;
};
export type ThreadToolResultRow = RowBase<'thread-tool-result'> & {
  sessionId: string;
  eventId: string;
  turnId: string;
  toolCallId: string;
  name: string;
  terminalStatus: 'succeeded' | 'failed' | 'cancelled';
};
export type StationPlanSnapshotRow = RowBase<'station-plan-snapshot'> & {
  sessionId: string;
  eventId: string;
  revision: number;
};
export type StationRequestDecisionRow = RowBase<'station-request-decision'> & {
  sessionId: string;
  eventId: string;
  requestId: string;
  status: 'accepted' | 'declined' | 'cancelled' | 'pending';
};
export type StationDelegationRow = RowBase<'station-delegation'> & {
  sessionId: string;
  eventId: string;
  toolCallId: string;
  childSessionId: string;
};
export type StationSessionOutputRow = RowBase<'station-session-output'> & {
  output: SessionOutputItem;
};
export type FlowGateVerdictRow = RowBase<'flow-gate-verdict'> & {
  runId: string;
  gateId: string;
  verdict: 'passed' | 'failed' | 'blocked';
};
export type FlowPolicyVerdictRow = RowBase<'flow-policy-verdict'> & {
  runId: string;
  policyId: string;
  verdict: 'passed' | 'failed' | 'blocked';
};
export type GateEvaluationRow = RowBase<'gate-evaluation'> & {
  evaluationId: string;
  verdict: 'passed' | 'failed' | 'blocked';
};
export type TaskKeptRow = RowBase<
  | 'task-kept-answer'
  | 'task-kept-input'
  | 'task-kept-result'
  | 'task-kept-gate'
  | 'task-kept-output'
  | 'task-kept-pull-request'
> & { taskId: string; provenanceSessionId: string; referenceId: string };
export type StationResourceSummaryRow = RowBase<'station-resource-summary'> & {
  sessionId: string;
  elapsedMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  costMicros?: number;
  model?: string;
  engine?: string;
};
export type SessionInventoryRow =
  | ThreadAuthoredInputRow
  | SurfaceAnswerContributionRow
  | FlowAgentsNarrativeRow
  | ThreadToolResultRow
  | StationPlanSnapshotRow
  | StationRequestDecisionRow
  | StationDelegationRow
  | StationSessionOutputRow
  | FlowGateVerdictRow
  | FlowPolicyVerdictRow
  | GateEvaluationRow
  | TaskKeptRow
  | StationResourceSummaryRow;
export type SessionInventoryGroup = {
  id: SessionInventoryGroupId;
  owner: OwnerRef;
  state: SessionInventoryGroupState;
  count?: SessionInventoryCount;
  items: readonly SessionInventoryRow[];
  continuation?: string;
  gaps: readonly SessionInventoryGap[];
};
type SessionInventoryProjectionBase = {
  version: typeof SESSION_INVENTORY_V1;
  scope: SessionInventoryScope;
  groups: readonly SessionInventoryGroup[];
};
export type SessionInventoryProjection =
  | (SessionInventoryProjectionBase & {
      scope: Extract<SessionInventoryScope, { kind: 'current-answer' }>;
      /** The same captured current-answer Basis projection, never a second read. */
      basis: StationBasisProjection;
      /** Exact Station tuple which binds this Basis to the requested answer. */
      basisBinding: StationAnswerBinding;
    })
  | (SessionInventoryProjectionBase & {
      scope: Exclude<SessionInventoryScope, { kind: 'current-answer' }>;
      basis?: never;
      basisBinding?: never;
    });
type SessionInventoryGroupPageBase = {
  version: typeof SESSION_INVENTORY_V1;
  scope: SessionInventoryScope;
  group: SessionInventoryGroup;
};
export type SessionInventoryGroupPage =
  | (SessionInventoryGroupPageBase & {
      scope: Extract<SessionInventoryScope, { kind: 'current-answer' }>;
      basis: StationBasisProjection;
      basisBinding: StationAnswerBinding;
    })
  | (SessionInventoryGroupPageBase & {
      scope: Exclude<SessionInventoryScope, { kind: 'current-answer' }>;
      basis?: never;
      basisBinding?: never;
    });

const encoder = new TextEncoder();
const statesWithoutFields = new Set<SessionInventoryGroupState>([
  'restricted',
  'unavailable',
  'unsupported-version',
  'corrupt',
]);
const rowKindsForGroup: Readonly<
  Record<SessionInventoryGroupId, readonly SessionInventoryRow['kind'][]>
> = {
  inputs: ['thread-authored-input'],
  sources: ['surface-answer-contribution'],
  execution: [
    'flow-agents-narrative',
    'thread-tool-result',
    'station-plan-snapshot',
    'station-delegation',
  ],
  decisions: ['station-request-decision'],
  outputs: ['station-session-output'],
  'verification-delivery': [
    'flow-gate-verdict',
    'flow-policy-verdict',
    'gate-evaluation',
  ],
  'live-now': [],
  kept: [
    'task-kept-answer',
    'task-kept-input',
    'task-kept-result',
    'task-kept-gate',
    'task-kept-output',
    'task-kept-pull-request',
  ],
  attention: [],
  resources: ['station-resource-summary'],
};
const allowed: Readonly<
  Record<SessionInventoryRow['kind'], readonly SessionInventoryRelation[]>
> = {
  // A Thread owner may explicitly bind an authored input to its current
  // answer. This is stronger than merely observing the input in a turn, and
  // keeps the current-answer scope's relation requirement representable by
  // the closed transport parser.
  'thread-authored-input': [
    'provided-to',
    'observed-during',
    'contributed-to',
    'kept-in-task',
  ],
  'surface-answer-contribution': ['contributed-to'],
  'flow-agents-narrative': ['observed-during', 'contributed-to', 'supports'],
  'thread-tool-result': ['observed-during', 'produced-by', 'kept-in-task'],
  'station-plan-snapshot': [
    'provided-to',
    'observed-during',
    'supersedes',
    'kept-in-task',
  ],
  'station-request-decision': [
    'provided-to',
    'observed-during',
    'kept-in-task',
  ],
  'station-delegation': ['observed-during', 'produced-by'],
  'station-session-output': ['produced-by', 'contributed-to', 'kept-in-task'],
  'flow-gate-verdict': ['checked-by', 'delivered-by', 'kept-in-task'],
  'flow-policy-verdict': ['checked-by', 'delivered-by', 'kept-in-task'],
  'gate-evaluation': ['checked-by', 'kept-in-task'],
  'task-kept-answer': ['kept-in-task'],
  'task-kept-input': ['kept-in-task'],
  'task-kept-result': ['kept-in-task'],
  'task-kept-gate': ['kept-in-task'],
  'task-kept-output': ['kept-in-task'],
  'task-kept-pull-request': ['kept-in-task'],
  'station-resource-summary': ['observed-during'],
};
function plain(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
function string(value: unknown, max = 1024): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    encoder.encode(value).byteLength <= max
  );
}
function owner(value: unknown): value is OwnerRef {
  return (
    plain(value) &&
    Object.keys(value).length === 2 &&
    string(value.owner, 128) &&
    string(value.id)
  );
}
function scope(value: unknown): value is SessionInventoryScope {
  return (
    plain(value) &&
    string(value.sessionId) &&
    ((value.kind === 'whole-session' && Object.keys(value).length === 2) ||
      (value.kind === 'current-answer' &&
        Object.keys(value).length === 3 &&
        string(value.turnId)) ||
      (value.kind === 'kept-in-task' &&
        Object.keys(value).length === 3 &&
        string(value.taskId)))
  );
}
function relationRow(value: unknown): value is {
  kind: SessionInventoryRow['kind'];
  key: string;
  owner: OwnerRef;
  relations: readonly SessionInventoryRelation[];
} {
  return (
    plain(value) &&
    string(value.kind, 64) &&
    value.kind in allowed &&
    string(value.key) &&
    owner(value.owner) &&
    Array.isArray(value.relations) &&
    value.relations.every(
      (relation) =>
        typeof relation === 'string' &&
        (
          allowed[
            value.kind as SessionInventoryRow['kind']
          ] as readonly string[]
        ).includes(relation),
    )
  );
}
function outputItem(value: unknown): boolean {
  if (
    !plain(value) ||
    !['ref', 'turnId', 'toolCallId', 'declaredAt', 'descriptor', 'label'].every(
      (key) => key in value || key === 'label',
    ) ||
    !Object.keys(value).every((key) =>
      [
        'ref',
        'turnId',
        'toolCallId',
        'declaredAt',
        'descriptor',
        'label',
      ].includes(key),
    ) ||
    !plain(value.ref) ||
    Object.keys(value.ref).length !== 2 ||
    !string(value.ref.sessionId) ||
    !string(value.ref.eventId) ||
    !string(value.turnId) ||
    !string(value.toolCallId) ||
    !string(value.declaredAt, 128) ||
    (value.label !== undefined && !string(value.label, 240)) ||
    !plain(value.descriptor)
  )
    return false;
  const descriptor = value.descriptor;
  if (descriptor.kind === 'workspace-file')
    return (
      Object.keys(descriptor).every((key) =>
        ['kind', 'relativePath', 'digest', 'length', 'mediaType'].includes(key),
      ) &&
      string(descriptor.relativePath, 4096) &&
      string(descriptor.digest, 64) &&
      /^[a-f0-9]{64}$/.test(descriptor.digest) &&
      Number.isInteger(descriptor.length) &&
      (descriptor.length as number) >= 0 &&
      (descriptor.length as number) <= 5 * 1024 * 1024 &&
      (descriptor.mediaType === undefined || string(descriptor.mediaType, 160))
    );
  return (
    descriptor.kind === 'pull-request' &&
    Object.keys(descriptor).length === 7 &&
    descriptor.liveExternal === true &&
    string(descriptor.provider, 128) &&
    string(descriptor.host, 512) &&
    plain(descriptor.repository) &&
    Object.keys(descriptor.repository).length === 2 &&
    string(descriptor.repository.owner, 256) &&
    string(descriptor.repository.name, 256) &&
    string(descriptor.ref, 512) &&
    string(descriptor.nativeId, 512)
  );
}
function nonNegativeInt(
  value: unknown,
  max = Number.MAX_SAFE_INTEGER,
): boolean {
  return (
    Number.isInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= max
  );
}
function timestamp(value: unknown): value is string {
  return (
    string(value, 128) &&
    Number.isFinite(Date.parse(value)) &&
    /^\d{4}-\d{2}-\d{2}T/.test(value)
  );
}
function attachments(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= 20 &&
    value.every(
      (attachment) =>
        plain(attachment) &&
        Object.keys(attachment).length === 4 &&
        attachment.kind === 'attachment' &&
        string(attachment.name, 240) &&
        string(attachment.mediaType, 160) &&
        nonNegativeInt(attachment.length, 5 * 1024 * 1024),
    )
  );
}
function rowDetails(value: Record<string, unknown>): boolean {
  switch (value.kind) {
    case 'thread-authored-input':
      return (
        string(value.sessionId) &&
        string(value.eventId) &&
        string(value.turnId) &&
        ['message', 'steer', 'attachment'].includes(
          value.inputKind as string,
        ) &&
        attachments(value.attachmentDescriptors)
      );
    case 'surface-answer-contribution':
      return (
        string(value.sessionId) &&
        string(value.turnId) &&
        string(value.answerReferenceId) &&
        plain(value.reviewedSource) &&
        Object.keys(value.reviewedSource).length === 5 &&
        string(value.reviewedSource.exactRef, 512) &&
        REVIEWED_SOURCE_EXACT_REF.test(value.reviewedSource.exactRef) &&
        ['accepted', 'not-accepted', 'not-captured'].includes(
          value.reviewedSource.review as string,
        ) &&
        ['current', 'drifted', 'unknown'].includes(
          value.reviewedSource.currentness as string,
        ) &&
        timestamp(value.reviewedSource.checkedAt) &&
        nonNegativeInt(value.reviewedSource.assessmentRevision, 1_000_000) &&
        (value.reviewedSource.assessmentRevision as number) > 0 &&
        Array.isArray(value.contributionGaps) &&
        value.contributionGaps.length <=
          REVIEWED_SOURCE_CONTRIBUTION_GAP_CODES.length &&
        new Set(value.contributionGaps).size ===
          value.contributionGaps.length &&
        value.contributionGaps.every(
          (gap) =>
            typeof gap === 'string' &&
            (
              REVIEWED_SOURCE_CONTRIBUTION_GAP_CODES as readonly string[]
            ).includes(gap),
        )
      );
    case 'flow-agents-narrative':
      return (
        string(value.sessionId) &&
        string(value.eventId) &&
        string(value.narrativeRef) &&
        string(value.capturedAt, 128)
      );
    case 'thread-tool-result':
      return (
        string(value.sessionId) &&
        string(value.eventId) &&
        string(value.turnId) &&
        string(value.toolCallId) &&
        string(value.name, 240) &&
        ['succeeded', 'failed', 'cancelled'].includes(
          value.terminalStatus as string,
        )
      );
    case 'station-plan-snapshot':
      return (
        string(value.sessionId) &&
        string(value.eventId) &&
        nonNegativeInt(value.revision, 1_000_000)
      );
    case 'station-request-decision':
      return (
        string(value.sessionId) &&
        string(value.eventId) &&
        string(value.requestId) &&
        ['accepted', 'declined', 'cancelled', 'pending'].includes(
          value.status as string,
        )
      );
    case 'station-delegation':
      return (
        string(value.sessionId) &&
        string(value.eventId) &&
        string(value.toolCallId) &&
        string(value.childSessionId)
      );
    case 'station-session-output':
      return outputItem(value.output);
    case 'flow-gate-verdict':
      return (
        string(value.runId) &&
        string(value.gateId) &&
        ['passed', 'failed', 'blocked'].includes(value.verdict as string)
      );
    case 'flow-policy-verdict':
      return (
        string(value.runId) &&
        string(value.policyId) &&
        ['passed', 'failed', 'blocked'].includes(value.verdict as string)
      );
    case 'gate-evaluation':
      return (
        string(value.evaluationId) &&
        ['passed', 'failed', 'blocked'].includes(value.verdict as string)
      );
    case 'task-kept-answer':
    case 'task-kept-input':
    case 'task-kept-result':
    case 'task-kept-gate':
    case 'task-kept-output':
    case 'task-kept-pull-request':
      return (
        string(value.taskId) &&
        string(value.provenanceSessionId) &&
        string(value.referenceId)
      );
    case 'station-resource-summary':
      return (
        string(value.sessionId) &&
        [
          'elapsedMs',
          'inputTokens',
          'outputTokens',
          'cachedTokens',
          'costMicros',
        ].every(
          (key) => value[key] === undefined || nonNegativeInt(value[key]),
        ) &&
        ['model', 'engine'].every(
          (key) => value[key] === undefined || string(value[key], 512),
        )
      );
    default:
      return false;
  }
}
function row(value: unknown): value is SessionInventoryRow {
  if (!relationRow(value)) return false;
  // The server produces typed rows. This parser additionally refuses foreign kinds,
  // forbidden relations, body-bearing fields, and cross-session Output references.
  if (
    Object.keys(value).some((key) =>
      ['body', 'text', 'data', 'url', 'path', 'confidence'].includes(key),
    )
  )
    return false;
  const required: Readonly<
    Record<SessionInventoryRow['kind'], readonly string[]>
  > = {
    'thread-authored-input': [
      'sessionId',
      'eventId',
      'turnId',
      'inputKind',
      'attachmentDescriptors',
    ],
    'surface-answer-contribution': [
      'sessionId',
      'turnId',
      'answerReferenceId',
      'reviewedSource',
      'contributionGaps',
    ],
    'flow-agents-narrative': [
      'sessionId',
      'eventId',
      'narrativeRef',
      'capturedAt',
    ],
    'thread-tool-result': [
      'sessionId',
      'eventId',
      'turnId',
      'toolCallId',
      'name',
      'terminalStatus',
    ],
    'station-plan-snapshot': ['sessionId', 'eventId', 'revision'],
    'station-request-decision': ['sessionId', 'eventId', 'requestId', 'status'],
    'station-delegation': [
      'sessionId',
      'eventId',
      'toolCallId',
      'childSessionId',
    ],
    'station-session-output': ['output'],
    'flow-gate-verdict': ['runId', 'gateId', 'verdict'],
    'flow-policy-verdict': ['runId', 'policyId', 'verdict'],
    'gate-evaluation': ['evaluationId', 'verdict'],
    'task-kept-answer': ['taskId', 'provenanceSessionId', 'referenceId'],
    'task-kept-input': ['taskId', 'provenanceSessionId', 'referenceId'],
    'task-kept-result': ['taskId', 'provenanceSessionId', 'referenceId'],
    'task-kept-gate': ['taskId', 'provenanceSessionId', 'referenceId'],
    'task-kept-output': ['taskId', 'provenanceSessionId', 'referenceId'],
    'task-kept-pull-request': ['taskId', 'provenanceSessionId', 'referenceId'],
    'station-resource-summary': ['sessionId'],
  };
  const optional: Readonly<
    Record<SessionInventoryRow['kind'], readonly string[]>
  > = {
    'thread-authored-input': [],
    'surface-answer-contribution': [],
    'flow-agents-narrative': [],
    'thread-tool-result': [],
    'station-plan-snapshot': [],
    'station-request-decision': [],
    'station-delegation': [],
    'station-session-output': [],
    'flow-gate-verdict': [],
    'flow-policy-verdict': [],
    'gate-evaluation': [],
    'task-kept-answer': [],
    'task-kept-input': [],
    'task-kept-result': [],
    'task-kept-gate': [],
    'task-kept-output': [],
    'task-kept-pull-request': [],
    'station-resource-summary': [
      'elapsedMs',
      'inputTokens',
      'outputTokens',
      'cachedTokens',
      'costMicros',
      'model',
      'engine',
    ],
  };
  return (
    required[value.kind].every((key) => key in value) &&
    Object.keys(value).every((key) =>
      [
        'kind',
        'key',
        'owner',
        'relations',
        ...required[value.kind],
        ...optional[value.kind],
      ].includes(key),
    ) &&
    rowDetails(value as Record<string, unknown>)
  );
}
function validGap(value: unknown, requiredKind?: string): boolean {
  if (!plain(value) || typeof value.kind !== 'string') return false;
  if (
    ![
      'not-captured',
      'restricted',
      'unavailable',
      'unsupported-version',
      'corrupt',
    ].includes(value.kind) ||
    (requiredKind !== undefined && value.kind !== requiredKind)
  )
    return false;
  if (value.code === undefined) return Object.keys(value).length === 1;
  return (
    value.kind === 'not-captured' &&
    Object.keys(value).length === 2 &&
    [
      'session-source-index-not-captured',
      'task-source-provenance-not-captured',
    ].includes(value.code as string)
  );
}
function matchesCurrentAnswerBasis(
  scope: Extract<SessionInventoryScope, { kind: 'current-answer' }>,
  basis: unknown,
  binding: unknown,
): binding is StationAnswerBinding {
  const parsedBinding = parseStationAnswerBinding(binding);
  const parsedBasis = parseStationBasisProjection(basis);
  if (
    !parsedBinding ||
    !parsedBasis ||
    parsedBinding.sessionId !== scope.sessionId ||
    parsedBinding.turnId !== scope.turnId ||
    parsedBinding.answer.threadId !== scope.sessionId ||
    parsedBasis.answer.state !== 'available'
  )
    return false;
  const answer = parsedBasis.answer.value.ref;
  return (
    answer.authority === '@kontourai/thread' &&
    answer.schemaVersion === '1.2.0' &&
    answer.kind === 'assistant-message' &&
    answer.standing === 'observed' &&
    answer.threadId === parsedBinding.answer.threadId &&
    answer.messageId === parsedBinding.answer.messageId
  );
}
function group(
  value: unknown,
  projectionScope: SessionInventoryScope,
  page: boolean,
  basisBinding?: StationAnswerBinding,
): value is SessionInventoryGroup {
  if (
    !plain(value) ||
    !SESSION_INVENTORY_GROUP_IDS.includes(
      value.id as SessionInventoryGroupId,
    ) ||
    !owner(value.owner) ||
    typeof value.state !== 'string' ||
    ![
      'available',
      'empty',
      'not-captured',
      'restricted',
      'unavailable',
      'unsupported-version',
      'corrupt',
    ].includes(value.state) ||
    !Array.isArray(value.items) ||
    !Array.isArray(value.gaps) ||
    !Object.keys(value).every((key) =>
      [
        'id',
        'owner',
        'state',
        'count',
        'items',
        'continuation',
        'gaps',
      ].includes(key),
    )
  )
    return false;
  if (statesWithoutFields.has(value.state as SessionInventoryGroupState))
    return (
      Object.keys(value).every((key) =>
        ['id', 'owner', 'state', 'items', 'gaps'].includes(key),
      ) &&
      value.items.length === 0 &&
      value.gaps.length > 0 &&
      value.gaps.every((gap) => validGap(gap, value.state as string))
    );
  if (
    value.state === 'not-captured' &&
    (!Object.keys(value).every((key) =>
      ['id', 'owner', 'state', 'items', 'gaps'].includes(key),
    ) ||
      value.items.length !== 0 ||
      value.gaps.length !== 1 ||
      !validGap(value.gaps[0], 'not-captured'))
  )
    return false;
  if (
    value.state === 'empty' &&
    (!Object.keys(value).every((key) =>
      ['id', 'owner', 'state', 'count', 'items', 'gaps'].includes(key),
    ) ||
      value.items.length !== 0 ||
      value.gaps.length !== 0 ||
      !plain(value.count) ||
      value.count.kind !== 'exact' ||
      value.count.value !== 0)
  )
    return false;
  if (
    value.items.length >
      (page
        ? SESSION_INVENTORY_PAGE_MAX_ITEMS
        : SESSION_INVENTORY_PREVIEW_MAX_PER_GROUP) ||
    !value.items.every(row)
  )
    return false;
  if (!page && value.items.length > SESSION_INVENTORY_PREVIEW_MAX_PER_GROUP)
    return false;
  if (
    value.state === 'available' &&
    (value.items.length === 0 ||
      !value.items.every((item) =>
        rowKindsForGroup[value.id as SessionInventoryGroupId].includes(
          (item as SessionInventoryRow).kind,
        ),
      ))
  )
    return false;
  if (
    value.count !== undefined &&
    (!plain(value.count) ||
      !['exact', 'at-least'].includes(value.count.kind as string) ||
      !Number.isInteger(value.count.value) ||
      (value.count.value as number) < value.items.length)
  )
    return false;
  if (value.continuation !== undefined && !string(value.continuation))
    return false;
  if (
    value.continuation !== undefined &&
    (!plain(value.count) || value.count.kind !== 'at-least')
  )
    return false;
  if (value.gaps.some((gap) => !validGap(gap))) return false;
  return value.items.every((item) => {
    const itemRecord = item as unknown as Record<string, unknown>;
    if (!plain(itemRecord)) return false;
    const sessionRef = itemRecord.sessionId ?? itemRecord.provenanceSessionId;
    if (sessionRef !== undefined && sessionRef !== projectionScope.sessionId)
      return false;
    if (
      projectionScope.kind === 'kept-in-task' &&
      itemRecord.taskId !== undefined &&
      itemRecord.taskId !== projectionScope.taskId
    )
      return false;
    if (
      projectionScope.kind === 'current-answer' &&
      itemRecord.turnId !== undefined &&
      itemRecord.turnId !== projectionScope.turnId
    )
      return false;
    const relations = itemRecord.relations;
    if (!Array.isArray(relations)) return false;
    if (
      projectionScope.kind === 'current-answer' &&
      !relations.includes('contributed-to')
    )
      return false;
    if (itemRecord.kind === 'surface-answer-contribution') {
      if (
        projectionScope.kind !== 'current-answer' ||
        !basisBinding ||
        itemRecord.answerReferenceId !== basisBinding.answer.messageId ||
        itemRecord.sessionId !== basisBinding.sessionId ||
        itemRecord.turnId !== basisBinding.turnId ||
        itemRecord.key !==
          `reviewed-source:${(itemRecord.reviewedSource as Record<string, unknown>).exactRef}`
      )
        return false;
      // The v1 authenticated source association is the sole transport edge.
      if (
        !relations.includes('contributed-to') ||
        relations.some((relation) => relation !== 'contributed-to') ||
        new Set(relations).size !== relations.length
      )
        return false;
    }
    if (itemRecord.kind !== 'station-session-output') return true;
    const output = itemRecord.output;
    return (
      plain(output) &&
      plain(output.ref) &&
      output.ref.sessionId === projectionScope.sessionId
    );
  });
}
export function parseSessionInventoryProjection(
  value: unknown,
): SessionInventoryProjection | null {
  try {
    if (
      !plain(value) ||
      !['version', 'scope', 'groups'].every((key) => key in value) ||
      !Object.keys(value).every((key) =>
        ['version', 'scope', 'groups', 'basis', 'basisBinding'].includes(key),
      ) ||
      value.version !== SESSION_INVENTORY_V1 ||
      !scope(value.scope) ||
      !Array.isArray(value.groups)
    )
      return null;
    const parsedScope = value.scope;
    const basisBinding =
      parsedScope.kind === 'current-answer' &&
      matchesCurrentAnswerBasis(parsedScope, value.basis, value.basisBinding)
        ? parseStationAnswerBinding(value.basisBinding)
        : null;
    if (
      (parsedScope.kind === 'current-answer' && !basisBinding) ||
      (parsedScope.kind !== 'current-answer' &&
        (value.basis !== undefined || value.basisBinding !== undefined)) ||
      value.groups.length !== SESSION_INVENTORY_GROUP_IDS.length ||
      value.groups.some(
        (item, index) =>
          !group(item, parsedScope, false, basisBinding ?? undefined) ||
          (item as SessionInventoryGroup).id !==
            SESSION_INVENTORY_GROUP_IDS[index],
      ) ||
      value.groups.reduce(
        (n, item) => n + ((item as SessionInventoryGroup).items?.length ?? 0),
        0,
      ) > SESSION_INVENTORY_PREVIEW_MAX_ITEMS
    )
      return null;
    return encoder.encode(JSON.stringify(value)).byteLength <=
      SESSION_INVENTORY_MAX_SERIALIZED_BYTES
      ? (value as SessionInventoryProjection)
      : null;
  } catch {
    return null;
  }
}
export function parseSessionInventoryGroupPage(
  value: unknown,
): SessionInventoryGroupPage | null {
  try {
    if (
      !plain(value) ||
      !Object.keys(value).every((key) =>
        ['version', 'scope', 'group', 'basis', 'basisBinding'].includes(key),
      ) ||
      !['version', 'scope', 'group'].every((key) => key in value) ||
      value.version !== SESSION_INVENTORY_V1 ||
      !scope(value.scope)
    )
      return null;
    const basisBinding =
      value.scope.kind === 'current-answer' &&
      matchesCurrentAnswerBasis(value.scope, value.basis, value.basisBinding)
        ? parseStationAnswerBinding(value.basisBinding)
        : null;
    if (
      (value.scope.kind === 'current-answer' && !basisBinding) ||
      (value.scope.kind !== 'current-answer' &&
        (value.basis !== undefined || value.basisBinding !== undefined)) ||
      !group(value.group, value.scope, true, basisBinding ?? undefined)
    )
      return null;
    return encoder.encode(JSON.stringify(value)).byteLength <=
      SESSION_INVENTORY_MAX_SERIALIZED_BYTES
      ? (value as SessionInventoryGroupPage)
      : null;
  } catch {
    return null;
  }
}
