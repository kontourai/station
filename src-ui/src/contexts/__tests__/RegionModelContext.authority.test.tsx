/**
 * @vitest-environment jsdom
 *
 * #928 step 3a: the region layout is the authority for placement, not a
 * projection of the single legacy dock. The property that did not exist before
 * this step is two regions holding two DIFFERENT occupants at once — and
 * keeping them across a device-settings change, which used to overwrite region
 * state on every settings edit.
 */

import { act, render } from '@testing-library/react';
import { useEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  settings: {
    chatDockHeight: 320,
    chatDockWidth: 400,
    dockSlotPlacement: 'bottom' as string | undefined,
  },
  isDockOpen: true,
  setDeviceSetting: vi.fn(),
}));

vi.mock('../DeviceSettingsContext', () => ({
  useDeviceSettings: () => harness.settings,
  useDeviceSettingsActions: () => ({
    setDeviceSetting: harness.setDeviceSetting,
  }),
}));
vi.mock('../NavigationContext', () => ({
  useNavigation: () => ({ isDockOpen: harness.isDockOpen }),
}));

const { RegionModelProvider, useRegionModel } = await import(
  '../RegionModelContext'
);

function Probe({ onReady }: { onReady: (value: unknown) => void }) {
  const value = useRegionModel();
  useEffect(() => {
    onReady(value);
  }, [value, onReady]);
  return null;
}

type Model = ReturnType<typeof useRegionModel>;

let latest: Model | undefined;

function renderModel() {
  latest = undefined;
  const view = render(
    <RegionModelProvider>
      <Probe
        onReady={(value) => {
          latest = value as Model;
        }}
      />
    </RegionModelProvider>,
  );
  return { view, model: () => latest as Model };
}

describe('RegionModelContext — the region layout is the placement authority', () => {
  it('holds two different occupants at once, and keeps them across a settings change', () => {
    const { view, model } = renderModel();

    act(() => {
      model().setRegion('bottom', { occupant: 'chat', visible: true });
      model().setRegion('right', { occupant: 'activity', visible: true });
    });

    expect(model().regions.bottom.occupant).toBe('chat');
    expect(model().regions.right.occupant).toBe('activity');

    // The old model re-derived the whole layout from dockSlotPlacement on every
    // settings change, which cleared any second occupant. Re-render under a
    // changed setting and both must survive.
    harness.settings = { ...harness.settings, chatDockHeight: 512 };
    act(() => {
      // Keep capturing: rerendering with a no-op onReady would leave `model()`
      // holding the pre-change value object, and the assertions below would
      // read a stale snapshot that cannot see an overwrite.
      view.rerender(
        <RegionModelProvider>
          <Probe
            onReady={(value) => {
              latest = value as Model;
            }}
          />
        </RegionModelProvider>,
      );
    });

    expect(model().regions.bottom.occupant).toBe('chat');
    expect(model().regions.right.occupant).toBe('activity');
  });

  it('hiding a region keeps its occupant', () => {
    const { model } = renderModel();
    act(() => {
      model().setRegion('bottom', { occupant: 'chat', visible: true });
    });
    act(() => {
      model().setRegion('bottom', { visible: false });
    });
    expect(model().regions.bottom.visible).toBe(false);
    expect(model().regions.bottom.occupant).toBe('chat');
  });

  it('seeds placement from a returning user’s persisted dock setting', () => {
    harness.settings = { ...harness.settings, dockSlotPlacement: 'right' };
    const { model } = renderModel();
    expect(model().regions.right.occupant).toBe('chat');
    expect(model().regions.bottom.occupant).toBeNull();
    harness.settings = { ...harness.settings, dockSlotPlacement: 'bottom' };
  });
});
