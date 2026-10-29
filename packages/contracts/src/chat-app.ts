import {
  boundaryText,
  closedRecord,
  enumValue,
  sha256,
  timestamp,
} from './contract-validation.js';
import {
  DISCORD_CAPABILITIES,
  type DiscordCapability,
  type DiscordGatewayConfiguration,
} from './discord.js';
import {
  type IntegrationActionStatus,
  parseIntegrationActionStatus,
} from './integration-status.js';

export const CHAT_APP_IDS = ['discord', 'slack'] as const;
export type ChatAppId = (typeof CHAT_APP_IDS)[number];
export const CHAT_APP_CAPABILITIES = [
  'notify',
  'start',
  'continue',
  'approve',
] as const;
export type ChatAppCapability = (typeof CHAT_APP_CAPABILITIES)[number];

/** 32 symbols, excluding 0/1/I/O. Runtime generation must be uniform and cryptographic. */
export const CHAT_LINK_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
/** Text bounds use UTF-16 code units. Ten random symbols provide 50 bits of entropy. */
export const CHAT_APP_LIMITS = Object.freeze({
  idChars: 256,
  reasonChars: 1000,
  linkCodeChars: 128,
  linkCodeMinChars: 10,
  linkCodeMinEntropyBits: 50,
  linkCodeMaxFailedAttempts: 5,
  linkCodeLifetimeMs: 10 * 60 * 1000,
});

/** Identical to a status action: no chip-to-status translation. */
export type ChatAppCapabilityChip = IntegrationActionStatus<ChatAppCapability>;

export interface ChatLegacyDiscordIdentityProvenance {
  readonly source: 'legacy-import';
  /** Legacy userId namespace; resolve against real principals before granting access. */
  readonly stationIdentity: string;
  /** Retain exact legacy grants. Absence in v1 becomes [], never a default grant. */
  readonly capabilities: readonly DiscordCapability[];
  /** Project slugs, not project IDs. Required in addition to project-files:read. */
  readonly projectFileProjects: readonly string[];
}

export type ChatIdentityLink = {
  readonly externalUserId: string;
  /** Presence revokes immediately, including imported future timestamps; never a schedule. */
  readonly revokedAt?: string;
} & (
  | {
      readonly app: ChatAppId;
      readonly principalId: string;
      readonly linkedAt: string;
      readonly importedAt?: never;
      readonly provenance?: never;
    }
  | {
      readonly app: 'discord';
      /** Omitted until the runtime verifies the legacy identity-to-principal mapping. */
      readonly principalId?: string;
      readonly linkedAt?: never;
      readonly importedAt: string;
      readonly provenance: ChatLegacyDiscordIdentityProvenance;
    }
);

export type ChatChannelTarget =
  | { readonly kind: 'project'; readonly projectId: string }
  | { readonly kind: 'conversation'; readonly conversationId: string };

/** Workspace is a Discord guild or Slack workspace. Binding writes are operator-owned. */
export type ChatChannelBinding = {
  readonly id: string;
  readonly externalWorkspaceId: string;
  readonly externalChannelId: string;
} & (
  | {
      readonly app: ChatAppId;
      /** Slack thread timestamp or Discord thread id; absent binds the whole channel. */
      readonly externalThreadId?: string;
      readonly target: ChatChannelTarget;
      readonly boundByPrincipalId: string;
      readonly boundAt: string;
      readonly provenance?: never;
    }
  | {
      readonly app: 'discord';
      readonly externalThreadId?: never;
      readonly target: Extract<ChatChannelTarget, { kind: 'conversation' }>;
      readonly provenance: { readonly source: 'legacy-import' };
      readonly boundByPrincipalId?: never;
      readonly boundAt?: never;
    }
);

/**
 * Import routing never grants channel access. Retain the v1 guild/channel allow-list:
 * some matching guild must explicitly name the channel; empty means deny all.
 */
export interface ChatDiscordImport {
  /** Absent/false in v1 stays disabled; the runtime must persist this state. */
  readonly enabled: boolean;
  readonly links: readonly ChatIdentityLink[];
  readonly bindings: readonly ChatChannelBinding[];
  readonly guilds: readonly {
    readonly guildId: string;
    readonly channelIds: readonly string[];
  }[];
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
  readonly approval?: {
    readonly sessionId: string;
    readonly requestId: string;
  };
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

/**
 * Private two-step record. Issue before the principal is known; store only the
 * lowercase SHA-256 digest of the raw ASCII code. Runtime must compare digests,
 * check expiry/attempt budget, and atomically bind the authenticated principal
 * and consumedAt on successful confirmation. Increment failures atomically;
 * failedAttempts == max is locked. Parsers do not grant redemption.
 */
export type ChatLinkCode = {
  readonly app: ChatAppId;
  readonly challengeId: string;
  readonly codeHash: string;
  readonly externalUserId: string;
  readonly failedAttempts: number;
  readonly issuedAt: string;
  readonly expiresAt: string;
} & (
  | { readonly principalId?: never; readonly consumedAt?: never }
  | { readonly principalId: string; readonly consumedAt: string }
);

/**
 * Principal comes exclusively from the authenticated caller, never this body.
 * The runtime must require the caller to prove control of this one-time code.
 */
export interface ChatLinkConfirmRequest {
  readonly app: ChatAppId;
  readonly challengeId: string;
  readonly code: string;
}

function id(value: unknown): value is string {
  return boundaryText(value, CHAT_APP_LIMITS.idChars);
}

function externalId(
  app: ChatAppId,
  kind: 'user' | 'workspace' | 'channel' | 'thread' | 'message',
  value: unknown,
): value is string {
  if (!id(value)) return false;
  if (app === 'discord') return /^[0-9]{17,20}$/u.test(value);
  if (kind === 'thread' || kind === 'message')
    return /^[0-9]+\.[0-9]+$/u.test(value);
  const prefix =
    kind === 'user' ? '[UW]' : kind === 'workspace' ? 'T' : '[CGD]';
  return new RegExp(`^${prefix}[A-Z0-9]+$`, 'u').test(value);
}

function code(value: unknown): value is string {
  return (
    boundaryText(value, CHAT_APP_LIMITS.linkCodeChars) &&
    value.length >= CHAT_APP_LIMITS.linkCodeMinChars &&
    Array.from(value).every((symbol) =>
      CHAT_LINK_CODE_ALPHABET.includes(symbol),
    )
  );
}

export function parseChatAppId(value: unknown): ChatAppId | null {
  return enumValue(value, CHAT_APP_IDS) ? value : null;
}

export function parseChatAppCapabilityChip(
  value: unknown,
): ChatAppCapabilityChip | null {
  const status = parseIntegrationActionStatus(value);
  return status && enumValue(status.action, CHAT_APP_CAPABILITIES)
    ? { ...status, action: status.action }
    : null;
}

function parseLegacyIdentityProvenance(
  value: unknown,
): ChatLegacyDiscordIdentityProvenance | null {
  if (
    !closedRecord(value, [
      'source',
      'stationIdentity',
      'capabilities',
      'projectFileProjects',
    ]) ||
    value.source !== 'legacy-import' ||
    !id(value.stationIdentity) ||
    !Array.isArray(value.capabilities) ||
    !Array.isArray(value.projectFileProjects)
  )
    return null;
  const capabilities: DiscordCapability[] = [];
  for (const capability of value.capabilities) {
    if (!enumValue(capability, DISCORD_CAPABILITIES)) return null;
    capabilities.push(capability);
  }
  const projectFileProjects: string[] = [];
  for (const project of value.projectFileProjects) {
    if (!id(project)) return null;
    projectFileProjects.push(project);
  }
  return {
    source: 'legacy-import',
    stationIdentity: value.stationIdentity,
    capabilities,
    projectFileProjects,
  };
}

export function parseChatIdentityLink(value: unknown): ChatIdentityLink | null {
  if (
    !closedRecord(value, [
      'app',
      'externalUserId',
      'principalId',
      'linkedAt',
      'importedAt',
      'provenance',
      'revokedAt',
    ]) ||
    !enumValue(value.app, CHAT_APP_IDS) ||
    !externalId(value.app, 'user', value.externalUserId) ||
    (value.revokedAt !== undefined && !timestamp(value.revokedAt))
  )
    return null;
  const revoked =
    value.revokedAt === undefined ? {} : { revokedAt: value.revokedAt };
  if (value.provenance !== undefined) {
    const provenance = parseLegacyIdentityProvenance(value.provenance);
    if (
      !provenance ||
      value.app !== 'discord' ||
      !timestamp(value.importedAt) ||
      value.linkedAt !== undefined ||
      (value.principalId !== undefined && !id(value.principalId))
    )
      return null;
    return {
      app: 'discord',
      externalUserId: value.externalUserId,
      importedAt: value.importedAt,
      provenance,
      ...(value.principalId === undefined
        ? {}
        : { principalId: value.principalId }),
      ...revoked,
    };
  }
  if (
    !id(value.principalId) ||
    !timestamp(value.linkedAt) ||
    value.importedAt !== undefined ||
    (value.revokedAt !== undefined && value.revokedAt < value.linkedAt)
  )
    return null;
  return {
    app: value.app,
    externalUserId: value.externalUserId,
    principalId: value.principalId,
    linkedAt: value.linkedAt,
    ...revoked,
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
    return { kind: 'conversation', conversationId: value.conversationId };
  return null;
}

/** Whole-channel v1 key: stable across imports and independent of selected session. */
export function legacyDiscordBindingId(
  guildId: string,
  channelId: string,
): string {
  return `legacy-discord:${guildId}:${channelId}`;
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
      'provenance',
    ]) ||
    !id(value.id) ||
    !enumValue(value.app, CHAT_APP_IDS) ||
    !externalId(value.app, 'workspace', value.externalWorkspaceId) ||
    !externalId(value.app, 'channel', value.externalChannelId) ||
    (value.externalThreadId !== undefined &&
      !externalId(value.app, 'thread', value.externalThreadId))
  )
    return null;
  const target = parseTarget(value.target);
  if (!target) return null;
  const base = {
    id: value.id,
    externalWorkspaceId: value.externalWorkspaceId,
    externalChannelId: value.externalChannelId,
  };
  if (value.provenance !== undefined) {
    if (
      !closedRecord(value.provenance, ['source']) ||
      value.provenance.source !== 'legacy-import' ||
      value.app !== 'discord' ||
      value.boundByPrincipalId !== undefined ||
      value.boundAt !== undefined ||
      value.externalThreadId !== undefined ||
      target.kind !== 'conversation' ||
      value.id !==
        legacyDiscordBindingId(
          value.externalWorkspaceId,
          value.externalChannelId,
        )
    )
      return null;
    return {
      ...base,
      app: 'discord',
      target,
      provenance: { source: 'legacy-import' },
    };
  }
  if (!id(value.boundByPrincipalId) || !timestamp(value.boundAt)) return null;
  return {
    ...base,
    app: value.app,
    target,
    boundByPrincipalId: value.boundByPrincipalId,
    boundAt: value.boundAt,
    ...(value.externalThreadId === undefined
      ? {}
      : { externalThreadId: value.externalThreadId }),
  };
}

/**
 * Pure import projection from the real v1 private-store contract. The runtime
 * owns one-time persistence, enabled/token custody, and verified principal
 * resolution. Retain array order (v1 resolves the first matching identity).
 * Legacy grants/scopes remain mandatory ceilings alongside current membership;
 * no legacy grant implies approve, and a binding never bypasses the allow-list.
 * Return null for an unrepresentable record: never silently drop authority data.
 */
export function importLegacyDiscordConfiguration(
  configuration: DiscordGatewayConfiguration,
  importedAt: string,
): ChatDiscordImport | null {
  if (configuration.schemaVersion !== 1 || !timestamp(importedAt)) return null;
  const links: ChatIdentityLink[] = [];
  for (const mapping of configuration.identities ?? []) {
    const revokedTime =
      mapping.revokedAt === undefined ? NaN : Date.parse(mapping.revokedAt);
    const canonicalRevokedAt = Number.isFinite(revokedTime)
      ? new Date(revokedTime).toISOString()
      : undefined;
    const link = parseChatIdentityLink({
      app: 'discord',
      externalUserId: mapping.discordUserId,
      importedAt,
      provenance: {
        source: 'legacy-import',
        stationIdentity: mapping.stationIdentity,
        capabilities: mapping.capabilities ?? [],
        projectFileProjects: mapping.projectFileProjects ?? [],
      },
      ...(mapping.revokedAt === undefined
        ? {}
        : {
            revokedAt: timestamp(canonicalRevokedAt)
              ? canonicalRevokedAt
              : importedAt,
          }),
    });
    if (!link) return null;
    links.push(link);
  }
  const bindings: ChatChannelBinding[] = [];
  for (const binding of configuration.sessionBindings ?? []) {
    const parsed = parseChatChannelBinding({
      id: legacyDiscordBindingId(binding.guildId, binding.channelId),
      app: 'discord',
      externalWorkspaceId: binding.guildId,
      externalChannelId: binding.channelId,
      target: { kind: 'conversation', conversationId: binding.sessionId },
      provenance: { source: 'legacy-import' },
    });
    if (!parsed) return null;
    bindings.push(parsed);
  }
  const guilds: ChatDiscordImport['guilds'][number][] = [];
  for (const scope of configuration.guilds ?? []) {
    if (
      !externalId('discord', 'workspace', scope.guildId) ||
      !(scope.channelIds ?? []).every((channelId) =>
        externalId('discord', 'channel', channelId),
      )
    )
      return null;
    guilds.push({
      guildId: scope.guildId,
      channelIds: [...(scope.channelIds ?? [])],
    });
  }
  return { enabled: configuration.enabled === true, links, bindings, guilds };
}

function parseOutcome(
  app: ChatAppId,
  value: unknown,
): ChatDeliveryOutcome | null {
  if (!closedRecord(value, ['state', 'reason', 'externalMessageId']))
    return null;
  if (value.state === 'pending' && closedRecord(value, ['state']))
    return { state: 'pending' };
  if (
    value.state === 'delivered' &&
    closedRecord(value, ['state', 'externalMessageId']) &&
    externalId(app, 'message', value.externalMessageId)
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
    boundaryText(value.reason, CHAT_APP_LIMITS.reasonChars)
  )
    return { state: 'failed', reason: value.reason };
  return null;
}

export function parseChatDeliveryLogEntry(
  value: unknown,
): ChatDeliveryLogEntry | null {
  const optionalIds = [
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
      'externalThreadId',
      'externalUserId',
      'approval',
      'direction',
      'action',
      'outcome',
      'createdAt',
      ...optionalIds,
    ]) ||
    !id(value.id) ||
    !enumValue(value.app, CHAT_APP_IDS) ||
    !externalId(value.app, 'workspace', value.externalWorkspaceId) ||
    !externalId(value.app, 'channel', value.externalChannelId) ||
    !enumValue(value.direction, ['inbound', 'outbound']) ||
    !enumValue(value.action, CHAT_APP_CAPABILITIES) ||
    !timestamp(value.createdAt)
  )
    return null;
  const optional: Partial<
    Record<
      (typeof optionalIds)[number] | 'externalUserId' | 'externalThreadId',
      string
    >
  > = {};
  for (const key of optionalIds) {
    if (value[key] === undefined) continue;
    if (!id(value[key])) return null;
    optional[key] = value[key];
  }
  for (const [key, kind] of [
    ['externalUserId', 'user'],
    ['externalThreadId', 'thread'],
  ] as const) {
    if (value[key] === undefined) continue;
    if (!externalId(value.app, kind, value[key])) return null;
    optional[key] = value[key];
  }
  let approval: ChatDeliveryLogEntry['approval'];
  if (value.approval !== undefined) {
    if (
      !closedRecord(value.approval, ['sessionId', 'requestId']) ||
      !id(value.approval.sessionId) ||
      !id(value.approval.requestId)
    )
      return null;
    approval = {
      sessionId: value.approval.sessionId,
      requestId: value.approval.requestId,
    };
  }
  const outcome = parseOutcome(value.app, value.outcome);
  if (
    !outcome ||
    value.retryOf === value.id ||
    (outcome.state === 'refused' &&
      outcome.reason === 'unlinked-sender' &&
      value.principalId !== undefined)
  )
    return null;
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
    ...(approval === undefined ? {} : { approval }),
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
      !boundaryText(value.reason, CHAT_APP_LIMITS.reasonChars))
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
      'challengeId',
      'codeHash',
      'externalUserId',
      'principalId',
      'failedAttempts',
      'issuedAt',
      'expiresAt',
      'consumedAt',
    ]) ||
    !enumValue(value.app, CHAT_APP_IDS) ||
    !id(value.challengeId) ||
    !sha256(value.codeHash) ||
    !externalId(value.app, 'user', value.externalUserId) ||
    typeof value.failedAttempts !== 'number' ||
    !Number.isSafeInteger(value.failedAttempts) ||
    value.failedAttempts < 0 ||
    value.failedAttempts > CHAT_APP_LIMITS.linkCodeMaxFailedAttempts ||
    !timestamp(value.issuedAt) ||
    !timestamp(value.expiresAt)
  )
    return null;
  const lifetime = Date.parse(value.expiresAt) - Date.parse(value.issuedAt);
  if (lifetime <= 0 || lifetime > CHAT_APP_LIMITS.linkCodeLifetimeMs)
    return null;
  const issued = {
    app: value.app,
    challengeId: value.challengeId,
    codeHash: value.codeHash,
    externalUserId: value.externalUserId,
    failedAttempts: value.failedAttempts,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
  };
  if (value.consumedAt === undefined) {
    return value.principalId === undefined ? issued : null;
  }
  if (
    !timestamp(value.consumedAt) ||
    value.consumedAt < value.issuedAt ||
    value.consumedAt >= value.expiresAt ||
    !id(value.principalId) ||
    value.failedAttempts >= CHAT_APP_LIMITS.linkCodeMaxFailedAttempts
  )
    return null;
  return {
    ...issued,
    principalId: value.principalId,
    consumedAt: value.consumedAt,
  };
}

export function parseChatLinkConfirmRequest(
  value: unknown,
): ChatLinkConfirmRequest | null {
  if (
    !closedRecord(value, ['app', 'challengeId', 'code']) ||
    !enumValue(value.app, CHAT_APP_IDS) ||
    !id(value.challengeId) ||
    !code(value.code)
  )
    return null;
  return { app: value.app, challengeId: value.challengeId, code: value.code };
}
