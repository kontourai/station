/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';
import {
  NovaVoiceSessionAdapter,
  type NovaVoiceSessionAdapterDependencies,
} from '../providers/voice/NovaVoiceSessionAdapter';

class FakeSocket {
  readyState = 1;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  readonly close = vi.fn(() => {
    this.readyState = 3;
  });
  readonly send = vi.fn();

  open(): void {
    this.onopen?.(new Event('open'));
  }

  message(message: unknown): void {
    this.onmessage?.(
      new MessageEvent('message', { data: JSON.stringify(message) }),
    );
  }

  closed(code: number): void {
    this.onclose?.({ code } as CloseEvent);
  }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function createHarness(options?: {
  getUserMedia?: () => Promise<MediaStream>;
  fetchVoicePort?: () => Promise<number>;
}) {
  const socket = new FakeSocket();
  const source = {
    buffer: null,
    onended: null,
    connect: vi.fn(),
    disconnect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  } as unknown as AudioBufferSourceNode;
  const microphoneSource = {
    connect: vi.fn(),
    disconnect: vi.fn(),
  } as unknown as MediaStreamAudioSourceNode;
  const context = {
    sampleRate: 48_000,
    destination: {},
    audioWorklet: { addModule: vi.fn(async () => undefined) },
    createMediaStreamSource: vi.fn(() => microphoneSource),
    createBuffer: vi.fn(() => ({ copyToChannel: vi.fn() })),
    createBufferSource: vi.fn(() => source),
    close: vi.fn(async () => undefined),
  } as unknown as AudioContext;
  const track = vi.fn();
  class FakeAudioWorkletNode {
    readonly port = { onmessage: null };
    readonly connect = vi.fn();
    readonly disconnect = vi.fn();
  }
  (globalThis as unknown as { AudioWorkletNode: unknown }).AudioWorkletNode =
    FakeAudioWorkletNode;
  const dependencies: NovaVoiceSessionAdapterDependencies = {
    apiBase: 'http://localhost:3000',
    credentialProvider: {
      getCredential: () => undefined,
      getProtocolVersion: () => 1,
    },
    pageHref: () => 'http://localhost:5173/',
    createSocket: () => socket as unknown as WebSocket,
    createAudioContext: () => context,
    getUserMedia:
      options?.getUserMedia ??
      (async () => ({ getTracks: () => [] }) as unknown as MediaStream),
    fetchVoicePort: options?.fetchVoicePort ?? (async () => 3002),
    createVoiceSession: async () => ({ sessionId: 'rest-session' }),
    deriveVoiceWsUrl: () => 'ws://localhost:3002/?agent=station-voice',
    isRemoteEndpoint: () => false,
    createAuthGate: (_remote, _credentials, onAuthenticated) => ({
      open: () => onAuthenticated(),
      consume: () => false,
    }),
    track,
  };
  return {
    adapter: new NovaVoiceSessionAdapter(dependencies),
    context,
    socket,
    source,
    track,
  };
}

async function startHarness(harness: ReturnType<typeof createHarness>) {
  const started = harness.adapter.start();
  await flush();
  harness.socket.open();
  await flush();
  harness.socket.message({ type: 'session_ready' });
  await expect(started).resolves.toMatchObject({ ok: true });
}

describe('NovaVoiceSessionAdapter', () => {
  it('normalizes Nova UI state and publishes frozen presentation snapshots', async () => {
    const harness = createHarness();
    const snapshots = [harness.adapter.getSnapshot()];
    harness.adapter.subscribe(() =>
      snapshots.push(harness.adapter.getSnapshot()),
    );

    await startHarness(harness);
    harness.socket.message({
      type: 'transcript',
      text: 'canary transcript',
      role: 'assistant',
    });
    harness.socket.message({ type: 'state', state: 'idle' });
    harness.socket.message({ type: 'state', state: 'processing' });

    expect(harness.adapter.getSnapshot()).toMatchObject({
      state: 'thinking',
      transcript: 'canary transcript',
      transcriptRole: 'assistant',
      controlSessionId: 'rest-session',
    });
    expect(snapshots.every(Object.isFrozen)).toBe(true);
    expect(snapshots.map((snapshot) => snapshot.revision)).toEqual([
      ...snapshots.keys(),
    ]);
  });

  it('cleans socket and audio resources once on explicit repeated stop', async () => {
    const harness = createHarness();
    await startHarness(harness);

    await Promise.all([harness.adapter.stop(), harness.adapter.stop()]);

    expect(harness.socket.close).toHaveBeenCalledTimes(1);
    expect(harness.context.close).toHaveBeenCalledTimes(1);
    expect(harness.adapter.getSnapshot().state).toBe('disconnected');
    expect(harness.track).toHaveBeenCalledWith(
      'station.voice.session.lifecycle',
      expect.objectContaining({
        layer: 'browser',
        adapter: 'nova-s2s',
        operation: 'stop',
        outcome: 'success',
        reason: 'explicit',
      }),
    );
  });

  it('settles microphone denial through the same terminal cleanup path', async () => {
    const harness = createHarness({
      getUserMedia: async () => Promise.reject(new Error('raw provider error')),
    });
    const started = harness.adapter.start();
    await flush();
    harness.socket.open();
    await flush();
    harness.socket.message({ type: 'session_ready' });
    await expect(started).resolves.toMatchObject({ ok: false });

    expect(harness.socket.close).toHaveBeenCalledTimes(1);
    expect(harness.context.close).toHaveBeenCalledTimes(1);
    expect(harness.adapter.getSnapshot()).toMatchObject({
      state: 'disconnected',
      error: expect.objectContaining({ message: 'Mic access denied' }),
    });
    expect(harness.track).toHaveBeenCalledWith(
      'station.voice.session.lifecycle',
      expect.objectContaining({
        operation: 'error',
        reason: 'microphone_failed',
      }),
    );
    expect(JSON.stringify(harness.track.mock.calls)).not.toContain(
      'raw provider error',
    );
  });

  it('treats listening after speech as a playback-only barge-in', async () => {
    const harness = createHarness();
    await startHarness(harness);
    harness.socket.message({ type: 'state', state: 'speaking' });
    harness.socket.message({
      type: 'audio_out',
      data: btoa(String.fromCharCode(0, 0)),
    });
    harness.socket.message({ type: 'state', state: 'listening' });

    expect(harness.source.stop).toHaveBeenCalledTimes(1);
    expect(harness.socket.close).not.toHaveBeenCalled();
    expect(harness.adapter.getSnapshot().state).toBe('listening');
    expect(harness.track).toHaveBeenCalledWith(
      'station.voice.session.lifecycle',
      expect.objectContaining({ operation: 'interrupt', reason: 'barge_in' }),
    );
  });

  it('treats a normal socket close as a clean disconnected terminal state', async () => {
    const harness = createHarness();
    await startHarness(harness);
    harness.socket.closed(1000);
    await flush();

    expect(harness.adapter.getSnapshot()).toMatchObject({
      state: 'disconnected',
      error: undefined,
    });
    expect(harness.context.close).toHaveBeenCalledTimes(1);
    expect(harness.track).toHaveBeenCalledWith(
      'station.voice.session.lifecycle',
      expect.objectContaining({
        operation: 'stop',
        outcome: 'success',
        reason: 'socket_close',
      }),
    );
    expect(harness.track).not.toHaveBeenCalledWith(
      'station.voice.session.lifecycle',
      expect.objectContaining({ operation: 'error' }),
    );
  });

  it('does not report a successful start when a normal close wins before ready', async () => {
    const harness = createHarness();
    const started = harness.adapter.start();
    await flush();
    harness.socket.open();
    await flush();
    harness.socket.closed(1000);

    await expect(started).resolves.toMatchObject({
      ok: false,
      error: expect.objectContaining({
        code: 'unavailable',
        operation: 'start',
      }),
    });
    expect(harness.adapter.getSnapshot()).toMatchObject({
      state: 'disconnected',
      error: undefined,
    });
  });

  it('ignores an async port lookup that completes after stop', async () => {
    let resolvePort: ((port: number) => void) | undefined;
    const harness = createHarness({
      fetchVoicePort: () =>
        new Promise<number>((resolve) => {
          resolvePort = resolve;
        }),
    });
    const started = harness.adapter.start();
    await harness.adapter.stop();
    resolvePort?.(3002);

    await expect(started).resolves.toMatchObject({ ok: false });
    expect(harness.socket.close).not.toHaveBeenCalled();
    expect(harness.adapter.getSnapshot().state).toBe('disconnected');
  });
});
