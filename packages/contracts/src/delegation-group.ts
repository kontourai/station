/** A retained observation of one member-context sync operation. */
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

/** Session groups use Station authority; they do not claim portable envelope enforcement. */
export type CliSessionGroupView = {
  version: 'station.cli-session-group/v1';
  groupId: string;
  revision: number;
  supervision: 'active' | 'not-running';
  cancelled: boolean;
  deadlineAt: number;
  maxConcurrent: number;
  /** Maximum reserved seat starts. Defaults to roster size. */
  maxDispatches: number;
  dispatchCount: number;
  admissionClosed?: 'dispatch-limit-exhausted';
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
    terminalEvent?: { eventId: string; turnId: string };
  }[];
};
