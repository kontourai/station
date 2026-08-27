import { afterEach, describe, expect, it, vi } from 'vitest';
import { voiceRegistry } from '../voice/registry.js';
import type { STTProvider, TTSProvider } from '../voice/types.js';

// Minimal stub providers
function makeSTT(id: string): STTProvider {
  return {
    id,
    name: `STT ${id}`,
    isSupported: true,
    state: 'idle',
    transcript: '',
    startListening: vi.fn(),
    stopListening: vi.fn(),
    subscribe: vi.fn(() => () => {}),
  };
}

function makeTTS(id: string): TTSProvider {
  return {
    id,
    name: `TTS ${id}`,
    isSupported: true,
    speaking: false,
    speak: vi.fn(),
    cancel: vi.fn(),
    subscribe: vi.fn(() => () => {}),
  };
}

describe('voiceRegistry', () => {
  // Clean up after each test so tests don't bleed state into each other
  afterEach(() => {
    for (const p of voiceRegistry.getAvailableSTT())
      voiceRegistry.unregisterSTT(p.id);
    for (const p of voiceRegistry.getAvailableTTS())
      voiceRegistry.unregisterTTS(p.id);
  });

  describe('STT registration', () => {
    it('registers and retrieves an STT provider', () => {
      const p = makeSTT('test-stt');
      voiceRegistry.registerSTT(p);
      expect(voiceRegistry.getSTT('test-stt')).toBe(p);
    });

    it('getAvailableSTT returns all registered STT providers', () => {
      const a = makeSTT('a');
      const b = makeSTT('b');
      voiceRegistry.registerSTT(a);
      voiceRegistry.registerSTT(b);
      const ids = voiceRegistry.getAvailableSTT().map((p) => p.id);
      expect(ids).toContain('a');
      expect(ids).toContain('b');
    });

    it('unregisters an STT provider', () => {
      const p = makeSTT('rm-stt');
      voiceRegistry.registerSTT(p);
      voiceRegistry.unregisterSTT('rm-stt');
      expect(voiceRegistry.getSTT('rm-stt')).toBeUndefined();
    });

    it('re-registering same id replaces the provider', () => {
      const a = makeSTT('dup');
      const b = { ...makeSTT('dup'), name: 'Replaced' };
      voiceRegistry.registerSTT(a);
      voiceRegistry.registerSTT(b);
      expect(voiceRegistry.getSTT('dup')?.name).toBe('Replaced');
      expect(
        voiceRegistry.getAvailableSTT().filter((p) => p.id === 'dup'),
      ).toHaveLength(1);
    });

    it('disposes only the exact STT registration it created', () => {
      const first = makeSTT('owned-stt');
      const replacement = { ...makeSTT('owned-stt'), name: 'Replacement' };
      const disposeFirst = voiceRegistry.registerSTT(first);
      voiceRegistry.registerSTT(replacement);

      disposeFirst();
      disposeFirst();

      expect(voiceRegistry.getSTT('owned-stt')).toBe(replacement);
    });
  });

  describe('TTS registration', () => {
    it('registers and retrieves a TTS provider', () => {
      const p = makeTTS('test-tts');
      voiceRegistry.registerTTS(p);
      expect(voiceRegistry.getTTS('test-tts')).toBe(p);
    });

    it('unregisters a TTS provider', () => {
      const p = makeTTS('rm-tts');
      voiceRegistry.registerTTS(p);
      voiceRegistry.unregisterTTS('rm-tts');
      expect(voiceRegistry.getTTS('rm-tts')).toBeUndefined();
    });

    it('disposes only the exact TTS registration it created', () => {
      const first = makeTTS('owned-tts');
      const replacement = { ...makeTTS('owned-tts'), name: 'Replacement' };
      const disposeFirst = voiceRegistry.registerTTS(first);
      voiceRegistry.registerTTS(replacement);

      disposeFirst();

      expect(voiceRegistry.getTTS('owned-tts')).toBe(replacement);
    });
  });

  describe('subscribe notifications', () => {
    it('notifies subscribers on STT registration', () => {
      const listener = vi.fn();
      const unsub = voiceRegistry.subscribe(listener);
      voiceRegistry.registerSTT(makeSTT('notify-test'));
      expect(listener).toHaveBeenCalledTimes(1);
      unsub();
    });

    it('notifies subscribers on STT unregistration', () => {
      voiceRegistry.registerSTT(makeSTT('unsub-test'));
      const listener = vi.fn();
      const unsub = voiceRegistry.subscribe(listener);
      voiceRegistry.unregisterSTT('unsub-test');
      expect(listener).toHaveBeenCalledTimes(1);
      unsub();
    });

    it('does NOT notify when unregistering a non-existent id', () => {
      const listener = vi.fn();
      const unsub = voiceRegistry.subscribe(listener);
      voiceRegistry.unregisterSTT('does-not-exist');
      expect(listener).not.toHaveBeenCalled();
      unsub();
    });

    it('unsubscribed listener is not called', () => {
      const listener = vi.fn();
      const unsub = voiceRegistry.subscribe(listener);
      unsub();
      voiceRegistry.registerSTT(makeSTT('after-unsub'));
      expect(listener).not.toHaveBeenCalled();
    });
  });
});
