import { describe, expect, it, vi } from 'vitest';
import {
  createProviderVoiceSessionAdapter,
  type VoiceSessionAdapter,
} from '../voice/session.js';
import type { STTProvider, STTState, TTSProvider } from '../voice/types.js';

interface MutableSTT {
  readonly provider: STTProvider;
  emit(state: STTState, transcript?: string): void;
}

interface MutableTTS {
  readonly provider: TTSProvider;
}

function makeSTT(options?: { readonly startThrows?: Error }): MutableSTT {
  const listeners = new Set<() => void>();
  let state: STTState = 'idle';
  let transcript = '';
  const notify = () => listeners.forEach((listener) => listener());
  const provider: STTProvider = {
    id: 'provider-stt',
    name: 'Provider STT',
    isSupported: true,
    get state() {
      return state;
    },
    get transcript() {
      return transcript;
    },
    startListening: vi.fn(() => {
      if (options?.startThrows) throw options.startThrows;
      state = 'listening';
      notify();
    }),
    stopListening: vi.fn(() => {
      state = 'idle';
      notify();
    }),
    subscribe: vi.fn((listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  };

  return {
    provider,
    emit(nextState, nextTranscript = transcript) {
      state = nextState;
      transcript = nextTranscript;
      notify();
    },
  };
}

function makeTTS(): MutableTTS {
  const listeners = new Set<() => void>();
  let speaking = false;
  const notify = () => listeners.forEach((listener) => listener());
  return {
    provider: {
      id: 'provider-tts',
      name: 'Provider TTS',
      isSupported: true,
      get speaking() {
        return speaking;
      },
      speak: vi.fn(() => {
        speaking = true;
        notify();
      }),
      cancel: vi.fn(() => {
        speaking = false;
        notify();
      }),
      subscribe: vi.fn((listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
    },
  };
}

describe('ProviderVoiceSessionAdapter', () => {
  it('controls STT and publishes frozen, monotonic transcript snapshots', async () => {
    const stt = makeSTT();
    const tts = makeTTS();
    const adapter = createProviderVoiceSessionAdapter(
      stt.provider,
      tts.provider,
    );
    expect(adapter.descriptor).toEqual({
      id: 'provider-composed',
      name: 'Provider-composed voice session',
      description: 'Composes independent STT and TTS providers.',
    });
    const revisions = [adapter.getSnapshot().revision];
    const unsubscribe = adapter.subscribe(() => {
      revisions.push(adapter.getSnapshot().revision);
    });

    const started = await adapter.start({
      controlSessionId: 'control-1',
      conversationSessionId: 'conversation-1',
    });
    stt.emit('listening', 'Dictated text');

    expect(started).toMatchObject({ ok: true });
    expect(stt.provider.startListening).toHaveBeenCalledOnce();
    expect(adapter.getSnapshot()).toMatchObject({
      state: 'listening',
      controlSessionId: 'control-1',
      conversationSessionId: 'conversation-1',
      transcript: 'Dictated text',
      transcriptRole: 'user',
    });
    expect(Object.isFrozen(adapter.getSnapshot())).toBe(true);
    expect(
      revisions.every(
        (revision, index) => index === 0 || revision > revisions[index - 1],
      ),
    ).toBe(true);

    unsubscribe();
  });

  it('projects direct provider speak and cancel without exposing sendText', async () => {
    const stt = makeSTT();
    const tts = makeTTS();
    const adapter = createProviderVoiceSessionAdapter(
      stt.provider,
      tts.provider,
    );
    await adapter.start();
    stt.provider.stopListening();

    tts.provider.speak('Read this aloud');
    expect(adapter.getSnapshot().state).toBe('speaking');

    tts.provider.cancel();
    expect(adapter.getSnapshot().state).toBe('connected-idle');
    expect(adapter.capabilities.textTurn).toBe(false);
    expect((adapter as VoiceSessionAdapter).sendText).toBeUndefined();
  });

  it('observes direct provider provider activity without requiring plugin callers to change their provider calls', () => {
    const stt = makeSTT();
    const tts = makeTTS();
    const adapter = createProviderVoiceSessionAdapter(
      stt.provider,
      tts.provider,
    );

    stt.provider.startListening();
    expect(adapter.getSnapshot().state).toBe('listening');
    stt.provider.stopListening();
    expect(adapter.getSnapshot().state).toBe('connected-idle');
    tts.provider.speak('Still using the independent provider contract');
    expect(adapter.getSnapshot().state).toBe('speaking');
  });

  it('interrupts speech while retaining the active STT listener', async () => {
    const stt = makeSTT();
    const tts = makeTTS();
    const adapter = createProviderVoiceSessionAdapter(
      stt.provider,
      tts.provider,
    );
    await adapter.start();
    tts.provider.speak('Interrupt me');

    const result = await adapter.interrupt();

    expect(result).toMatchObject({ ok: true });
    expect(tts.provider.cancel).toHaveBeenCalledOnce();
    expect(stt.provider.stopListening).not.toHaveBeenCalled();
    expect(adapter.getSnapshot().state).toBe('listening');
  });

  it('stops STT and cancels TTS together', async () => {
    const stt = makeSTT();
    const tts = makeTTS();
    const adapter = createProviderVoiceSessionAdapter(
      stt.provider,
      tts.provider,
    );
    await adapter.start();
    tts.provider.speak('Stop me');

    const result = await adapter.stop();

    expect(result).toMatchObject({ ok: true });
    expect(stt.provider.stopListening).toHaveBeenCalledOnce();
    expect(tts.provider.cancel).toHaveBeenCalledOnce();
    expect(adapter.getSnapshot().state).toBe('disconnected');
  });

  it('surfaces synchronous provider-start failures as typed snapshots', async () => {
    const stt = makeSTT({ startThrows: new Error('Microphone unavailable') });
    const tts = makeTTS();
    const adapter = createProviderVoiceSessionAdapter(
      stt.provider,
      tts.provider,
    );

    const result = await adapter.start();

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'operation-failed', operation: 'start' },
    });
    expect(adapter.getSnapshot().state).toBe('error');
    expect(Object.isFrozen(adapter.getSnapshot())).toBe(true);
    expect(stt.provider.stopListening).toHaveBeenCalledOnce();
    expect(tts.provider.cancel).toHaveBeenCalledOnce();
  });

  it('disposes subscriptions once after stopping both providers', async () => {
    const stt = makeSTT();
    const tts = makeTTS();
    const adapter = createProviderVoiceSessionAdapter(
      stt.provider,
      tts.provider,
    );
    await adapter.start();

    const [first, second] = await Promise.all([
      adapter.dispose(),
      adapter.dispose(),
    ]);

    expect(first).toMatchObject({ ok: true });
    expect(second).toBe(first);
    expect(stt.provider.subscribe).toHaveBeenCalledOnce();
    expect(tts.provider.subscribe).toHaveBeenCalledOnce();
    expect(stt.provider.stopListening).toHaveBeenCalledOnce();
    expect(tts.provider.cancel).toHaveBeenCalledOnce();
  });

  it('rejects a concurrent start as soon as disposal begins and leaves STT stopped', async () => {
    const stt = makeSTT();
    const tts = makeTTS();
    const adapter = createProviderVoiceSessionAdapter(
      stt.provider,
      tts.provider,
    );
    await adapter.start();

    const disposing = adapter.dispose();
    const restarted = await adapter.start();
    await disposing;

    expect(restarted).toMatchObject({
      ok: false,
      error: { code: 'unavailable', operation: 'start' },
    });
    expect(stt.provider.startListening).toHaveBeenCalledOnce();
    expect(stt.provider.stopListening).toHaveBeenCalledOnce();
    expect(stt.provider.state).toBe('idle');
    expect(adapter.getSnapshot().state).toBe('disconnected');
  });
});
