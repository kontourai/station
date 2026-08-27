/**
 * The remote-chat authorization contract. These capabilities intentionally
 * answer four separate questions; callers must request one explicitly.
 */
export const DISCORD_CAPABILITIES = [
  'turn:start',
  'turn:stop',
  'transcript:read',
  'project-files:read',
] as const;

export type DiscordCapability = (typeof DISCORD_CAPABILITIES)[number];

export interface DiscordIdentityMapping {
  /** Stable Discord user id; names are display-only and never authorize. */
  discordUserId: string;
  /** The Station identity this external identity is allowed to act as. */
  stationIdentity: string;
  /** A retained mapping is inactive from the instant this is present. */
  revokedAt?: string;
  /** Explicit grants only. An absent list means no capabilities. */
  capabilities?: DiscordCapability[];
  /**
   * Project scope for `project-files:read`. That capability alone is not a
   * blanket file grant: the requested project must be named here too.
   */
  projectFileProjects?: string[];
}

export interface DiscordGuildScope {
  /** Stable guild id. */
  guildId: string;
  /** Explicit channel allow-list. Empty or absent means no channel is allowed. */
  channelIds?: string[];
}

/**
 * A Station-owned selection of one existing conversation for one Discord
 * channel. This is configuration, not Gateway process state: reconnecting a
 * bot must never change which Station session a channel reaches.
 */
export interface DiscordChannelSessionBinding {
  guildId: string;
  channelId: string;
  /** The Station orchestration conversation id. */
  sessionId: string;
}

/**
 * Private, local-only configuration stored outside the public app-config
 * projection. `enabled` must be exactly true before the gateway can connect.
 */
export interface DiscordGatewayConfiguration {
  schemaVersion: 1;
  enabled?: boolean;
  /** Bot token. It must never be included in API projections or telemetry. */
  token?: string;
  guilds?: DiscordGuildScope[];
  identities?: DiscordIdentityMapping[];
  /** Explicit channel-to-Station-session routing; absent means no channel is bound. */
  sessionBindings?: DiscordChannelSessionBinding[];
}
