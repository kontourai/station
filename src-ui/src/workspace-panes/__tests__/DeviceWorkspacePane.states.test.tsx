// @vitest-environment jsdom

/**
 * #1969: the Device pane's inventory-derived states.
 *
 * Every case here is reached through the real SDK client and a real
 * `QueryClient` over a stubbed `fetch`, so a fixture that is not the shape
 * the server emits fails rather than being believed.
 */

import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

const scope: { apiBase: string; authorityKey: string } | undefined = {
  apiBase: 'http://station.test',
  authorityKey: 'authority-1',
};
vi.mock('../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => scope,
}));

import { DeviceWorkspacePane } from '../DeviceWorkspacePane';
import {
  ANDROID_DEVICE,
  authorizeScope,
  IOS_DEVICE,
  partialInventory,
  readyInventory,
  renderInQueryClient,
  stubDeviceFetch,
  unavailableInventory,
} from './deviceWorkspacePaneHarness';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

async function mount() {
  authorizeScope();
  const view = renderInQueryClient(<DeviceWorkspacePane />);
  return view;
}

describe('the Device pane over an inventory (#1969)', () => {
  /**
   * The setup state, which is NOT a failure: nothing broke, the helper was
   * never pointed at. Routing `not-configured` through the same `ErrorState`
   * arm as the other five — or giving it a Refresh — reds this.
   */
  test('an unconfigured host gets setup copy, no Capture and no retry', async () => {
    stubDeviceFetch({ inventory: unavailableInventory('not-configured') });
    await mount();
    await screen.findByText(/Set up device inspection/);
    expect(screen.getByText(/STATION_MOBILE_DEVICE_HUB_URL/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Capture' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull();
  });

  /**
   * Each remaining host failure keeps its OWN sentence. Collapsing two of
   * them onto one string — or routing one through the `not-configured` setup
   * card — reds the case that no longer finds its title.
   */
  test.each([
    ['invalid-configuration', /address was refused/],
    ['hub-unavailable', /did not answer/],
    ['invalid-response', /could not read/],
    ['response-too-large', /more than Station will read/],
    ['busy', /is busy/],
  ] as const)(
    '%s renders its own sentence with a Refresh',
    async (failure, pattern) => {
      stubDeviceFetch({ inventory: unavailableInventory(failure) });
      await mount();
      await screen.findByText(pattern);
      expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy();
      expect(screen.queryByText(/Set up device inspection/)).toBeNull();
    },
  );

  /**
   * The shared empty label, not a bespoke "No devices" — that string would
   * consume a slot in the ad-hoc "No X" ceiling for a state the family
   * already has a label for. The distinguishing sentence lives in the
   * description, which is what #1536 E8 prescribes.
   */
  test('a ready host with nothing running renders the shared empty', async () => {
    stubDeviceFetch({ inventory: readyInventory([]) });
    await mount();
    await screen.findByText('Nothing here yet');
    expect(screen.getByText(/reported nothing running/)).toBeTruthy();
    expect(screen.queryByText(/No devices/)).toBeNull();
  });

  /**
   * A partial discovery with NOTHING in it is still a partial discovery. The
   * service emits this envelope: `parseDevices` sets `partial` from the
   * helper's `errors` array alone, so `{simulators:[],emulators:[],errors:[…]}`
   * becomes `{state:'partial', devices:[]}` (probed directly against
   * `LocalMobileDeviceHost`). Falling through to the ready-empty's
   * description tells the reader the helper "reported nothing running" — a
   * claim about a discovery that finished, which this one did not — and
   * loses the incomplete note with it. Reverting the description to the
   * unconditional sentence reds two of the three assertions below.
   */
  test('a partial inventory with no devices says the discovery was incomplete, not that nothing is running', async () => {
    stubDeviceFetch({ inventory: partialInventory([]) });
    await mount();
    await screen.findByText('Nothing here yet');
    expect(screen.getByText(/may be incomplete/)).toBeTruthy();
    expect(
      screen.getByText(/sources that did answer listed nothing running/),
    ).toBeTruthy();
    expect(screen.queryByText(/helper reported nothing running/)).toBeNull();
  });

  /** A partial discovery is a NOTE on a real list, not an error. */
  test('a partial inventory renders the list and says discovery was incomplete', async () => {
    stubDeviceFetch({ inventory: partialInventory([IOS_DEVICE]) });
    await mount();
    await screen.findByRole('radio', { name: /iPhone 17 Pro/ });
    expect(screen.getByText(/may be incomplete/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('both native targets are offered, with their platform and runtime', async () => {
    stubDeviceFetch({ inventory: readyInventory() });
    await mount();
    await screen.findByRole('radio', { name: /iPhone 17 Pro/ });
    expect(screen.getByRole('radio', { name: /Pixel 10 Pro XL/ })).toBeTruthy();
    expect(screen.getByText(/iOS · iOS 26\.5/)).toBeTruthy();
    expect(screen.getByText(/Android · Android 16/)).toBeTruthy();
  });

  /**
   * A device the host lists but this client cannot address gets a DISABLED
   * row naming why, rather than a Capture that is guaranteed to 400.
   *
   * The fixture is the ONLY shape that reaches this branch from a real
   * server: an UNBOOTED Android row under an AVD name. `LocalMobileDeviceHost`
   * applies the `emulator-<n>` rule only to a booted Android device, so it
   * lists this row (probed: `state: 'ready'` with the row present) while the
   * same row with `booted: true` makes it refuse the whole inventory
   * `invalid-response`. A booted AVD-name fixture would therefore be testing
   * an envelope no writer produces.
   *
   * It is also why the reason must PRE-EMPT "Not running": this row is both,
   * and "start it, then refresh" would send the reader to an inventory the
   * host refuses wholesale. Restoring the `!device.booted` check to the front
   * of `unsupportedReason` reds the reason assertion below.
   */
  test('a device id the client cannot address is offered disabled, with the reason', async () => {
    stubDeviceFetch({
      inventory: readyInventory([
        IOS_DEVICE,
        { ...ANDROID_DEVICE, deviceId: 'Pixel_9_API_36', booted: false },
      ]),
    });
    await mount();
    const row = await screen.findByRole('radio', { name: /Pixel 10 Pro XL/ });
    expect(row).toHaveProperty('disabled', true);
    expect(screen.getByText(/emulator-<number> serial/)).toBeTruthy();
    expect(screen.queryByText(/Not running/)).toBeNull();
    expect(screen.getByRole('radio', { name: /iPhone/ })).toHaveProperty(
      'disabled',
      false,
    );
  });

  /** A stopped device would 409 on capture; it is offered disabled instead. */
  test('a device that is not running is offered disabled', async () => {
    stubDeviceFetch({
      inventory: readyInventory([{ ...IOS_DEVICE, booted: false }]),
    });
    await mount();
    expect(await screen.findByRole('radio', { name: /iPhone/ })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByText(/Not running/)).toBeTruthy();
  });

  /**
   * A failed READ gets an error before any empty. Reordering the branches so
   * the `devices.length === 0` empty is reached first would draw "Nothing
   * here yet" over a request that never succeeded.
   */
  test('a refused read renders an error, not an empty', async () => {
    stubDeviceFetch({ inventoryStatus: 503 });
    await mount();
    await waitFor(() =>
      expect(screen.getByText(/device list could not be read/)).toBeTruthy(),
    );
    expect(screen.queryByText('Nothing here yet')).toBeNull();
    expect(screen.queryByText(/Set up device inspection/)).toBeNull();
  });
});
