import type {
  VoiceRealtimeConnection,
  VoiceRealtimeLease,
  VoiceRealtimeProvider,
  VoiceRealtimeReadiness,
} from '@kontourai/station-sdk/voice';

export type OpenAIRealtimeConnection = VoiceRealtimeConnection &
  Required<
    Pick<
      VoiceRealtimeConnection,
      'sendText' | 'sendAudio' | 'updateContext' | 'interrupt'
    >
  >;

export interface OpenAIRealtimeCompatibleTransport {
  readiness?(signal?: AbortSignal): Promise<VoiceRealtimeReadiness>;
  mint(
    signal?: AbortSignal,
  ): Promise<{ readonly endpoint: string; readonly expiresAt?: number }>;
  open(
    endpoint: string,
    signal?: AbortSignal,
  ): Promise<OpenAIRealtimeConnection>;
}

/** Compatible-event transport only: no provider SDK is part of Station core. */
export class OpenAIRealtimeProvider implements VoiceRealtimeProvider {
  readonly descriptor = Object.freeze({
    id: 'openai-realtime-compatible',
    name: 'OpenAI-compatible Realtime',
  });
  readonly capabilities = Object.freeze({
    audioInput: true,
    audioOutput: true,
    textTurn: true,
    interrupt: true,
    updateContext: true,
  });

  constructor(private readonly transport: OpenAIRealtimeCompatibleTransport) {}

  async readiness(signal?: AbortSignal): Promise<VoiceRealtimeReadiness> {
    return (
      (await this.transport.readiness?.(signal)) ?? {
        status: 'unconfigured',
        reason: 'missing-configuration',
      }
    );
  }

  async mint(input?: {
    readonly signal?: AbortSignal;
  }): Promise<VoiceRealtimeLease> {
    const authorization = await this.transport.mint(input?.signal);
    return Object.freeze({
      providerId: this.descriptor.id,
      expiresAt: authorization.expiresAt,
      open: (signal?: AbortSignal) =>
        this.transport.open(authorization.endpoint, signal),
    });
  }
}
