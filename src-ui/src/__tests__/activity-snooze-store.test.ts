// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let store: typeof import('../utils/activity-snooze-store');
const NOW = 1_000_000;
const unsubscribe: (() => void)[] = [];

beforeEach(async () => {
  localStorage.clear();
  vi.resetModules();
  store = await import('../utils/activity-snooze-store');
});

afterEach(() => {
  for (const dispose of unsubscribe.splice(0)) dispose();
  vi.restoreAllMocks();
});

describe('snooze persistence', () => {
  it('keeps a failed write visible to subscribers alongside existing snoozes', () => {
    store.writeSnooze('existing', NOW + 100, NOW, 'person-a');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    });
    const observed: Record<string, number>[] = [];
    unsubscribe.push(
      store.subscribeSnoozes(() => {
        observed.push(store.readSnoozes(NOW, 'person-a'));
      }),
    );

    store.writeSnooze('new', NOW + 200, NOW, 'person-a');

    expect(observed).toEqual([{ existing: NOW + 100, new: NOW + 200 }]);
    expect(store.readSnoozes(NOW + 101, 'person-a')).toEqual({
      new: NOW + 200,
    });
    expect(store.readSnoozes(NOW, 'person-b')).toEqual({});
    const key = localStorage.key(0)!;
    window.dispatchEvent(
      new StorageEvent('storage', { key, storageArea: sessionStorage }),
    );
    expect(observed).toHaveLength(1);
    expect(store.readSnoozes(NOW, 'person-a')).toEqual({
      existing: NOW + 100,
      new: NOW + 200,
    });
  });

  it('retains unsnooze and identity migration while writes fail, then persists the session state', () => {
    store.writeSnooze('remove', NOW + 100, NOW, 'person');
    store.writeSnooze('draft', NOW + 200, NOW, 'person');
    const write = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('Storage unavailable');
      });

    store.clearSnooze('remove', NOW, 'person');
    store.migrateSnoozeKey('draft', 'conversation', NOW, 'person');
    expect(store.readSnoozes(NOW, 'person')).toEqual({
      conversation: NOW + 200,
    });

    write.mockRestore();
    store.writeSnooze('another', NOW + 300, NOW, 'person');
    const saved = localStorage.getItem(localStorage.key(0)!);
    expect(JSON.parse(saved!)).toEqual({
      conversation: NOW + 200,
      another: NOW + 300,
    });
  });

  it('uses the last observed snapshot when storage cannot be read', () => {
    store.writeSnooze('work', NOW + 100, NOW, 'person');
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('Storage unavailable');
    });

    expect(store.readSnoozes(NOW, 'person')).toEqual({ work: NOW + 100 });
    expect(store.readSnoozes(NOW, 'other-person')).toEqual({});
    expect(store.readSnoozes(NOW + 100, 'person')).toEqual({});
  });

  it('notifies live readers about another tab without waiting for the coarse clock', () => {
    store.writeSnooze('work', NOW + 100, NOW, 'person');
    const key = localStorage.key(0)!;
    const changed = vi.fn();
    unsubscribe.push(store.subscribeSnoozes(changed));
    localStorage.setItem(key, JSON.stringify({ other: NOW + 200 }));

    window.dispatchEvent(
      new StorageEvent('storage', { key, storageArea: localStorage }),
    );

    expect(changed).toHaveBeenCalledOnce();
    expect(store.readSnoozes(NOW, 'person')).toEqual({ other: NOW + 200 });
    window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated' }));
    expect(changed).toHaveBeenCalledOnce();
    localStorage.clear();
    window.dispatchEvent(
      new StorageEvent('storage', { key: null, storageArea: localStorage }),
    );
    expect(changed).toHaveBeenCalledTimes(2);
    expect(store.readSnoozes(NOW, 'person')).toEqual({});
  });
});
