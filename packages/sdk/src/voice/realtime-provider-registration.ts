import {
  RealtimeVoiceSessionAdapter,
  type RealtimeVoiceSessionAdapterOptions,
} from './realtime-session-adapter.js';
import type { VoiceRealtimeProvider } from './realtime-types.js';
import type { VoiceSessionAdapterRegistration } from './session-registry.js';
import { VoiceSessionAdapterRegistry } from './session-registry.js';

/** Explicit pack boundary: importing a pack has no registry side effect. */
export function registerRealtimeVoiceProvider(
  registry: VoiceSessionAdapterRegistry,
  provider: VoiceRealtimeProvider,
  options?: RealtimeVoiceSessionAdapterOptions,
): VoiceSessionAdapterRegistration {
  return registry.register(new RealtimeVoiceSessionAdapter(provider, options));
}
