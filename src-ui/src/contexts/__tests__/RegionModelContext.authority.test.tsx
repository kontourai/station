/**
 * @vitest-environment jsdom
 *
 * #928 step 3a: the region layout is the authority for placement, not a
 * projection of the single legacy dock.
 *
 * The property that changed is narrower than "two occupants are expressible" —
 * the old `syncRegionLayoutFromDock` only cleared occupants equal to 'chat', so
 * a differently-named second occupant always survived it. What it DID do on
 * every settings change was force the chat surface back to
 * `settings.dockSlotPlacement` and re-derive visibility from the global
 * `isDockOpen`. So a region write that moved chat, or hid it, was reverted by
 * the next unrelated settings edit. That is what these assert.
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
  it('keeps a region write to the chat surface across an unrelated settings change', () => {
    const { view, model } = renderModel();

    // Persisted placement is 'bottom'. Move chat to 'right' through the region
    // model, and put a second surface in 'bottom'.
    act(() => {
      model().setRegion('bottom', { occupant: 'activity', visible: true });
      model().setRegion('right', { occupant: 'chat', visible: true });
    });

    expect(model().regions.right.occupant).toBe('chat');
    expect(model().regions.bottom.occupant).toBe('activity');

    // The old projection forced chat back to settings.dockSlotPlacement on any
    // settings change, taking 'bottom' from its occupant. Both must survive.
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

    expect(model().regions.right.occupant).toBe('chat');
    expect(model().regions.bottom.occupant).toBe('activity');
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
