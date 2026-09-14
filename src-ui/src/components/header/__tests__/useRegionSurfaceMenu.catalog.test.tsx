/** @vitest-environment jsdom */

/**
 * #2047, D2: the folded Regions menu of a bottom-only device offers a
 * catalog-only surface (`RegisteredSurface.exposure: 'catalog'`) only where
 * it is already PLACED — a Terminal behind Chat's tab gets its "Show … in
 * the dock" row, because that row is how a phone reaches a tab it cannot
 * see — and never as an unplaced "Show" row, which would make the toolbar
 * an offer the region's "+" is meant to be. Sibling of
 * `useRegionSurfaceMenu.placement.test.tsx`, which proves the picker half on
 * a fine pointer; this file's device mock is bottom-only, and a `vi.mock` is
 * per file.
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
      maximized: false,
    },
    left: {
      visible: false,
      size: 400,
      panes: [],
      occupant: null,
      maximized: false,
    },
    right: {
      visible: false,
      size: 400,
      panes: [],
      occupant: null,
      maximized: false,
    },
    // Terminal placed behind Chat's tab; Diff and Files unplaced.
    bottom: {
      visible: true,
      size: 320,
      panes: ['chat', 'coding:terminal'],
      occupant: 'chat',
      maximized: false,
    },
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
    lastShownRegion: 'bottom',
    surfaces: REGION_SURFACE_REGISTRY,
    setRegion: vi.fn(),
    placeSurface: vi.fn(),
    showSurface: vi.fn(),
    toggleSurface: vi.fn(),
  };
  return {
    ...actual,
    useRegionModelOptional: () => model,
    useRegionModel: () => model,
  };
});

vi.mock('../../../hooks/useIsMobile', () => ({
  useIsMobile: () => true,
  useDockSlotDevice: () => ({ viewportWidth: 390, coarsePointer: true }),
  availablePlacements: () => ['bottom'],
}));

import { REGION_SURFACE_REGISTRY } from '../../../regions/region-model';
import { useRegionSurfaceMenu } from '../useRegionSurfaceMenu';

describe('the folded Regions menu and catalog-only surfaces (#2047)', () => {
  /**
   * Deleting the `exposure !== 'catalog'` clause from `surfaceList` adds
   * "Show Diff in the dock" and "Show Files in the dock" rows and fails the
   * exact-list assertion; dropping the per-region loop's `region.panes` read
   * in favour of `surfaceList` loses the placed Terminal's row.
   */
  test('a placed catalog-only pane has its Show row; unplaced ones have none', () => {
    for (const id of ['coding:terminal', 'coding:diff', 'coding:file-browser'])
      expect(REGION_SURFACE_REGISTRY.get(id)?.exposure, id).toBe('catalog');

    const { result } = renderHook(() => useRegionSurfaceMenu());
    expect(result.current.bottomOnly).toBe(true);
    expect(
      result.current.menuItems.map((item) => [item.label, item.checked]),
    ).toEqual([
      ['Hide Chat from the dock', true],
      ['Show Terminal in the dock', false],
      ['Show Activity in the dock', false],
    ]);
    expect(result.current.surfaceList.map((surface) => surface.id)).toEqual([
      'chat',
      'activity',
    ]);
  });
});
