/**
 * VoiceProviderContext — app-level context for active STT/TTS provider selection.
 *
 * Subscribes to voiceRegistry via useSyncExternalStore so the component tree
 * re-renders when new providers are registered (e.g. after plugin load).
 *
 * Active provider IDs are persisted via the device-settings store
 * (`sttProvider`/`ttsProvider`, archive#settings-revamp — previously
 * their own raw localStorage keys).
 */

import type { STTProvider, TTSProvider } from '@kontourai/station-sdk';
import { voiceRegistry } from '@kontourai/station-sdk';
import type { ProviderVoiceSessionAdapter } from '@kontourai/station-sdk/voice';
import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
} from 'react';
import { loadStationVoiceSdk } from '../core/pluginSharedRuntime';
import { useServerCapabilities } from '../hooks/useServerCapabilities';
import {
  useDeviceSettings,
  useDeviceSettingsActions,
} from './DeviceSettingsContext';

interface VoiceProviderContextValue {
  availableSTT: STTProvider[];
  availableTTS: TTSProvider[];
  activeSTT: STTProvider | null;
  activeTTS: TTSProvider | null;
  /** Compatibility lifecycle bridge; direct provider methods remain available. */
  providerVoiceSessionAdapter: ProviderVoiceSessionAdapter | null;
  setSTTProvider: (id: string) => void;
  setTTSProvider: (id: string) => void;
}

const VoiceProviderCtx = createContext<VoiceProviderContextValue | null>(null);

// Stable snapshot functions for useSyncExternalStore
function getSTTSnapshot() {
  return voiceRegistry.getAvailableSTT();
}
function getTTSSnapshot() {
  return voiceRegistry.getAvailableTTS();
}

export function VoiceProviderContext({
  children,
}: {
  children: React.ReactNode;
}) {
  // Fetch server capabilities and register server-backed providers
  useServerCapabilities();

  // Subscribe to registry changes — re-renders when providers are added/removed
  const availableSTT = useSyncExternalStore(
    voiceRegistry.subscribe,
    getSTTSnapshot,
    getSTTSnapshot,
  );
  const availableTTS = useSyncExternalStore(
    voiceRegistry.subscribe,
    getTTSSnapshot,
    getTTSSnapshot,
  );

  const { sttProvider: activeSTTId, ttsProvider: activeTTSId } =
    useDeviceSettings();
  const { setDeviceSetting } = useDeviceSettingsActions();

  const setSTTProvider = useCallback(
    (id: string) => setDeviceSetting('sttProvider', id),
    [setDeviceSetting],
  );

  const setTTSProvider = useCallback(
    (id: string) => setDeviceSetting('ttsProvider', id),
    [setDeviceSetting],
  );

  const activeSTT = useMemo(
    () =>
      availableSTT.find((p: STTProvider) => p.id === activeSTTId) ??
      availableSTT[0] ??
      null,
    [availableSTT, activeSTTId],
  );
  const activeTTS = useMemo(
    () =>
      availableTTS.find((p: TTSProvider) => p.id === activeTTSId) ??
      availableTTS[0] ??
      null,
    [availableTTS, activeTTSId],
  );

  const [providerVoiceSessionAdapter, setProviderVoiceSessionAdapter] =
    React.useState<ProviderVoiceSessionAdapter | null>(null);
  React.useEffect(() => {
    // Create from the selected concrete instances inside the effect. This is
    // deliberate: StrictMode's setup/cleanup rehearsal must dispose one
    // throwaway adapter, never the adapter retained by the live tree.
    if (!activeSTT || !activeTTS) {
      setProviderVoiceSessionAdapter(null);
      return;
    }
    let disposed = false;
    let adapter: ProviderVoiceSessionAdapter | null = null;
    setProviderVoiceSessionAdapter(null);
    void loadStationVoiceSdk()
      .then(({ createProviderVoiceSessionAdapter }) => {
        const nextAdapter = createProviderVoiceSessionAdapter(
          activeSTT,
          activeTTS,
        );
        if (disposed) {
          void nextAdapter.dispose();
          return;
        }
        adapter = nextAdapter;
        setProviderVoiceSessionAdapter(nextAdapter);
      })
      .catch(() => {
        // Direct independent providers remain usable if the optional compatibility
        // chunk cannot be loaded; avoid surfacing a rejected import globally.
        if (!disposed) setProviderVoiceSessionAdapter(null);
      });
    return () => {
      disposed = true;
      void adapter?.dispose();
    };
  }, [activeSTT, activeTTS]);

  const value = useMemo(
    () => ({
      availableSTT,
      availableTTS,
      activeSTT,
      activeTTS,
      providerVoiceSessionAdapter,
      setSTTProvider,
      setTTSProvider,
    }),
    [
      availableSTT,
      availableTTS,
      activeSTT,
      activeTTS,
      providerVoiceSessionAdapter,
      setSTTProvider,
      setTTSProvider,
    ],
  );

  return (
    <VoiceProviderCtx.Provider value={value}>
      {children}
    </VoiceProviderCtx.Provider>
  );
}

export function useVoiceProviderContext(): VoiceProviderContextValue {
  const ctx = useContext(VoiceProviderCtx);
  if (!ctx)
    throw new Error(
      'useVoiceProviderContext must be used within VoiceProviderContext',
    );
  return ctx;
}
