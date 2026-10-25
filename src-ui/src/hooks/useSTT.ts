/**
 * useSTT — React hook for the active STT provider.
 *
 * Binds to the active STTProvider via useSyncExternalStore so the component
 * re-renders whenever the provider's state changes.
 *
 * Returns a stable API surface regardless of which provider is active.
 *
 * The provider is one per app, but several composers can offer a mic at once
 * (a start composer over the dock's chat). Each hook instance is a dictation
 * owner: the instance that last started listening is the only one that sees
 * the provider's state and transcript. Without that, one dictation landed in
 * every mounted composer's draft.
 */

import type { STTOptions, STTState } from '@kontourai/station-sdk';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import {
  useOptionalVoiceProviderContext,
  useVoiceProviderContext,
} from '../contexts/VoiceProviderContext';

export interface UseSTTResult {
  supported: boolean;
  unsupportedReason?: string;
  errorMessage?: string;
  state: STTState;
  transcript: string;
  startListening: (opts?: STTOptions) => void;
  stopListening: () => void;
}

// No provider: nothing to subscribe to. Local rather than the SDK's export so
// a start surface that offers a mic does not need the SDK's runtime module.
const noopSubscribe = () => () => {};

/** The hook instance whose dictation the provider is serving, if any. */
let dictationOwner: symbol | null = null;

export function useSTT(): UseSTTResult {
  return useSTTFor(useVoiceProviderContext().activeSTT);
}

/** `useSTT` for a surface that may render outside the voice provider. */
export function useOptionalSTT(): UseSTTResult | null {
  const context = useOptionalVoiceProviderContext();
  const result = useSTTFor(context?.activeSTT ?? null);
  return context ? result : null;
}

type ActiveSTT = ReturnType<typeof useVoiceProviderContext>['activeSTT'];

function useSTTFor(activeSTT: ActiveSTT): UseSTTResult {
  const owner = useRef<symbol>(Symbol('stt-owner')).current;

  // Stop the previous provider if it was listening when the active provider changes.
  const prevProviderRef = useRef(activeSTT);
  useEffect(() => {
    const prev = prevProviderRef.current;
    if (prev !== activeSTT) {
      if (prev?.cancelListening) prev.cancelListening();
      else if (prev?.state === 'listening') prev.stopListening();
      prevProviderRef.current = activeSTT;
    }
  }, [activeSTT]);

  // An owner that closes keeps its ownership: the provider holds the last
  // transcript until the next start, and handing it back to everyone would
  // land that dictation in whichever composer is still open. A dictation
  // still running is stopped, for the same reason.
  const activeSTTRef = useRef(activeSTT);
  activeSTTRef.current = activeSTT;
  useEffect(
    () => () => {
      const provider = activeSTTRef.current;
      if (dictationOwner === owner) {
        if (provider?.cancelListening) provider.cancelListening();
        else if (provider?.state === 'listening') provider.stopListening();
      }
    },
    [owner],
  );

  // Another composer's dictation reads as idle with no transcript here.
  const foreign = () => dictationOwner !== null && dictationOwner !== owner;

  const state = useSyncExternalStore(
    activeSTT?.subscribe ?? noopSubscribe,
    () => (foreign() ? 'idle' : (activeSTT?.state ?? 'idle')),
    () => activeSTT?.state ?? 'idle',
  );

  const transcript = useSyncExternalStore(
    activeSTT?.subscribe ?? noopSubscribe,
    () => (foreign() ? '' : (activeSTT?.transcript ?? '')),
    () => activeSTT?.transcript ?? '',
  );

  return {
    supported: activeSTT?.isSupported ?? false,
    unsupportedReason: activeSTT?.unsupportedReason,
    errorMessage: foreign() ? undefined : activeSTT?.errorMessage,
    state,
    transcript,
    // Preserve the direct plugin contract, including STT options that the
    // provider-neutral lifecycle API deliberately does not reinterpret.
    startListening: (opts) => {
      dictationOwner = owner;
      activeSTT?.startListening(opts);
    },
    stopListening: () => activeSTT?.stopListening(),
  };
}
