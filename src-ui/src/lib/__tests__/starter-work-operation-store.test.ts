import { describe, expect, test, vi } from 'vitest';
import {
  createStarterWorkOperationStore,
  STARTER_WORK_OPERATION_STORAGE_KEY,
  type StarterWorkOperationExclusiveLock,
  type StarterWorkOperationStorage,
} from '../starter-work-operation-store';

const firstId = '00000000-0000-4000-8000-000000000001';
const secondId = '00000000-0000-4000-8000-000000000002';

function memoryStorage(initial?: string): {
  storage: StarterWorkOperationStorage;
  writes: string[];
  raw: () => string | null;
} {
  let value = initial ?? null;
  const writes: string[] = [];
  return {
    storage: {
      getItem: (key) => {
        if (key !== STARTER_WORK_OPERATION_STORAGE_KEY)
          throw new Error('unexpected key');
        return value;
      },
      setItem: (key, next) => {
        if (key !== STARTER_WORK_OPERATION_STORAGE_KEY)
          throw new Error('unexpected key');
        writes.push(next);
        value = next;
      },
      removeItem: (key) => {
        if (key !== STARTER_WORK_OPERATION_STORAGE_KEY)
          throw new Error('unexpected key');
        value = null;
      },
    },
    writes,
    raw: () => value,
  };
}

const exclusiveLock: StarterWorkOperationExclusiveLock = {
  request: async (_name, _options, callback) => callback(),
};

function queuedExclusiveLock(): StarterWorkOperationExclusiveLock {
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

function documentFor(projects: Record<string, string>): string {
  return JSON.stringify({
    schemaVersion: 1,
    projects: Object.fromEntries(
      Object.entries(projects).map(([projectId, operationId]) => [
        projectId,
        { operationId },
      ]),
    ),
  });
}

describe('Starter Work operation store', () => {
  test('reserves durably, reads pending state, and reuses the exact operation', async () => {
    const { storage, raw } = memoryStorage();
    const store = createStarterWorkOperationStore({
      storage,
      lock: exclusiveLock,
      createUuid: () => firstId,
    });

    expect(store.read('project-alpha')).toEqual({ state: 'absent' });
    expect(await store.reserve('project-alpha')).toEqual({
      state: 'reserved',
      operationId: `task-create:${firstId}`,
      reused: false,
    });
    expect(store.read('project-alpha')).toEqual({
      state: 'pending',
      operationId: `task-create:${firstId}`,
    });
    expect(await store.reserve('project-alpha')).toEqual({
      state: 'reserved',
      operationId: `task-create:${firstId}`,
      reused: true,
    });
    expect(raw()).toBe(
      documentFor({ 'project-alpha': `task-create:${firstId}` }),
    );
  });

  test('treats inherited object names as absent project ids', async () => {
    const { storage } = memoryStorage();
    const store = createStarterWorkOperationStore({
      storage,
      lock: exclusiveLock,
      createUuid: () => firstId,
    });

    for (const projectId of ['toString', 'hasOwnProperty', 'valueOf']) {
      expect(store.read(projectId)).toEqual({ state: 'absent' });
      expect(await store.reserve(projectId)).toEqual({
        state: 'reserved',
        operationId: `task-create:${firstId}`,
        reused: false,
      });
      expect(await store.clear(projectId, `task-create:${firstId}`)).toEqual({
        state: 'cleared',
      });
    }
  });

  test('serializes concurrent reservations through the exclusive lock', async () => {
    const { storage } = memoryStorage();
    let generated = 0;
    const store = createStarterWorkOperationStore({
      storage,
      lock: queuedExclusiveLock(),
      createUuid: () => {
        generated += 1;
        return generated === 1 ? firstId : secondId;
      },
    });

    const [one, two] = await Promise.all([
      store.reserve('project-alpha'),
      store.reserve('project-alpha'),
    ]);

    expect(one).toEqual({
      state: 'reserved',
      operationId: `task-create:${firstId}`,
      reused: false,
    });
    expect(two).toEqual({
      state: 'reserved',
      operationId: `task-create:${firstId}`,
      reused: true,
    });
    expect(generated).toBe(1);
  });

  test('converges separate store instances sharing one lock and storage', async () => {
    const { storage } = memoryStorage();
    const lock = queuedExclusiveLock();
    const first = createStarterWorkOperationStore({
      storage,
      lock,
      createUuid: () => firstId,
    });
    const second = createStarterWorkOperationStore({
      storage,
      lock,
      createUuid: () => secondId,
    });

    const [fromFirst, fromSecond] = await Promise.all([
      first.reserve('project-alpha'),
      second.reserve('project-alpha'),
    ]);

    expect(fromFirst).toEqual({
      state: 'reserved',
      operationId: `task-create:${firstId}`,
      reused: false,
    });
    expect(fromSecond).toEqual({
      state: 'reserved',
      operationId: `task-create:${firstId}`,
      reused: true,
    });
  });

  test('fails closed for corrupt documents without overwriting them', async () => {
    const corrupt =
      '{"schemaVersion":1,"projects":{"__proto__":{"operationId":"task-create:' +
      firstId +
      '"}}}';
    const { storage, raw, writes } = memoryStorage(corrupt);
    const store = createStarterWorkOperationStore({
      storage,
      lock: exclusiveLock,
      createUuid: () => firstId,
    });

    expect(store.read('project-alpha')).toEqual({ state: 'corrupt' });
    expect(await store.reserve('project-alpha')).toEqual({ state: 'corrupt' });
    expect(raw()).toBe(corrupt);
    expect(writes).toEqual([]);
  });

  test('rejects every bounded untrusted identity shape before it can become a write', async () => {
    const malformed = [
      '{"schemaVersion":1,"projects":{},"extra":true}',
      documentFor({ [`a${'b'.repeat(4096)}`]: `task-create:${firstId}` }),
      documentFor({ 'project\nalpha': `task-create:${firstId}` }),
      documentFor({ 'project-alpha': 'task-create:not-a-uuid' }),
      `${documentFor({})}${' '.repeat(64 * 1024)}`,
    ];

    for (const raw of malformed) {
      const { storage, writes } = memoryStorage(raw);
      const store = createStarterWorkOperationStore({
        storage,
        lock: exclusiveLock,
        createUuid: () => firstId,
      });
      expect(store.read('project-alpha')).toEqual({ state: 'corrupt' });
      expect(await store.reserve('project-alpha')).toEqual({
        state: 'corrupt',
      });
      expect(writes).toEqual([]);
    }
  });

  test('does not evict or overwrite an at-capacity document', async () => {
    const projects = Object.fromEntries(
      Array.from({ length: 128 }, (_, index) => [
        `project-${index}`,
        `task-create:00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      ]),
    );
    const raw = documentFor(projects);
    const { storage, writes } = memoryStorage(raw);
    const store = createStarterWorkOperationStore({
      storage,
      lock: exclusiveLock,
      createUuid: () => firstId,
    });

    expect(await store.reserve('new-project')).toEqual({
      state: 'unavailable',
    });
    expect(writes).toEqual([]);
  });

  test('reports unavailable rather than writing without a lock or storage', async () => {
    const unavailableStorage: StarterWorkOperationStorage = {
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
    const withoutStorage = createStarterWorkOperationStore({
      storage: unavailableStorage,
      lock: exclusiveLock,
    });
    const { storage, writes } = memoryStorage();
    const withoutLock = createStarterWorkOperationStore({
      storage,
      lock: null,
    });

    expect(withoutStorage.read('project-alpha')).toEqual({
      state: 'unavailable',
    });
    expect(await withoutStorage.reserve('project-alpha')).toEqual({
      state: 'unavailable',
    });
    expect(await withoutLock.reserve('project-alpha')).toEqual({
      state: 'unavailable',
    });
    expect(writes).toEqual([]);
  });

  test('aborts a never-settling lock request at its deadline', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const neverSettles: StarterWorkOperationExclusiveLock = {
      request: (_name, options) => {
        signal = options.signal;
        return new Promise(() => undefined);
      },
    };
    const { storage, writes } = memoryStorage();
    const store = createStarterWorkOperationStore({
      storage,
      lock: neverSettles,
      lockWaitTimeoutMs: 20,
    });

    const pending = store.reserve('project-alpha');
    await vi.advanceTimersByTimeAsync(20);

    await expect(pending).resolves.toEqual({ state: 'unavailable' });
    expect(signal?.aborted).toBe(true);
    expect(writes).toEqual([]);
    vi.useRealTimers();
  });

  test('requires matching readback after a write', async () => {
    const storage: StarterWorkOperationStorage = {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    };
    const store = createStarterWorkOperationStore({
      storage,
      lock: exclusiveLock,
      createUuid: () => firstId,
    });

    expect(await store.reserve('project-alpha')).toEqual({
      state: 'unavailable',
    });
  });

  test('clears only the exact completed operation and leaves stale evidence intact', async () => {
    const pending = `task-create:${firstId}`;
    const { storage, raw } = memoryStorage(
      documentFor({ 'project-alpha': pending }),
    );
    const store = createStarterWorkOperationStore({
      storage,
      lock: exclusiveLock,
    });

    expect(
      await store.clear('project-alpha', `task-create:${secondId}`),
    ).toEqual({
      state: 'stale',
    });
    expect(raw()).toBe(documentFor({ 'project-alpha': pending }));
    expect(await store.clear('project-alpha', pending)).toEqual({
      state: 'cleared',
    });
    expect(store.read('project-alpha')).toEqual({ state: 'absent' });
  });
});
