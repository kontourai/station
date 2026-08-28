/**
 * @vitest-environment jsdom
 */

import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { beforeEach, expect, test, vi } from 'vitest';

/**
 * archive#3815  `PluginRegistry` copies `permissions.granted`
 * into each loaded layout record, and `PluginFrameHost` authorizes frame
 * navigation and its authenticated API bridge against THAT snapshot. So
 * invalidating the `plugins` query alone left an already-open frame bridging
 * with a permission the panel had just reported as removed, until some
 * unrelated reload happened to refresh the registry.
 *
 * The registry reload is the part with no user-visible symptom until it
 * matters, which is exactly why it needs a test rather than a careful
 * reading.
 */

const reload = vi.hoisted(() => vi.fn());
vi.mock('../core/PluginRegistry', () => ({
  pluginRegistry: { reload },
}));

import { invalidateQueriesForServerEvent } from '../hooks/useServerEvents';

beforeEach(() => {
  reload.mockClear();
});

async function dispatch(event: string) {
  const invalidateQueries = vi.fn();
  invalidateQueriesForServerEvent(event, { invalidateQueries });
// The reload is loaded lazily through a dynamic import.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return invalidateQueries;
}

test('a grants change refreshes the plugin list AND the loaded registry', async () => {
  const invalidateQueries = await dispatch(
    SERVER_EVENTS.PLUGINS_GRANTS_CHANGED,
  );

  expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['plugins'] });
// Without this, a frame that is already open keeps using a withdrawn
// permission.
  expect(reload).toHaveBeenCalledTimes(1);
});

test('the events that already reloaded the registry still do', async () => {
  await dispatch(SERVER_EVENTS.PLUGINS_INSTALLED);
  expect(reload).toHaveBeenCalledTimes(1);
  reload.mockClear();
  await dispatch(SERVER_EVENTS.PLUGINS_UPDATED);
  expect(reload).toHaveBeenCalledTimes(1);
});

test('an unrelated plugin event does not reload the registry', async () => {
  await dispatch(SERVER_EVENTS.PLUGINS_UPDATES_AVAILABLE);
  expect(reload).not.toHaveBeenCalled();
});
