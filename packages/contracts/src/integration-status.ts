import {
  boundedText,
  closedRecord,
  enumValue,
} from './integration-validation.js';

export const INTEGRATION_ACTION_STATES = [
  'works',
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

/** Bounds use UTF-16 code units and refuse rather than truncate. */
export const INTEGRATION_STATUS_LIMITS = Object.freeze({
  idChars: 256,
  actionChars: 64,
  probeIdChars: 256,
  reasonChars: 1000,
  actionsPerConnection: 32,
  connections: 100,
});

export interface IntegrationActionStatus {
  readonly action: string;
  /** Probe identifier, including the owner of an upstream availability check. */
  readonly computedBy: string;
  readonly state: IntegrationActionState;
  /** Probe diagnostic or concrete upstream reason; never an inferred capability. */
  readonly reason: string;
}

export interface IntegrationConnectionStatus {
  readonly connectionId: string;
  readonly provider: IntegrationProvider;
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
    !boundedText(value.action, INTEGRATION_STATUS_LIMITS.actionChars) ||
    !boundedText(value.computedBy, INTEGRATION_STATUS_LIMITS.probeIdChars) ||
    !enumValue(value.state, INTEGRATION_ACTION_STATES) ||
    !boundedText(value.reason, INTEGRATION_STATUS_LIMITS.reasonChars)
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
    !closedRecord(value, ['connectionId', 'provider', 'actions']) ||
    !boundedText(value.connectionId, INTEGRATION_STATUS_LIMITS.idChars) ||
    !enumValue(value.provider, INTEGRATION_PROVIDERS) ||
    !Array.isArray(value.actions) ||
    value.actions.length > INTEGRATION_STATUS_LIMITS.actionsPerConnection
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
