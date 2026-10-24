import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { PendingPairingExchange } from '../core/devicePairing';
import {
  claimPendingPairingExchange,
  restoreHeldPairingExchanges,
  settlePendingPairingExchange,
} from '../core/pendingPairingExchangeJournal';

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const pending = (): PendingPairingExchange => ({
  endpoint: 'http://192.168.1.2:19441',
  requestKind: 'direct',
  requestId: 'request',
  offerId: 'offer',
  proof: 'proof',
  expiresAt: Date.now() + 60000,
  browserSession: false,
});

test('keeps an uncertain attempt held beyond expiry and restores it without the presentation mirror', async () => {
  const request = pending();
  expect(await claimPendingPairingExchange(request)).toBe('claimed');
  expect(await claimPendingPairingExchange({ ...request, expiresAt: 0 })).toBe(
    'held',
  );
  expect(await restoreHeldPairingExchanges()).toMatchObject({
    status: 'available',
    held: [{ requestId: 'request', exchangeAttempt: true }],
  });
});

test('retains a completed receipt through its original expiry even if a stale snapshot changes expiry', async () => {
  const request = pending();
  expect(await claimPendingPairingExchange(request)).toBe('claimed');
  expect(await settlePendingPairingExchange(request, 'completed')).toBe(true);
  expect(
    await claimPendingPairingExchange({
      ...request,
      expiresAt: Date.now() + 120000,
    }),
  ).toBe('held');
  expect(await restoreHeldPairingExchanges()).toEqual({
    status: 'available',
    held: [],
  });
});

test('distinguishes unavailable inventory from an empty journal and refuses admission', async () => {
  vi.stubGlobal('indexedDB', undefined);
  expect(await restoreHeldPairingExchanges()).toEqual({
    status: 'unavailable',
    held: [],
  });
  expect(await claimPendingPairingExchange(pending())).toBe('unavailable');
});

test('bounds a blocked restore instead of pretending recovery is empty', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('indexedDB', { open: () => ({}) });
  const recovery = restoreHeldPairingExchanges();
  await vi.advanceTimersByTimeAsync(5000);
  expect(await recovery).toEqual({ status: 'unavailable', held: [] });
});
