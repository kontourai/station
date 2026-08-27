/**
 * useTTS — React hook for the active TTS provider.
 *
 * Binds to the active TTSProvider via useSyncExternalStore so the component
 * re-renders whenever speaking state changes.
 */

import type { TTSOptions } from '@kontourai/station-sdk';
import { noopSubscribe } from '@kontourai/station-sdk';
import { useSyncExternalStore } from 'react';
import { useVoiceProviderContext } from '../contexts/VoiceProviderContext';

export interface UseTTSResult {
  supported: boolean;
  speaking: boolean;
  speak: (text: string, opts?: TTSOptions) => void;
  cancel: () => void;
}

export function useTTS(): UseTTSResult {
  const { activeTTS, providerVoiceSessionAdapter } = useVoiceProviderContext();

  const speaking = useSyncExternalStore(
    activeTTS?.subscribe ?? noopSubscribe,
    () => activeTTS?.speaking ?? false,
    () => activeTTS?.speaking ?? false,
  );

  return {
    supported: activeTTS?.isSupported ?? false,
    speaking,
    speak: (text, opts) => activeTTS?.speak(text, opts),
    cancel: () => {
      if (providerVoiceSessionAdapter) {
        void providerVoiceSessionAdapter.interrupt();
        return;
      }
      activeTTS?.cancel();
    },
  };
}
