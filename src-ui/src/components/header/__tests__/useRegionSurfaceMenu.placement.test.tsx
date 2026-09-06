/** @vitest-environment jsdom */

/**
 * The converse of `SEGMENT_REGION_ORDER`'s `satisfies readonly RegionId[]`.
 *
 * That clause pins every member of the picker's segment order to the region
 * union — no segment can name a region the model does not have. It says nothing
 * the other way: adding a fifth region to `REGION_IDS` and forgetting to place
 * it in the order compiles, and the picker silently offers a surface one fewer
 * placement than it declares. This file is what the constant's docblock cites,
 * and it existed only in that citation until the #1552 review (M6) looked.
 *
 * Asserted through the HOOK, not against the constant. `SEGMENT_REGION_ORDER` is
 * module-private, and a test that exported it to compare against its own literal
 * would satisfy its name without reaching the picker. Activity declares every
 * region in the registry, so with every dock placement available its row must
 * expose one segment per `REGION_IDS` member — which is the completeness claim,
 * derived from the model's own list.
 */

import { renderHook } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  regions: {
    main: { visible: true, size: 0, occupant: 'home' as string | null },
    left: { visible: false, size: 400, occupant: null },
    right: { visible: false, size: 400, occupant: null },
    bottom: { visible: true, size: 320, occupant: 'chat' },
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
  REGION_IDS,
  REGION_SURFACE_REGISTRY,
} from '../../../regions/region-model';
import { useRegionSurfaceMenu } from '../useRegionSurfaceMenu';

describe('the Layout picker offers every region the model declares', () => {
  test('a surface declaring all of REGION_IDS gets a segment for each, plus Hidden', () => {
    const { result } = renderHook(() => useRegionSurfaceMenu());

    const activity = REGION_SURFACE_REGISTRY.get('activity');
    // Precondition, not decoration: this claim is only meaningful while some
    // registered surface actually declares every region. If Activity narrows,
    // this must red and point at the next surface that can carry the proof —
    // not pass over a row that was never asked for the missing segment.
    expect(
      activity && [...REGION_IDS].every((id) => activity.regions.includes(id)),
      'no registered surface declares every region, so this file proves nothing',
    ).toBe(true);

    const row = result.current.placementRows.find(
      (candidate) => candidate.surfaceId === 'activity',
    );
    expect(row, 'Activity has no placement row').toBeDefined();

    const regionSegments = row?.segments.filter(
      (segment) => segment.region !== null,
    );
    expect(regionSegments?.map((segment) => segment.region)).toEqual(
      // Order is the picker's own (dock edges as they sit on screen, then the
      // primary area); membership is the model's. Compared as a SET so this
      // fails on a missing region rather than on a deliberate reordering.
      expect.arrayContaining([...REGION_IDS]),
    );
    expect(regionSegments).toHaveLength(REGION_IDS.length);

    // And exactly one non-region segment: Hidden, which the row appends.
    const hidden = row?.segments.filter((segment) => segment.region === null);
    expect(hidden?.map((segment) => segment.label)).toEqual(['Hidden']);
  });

  test('a surface is never offered a region it does not declare', () => {
    const { result } = renderHook(() => useRegionSurfaceMenu());

    // Chat declares the dock regions only — `main` would be a projectless
    // full-screen mount no entry point makes (see the registry's own note).
    const chat = REGION_SURFACE_REGISTRY.get('chat');
    expect(chat?.regions.includes('main')).toBe(false);

    const row = result.current.placementRows.find(
      (candidate) => candidate.surfaceId === 'chat',
    );
    expect(row?.segments.map((segment) => segment.region)).not.toContain(
      'main',
    );
    for (const segment of row?.segments ?? []) {
      if (segment.region === null) continue;
      expect(
        chat?.regions.includes(segment.region),
        `Chat is offered ${segment.region}, which it does not declare`,
      ).toBe(true);
    }
  });
});
