/**
 * useRegisteredSTT — speech-to-text through the published SDK surface.
 *
 * Plugins reach STT providers through `voiceRegistry`, where voice plugins
 * register them. The SDK does not expose which provider the person selected
 * in Station's voice settings: that choice lives in the host UI (its internal
 * `useSTT` hook), outside the plugin boundary. This hook therefore uses the
 * first registered provider that reports itself supported.
 */

import {
  type STTOptions,
  type STTProvider,
  type STTState,
  voiceRegistry,
} from '@kontourai/station-sdk';
import { useCallback, useSyncExternalStore } from 'react';

export interface RegisteredSTT {
  /** False when no registered provider can listen in this browser. */
  supported: boolean;
  state: STTState;
  transcript: string;
  startListening: (opts?: STTOptions) => void;
  stopListening: () => void;
}

function firstSupportedSTT(): STTProvider | undefined {
  return voiceRegistry.getAvailableSTT().find((p) => p.isSupported);
}

export function useRegisteredSTT(): RegisteredSTT {
  const provider = useSyncExternalStore(
    voiceRegistry.subscribe,
    firstSupportedSTT,
    firstSupportedSTT,
  );
  const subscribe = useCallback(
    (onChange: () => void) =>
      provider ? provider.subscribe(onChange) : () => {},
    [provider],
  );
  const state = useSyncExternalStore(
    subscribe,
    () => provider?.state ?? 'idle',
    () => provider?.state ?? 'idle',
  );
  const transcript = useSyncExternalStore(
    subscribe,
    () => provider?.transcript ?? '',
    () => provider?.transcript ?? '',
  );
  const startListening = useCallback(
    (opts?: STTOptions) => provider?.startListening(opts),
    [provider],
  );
  const stopListening = useCallback(
    () => provider?.stopListening(),
    [provider],
  );

  return {
    supported: provider !== undefined,
    state,
    transcript,
    startListening,
    stopListening,
  };
}
