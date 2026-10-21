import type { InputRequestForm } from './input-request';

export const DELEGATION_GROUP_TRANSPORT_VERSION =
  'station.delegation-group/v1' as const;
export const DELEGATION_GROUP_LIMITS = {
  requestBytes: 16_384,
  responseBytes: 262_144,
  pageSize: 64,
  memberPageSize: 64,
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
export type CliSessionGroupView = {
  version: 'station.cli-session-group/v1';
  groupId: string;
  revision: number;
  supervision: 'active' | 'not-running';
  cancelled: boolean;
  deadlineAt: number;
  maxConcurrent: number;
  dispatchCount: number;
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
    terminalEvent?: { eventId: string; turnId: string };
  }[];
};
