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
import { describe, expect, test, vi } from 'vitest';

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
    setRegion: vi.fn(),
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
import { useRegionSurfaceMenu } from '../useRegionSurfaceMenu';

describe('the toolbar offers a toggle for every dock region the model declares', () => {
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

    // Bottom holds Chat and is visible: a pressed toggle, no offers. Left
    // and right are empty: unpressed, and offering the shell surfaces that
    // declare them.
    const bottom = toggles.find((toggle) => toggle.region === 'bottom');
    expect(bottom).toMatchObject({
      label: 'Bottom',
      paneTitles: ['Chat'],
      visible: true,
      offers: [],
    });
    const left = toggles.find((toggle) => toggle.region === 'left');
    expect(left).toMatchObject({
      label: 'Left',
      paneTitles: [],
      visible: false,
    });
    expect(left?.offers.map((offer) => offer.surfaceId)).toEqual([
      'chat',
      'activity',
    ]);
  });

  /**
   * #2047 (`RegisteredSurface.exposure`): a catalog-only surface is never an
   * empty region's offer and is not in the list the chords read, even though
   * it declares every dock region. Deleting the `exposure !== 'catalog'`
   * clause from `surfaceList` fails both assertions; dropping the flag from a
   * registry entry fails the precondition, which points at the registry.
   */
  test('a catalog-only surface is never offered and is not in the shell’s surface list', () => {
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
    // Exact, per region: a negated `arrayContaining` would pass with four of
    // five catalog ids leaked. An occupied region offers nothing; an empty
    // one offers exactly the two shell surfaces.
    for (const toggle of result.current.regionToggles)
      expect(
        toggle.offers.map((offer) => offer.surfaceId),
        toggle.region,
      ).toEqual(toggle.paneTitles.length ? [] : ['chat', 'activity']);
    expect(result.current.surfaceList.map((surface) => surface.id)).toEqual([
      'chat',
      'activity',
    ]);
  });

  test('a region is never offered a surface that does not declare it', () => {
    const { result } = renderHook(() => useRegionSurfaceMenu());
    for (const toggle of result.current.regionToggles)
      for (const offer of toggle.offers)
        expect(
          REGION_SURFACE_REGISTRY.get(offer.surfaceId)?.regions.includes(
            toggle.region,
          ),
          `${toggle.region} is offered ${offer.surfaceId}, which does not declare it`,
        ).toBe(true);
  });
});
