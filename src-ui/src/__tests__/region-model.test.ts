// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  DEFAULT_DEVICE_REGION_ARRANGEMENT,
  dockMirrorDiff,
  firstFreeDockRegion,
  foldedDockRegion,
  occupiedDockRegion,
  placeSurface,
  REGION_SURFACE_REGISTRY,
  revealSurface,
  seedRegionArrangementFromDock,
  showSurfaceAlone,
  syncRegionArrangementFromDock,
  updateRegion,
} from '../regions/region-model';

describe('region model', () => {
  afterEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  test('a region has one occupant and assigning another replaces it', () => {
    const first = updateRegion(DEFAULT_DEVICE_REGION_ARRANGEMENT, 'bottom', {
      occupant: 'chat',
    });
    const second = updateRegion(first, 'bottom', { occupant: 'activity' });

    expect(second.bottom.occupant).toBe('activity');
    expect(Object.keys(second.bottom)).toEqual(['visible', 'size', 'occupant']);
  });

  test('finds the dock region occupied by any surface', () => {
    const arrangement = placeSurface(
      DEFAULT_DEVICE_REGION_ARRANGEMENT,
      'fixture',
      'right',
    );

    expect(occupiedDockRegion(arrangement, 'fixture')).toBe('right');
    expect(occupiedDockRegion(arrangement, 'missing')).toBeUndefined();
  });

  test('hiding a region retains its occupant and size', () => {
    const sized = updateRegion(DEFAULT_DEVICE_REGION_ARRANGEMENT, 'bottom', {
      visible: true,
      size: 444,
      occupant: 'chat',
    });

    expect(updateRegion(sized, 'bottom', { visible: false }).bottom).toEqual({
      visible: false,
      size: 444,
      occupant: 'chat',
    });
  });

  test('the coarse fold chooses the most recently shown occupied region and falls back to Chat', () => {
    const withActivity = placeSurface(
      DEFAULT_DEVICE_REGION_ARRANGEMENT,
      'activity',
      'right',
    );
    expect(foldedDockRegion(withActivity, 'right')).toBe('right');

    const hidden = updateRegion(withActivity, 'right', { visible: false });
    expect(foldedDockRegion(hidden, 'right')).toBe('bottom');

    const allHidden = updateRegion(hidden, 'bottom', { visible: false });
    expect(foldedDockRegion(allHidden, null)).toBe('bottom');
  });

  test('the coarse fold chooses lastShownRegion when two occupied regions are visible', () => {
    const bothVisible = updateRegion(
      placeSurface(DEFAULT_DEVICE_REGION_ARRANGEMENT, 'activity', 'right'),
      'bottom',
      { visible: true },
    );

    expect(foldedDockRegion(bothVisible, 'right')).toBe('right');
    expect(foldedDockRegion(bothVisible, 'bottom')).toBe('bottom');
  });

  test('a homeless surface prefers a free default and otherwise takes the first free dock region', () => {
    expect(
      firstFreeDockRegion(DEFAULT_DEVICE_REGION_ARRANGEMENT, 'right'),
    ).toBe('right');
    const chatAtRight = placeSurface(
      DEFAULT_DEVICE_REGION_ARRANGEMENT,
      'chat',
      'right',
    );
    expect(firstFreeDockRegion(chatAtRight, 'right')).toBe('bottom');
  });

  test('revealSurface makes an occupied hidden surface visible without moving it', () => {
    const hidden = updateRegion(
      placeSurface(DEFAULT_DEVICE_REGION_ARRANGEMENT, 'activity', 'right'),
      'right',
      { visible: false },
    );

    const shown = revealSurface(hidden, 'activity', 'left');

    expect(shown.region).toBe('right');
    expect(shown.arrangement.right).toMatchObject({
      occupant: 'activity',
      visible: true,
    });
    expect(shown.arrangement.left).toEqual(hidden.left);
  });

  test('revealSurface uses the preferred free region', () => {
    const shown = revealSurface(
      DEFAULT_DEVICE_REGION_ARRANGEMENT,
      'activity',
      'right',
    );

    expect(shown.region).toBe('right');
    expect(shown.arrangement.right).toMatchObject({
      occupant: 'activity',
      visible: true,
    });
  });

  test('revealSurface uses the first free region when the preferred region is occupied', () => {
    const occupiedPreferred = placeSurface(
      DEFAULT_DEVICE_REGION_ARRANGEMENT,
      'fixture',
      'right',
    );

    const shown = revealSurface(occupiedPreferred, 'activity', 'right');

    expect(shown.region).toBe('left');
    expect(shown.arrangement.left.occupant).toBe('activity');
  });

  test('revealSurface puts Activity in bottom when Chat occupies right', () => {
    const shown = revealSurface(
      placeSurface(DEFAULT_DEVICE_REGION_ARRANGEMENT, 'chat', 'right'),
      'activity',
      'right',
    );

    expect(shown.region).toBe('bottom');
    expect(shown.arrangement.bottom.occupant).toBe('activity');
  });

  test('showSurfaceAlone leaves the revealed surface as the only visible dock region', () => {
    const visible = updateRegion(
      placeSurface(DEFAULT_DEVICE_REGION_ARRANGEMENT, 'fixture', 'left'),
      'bottom',
      { visible: true },
    );

    const shown = showSurfaceAlone(visible, 'activity', 'right');

    expect(shown.region).toBe('right');
    expect(
      ['left', 'right', 'bottom'].filter(
        (id) => shown.arrangement[id as 'left' | 'right' | 'bottom'].visible,
      ),
    ).toEqual(['right']);
  });

  test('registers Chat and Activity with their default regions', () => {
    expect([...REGION_SURFACE_REGISTRY.values()]).toEqual([
      expect.objectContaining({
        id: 'chat',
        title: 'Chat',
        icon: 'chat',
        shortcut: { id: 'dock.toggle', key: 'd', modifiers: ['cmd'] },
        defaultRegion: 'bottom',
      }),
      expect.objectContaining({
        id: 'activity',
        title: 'Activity',
        icon: 'activity',
        shortcut: {
          id: 'activity.toggle',
          key: 'a',
          modifiers: ['cmd', 'shift'],
        },
        defaultRegion: 'right',
      }),
    ]);
  });

  test('placing an already-mounted surface swaps occupants without moving region sizes', () => {
    const withActivity = placeSurface(
      DEFAULT_DEVICE_REGION_ARRANGEMENT,
      'activity',
      'right',
    );
    const swapped = placeSurface(withActivity, 'activity', 'bottom');

    expect(swapped.bottom).toEqual({
      visible: true,
      size: 320,
      occupant: 'activity',
    });
    expect(swapped.right).toEqual({
      visible: false,
      size: 400,
      occupant: 'chat',
    });
  });

  test('a swap carries the displaced occupant visibility and reveals the incoming surface', () => {
    const hiddenActivity = updateRegion(
      updateRegion(
        placeSurface(DEFAULT_DEVICE_REGION_ARRANGEMENT, 'activity', 'right'),
        'right',
        { visible: false },
      ),
      'bottom',
      { visible: true },
    );
    const swapped = placeSurface(hiddenActivity, 'activity', 'bottom');

    expect(swapped.bottom).toMatchObject({
      occupant: 'activity',
      visible: true,
    });
    expect(swapped.right).toMatchObject({ occupant: 'chat', visible: true });
  });

  test('placing a homeless surface relocates the displaced occupant to the first free dock region', () => {
    const placed = placeSurface(
      DEFAULT_DEVICE_REGION_ARRANGEMENT,
      'activity',
      'bottom',
    );

    expect(placed.bottom.occupant).toBe('activity');
    expect(placed.right).toMatchObject({ occupant: 'chat', visible: false });
  });

  test('placing a homeless surface vacates the displaced occupant when no dock region is free', () => {
    const fullArrangement = {
      ...structuredClone(DEFAULT_DEVICE_REGION_ARRANGEMENT),
      left: { visible: true, size: 400, occupant: 'left-surface' },
      right: { visible: true, size: 400, occupant: 'right-surface' },
    };
    const placed = placeSurface(fullArrangement, 'activity', 'bottom');

    expect(placed.bottom.occupant).toBe('activity');
    expect(occupiedDockRegion(placed, 'chat')).toBeUndefined();
  });

  test('seeds the in-memory model from resolved navigation placement and persisted sizes', () => {
    const arrangement = seedRegionArrangementFromDock(
      {
        chatDockHeight: 417,
        chatDockWidth: 389,
      },
      'right',
      true,
    );

    expect(arrangement.bottom).toEqual({
      visible: false,
      size: 417,
      occupant: null,
    });
    expect(arrangement.left.size).toBe(389);
    expect(arrangement.right).toEqual({
      visible: true,
      size: 389,
      occupant: 'chat',
    });
  });

  test('a same-visibility move mirrors placement only', () => {
    const before = updateRegion(DEFAULT_DEVICE_REGION_ARRANGEMENT, 'bottom', {
      visible: true,
    });
    const after = placeSurface(before, 'chat', 'right');

    // `visible` is compared across the move, never re-emitted with it: the
    // mirror's `setDockState` records `lastDockMaximized` as a side effect,
    // so a spurious write here would forget a remembered maximize.
    expect(dockMirrorDiff(before, after)).toEqual({
      placement: 'right',
      size: { right: 400 },
    });
  });

  test("a Chat move mirrors the entered region's size and the next inbound sync preserves it", () => {
    const sizedRight = updateRegion(
      placeSurface(DEFAULT_DEVICE_REGION_ARRANGEMENT, 'activity', 'right'),
      'right',
      { size: 600 },
    );
    const swapped = placeSurface(sizedRight, 'activity', 'bottom');
    const diff = dockMirrorDiff(sizedRight, swapped);

    expect(diff).toEqual({ placement: 'right', size: { right: 600 } });
    const synced = syncRegionArrangementFromDock(
      swapped,
      {
        chatDockHeight: 320,
        chatDockWidth: diff.size?.right ?? 400,
      },
      true,
      'right',
    );
    expect(synced.right.size).toBe(600);
  });

  test('placing into a region while hidden mirrors the reveal', () => {
    const after = placeSurface(
      DEFAULT_DEVICE_REGION_ARRANGEMENT,
      'chat',
      'right',
    );

    expect(dockMirrorDiff(DEFAULT_DEVICE_REGION_ARRANGEMENT, after)).toEqual({
      placement: 'right',
      size: { right: 400 },
      visible: true,
    });
  });

  test('sync preserves the size of a region occupied by a second surface', () => {
    const withActivity = updateRegion(
      DEFAULT_DEVICE_REGION_ARRANGEMENT,
      'right',
      {
        occupant: 'activity',
        visible: true,
        size: 517,
      },
    );
    const synced = syncRegionArrangementFromDock(
      withActivity,
      { chatDockHeight: 333, chatDockWidth: 444 },
      false,
      'bottom',
    );

    expect(synced.right).toEqual({
      occupant: 'activity',
      visible: true,
      size: 517,
    });
    expect(synced.bottom.visible).toBe(false);
  });

  test('sync never evicts a second occupant when dockMode names its region', () => {
    const withActivity = updateRegion(
      DEFAULT_DEVICE_REGION_ARRANGEMENT,
      'right',
      {
        occupant: 'activity',
        visible: true,
      },
    );
    const synced = syncRegionArrangementFromDock(
      withActivity,
      { chatDockHeight: 320, chatDockWidth: 400 },
      true,
      'right',
    );

    expect(synced.right.occupant).toBe('activity');
    expect(synced.bottom.occupant).toBe('chat');
    expect(synced.bottom.visible).toBe(true);
  });

  test('mirror ignores size changes from a region Activity occupies', () => {
    const before = updateRegion(DEFAULT_DEVICE_REGION_ARRANGEMENT, 'right', {
      occupant: 'activity',
      visible: true,
    });
    const after = updateRegion(before, 'right', { size: 517 });

    expect(dockMirrorDiff(before, after)).toEqual({});
  });
});
