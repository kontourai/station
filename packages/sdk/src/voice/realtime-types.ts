import type {
  VoiceSessionAdapterCapabilities,
  VoiceSessionAdapterDescriptor,
  VoiceSessionContextUpdate,
  VoiceSessionLifecycleState,
  VoiceSessionTextTurn,
} from './session-types.js';

/** Public, content-free result of a realtime provider capability probe. */
export type VoiceRealtimeReadiness =
  | { readonly status: 'ready' }
  | {
      readonly status: 'unsupported';
      readonly reason: 'browser-unsupported' | 'provider-unsupported';
    }
  | {
      readonly status: 'unconfigured';
      readonly reason: 'missing-configuration';
    }
  | {
      readonly status: 'unavailable';
      readonly reason: 'network-unavailable' | 'service-unavailable';
    }
  | {
      readonly status: 'rate-limited';
      readonly reason: 'provider-rate-limited';
      readonly retryAt?: number;
    };

export interface VoiceRealtimeCapabilities
  extends VoiceSessionAdapterCapabilities {
  readonly audioInput?: boolean;
  readonly audioOutput?: boolean;
}

export interface VoiceRealtimeUsage {
  readonly inputAudioMs?: number;
  readonly outputAudioMs?: number;
}

export type VoiceRealtimeEvent =
  | { readonly type: 'state'; readonly state: VoiceSessionLifecycleState }
  | { readonly type: 'speech'; readonly audio: Uint8Array }
  | {
      readonly type: 'transcript';
      readonly text: string;
      readonly role: 'user' | 'assistant';
    }
  | ({ readonly type: 'usage' } & VoiceRealtimeUsage)
  | { readonly type: 'disconnect' }
  | {
      readonly type: 'error';
      readonly code?: Exclude<VoiceRealtimeReadiness['status'], 'ready'>;
    };

/**
 * A provider connection deliberately contains no provider session identifier
 * or authorization material. Those stay inside the provider-pack closure.
 */
export interface VoiceRealtimeConnection {
  subscribe(listener: (event: VoiceRealtimeEvent) => void): () => void;
  sendText?(input: VoiceSessionTextTurn): Promise<void>;
  sendAudio?(audio: Uint8Array): Promise<void>;
  updateContext?(input: VoiceSessionContextUpdate): Promise<void>;
  interrupt?(): Promise<void>;
  close(): Promise<void>;
}

export interface VoiceRealtimeLease {
  /** Provider name only; never a provider session, token, or signed URL. */
  readonly providerId: string;
  /** Optional safe expiry metadata for UI retry decisions. */
  readonly expiresAt?: number;
  /** The provider pack closes over authorization until this operation runs. */
  open(signal?: AbortSignal): Promise<VoiceRealtimeConnection>;
}

export interface VoiceRealtimeMintInput {
  readonly signal?: AbortSignal;
  /** Immutable caller context is passed transiently and never projected. */
  readonly context?: Readonly<Record<string, unknown>>;
}

export interface VoiceRealtimeProvider {
  readonly descriptor: VoiceSessionAdapterDescriptor;
  readonly capabilities: VoiceRealtimeCapabilities;
  readiness(signal?: AbortSignal): Promise<VoiceRealtimeReadiness>;
  mint(input?: VoiceRealtimeMintInput): Promise<VoiceRealtimeLease>;
}
