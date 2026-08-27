/** Provider-neutral contracts for one live voice interaction session. */

export const VOICE_SESSION_LIFECYCLE_STATES = Object.freeze([
  'disconnected',
  'connecting',
  'connected-idle',
  'listening',
  'transcribing',
  'thinking',
  'speaking',
  'stopping',
  'error',
] as const);

export type VoiceSessionLifecycleState =
  (typeof VOICE_SESSION_LIFECYCLE_STATES)[number];

export interface VoiceSessionAdapterDescriptor {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
}

export interface VoiceSessionAdapterCapabilities {
  readonly interrupt?: boolean;
  readonly reconnect?: boolean;
  readonly updateContext?: boolean;
  readonly textTurn?: boolean;
  readonly audioInput?: boolean;
}

export type VoiceSessionOperation =
  | 'start'
  | 'stop'
  | 'interrupt'
  | 'reconnect'
  | 'update-context'
  | 'send-text'
  | 'send-audio';

export type VoiceSessionErrorCode =
  | 'unavailable'
  | 'unsupported'
  | 'unconfigured'
  | 'rate-limited'
  | 'operation-failed';

export class VoiceSessionError extends Error {
  readonly name = 'VoiceSessionError';

  constructor(
    readonly code: VoiceSessionErrorCode,
    message: string,
    readonly operation?: VoiceSessionOperation,
    readonly cause?: unknown,
  ) {
    super(message);
  }
}

export interface VoiceSessionSnapshot {
  readonly state: VoiceSessionLifecycleState;
  /** Monotonic for each adapter or manager projection. */
  readonly revision: number;
  /** Identity of the control connection, distinct from the conversation. */
  readonly controlSessionId?: string;
  /** Identity of the provider conversation, distinct from the control session. */
  readonly conversationSessionId?: string;
  /** Latest provider-normalized transcript for presentation. */
  readonly transcript?: string;
  /** Speaker associated with the normalized transcript. */
  readonly transcriptRole?: 'user' | 'assistant';
  /** Whether the adapter's input is muted, when the provider exposes it. */
  readonly muted?: boolean;
  /** Normalized input level in the inclusive range from zero through one. */
  readonly inputAudioLevel?: number;
  readonly error?: VoiceSessionError;
}

export interface VoiceSessionStartInput {
  readonly controlSessionId?: string;
  readonly conversationSessionId?: string;
  readonly context?: Record<string, unknown>;
}

export interface VoiceSessionContextUpdate {
  readonly [key: string]: unknown;
}

export interface VoiceSessionTextTurn {
  readonly text: string;
}

/** Caller-owned audio input. Implementations must never project its bytes. */
export interface VoiceSessionAudioInput {
  readonly audio: Uint8Array;
}

export type VoiceSessionOperationResult =
  | { readonly ok: true; readonly snapshot: VoiceSessionSnapshot }
  | { readonly ok: false; readonly error: VoiceSessionError };

/**
 * A live adapter instance. Registries own no provider state; they simply make
 * instances available for a manager to select and retain while active.
 */
export interface VoiceSessionAdapter {
  readonly descriptor: VoiceSessionAdapterDescriptor;
  readonly capabilities: VoiceSessionAdapterCapabilities;
  getSnapshot(): VoiceSessionSnapshot;
  subscribe(listener: () => void): () => void;
  start(input?: VoiceSessionStartInput): Promise<VoiceSessionOperationResult>;
  stop(): Promise<VoiceSessionOperationResult>;
  interrupt?(): Promise<VoiceSessionOperationResult>;
  reconnect?(): Promise<VoiceSessionOperationResult>;
  updateContext?(
    input: VoiceSessionContextUpdate,
  ): Promise<VoiceSessionOperationResult>;
  sendText?(input: VoiceSessionTextTurn): Promise<VoiceSessionOperationResult>;
  sendAudio?(
    input: VoiceSessionAudioInput,
  ): Promise<VoiceSessionOperationResult>;
}
