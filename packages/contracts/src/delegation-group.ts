import type { InputRequestForm } from './input-request';
import type { ReportGroupAmounts, ReportGroupInput } from './report-group';

export const DELEGATION_GROUP_TRANSPORT_VERSION =
  'station.delegation-group/v1' as const;
export const DELEGATION_GROUP_LIMITS = {
  requestBytes: 262_144,
  responseBytes: 262_144,
  pageSize: 64,
  // Each code unit can require six JSON bytes; leave room for response metadata.
  outputPageCodeUnits: 32_768,
} as const;

/** Intent is inert; the host must resolve current source, inventory and authority. */
export type DelegationGroupCreateInput = Omit<ReportGroupInput, 'continuation'>;
export type DelegationGroupCommandInput = {
  operationId: string;
  expectedRevision: number;
};

/** Public observations exclude the private authority journal and signed admission. */
export type DelegationGroupView = {
  version: typeof DELEGATION_GROUP_TRANSPORT_VERSION;
  groupId: string;
  revision: number;
  execution: 'idle' | 'execution_unknown' | 'returned';
  cancellation: 'none' | 'pending' | 'requested';
  terminal: 'unproven' | 'proven';
  acceptance: 'unassessed';
  topology: { kind: 'independent-advisory' } | { kind: 'flow'; runId: string };
  members: {
    seatId: string;
    taskId: string;
    selection: {
      agentId: string;
      runtimeProtocol: string;
      provider: string;
      modelId: string;
    };
    invocationId: string | null;
    outcome: string | null;
    terminalProof: 'unproven' | 'proven';
  }[];
  /** Present only when the host has authenticated the retained accounting ledger. */
  accounting?: {
    knownTerminalUsage: ReportGroupAmounts;
    unsettledAllocation: ReportGroupAmounts;
  };
};
export type DelegationGroupOperationResult = {
  replayed: boolean;
  group: DelegationGroupView;
};
export type DelegationGroupListPage = {
  groups: DelegationGroupView[];
  nextGroupId: string | null;
  hasMore: boolean;
};
export type DelegationGroupEventPage = {
  groupId: string;
  afterRevision: number;
  nextRevision: number;
  hasMore: boolean;
  events: {
    revision: number;
    kind: string;
    seatId?: string;
    invocationId?: string;
    outcome?: string;
  }[];
};
export type DelegationGroupMemberEventPage = {
  groupId: string;
  seatId: string;
  nextSequence: number;
  hasMore: boolean;
  events: {
    sequence: number;
    eventId: string;
    kind: string;
    turnId?: string;
    inputRequest?: {
      requestId: string;
      requestEventId: string;
      form: InputRequestForm;
    };
  }[];
};
export type DelegationGroupRawOutputResult = {
  groupId: string;
  seatId: string;
  invocationId: string;
  text: string;
  /** UTF-16 offsets; a page never splits a surrogate pair. */
  afterCodeUnit: number;
  nextCodeUnit: number;
  hasMore: boolean;
  modelId: string;
  /** Whole invocation usage, repeated on every page; never sum pages. */
  usage: ReportGroupAmounts;
};

// A 128-character group ID can expand threefold in the cursor; revision is
// a safe integer (at most 16 digits). 1 KiB covers the fixed SSE field lines.
export const CLI_SESSION_GROUP_EVENT_LIMITS = {
  pageBytes: 262_144,
  frameBytes: 262_144 + 1_024,
} as const;

/** Session groups use Station authority; they do not claim portable envelope enforcement. */
export type CliSessionGroupPresetIdentity = {
  presetId: string;
  name: string;
  sha256: string;
  stationmaster: string;
  /** Authored presentation retained with the exact preset; absent on older records. */
  members?: {
    seatId: string;
    codename: string;
    color: string;
    role: string;
  }[];
};

export type CliSessionGroupAttention = {
  kind: 'needs-input' | 'review-pending' | 'blocked';
  observedAt: string;
  request?: { id: string; eventId?: string };
};

export type CliSessionGroupSync = {
  operationId: string;
  runId: string;
  contentHash: string;
  timestamp: string;
  status: 'syncing' | 'acknowledged' | 'incomplete';
  members: {
    seatId: string;
    status: 'pending' | 'acknowledged' | 'failed' | 'unknown';
    attempts: number;
    timestamp?: string;
    turnId?: string;
    terminalEventId?: string;
    nativeIdentityHash?: string;
    toolCalls?: number;
  }[];
};

export type CliSessionGroupView = {
  version: 'station.cli-session-group/v1';
  groupId: string;
  revision: number;
  supervision: 'active' | 'not-running';
  cancelled: boolean;
  deadlineAt: number;
  maxConcurrent: number;
  /** Maximum reserved seat starts, not physical provider requests. Defaults to roster size. */
  maxDispatches?: number;
  dispatchCount: number;
  admissionClosed?: 'dispatch-limit-exhausted';
  preset?: CliSessionGroupPresetIdentity;
  contextSync?: CliSessionGroupSync;
  guarantees: {
    authority: 'station-session';
    portableFlowLineage: 'unbound';
    dollarCap: 'unavailable';
    tokenCap: 'unavailable';
    physicalAttemptCap: 'unavailable';
    deadline: 'stop-admission-and-request-interruption';
  };
  flow: {
    runId: string;
    definition: { id: string; version: string; digest: string };
    status: string;
  } | null;
  acceptance: 'unassessed';
  members: {
    seatId: string;
    needs: string[];
    state: 'pending' | 'launch-intent' | 'started' | 'terminal';
    claimId?: string;
    reservedSessionId?: string;
    initialClientTurnId?: string;
    handle?: {
      taskId: string;
      conversationId: string;
      sessionId: string;
      initialTurnId?: string;
    };
    outcome?: 'completed' | 'failed' | 'canceled';
    attention?: CliSessionGroupAttention;
    terminalEvent?: { eventId: string; turnId: string };
    dispatchFailure?: { status: number; code: string };
  }[];
};

export type CliSessionGroupCreateInput = {
  operationId: string;
  maxConcurrent: number;
  /** Maximum reserved seat starts, not physical provider requests. Defaults to roster size. */
  maxDispatches?: number;
  deadlineAt: number;
  members: {
    seatId: string;
    prompt: string;
    needs?: string[];
    parentTaskId?: string;
    target: {
      environment?: { kind: 'current' };
      agent: import('./agent-identity').AgentId;
      expectedEngine: {
        kind: 'connection';
        connectionId: import('./agent-identity').EngineConnectionId;
      };
      model?: import('./execution-target').ExecutionModelRequest;
      workspace?:
        | { kind: 'project'; projectSlug: string; cwd?: string }
        | { kind: 'directory'; cwd: string };
    };
  }[];
};

export type CliSessionGroupListPage = {
  groups: CliSessionGroupView[];
  nextGroupId: string | null;
  hasMore: boolean;
};

/** Durable observations of group writes, not another source of scheduling decisions. */
export type CliSessionGroupEvent = {
  contextSync?: CliSessionGroupSync;
  revision: number;
  members: CliSessionGroupView['members'];
  cancelled?: boolean;
  admissionClosed?: 'dispatch-limit-exhausted';
  schedule: { kind: string; stepId: string; claimId: string }[];
};
export type CliSessionGroupEventPage = {
  groupId: string;
  afterRevision: number;
  nextRevision: number;
  events: CliSessionGroupEvent[];
  hasMore: boolean;
  gap?: { availableFromRevision: number };
  unavailable: { cursor: number; code: 'item_too_large' }[];
};

export function cliSessionGroupStreamCursor(
  groupId: string,
  revision: number,
): string {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(groupId) ||
    !Number.isSafeInteger(revision) ||
    revision < 0
  )
    throw new Error('group_stream_cursor_invalid');
  return `cli-group:${encodeURIComponent(groupId)}:${revision}`;
}
export function readCliSessionGroupStreamCursor(
  groupId: string,
  initial = 0,
  lastEventId?: string,
): number {
  const prefix = cliSessionGroupStreamCursor(groupId, 0).slice(0, -1);
  cliSessionGroupStreamCursor(groupId, initial);
  if (lastEventId === undefined) return initial;
  if (!lastEventId.startsWith(prefix))
    throw new Error('group_stream_cursor_invalid');
  const suffix = lastEventId.slice(prefix.length);
  if (!/^(0|[1-9][0-9]{0,15})$/.test(suffix))
    throw new Error('group_stream_cursor_invalid');
  const revision = Number(suffix);
  cliSessionGroupStreamCursor(groupId, revision);
  if (revision < initial) throw new Error('group_stream_cursor_invalid');
  return revision;
}
