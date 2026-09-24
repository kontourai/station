/**
 * Nova Sonic Voice plugin — client bundle entry point.
 *
 * The browser plugin host calls `activate` when the bundle loads and the
 * disposer it returns before reload or disable (#2401: the bundle used to
 * register at import time, reading an undeclared `station` global).
 */
import { voiceRegistry } from '@kontourai/station-sdk';
import { NovaSonicProvider } from './NovaSonicProvider';

interface PluginHostContext {
  readonly apiBase: string;
}

export function activate({ apiBase }: PluginHostContext): () => void {
  const disposeSTT = voiceRegistry.registerSTT(new NovaSonicProvider(apiBase));
  // NovaSonicProvider also implements TTSProvider (same session).
  const disposeTTS = voiceRegistry.registerTTS(new NovaSonicProvider(apiBase));
  return () => {
    disposeTTS();
    disposeSTT();
  };
}
