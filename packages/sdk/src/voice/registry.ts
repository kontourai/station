/**
 * voiceRegistry — module-level singleton for STT/TTS provider registration.
 *
 * Plugins call voiceRegistry.registerSTT() / registerTTS() from their bundle
 * on load. React contexts subscribe to registry changes via subscribe().
 *
 * No React dependency — pure module singleton.
 */
import { ListenerManager } from '../core/ListenerManager.js';
import type { STTProvider, TTSProvider } from './types.js';

class VoiceRegistry extends ListenerManager {
  private _stt = new Map<string, STTProvider>();
  private _tts = new Map<string, TTSProvider>();
  private _cachedSTT: STTProvider[] = [];
  private _cachedTTS: TTSProvider[] = [];

  registerSTT(provider: STTProvider): () => void {
    this._stt.set(provider.id, provider);
    this._cachedSTT = Array.from(this._stt.values());
    this._notify();
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      if (this._stt.get(provider.id) !== provider) return;
      this._stt.delete(provider.id);
      this._cachedSTT = Array.from(this._stt.values());
      this._notify();
    };
  }

  registerTTS(provider: TTSProvider): () => void {
    this._tts.set(provider.id, provider);
    this._cachedTTS = Array.from(this._tts.values());
    this._notify();
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      if (this._tts.get(provider.id) !== provider) return;
      this._tts.delete(provider.id);
      this._cachedTTS = Array.from(this._tts.values());
      this._notify();
    };
  }

  unregisterSTT(id: string): void {
    if (this._stt.delete(id)) {
      this._cachedSTT = Array.from(this._stt.values());
      this._notify();
    }
  }

  unregisterTTS(id: string): void {
    if (this._tts.delete(id)) {
      this._cachedTTS = Array.from(this._tts.values());
      this._notify();
    }
  }

  getAvailableSTT(): STTProvider[] {
    return this._cachedSTT;
  }

  getAvailableTTS(): TTSProvider[] {
    return this._cachedTTS;
  }

  getSTT(id: string): STTProvider | undefined {
    return this._stt.get(id);
  }

  getTTS(id: string): TTSProvider | undefined {
    return this._tts.get(id);
  }
}

export const voiceRegistry = new VoiceRegistry();
