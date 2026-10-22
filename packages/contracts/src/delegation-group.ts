import type { InputRequestForm } from './input-request';

export const DELEGATION_GROUP_TRANSPORT_VERSION =
  'station.delegation-group/v1' as const;
export const DELEGATION_GROUP_LIMITS = {
  requestBytes: 16_384,
  responseBytes: 262_144,
  pageSize: 64,
  memberPageSize: 64,
} as const;

// A 128-character group ID can expand threefold in the cursor; revision is
// a safe integer (at most 16 digits). 1 KiB covers the fixed SSE field lines.
export const CLI_SESSION_GROUP_EVENT_LIMITS = {
  pageBytes: 262_144,
  frameBytes: 262_144 + 1_024,
} as const;

export type DelegationGroupCreateInput = {
  preparationId: string;
  operationId: string;
};
export type DelegationGroupCommandInput = {
  operationId: string;
  expectedRevision: number;
};
export type DelegationGroupReference = {
  id: string;
  domain: string;
  digest: string;
};
export type DelegationGroupView = {
  version: typeof DELEGATION_GROUP_TRANSPORT_VERSION;
  groupId: string;
  revision: number;
  execution: 'idle' | 'execution_unknown' | 'returned';
  cancellation: 'none' | 'pending' | 'requested';
  terminal: 'unproven' | 'proven';
  acceptance: 'unassessed';
  executionCapability: {
    status: 'unavailable';
    code: 'physical_adapter_unqualified';
  };
  topology:
    | { kind: 'independent-advisory' }
    | {
        kind: 'flow';
        runId: string;
        definition: { id: string; version: string; digest: string };
      };
  members: {
    seatId: string;
    taskId: string;
    conversationId: string;
    sessionId: string;
    clientTurnId: string;
    claimId: string | null;
    invocationId: string | null;
    providerTurnId: string | null;
    bindingState:
      | 'reserved'
      | 'launch-intent'
      | 'session-started'
      | 'turn-accepted'
      | 'observed';
    outcome: string | null;
    outputRef: DelegationGroupReference | null;
    dissentRefs: DelegationGroupReference[];
    uncertaintyRefs: DelegationGroupReference[];
    terminalProof: 'unproven' | 'proven';
  }[];
};
export type DelegationGroupEventPage = {
  groupId: string;
  afterRevision: number;
  nextRevision: number;
  events: {
    revision: number;
    kind: string;
    seatId?: string;
    invocationId?: string;
    outputRef?: DelegationGroupReference;
  }[];
  hasMore: boolean;
  unavailable: { cursor: number; code: 'item_too_large' }[];
};
export type DelegationGroupMemberEventPage = {
  unavailable: { cursor: number; code: 'item_too_large' }[];
  state: 'available' | 'unavailable';
  groupId: string;
  seatId: string;
  nextSequence: number;
  hasMore: boolean;
  events: {
    eventId: string;
    sequence: number;
    kind: string;
    turnId?: string;
    inputRequest?: {
      requestId: string;
      requestEventId: string;
      form: InputRequestForm;
    };
  }[];
};
export type DelegationGroupCancelResult = {
  disposition: 'requested' | 'pending';
  group: DelegationGroupView;
};

export type DelegationGroupListPage = {
  unavailable: { cursor: string; code: 'item_too_large' }[];
  groups: DelegationGroupView[];
  nextGroupId: string | null;
  hasMore: boolean;
};

export type DelegationGroupOperationResult = {
  replayed: boolean;
  group: DelegationGroupView;
};

/** Private observation payloads are JSON data, never executable authority. */
export type DelegationGroupJson =
  | null
  | boolean
  | number
  | string
  | DelegationGroupJson[]
  | { [key: string]: DelegationGroupJson };
export type DelegationGroupRawOutputResult = {
  reference: DelegationGroupReference;
  raw: DelegationGroupJson;
  rawResult: DelegationGroupJson;
};

/** Session groups use Station authority; they do not claim portable envelope enforcement. */
export type CliSessionGroupPresetIdentity = {
  presetId: string;
  name: string;
  sha256: string;
  stationmaster: string;
};

export type CliSessionGroupAttention = {
  kind: 'needs-input' | 'review-pending' | 'blocked';
  observedAt: string;
  request?: { id: string; eventId?: string };
};

export type CliSessionGroupView = {
  version: 'station.cli-session-group/v1';
  groupId: string;
  revision: number;
  supervision: 'active' | 'not-running';
  cancelled: boolean;
  deadlineAt: number;
  maxConcurrent: number;
  dispatchCount: number;
  preset?: CliSessionGroupPresetIdentity;
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
  revision: number;
  members: CliSessionGroupView['members'];
  cancelled?: boolean;
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
