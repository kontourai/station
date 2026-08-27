import { describe, expect, it, vi } from 'vitest';
import { VoiceSessionManager } from '../voice/session-manager.js';
import { VoiceSessionAdapterRegistry } from '../voice/session-registry.js';
import type {
  VoiceSessionAdapter,
  VoiceSessionLifecycleState,
  VoiceSessionOperationResult,
  VoiceSessionSnapshot,
} from '../voice/session-types.js';
import { VoiceSessionError } from '../voice/session-types.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function result(snapshot: VoiceSessionSnapshot): VoiceSessionOperationResult {
  return { ok: true, snapshot };
}

function makeAdapter(
  id: string,
  options: {
    interrupt?: boolean;
    reconnect?: boolean;
    audioInput?: boolean;
    delayedStart?: boolean;
    delayedRestart?: boolean;
    delayedStop?: boolean;
    failStartAttempts?: number;
    failStartResultAttempts?: number;
    failStopAttempts?: number;
    failStopResultAttempts?: number;
  } = {},
) {
  let snapshot: VoiceSessionSnapshot = { state: 'disconnected', revision: 0 };
  let listener: (() => void) | undefined;
  const startDeferred = deferred<VoiceSessionOperationResult>();
  const restartDeferred = deferred<VoiceSessionOperationResult>();
  const stopDeferred = deferred<void>();
  let successfulStartAttempts = 0;
  let failuresRemaining = options.failStartAttempts ?? 0;
  let failedResultsRemaining = options.failStartResultAttempts ?? 0;
  let stopFailuresRemaining = options.failStopAttempts ?? 0;
  let failedStopResultsRemaining = options.failStopResultAttempts ?? 0;
  const emit = (state: VoiceSessionLifecycleState) => {
    snapshot = {
      ...snapshot,
      state,
      revision: snapshot.revision + 1,
    };
    listener?.();
  };
  const adapter: VoiceSessionAdapter = {
    descriptor: { id, name: id },
    capabilities: {
      interrupt: options.interrupt ?? false,
      reconnect: options.reconnect ?? false,
      audioInput: options.audioInput ?? false,
    },
    getSnapshot: () => snapshot,
    subscribe: (next) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    start: vi.fn(async () => {
      if (failuresRemaining > 0) {
        failuresRemaining -= 1;
        throw new Error('start failed');
      }
      if (failedResultsRemaining > 0) {
        failedResultsRemaining -= 1;
        return {
          ok: false as const,
          error: new VoiceSessionError(
            'operation-failed',
            'start failed',
            'start',
          ),
        };
      }
      snapshot = {
        ...snapshot,
        state: 'connecting',
        revision: snapshot.revision + 1,
      };
      listener?.();
      if (options.delayedStart) return startDeferred.promise;
      successfulStartAttempts += 1;
      if (options.delayedRestart && successfulStartAttempts > 1) {
        return restartDeferred.promise;
      }
      snapshot = {
        ...snapshot,
        state: 'connected-idle',
        revision: snapshot.revision + 1,
      };
      listener?.();
      return result(snapshot);
    }),
    stop: vi.fn(async () => {
      if (options.delayedStop) await stopDeferred.promise;
      if (stopFailuresRemaining > 0) {
        stopFailuresRemaining -= 1;
        throw new Error('stop failed');
      }
      if (failedStopResultsRemaining > 0) {
        failedStopResultsRemaining -= 1;
        return {
          ok: false as const,
          error: new VoiceSessionError(
            'operation-failed',
            'stop failed',
            'stop',
          ),
        };
      }
      snapshot = {
        ...snapshot,
        state: 'disconnected',
        revision: snapshot.revision + 1,
      };
      listener?.();
      return result(snapshot);
    }),
  };
  if (options.interrupt) {
    adapter.interrupt = vi.fn(async () => result(snapshot));
  }
  if (options.reconnect) {
    adapter.reconnect = vi.fn(async () => result(snapshot));
  }
  if (options.audioInput) {
    adapter.sendAudio = vi.fn(async () => result(snapshot));
  }
  return { adapter, emit, restartDeferred, startDeferred, stopDeferred };
}

function makeEmittingAdapter(id: string) {
  const controlSessionId = 'control-session';
  const conversationSessionId = 'conversation-session';
  let listener: (() => void) | undefined;
  let snapshot: VoiceSessionSnapshot = {
    state: 'disconnected',
    revision: 0,
    controlSessionId,
    conversationSessionId,
  };
  const emit = (state: VoiceSessionLifecycleState) => {
    snapshot = {
      ...snapshot,
      state,
      revision: snapshot.revision + 1,
    };
    listener?.();
  };
  const adapter: VoiceSessionAdapter = {
    descriptor: { id, name: id },
    capabilities: {},
    getSnapshot: () => snapshot,
    subscribe: (next) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    start: vi.fn(async () => {
      snapshot = {
        ...snapshot,
        state: 'connected-idle',
        revision: snapshot.revision + 1,
      };
      return result(snapshot);
    }),
    stop: vi.fn(async () => {
      snapshot = {
        ...snapshot,
        state: 'disconnected',
        revision: snapshot.revision + 1,
      };
      return result(snapshot);
    }),
  };
  return { adapter, controlSessionId, conversationSessionId, emit };
}

describe('VoiceSessionManager', () => {
  it('returns typed unavailable outcomes without a selected live adapter', async () => {
    const manager = new VoiceSessionManager(new VoiceSessionAdapterRegistry());

    await expect(manager.start()).resolves.toMatchObject({
      ok: false,
      error: { code: 'unavailable' },
    });
    await expect(manager.interrupt()).resolves.toMatchObject({
      ok: false,
      error: { code: 'unavailable' },
    });
  });

  it('coalesces repeated starts and serializes stop after a deferred start', async () => {
    const registry = new VoiceSessionAdapterRegistry();
    const { adapter, startDeferred } = makeAdapter('one', {
      delayedStart: true,
    });
    registry.register(adapter);
    const manager = new VoiceSessionManager(registry);
    manager.select('one');

    const firstStart = manager.start();
    const duplicateStart = manager.start();
    expect(firstStart).toBe(duplicateStart);
    await vi.waitFor(() => expect(adapter.start).toHaveBeenCalledTimes(1));
    const stop = manager.stop();
    expect(adapter.stop).not.toHaveBeenCalled();

    startDeferred.resolve(result({ state: 'connected-idle', revision: 2 }));
    await expect(stop).resolves.toMatchObject({
      ok: true,
      snapshot: { state: 'disconnected' },
    });
    await firstStart;
    expect(adapter.stop).toHaveBeenCalledTimes(1);
    expect(manager.getSnapshot().state).toBe('disconnected');
  });

  it('cancels start when stop wins before provider invocation', async () => {
    const registry = new VoiceSessionAdapterRegistry();
    const { adapter } = makeAdapter('one');
    registry.register(adapter);
    const manager = new VoiceSessionManager(registry);
    manager.select('one');

    const start = manager.start();
    const stop = manager.stop();

    await expect(start).resolves.toMatchObject({
      ok: false,
      error: { code: 'unavailable', operation: 'start' },
    });
    await expect(stop).resolves.toMatchObject({
      ok: true,
      snapshot: { state: 'disconnected' },
    });
    expect(adapter.start).not.toHaveBeenCalled();
    expect(adapter.stop).not.toHaveBeenCalled();
  });

  it('does not let a stale start completion overwrite newer stop intent', async () => {
    const registry = new VoiceSessionAdapterRegistry();
    const { adapter, startDeferred } = makeAdapter('one', {
      delayedStart: true,
    });
    registry.register(adapter);
    const manager = new VoiceSessionManager(registry);
    manager.select('one');

    const start = manager.start();
    const stop = manager.stop();
    startDeferred.resolve(result({ state: 'speaking', revision: 5 }));
    await Promise.all([start, stop]);

    expect(manager.getSnapshot().state).toBe('disconnected');
    expect(manager.getSnapshot().revision).toBeGreaterThan(0);
  });

  it('projects the full immutable revisioned lifecycle matrix without conflating IDs', async () => {
    const registry = new VoiceSessionAdapterRegistry();
    const { adapter, controlSessionId, conversationSessionId, emit } =
      makeEmittingAdapter('matrix');
    registry.register(adapter);
    const manager = new VoiceSessionManager(registry);
    const observed: VoiceSessionSnapshot[] = [manager.getSnapshot()];
    manager.subscribe(() => observed.push(manager.getSnapshot()));
    manager.select('matrix');

    await manager.start();
    emit('listening');
    emit('transcribing');
    emit('thinking');
    emit('speaking');
    emit('error');
    await manager.stop();

    expect(new Set(observed.map((snapshot) => snapshot.state))).toEqual(
      new Set([
        'disconnected',
        'connecting',
        'connected-idle',
        'listening',
        'transcribing',
        'thinking',
        'speaking',
        'stopping',
        'error',
      ]),
    );
    expect(observed.every(Object.isFrozen)).toBe(true);
    expect(
      observed
        .slice(1)
        .every(
          (snapshot, index) => snapshot.revision > observed[index].revision,
        ),
    ).toBe(true);
    expect(
      observed
        .slice(1)
        .every((snapshot) => snapshot.controlSessionId === controlSessionId),
    ).toBe(true);
    expect(
      observed
        .slice(1)
        .every(
          (snapshot) =>
            snapshot.conversationSessionId === conversationSessionId,
        ),
    ).toBe(true);
    expect(controlSessionId).not.toBe(conversationSessionId);
  });

  it('retains the active adapter through deselection, reselection, and unregister', async () => {
    const registry = new VoiceSessionAdapterRegistry();
    const first = makeAdapter('first');
    const second = makeAdapter('second');
    const firstHandle = registry.register(first.adapter);
    registry.register(second.adapter);
    const manager = new VoiceSessionManager(registry);
    manager.select('first');
    await manager.start();

    manager.select(undefined);
    firstHandle.dispose();
    manager.select('second');
    await manager.stop();

    expect(first.adapter.stop).toHaveBeenCalledTimes(1);
    expect(second.adapter.stop).not.toHaveBeenCalled();
    await manager.start();
    expect(second.adapter.start).toHaveBeenCalledTimes(1);
  });

  it('returns typed unsupported results for absent optional operations', async () => {
    const registry = new VoiceSessionAdapterRegistry();
    const { adapter } = makeAdapter('one');
    registry.register(adapter);
    const manager = new VoiceSessionManager(registry);
    manager.select('one');
    await manager.start();

    await expect(manager.interrupt()).resolves.toMatchObject({
      ok: false,
      error: { code: 'unsupported' },
    });
    await expect(manager.reconnect()).resolves.toMatchObject({
      ok: false,
      error: { code: 'unsupported' },
    });
    await expect(
      manager.updateContext({ topic: 'hello' }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'unsupported' },
    });
    await expect(manager.sendText({ text: 'hello' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'unsupported' },
    });
  });

  it('routes provider-neutral audio input only to an enabled live adapter', async () => {
    const registry = new VoiceSessionAdapterRegistry();
    const { adapter } = makeAdapter('audio', { audioInput: true });
    registry.register(adapter);
    const manager = new VoiceSessionManager(registry);
    manager.select('audio');
    await manager.start();

    await expect(
      manager.sendAudio({ audio: new Uint8Array([1, 2]) }),
    ).resolves.toMatchObject({ ok: true });
    expect(adapter.sendAudio).toHaveBeenCalledWith({
      audio: new Uint8Array([1, 2]),
    });
  });

  it('routes reconnect through the selected active adapter', async () => {
    const registry = new VoiceSessionAdapterRegistry();
    const { adapter } = makeAdapter('one', { reconnect: true });
    registry.register(adapter);
    const manager = new VoiceSessionManager(registry);
    manager.select('one');
    await manager.start();

    await expect(manager.reconnect()).resolves.toMatchObject({ ok: true });

    expect(adapter.reconnect).toHaveBeenCalledTimes(1);
  });

  it('sanitizes errors thrown by an adapter optional operation', async () => {
    const registry = new VoiceSessionAdapterRegistry();
    const { adapter } = makeAdapter('one', { reconnect: true });
    adapter.reconnect = vi.fn(async () => {
      throw new Error('Bearer manager-secret');
    });
    registry.register(adapter);
    const manager = new VoiceSessionManager(registry);
    manager.select('one');
    await manager.start();

    const result = await manager.reconnect();

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'operation-failed', operation: 'reconnect' },
    });
    if (!result.ok) {
      expect(result.error.message).toBe('Voice-session operation failed.');
      expect(result.error.cause).toBeUndefined();
    }
    expect(JSON.stringify(result)).not.toContain('manager-secret');
    expect(manager.getSnapshot().error?.message).toBe(
      'Voice-session operation failed.',
    );
    expect(JSON.stringify(manager.getSnapshot())).not.toContain(
      'manager-secret',
    );
  });

  it('continues projecting adapter snapshots after an optional operation', async () => {
    const registry = new VoiceSessionAdapterRegistry();
    const { adapter, emit } = makeAdapter('one', { interrupt: true });
    registry.register(adapter);
    const manager = new VoiceSessionManager(registry);
    manager.select('one');

    await manager.start();
    await manager.interrupt();
    emit('speaking');

    expect(manager.getSnapshot().state).toBe('speaking');
  });

  it('settles stop before reporting a later optional request as unavailable', async () => {
    const registry = new VoiceSessionAdapterRegistry();
    const { adapter, stopDeferred } = makeAdapter('one', {
      interrupt: true,
      delayedStop: true,
    });
    registry.register(adapter);
    const manager = new VoiceSessionManager(registry);
    manager.select('one');
    await manager.start();

    const stop = manager.stop();
    const interrupt = manager.interrupt();
    await Promise.resolve();
    stopDeferred.resolve();

    await expect(stop).resolves.toMatchObject({
      ok: true,
      snapshot: { state: 'disconnected' },
    });
    await expect(interrupt).resolves.toMatchObject({
      ok: false,
      error: { code: 'unavailable' },
    });
    expect(manager.getSnapshot().state).toBe('disconnected');
  });

  it('cleans up a failed start so a later retry invokes the adapter again', async () => {
    const registry = new VoiceSessionAdapterRegistry();
    const { adapter } = makeAdapter('one', { failStartAttempts: 1 });
    registry.register(adapter);
    const manager = new VoiceSessionManager(registry);
    manager.select('one');

    await expect(manager.start()).resolves.toMatchObject({
      ok: false,
      error: { code: 'operation-failed', operation: 'start' },
    });
    await expect(manager.start()).resolves.toMatchObject({ ok: true });
    expect(adapter.start).toHaveBeenCalledTimes(2);
    expect(manager.getSnapshot().state).toBe('connected-idle');
  });

  it('also releases a typed failed start result before retrying', async () => {
    const registry = new VoiceSessionAdapterRegistry();
    const { adapter } = makeAdapter('one', { failStartResultAttempts: 1 });
    registry.register(adapter);
    const manager = new VoiceSessionManager(registry);
    manager.select('one');

    await expect(manager.start()).resolves.toMatchObject({ ok: false });
    await expect(manager.start()).resolves.toMatchObject({ ok: true });
    expect(adapter.start).toHaveBeenCalledTimes(2);
  });

  it('serializes start requested during stop as one real coalesced restart', async () => {
    const registry = new VoiceSessionAdapterRegistry();
    const { adapter, stopDeferred } = makeAdapter('one', { delayedStop: true });
    registry.register(adapter);
    const manager = new VoiceSessionManager(registry);
    manager.select('one');
    await manager.start();

    const stop = manager.stop();
    const restart = manager.start();
    expect(manager.start()).toBe(restart);
    await Promise.resolve();
    stopDeferred.resolve();

    await expect(stop).resolves.toMatchObject({ ok: true });
    await expect(restart).resolves.toMatchObject({
      ok: true,
      snapshot: { state: 'connected-idle' },
    });
    expect(adapter.start).toHaveBeenCalledTimes(2);
    expect(manager.getSnapshot().state).toBe('connected-idle');
  });

  it('keeps coalescing duplicate starts after a queued restart begins', async () => {
    const registry = new VoiceSessionAdapterRegistry();
    const { adapter, restartDeferred, stopDeferred } = makeAdapter('one', {
      delayedRestart: true,
      delayedStop: true,
    });
    registry.register(adapter);
    const manager = new VoiceSessionManager(registry);
    manager.select('one');
    await manager.start();

    const stop = manager.stop();
    const restart = manager.start();
    stopDeferred.resolve();
    await expect(stop).resolves.toMatchObject({ ok: true });
    await vi.waitFor(() => expect(adapter.start).toHaveBeenCalledTimes(2));

    const duplicate = manager.start();
    expect(duplicate).toBe(restart);
    let settled = false;
    void duplicate.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    restartDeferred.resolve(result({ state: 'connected-idle', revision: 4 }));
    await expect(restart).resolves.toMatchObject({
      ok: true,
      snapshot: { state: 'connected-idle' },
    });
  });

  it('queues a distinct restart when a pending start is followed by stop', async () => {
    const registry = new VoiceSessionAdapterRegistry();
    const { adapter, startDeferred } = makeAdapter('one', {
      delayedStart: true,
    });
    registry.register(adapter);
    const manager = new VoiceSessionManager(registry);
    manager.select('one');

    const firstStart = manager.start();
    await vi.waitFor(() => expect(adapter.start).toHaveBeenCalledTimes(1));
    const stop = manager.stop();
    const restart = manager.start();
    expect(restart).not.toBe(firstStart);
    expect(manager.start()).toBe(restart);
    startDeferred.resolve(result({ state: 'connected-idle', revision: 2 }));

    await expect(firstStart).resolves.toMatchObject({ ok: true });
    await expect(stop).resolves.toMatchObject({ ok: true });
    await expect(restart).resolves.toMatchObject({ ok: true });
    expect(adapter.start).toHaveBeenCalledTimes(2);
    expect(manager.getSnapshot().state).toBe('connected-idle');
  });

  it('does not replace a retained session when its queued stop restart fails', async () => {
    const registry = new VoiceSessionAdapterRegistry();
    const { adapter } = makeAdapter('one', { failStopResultAttempts: 1 });
    registry.register(adapter);
    const manager = new VoiceSessionManager(registry);
    manager.select('one');
    await manager.start();

    const stop = manager.stop();
    const restart = manager.start();

    await expect(stop).resolves.toMatchObject({
      ok: false,
      error: { code: 'operation-failed', operation: 'stop' },
    });
    await expect(restart).resolves.toMatchObject({
      ok: false,
      error: { code: 'unavailable', operation: 'start' },
    });
    expect(adapter.start).toHaveBeenCalledTimes(1);

    await expect(manager.stop()).resolves.toMatchObject({ ok: true });
    expect(adapter.stop).toHaveBeenCalledTimes(2);
  });

  it('binds a new restart to a retried stop after the prior stop failed', async () => {
    const registry = new VoiceSessionAdapterRegistry();
    const { adapter } = makeAdapter('one', { failStopResultAttempts: 1 });
    registry.register(adapter);
    const manager = new VoiceSessionManager(registry);
    manager.select('one');
    await manager.start();

    const failedStop = manager.stop();
    const doomedRestart = manager.start();
    await expect(failedStop).resolves.toMatchObject({ ok: false });

    const retryStop = manager.stop();
    const retryRestart = manager.start();
    expect(retryRestart).not.toBe(doomedRestart);

    await expect(doomedRestart).resolves.toMatchObject({
      ok: false,
      error: { code: 'unavailable', operation: 'start' },
    });
    await expect(retryStop).resolves.toMatchObject({ ok: true });
    await expect(retryRestart).resolves.toMatchObject({
      ok: true,
      snapshot: { state: 'connected-idle' },
    });
    expect(adapter.start).toHaveBeenCalledTimes(2);
    expect(manager.getSnapshot().state).toBe('connected-idle');
  });

  it('cancels a queued start when disposed before provider invocation', async () => {
    const registry = new VoiceSessionAdapterRegistry();
    const { adapter } = makeAdapter('one');
    registry.register(adapter);
    const manager = new VoiceSessionManager(registry);
    manager.select('one');

    const start = manager.start();
    const disposal = manager.dispose();

    await expect(start).resolves.toMatchObject({
      ok: false,
      error: { code: 'unavailable', operation: 'start' },
    });
    expect(adapter.start).not.toHaveBeenCalled();
    expect(adapter.stop).not.toHaveBeenCalled();
    await expect(disposal).resolves.toMatchObject({ ok: true });
    expect(manager.getSnapshot().state).toBe('disconnected');
    await expect(manager.start()).resolves.toMatchObject({ ok: false });
  });

  it('stops a provider whose start was in flight when the manager was disposed', async () => {
    const registry = new VoiceSessionAdapterRegistry();
    const { adapter, startDeferred } = makeAdapter('one', {
      delayedStart: true,
    });
    registry.register(adapter);
    const manager = new VoiceSessionManager(registry);
    manager.select('one');

    const start = manager.start();
    await vi.waitFor(() => expect(adapter.start).toHaveBeenCalledTimes(1));
    const disposal = manager.dispose();
    startDeferred.resolve(result({ state: 'connected-idle', revision: 2 }));

    await expect(start).resolves.toMatchObject({
      ok: false,
      error: { code: 'unavailable', operation: 'start' },
    });
    await expect(disposal).resolves.toMatchObject({ ok: true });
    await vi.waitFor(() => expect(adapter.stop).toHaveBeenCalledTimes(1));
    expect(manager.getSnapshot().state).toBe('disconnected');
  });

  it('stops an active provider exactly once when disposed during stop', async () => {
    const registry = new VoiceSessionAdapterRegistry();
    const { adapter, stopDeferred } = makeAdapter('one', {
      delayedStop: true,
    });
    registry.register(adapter);
    const manager = new VoiceSessionManager(registry);
    manager.select('one');
    await manager.start();

    const stop = manager.stop();
    await vi.waitFor(() => expect(adapter.stop).toHaveBeenCalledTimes(1));
    const disposal = manager.dispose();
    stopDeferred.resolve();

    await expect(stop).resolves.toMatchObject({ ok: true });
    await expect(disposal).resolves.toMatchObject({ ok: true });
    expect(adapter.stop).toHaveBeenCalledTimes(1);
    expect(manager.getSnapshot().state).toBe('disconnected');
  });

  it.each([
    ['typed failure', { failStopResultAttempts: 1 }],
    ['thrown failure', { failStopAttempts: 1 }],
  ])(
    'reports and retries disposal cleanup after a %s',
    async (_label, options) => {
      const registry = new VoiceSessionAdapterRegistry();
      const { adapter } = makeAdapter('one', options);
      registry.register(adapter);
      const manager = new VoiceSessionManager(registry);
      manager.select('one');
      await manager.start();

      const firstDisposal = manager.dispose();
      expect(manager.getSnapshot().state).toBe('stopping');
      await expect(firstDisposal).resolves.toMatchObject({
        ok: false,
        error: { code: 'operation-failed', operation: 'stop' },
      });
      expect(manager.getSnapshot().state).toBe('error');
      expect(adapter.stop).toHaveBeenCalledTimes(1);

      await expect(manager.dispose()).resolves.toMatchObject({
        ok: true,
        snapshot: { state: 'disconnected' },
      });
      expect(adapter.stop).toHaveBeenCalledTimes(2);
      expect(manager.getSnapshot().state).toBe('disconnected');
    },
  );

  it('routes stop through retained disposal cleanup instead of false success', async () => {
    const registry = new VoiceSessionAdapterRegistry();
    const { adapter } = makeAdapter('one', { failStopResultAttempts: 2 });
    registry.register(adapter);
    const manager = new VoiceSessionManager(registry);
    manager.select('one');
    await manager.start();

    await expect(manager.dispose()).resolves.toMatchObject({ ok: false });
    expect(manager.getSnapshot().state).toBe('error');

    await expect(manager.stop()).resolves.toMatchObject({
      ok: false,
      error: { code: 'operation-failed', operation: 'stop' },
    });
    expect(manager.getSnapshot().state).toBe('error');

    await expect(manager.dispose()).resolves.toMatchObject({
      ok: true,
      snapshot: { state: 'disconnected' },
    });
    expect(adapter.stop).toHaveBeenCalledTimes(3);
  });
});
