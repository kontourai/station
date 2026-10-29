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
      // An unreadable policy, database or refusal log must fail closed.
      return { allowed: false, reason: 'policy_unavailable' };
    }
  }
}
