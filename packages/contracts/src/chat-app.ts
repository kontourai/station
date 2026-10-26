import {
  INTEGRATION_ACTION_STATES,
  type IntegrationActionState,
} from './integration-status.js';
import {
  boundedText,
  closedRecord,
  enumValue,
  timestamp,
} from './integration-validation.js';

export const CHAT_APP_IDS = ['discord', 'slack'] as const;
export type ChatAppId = (typeof CHAT_APP_IDS)[number];
export const CHAT_APP_CAPABILITIES = [
  'notify',
  'start',
  'continue',
  'approve',
] as const;
export type ChatAppCapability = (typeof CHAT_APP_CAPABILITIES)[number];

/** Text bounds use UTF-16 code units. Codes expire within ten minutes. */
export const CHAT_APP_LIMITS = Object.freeze({
  idChars: 256,
  probeIdChars: 256,
  reasonChars: 1000,
  linkCodeChars: 128,
  linkCodeMinChars: 8,
  linkCodeLifetimeMs: 10 * 60 * 1000,
});

export interface ChatAppCapabilityChip {
  readonly capability: ChatAppCapability;
  readonly probe: string;
  readonly state: IntegrationActionState;
}

export interface ChatIdentityLink {
  readonly app: ChatAppId;
  readonly externalUserId: string;
  readonly principalId: string;
  readonly linkedAt: string;
  readonly revokedAt?: string;
}

export type ChatChannelTarget =
  | { readonly kind: 'project'; readonly projectId: string }
  | {
      readonly kind: 'conversation';
      readonly conversationId: string;
    };

/** Workspace is a Discord guild or Slack workspace. Binding writes are operator-owned. */
export interface ChatChannelBinding {
  readonly id: string;
  readonly app: ChatAppId;
  readonly externalWorkspaceId: string;
  readonly externalChannelId: string;
  /** Slack thread timestamp or Discord thread id; absent binds the whole channel. */
  readonly externalThreadId?: string;
  readonly target: ChatChannelTarget;
  readonly boundByPrincipalId: string;
  readonly boundAt: string;
}

export const CHAT_DELIVERY_REFUSAL_REASONS = [
  'app-disabled',
  'not-connected',
  'unlinked-sender',
  'link-revoked',
  'channel-unbound',
  'project-unavailable',
  'conversation-unavailable',
  'membership-required',
  'execute-required',
  'approve-required',
  'capability-unavailable',
  'attachments-unsupported',
  'invalid-message',
  'duplicate-delivery',
  'approval-unavailable',
  'approval-expired',
] as const;
export type ChatDeliveryRefusalReason =
  (typeof CHAT_DELIVERY_REFUSAL_REASONS)[number];

export type ChatDeliveryOutcome =
  | { readonly state: 'pending' }
  | { readonly state: 'delivered'; readonly externalMessageId: string }
  | { readonly state: 'refused'; readonly reason: ChatDeliveryRefusalReason }
  | { readonly state: 'failed'; readonly reason: string };

/** One attempt per row; retryOf links a later attempt to the retained prior outcome. */
export interface ChatDeliveryLogEntry {
  readonly id: string;
  readonly app: ChatAppId;
  readonly externalWorkspaceId: string;
  readonly externalChannelId: string;
  readonly externalThreadId?: string;
  readonly externalUserId?: string;
  readonly principalId?: string;
  readonly projectId?: string;
  readonly conversationId?: string;
  readonly taskId?: string;
  readonly direction: 'inbound' | 'outbound';
  readonly action: ChatAppCapability;
  readonly outcome: ChatDeliveryOutcome;
  readonly createdAt: string;
  readonly retryOf?: string;
}

export interface ChatAppKillSwitch {
  readonly app: ChatAppId;
  readonly disabled: boolean;
  readonly updatedAt: string;
  readonly updatedByPrincipalId: string;
  readonly reason?: string;
}

/** Private one-time record. The runtime must consume atomically after principal matching. */
export interface ChatLinkCode {
  readonly app: ChatAppId;
  readonly code: string;
  readonly externalUserId: string;
  readonly principalId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly consumedAt?: string;
}

/** The runtime must also match principalId to the authenticated caller and code record. */
export interface ChatLinkConfirmRequest {
  readonly app: ChatAppId;
  readonly code: string;
  readonly principalId: string;
}

function id(value: unknown): value is string {
  return boundedText(value, CHAT_APP_LIMITS.idChars);
}

function code(value: unknown): value is string {
  return (
    boundedText(value, CHAT_APP_LIMITS.linkCodeChars) &&
    value.length >= CHAT_APP_LIMITS.linkCodeMinChars &&
    /^[A-Za-z0-9_-]+$/u.test(value)
  );
}

export function parseChatAppId(value: unknown): ChatAppId | null {
  return enumValue(value, CHAT_APP_IDS) ? value : null;
}

export function parseChatAppCapabilityChip(
  value: unknown,
): ChatAppCapabilityChip | null {
  if (
    !closedRecord(value, ['capability', 'probe', 'state']) ||
    !enumValue(value.capability, CHAT_APP_CAPABILITIES) ||
    !boundedText(value.probe, CHAT_APP_LIMITS.probeIdChars) ||
    !enumValue(value.state, INTEGRATION_ACTION_STATES)
  )
    return null;
  return {
    capability: value.capability,
    probe: value.probe,
    state: value.state,
  };
}

export function parseChatIdentityLink(value: unknown): ChatIdentityLink | null {
  if (
    !closedRecord(value, [
      'app',
      'externalUserId',
      'principalId',
      'linkedAt',
      'revokedAt',
    ]) ||
    !enumValue(value.app, CHAT_APP_IDS) ||
    !id(value.externalUserId) ||
    !id(value.principalId) ||
    !timestamp(value.linkedAt) ||
    (value.revokedAt !== undefined &&
      (!timestamp(value.revokedAt) || value.revokedAt < value.linkedAt))
  )
    return null;
  return {
    app: value.app,
    externalUserId: value.externalUserId,
    principalId: value.principalId,
    linkedAt: value.linkedAt,
    ...(value.revokedAt === undefined ? {} : { revokedAt: value.revokedAt }),
  };
}

function parseTarget(value: unknown): ChatChannelTarget | null {
  if (!closedRecord(value, ['kind', 'projectId', 'conversationId']))
    return null;
  if (
    value.kind === 'project' &&
    closedRecord(value, ['kind', 'projectId']) &&
    id(value.projectId)
  )
    return { kind: 'project', projectId: value.projectId };
  if (
    value.kind === 'conversation' &&
    closedRecord(value, ['kind', 'conversationId']) &&
    id(value.conversationId)
  )
    return {
      kind: 'conversation',
      conversationId: value.conversationId,
    };
  return null;
}

export function parseChatChannelBinding(
  value: unknown,
): ChatChannelBinding | null {
  if (
    !closedRecord(value, [
      'id',
      'app',
      'externalWorkspaceId',
      'externalChannelId',
      'externalThreadId',
      'target',
      'boundByPrincipalId',
      'boundAt',
    ]) ||
    !id(value.id) ||
    !enumValue(value.app, CHAT_APP_IDS) ||
    !id(value.externalWorkspaceId) ||
    !id(value.externalChannelId) ||
    (value.externalThreadId !== undefined && !id(value.externalThreadId)) ||
    !id(value.boundByPrincipalId) ||
    !timestamp(value.boundAt)
  )
    return null;
  const target = parseTarget(value.target);
  if (!target) return null;
  return {
    id: value.id,
    app: value.app,
    externalWorkspaceId: value.externalWorkspaceId,
    externalChannelId: value.externalChannelId,
    ...(value.externalThreadId === undefined
      ? {}
      : { externalThreadId: value.externalThreadId }),
    target,
    boundByPrincipalId: value.boundByPrincipalId,
    boundAt: value.boundAt,
  };
}

function parseOutcome(value: unknown): ChatDeliveryOutcome | null {
  if (!closedRecord(value, ['state', 'reason', 'externalMessageId']))
    return null;
  if (value.state === 'pending' && closedRecord(value, ['state']))
    return { state: 'pending' };
  if (
    value.state === 'delivered' &&
    closedRecord(value, ['state', 'externalMessageId']) &&
    id(value.externalMessageId)
  )
    return { state: 'delivered', externalMessageId: value.externalMessageId };
  if (!closedRecord(value, ['state', 'reason'])) return null;
  if (
    value.state === 'refused' &&
    enumValue(value.reason, CHAT_DELIVERY_REFUSAL_REASONS)
  )
    return { state: 'refused', reason: value.reason };
  if (
    value.state === 'failed' &&
    boundedText(value.reason, CHAT_APP_LIMITS.reasonChars)
  )
    return { state: 'failed', reason: value.reason };
  return null;
}

export function parseChatDeliveryLogEntry(
  value: unknown,
): ChatDeliveryLogEntry | null {
  const optionalIds = [
    'externalThreadId',
    'externalUserId',
    'principalId',
    'projectId',
    'conversationId',
    'taskId',
    'retryOf',
  ] as const;
  if (
    !closedRecord(value, [
      'id',
      'app',
      'externalWorkspaceId',
      'externalChannelId',
      'direction',
      'action',
      'outcome',
      'createdAt',
      ...optionalIds,
    ]) ||
    !id(value.id) ||
    !enumValue(value.app, CHAT_APP_IDS) ||
    !id(value.externalWorkspaceId) ||
    !id(value.externalChannelId) ||
    !enumValue(value.direction, ['inbound', 'outbound']) ||
    !enumValue(value.action, CHAT_APP_CAPABILITIES) ||
    !timestamp(value.createdAt)
  )
    return null;
  const optional: Partial<Record<(typeof optionalIds)[number], string>> = {};
  for (const key of optionalIds) {
    if (value[key] === undefined) continue;
    if (!id(value[key])) return null;
    optional[key] = value[key];
  }
  const outcome = parseOutcome(value.outcome);
  if (!outcome || value.retryOf === value.id) return null;
  return {
    id: value.id,
    app: value.app,
    externalWorkspaceId: value.externalWorkspaceId,
    externalChannelId: value.externalChannelId,
    direction: value.direction,
    action: value.action,
    outcome,
    createdAt: value.createdAt,
    ...optional,
  };
}

export function parseChatAppKillSwitch(
  value: unknown,
): ChatAppKillSwitch | null {
  if (
    !closedRecord(value, [
      'app',
      'disabled',
      'updatedAt',
      'updatedByPrincipalId',
      'reason',
    ]) ||
    !enumValue(value.app, CHAT_APP_IDS) ||
    typeof value.disabled !== 'boolean' ||
    !timestamp(value.updatedAt) ||
    !id(value.updatedByPrincipalId) ||
    (value.reason !== undefined &&
      !boundedText(value.reason, CHAT_APP_LIMITS.reasonChars))
  )
    return null;
  return {
    app: value.app,
    disabled: value.disabled,
    updatedAt: value.updatedAt,
    updatedByPrincipalId: value.updatedByPrincipalId,
    ...(value.reason === undefined ? {} : { reason: value.reason }),
  };
}

export function parseChatLinkCode(value: unknown): ChatLinkCode | null {
  if (
    !closedRecord(value, [
      'app',
      'code',
      'externalUserId',
      'principalId',
      'issuedAt',
      'expiresAt',
      'consumedAt',
    ]) ||
    !enumValue(value.app, CHAT_APP_IDS) ||
    !code(value.code) ||
    !id(value.externalUserId) ||
    !id(value.principalId) ||
    !timestamp(value.issuedAt) ||
    !timestamp(value.expiresAt)
  )
    return null;
  const lifetime = Date.parse(value.expiresAt) - Date.parse(value.issuedAt);
  if (
    lifetime <= 0 ||
    lifetime > CHAT_APP_LIMITS.linkCodeLifetimeMs ||
    (value.consumedAt !== undefined &&
      (!timestamp(value.consumedAt) ||
        value.consumedAt < value.issuedAt ||
        value.consumedAt >= value.expiresAt))
  )
    return null;
  return {
    app: value.app,
    code: value.code,
    externalUserId: value.externalUserId,
    principalId: value.principalId,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
    ...(value.consumedAt === undefined ? {} : { consumedAt: value.consumedAt }),
  };
}

export function parseChatLinkConfirmRequest(
  value: unknown,
): ChatLinkConfirmRequest | null {
  if (
    !closedRecord(value, ['app', 'code', 'principalId']) ||
    !enumValue(value.app, CHAT_APP_IDS) ||
    !code(value.code) ||
    !id(value.principalId)
  )
    return null;
  return { app: value.app, code: value.code, principalId: value.principalId };
}
