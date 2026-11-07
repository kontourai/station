// @vitest-environment jsdom
/**
 * A native phone's first Station, added from "Connect a Station" at a plain
 * HTTP loopback address, approved on the computer. Field report: the exchange
 * returned 200, but the phone reported "Pairing outcome needs review" and the
 * saved Station then read "isn't accepting this device".
 *
 * Every layer here is real except the two platform edges: the native host's
 * exchange transport (a host-held credential handle, never a renderer bearer)
 * and the native profile repository's commit.
 */
import {
  ConnectionStore,
  ConnectionsProvider,
  type PendingPairingExchange,
  type StorageAdapter,
  setNativePairingExchangeTransport,
} from '@kontourai/station-connect';
import { act, cleanup, render } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PendingPairingReconciler } from '../components/PendingPairingReconciler';

vi.mock('../lib/compatibilityLoader', () => ({
  checkHostCompatibility: async () => ({
    blocking: false,
    verdict: 'compatible',
    reason: 'Compatible',
  }),
}));

const ENDPOINT = 'http://127.0.0.1:4612';

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  globalThis.localStorage.clear();
});
afterEach(() => {
  cleanup();
  setNativePairingExchangeTransport(undefined);
  vi.unstubAllGlobals();
});

test('a phone’s first loopback Station saves its approved access instead of holding it for review', async () => {
  const values = new Map<string, string>();
  const storage: StorageAdapter = {
    get: (key) => values.get(key) ?? null,
    set: (key, value) => {
      values.set(key, value);
    },
    remove: (key) => {
      values.delete(key);
    },
  };
  const store = new ConnectionStore({ storage, credentialStorage: storage });
  // Exactly what ConnectStationDialog does on a fresh phone: no Station yet,
  // so the added destination becomes the selected one.
  const target = store.add(ENDPOINT, ENDPOINT);
  expect(store.getActive()?.id).toBe(target.id);
  expect(target.credentialState).toBe('not-required');

  const exchanges: string[] = [];
  setNativePairingExchangeTransport(async (input) => {
    exchanges.push(input.clientInstanceId);
    return {
      environmentId: 'dfe5528e-6d20-4580-bcfa-9cb587828b9a',
      device: {
        id: 'phone',
        name: 'iPhone · Station Dev',
        kind: 'device',
        scope: 'orchestration:read',
        createdAt: 1,
        activityTracking: 'tracked-since-issued',
        lastSeenFrom: null,
        usageCount: 0,
        lastActiveDay: null,
        revokedAt: null,
        revocation: { state: 'not-revoked' },
      },
      credentialHandle: 'host-handle-1',
      credentialRef: { kind: 'station-bearer', id: 'ref-1' },
    };
  });
  const commitVerifiedPairing = vi.fn(async (input: { connectionId: string }) =>
    Promise.resolve(input.connectionId),
  );

  const pending: PendingPairingExchange = {
    // The record ConnectStationDialog persists for this journey.
    endpoint: ENDPOINT,
    offerId: 'offer',
    proof: 'proof',
    requestId: 'request',
    requestedAt: Date.now(),
    expiresAt: Date.now() + 5 * 60_000,
    expectedEnvironmentId: 'dfe5528e-6d20-4580-bcfa-9cb587828b9a',
    browserSession: false,
    requestKind: 'direct',
    targetConnectionId: target.id,
    targetConnectionLabel: ENDPOINT,
    activateConnection: false,
    preserveSelectedStation: false,
  };
  globalThis.localStorage.setItem(
    `station-pairing-pending-exchange:v1:${ENDPOINT}:direct`,
    JSON.stringify(pending),
  );
  const callbacks = {
    onCompleted: vi.fn(),
    onIndeterminate: vi.fn(),
    onTerminalFailure: vi.fn(),
    onConnectionWaiting: vi.fn(),
    onApprovalWaiting: vi.fn(),
  };
  render(
    <ConnectionsProvider
      store={store}
      commitVerifiedPairing={commitVerifiedPairing}
    >
      <PendingPairingReconciler pending={pending} {...callbacks} />
    </ConnectionsProvider>,
  );

  await act(async () => {
    await vi.waitFor(
      () =>
        expect(
          callbacks.onCompleted.mock.calls.length +
            callbacks.onIndeterminate.mock.calls.length +
            callbacks.onTerminalFailure.mock.calls.length,
        ).toBe(1),
      { timeout: 5_000 },
    );
  });
  expect(exchanges).toHaveLength(1);
  expect(callbacks.onIndeterminate).not.toHaveBeenCalled();
  expect(callbacks.onTerminalFailure).not.toHaveBeenCalled();
  expect(callbacks.onCompleted).toHaveBeenCalledOnce();
  expect(commitVerifiedPairing).toHaveBeenCalledWith(
    expect.objectContaining({
      connectionId: target.id,
      endpoint: ENDPOINT,
      credentialHandle: 'host-handle-1',
    }),
  );
  expect(store.getActive()?.environmentId).toBe(
    'dfe5528e-6d20-4580-bcfa-9cb587828b9a',
  );
});
