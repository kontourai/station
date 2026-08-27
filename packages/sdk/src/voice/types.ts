/**
 * Voice provider interfaces for the Station SDK.
 *
 * STTProvider — speech-to-text (press-to-talk, continuous listening)
 * TTSProvider — text-to-speech readback
 * ConversationalVoiceProvider — bidirectional (STT + TTS in one session, e.g. Nova Sonic)
 *
 * All providers implement the useSyncExternalStore subscribe pattern so React
 * can bind to their state without additional wrappers.
 */

export type STTState = 'idle' | 'listening' | 'error';

export interface STTOptions {
  lang?: string;
  continuous?: boolean;
  interimResults?: boolean;
}

export interface TTSOptions {
  lang?: string;
  rate?: number;
  pitch?: number;
  volume?: number;
}

export interface ConversationalOptions {
  lang?: string;
  /** AWS region or other provider-specific routing info */
  region?: string;
}

/** Describes where in the UI a provider option should appear. */
export type VisibleOn = 'all' | 'mobile' | 'desktop';

/** Shape returned by GET /api/system/capabilities for each provider. */
export interface ProviderCapability {
  id: string;
  name: string;
  /** If true, runs entirely in the browser (WebSpeech). No server config needed. */
  clientOnly: boolean;
  /** Which client types surface this option in Settings. clientOnly providers always show on the matching client. */
  visibleOn: VisibleOn[];
  /** Whether the server has valid credentials/API keys for this provider. Always true for clientOnly. */
  configured: boolean;
}

export interface STTProvider {
  readonly id: string;
  readonly name: string;
  readonly isSupported: boolean;
  readonly state: STTState;
  readonly transcript: string;
  startListening(opts?: STTOptions): void;
  stopListening(): void;
  /** useSyncExternalStore-compatible subscribe. Returns unsubscribe fn. */
  subscribe(fn: () => void): () => void;
}

export interface TTSProvider {
  readonly id: string;
  readonly name: string;
  readonly isSupported: boolean;
  readonly speaking: boolean;
  speak(text: string, opts?: TTSOptions): void;
  cancel(): void;
  /** useSyncExternalStore-compatible subscribe. Returns unsubscribe fn. */
  subscribe(fn: () => void): () => void;
}

export type ConversationalSessionState = 'idle' | 'active' | 'error';

export interface ConversationalVoiceProvider extends STTProvider, TTSProvider {
  readonly sessionState: ConversationalSessionState;
  startSession(opts?: ConversationalOptions): void;
  endSession(): void;
}
