import {
  ChatAppCore,
  type LegacyDiscordAuthorization,
  type LegacyDiscordRequest,
} from '../chat-apps/chat-app-core.js';
import { DiscordGatewayConfigurationStore } from './discord-gateway-config-store.js';

export type DiscordAuthorizationRequest = LegacyDiscordRequest;
export type DiscordAuthorizationResult = LegacyDiscordAuthorization;

/** Durable links are authority; the live v1 file remains an additional ceiling. */
export class DiscordAuthorizationService {
  private readonly core: ChatAppCore;

  constructor(
    private readonly store: DiscordGatewayConfigurationStore,
    core?: ChatAppCore,
  ) {
    this.core = core ?? new ChatAppCore(store.homeDir);
  }

  authorize(request: DiscordAuthorizationRequest): DiscordAuthorizationResult {
    try {
      const configuration = this.store.read();
      const snapshot = JSON.stringify(configuration);
      return this.core.authorizeDiscord(
        configuration,
        request,
        () => JSON.stringify(this.store.read()) === snapshot,
      );
    } catch {
      // Logging may itself be unavailable; never send when authority is uncertain.
      if (request.replyChunk) {
        try {
          this.core.recordDelivery(
            {
              app: 'discord',
              externalWorkspaceId: request.guildId,
              externalChannelId: request.channelId,
              externalUserId: request.discordUserId,
              conversationId: request.expectedSessionId,
              direction: 'outbound',
              action: 'notify',
              replyChunk: request.replyChunk,
            },
            { state: 'refused', reason: 'policy-unavailable' },
          );
        } catch {
          /* The delivery log itself is unavailable. */
        }
      }
      return { allowed: false, reason: 'policy_unavailable' };
    }
  }
}
