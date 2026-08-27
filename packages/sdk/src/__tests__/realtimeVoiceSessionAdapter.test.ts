import { describe, expect, it } from 'vitest';
import { RealtimeVoiceSessionAdapter } from '../voice/realtime-session-adapter.js';
import { createFakeVoiceRealtimeProvider } from '../voice/realtime-testing.js';
import type {
  VoiceRealtimeConnection,
  VoiceRealtimeProvider,
  VoiceRealtimeReadiness,
} from '../voice/realtime-types.js';

describe('RealtimeVoiceSessionAdapter', () => {
  it('deduplicates concurrent starts and preserves Station identity on reconnect', async () => {
    const provider = createFakeVoiceRealtimeProvider({ deferredOpen: true });
    const adapter = new RealtimeVoiceSessionAdapter(provider);
    const first = adapter.start({
      controlSessionId: 'station-control',
      conversationSessionId: 'station-conversation',
      context: { locale: 'en-US' },
    });
    const second = adapter.start();

    expect(first).toBe(second);
    provider.resolveOpen();
    expect(await first).toMatchObject({ ok: true });
    await adapter.reconnect();

    expect(provider.openCount).toBe(2);
    expect(provider.closeCount).toBe(1);
    expect(adapter.getSnapshot()).toMatchObject({
      controlSessionId: 'station-control',
      conversationSessionId: 'station-conversation',
      state: 'connected-idle',
    });
  });

  it('suppresses stale connection events and sanitizes provider failures', async () => {
    const provider = createFakeVoiceRealtimeProvider();
    const adapter = new RealtimeVoiceSessionAdapter(provider);
    await adapter.start();
    const stale = provider.currentConnection;
    await adapter.reconnect();
    stale.emit({
      type: 'transcript',
      text: 'secret stale transcript',
      role: 'assistant',
    });
    stale.emit({
      type: 'error',
      code: 'unavailable',
    });

    expect(adapter.getSnapshot().transcript).toBeUndefined();
    expect(adapter.getSnapshot().error).toBeUndefined();
  });

  it('does not reactivate after stop while a lease is opening', async () => {
    const provider = createFakeVoiceRealtimeProvider({ deferredOpen: true });
    const adapter = new RealtimeVoiceSessionAdapter(provider);
    const starting = adapter.start();
    await Promise.resolve();
    await Promise.resolve();
    const stopping = adapter.stop();
    provider.resolveOpen();
    await starting;
    await stopping;

    expect(adapter.getSnapshot().state).toBe('disconnected');
    expect(provider.closeCount).toBe(1);
  });

  it('retains a stale opened connection when its first cleanup fails', async () => {
    let resolveOpen:
      | ((connection: VoiceRealtimeConnection) => void)
      | undefined;
    let closeCalls = 0;
    const provider: VoiceRealtimeProvider = {
      descriptor: { id: 'stale-cleanup', name: 'Stale cleanup' },
      capabilities: {},
      readiness: async () => ({ status: 'ready' }),
      mint: async () => ({
        providerId: 'stale-cleanup',
        open: () =>
          new Promise<VoiceRealtimeConnection>((resolve) => {
            resolveOpen = resolve;
          }),
      }),
    };
    const adapter = new RealtimeVoiceSessionAdapter(provider);
    const starting = adapter.start();
    await Promise.resolve();
    await Promise.resolve();
    await expect(adapter.stop()).resolves.toMatchObject({ ok: true });
    resolveOpen?.(
      connectionWithClose(async () => {
        closeCalls += 1;
        if (closeCalls === 1) throw new Error('Bearer stale-close-secret');
      }),
    );

    await expect(starting).resolves.toMatchObject({ ok: false });
    await expect(adapter.stop()).resolves.toMatchObject({ ok: true });

    expect(closeCalls).toBe(2);
    expect(JSON.stringify(adapter.getSnapshot())).not.toContain(
      'stale-close-secret',
    );
  });

  it('maps each non-ready provider state to a typed, content-free error', async () => {
    const provider: VoiceRealtimeProvider = {
      descriptor: { id: 'limited', name: 'Limited' },
      capabilities: {},
      readiness: async () => ({
        status: 'rate-limited',
        reason: 'provider-rate-limited',
        retryAt: 1_700_000_000_000,
      }),
      mint: async () => {
        throw new Error('mint must not run when unready');
      },
    };
    const result = await new RealtimeVoiceSessionAdapter(provider).start();

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'rate-limited' },
    });
    if (!result.ok) expect(result.error.message).not.toContain('mint');
  });

  it('maps every closed readiness state without surfacing provider detail', async () => {
    const readinessStates: readonly Exclude<
      VoiceRealtimeReadiness,
      { status: 'ready' }
    >[] = [
      { status: 'unsupported', reason: 'provider-unsupported' },
      { status: 'unconfigured', reason: 'missing-configuration' },
      { status: 'unavailable', reason: 'service-unavailable' },
      {
        status: 'rate-limited',
        reason: 'provider-rate-limited',
        retryAt: 1_700_000_000_000,
      },
    ];

    for (const readiness of readinessStates) {
      const adapter = new RealtimeVoiceSessionAdapter({
        descriptor: { id: readiness.status, name: readiness.status },
        capabilities: {},
        readiness: async () => readiness,
        mint: async () => {
          throw new Error('Bearer secret-canary must not reach mint');
        },
      });
      const result = await adapter.start();
      expect(result).toMatchObject({
        ok: false,
        error: { code: readiness.status },
      });
      expect(JSON.stringify(result)).not.toContain('secret-canary');
    }
  });

  it('returns success after supported optional operations resolve', async () => {
    const provider = createFakeVoiceRealtimeProvider();
    const adapter = new RealtimeVoiceSessionAdapter(provider);
    await adapter.start();

    await expect(adapter.sendText({ text: 'turn' })).resolves.toMatchObject({
      ok: true,
    });
    await expect(
      adapter.updateContext({ locale: 'en-US' }),
    ).resolves.toMatchObject({
      ok: true,
    });
    await expect(adapter.interrupt()).resolves.toMatchObject({ ok: true });
  });

  it('does not open a second connection when already connected', async () => {
    const provider = createFakeVoiceRealtimeProvider();
    const adapter = new RealtimeVoiceSessionAdapter(provider);
    await adapter.start();
    await adapter.start();

    expect(provider.openCount).toBe(1);
  });

  it('can restart after stop using the same adapter instance', async () => {
    const provider = createFakeVoiceRealtimeProvider();
    const adapter = new RealtimeVoiceSessionAdapter(provider);
    await adapter.start();
    await adapter.stop();

    await expect(adapter.start()).resolves.toMatchObject({ ok: true });
    expect(provider.openCount).toBe(2);
  });

  it('deduplicates concurrent reconnects into one replacement', async () => {
    const provider = createFakeVoiceRealtimeProvider({ deferredOpen: true });
    const adapter = new RealtimeVoiceSessionAdapter(provider);
    const starting = adapter.start();
    provider.resolveOpen();
    await starting;

    const first = adapter.reconnect();
    const second = adapter.reconnect();

    expect(first).toBe(second);
    provider.resolveOpen();
    await first;
    expect(provider.openCount).toBe(2);
    expect(provider.closeCount).toBe(1);
  });

  it('aborts an in-flight mint and completes stop promptly', async () => {
    let mintSignal: AbortSignal | undefined;
    const provider: VoiceRealtimeProvider = {
      descriptor: { id: 'hung', name: 'Hung' },
      capabilities: {},
      readiness: async () => ({ status: 'ready' }),
      mint: ({ signal } = {}) => {
        mintSignal = signal;
        return new Promise((_, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      },
    };
    const adapter = new RealtimeVoiceSessionAdapter(provider);
    const starting = adapter.start();
    await Promise.resolve();
    await Promise.resolve();

    await expect(
      Promise.race([
        adapter.stop(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('stop timed out')), 25),
        ),
      ]),
    ).resolves.toMatchObject({ ok: true });
    expect(mintSignal?.aborted).toBe(true);
    await expect(starting).resolves.toMatchObject({ ok: false });
  });

  it('serializes an immediate restart behind an in-flight stop', async () => {
    let resolveFirstClose: (() => void) | undefined;
    let opens = 0;
    const provider: VoiceRealtimeProvider = {
      descriptor: { id: 'restart-race', name: 'Restart race' },
      capabilities: {},
      readiness: async () => ({ status: 'ready' }),
      mint: async () => ({
        providerId: 'restart-race',
        open: async () => {
          opens += 1;
          const currentOpen = opens;
          return connectionWithClose(async () => {
            if (currentOpen === 1) {
              await new Promise<void>((resolve) => {
                resolveFirstClose = resolve;
              });
            }
          });
        },
      }),
    };
    const adapter = new RealtimeVoiceSessionAdapter(provider);
    await adapter.start();

    const stopping = adapter.stop();
    const restarting = adapter.start();
    await Promise.resolve();
    await Promise.resolve();

    expect(opens).toBe(1);
    resolveFirstClose?.();
    await stopping;
    await expect(restarting).resolves.toMatchObject({ ok: true });
    expect(opens).toBe(2);
    expect(adapter.getSnapshot().state).toBe('connected-idle');
  });

  it('reopens after a provider disconnect instead of retaining a dead connection', async () => {
    const provider = createFakeVoiceRealtimeProvider();
    const adapter = new RealtimeVoiceSessionAdapter(provider);
    await adapter.start();
    provider.currentConnection.emit({ type: 'disconnect' });

    await adapter.start();

    expect(provider.openCount).toBe(2);
    expect(adapter.getSnapshot().state).toBe('connected-idle');
  });

  it('passes a deeply immutable context snapshot to a delayed mint', async () => {
    let resolveReadiness: (() => void) | undefined;
    let observedContext: Readonly<Record<string, unknown>> | undefined;
    const provider: VoiceRealtimeProvider = {
      descriptor: { id: 'context', name: 'Context' },
      capabilities: {},
      readiness: () =>
        new Promise((resolve) => {
          resolveReadiness = () => resolve({ status: 'ready' });
        }),
      mint: async (input) => {
        observedContext = input?.context;
        return {
          providerId: 'context',
          open: async () => connectionWithClose(async () => undefined),
        };
      },
    };
    const context = { nested: { locale: 'en-US' } };
    const adapter = new RealtimeVoiceSessionAdapter(provider);
    const starting = adapter.start({ context });
    context.nested.locale = 'changed';
    await Promise.resolve();
    await Promise.resolve();
    expect(resolveReadiness).toBeTypeOf('function');
    resolveReadiness?.();
    await starting;

    expect(observedContext).toEqual({ nested: { locale: 'en-US' } });
    expect(Object.isFrozen(observedContext?.nested)).toBe(true);
  });

  it('forwards speech and usage only from the current connection', async () => {
    const provider = createFakeVoiceRealtimeProvider();
    const speech: number[][] = [];
    const usage: unknown[] = [];
    const adapter = new RealtimeVoiceSessionAdapter(provider, {
      onSpeech: (audio) => speech.push([...audio]),
      onUsage: (event) => usage.push(event),
    });
    await adapter.start();
    const stale = provider.currentConnection;
    await adapter.reconnect();

    stale.emit({ type: 'speech', audio: new Uint8Array([1]) });
    stale.emit({ type: 'usage', inputAudioMs: 10 });
    provider.currentConnection.emit({
      type: 'speech',
      audio: new Uint8Array([2]),
    });
    provider.currentConnection.emit({
      type: 'usage',
      inputAudioMs: 20,
      outputAudioMs: 30,
    });

    expect(speech).toEqual([[2]]);
    expect(usage).toEqual([{ inputAudioMs: 20, outputAudioMs: 30 }]);
    expect(Object.isFrozen(usage[0])).toBe(true);
  });

  it('makes stop win over reconnect while close is delayed', async () => {
    let releaseClose: (() => void) | undefined;
    let opens = 0;
    const speech: number[][] = [];
    const usage: unknown[] = [];
    let emitCurrent:
      | ((
          event: import('../voice/realtime-types.js').VoiceRealtimeEvent,
        ) => void)
      | undefined;
    const provider: VoiceRealtimeProvider = {
      descriptor: { id: 'stop-wins', name: 'Stop wins' },
      capabilities: { audioInput: true },
      readiness: async () => ({ status: 'ready' }),
      mint: async () => ({
        providerId: 'stop-wins',
        open: async () => {
          opens += 1;
          const listeners = new Set<
            (
              event: import('../voice/realtime-types.js').VoiceRealtimeEvent,
            ) => void
          >();
          emitCurrent = (event) =>
            listeners.forEach((listener) => listener(event));
          return {
            subscribe: (listener) => {
              listeners.add(listener);
              return () => listeners.delete(listener);
            },
            sendAudio: async () => undefined,
            close: async () => {
              if (opens === 1) {
                await new Promise<void>((resolve) => {
                  releaseClose = resolve;
                });
              }
            },
          };
        },
      }),
    };
    const adapter = new RealtimeVoiceSessionAdapter(provider, {
      onSpeech: (audio) => speech.push([...audio]),
      onUsage: (next) => usage.push(next),
    });
    await adapter.start();

    const stopping = adapter.stop();
    const reconnecting = adapter.reconnect();
    await Promise.resolve();
    await Promise.resolve();
    expect(opens).toBe(1);
    releaseClose?.();

    await expect(stopping).resolves.toMatchObject({
      ok: true,
      snapshot: { state: 'disconnected' },
    });
    await expect(reconnecting).resolves.toMatchObject({
      ok: false,
      error: { code: 'unavailable', operation: 'reconnect' },
    });
    emitCurrent?.({ type: 'speech', audio: new Uint8Array([9]) });
    emitCurrent?.({ type: 'usage', inputAudioMs: 9 });
    expect(opens).toBe(1);
    expect(speech).toEqual([]);
    expect(usage).toEqual([]);
    expect(adapter.getSnapshot().state).toBe('disconnected');
    await expect(adapter.start()).resolves.toMatchObject({ ok: true });
    expect(opens).toBe(2);
  });

  it('sanitizes a close failure without losing retryable cleanup ownership', async () => {
    let closeAttempts = 0;
    const provider: VoiceRealtimeProvider = {
      descriptor: { id: 'close-failure', name: 'Close failure' },
      capabilities: {},
      readiness: async () => ({ status: 'ready' }),
      mint: async () => ({
        providerId: 'close-failure',
        open: async () =>
          connectionWithClose(async () => {
            closeAttempts += 1;
            if (closeAttempts === 1) throw new Error('Bearer secret-canary');
          }),
      }),
    };
    const adapter = new RealtimeVoiceSessionAdapter(provider);
    const snapshots = [adapter.getSnapshot()];
    adapter.subscribe(() => snapshots.push(adapter.getSnapshot()));
    await adapter.start();

    const first = await adapter.stop();
    expect(first).toMatchObject({
      ok: false,
      error: { code: 'unavailable', operation: 'stop' },
    });
    expect(JSON.stringify(first)).not.toContain('secret-canary');
    expect(adapter.getSnapshot()).toMatchObject({ state: 'error' });
    await expect(adapter.start()).resolves.toMatchObject({
      ok: false,
      error: { code: 'unavailable', operation: 'start' },
    });
    await expect(adapter.stop()).resolves.toMatchObject({
      ok: true,
      snapshot: { state: 'disconnected' },
    });
    expect(closeAttempts).toBe(2);
    expect(JSON.stringify(snapshots)).not.toContain('secret-canary');
  });

  it('sanitizes reconnect cleanup failures instead of rejecting with provider detail', async () => {
    const provider: VoiceRealtimeProvider = {
      descriptor: { id: 'reconnect-failure', name: 'Reconnect failure' },
      capabilities: {},
      readiness: async () => ({ status: 'ready' }),
      mint: async () => ({
        providerId: 'reconnect-failure',
        open: async () =>
          connectionWithClose(async () => {
            throw new Error('Bearer reconnect-secret');
          }),
      }),
    };
    const adapter = new RealtimeVoiceSessionAdapter(provider);
    await adapter.start();

    const result = await adapter.reconnect();

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'unavailable', operation: 'reconnect' },
    });
    expect(JSON.stringify(result)).not.toContain('reconnect-secret');
    expect(JSON.stringify(adapter.getSnapshot())).not.toContain(
      'reconnect-secret',
    );
  });

  it('rejects text and audio operations once stop has begun closing', async () => {
    let releaseClose: (() => void) | undefined;
    let textTurns = 0;
    let audioTurns = 0;
    const provider: VoiceRealtimeProvider = {
      descriptor: { id: 'closing', name: 'Closing' },
      capabilities: { textTurn: true, audioInput: true },
      readiness: async () => ({ status: 'ready' }),
      mint: async () => ({
        providerId: 'closing',
        open: async () => ({
          subscribe: () => () => undefined,
          sendText: async () => {
            textTurns += 1;
          },
          sendAudio: async () => {
            audioTurns += 1;
          },
          close: () =>
            new Promise<void>((resolve) => {
              releaseClose = resolve;
            }),
        }),
      }),
    };
    const adapter = new RealtimeVoiceSessionAdapter(provider);
    await adapter.start();

    const stopping = adapter.stop();
    await expect(adapter.sendText({ text: 'late' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'unavailable', operation: 'send-text' },
    });
    await expect(
      adapter.sendAudio({ audio: new Uint8Array([1]) }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'unavailable', operation: 'send-audio' },
    });
    expect(textTurns).toBe(0);
    expect(audioTurns).toBe(0);
    releaseClose?.();
    await stopping;
  });

  it('coalesces reconnect and stop cleanup for a non-reentrant connection close', async () => {
    let closeCalls = 0;
    let releaseClose: (() => void) | undefined;
    const provider: VoiceRealtimeProvider = {
      descriptor: { id: 'close-once', name: 'Close once' },
      capabilities: {},
      readiness: async () => ({ status: 'ready' }),
      mint: async () => ({
        providerId: 'close-once',
        open: async () =>
          connectionWithClose(async () => {
            closeCalls += 1;
            await new Promise<void>((resolve) => {
              releaseClose = resolve;
            });
          }),
      }),
    };
    const adapter = new RealtimeVoiceSessionAdapter(provider);
    await adapter.start();

    const reconnecting = adapter.reconnect();
    await Promise.resolve();
    const stopping = adapter.stop();
    await Promise.resolve();
    await Promise.resolve();

    expect(closeCalls).toBe(1);
    releaseClose?.();
    await expect(stopping).resolves.toMatchObject({ ok: true });
    await expect(reconnecting).resolves.toMatchObject({ ok: false });
    expect(closeCalls).toBe(1);
  });

  it('closes a connection when subscription attachment throws', async () => {
    let closeCalls = 0;
    const provider: VoiceRealtimeProvider = {
      descriptor: { id: 'subscribe-throws', name: 'Subscribe throws' },
      capabilities: {},
      readiness: async () => ({ status: 'ready' }),
      mint: async () => ({
        providerId: 'subscribe-throws',
        open: async () => ({
          subscribe: () => {
            throw new Error('Bearer subscribe-secret');
          },
          close: async () => {
            closeCalls += 1;
          },
        }),
      }),
    };
    const adapter = new RealtimeVoiceSessionAdapter(provider);

    const result = await adapter.start();

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'unavailable', operation: 'start' },
    });
    expect(closeCalls).toBe(1);
    expect(JSON.stringify(result)).not.toContain('subscribe-secret');
  });

  it('continues close when a subscription disposer throws', async () => {
    let unsubscribeCalls = 0;
    let closeCalls = 0;
    const provider: VoiceRealtimeProvider = {
      descriptor: { id: 'unsubscribe-throws', name: 'Unsubscribe throws' },
      capabilities: {},
      readiness: async () => ({ status: 'ready' }),
      mint: async () => ({
        providerId: 'unsubscribe-throws',
        open: async () => ({
          subscribe: () => () => {
            unsubscribeCalls += 1;
            throw new Error('Bearer unsubscribe-secret');
          },
          close: async () => {
            closeCalls += 1;
          },
        }),
      }),
    };
    const adapter = new RealtimeVoiceSessionAdapter(provider);
    await adapter.start();

    const result = await adapter.stop();

    expect(result).toMatchObject({ ok: true });
    expect(unsubscribeCalls).toBe(1);
    expect(closeCalls).toBe(1);
    expect(JSON.stringify(result)).not.toContain('unsubscribe-secret');
  });

  it('retains cleanup ownership when subscribe and its first close both throw', async () => {
    let closeCalls = 0;
    const provider: VoiceRealtimeProvider = {
      descriptor: { id: 'attach-cleanup-fails', name: 'Attach cleanup fails' },
      capabilities: {},
      readiness: async () => ({ status: 'ready' }),
      mint: async () => ({
        providerId: 'attach-cleanup-fails',
        open: async () => ({
          subscribe: () => {
            throw new Error('Bearer subscribe-secret');
          },
          close: async () => {
            closeCalls += 1;
            if (closeCalls === 1) throw new Error('Bearer close-secret');
          },
        }),
      }),
    };
    const adapter = new RealtimeVoiceSessionAdapter(provider);

    await expect(adapter.start()).resolves.toMatchObject({ ok: false });
    await expect(adapter.stop()).resolves.toMatchObject({ ok: true });

    expect(closeCalls).toBe(2);
    expect(JSON.stringify(adapter.getSnapshot())).not.toMatch(
      /subscribe-secret|close-secret/,
    );
  });

  it('does not overwrite a synchronous disconnect emitted during subscription', async () => {
    let opens = 0;
    let closes = 0;
    const provider: VoiceRealtimeProvider = {
      descriptor: { id: 'sync-disconnect', name: 'Sync disconnect' },
      capabilities: {},
      readiness: async () => ({ status: 'ready' }),
      mint: async () => ({
        providerId: 'sync-disconnect',
        open: async () => {
          opens += 1;
          return {
            subscribe: (listener) => {
              listener({ type: 'disconnect' });
              return () => undefined;
            },
            close: async () => {
              closes += 1;
            },
          };
        },
      }),
    };
    const adapter = new RealtimeVoiceSessionAdapter(provider);

    await expect(adapter.start()).resolves.toMatchObject({ ok: false });
    await expect(adapter.start()).resolves.toMatchObject({ ok: false });

    expect(opens).toBe(2);
    expect(closes).toBe(2);
    expect(adapter.getSnapshot().state).not.toBe('connected-idle');
  });

  it('isolates a throwing unsubscriber on provider disconnect and still closes', async () => {
    let emitDisconnect: (() => void) | undefined;
    let unsubscribeCalls = 0;
    let closeCalls = 0;
    const provider: VoiceRealtimeProvider = {
      descriptor: { id: 'disconnect-cleanup', name: 'Disconnect cleanup' },
      capabilities: {},
      readiness: async () => ({ status: 'ready' }),
      mint: async () => ({
        providerId: 'disconnect-cleanup',
        open: async () => ({
          subscribe: (listener) => {
            emitDisconnect = () => listener({ type: 'disconnect' });
            return () => {
              unsubscribeCalls += 1;
              throw new Error('Bearer disconnect-unsubscribe-secret');
            };
          },
          close: async () => {
            closeCalls += 1;
          },
        }),
      }),
    };
    const adapter = new RealtimeVoiceSessionAdapter(provider);
    await adapter.start();

    emitDisconnect?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(adapter.getSnapshot().state).toBe('disconnected');
    expect(unsubscribeCalls).toBe(1);
    expect(closeCalls).toBe(1);
    expect(JSON.stringify(adapter.getSnapshot())).not.toContain(
      'disconnect-unsubscribe-secret',
    );
  });

  it('serializes provider-neutral audio input through the live connection', async () => {
    const provider = createFakeVoiceRealtimeProvider();
    const adapter = new RealtimeVoiceSessionAdapter(provider);
    await adapter.start();

    await expect(
      adapter.sendAudio({ audio: new Uint8Array([1, 2]) }),
    ).resolves.toMatchObject({ ok: true });
    expect(provider.currentConnection.operations).toContain('send-audio');
  });
});

function connectionWithClose(
  close: () => Promise<void>,
): VoiceRealtimeConnection {
  return {
    subscribe: () => () => undefined,
    close,
  };
}
