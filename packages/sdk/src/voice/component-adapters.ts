import type {
  VoiceAudioCaptureAdapter,
  VoiceAudioCaptureEvent,
  VoiceAudioChunk,
  VoiceComponentDescriptor,
  VoiceInputAdapter,
  VoiceInputEvent,
  VoiceSynthesisAdapter,
  VoiceSynthesisInput,
  VoiceTranscriptionAdapter,
} from './component-types.js';
import type { STTProvider } from './types.js';

type VoiceFetch = (input: string, init?: RequestInit) => Promise<Response>;

interface OpenAICompatibleBaseOptions {
  readonly endpoint: string;
  readonly model: string;
  readonly fetch: VoiceFetch;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface OpenAICompatibleTranscriptionOptions
  extends OpenAICompatibleBaseOptions {
  readonly fileName?: string;
  readonly mimeType?: string;
}

export interface OpenAICompatibleSynthesisOptions
  extends OpenAICompatibleBaseOptions {
  readonly voice: string;
  readonly responseFormat?: string;
}

/** Normalizes an existing device/browser STT provider into composed input events. */
export class ProviderVoiceInputAdapter implements VoiceInputAdapter {
  readonly descriptor: VoiceComponentDescriptor;
  private readonly listeners = new Set<(event: VoiceInputEvent) => void>();
  private epoch = 0;
  private transcript = '';
  private state: STTProvider['state'];
  private readonly unsubscribeProvider: () => void;
  private removeAbortListener: (() => void) | undefined;
  private disposed = false;

  constructor(private readonly provider: STTProvider) {
    this.descriptor = Object.freeze({
      id: `provider-input:${provider.id}`,
      name: provider.name,
    });
    this.state = provider.state;
    this.unsubscribeProvider = this.provider.subscribe(() => this.refresh());
  }

  subscribe(listener: (event: VoiceInputEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(signal: AbortSignal): Promise<void> {
    if (this.disposed)
      throw new Error('Provider voice input adapter is disposed.');
    throwIfAborted(signal);
    this.removeAbortListener?.();
    this.epoch += 1;
    this.transcript = this.provider.transcript;
    this.state = this.provider.state;
    this.provider.startListening();
    const stopOnAbort = () => this.provider.stopListening();
    signal.addEventListener('abort', stopOnAbort, { once: true });
    this.removeAbortListener = () =>
      signal.removeEventListener('abort', stopOnAbort);
  }

  async stop(signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    this.removeAbortListener?.();
    this.removeAbortListener = undefined;
    this.provider.stopListening();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.removeAbortListener?.();
    this.removeAbortListener = undefined;
    this.unsubscribeProvider();
    this.listeners.clear();
  }

  private refresh(): void {
    if (this.provider.state === 'error') {
      this.emit(
        Object.freeze({
          type: 'error',
          epoch: this.epoch,
          error: new Error('Provider input provider reported an error.'),
        }),
      );
      return;
    }
    if (
      this.provider.state === 'listening' &&
      this.provider.transcript &&
      this.provider.transcript !== this.transcript
    ) {
      this.transcript = this.provider.transcript;
      this.emit(
        Object.freeze({
          type: 'interim',
          epoch: this.epoch,
          transcript: this.transcript,
        }),
      );
    }
    if (
      this.state === 'listening' &&
      this.provider.state === 'idle' &&
      this.transcript
    ) {
      this.emit(
        Object.freeze({
          type: 'final',
          epoch: this.epoch,
          transcript: this.transcript,
        }),
      );
    }
    this.state = this.provider.state;
  }

  private emit(event: VoiceInputEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

/** An injected OpenAI-compatible transcription endpoint; it does not capture device audio. */
export class OpenAICompatibleTranscriptionAdapter
  implements VoiceTranscriptionAdapter
{
  readonly descriptor: VoiceComponentDescriptor = Object.freeze({
    id: 'openai-compatible-transcription',
    name: 'OpenAI-compatible transcription',
  });
  readonly #options: OpenAICompatibleTranscriptionOptions;
  constructor(options: OpenAICompatibleTranscriptionOptions) {
    this.#options = options;
  }

  async transcribe(audio: Uint8Array, signal: AbortSignal): Promise<string> {
    throwIfAborted(signal);
    const response = await this.#options.fetch(this.#options.endpoint, {
      method: 'POST',
      signal,
      headers: withoutContentType(this.#options.headers),
      body: transcriptionForm(this.#options, audio),
    });
    if (!response.ok)
      throw new Error(
        `Transcription request failed with status ${response.status}.`,
      );
    const payload: unknown = await response.json();
    if (!isRecord(payload) || typeof payload.text !== 'string')
      throw new Error('Transcription response did not contain text.');
    return payload.text;
  }
}

/** Composes captured audio and a transcription client into selectable voice input. */
export class TranscribingVoiceInputAdapter implements VoiceInputAdapter {
  readonly descriptor: VoiceComponentDescriptor;
  private readonly listeners = new Set<(event: VoiceInputEvent) => void>();
  private readonly unsubscribeCapture: () => void;
  private controller: AbortController | undefined;
  private removeAbortListener: (() => void) | undefined;
  private generation = 0;
  private started = false;
  private disposed = false;

  constructor(
    private readonly capture: VoiceAudioCaptureAdapter,
    private readonly transcriber: VoiceTranscriptionAdapter,
  ) {
    this.descriptor = Object.freeze({
      id: `transcribing-input:${capture.descriptor.id}:${transcriber.descriptor.id}`,
      name: `${capture.descriptor.name} transcription`,
    });
    this.unsubscribeCapture = capture.subscribe((event) => {
      void this.handleCapture(event);
    });
  }

  subscribe(listener: (event: VoiceInputEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(signal: AbortSignal): Promise<void> {
    if (this.disposed)
      throw new Error('Transcribing voice input adapter is disposed.');
    throwIfAborted(signal);
    this.generation += 1;
    this.controller?.abort();
    this.removeAbortListener?.();
    const controller = new AbortController();
    this.controller = controller;
    this.started = true;
    const abortController = () => controller.abort();
    signal.addEventListener('abort', abortController, { once: true });
    this.removeAbortListener = () =>
      signal.removeEventListener('abort', abortController);
    try {
      await this.capture.start(controller.signal);
    } catch (error) {
      if (this.controller === controller) {
        this.started = false;
        controller.abort();
        this.controller = undefined;
        this.removeAbortListener?.();
        this.removeAbortListener = undefined;
      }
      throw error;
    }
  }

  async stop(signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    this.started = false;
    this.generation += 1;
    this.controller?.abort();
    this.controller = undefined;
    this.removeAbortListener?.();
    this.removeAbortListener = undefined;
    await this.capture.stop(signal);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const wasStarted = this.started;
    this.started = false;
    this.generation += 1;
    this.controller?.abort();
    this.controller = undefined;
    this.removeAbortListener?.();
    this.removeAbortListener = undefined;
    this.unsubscribeCapture();
    this.listeners.clear();
    if (wasStarted) await this.capture.stop(new AbortController().signal);
  }

  private async handleCapture(event: VoiceAudioCaptureEvent): Promise<void> {
    const controller = this.controller;
    const generation = this.generation;
    if (this.disposed || !this.started || !controller) return;
    if (event.type === 'error') {
      this.emit(
        Object.freeze({
          type: 'error',
          epoch: event.epoch,
          error: event.error,
        }),
      );
      return;
    }
    try {
      const transcript = await this.transcriber.transcribe(
        event.audio,
        controller.signal,
      );
      if (!this.isCurrent(generation, controller)) return;
      this.emit(
        Object.freeze({ type: 'final', epoch: event.epoch, transcript }),
      );
    } catch (cause) {
      if (!this.isCurrent(generation, controller)) return;
      this.emit(
        Object.freeze({
          type: 'error',
          epoch: event.epoch,
          error:
            cause instanceof Error ? cause : new Error('Transcription failed.'),
        }),
      );
    }
  }

  private isCurrent(generation: number, controller: AbortController): boolean {
    return (
      this.started &&
      this.generation === generation &&
      this.controller === controller &&
      !controller.signal.aborted
    );
  }

  private emit(event: VoiceInputEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

/** Streams audio from an injected OpenAI-compatible synthesis endpoint. */
export class OpenAICompatibleSynthesisAdapter implements VoiceSynthesisAdapter {
  readonly descriptor: VoiceComponentDescriptor = Object.freeze({
    id: 'openai-compatible-synthesis',
    name: 'OpenAI-compatible synthesis',
  });
  readonly #options: OpenAICompatibleSynthesisOptions;
  constructor(options: OpenAICompatibleSynthesisOptions) {
    this.#options = options;
  }

  async *synthesize(
    input: VoiceSynthesisInput,
  ): AsyncIterable<VoiceAudioChunk> {
    throwIfAborted(input.signal);
    const response = await this.#options.fetch(this.#options.endpoint, {
      method: 'POST',
      signal: input.signal,
      headers: { ...this.#options.headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.#options.model,
        input: input.text,
        voice: this.#options.voice,
        ...(this.#options.responseFormat
          ? { response_format: this.#options.responseFormat }
          : {}),
      }),
    });
    if (!response.ok)
      throw new Error(
        `Synthesis request failed with status ${response.status}.`,
      );
    const data = new Uint8Array(await response.arrayBuffer());
    yield Object.freeze({
      data,
      format:
        response.headers.get('content-type')?.split(';')[0] ?? 'audio/mpeg',
    });
  }
}

/** Defers heavyweight local implementations until a consumer selects them. */
export class LazyVoiceComponentFactory<T> {
  #instance: Promise<T> | undefined;
  constructor(private readonly load: () => Promise<T>) {}
  create(): Promise<T> {
    this.#instance ??= this.load();
    return this.#instance;
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('Voice operation was aborted.');
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
function transcriptionForm(
  options: OpenAICompatibleTranscriptionOptions,
  audio: Uint8Array,
): FormData {
  const form = new FormData();
  form.append('model', options.model);
  form.append(
    'file',
    new Blob([new Uint8Array(audio).buffer], {
      type: options.mimeType ?? 'audio/wav',
    }),
    options.fileName ?? 'audio.wav',
  );
  return form;
}
function withoutContentType(
  headers: Readonly<Record<string, string>> | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== 'content-type') result[key] = value;
  }
  return result;
}
