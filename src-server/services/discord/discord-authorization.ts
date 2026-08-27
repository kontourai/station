import type {
  DiscordCapability,
  DiscordGatewayConfiguration,
} from '@kontourai/station-contracts/discord';
import {
  DiscordGatewayConfigurationError,
  DiscordGatewayConfigurationStore,
  hasDiscordCapability,
} from './discord-gateway-config-store.js';

export interface DiscordAuthorizationRequest {
  discordUserId: string;
  guildId: string;
  channelId: string;
  capability: DiscordCapability;
  projectSlug?: string;
}

export type DiscordAuthorizationResult =
  | { allowed: true; stationIdentity: string }
  | {
      allowed: false;
      reason:
        | 'outside_allowed_scope'
        | 'unmapped_identity'
        | 'not_permitted'
        | 'policy_unavailable';
    };

/**
 * The sole identity and authorization seam for a Discord-originated request.
 * It deliberately computes mapping and each capability together from the
 * current policy document; no caller can accidentally treat a name or a
 * cached mapping as authority.
 */
export class DiscordAuthorizationService {
  constructor(private readonly store: DiscordGatewayConfigurationStore) {}

  authorize(request: DiscordAuthorizationRequest): DiscordAuthorizationResult {
    let configuration: DiscordGatewayConfiguration;
    try {
      configuration = this.store.read();
    } catch (error) {
      if (error instanceof DiscordGatewayConfigurationError) {
        return { allowed: false, reason: 'policy_unavailable' };
      }
      throw error;
    }

    const inScope = configuration.guilds?.some(
      (scope) =>
        scope.guildId === request.guildId &&
        scope.channelIds?.includes(request.channelId) === true,
    );
    if (!inScope) return { allowed: false, reason: 'outside_allowed_scope' };

    const mapping = configuration.identities?.find(
      (candidate) => candidate.discordUserId === request.discordUserId,
    );
    if (!mapping || mapping.revokedAt !== undefined) {
      return { allowed: false, reason: 'unmapped_identity' };
    }
    if (!hasDiscordCapability(mapping, request.capability)) {
      return { allowed: false, reason: 'not_permitted' };
    }
    if (
      request.capability === 'project-files:read' &&
      (!request.projectSlug ||
        mapping.projectFileProjects?.includes(request.projectSlug) !== true)
    ) {
      return { allowed: false, reason: 'not_permitted' };
    }
    return { allowed: true, stationIdentity: mapping.stationIdentity };
  }
}
