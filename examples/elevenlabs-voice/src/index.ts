import { voiceRegistry } from '@kontourai/station-sdk';
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
  ElevenLabsRealtimeProvider,
  type ElevenLabsRealtimeTransport,
} from './ElevenLabsRealtimeProvider';
import { ElevenLabsSTTProvider } from './ElevenLabsSTTProvider';
import { ElevenLabsTTSProvider } from './ElevenLabsTTSProvider';

interface PluginHostContext {
  readonly apiBase: string;
}

/**
 * The browser plugin host calls this on load and its returned disposer before
 * reload/disable. Realtime registers in an unconfigured state until a
 * credential-safe concrete transport replaces the registration.
 */
export function activate(
  { apiBase }: PluginHostContext,
  realtimeRegistry: VoiceSessionAdapterRegistry = voiceSessionAdapterRegistry,
): () => void {
  const stt = new ElevenLabsSTTProvider(apiBase);
  const tts = new ElevenLabsTTSProvider(apiBase);
  const disposeSTT = voiceRegistry.registerSTT(stt);
  const disposeTTS = voiceRegistry.registerTTS(tts);
  const realtimeRegistration = installElevenLabsRealtimeVoice(
    {
      readiness: async () => ({
        status: 'unconfigured',
        reason: 'missing-configuration',
      }),
      mint: async () => {
        throw new Error('ElevenLabs realtime transport is not configured.');
      },
      open: async () => {
        throw new Error('ElevenLabs realtime transport is not configured.');
      },
    },
    realtimeRegistry,
  );
  return () => {
    realtimeRegistration.dispose();
    stt.stopListening();
    tts.cancel();
    disposeTTS();
    disposeSTT();
  };
}

/** Pack installation is explicit so disabling this pack is a single dispose. */
export function installElevenLabsRealtimeVoice(
  transport: ElevenLabsRealtimeTransport,
  registry: VoiceSessionAdapterRegistry = voiceSessionAdapterRegistry,
  options?: RealtimeVoiceSessionAdapterOptions,
): VoiceSessionAdapterRegistration {
  return registerRealtimeVoiceProvider(
    registry,
    new ElevenLabsRealtimeProvider(transport),
    options,
  );
}

export type { ElevenLabsRealtimeTransport } from './ElevenLabsRealtimeProvider';
export { ElevenLabsRealtimeProvider } from './ElevenLabsRealtimeProvider';
