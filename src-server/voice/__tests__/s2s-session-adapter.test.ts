import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { S2SSessionAdapter } from '../s2s-session-adapter.js';
import type {
  IS2SProvider,
  S2SAudioFormat,
  S2SProviderState,
  S2SSessionConfig,
} from '../s2s-types.js';

const INPUT_FORMAT: S2SAudioFormat = {
  mediaType: 'audio/pcm',
  sampleRateHertz: 16_000,
  sampleSizeBits: 16,
  channelCount: 1,
  encoding: 'base64',
};
const OUTPUT_FORMAT: S2SAudioFormat = {
  ...INPUT_FORMAT,
  sampleRateHertz: 24_000,
};
const CONFIG: S2SSessionConfig = { systemPrompt: 'safe', tools: [] };

class FakeProvider extends EventEmitter implements IS2SProvider {
  readonly outputAudioFormat = OUTPUT_FORMAT;
  state: S2SProviderState = 'disconnected';
  readonly connect = vi.fn(async () => INPUT_FORMAT);
  readonly disconnect = vi.fn(async (): Promise<void> => undefined);
  readonly sendAudio = vi.fn();
  readonly sendToolResult = vi.fn();
}

describe('S2SSessionAdapter', () => {
  it('normalizes provider states and keeps immutable monotonic snapshots', async () => {
    const provider = new FakeProvider();
    const lifecycle = vi.fn();
    const adapter = new S2SSessionAdapter(provider, CONFIG, {
      onAudio: vi.fn(),
      onTranscript: vi.fn(),
      onToolUse: vi.fn(),
      onError: vi.fn(),
      recordLifecycle: lifecycle,
    });
    const revisions: number[] = [];
    adapter.subscribe(() => revisions.push(adapter.getSnapshot().revision));

    await expect(
      adapter.start({
        controlSessionId: 'control',
        conversationSessionId: 'conversation',
      }),
    ).resolves.toMatchObject({ ok: true });
    provider.emit('stateChange', 'idle');
    expect(adapter.getSnapshot()).toMatchObject({
      state: 'connected-idle',
      controlSessionId: 'control',
      conversationSessionId: 'conversation',
    });
    provider.emit('stateChange', 'processing');
    expect(adapter.getSnapshot().state).toBe('thinking');
    provider.emit('stateChange', 'speaking');
    provider.emit('stateChange', 'listening');
    expect(lifecycle).toHaveBeenCalledWith({
      operation: 'interrupt',
      outcome: 'success',
      reason: 'barge_in',
    });
    expect(Object.isFrozen(adapter.getSnapshot())).toBe(true);
    expect(
      revisions.every((revision, i) => i === 0 || revision > revisions[i - 1]),
    ).toBe(true);
  });

  it('forwards content while live and suppresses late events after awaited idempotent stop', async () => {
    const provider = new FakeProvider();
    let releaseDisconnect!: () => void;
    provider.disconnect.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseDisconnect = resolve;
        }),
    );
    const onAudio = vi.fn();
    const onTranscript = vi.fn();
    const onToolUse = vi.fn();
    const adapter = new S2SSessionAdapter(provider, CONFIG, {
      onAudio,
      onTranscript,
      onToolUse,
      onError: vi.fn(),
    });
    await adapter.start();

    provider.emit('audio', Buffer.from('before'));
    provider.emit('transcript', {
      text: 'before',
      role: 'user',
      stage: 'final',
    });
    provider.emit('toolUse', {
      toolName: 'before',
      toolUseId: 'one',
      parameters: {},
    });
    const firstStop = adapter.stop();
    const secondStop = adapter.stop();
    expect(secondStop).toBe(firstStop);
    provider.emit('audio', Buffer.from('after'));
    provider.emit('transcript', {
      text: 'after',
      role: 'user',
      stage: 'final',
    });
    expect(provider.disconnect).toHaveBeenCalledTimes(1);
    releaseDisconnect();
    await expect(firstStop).resolves.toMatchObject({
      ok: true,
      snapshot: { state: 'disconnected' },
    });
    expect(onAudio).toHaveBeenCalledTimes(1);
    expect(onTranscript).toHaveBeenCalledTimes(1);
    expect(onToolUse).toHaveBeenCalledTimes(1);
  });

  it('disconnects and settles when stopped while provider connect never settles', async () => {
    const provider = new FakeProvider();
    let releaseConnect!: (format: S2SAudioFormat) => void;
    provider.connect.mockImplementation(
      () =>
        new Promise<S2SAudioFormat>((resolve) => {
          releaseConnect = resolve;
        }),
    );
    const adapter = new S2SSessionAdapter(provider, CONFIG, {
      onAudio: vi.fn(),
      onTranscript: vi.fn(),
      onToolUse: vi.fn(),
      onError: vi.fn(),
    });

    const starting = adapter.start();
    await Promise.resolve();
    const stopping = adapter.stop();

    expect(provider.disconnect).toHaveBeenCalledOnce();
    await expect(stopping).resolves.toMatchObject({
      ok: true,
      snapshot: { state: 'disconnected' },
    });
    await expect(starting).resolves.toMatchObject({
      ok: false,
      error: { operation: 'start' },
    });
    releaseConnect(INPUT_FORMAT);
    await Promise.resolve();
    expect(adapter.getSnapshot().state).toBe('disconnected');
  });

  it('reserves start before a connecting subscriber can stop reentrantly', async () => {
    const provider = new FakeProvider();
    const adapter = new S2SSessionAdapter(provider, CONFIG, {
      onAudio: vi.fn(),
      onTranscript: vi.fn(),
      onToolUse: vi.fn(),
      onError: vi.fn(),
    });
    let stopping: Promise<unknown> | undefined;
    adapter.subscribe(() => {
      if (adapter.getSnapshot().state === 'connecting') {
        stopping = adapter.stop();
      }
    });

    const started = await adapter.start();
    await stopping;

    expect(started).toMatchObject({
      ok: false,
      error: { operation: 'start' },
    });
    expect(provider.connect).not.toHaveBeenCalled();
    expect(provider.disconnect).toHaveBeenCalledOnce();
    expect(adapter.getSnapshot().state).toBe('disconnected');
  });

  it('retains a failed disconnect as a retriable teardown', async () => {
    const provider = new FakeProvider();
    provider.disconnect
      .mockRejectedValueOnce(new Error('transient disconnect failure'))
      .mockResolvedValueOnce(undefined);
    const adapter = new S2SSessionAdapter(provider, CONFIG, {
      onAudio: vi.fn(),
      onTranscript: vi.fn(),
      onToolUse: vi.fn(),
      onError: vi.fn(),
    });
    await adapter.start();

    await expect(adapter.stop()).resolves.toMatchObject({
      ok: false,
      error: { operation: 'stop' },
    });
    expect(adapter.getSnapshot().state).toBe('error');
    await expect(adapter.stop()).resolves.toMatchObject({
      ok: true,
      snapshot: { state: 'disconnected' },
    });
    expect(provider.disconnect).toHaveBeenCalledTimes(2);
  });

  it('publishes a typed error while telemetry receives only bounded fields', async () => {
    const provider = new FakeProvider();
    const secret = 'credential-secret transcript-secret';
    provider.connect.mockRejectedValue(new Error(secret));
    const lifecycle = vi.fn();
    const adapter = new S2SSessionAdapter(provider, CONFIG, {
      onAudio: vi.fn(),
      onTranscript: vi.fn(),
      onToolUse: vi.fn(),
      onError: vi.fn(),
      recordLifecycle: lifecycle,
    });

    const result = await adapter.start();
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'operation-failed', operation: 'start' },
    });
    expect(adapter.getSnapshot().state).toBe('error');
    expect(JSON.stringify(lifecycle.mock.calls)).not.toContain(secret);
    expect(lifecycle).toHaveBeenCalledWith({
      operation: 'start',
      outcome: 'failure',
      reason: 'provider_failed',
    });
  });

  it('keeps provider-error cleanup authoritative when a lifecycle observer throws', async () => {
    const provider = new FakeProvider();
    const onError = vi.fn();
    const adapter = new S2SSessionAdapter(provider, CONFIG, {
      onAudio: vi.fn(),
      onTranscript: vi.fn(),
      onToolUse: vi.fn(),
      onError,
      recordLifecycle: vi.fn(() => {
        throw new Error('metrics unavailable');
      }),
    });
    await adapter.start();
    provider.emit('error', new Error('provider failed'));
    expect(onError).toHaveBeenCalledOnce();
    expect(adapter.getSnapshot().state).toBe('error');
  });
});
