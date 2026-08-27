import { EventEmitter } from 'node:events';
import type {
  VoiceRealtimeConnection,
  VoiceRealtimeEvent,
  VoiceRealtimeLease,
  VoiceRealtimeProvider,
  VoiceRealtimeReadiness,
} from '@kontourai/station-sdk/voice';
import type {
  IS2SProvider,
  S2SSessionConfig,
  S2STranscript,
} from '../s2s-types.js';

export type S2SRealtimeProviderFactory = () => IS2SProvider;

/** Server-only Nova bridge; AWS SDK construction remains in provider code. */
export function createS2SRealtimeProvider(
  factory: S2SRealtimeProviderFactory,
  config: S2SSessionConfig,
  readiness?: (signal?: AbortSignal) => Promise<VoiceRealtimeReadiness>,
): VoiceRealtimeProvider {
  return Object.freeze({
    descriptor: Object.freeze({
      id: 'nova-s2s',
      name: 'Nova speech-to-speech',
      description: 'Station server speech-to-speech session',
    }),
    capabilities: Object.freeze({ audioInput: true, audioOutput: true }),
    // A bridge cannot infer provider availability from construction alone.
    // Callers must supply a probe; otherwise the truthful state is unconfigured.
    readiness: async (signal?: AbortSignal): Promise<VoiceRealtimeReadiness> =>
      readiness?.(signal) ?? {
        status: 'unconfigured' as const,
        reason: 'missing-configuration' as const,
      },
    mint: async (): Promise<VoiceRealtimeLease> => {
      const provider = factory();
      return Object.freeze({
        providerId: 'nova-s2s',
        open: async () => openS2SConnection(provider, config),
      });
    },
  });
}

async function openS2SConnection(
  provider: IS2SProvider,
  config: S2SSessionConfig,
): Promise<VoiceRealtimeConnection> {
  await provider.connect(config);
  const emitter = new EventEmitter();
  const onAudio = (audio: Buffer) =>
    emitter.emit('event', { type: 'speech', audio: new Uint8Array(audio) });
  const onTranscript = (transcript: S2STranscript) =>
    emitter.emit('event', {
      type: 'transcript',
      text: transcript.text,
      role: transcript.role,
    });
  const onState = (state: string) =>
    emitter.emit('event', {
      type: 'state',
      state:
        state === 'idle'
          ? 'connected-idle'
          : state === 'processing'
            ? 'thinking'
            : state,
    });
  const onError = () =>
    emitter.emit('event', { type: 'error', code: 'unavailable' });
  provider.on('audio', onAudio);
  provider.on('transcript', onTranscript);
  provider.on('stateChange', onState as never);
  provider.on('error', onError);
  let closed = false;
  let listenersDetached = false;
  return {
    subscribe(listener: (event: VoiceRealtimeEvent) => void) {
      emitter.on('event', listener);
      return () => emitter.off('event', listener);
    },
    async sendAudio(audio: Uint8Array) {
      provider.sendAudio(Buffer.from(audio));
    },
    async close() {
      if (closed) return;
      if (!listenersDetached) {
        listenersDetached = true;
        provider.off('audio', onAudio);
        provider.off('transcript', onTranscript);
        provider.off('stateChange', onState as never);
        provider.off('error', onError);
      }
      await provider.disconnect();
      closed = true;
    },
  };
}
