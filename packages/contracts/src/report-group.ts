/** Public report projections contain observations, never execution capabilities. */
export const REPORT_GROUP_VERSION = 'station.report-group/v1' as const;
export const REPORT_GROUP_LIMITS = {
  requestBytes: 262_144,
  pageBytes: 262_144,
  frameBytes: 263_168,
  resultCodeUnits: 16_384,
} as const;
export const REPORT_GROUP_CONTEXT_LIMITS = {
  textBytes: 65_536,
  requestBytes: 524_288,
} as const;
export type ReportGroupAmounts = {
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
};
export type ReportGroupReference = {
  id: string;
  domain: string;
  digest: string;
};
export const REPORT_GROUP_CONTINUATION_LIMITS = {
  attemptsPerMember: 8,
  maxRounds: 16,
  maxSyncs: 32,
  maxRenewals: 8,
  maxEvaluations: 128,
  maxRecoveries: 16,
  maxAttempts: 128,
} as const;
export type ReportGroupContinuation = {
  attemptsPerMember: number;
  maxRounds: number;
  maxSyncs: number;
  maxRenewals: number;
  maxEvaluations: number;
  maxRecoveries: number;
};
export type ReportGroupInput = {
  operationId: string;
  projectSlug: string;
  resourceId?: string;
  flow?: { runId: string; steps: Record<string, string> };
  continuation?: ReportGroupContinuation;
  deadlineAt: number;
  maxConcurrent: number;
  budget: ReportGroupAmounts;
  members: {
    seatId: string;
    agentId: string;
    brief: string;
    maxOutputTokens: number;
    input?: 'operator-clarification-v1';
  }[];
};
/** Limits are initial intent; they do not themselves authorize an invocation or renewal. */
export function assertReportGroupContinuation(input: ReportGroupInput): void {
  const limits = input.continuation;
  if (
    input.members.some((member) => member.input !== undefined) &&
    (!limits ||
      limits.maxSyncs < 1 ||
      limits.maxRenewals < 1 ||
      limits.attemptsPerMember < 4)
  )
    throw Error('report_input_continuation_required');
  if (!limits) return;
  if (!input.flow) throw Error('report_continuation_flow_required');
  for (const key of [
    'attemptsPerMember',
    'maxRounds',
    'maxSyncs',
    'maxRenewals',
    'maxEvaluations',
    'maxRecoveries',
  ] as const) {
    const min = key === 'attemptsPerMember' || key === 'maxRounds' ? 1 : 0;
    if (
      !Number.isSafeInteger(limits[key]) ||
      limits[key] < min ||
      limits[key] > REPORT_GROUP_CONTINUATION_LIMITS[key]
    )
      throw Error('report_continuation_invalid');
  }
  const attempts = input.members.length * limits.attemptsPerMember;
  if (
    !Number.isSafeInteger(attempts) ||
    attempts > REPORT_GROUP_CONTINUATION_LIMITS.maxAttempts ||
    input.members.length + 2 * limits.maxSyncs > attempts
  )
    throw Error('report_continuation_capacity');
}
export type ReportGroupContextCheckpoint = {
  groupId: string;
  seatId: string;
  revision: number;
  flowHead: string;
};
export const REPORT_GROUP_RENEWAL_LIMITS = {
  operationKeyCodeUnits: 96,
  requestBytes: 4096,
} as const;
export type ReportGroupNarrowInput = {
  operationKey: string;
  expectedRevision: number;
  seatId: string;
};
export type ReportGroupInputSyncInput = {
  operationKey: string;
  expectedRevision: number;
  seatId: string;
  flowHead: string;
  renewalOperationKey: string;
};
export type ReportGroupReportInput = {
  operationKey: string;
  expectedRevision: number;
  seatId: string;
  flowHead: string;
  syncOperationKey: string;
  previousInvocationId: string;
  retryRef: string;
};
export type ReportGroupContextSyncInput = {
  operationKey: string;
  expectedRevision: number;
  seatId: string;
  flowHead: string;
  text: string;
};
export type ReportGroupFinalizeContinuationInput = {
  operationKey: string;
  expectedRevision: number;
  continuationOperationKey: string;
};
export type ReportGroupFinalizeSyncInput = {
  operationKey: string;
  expectedRevision: number;
  syncOperationKey: string;
  preparedDigest: string;
};
export type ReportGroupContextSyncView = {
  operationKey: string;
  seatId: string;
  flowHead: string;
  state: 'pending' | 'prepared' | 'acknowledged' | 'incomplete';
  reason:
    | 'exact_ack'
    | 'ack_mismatch'
    | 'unexpected_tools'
    | 'execution_incomplete'
    | null;
  preparedDigest: string | null;
  /** Null means no complete operation-level accounting snapshot was retained. */
  attempts:
    | {
        invocationId: string;
        allocation: ReportGroupAmounts;
        usage: ReportGroupAmounts | null;
        accountingTerminal: boolean;
        terminal: ReportGroupReference | null;
      }[]
    | null;
};
export type ReportGroupView = {
  version: typeof REPORT_GROUP_VERSION;
  groupId: string;
  operationId: string;
  revision: number;
  topology: { kind: 'independent-advisory' } | { kind: 'flow'; runId: string };
  execution: 'not-created' | 'idle' | 'returned' | 'unknown';
  cancellation: 'none' | 'pending' | 'requested';
  authorityRevoked: boolean;
  acceptance: 'unassessed';
  contextSyncs?: ReportGroupContextSyncView[];
  contextSyncAllowance?: {
    maximumOperations: number;
    recordedOperations: number;
  };
  accounting?: {
    invocationCount: number;
    unsettledInvocations: number;
    knownTerminalUsage: ReportGroupAmounts;
    unsettledAllocation: ReportGroupAmounts;
  };
  members: {
    seatId: string;
    agentId: string;
    taskId: string;
    clientTurnId: string;
    requestedModelId: string;
    attempts: {
      invocationId: string;
      observation: ReportGroupReference | null;
      terminal: ReportGroupReference | null;
      allocation: ReportGroupAmounts | null;
      usage: ReportGroupAmounts | null;
      accountingTerminal: boolean;
    }[];
  }[];
};
export type ReportGroupOperation = {
  replayed: boolean;
  group: ReportGroupView;
};
export type ReportGroupReportOperation = ReportGroupOperation & {
  operationKey: string;
  seatId: string;
  invocationId: string;
};
export type ReportGroupListPage = {
  groups: ReportGroupView[];
  hasMore: boolean;
  nextGroupId: string | null;
};
export type ReportGroupCancelInput = {
  operationKey: string;
  expectedRevision: number;
};
export type ReportGroupFinalizeCancelInput = ReportGroupCancelInput & {
  cancelOperationKey: string;
};
export type ReportGroupCancelResult = {
  replayed: boolean;
  revision: number;
  cancellation: ReportGroupView['cancellation'];
};
export type ReportGroupEventPage = {
  groupId: string;
  afterRevision: number;
  nextRevision: number;
  revision: number;
  events: {
    revision: number;
    kind: string;
    commandKind?: string;
    seatId?: string;
    invocationId?: string;
  }[];
  unavailable: { cursor: number; code: 'item_too_large' }[];
  hasMore: boolean;
};
export type ReportGroupResultPage =
  | { kind: 'failure'; code: 'report_attempt_unavailable' }
  | {
      kind: 'result';
      groupId: string;
      seatId: string;
      invocationId: string;
      modelId: string;
      text: string;
      afterOffset: number;
      nextOffset: number;
      hasMore: boolean;
      usage: ReportGroupAmounts;
    };
export function reportGroupStreamCursor(
  groupId: string,
  revision: number,
): string {
  return `report:${encodeURIComponent(groupId)}:${revision}`;
}

export type ReportGroupAccountingRecoveryInput = {
  seatId: string;
  invocationId: string;
  operationKey: string;
};
export type ReportGroupAccountingRecoveryResult =
  ReportGroupAccountingRecoveryInput & {
    groupId: string;
    replayed: boolean;
    status: 'settled' | 'held';
    reason: 'exact-settlement' | 'usage-unknown' | 'usage-exceeds-reservation';
    accounting: ReportGroupAmounts | null;
    receipt: ReportGroupReference;
  };
