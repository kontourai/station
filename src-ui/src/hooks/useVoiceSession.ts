import {
  VoiceSessionAdapterRegistry,
  VoiceSessionManager,
  type VoiceSessionSnapshot,
} from '@kontourai/station-sdk/voice';
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { useApiBase } from '../contexts/ApiBaseContext';
import {
  createNovaVoiceSessionAdapterDependencies,
  NovaVoiceSessionAdapter,
} from '../providers/voice/NovaVoiceSessionAdapter';

type VoiceState = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking';

export interface UseVoiceSessionResult {
  state: VoiceState;
  transcript: string;
  transcriptRole: 'user' | 'assistant' | null;
  connect: () => Promise<void>;
  disconnect: () => void;
  isMuted: boolean;
  toggleMute: () => void;
  error: string | null;
  /** Mic input level 0–1, updated per audio frame. Use for visualization. */
  audioLevel: number;
}

interface NovaSessionBinding {
  readonly adapter: NovaVoiceSessionAdapter;
  readonly manager: VoiceSessionManager;
  readonly disposeRegistration: () => void;
  cleanupGeneration: number;
}

function createNovaSessionBinding(
  apiBase: string,
  credentialProvider: ReturnType<typeof useApiBase>['credentialProvider'],
): NovaSessionBinding {
  const adapter = new NovaVoiceSessionAdapter(
    createNovaVoiceSessionAdapterDependencies(apiBase, credentialProvider),
  );
  const registry = new VoiceSessionAdapterRegistry();
  const registration = registry.register(adapter);
  const manager = new VoiceSessionManager(registry);
  manager.select(adapter.descriptor.id);
  return {
    adapter,
    manager,
    disposeRegistration: registration.dispose,
    cleanupGeneration: 0,
  };
}

function projectState(snapshot: VoiceSessionSnapshot): VoiceState {
  switch (snapshot.state) {
    case 'connecting':
      return 'connecting';
    case 'listening':
      return 'listening';
    case 'thinking':
    case 'transcribing':
      return 'thinking';
    case 'speaking':
      return 'speaking';
    default:
      // `connected-idle`, `disconnected`, terminal errors, and stopping all
      // retain the old UI's inactive presentation.
      return 'idle';
  }
}

/**
 * React projection and commands for one Nova browser adapter. It deliberately
 * owns no websocket, microphone, or playback state: that lifecycle belongs to
 * NovaVoiceSessionAdapter and is serialized by VoiceSessionManager.
 */
export function useVoiceSession(): UseVoiceSessionResult {
  const { apiBase, credentialProvider } = useApiBase();
  const binding = useMemo(
    () => createNovaSessionBinding(apiBase, credentialProvider),
    [apiBase, credentialProvider],
  );
  const snapshot = useSyncExternalStore(
    binding.manager.subscribe,
    () => binding.manager.getSnapshot(),
    () => binding.manager.getSnapshot(),
  );

  useEffect(() => {
    // StrictMode rehearses an effect cleanup before it installs the live
    // effect. Deferring disposal by one microtask gives that installation a
    // chance to invalidate the rehearsal token without leaking real unmounts.
    binding.cleanupGeneration += 1;
    return () => {
      const cleanupGeneration = ++binding.cleanupGeneration;
      queueMicrotask(() => {
        if (binding.cleanupGeneration !== cleanupGeneration) return;
        binding.disposeRegistration();
        void binding.manager.dispose();
      });
    };
  }, [binding]);

  const connect = useCallback(async () => {
    // A remote close is a terminal adapter event, not an active manager
    // session. Retire that manager entry before selecting the fresh adapter
    // start intent so reconnect owns a new socket/audio lifecycle.
    if (
      binding.manager.getSnapshot().state === 'error' ||
      binding.manager.getSnapshot().state === 'disconnected'
    ) {
      await binding.manager.stop();
    }
    await binding.manager.start();
  }, [binding]);
  const disconnect = useCallback(() => {
    void binding.manager.stop();
  }, [binding]);
  const toggleMute = useCallback(() => {
    binding.adapter.toggleMuted();
  }, [binding]);

  return {
    state: projectState(snapshot),
    transcript: snapshot.transcript ?? '',
    transcriptRole: snapshot.transcriptRole ?? null,
    connect,
    disconnect,
    isMuted: snapshot.muted ?? false,
    toggleMute,
    error: snapshot.error?.message ?? null,
    audioLevel: snapshot.inputAudioLevel ?? 0,
  };
}
