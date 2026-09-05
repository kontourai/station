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
      },
      left: { visible: false, size: 400, occupant: null },
      right: {
        visible: true,
        size: 517,
        occupant: { kind: 'surface', id: 'activity' },
      },
      bottom: {
        visible: false,
        size: 320,
        occupant: { kind: 'surface', id: 'chat' },
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
    });
    expect(model?.regions.bottom.occupant).toBe('chat');
    expect(model?.regions.main.occupant).toBe('home');
  });

  test('a record equal to the default is no record: the legacy seed governs, so Chat follows dockSlotPlacement', async () => {
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
        },
      }),
    });
    setUrl('/?dock=open&dockSlotPlacement=left');

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
    });
  });

  test('a record naming a retired surface in right mounts with right empty', async () => {
    seedEnvelope({
      regionArrangement: activityRightRecord({
        right: {
          visible: true,
          size: 517,
          occupant: { kind: 'surface', id: 'retired-surface' },
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
    });
    // The store's echo of this tab's own write is not adopted as a change.
    await settle();
    expect(regionArrangementWrites(setSpy)).toHaveLength(1);
    expect(model?.regions.left.occupant).toBe('activity');
  });

  test('a mount is not a write: nothing is persisted until the user changes something', async () => {
    const setSpy = vi.spyOn(deviceSettingsStore, 'set');
    setUrl('/?dock=open');
    render(<Harness />);
    await waitFor(() => expect(model?.regions.bottom.visible).toBe(true));
    await settle();

    expect(regionArrangementWrites(setSpy)).toHaveLength(0);
    expect(deviceSettingsStore.get('regionArrangement')).toEqual(
      DEFAULT_REGION_ARRANGEMENT_RECORD,
    );
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

test('the default arrangement seeds exactly the contracts default literal', () => {
  expect(toRegionArrangementRecord(DEFAULT_DEVICE_REGION_ARRANGEMENT)).toEqual(
    DEFAULT_REGION_ARRANGEMENT_RECORD,
  );
});
