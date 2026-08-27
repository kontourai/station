/**
 * useSTT — React hook for the active STT provider.
 *
 * Binds to the active STTProvider via useSyncExternalStore so the component
 * re-renders whenever the provider's state changes.
 *
 * Returns a stable API surface regardless of which provider is active.
 */

import type { STTOptions, STTState } from '@kontourai/station-sdk';
import { noopSubscribe } from '@kontourai/station-sdk';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useVoiceProviderContext } from '../contexts/VoiceProviderContext';

export interface UseSTTResult {
  supported: boolean;
  state: STTState;
  transcript: string;
  startListening: (opts?: STTOptions) => void;
  stopListening: () => void;
}

export function useSTT(): UseSTTResult {
  const { activeSTT } = useVoiceProviderContext();

  // Stop the previous provider if it was listening when the active provider changes.
  const prevProviderRef = useRef(activeSTT);
  useEffect(() => {
    const prev = prevProviderRef.current;
    if (prev !== activeSTT) {
      if (prev?.state === 'listening') prev.stopListening();
      prevProviderRef.current = activeSTT;
    }
  }, [activeSTT]);

  const state = useSyncExternalStore(
    activeSTT?.subscribe ?? noopSubscribe,
    () => activeSTT?.state ?? 'idle',
    () => activeSTT?.state ?? 'idle',
  );

  const transcript = useSyncExternalStore(
    activeSTT?.subscribe ?? noopSubscribe,
    () => activeSTT?.transcript ?? '',
    () => activeSTT?.transcript ?? '',
  );

  return {
    supported: activeSTT?.isSupported ?? false,
    state,
    transcript,
    // Preserve the direct plugin contract, including STT options that the
    // provider-neutral lifecycle API deliberately does not reinterpret.
    startListening: (opts) => activeSTT?.startListening(opts),
    stopListening: () => activeSTT?.stopListening(),
  };
}
