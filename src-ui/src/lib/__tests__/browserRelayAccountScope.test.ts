/** @vitest-environment jsdom */

import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('broadcasts the route map key so another tab retires its old account scope', async () => {
  vi.stubGlobal('BroadcastChannel', undefined);
  const routeKey = '["saved-station","station-origin","broker-route"]';
  vi.resetModules();
  const sender = await import('../browserRelayAccountScope');
  const write = vi.spyOn(Storage.prototype, 'setItem');
  sender.publishBrowserRelayAccountScope(routeKey, 'account-B', 2);

  const serialized = write.mock.calls.find(
    ([key]) => key === 'station-browser-relay-account-scope-event-v1',
  )?.[1];
  expect(serialized).toBeDefined();
  const message = JSON.parse(serialized!);
  expect(message.route).toBe(routeKey);
  expect(message.route).not.toBe(
    sender.getBrowserRelayAccountScope(routeKey)?.scopeKey,
  );

  // A fresh module instance models the second tab's separate in-memory map.
  vi.resetModules();
  const receiver = await import('../browserRelayAccountScope');
  expect(receiver.getBrowserRelayAccountScope(routeKey)).toBeNull();
  window.dispatchEvent(
    new StorageEvent('storage', {
      key: 'station-browser-relay-account-scope-event-v1',
      newValue: serialized,
    }),
  );
  expect(receiver.getBrowserRelayAccountScope(routeKey)?.authorityKey).toBe(
    'account-B',
  );
});
