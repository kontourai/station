import {
  boundaryText,
  closedRecord,
  enumValue,
} from './contract-validation.js';

export const INTEGRATION_ACTION_STATES = [
  'works',
  'unverified',
  'not-configured',
  'waiting-on-provider',
  'unsupported',
  'failed',
] as const;
export type IntegrationActionState = (typeof INTEGRATION_ACTION_STATES)[number];

export const INTEGRATION_PROVIDERS = [
  'github',
  'discord',
  'slack',
  'webhook',
  'linear',
  'jira',
] as const;
export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number];

export const INTEGRATION_ACTIONS = [
  'notify',
  'start',
  'continue',
  'approve',
  'read',
  'write',
  'link-pr',
  'update-status',
  'close-issue',
] as const;
export type IntegrationAction = (typeof INTEGRATION_ACTIONS)[number];

/** Bounds use UTF-16 code units and refuse rather than truncate. */
export const INTEGRATION_STATUS_LIMITS = Object.freeze({
  idChars: 256,
  probeIdChars: 256,
  reasonChars: 1000,
  actionsPerConnection: INTEGRATION_ACTIONS.length,
  connections: 100,
});

export interface IntegrationActionStatus<
  Action extends IntegrationAction = IntegrationAction,
> {
  readonly action: Action;
  /** Probe identifier, including the owner of an upstream availability check. */
  readonly computedBy: string;
  readonly state: IntegrationActionState;
  /** Probe diagnostic or concrete upstream reason; never an inferred capability. */
  readonly reason: string;
}

/** Observed CLI credentials on the answering Station; never a repository grant. */
export interface GitHubCliAuthentication {
  readonly state: 'signed-in' | 'failed' | 'unknown';
  readonly observedAt: number;
  readonly account?: string;
  readonly scopes?: readonly string[];
}

export function parseGitHubCliAuthentication(
  value: unknown,
): GitHubCliAuthentication | null {
  if (
    !closedRecord(value, ['state', 'observedAt', 'account', 'scopes']) ||
    !enumValue(value.state, ['signed-in', 'failed', 'unknown']) ||
    !Number.isSafeInteger(value.observedAt) ||
    typeof value.observedAt !== 'number' ||
    value.observedAt < 0
  )
    return null;
  if (
    value.state !== 'signed-in' &&
    (value.account !== undefined || value.scopes !== undefined)
  )
    return null;
  if (
    value.account !== undefined &&
    (typeof value.account !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}(?:\[bot\])?$/.test(value.account))
  )
    return null;
  if (
    value.scopes !== undefined &&
    (!Array.isArray(value.scopes) ||
      value.scopes.length > 32 ||
      value.scopes.some(
        (scope) =>
          typeof scope !== 'string' ||
          scope.length > 64 ||
          !/^[a-z][a-z0-9_-]*(?::[a-z][a-z0-9_-]*)*$/.test(scope) ||
          /^(?:gh[pousr]_|github_pat_)/.test(scope),
      ) ||
      new Set(value.scopes).size !== value.scopes.length)
  )
    return null;
  return {
    state: value.state,
    observedAt: value.observedAt,
    ...(value.account !== undefined ? { account: value.account } : {}),
    ...(value.scopes !== undefined ? { scopes: [...value.scopes] } : {}),
  };
}

export interface IntegrationConnectionStatus {
  readonly connectionId: string;
  readonly provider: IntegrationProvider;
  /** Opt-in metadata; absent on older hosts and ordinary status reads. */
  readonly authentication?: GitHubCliAuthentication;
  readonly actions: readonly IntegrationActionStatus[];
}

export interface IntegrationStatus {
  readonly connections: readonly IntegrationConnectionStatus[];
}

export function parseIntegrationActionStatus(
  value: unknown,
): IntegrationActionStatus | null {
  if (
    !closedRecord(value, ['action', 'computedBy', 'state', 'reason']) ||
    !enumValue(value.action, INTEGRATION_ACTIONS) ||
    !boundaryText(value.computedBy, INTEGRATION_STATUS_LIMITS.probeIdChars) ||
    !enumValue(value.state, INTEGRATION_ACTION_STATES) ||
    !boundaryText(value.reason, INTEGRATION_STATUS_LIMITS.reasonChars)
  )
    return null;
  return {
    action: value.action,
    computedBy: value.computedBy,
    state: value.state,
    reason: value.reason,
  };
}

export function parseIntegrationConnectionStatus(
  value: unknown,
): IntegrationConnectionStatus | null {
  if (
    !closedRecord(value, [
      'connectionId',
      'provider',
      'actions',
      'authentication',
    ]) ||
    !boundaryText(value.connectionId, INTEGRATION_STATUS_LIMITS.idChars) ||
    !enumValue(value.provider, INTEGRATION_PROVIDERS) ||
    !Array.isArray(value.actions) ||
    value.actions.length > INTEGRATION_STATUS_LIMITS.actionsPerConnection
  )
    return null;
  const authentication =
    value.authentication === undefined
      ? undefined
      : parseGitHubCliAuthentication(value.authentication);
  if (
    value.authentication !== undefined &&
    (!authentication || value.provider !== 'github')
  )
    return null;
  const actions: IntegrationActionStatus[] = [];
  const seen = new Set<string>();
  for (const entry of value.actions) {
    const action = parseIntegrationActionStatus(entry);
    if (!action || seen.has(action.action)) return null;
    seen.add(action.action);
    actions.push(action);
  }
  return {
    connectionId: value.connectionId,
    provider: value.provider,
    actions,
    ...(authentication ? { authentication } : {}),
  };
}

export function parseIntegrationStatus(
  value: unknown,
): IntegrationStatus | null {
  if (
    !closedRecord(value, ['connections']) ||
    !Array.isArray(value.connections) ||
    value.connections.length > INTEGRATION_STATUS_LIMITS.connections
  )
    return null;
  const connections: IntegrationConnectionStatus[] = [];
  const seen = new Set<string>();
  for (const entry of value.connections) {
    const connection = parseIntegrationConnectionStatus(entry);
    if (!connection || seen.has(connection.connectionId)) return null;
    seen.add(connection.connectionId);
    connections.push(connection);
  }
  return { connections };
}
