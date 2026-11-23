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

export type CliSessionGroupCreateInput = {
  operationId: string;
  maxConcurrent: number;
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
