// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readSnoozes, writeSnooze } from '../utils/activity-snooze-store';
import {
  isInboxPinned,
  migrateInboxPin,
  pinInboxItem,
  readInboxPins,
  subscribeInboxPins,
  toggleInboxPin,
} from '../utils/inbox-pin-store';

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

it('partitions pins by authority and Station, including when local IDs coincide', () => {
  const local = { id: 'same' };
  const station = { ...local, environmentId: 'station-a' };
  pinInboxItem(station, 'person-a');
  expect(isInboxPinned(station, readInboxPins('person-a'))).toBe(true);
  expect(isInboxPinned(local, readInboxPins('person-a'))).toBe(false);
  expect(
    isInboxPinned(
      { ...station, environmentId: 'station-b' },
      readInboxPins('person-a'),
    ),
  ).toBe(false);
  expect(isInboxPinned(station, readInboxPins('person-b'))).toBe(false);
});

it('retains the 100 newest entries', () => {
  const now = vi.spyOn(Date, 'now');
  for (let index = 1; index <= 101; index++) {
    now.mockReturnValue(index);
    pinInboxItem({ id: String(index) }, 'bounded');
  }
  const pins = readInboxPins('bounded');
  expect(Object.keys(pins)).toHaveLength(100);
  expect(isInboxPinned({ id: '1' }, pins)).toBe(false);
  expect(isInboxPinned({ id: '101' }, pins)).toBe(true);
});

it('keeps a pin and its migration available when storage reads and writes fail', () => {
  pinInboxItem({ id: 'another' }, 'fallback');
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('unavailable');
  });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('unavailable');
  });
  pinInboxItem({ id: 'draft' }, 'fallback');
  const original = readInboxPins('fallback').draft;
  migrateInboxPin('draft', 'chat', 'fallback');
  expect(readInboxPins('fallback')).toEqual({
    another: expect.anything(),
    chat: original,
  });
  expect(readInboxPins('different-authority')).toEqual({});
  toggleInboxPin({ id: 'chat' }, 'fallback');
  expect(readInboxPins('fallback')).toEqual({ another: expect.anything() });
});

it('notifies subscribers about another tab changing its stored pins', () => {
  pinInboxItem({ id: 'first' }, 'cross-tab');
  const key = localStorage.key(0);
  expect(key).not.toBeNull();
  if (key === null) throw new Error('Pin storage was not written');
  const listener = vi.fn();
  const stop = subscribeInboxPins(listener);
  try {
    localStorage.removeItem(key);
    window.dispatchEvent(
      new StorageEvent('storage', { key, storageArea: localStorage }),
    );
    expect(listener).toHaveBeenCalledOnce();
    expect(readInboxPins('cross-tab')).toEqual({});
  } finally {
    stop();
  }
});

it('clears an active snooze when pinning and preserves the pin timestamp on promotion', () => {
  const now = Date.now();
  writeSnooze('local-draft', now + 60_000, now, 'promotion');
  pinInboxItem({ id: 'local-draft' }, 'promotion');
  expect(readSnoozes(now, 'promotion')).toEqual({});
  const pin = readInboxPins('promotion')['local-draft'];
  migrateInboxPin('local-draft', 'chat-id', 'promotion');
  expect(readInboxPins('promotion')).toEqual({ 'chat-id': pin });
});
