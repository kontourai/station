export const SESSION_GOAL_OBJECTIVE_MAX_CHARS = 4000;

export type SessionGoalStatus =
  | 'active'
  | 'paused'
  | 'blocked'
  | 'usage-limited'
  | 'budget-limited'
  | 'complete';

export interface SessionGoal {
  objective: string;
  status: SessionGoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
}

export type SessionGoalCommand =
  /** Store a paused objective. Activation is a separately advertised operation. */
  | { operation: 'set'; objective: string; tokenBudget: number | null }
  | { operation: 'pause' | 'resume' | 'clear' };

/** Shared control semantics; implementation identity is never an authorization. */
export interface SessionGoalCapability {
  implementation: 'engine' | 'station';
  operations: readonly ('read' | SessionGoalCommand['operation'])[];
  maxObjectiveChars: number;
  tokenBudget: 'enforced-by-implementation';
  completion: 'implementation-reported';
  saveState: 'paused';
}

export type SessionGoalRead =
  | {
      state: 'available';
      capability: SessionGoalCapability;
      goal: SessionGoal | null;
    }
  | { state: 'unsupported' }
  | {
      state: 'unavailable';
      reason: 'session-not-live' | 'provider-unavailable';
    };

export type SessionGoalControlResult =
  | { state: 'applied'; goal: SessionGoal | null }
  | { state: 'unsupported' }
  | {
      state: 'refused';
      reason: 'invalid-command' | 'session-not-live' | 'busy';
    }
  | { state: 'indeterminate' };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export function parseSessionGoal(value: unknown): SessionGoal | null {
  if (!record(value)) return null;
  const { objective, status, tokenBudget, tokensUsed, timeUsedSeconds } = value;
  if (
    typeof objective !== 'string' ||
    !objective.trim() ||
    objective.length > SESSION_GOAL_OBJECTIVE_MAX_CHARS ||
    typeof status !== 'string' ||
    ![
      'active',
      'paused',
      'blocked',
      'usage-limited',
      'budget-limited',
      'complete',
    ].includes(status) ||
    (tokenBudget !== null && (!count(tokenBudget) || tokenBudget === 0)) ||
    !count(tokensUsed) ||
    !count(timeUsedSeconds)
  )
    return null;
  return {
    objective,
    status: status as SessionGoalStatus,
    tokenBudget,
    tokensUsed,
    timeUsedSeconds,
  };
}

export function parseSessionGoalCommand(
  value: unknown,
): SessionGoalCommand | null {
  if (!record(value)) return null;
  const { operation } = value;
  if (operation === 'pause' || operation === 'resume' || operation === 'clear')
    return Object.keys(value).length === 1 ? { operation } : null;
  if (
    operation !== 'set' ||
    Object.keys(value).some(
      (key) => !['operation', 'objective', 'tokenBudget'].includes(key),
    ) ||
    typeof value.objective !== 'string' ||
    !value.objective.trim() ||
    value.objective.length > SESSION_GOAL_OBJECTIVE_MAX_CHARS ||
    (value.tokenBudget !== null &&
      (!count(value.tokenBudget) || value.tokenBudget === 0))
  )
    return null;
  return {
    operation,
    objective: value.objective,
    tokenBudget: value.tokenBudget,
  };
}

export function parseSessionGoalRead(value: unknown): SessionGoalRead | null {
  if (!record(value)) return null;
  if (value.state === 'unsupported') return { state: 'unsupported' };
  if (
    value.state === 'unavailable' &&
    (value.reason === 'session-not-live' ||
      value.reason === 'provider-unavailable')
  )
    return { state: value.state, reason: value.reason };
  if (value.state !== 'available' || !record(value.capability)) return null;
  const capability = value.capability;
  if (
    !['engine', 'station'].includes(String(capability.implementation)) ||
    !Array.isArray(capability.operations) ||
    capability.operations.length > 5 ||
    !capability.operations.includes('read') ||
    capability.operations.some(
      (operation) =>
        !['read', 'set', 'pause', 'resume', 'clear'].includes(operation),
    ) ||
    !count(capability.maxObjectiveChars) ||
    capability.maxObjectiveChars < 1 ||
    capability.maxObjectiveChars > SESSION_GOAL_OBJECTIVE_MAX_CHARS ||
    capability.tokenBudget !== 'enforced-by-implementation' ||
    capability.completion !== 'implementation-reported' ||
    capability.saveState !== 'paused'
  )
    return null;
  const goal = value.goal === null ? null : parseSessionGoal(value.goal);
  if (value.goal !== null && !goal) return null;
  return {
    state: 'available',
    capability: {
      implementation: capability.implementation as 'engine' | 'station',
      operations: [...capability.operations],
      maxObjectiveChars: capability.maxObjectiveChars,
      tokenBudget: capability.tokenBudget,
      completion: capability.completion,
      saveState: capability.saveState,
    },
    goal,
  };
}

export function parseSessionGoalControlResult(
  value: unknown,
): SessionGoalControlResult | null {
  if (!record(value)) return null;
  if (value.state === 'unsupported' || value.state === 'indeterminate')
    return { state: value.state };
  if (
    value.state === 'refused' &&
    (value.reason === 'invalid-command' ||
      value.reason === 'session-not-live' ||
      value.reason === 'busy')
  )
    return { state: value.state, reason: value.reason };
  if (value.state !== 'applied') return null;
  const goal = value.goal === null ? null : parseSessionGoal(value.goal);
  return value.goal === null || goal ? { state: 'applied', goal } : null;
}
