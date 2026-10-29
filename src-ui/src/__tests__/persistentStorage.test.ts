// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetOutboundQueueStorage,
  _setOutboundQueueStorage,
  type OutboundQueueStorage,
  outboundDispatch,
} from '../lib/outboundQueue';
import {
  _resetPersistentStorageRequestForTests,
  requestPersistentStorage,
} from '../lib/persistentStorage';

function stubStorageManager(persisted: boolean, grant = true) {
  const manager = {
    persisted: vi.fn(async () => persisted),
    persist: vi.fn(async () => grant),
  };
  vi.stubGlobal('navigator', { ...navigator, storage: manager });
  return manager;
}

function memoryStorage(): OutboundQueueStorage {
  let value: unknown;
  return {
    getItem: async () => value,
    setItem: async (_key, next) => {
      value = next;
    },
    updateItem: async (_key, updater) => {
      value = updater(value);
    },
  };
}

beforeEach(() => {
  _resetPersistentStorageRequestForTests();
});
afterEach(() => {
  vi.unstubAllGlobals();
  _resetOutboundQueueStorage();
});

describe('requestPersistentStorage', () => {
  it('asks once per page and reports the browser decision', async () => {
    const manager = stubStorageManager(false, true);
    await expect(requestPersistentStorage()).resolves.toBe(true);
    await expect(requestPersistentStorage()).resolves.toBe(true);
    expect(manager.persist).toHaveBeenCalledTimes(1);
  });

  it('does not ask again when storage is already persistent', async () => {
    const manager = stubStorageManager(true);
    await expect(requestPersistentStorage()).resolves.toBe(true);
    expect(manager.persist).not.toHaveBeenCalled();
  });

  it('treats a refusal, a failure or a missing API as best effort', async () => {
    stubStorageManager(false, false);
    await expect(requestPersistentStorage()).resolves.toBe(false);
    _resetPersistentStorageRequestForTests();
    vi.stubGlobal('navigator', {
      ...navigator,
      storage: {
        persist: async () => {
          throw new Error('blocked');
        },
      },
    });
    await expect(requestPersistentStorage()).resolves.toBe(false);
    _resetPersistentStorageRequestForTests();
    vi.stubGlobal('navigator', { ...navigator, storage: undefined });
    await expect(requestPersistentStorage()).resolves.toBe(false);
  });
});

describe('outbox persistence requests', () => {
  const intent = {
    clientTurnId: 'key-1',
    sessionId: 'session-a',
    agentSlug: 'codex',
    content: 'hello',
  };

  it('asks when a message is left waiting on this device', async () => {
    _setOutboundQueueStorage(memoryStorage());
    const manager = stubStorageManager(false);
    await outboundDispatch.enqueue(intent);
    expect(manager.persist).toHaveBeenCalledTimes(1);
  });

  it('never asks for an ordinary live send', async () => {
    _setOutboundQueueStorage(memoryStorage());
    const manager = stubStorageManager(false);
    const live = await outboundDispatch.beginLive(intent);
    await live.refused();
    expect(manager.persisted).not.toHaveBeenCalled();
    expect(manager.persist).not.toHaveBeenCalled();
  });
});
