import { describe, expect, it, vi } from 'vitest';
import {
  LazyVoiceComponentFactory,
  OpenAICompatibleSynthesisAdapter,
  OpenAICompatibleTranscriptionAdapter,
  ProviderVoiceInputAdapter,
  TranscribingVoiceInputAdapter,
} from '../voice/component-adapters.js';
import type {
  VoiceAudioCaptureAdapter,
  VoiceAudioCaptureEvent,
} from '../voice/component-types.js';

describe('voice component adapters', () => {
  it('normalizes provider interim transcript changes and exactly one idle final', async () => {
    let listener: (() => void) | undefined;
    const stt = {
      id: 'device',
      name: 'Device',
      isSupported: true,
      state: 'idle' as 'idle' | 'listening',
      transcript: '',
      startListening: vi.fn(),
      stopListening: vi.fn(),
      subscribe: (next: () => void) => {
        listener = next;
        return () => undefined;
      },
    };
    const adapter = new ProviderVoiceInputAdapter(stt);
    const seen: unknown[] = [];
    adapter.subscribe((event) => seen.push(event));
    await adapter.start(new AbortController().signal);
    stt.state = 'listening';
    stt.transcript = 'device';
    listener?.();
    stt.transcript = 'device words';
    listener?.();
    stt.state = 'idle';
    listener?.();
    listener?.();
    expect(seen).toEqual([
      { type: 'interim', epoch: 1, transcript: 'device' },
      { type: 'interim', epoch: 1, transcript: 'device words' },
      { type: 'final', epoch: 1, transcript: 'device words' },
    ]);
  });

  it('uses injected OpenAI-compatible multipart transcription and raw synthesis bytes', async () => {
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      if (url.endsWith('/transcribe')) {
        expect(init?.body).toBeInstanceOf(FormData);
        const form = init?.body as FormData;
        expect(form.get('model')).toBe('stt');
        expect(form.get('file')).toBeInstanceOf(Blob);
        expect((form.get('file') as File).name).toBe('recording.wav');
        expect((form.get('file') as Blob).type).toBe('audio/wav');
        expect(new Headers(init?.headers).has('content-type')).toBe(false);
        return new Response(JSON.stringify({ text: 'hello' }), { status: 200 });
      }
      expect(init?.headers).toMatchObject({
        'content-type': 'application/json',
      });
      expect(init?.body).toBe(
        JSON.stringify({
          model: 'tts',
          input: 'hello',
          voice: 'alloy',
          response_format: 'opus',
        }),
      );
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'audio/ogg; codecs=opus' },
      });
    });
    const controller = new AbortController();
    const transcriber = new OpenAICompatibleTranscriptionAdapter({
      endpoint: 'https://example.test/transcribe',
      model: 'stt',
      fetch,
      fileName: 'recording.wav',
      mimeType: 'audio/wav',
    });
    const synthesis = new OpenAICompatibleSynthesisAdapter({
      endpoint: 'https://example.test/speech',
      model: 'tts',
      voice: 'alloy',
      responseFormat: 'opus',
      fetch,
    });
    await expect(
      transcriber.transcribe(new Uint8Array([1]), controller.signal),
    ).resolves.toBe('hello');
    const audio: unknown[] = [];
    for await (const chunk of synthesis.synthesize({
      text: 'hello',
      signal: controller.signal,
    })) {
      audio.push(chunk);
    }
    expect(audio).toEqual([
      { data: new Uint8Array([1, 2, 3]), format: 'audio/ogg' },
    ]);
    expect(JSON.stringify(transcriber)).not.toContain('Authorization');
  });

  it('loads heavy local components only when selected', async () => {
    const load = vi.fn(async () => ({ value: 'loaded' }));
    const factory = new LazyVoiceComponentFactory(load);
    expect(load).not.toHaveBeenCalled();
    await expect(factory.create()).resolves.toEqual({ value: 'loaded' });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('turns captured audio into one final and suppresses stale transcriber completion after stop', async () => {
    const capture = new TestCapture();
    let resolveTranscription: ((value: string) => void) | undefined;
    const transcription = {
      descriptor: { id: 'transcriber', name: 'Transcriber' },
      transcribe: vi.fn(
        () =>
          new Promise<string>((resolve) => {
            resolveTranscription = resolve;
          }),
      ),
    };
    const adapter = new TranscribingVoiceInputAdapter(capture, transcription);
    const seen: unknown[] = [];
    adapter.subscribe((event) => seen.push(event));
    await adapter.start(new AbortController().signal);
    capture.emit({ type: 'audio', epoch: 4, audio: new Uint8Array([1]) });
    await Promise.resolve();
    resolveTranscription?.('first');
    await Promise.resolve();
    expect(seen).toEqual([{ type: 'final', epoch: 4, transcript: 'first' }]);

    capture.emit({ type: 'audio', epoch: 5, audio: new Uint8Array([2]) });
    await Promise.resolve();
    await adapter.stop(new AbortController().signal);
    resolveTranscription?.('late');
    await Promise.resolve();
    expect(seen).toHaveLength(1);
  });

  it('returns to a stopped state when audio capture startup fails', async () => {
    const capture = new TestCapture();
    vi.spyOn(capture, 'start').mockRejectedValueOnce(new Error('no device'));
    const transcription = {
      descriptor: { id: 'transcriber', name: 'Transcriber' },
      transcribe: vi.fn(async () => 'unused'),
    };
    const adapter = new TranscribingVoiceInputAdapter(capture, transcription);
    await expect(adapter.start(new AbortController().signal)).rejects.toThrow(
      'no device',
    );

    capture.emit({ type: 'audio', epoch: 1, audio: new Uint8Array([1]) });
    await Promise.resolve();
    expect(transcription.transcribe).not.toHaveBeenCalled();
  });

  it('keeps overlapping starts isolated and disposes owned capture subscriptions', async () => {
    const capture = new TestCapture();
    const transcription = {
      descriptor: { id: 'transcriber', name: 'Transcriber' },
      transcribe: vi.fn(async (_audio: Uint8Array, signal: AbortSignal) => {
        expect(signal.aborted).toBe(false);
        return 'new generation';
      }),
    };
    const adapter = new TranscribingVoiceInputAdapter(capture, transcription);
    const first = new AbortController();
    const second = new AbortController();
    const seen: unknown[] = [];
    adapter.subscribe((event) => seen.push(event));
    await adapter.start(first.signal);
    await adapter.start(second.signal);
    first.abort();
    capture.emit({ type: 'audio', epoch: 2, audio: new Uint8Array([2]) });
    await Promise.resolve();
    expect(seen).toEqual([
      { type: 'final', epoch: 2, transcript: 'new generation' },
    ]);
    await adapter.dispose?.();
    expect(capture.listenerCount).toBe(0);
  });

  it('disposes the provider subscription exactly once', async () => {
    const unsubscribe = vi.fn();
    const provider = {
      id: 'provider-stt',
      name: 'Provider STT',
      isSupported: true,
      state: 'idle' as const,
      transcript: '',
      startListening: vi.fn(),
      stopListening: vi.fn(),
      subscribe: vi.fn(() => unsubscribe),
    };
    const adapter = new ProviderVoiceInputAdapter(provider);
    adapter.dispose?.();
    adapter.dispose?.();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('removes a provider start signal listener when explicitly stopped', async () => {
    const provider = {
      id: 'provider-stt',
      name: 'Provider STT',
      isSupported: true,
      state: 'idle' as const,
      transcript: '',
      startListening: vi.fn(),
      stopListening: vi.fn(),
      subscribe: () => () => undefined,
    };
    const adapter = new ProviderVoiceInputAdapter(provider);
    const controller = new AbortController();
    await adapter.start(controller.signal);
    await adapter.stop(new AbortController().signal);
    controller.abort();
    expect(provider.stopListening).toHaveBeenCalledTimes(1);
  });
});

class TestCapture implements VoiceAudioCaptureAdapter {
  readonly descriptor = { id: 'capture', name: 'Capture' };
  private readonly listeners = new Set<
    (event: VoiceAudioCaptureEvent) => void
  >();
  subscribe(listener: (event: VoiceAudioCaptureEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async start(_signal: AbortSignal): Promise<void> {}
  async stop(_signal: AbortSignal): Promise<void> {}
  emit(event: VoiceAudioCaptureEvent): void {
    for (const listener of this.listeners) listener(event);
  }
  get listenerCount(): number {
    return this.listeners.size;
  }
}
