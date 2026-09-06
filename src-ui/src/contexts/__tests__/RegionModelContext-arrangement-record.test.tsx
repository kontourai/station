/**
 * @vitest-environment jsdom
 *
 * #928 slice D: the region arrangement persists per device as the
 * `regionArrangement` device setting. Every test here mounts the real
 * `RegionModelProvider` over the real navigation store and the real
 * device-settings store, because the seams under test are the joins: what the
 * provider reads at mount, what it writes after a placement, and what it does
 * when the store hands it another tab's record.
 */

import {
  DEFAULT_REGION_ARRANGEMENT_RECORD,
  type RegionArrangementRecord,
} from '@kontourai/station-contracts/device-settings';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { deviceSettingsStore } from '../../lib/device-settings-store';
import { toRegionArrangementRecord } from '../../regions/region-arrangement-record';
import { DEFAULT_DEVICE_REGION_ARRANGEMENT } from '../../regions/region-model';
import { NavigationProvider } from '../NavigationContext';
import { navigationStore } from '../navigation-store';
import { RegionModelProvider, useRegionModel } from '../RegionModelContext';

const ENVELOPE_KEY = 'station-device-settings-v1';

let model: ReturnType<typeof useRegionModel> | null = null;

function Probe() {
  const value = useRegionModel();
  useEffect(() => {
    model = value;
  }, [value]);
  return null;
}

function Harness() {
  return (
    <NavigationProvider>
      <RegionModelProvider>
        <Probe />
      </RegionModelProvider>
    </NavigationProvider>
  );
}

function setUrl(url: string) {
  window.history.replaceState({}, '', url);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

/** Seeds storage as an earlier session on this device would have left it, then re-reads both stores from it. */
function seedEnvelope(values: Record<string, unknown>) {
  localStorage.setItem(ENVELOPE_KEY, JSON.stringify({ version: 2, values }));
  deviceSettingsStore.reloadFromStorage();
}

/** A record differing from the default: Activity in `right`, Chat hidden in `bottom`. */
function activityRightRecord(
  patch: Partial<RegionArrangementRecord['regions']> = {},
): RegionArrangementRecord {
  return {
    version: 1,
    regions: {
      main: {
        visible: true,
        size: 0,
        occupant: { kind: 'surface', id: 'home' },
        maximized: false,
      },
      left: { visible: false, size: 400, occupant: null, maximized: false },
      right: {
        visible: true,
        size: 517,
        occupant: { kind: 'surface', id: 'activity' },
        maximized: false,
      },
      bottom: {
        visible: false,
        size: 320,
        occupant: { kind: 'surface', id: 'chat' },
        maximized: false,
      },
      ...patch,
    },
  };
}

/**
 * What another tab's write looks like from here: localStorage already holds
 * the new envelope and the `storage` event announces it. The store's own
 * listener re-reads and notifies, and `useDeviceSettings` re-renders the
 * provider with the new value — the real cross-tab path, not a stubbed one.
 */
function writeFromAnotherTab(record: unknown) {
  const envelope = {
    ...deviceSettingsStore.getEnvelope(),
    values: {
      ...deviceSettingsStore.getEnvelope().values,
      regionArrangement: record,
    },
  };
  const newValue = JSON.stringify(envelope);
  const oldValue = localStorage.getItem(ENVELOPE_KEY);
  localStorage.setItem(ENVELOPE_KEY, newValue);
  window.dispatchEvent(
    new StorageEvent('storage', {
      key: ENVELOPE_KEY,
      newValue,
      oldValue,
      storageArea: localStorage,
    }),
  );
}

/** Every write a mount could make: device settings (any key) and navigation's dock setters. */
function spyOnEverySetter() {
  return {
    set: vi.spyOn(deviceSettingsStore, 'set'),
    setDockMode: vi.spyOn(navigationStore, 'setDockMode'),
    setDockState: vi.spyOn(navigationStore, 'setDockState'),
    updateParams: vi.spyOn(navigationStore, 'updateParams'),
  };
}

function expectNoWrites(spies: ReturnType<typeof spyOnEverySetter>) {
  expect(spies.set).not.toHaveBeenCalled();
  expect(spies.setDockMode).not.toHaveBeenCalled();
  expect(spies.setDockState).not.toHaveBeenCalled();
  expect(spies.updateParams).not.toHaveBeenCalled();
}

function regionArrangementWrites(spy: {
  mock: { calls: readonly (readonly unknown[])[] };
}) {
  return spy.mock.calls.filter(([key]) => key === 'regionArrangement');
}

async function settle(ms = 250) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

beforeEach(() => {
  model = null;
  localStorage.clear();
  deviceSettingsStore.reloadFromStorage();
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: 1024,
  });
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  setUrl('/');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  deviceSettingsStore.reloadFromStorage();
  setUrl('/');
});

describe('RegionModelProvider reads the regionArrangement record at mount', () => {
  test('a record with Activity in right mounts with Activity in right (the reload case)', async () => {
    seedEnvelope({ regionArrangement: activityRightRecord() });
    setUrl('/');

    render(<Harness />);
    await waitFor(() => expect(model).not.toBeNull());

    expect(model?.regions.right).toEqual({
      visible: true,
      size: 517,
      occupant: 'activity',
      maximized: false,
    });
    expect(model?.regions.bottom.occupant).toBe('chat');
    expect(model?.regions.main.occupant).toBe('home');
  });

  // The upgrade case: a pre-record device holds the registry default plus its
  // legacy `dockSlotPlacement`. Only the default-record gate lets the legacy
  // key govern here, because a governing record now decides Chat's placement
  // itself (below).
  test('a record equal to the default is no record: the legacy seed governs, so a pre-record device keeps Chat where dockSlotPlacement said', async () => {
    seedEnvelope({
      regionArrangement: DEFAULT_REGION_ARRANGEMENT_RECORD,
      dockSlotPlacement: 'right',
    });
    // Navigation resolves `dockMode` from the device setting at parse time.
    setUrl('/');
    expect(navigationStore.getSnapshot().dockMode).toBe('right');

    render(<Harness />);
    await waitFor(() => expect(model).not.toBeNull());

    expect(model?.regions.right.occupant).toBe('chat');
    expect(model?.regions.bottom.occupant).toBeNull();
  });

  test('?dock=open&dockSlotPlacement=left beats a record holding Chat hidden in bottom, and the record still places Activity', async () => {
    seedEnvelope({
      regionArrangement: activityRightRecord({
        right: {
          visible: false,
          size: 517,
          occupant: { kind: 'surface', id: 'activity' },
          maximized: false,
        },
      }),
    });
    setUrl('/?dock=open&dockSlotPlacement=left');
    const spies = spyOnEverySetter();

    render(<Harness />);
    await waitFor(() => expect(model).not.toBeNull());

    expect(model?.regions.left).toMatchObject({
      visible: true,
      occupant: 'chat',
    });
    expect(model?.regions.bottom.occupant).toBeNull();
    // The URL spoke only about Chat; the record's Activity placement stands.
    expect(model?.regions.right).toEqual({
      visible: false,
      size: 517,
      occupant: 'activity',
      maximized: false,
    });
    // The initializer did this, not a mount-time correction that then
    // persisted: no record write, no navigation write.
    await settle();
    expect(regionArrangementWrites(spies.set)).toHaveLength(0);
    expectNoWrites(spies);
  });

  test('?dockSlotPlacement=right places Chat in an occupied right, relocating Activity by the model’s own rule, and writes nothing', async () => {
    seedEnvelope({ regionArrangement: activityRightRecord() });
    setUrl('/?dockSlotPlacement=right');
    const spies = spyOnEverySetter();

    render(<Harness />);
    await waitFor(() => expect(model).not.toBeNull());

    // No `dock=open`, and the record held Chat hidden: placed, not shown.
    expect(model?.regions.right).toMatchObject({
      occupant: 'chat',
      visible: false,
    });
    // Activity swaps into the region Chat vacated, keeping its visibility.
    expect(model?.regions.bottom).toMatchObject({
      occupant: 'activity',
      visible: true,
    });
    await settle();
    expectNoWrites(spies);
    expect(window.location.search).toBe('?dockSlotPlacement=right');
  });

  test('with no URL param the record decides Chat, not the legacy dockSlotPlacement/dock keys', async () => {
    seedEnvelope({
      regionArrangement: activityRightRecord({
        left: {
          visible: false,
          size: 400,
          occupant: { kind: 'surface', id: 'activity' },
          maximized: false,
        },
        right: {
          visible: true,
          size: 480,
          occupant: { kind: 'surface', id: 'chat' },
          maximized: false,
        },
        bottom: { visible: false, size: 320, occupant: null, maximized: false },
      }),
      dockSlotPlacement: 'left',
    });
    setUrl('/');
    expect(navigationStore.getSnapshot().dockMode).toBe('left');
    expect(navigationStore.getSnapshot().isDockOpen).toBe(false);

    render(<Harness />);
    await waitFor(() => expect(model).not.toBeNull());

    expect(model?.regions.right).toEqual({
      visible: true,
      size: 480,
      occupant: 'chat',
      maximized: false,
    });
    expect(model?.regions.left.occupant).toBe('activity');
  });

  test('a record naming a retired surface in right mounts with right empty', async () => {
    seedEnvelope({
      regionArrangement: activityRightRecord({
        right: {
          visible: true,
          size: 517,
          occupant: { kind: 'surface', id: 'retired-surface' },
          maximized: false,
        },
      }),
    });
    setUrl('/');

    render(<Harness />);
    await waitFor(() => expect(model).not.toBeNull());

    expect(model?.regions.right.occupant).toBeNull();
    expect(model?.regions.bottom.occupant).toBe('chat');
  });

  test('a malformed stored record keeps the app booting on the legacy seed', async () => {
    seedEnvelope({
      regionArrangement: 'not a record',
      dockSlotPlacement: 'right',
    });
    setUrl('/');

    render(<Harness />);
    await waitFor(() => expect(model).not.toBeNull());

    expect(model?.regions.right.occupant).toBe('chat');
    expect(model?.regions.main.occupant).toBe('home');
  });
});

describe('RegionModelProvider persists every arrangement write as the record', () => {
  test('placeSurface(activity, left) persists left.occupant = { kind: surface, id: activity }, coalesced into one write', async () => {
    const setSpy = vi.spyOn(deviceSettingsStore, 'set');
    render(<Harness />);
    await waitFor(() => expect(model).not.toBeNull());
    expect(regionArrangementWrites(setSpy)).toHaveLength(0);

    act(() => {
      model?.placeSurface('activity', 'left');
      model?.setRegion('left', { size: 333 });
    });
    // Trailing edge: nothing has been written in the same tick.
    expect(regionArrangementWrites(setSpy)).toHaveLength(0);

    await waitFor(() =>
      expect(setSpy).toHaveBeenCalledWith(
        'regionArrangement',
        expect.objectContaining({
          version: 1,
          regions: expect.objectContaining({
            left: {
              visible: true,
              size: 333,
              occupant: { kind: 'surface', id: 'activity' },
              maximized: false,
            },
          }),
        }),
      ),
    );
    expect(regionArrangementWrites(setSpy)).toHaveLength(1);
    // Persisted for real, not only requested: the store holds the record the
    // next mount will read.
    expect(deviceSettingsStore.get('regionArrangement').regions.left).toEqual({
      visible: true,
      size: 333,
      occupant: { kind: 'surface', id: 'activity' },
      maximized: false,
    });
    // The store's echo of this tab's own write is not adopted as a change.
    await settle();
    expect(regionArrangementWrites(setSpy)).toHaveLength(1);
    expect(model?.regions.left.occupant).toBe('activity');
  });

  test('a mount is not a write: no setter is reached until the user changes something', async () => {
    setUrl('/?dock=open');
    const spies = spyOnEverySetter();
    render(<Harness />);
    await waitFor(() => expect(model?.regions.bottom.visible).toBe(true));
    await settle();

    expectNoWrites(spies);
    expect(deviceSettingsStore.get('regionArrangement')).toEqual(
      DEFAULT_REGION_ARRANGEMENT_RECORD,
    );
  });

  // The legacy keys say Chat belongs in `left`, which the record gives to
  // Activity; the record shows Chat in `right` while navigation says closed.
  // Before this fix the mount-time legacy sync kept Chat put and then
  // `setDockMode` wrote `dockSlotPlacement: 'right'` before the user touched
  // anything. A disagreement is reconciled by the mirror on the next user
  // change, never at mount.
  test('a mount with legacy keys disagreeing with the record reaches no setter', async () => {
    seedEnvelope({
      regionArrangement: activityRightRecord({
        left: {
          visible: false,
          size: 400,
          occupant: { kind: 'surface', id: 'activity' },
          maximized: false,
        },
        right: {
          visible: true,
          size: 480,
          occupant: { kind: 'surface', id: 'chat' },
          maximized: false,
        },
        bottom: { visible: false, size: 320, occupant: null, maximized: false },
      }),
      dockSlotPlacement: 'left',
    });
    setUrl('/');
    const spies = spyOnEverySetter();

    render(<Harness />);
    await waitFor(() => expect(model).not.toBeNull());
    await settle();

    expect(model?.regions.right.occupant).toBe('chat');
    expect(model?.regions.left.occupant).toBe('activity');
    expectNoWrites(spies);
    expect(deviceSettingsStore.get('dockSlotPlacement')).toBe('left');
    expect(window.location.search).toBe('');

    // The next USER change is where the mirror reconciles: hiding Chat now
    // reaches navigation, and only navigation.
    act(() => model?.setRegion('right', { visible: false }));
    await waitFor(() => expect(spies.setDockState).toHaveBeenCalled());
  });
});

describe('RegionModelProvider adopts another tab’s record without re-persisting it', () => {
  test('a different record is adopted; the same record is a no-op', async () => {
    const setSpy = vi.spyOn(deviceSettingsStore, 'set');
    render(<Harness />);
    await waitFor(() => expect(model).not.toBeNull());
    expect(model?.regions.right.occupant).toBeNull();
    expect(navigationStore.getSnapshot().isDockOpen).toBe(false);

    const incoming = activityRightRecord({
      bottom: {
        visible: true,
        size: 320,
        occupant: { kind: 'surface', id: 'chat' },
        maximized: false,
      },
    });
    act(() => writeFromAnotherTab(incoming));

    await waitFor(() => expect(model?.regions.right.occupant).toBe('activity'));
    expect(model?.regions.right.size).toBe(517);
    // Adoption is a read. Its only writes are the Chat mirror's: the other
    // tab's Chat is open, so this tab's navigation now says so too.
    expect(navigationStore.getSnapshot().isDockOpen).toBe(true);
    await settle();
    expect(regionArrangementWrites(setSpy)).toHaveLength(0);
    expect(toRegionArrangementRecord(model!.regions)).toEqual(incoming);

    const before = model?.regions;
    act(() => writeFromAnotherTab(incoming));
    await settle();

    expect(model?.regions).toBe(before);
    expect(regionArrangementWrites(setSpy)).toHaveLength(0);
  });

  test('adopting a record that hides the last-shown region moves lastShownRegion to a region still showing something', async () => {
    setUrl('/?dock=open');
    render(<Harness />);
    await waitFor(() => expect(model?.lastShownRegion).toBe('bottom'));

    act(() => writeFromAnotherTab(activityRightRecord()));

    await waitFor(() => expect(model?.regions.right.occupant).toBe('activity'));
    expect(model?.regions.bottom.visible).toBe(false);
    expect(model?.lastShownRegion).toBe('right');
  });

  test('an unrelated setting’s write re-materializes an equal record and changes nothing', async () => {
    seedEnvelope({ regionArrangement: activityRightRecord() });
    setUrl('/?dockSlotPlacement=left');
    const setSpy = vi.spyOn(deviceSettingsStore, 'set');
    render(<Harness />);
    await waitFor(() => expect(model).not.toBeNull());
    // The URL put Chat in left; the stored record still says bottom.
    expect(model?.regions.left.occupant).toBe('chat');
    const before = model?.regions;

    // Any write re-parses the envelope from storage, so every value arrives
    // under a new reference. An equal record under a new reference must not
    // be adopted, or the URL's placement would be undone by a theme change.
    act(() => deviceSettingsStore.set('theme', 'light'));
    await settle();

    expect(model?.regions).toBe(before);
    expect(model?.regions.left.occupant).toBe('chat');
    expect(regionArrangementWrites(setSpy)).toHaveLength(0);
  });
});

// #928 slice iii / #1385: maximize is a region attribute; Chat's legacy
// `maximize` param and `lastDockMaximized` are its mirror, never its source.
describe('RegionModelProvider carries maximize as a region attribute', () => {
  test('?dock=open&maximize=true maximizes Chat’s region at mount and writes nothing', async () => {
    setUrl('/?dock=open&maximize=true');
    const spies = spyOnEverySetter();

    render(<Harness />);
    await waitFor(() => expect(model).not.toBeNull());

    expect(model?.regions.bottom).toMatchObject({
      occupant: 'chat',
      visible: true,
      maximized: true,
    });
    await settle();
    expectNoWrites(spies);
  });

  test('a record with right.maximized and Activity in right mounts maximized, and the URL says nothing', async () => {
    seedEnvelope({
      regionArrangement: activityRightRecord({
        right: {
          visible: true,
          size: 517,
          occupant: { kind: 'surface', id: 'activity' },
          maximized: true,
        },
      }),
    });
    setUrl('/');
    const spies = spyOnEverySetter();

    render(<Harness />);
    await waitFor(() => expect(model).not.toBeNull());

    expect(model?.regions.right).toEqual({
      visible: true,
      size: 517,
      occupant: 'activity',
      maximized: true,
    });
    expect(model?.regions.bottom.maximized).toBe(false);
    expect(navigationStore.getSnapshot().isDockMaximized).toBe(false);
    await settle();
    expectNoWrites(spies);
  });

  test('the URL’s maximize=true beats a record maximizing another region', async () => {
    seedEnvelope({
      regionArrangement: activityRightRecord({
        right: {
          visible: true,
          size: 517,
          occupant: { kind: 'surface', id: 'activity' },
          maximized: true,
        },
      }),
    });
    setUrl('/?dock=open&maximize=true');

    render(<Harness />);
    await waitFor(() => expect(model).not.toBeNull());

    expect(model?.regions.bottom).toMatchObject({
      occupant: 'chat',
      visible: true,
      maximized: true,
    });
    // One region at a time: the deep-linked Chat maximize restored Activity.
    expect(model?.regions.right.maximized).toBe(false);
  });

  test('maximizing Activity through setRegion persists the record and never calls setDockState', async () => {
    seedEnvelope({ regionArrangement: activityRightRecord() });
    setUrl('/');
    render(<Harness />);
    await waitFor(() => expect(model?.regions.right.occupant).toBe('activity'));
    const spies = spyOnEverySetter();
    // The store's memory is a module singleton an earlier test may have
    // raised; lower it so "untouched" below is observable.
    navigationStore.lastDockMaximized = false;

    act(() => model?.setRegion('right', { maximized: true }));

    await waitFor(() =>
      expect(
        deviceSettingsStore.get('regionArrangement').regions.right,
      ).toEqual({
        visible: true,
        size: 517,
        occupant: { kind: 'surface', id: 'activity' },
        maximized: true,
      }),
    );
    expect(model?.regions.right.maximized).toBe(true);
    expect(spies.setDockState).not.toHaveBeenCalled();
    expect(navigationStore.getSnapshot().isDockMaximized).toBe(false);
    expect(navigationStore.lastDockMaximized).toBe(false);
  });

  test('maximizing Chat’s region calls setDockState(true, true) exactly once and persists', async () => {
    setUrl('/?dock=open');
    render(<Harness />);
    await waitFor(() => expect(model?.regions.bottom.visible).toBe(true));
    const spies = spyOnEverySetter();

    act(() => model?.setRegion('bottom', { maximized: true }));

    await waitFor(() => expect(spies.setDockState).toHaveBeenCalledTimes(1));
    expect(spies.setDockState).toHaveBeenCalledWith(true, true);
    expect(navigationStore.getSnapshot().isDockMaximized).toBe(true);
    expect(navigationStore.lastDockMaximized).toBe(true);
    await waitFor(() =>
      expect(
        deviceSettingsStore.get('regionArrangement').regions.bottom.maximized,
      ).toBe(true),
    );
    // Settled: the inbound sync saw a navigation that already agrees, so no
    // second write.
    await settle();
    expect(spies.setDockState).toHaveBeenCalledTimes(1);

    // Restore: an explicit un-maximize clears the memory (an explicit
    // non-maximized open, navigation-store.ts).
    act(() => model?.setRegion('bottom', { maximized: false }));
    await waitFor(() => expect(spies.setDockState).toHaveBeenCalledTimes(2));
    expect(spies.setDockState).toHaveBeenLastCalledWith(true, false);
    expect(navigationStore.lastDockMaximized).toBe(false);
  });

  test('hiding a maximized Chat forwards the maximize it closed from, so lastDockMaximized survives', async () => {
    setUrl('/?dock=open&maximize=true');
    render(<Harness />);
    await waitFor(() => expect(model?.regions.bottom.maximized).toBe(true));
    const spies = spyOnEverySetter();

    act(() => model?.setRegion('bottom', { visible: false }));

    await waitFor(() => expect(spies.setDockState).toHaveBeenCalledTimes(1));
    expect(spies.setDockState).toHaveBeenCalledWith(false, true);
    expect(model?.regions.bottom.maximized).toBe(false);
    expect(
      new URLSearchParams(window.location.search).get('maximize'),
    ).toBeNull();
    expect(navigationStore.lastDockMaximized).toBe(true);
  });

  test('navigation’s maximize is inbound: a focusSession-style setDockState(true, true) maximizes Chat’s region', async () => {
    setUrl('/?dock=open');
    render(<Harness />);
    await waitFor(() => expect(model?.regions.bottom.visible).toBe(true));
    const setSpy = vi.spyOn(deviceSettingsStore, 'set');

    act(() => navigationStore.setDockState(true, true));

    await waitFor(() => expect(model?.regions.bottom.maximized).toBe(true));
    // The seed is inbound: the mirror does not replay it as a user write,
    // but the arrangement did change, so the record persists it.
    await waitFor(() =>
      expect(regionArrangementWrites(setSpy)).toHaveLength(1),
    );

    act(() => navigationStore.collapseMaximizedDock());
    await waitFor(() => expect(model?.regions.bottom.maximized).toBe(false));
    expect(navigationStore.lastDockMaximized).toBe(true);
  });
});

test('the default arrangement seeds exactly the contracts default literal', () => {
  expect(toRegionArrangementRecord(DEFAULT_DEVICE_REGION_ARRANGEMENT)).toEqual(
    DEFAULT_REGION_ARRANGEMENT_RECORD,
  );
});
