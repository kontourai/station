import { voiceRegistry } from '@kontourai/station-sdk';
import { useEffect } from 'react';
import { useApiBase } from '../../contexts/ApiBaseContext';
import { useSurfaceVisibilityFlags } from '../../hooks/useSurfaceVisibilityFlags';
import { LocalSpeechSTTProvider } from './LocalSpeechSTTProvider';

/** Reconcile the registration with live server previews and the selected Station. */
export function useLocalSpeechProvider(): void {
  const flags = useSurfaceVisibilityFlags();
  const enabled = flags.has('local-speech');
  const { apiBase, connectionId } = useApiBase();
  // biome-ignore lint/correctness/useExhaustiveDependencies: A profile switch must discard audio even when both profiles use the same API base.
  useEffect(() => {
    if (!enabled) return;
    const provider = new LocalSpeechSTTProvider(apiBase);
    const unregister = voiceRegistry.registerSTT(provider);
    return () => {
      provider.destroy();
      unregister();
    };
  }, [enabled, apiBase, connectionId]);
}
