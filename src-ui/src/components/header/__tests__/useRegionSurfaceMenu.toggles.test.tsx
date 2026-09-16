/** @vitest-environment jsdom */

/**
 * The converse of `TOGGLE_REGION_ORDER`'s `satisfies readonly DockRegionId[]`
 * (#2143).
 *
 * That clause pins every member of the toolbar's toggle order to the dock
 * union — no toggle can name a region the model does not have. It says nothing
 * the other way: adding a dock region to `DOCK_REGION_IDS` and forgetting to
 * place it in the order compiles, and the toolbar silently offers one fewer
 * toggle than the model has regions. Asserted through the HOOK, not against
 * the constant, which is module-private: with every dock placement available
 * the hook must yield one toggle per `DOCK_REGION_IDS` member.
 */

import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  regions: {
    main: {
      visible: true,
      size: 0,
      panes: ['home'],
      occupant: 'home' as string | null,
    },
    left: { visible: false, size: 400, panes: [], occupant: null },
    right: { visible: false, size: 400, panes: [], occupant: null },
    bottom: { visible: true, size: 320, panes: ['chat'], occupant: 'chat' },
  },
  setRegion: vi.fn(),
}));

vi.mock('../../../contexts/RegionModelContext', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../../contexts/RegionModelContext')
    >();
  const { REGION_SURFACE_REGISTRY } = await import(
    '../../../regions/region-model'
  );
  const model = {
    regions: harness.regions,
    lastShownRegion: null,
    surfaces: REGION_SURFACE_REGISTRY,
    setRegion: harness.setRegion,
    placeSurface: vi.fn(),
    showSurface: vi.fn(),
  };
  return {
    ...actual,
    useRegionModelOptional: () => model,
    useRegionModel: () => model,
  };
});

vi.mock('../../../hooks/useIsMobile', () => ({
  useIsMobile: () => false,
  useDockSlotDevice: () => ({ viewportWidth: 1456, coarsePointer: false }),
  // Every dock placement, so nothing is filtered out by the DEVICE and the only
  // filter left is the surface's own declaration plus the segment order.
  availablePlacements: () => ['left', 'right', 'bottom'],
}));

import {
  DOCK_REGION_IDS,
  REGION_SURFACE_REGISTRY,
} from '../../../regions/region-model';
import { registerRegionVisibilityApplier } from '../../../regions/region-visibility-appliers';
import { useRegionSurfaceMenu } from '../useRegionSurfaceMenu';

/** Unregisters for the appliers a test published, run after every test. */
const publishedAppliers: (() => void)[] = [];

afterEach(() => {
  while (publishedAppliers.length) publishedAppliers.pop()?.();
});

/** Publishes a shell's applier for `region`, as a mounted shell does. */
function publishApplier(region: 'left' | 'right' | 'bottom') {
  const applier = vi.fn();
  publishedAppliers.push(registerRegionVisibilityApplier(region, applier));
  return applier;
}

describe('the toolbar has a toggle for every dock region the model declares', () => {
  test('one toggle per DOCK_REGION_IDS member, each derived from the region', () => {
    const { result } = renderHook(() => useRegionSurfaceMenu());

    const toggles = result.current.regionToggles;
    // Membership is the model's; order is the toolbar's own (the edges as
    // they sit on screen). Compared as a SET so this fails on a missing
    // region rather than on a deliberate reordering.
    expect(toggles.map((toggle) => toggle.region)).toEqual(
      expect.arrayContaining([...DOCK_REGION_IDS]),
    );
    expect(toggles).toHaveLength(DOCK_REGION_IDS.length);

    // Bottom holds Chat and is visible: a pressed toggle naming its pane.
    // Left is empty and hidden. Since #2155 the two differ only in those
    // facts — there is no third shape, no offer list and no inert state.
    const bottom = toggles.find((toggle) => toggle.region === 'bottom');
    expect(bottom).toMatchObject({
      label: 'Bottom',
      paneTitles: ['Chat'],
      visible: true,
    });
    const left = toggles.find((toggle) => toggle.region === 'left');
    expect(left).toMatchObject({
      label: 'Left',
      paneTitles: [],
      visible: false,
    });
    // #2155 retired `offers` outright: every key a toggle carries is one of
    // these five, so a re-added offer list fails here rather than shipping a
    // second answer to "what goes in this region" beside the chooser (#2154).
    expect(Object.keys(left ?? {}).sort()).toEqual([
      'label',
      'onToggle',
      'paneTitles',
      'region',
      'visible',
    ]);
  });

  /**
   * #2155 D3: the toggle's write is the mounted shell's own show/hide, so the
   * toolbar and that region's chevron are the one act. Replacing the applier
   * lookup in `useRegionSurfaceMenu.ts` with the bare `model.setRegion` this
   * used to do reds both assertions: the shell's snap and maximize handling
   * would be skipped and the model written behind its back.
   */
  test('a mounted shell’s applier is the toggle’s route, and the model is not written behind it', () => {
    const applier = publishApplier('bottom');
    const { result } = renderHook(() => useRegionSurfaceMenu());
    harness.setRegion.mockClear();

    result.current.regionToggles
      .find((toggle) => toggle.region === 'bottom')
      ?.onToggle();

    // Bottom is visible in the fixture, so the press asks for closed.
    expect(applier).toHaveBeenCalledWith(false);
    expect(harness.setRegion).not.toHaveBeenCalled();
  });

  /**
   * The fallback, and the state that makes it the only possible path: a
   * HIDDEN EMPTY region mounts no host (#2153), so nothing has published an
   * applier for it and the model is written directly. `maximized: false`
   * rides along — a region with no shell has no maximized rendering to come
   * back to, and nothing may carry a maximize across a hide.
   */
  test('with no shell mounted for the region, the toggle writes the model itself', () => {
    const { result } = renderHook(() => useRegionSurfaceMenu());
    harness.setRegion.mockClear();

    result.current.regionToggles
      .find((toggle) => toggle.region === 'left')
      ?.onToggle();

    expect(harness.setRegion).toHaveBeenCalledWith('left', {
      visible: true,
      maximized: false,
    });
  });

  /**
   * The lookup is at PRESS time, not at render time. A shell mounts and
   * unmounts under a toolbar that does not re-render for it, so a toggle
   * holding an applier captured when it was built would keep calling a dead
   * shell's closure after its region's host went away.
   */
  test('a shell that unmounts after the toggle was built hands the press back to the model', () => {
    const unregister = registerRegionVisibilityApplier('bottom', vi.fn());
    const { result } = renderHook(() => useRegionSurfaceMenu());
    const bottom = result.current.regionToggles.find(
      (toggle) => toggle.region === 'bottom',
    );
    unregister();
    harness.setRegion.mockClear();

    bottom?.onToggle();

    expect(harness.setRegion).toHaveBeenCalledWith('bottom', {
      visible: false,
      maximized: false,
    });
  });

  /**
   * #2153: `visible` is the REGION's visibility and nothing else, and
   * `onToggle` acts on an empty region.
   *
   * Reverting `visible: state.visible` to `held && state.visible` in
   * `useRegionSurfaceMenu.ts` reds the first assertion: the region is on
   * screen and its control would report unpressed. Restoring the
   * `if (!held) return;` guard in `onToggle` reds the second: the write that
   * hides a visible empty region would be swallowed. A VISIBLE empty region
   * does mount a host, so this drives the fallback deliberately — no applier
   * is published here — to keep the assertion on the model write.
   */
  test('a visible EMPTY region reports visible, and its toggle writes', () => {
    harness.regions.left = {
      visible: true,
      size: 400,
      panes: [],
      occupant: null,
    };
    try {
      const { result } = renderHook(() => useRegionSurfaceMenu());
      const left = result.current.regionToggles.find(
        (toggle) => toggle.region === 'left',
      );
      expect(left).toMatchObject({ paneTitles: [], visible: true });
      harness.setRegion.mockClear();
      left?.onToggle();
      expect(harness.setRegion).toHaveBeenCalledWith('left', {
        visible: false,
        maximized: false,
      });
    } finally {
      harness.regions.left = {
        visible: false,
        size: 400,
        panes: [],
        occupant: null,
      };
    }
  });

  /**
   * #2047 (`RegisteredSurface.exposure`): a catalog-only surface is not in
   * the list the chords and the folded menu read, even though it declares
   * every dock region — the region's own chooser is what offers it (#2154),
   * and since #2155 the toolbar offers nothing at all. Deleting the
   * `exposure !== 'catalog'` clause from `surfaceList` fails the assertion;
   * dropping the flag from a registry entry fails the precondition, which
   * points at the registry.
   */
  test('a catalog-only surface is not in the shell’s surface list', () => {
    const catalogOnly = [...REGION_SURFACE_REGISTRY.values()].filter(
      (surface) => surface.exposure === 'catalog',
    );
    expect(
      catalogOnly.map((surface) => surface.id),
      'no registered surface is catalog-only, so this file proves nothing',
    ).toEqual([
      'workspace-agents',
      'device',
      'coding:terminal',
      'coding:diff',
      'coding:file-browser',
    ]);
    for (const surface of catalogOnly)
      expect(
        surface.regions.some((id) => id !== 'main'),
        surface.id,
      ).toBe(true);

    const { result } = renderHook(() => useRegionSurfaceMenu());
    expect(result.current.surfaceList.map((surface) => surface.id)).toEqual([
      'chat',
      'activity',
    ]);
  });
});
