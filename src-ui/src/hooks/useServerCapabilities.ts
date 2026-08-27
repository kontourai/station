/**
 * useServerCapabilities — fetches GET /api/system/capabilities on mount and
 * registers server-backed providers into voiceRegistry.
 *
 * Server-backed providers that are `configured: true` get a proxy STT/TTS
 * object registered so VoiceProviderContext can surface them in the UI.
 * Re-fetches when `apiBase` changes (i.e. connection switches).
 */

import type {
  ProviderCapability,
  STTProvider,
  TTSProvider,
} from '@kontourai/station-sdk';
import {
  ListenerManager,
  useServerCapabilitiesQuery,
  voiceRegistry,
} from '@kontourai/station-sdk';
import { useEffect } from 'react';

/** Shared base for server-backed provider stubs. */
function makeStubBase(cap: ProviderCapability) {
  const lm = new ListenerManager();
  return {
    id: cap.id,
    name: cap.name,
    isSupported: cap.configured,
    subscribe: lm.subscribe,
  };
}

/** Minimal stub STTProvider marking a server-backed provider. */
function makeServerSTTStub(cap: ProviderCapability): STTProvider {
  return {
    ...makeStubBase(cap),
    state: 'idle' as const,
    transcript: '',
    startListening() {
      console.warn(
        `[station] STT provider "${cap.id}" requires a plugin bundle to activate`,
      );
    },
    stopListening() {},
  };
}

/** Minimal stub TTSProvider marking a server-backed provider. */
function makeServerTTSStub(cap: ProviderCapability): TTSProvider {
  return {
    ...makeStubBase(cap),
    speaking: false,
    speak() {
      console.warn(
        `[station] TTS provider "${cap.id}" requires a plugin bundle to activate`,
      );
    },
    cancel() {},
  };
}

export function useServerCapabilities(): void {
  const { data, error } = useServerCapabilitiesQuery();

  useEffect(() => {
    for (const cap of data?.voice?.stt ?? []) {
      if (cap.clientOnly) continue;
      if (cap.configured && !voiceRegistry.getSTT(cap.id)) {
        voiceRegistry.registerSTT(makeServerSTTStub(cap));
      }
    }

    for (const cap of data?.voice?.tts ?? []) {
      if (cap.clientOnly) continue;
      if (cap.configured && !voiceRegistry.getTTS(cap.id)) {
        voiceRegistry.registerTTS(makeServerTTSStub(cap));
      }
    }
  }, [data]);

  useEffect(() => {
    if (!error) return;
    console.warn('[station] Failed to fetch /api/system/capabilities:', error);
  }, [error]);
}
