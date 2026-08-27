import { describe, expect, it, vi } from 'vitest';
import { VoiceSessionAdapterRegistry } from '../voice/session-registry.js';
import type {
  VoiceSessionAdapter,
  VoiceSessionOperationResult,
  VoiceSessionSnapshot,
} from '../voice/session-types.js';

function success(snapshot: VoiceSessionSnapshot): VoiceSessionOperationResult {
  return { ok: true, snapshot };
}

function makeAdapter(id: string, name = id): VoiceSessionAdapter {
  let snapshot: VoiceSessionSnapshot = { state: 'disconnected', revision: 0 };
  return {
    descriptor: { id, name },
    capabilities: {},
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    start: async () => {
      snapshot = {
        ...snapshot,
        state: 'connected-idle',
        revision: snapshot.revision + 1,
      };
      return success(snapshot);
    },
    stop: async () => {
      snapshot = {
        ...snapshot,
        state: 'disconnected',
        revision: snapshot.revision + 1,
      };
      return success(snapshot);
    },
  };
}

describe('VoiceSessionAdapterRegistry', () => {
  it('disposes each registration by identity and leaves other adapters live', () => {
    const registry = new VoiceSessionAdapterRegistry();
    const first = makeAdapter('first');
    const second = makeAdapter('second');
    const firstHandle = registry.register(first);
    const secondHandle = registry.register(second);

    firstHandle.dispose();
    firstHandle.dispose();

    expect(registry.get('first')).toBeUndefined();
    expect(registry.get('second')).toBe(second);
    secondHandle.dispose();
    expect(registry.getAll()).toEqual([]);
  });

  it('uses the newest live duplicate and reveals the preceding registration on disposal', () => {
    const registry = new VoiceSessionAdapterRegistry();
    const previous = makeAdapter('same', 'Previous');
    const winner = makeAdapter('same', 'Winner');
    const previousHandle = registry.register(previous);
    const winnerHandle = registry.register(winner);

    expect(registry.get('same')).toBe(winner);
    previousHandle.dispose();
    expect(registry.get('same')).toBe(winner);
    winnerHandle.dispose();
    expect(registry.get('same')).toBeUndefined();
  });

  it('preserves a stable immutable list until the visible registrations change', () => {
    const registry = new VoiceSessionAdapterRegistry();
    const first = makeAdapter('same', 'First');
    const firstHandle = registry.register(first);
    const before = registry.getAll();
    const shadowedHandle = registry.register(makeAdapter('same', 'Newest'));
    const visible = registry.getAll();
    const listener = vi.fn();
    registry.subscribe(listener);

    firstHandle.dispose();
    expect(registry.getAll()).toBe(visible);
    expect(listener).not.toHaveBeenCalled();
    expect(Object.isFrozen(before)).toBe(true);
    expect(Object.isFrozen(visible)).toBe(true);

    shadowedHandle.dispose();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('removes disposed entries through repeated registration churn', () => {
    const registry = new VoiceSessionAdapterRegistry();
    const durable = makeAdapter('durable');
    registry.register(durable);

    for (let index = 0; index < 100; index += 1) {
      const handle = registry.register(makeAdapter(`transient-${index}`));
      handle.dispose();
    }

    expect(registry.getAll()).toEqual([durable]);
    expect(registry.get('durable')).toBe(durable);
    expect(
      (registry as unknown as { entries: unknown[] }).entries,
    ).toHaveLength(1);
  });
});
