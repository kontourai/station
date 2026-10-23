/** Public report projections contain observations, never execution capabilities. */
export const REPORT_GROUP_VERSION = 'station.report-group/v1' as const;
export const REPORT_GROUP_LIMITS = {
  requestBytes: 262_144,
  pageBytes: 262_144,
  frameBytes: 263_168,
  resultCodeUnits: 16_384,
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
export type ReportGroupInput = {
  operationId: string;
  projectSlug: string;
  resourceId?: string;
  deadlineAt: number;
  maxConcurrent: number;
  budget: ReportGroupAmounts;
  members: {
    seatId: string;
    agentId: string;
    brief: string;
    maxOutputTokens: number;
  }[];
};
export type ReportGroupView = {
  version: typeof REPORT_GROUP_VERSION;
  groupId: string;
  operationId: string;
  revision: number;
  topology: { kind: 'independent-advisory' };
  execution: 'not-created' | 'idle' | 'returned' | 'unknown';
  cancellation: 'none' | 'pending' | 'requested';
  authorityRevoked: boolean;
  acceptance: 'unassessed';
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
