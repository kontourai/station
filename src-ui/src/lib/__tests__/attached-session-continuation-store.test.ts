import { describe, expect, test, vi } from 'vitest';
import {
  ATTACHED_SESSION_CONTINUATION_STORAGE_KEY,
  type AttachedSessionContinuationExclusiveLock,
  type AttachedSessionContinuationStorage,
  createAttachedSessionContinuationStore,
} from '../attached-session-continuation-store';

const firstId = '00000000-0000-4000-8000-000000000001';
const secondId = '00000000-0000-4000-8000-000000000002';
const firstOperation = `starter-session:${firstId}`;
const secondOperation = `starter-session:${secondId}`;

function memoryStorage(initial?: string): {
  storage: AttachedSessionContinuationStorage;
  writes: string[];
  raw: () => string | null;
} {
  let value = initial ?? null;
  const writes: string[] = [];
  return {
    storage: {
      getItem: (key) => {
        if (key !== ATTACHED_SESSION_CONTINUATION_STORAGE_KEY)
          throw new Error('unexpected key');
        return value;
      },
      setItem: (key, next) => {
        if (key !== ATTACHED_SESSION_CONTINUATION_STORAGE_KEY)
          throw new Error('unexpected key');
        writes.push(next);
        value = next;
      },
      removeItem: (key) => {
        if (key !== ATTACHED_SESSION_CONTINUATION_STORAGE_KEY)
          throw new Error('unexpected key');
        value = null;
      },
    },
    writes,
    raw: () => value,
  };
}

const exclusiveLock: AttachedSessionContinuationExclusiveLock = {
  request: async (_name, _options, callback) => callback(),
};

function queuedExclusiveLock(): AttachedSessionContinuationExclusiveLock {
  let tail = Promise.resolve();
  return {
    async request(_name, _options, callback) {
      const previous = tail;
      let release: (() => void) | undefined;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await callback();
      } finally {
        release?.();
      }
    },
  };
}

function documentFor(sessions: Record<string, string>): string {
  return JSON.stringify({
    schemaVersion: 1,
    sessions: Object.fromEntries(
      Object.entries(sessions).map(([sessionId, operationId]) => [
        sessionId,
        { operationId },
      ]),
    ),
  });
}

describe('Attached Session continuation store', () => {
  test('reserves, reads, and reuses the exact Session operation', async () => {
    const { storage, raw } = memoryStorage();
    const store = createAttachedSessionContinuationStore({
      storage,
      lock: exclusiveLock,
      createUuid: () => firstId,
    });

    expect(store.read('external:claude:one')).toEqual({ state: 'absent' });
    expect(await store.reserve('external:claude:one')).toEqual({
      state: 'reserved',
      operationId: firstOperation,
      reused: false,
    });
    expect(await store.reserve('external:claude:one')).toEqual({
      state: 'reserved',
      operationId: firstOperation,
      reused: true,
    });
    expect(raw()).toBe(documentFor({ 'external:claude:one': firstOperation }));
  });

  test('isolates sessions and serializes competing reservations', async () => {
    const { storage } = memoryStorage();
    const lock = queuedExclusiveLock();
    const first = createAttachedSessionContinuationStore({
      storage,
      lock,
      createUuid: () => firstId,
    });
    const second = createAttachedSessionContinuationStore({
      storage,
      lock,
      createUuid: () => secondId,
    });

    const [one, two] = await Promise.all([
      first.reserve('external:claude:one'),
      second.reserve('external:claude:one'),
    ]);
    expect(one).toMatchObject({
      state: 'reserved',
      operationId: firstOperation,
    });
    expect(two).toEqual({
      state: 'reserved',
      operationId: firstOperation,
      reused: true,
    });
    expect(await second.reserve('external:claude:two')).toEqual({
      state: 'reserved',
      operationId: secondOperation,
      reused: false,
    });
  });

  test('fails closed without overwriting malformed, oversized, or dangerous input', async () => {
    const malformed = [
      '{"schemaVersion":1,"sessions":{},"extra":true}',
      `{"schemaVersion":1,"sessions":{"__proto__":{"operationId":"${firstOperation}"}}}`,
      documentFor({ prototype: firstOperation }),
      documentFor({ constructor: firstOperation }),
      documentFor({ 'external\nclaude': firstOperation }),
      documentFor({ [`x${'y'.repeat(4096)}`]: firstOperation }),
      documentFor({ 'external:claude:one': 'starter-session:not-a-uuid' }),
      `${documentFor({})}${' '.repeat(64 * 1024)}`,
    ];

    for (const raw of malformed) {
      const { storage, writes } = memoryStorage(raw);
      const store = createAttachedSessionContinuationStore({
        storage,
        lock: exclusiveLock,
        createUuid: () => firstId,
      });
      expect(store.read('external:claude:one')).toEqual({ state: 'corrupt' });
      expect(await store.reserve('external:claude:one')).toEqual({
        state: 'corrupt',
      });
      expect(writes).toEqual([]);
    }
  });

  test('does not evict evidence at capacity or write without storage or a lock', async () => {
    const sessions = Object.fromEntries(
      Array.from({ length: 128 }, (_, index) => [
        `external:claude:${index}`,
        `starter-session:00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      ]),
    );
    const full = memoryStorage(documentFor(sessions));
    const fullStore = createAttachedSessionContinuationStore({
      storage: full.storage,
      lock: exclusiveLock,
      createUuid: () => firstId,
    });
    expect(await fullStore.reserve('external:claude:new')).toEqual({
      state: 'unavailable',
    });
    expect(full.writes).toEqual([]);

    const unavailableStorage: AttachedSessionContinuationStorage = {
      getItem: () => {
        throw new Error('disabled');
      },
      setItem: () => {
        throw new Error('disabled');
      },
      removeItem: () => {
        throw new Error('disabled');
      },
    };
    const noStorage = createAttachedSessionContinuationStore({
      storage: unavailableStorage,
      lock: exclusiveLock,
    });
    const noLock = createAttachedSessionContinuationStore({
      storage: memoryStorage().storage,
      lock: null,
    });
    expect(noStorage.read('external:claude:one')).toEqual({
      state: 'unavailable',
    });
    expect(await noStorage.reserve('external:claude:one')).toEqual({
      state: 'unavailable',
    });
    expect(await noLock.reserve('external:claude:one')).toEqual({
      state: 'unavailable',
    });
  });

  test('requires matching write readback and clears only the exact completed operation', async () => {
    const noReadback: AttachedSessionContinuationStorage = {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    };
    const store = createAttachedSessionContinuationStore({
      storage: noReadback,
      lock: exclusiveLock,
      createUuid: () => firstId,
    });
    expect(await store.reserve('external:claude:one')).toEqual({
      state: 'unavailable',
    });

    const persisted = memoryStorage(
      documentFor({ 'external:claude:one': firstOperation }),
    );
    const exact = createAttachedSessionContinuationStore({
      storage: persisted.storage,
      lock: exclusiveLock,
    });
    expect(await exact.clear('external:claude:one', secondOperation)).toEqual({
      state: 'stale',
    });
    expect(persisted.raw()).toBe(
      documentFor({ 'external:claude:one': firstOperation }),
    );
    expect(await exact.clear('external:claude:one', firstOperation)).toEqual({
      state: 'cleared',
    });
  });

  test('returns unavailable after the fixed lock deadline', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const neverSettles: AttachedSessionContinuationExclusiveLock = {
      request: (_name, options) => {
        signal = options.signal;
        return new Promise(() => undefined);
      },
    };
    const store = createAttachedSessionContinuationStore({
      storage: memoryStorage().storage,
      lock: neverSettles,
      lockWaitTimeoutMs: 20,
    });
    const reservation = store.reserve('external:claude:one');
    await vi.advanceTimersByTimeAsync(20);
    await expect(reservation).resolves.toEqual({ state: 'unavailable' });
    expect(signal?.aborted).toBe(true);
    vi.useRealTimers();
  });
});
