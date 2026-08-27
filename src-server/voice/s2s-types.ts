import { EventEmitter } from 'node:events';
import type { VoiceSessionLifecycleState } from '@kontourai/station-sdk/voice';

export type S2SAudioFormat = {
  mediaType: string;
  sampleRateHertz: number;
  sampleSizeBits: number;
  channelCount: number;
  encoding: 'base64' | 'raw';
};

export type S2SToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type S2SSessionConfig = {
  systemPrompt: string;
  tools: S2SToolDefinition[];
  voice?: string;
  inputAudio?: Partial<S2SAudioFormat>;
  outputAudio?: Partial<S2SAudioFormat>;
};

export type S2STranscript = {
  text: string;
  role: 'user' | 'assistant';
  stage: 'speculative' | 'final';
};

export type S2SToolUseEvent = {
  toolName: string;
  toolUseId: string;
  parameters: Record<string, unknown>;
};

/**
 * Optional v1 provider fact for a completed speech response.  The identifier
 * is issued by the provider, never by Station or the WebSocket client.  A
 * provider that cannot prove this identity continues to implement the base
 * S2S contract, but is deliberately not eligible for durable turn/run
 * attribution.
 */
export type S2SCorrelatedTurn = {
  /** Opaque provider completion identity, unique within its provider session. */
  providerTurnId: string;
  /** Provider session identity carried with the same response envelope. */
  providerSessionId: string;
  /** Provider prompt identity carried by every correlated envelope. */
  providerPromptId: string;
};

export type S2SCorrelatedToolUseEvent = S2SToolUseEvent &
  S2SCorrelatedTurn & {
    /** Content envelope that carried the tool fact; never inferred locally. */
    providerContentId: string;
  };

export type S2SCorrelatedTurnEnd = S2SCorrelatedTurn & {
  stopReason: string;
};

/**
 * Capability version marker.  It is additive so older S2S providers and
 * extensions keep their original event contract and simply remain
 * unattributed.
 */
export interface S2SCorrelatedTurnsV1 {
  readonly correlatedTurnsVersion: 1;
  /** Stable provider identity projected on attributed runs. */
  readonly correlatedTurnsProviderId: string;
}

export function supportsS2SCorrelatedTurnsV1(
  provider: IS2SProvider,
): provider is IS2SProvider & S2SCorrelatedTurnsV1 {
  return (
    (provider as Partial<S2SCorrelatedTurnsV1>).correlatedTurnsVersion === 1 &&
    typeof (provider as Partial<S2SCorrelatedTurnsV1>)
      .correlatedTurnsProviderId === 'string' &&
    (
      provider as Partial<S2SCorrelatedTurnsV1>
    ).correlatedTurnsProviderId!.trim().length > 0
  );
}

export type S2SProviderState =
  | 'disconnected'
  | 'connecting'
  | 'idle'
  | 'listening'
  | 'processing'
  | 'speaking';

export type S2SEventMap = {
  audio: (chunk: Buffer) => void;
  transcript: (t: S2STranscript) => void;
  toolUse: (e: S2SToolUseEvent) => void;
  turnStart: () => void;
  turnEnd: () => void;
  correlatedTurnStart: (turn: S2SCorrelatedTurn) => void;
  correlatedTurnEnd: (turn: S2SCorrelatedTurnEnd) => void;
  correlatedToolUse: (event: S2SCorrelatedToolUseEvent) => void;
  stateChange: (state: S2SProviderState) => void;
  error: (err: Error) => void;
};

export interface IS2SProvider extends EventEmitter {
  connect(config: S2SSessionConfig): Promise<S2SAudioFormat>;
  sendAudio(chunk: Buffer): void;
  sendToolResult(toolUseId: string, result: string): void;
  disconnect(): Promise<void>;
  readonly state: S2SProviderState;
  readonly outputAudioFormat: S2SAudioFormat;

  on<K extends keyof S2SEventMap>(event: K, listener: S2SEventMap[K]): this;
  off<K extends keyof S2SEventMap>(event: K, listener: S2SEventMap[K]): this;
  once<K extends keyof S2SEventMap>(event: K, listener: S2SEventMap[K]): this;
}

export type VoiceWsMessage =
  | { type: 'audio_in'; data: string }
  | { type: 'audio_out'; data: string }
  | {
      type: 'transcript';
      text: string;
      role: 'user' | 'assistant';
      stage: 'speculative' | 'final';
    }
  | { type: 'state'; state: VoiceSessionLifecycleState }
  | { type: 'error'; message: string }
  | {
      type: 'session_ready';
      inputAudioFormat: S2SAudioFormat;
      outputAudioFormat: S2SAudioFormat;
    };
