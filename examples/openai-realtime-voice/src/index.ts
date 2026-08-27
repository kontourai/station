import type {
  RealtimeVoiceSessionAdapterOptions,
  VoiceSessionAdapterRegistration,
} from '@kontourai/station-sdk/voice';
import {
  registerRealtimeVoiceProvider,
  type VoiceSessionAdapterRegistry,
  voiceSessionAdapterRegistry,
} from '@kontourai/station-sdk/voice';
import {
  type OpenAIRealtimeCompatibleTransport,
  OpenAIRealtimeProvider,
} from './OpenAIRealtimeProvider';

interface PluginHostContext {
  readonly apiBase: string;
}

/** Plugin activation exposes truthful unconfigured discovery until a host transport replaces it. */
export function activate(
  _context: PluginHostContext,
  registry: VoiceSessionAdapterRegistry = voiceSessionAdapterRegistry,
): () => void {
  const registration = installOpenAIRealtimeVoice(
    {
      readiness: async () => ({
        status: 'unconfigured',
        reason: 'missing-configuration',
      }),
      mint: async () => {
        throw new Error('OpenAI realtime transport is not configured.');
      },
      open: async () => {
        throw new Error('OpenAI realtime transport is not configured.');
      },
    },
    registry,
  );
  return () => registration.dispose();
}

export function installOpenAIRealtimeVoice(
  transport: OpenAIRealtimeCompatibleTransport,
  registry: VoiceSessionAdapterRegistry = voiceSessionAdapterRegistry,
  options?: RealtimeVoiceSessionAdapterOptions,
): VoiceSessionAdapterRegistration {
  return registerRealtimeVoiceProvider(
    registry,
    new OpenAIRealtimeProvider(transport),
    options,
  );
}

export type { OpenAIRealtimeCompatibleTransport } from './OpenAIRealtimeProvider';
export { OpenAIRealtimeProvider } from './OpenAIRealtimeProvider';
