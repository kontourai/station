/** Provider-neutral replaceable components used by composed voice sessions. */

export interface VoiceComponentDescriptor {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
}

/**
 * Input epochs increase monotonically between endpoint-detector resets.
 * Adapters may emit many interim events followed by at most one final event.
 */
export type VoiceInputEvent =
  | Readonly<{ type: 'interim'; epoch: number; transcript: string }>
  | Readonly<{ type: 'final'; epoch: number; transcript: string }>
  | Readonly<{ type: 'error'; epoch: number; error: Error }>;

export interface VoiceInputAdapter {
  readonly descriptor: VoiceComponentDescriptor;
  subscribe(listener: (event: VoiceInputEvent) => void): () => void;
  start(signal: AbortSignal): Promise<void>;
  stop(signal: AbortSignal): Promise<void>;
  /** Releases subscriptions owned by this adapter. Safe to call repeatedly. */
  dispose?(): void | Promise<void>;
}

export interface VoiceEndpointUtterance {
  readonly epoch: number;
  readonly transcript: string;
}

export interface VoiceEndpointDetector {
  readonly descriptor: VoiceComponentDescriptor;
  /** Consumes monotonically increasing input epochs at most once. */
  consume(event: VoiceInputEvent): VoiceEndpointUtterance | undefined;
  reset(): void;
}

export type VoiceAudioCaptureEvent =
  | Readonly<{ type: 'audio'; epoch: number; audio: Uint8Array }>
  | Readonly<{ type: 'error'; epoch: number; error: Error }>;

export interface VoiceAudioCaptureAdapter {
  readonly descriptor: VoiceComponentDescriptor;
  subscribe(listener: (event: VoiceAudioCaptureEvent) => void): () => void;
  start(signal: AbortSignal): Promise<void>;
  stop(signal: AbortSignal): Promise<void>;
}

export interface VoiceTranscriptionAdapter {
  readonly descriptor: VoiceComponentDescriptor;
  transcribe(audio: Uint8Array, signal: AbortSignal): Promise<string>;
}

export interface VoiceAgentTurnInput {
  readonly text: string;
  readonly context: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal;
}

export interface VoiceAgentTurnAdapter {
  readonly descriptor: VoiceComponentDescriptor;
  run(input: VoiceAgentTurnInput): AsyncIterable<string>;
}

export interface VoiceAudioChunk {
  readonly data: Uint8Array;
  readonly format: string;
}

export interface VoiceSynthesisInput {
  readonly text: string;
  readonly signal: AbortSignal;
}

export interface VoiceSynthesisAdapter {
  readonly descriptor: VoiceComponentDescriptor;
  synthesize(input: VoiceSynthesisInput): AsyncIterable<VoiceAudioChunk>;
}

export interface VoicePlaybackAdapter {
  readonly descriptor: VoiceComponentDescriptor;
  play(chunk: VoiceAudioChunk, signal: AbortSignal): Promise<void>;
  stop(signal: AbortSignal): Promise<void>;
}

export type VoiceTurnTelemetryEvent =
  | Readonly<{
      type: 'transcript-final';
      durationMs: number;
      attributes:
        | Readonly<{ inputSource: 'speech'; inputComponentId: string }>
        | Readonly<{ inputSource: 'text' }>;
    }>
  | Readonly<{
      type: 'first-token';
      durationMs: number;
      attributes: Readonly<{ agentComponentId: string }>;
    }>
  | Readonly<{
      type: 'first-audio';
      durationMs: number;
      attributes: Readonly<{
        synthesisComponentId: string;
        playbackComponentId: string;
      }>;
    }>
  | Readonly<{
      type: 'turn-complete';
      durationMs: number;
      attributes: Readonly<{
        outcome: 'completed' | 'failed' | 'interrupted';
      }>;
    }>
  | Readonly<{
      type: 'secondary';
      durationMs: number;
      attributes: Readonly<{
        role: 'input' | 'agent' | 'synthesis' | 'playback';
        failedComponentId: string;
        secondaryComponentId: string;
        reasonCode: string;
      }>;
    }>;

export type VoiceTurnTelemetrySink = (event: VoiceTurnTelemetryEvent) => void;

export interface VoiceRoleComponents<TComponent> {
  readonly primary: TComponent;
  readonly secondary?: TComponent;
}
