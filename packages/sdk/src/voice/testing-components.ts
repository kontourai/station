import type {
  VoiceAgentTurnAdapter,
  VoiceAgentTurnInput,
  VoiceAudioChunk,
  VoiceInputAdapter,
  VoiceInputEvent,
  VoicePlaybackAdapter,
  VoiceSynthesisAdapter,
  VoiceSynthesisInput,
} from './component-types.js';
import { FinalVoiceEndpointDetector } from './endpoint-detector.js';

class TestingInput implements VoiceInputAdapter {
  readonly descriptor = Object.freeze({
    id: 'testing-input',
    name: 'Testing input',
  });
  private readonly listeners = new Set<(event: VoiceInputEvent) => void>();
  readonly startSignals: AbortSignal[] = [];
  readonly stopSignals: AbortSignal[] = [];
  subscribe(listener: (event: VoiceInputEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async start(signal: AbortSignal): Promise<void> {
    this.startSignals.push(signal);
  }
  async stop(signal: AbortSignal): Promise<void> {
    this.stopSignals.push(signal);
  }
  emit(event: VoiceInputEvent): void {
    for (const listener of this.listeners) listener(Object.freeze(event));
  }
}

class TestingAgent implements VoiceAgentTurnAdapter {
  readonly descriptor = Object.freeze({
    id: 'testing-agent',
    name: 'Testing agent',
  });
  readonly inputs: VoiceAgentTurnInput[] = [];
  constructor(private readonly options: TestingVoiceComponentsOptions) {}
  async *run(input: VoiceAgentTurnInput): AsyncIterable<string> {
    this.inputs.push(input);
    if (this.options.agentError) throw this.options.agentError;
    const stream =
      this.inputs.length === 1 ? this.options.tokenStream : undefined;
    if (stream) {
      yield* stream(input);
      return;
    }
    for (const token of this.options.tokens ?? ['ok']) yield token;
  }
}

class TestingSynthesis implements VoiceSynthesisAdapter {
  readonly descriptor = Object.freeze({
    id: 'testing-synthesis',
    name: 'Testing synthesis',
  });
  readonly inputs: VoiceSynthesisInput[] = [];
  async *synthesize(
    input: VoiceSynthesisInput,
  ): AsyncIterable<VoiceAudioChunk> {
    this.inputs.push(input);
    yield Object.freeze({ data: new Uint8Array([1]), format: 'audio/pcm' });
  }
}

class TestingPlayback implements VoicePlaybackAdapter {
  readonly descriptor = Object.freeze({
    id: 'testing-playback',
    name: 'Testing playback',
  });
  readonly calls: string[] = [];
  async play(_chunk: VoiceAudioChunk, _signal: AbortSignal): Promise<void> {
    this.calls.push('play');
  }
  async stop(_signal: AbortSignal): Promise<void> {
    this.calls.push('stop');
  }
}

export interface TestingVoiceComponentsOptions {
  readonly tokens?: readonly string[];
  readonly tokenStream?: (input: VoiceAgentTurnInput) => AsyncIterable<string>;
  readonly agentError?: Error;
}

export function createTestingVoiceComponents(
  options: TestingVoiceComponentsOptions = {},
) {
  const input = new TestingInput();
  return {
    input,
    endpoint: new FinalVoiceEndpointDetector(),
    agent: new TestingAgent(options),
    synthesis: new TestingSynthesis(),
    playback: new TestingPlayback(),
    settle: async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

export function deferredVoiceTokens() {
  let resolveTokens: ((tokens: readonly string[]) => void) | undefined;
  const promise = new Promise<readonly string[]>((resolve) => {
    resolveTokens = resolve;
  });
  return {
    stream: async function* (
      _input: VoiceAgentTurnInput,
    ): AsyncIterable<string> {
      for (const token of await promise) yield token;
    },
    resolve(tokens: readonly string[]): void {
      resolveTokens?.(tokens);
    },
  };
}
