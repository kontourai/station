import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  DiscordCapability,
  DiscordChannelSessionBinding,
  DiscordGatewayConfiguration,
  DiscordGuildScope,
  DiscordIdentityMapping,
} from '@kontourai/station-contracts/discord';
import { DISCORD_CAPABILITIES } from '@kontourai/station-contracts/discord';

const FILE_NAME = 'discord-gateway.json';
const CAPABILITIES = new Set<string>(DISCORD_CAPABILITIES);

export class DiscordGatewayConfigurationError extends Error {
  constructor() {
    super('Discord gateway configuration is unavailable.');
    this.name = 'DiscordGatewayConfigurationError';
  }
}

export function discordGatewayConfigurationPath(homeDir: string): string {
  return join(homeDir, 'security', FILE_NAME);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isStringList(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => isNonEmptyString(entry))
  );
}

function isGuildScope(value: unknown): value is DiscordGuildScope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const scope = value as Record<string, unknown>;
  return (
    isNonEmptyString(scope.guildId) &&
    (scope.channelIds === undefined || isStringList(scope.channelIds))
  );
}

function isIdentityMapping(value: unknown): value is DiscordIdentityMapping {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const mapping = value as Record<string, unknown>;
  return (
    isNonEmptyString(mapping.discordUserId) &&
    isNonEmptyString(mapping.stationIdentity) &&
    (mapping.revokedAt === undefined || isNonEmptyString(mapping.revokedAt)) &&
    (mapping.capabilities === undefined ||
      (Array.isArray(mapping.capabilities) &&
        mapping.capabilities.every(
          (capability) =>
            typeof capability === 'string' && CAPABILITIES.has(capability),
        ))) &&
    (mapping.projectFileProjects === undefined ||
      isStringList(mapping.projectFileProjects))
  );
}

function isChannelSessionBinding(
  value: unknown,
): value is DiscordChannelSessionBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const binding = value as Record<string, unknown>;
  return (
    isNonEmptyString(binding.guildId) &&
    isNonEmptyString(binding.channelId) &&
    isNonEmptyString(binding.sessionId)
  );
}

function isConfiguration(value: unknown): value is DiscordGatewayConfiguration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const config = value as Record<string, unknown>;
  return (
    config.schemaVersion === 1 &&
    (config.enabled === undefined || typeof config.enabled === 'boolean') &&
    (config.token === undefined || isNonEmptyString(config.token)) &&
    (config.guilds === undefined ||
      (Array.isArray(config.guilds) && config.guilds.every(isGuildScope))) &&
    (config.identities === undefined ||
      (Array.isArray(config.identities) &&
        config.identities.every(isIdentityMapping))) &&
    (config.sessionBindings === undefined ||
      (Array.isArray(config.sessionBindings) &&
        config.sessionBindings.every(isChannelSessionBinding) &&
        new Set(
          config.sessionBindings.map(
            (binding) => `${binding.guildId}\u0000${binding.channelId}`,
          ),
        ).size === config.sessionBindings.length &&
        new Set(config.sessionBindings.map((binding) => binding.sessionId))
          .size === config.sessionBindings.length))
  );
}

/**
 * The binding is loaded from Station's private configuration every time it is
 * needed. It is intentionally not retained by the gateway client: channel
 * routing is Station-persisted authority, not reconnect-local bot state.
 */
export function findDiscordChannelSessionBinding(
  configuration: DiscordGatewayConfiguration,
  guildId: string,
  channelId: string,
): DiscordChannelSessionBinding | undefined {
  return configuration.sessionBindings?.find(
    (binding) => binding.guildId === guildId && binding.channelId === channelId,
  );
}

/**
 * The policy is deliberately loaded anew for every authorization decision.
 * That is what makes a mapping revocation immediate rather than a restart-time
 * cache invalidation problem. The file is private because it holds a token.
 */
export class DiscordGatewayConfigurationStore {
  constructor(private readonly homeDir: string) {}

  read(): DiscordGatewayConfiguration {
    const path = discordGatewayConfigurationPath(this.homeDir);
    if (!existsSync(path)) return { schemaVersion: 1 };
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      if (!isConfiguration(parsed)) throw new Error('invalid shape');
      return structuredClone(parsed);
    } catch {
      throw new DiscordGatewayConfigurationError();
    }
  }

  /** Local configuration seam for future owner-authenticated management UI/CLI. */
  write(configuration: DiscordGatewayConfiguration): void {
    if (!isConfiguration(configuration)) {
      throw new DiscordGatewayConfigurationError();
    }
    const path = discordGatewayConfigurationPath(this.homeDir);
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const temporaryPath = `${path}.${process.pid}.tmp`;
    try {
      writeFileSync(temporaryPath, JSON.stringify(configuration, null, 2), {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'w',
      });
      renameSync(temporaryPath, path);
      chmodSync(path, 0o600);
    } finally {
      if (existsSync(temporaryPath)) {
        try {
          // A failed replacement must not leave a token-bearing scratch file.
          rmSync(temporaryPath, { force: true });
        } catch {
          // The original error remains authoritative.
        }
      }
    }
  }
}

export function hasDiscordCapability(
  mapping: DiscordIdentityMapping,
  capability: DiscordCapability,
): boolean {
  return mapping.capabilities?.includes(capability) === true;
}
