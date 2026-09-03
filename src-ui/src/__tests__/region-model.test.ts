// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  DEFAULT_DEVICE_REGION_LAYOUT,
  dockMirrorDiff,
  foldedDockRegion,
  isRegionAvailable,
  occupiedDockRegion,
  placeSurface,
  REGION_SURFACE_REGISTRY,
  seedRegionLayoutFromDock,
  syncRegionLayoutFromDock,
  updateRegion,
} from '../regions/region-model';

describe('region model', () => {
  afterEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  test('declares availability once per breakpoint', () => {
    expect(
      (['main', 'left', 'right', 'bottom'] as const).filter((id) =>
        isRegionAvailable(id, 'phone'),
      ),
    ).toEqual(['main', 'bottom']);
    expect(
      (['main', 'left', 'right', 'bottom'] as const).filter((id) =>
        isRegionAvailable(id, 'desktop'),
      ),
    ).toEqual(['main', 'left', 'right', 'bottom']);
  });

  test('a region has one occupant and assigning another replaces it', () => {
    const first = updateRegion(DEFAULT_DEVICE_REGION_LAYOUT, 'bottom', {
      occupant: 'chat',
    });
    const second = updateRegion(first, 'bottom', { occupant: 'activity' });

    expect(second.bottom.occupant).toBe('activity');
    expect(Object.keys(second.bottom)).toEqual(['visible', 'size', 'occupant']);
  });

  test('finds the dock region occupied by any surface', () => {
    const layout = placeSurface(
      DEFAULT_DEVICE_REGION_LAYOUT,
      'fixture',
      'right',
    );

    expect(occupiedDockRegion(layout, 'fixture')).toBe('right');
    expect(occupiedDockRegion(layout, 'missing')).toBeUndefined();
  });

  test('hiding a region retains its occupant and size', () => {
    const sized = updateRegion(DEFAULT_DEVICE_REGION_LAYOUT, 'bottom', {
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
      DEFAULT_DEVICE_REGION_LAYOUT,
      'activity',
      'right',
    );
    expect(foldedDockRegion(withActivity, 'right')).toBe('right');

    const hidden = updateRegion(withActivity, 'right', { visible: false });
    expect(foldedDockRegion(hidden, 'right')).toBe('bottom');

    const allHidden = updateRegion(hidden, 'bottom', { visible: false });
    expect(foldedDockRegion(allHidden, null)).toBe('bottom');
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
      DEFAULT_DEVICE_REGION_LAYOUT,
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
      visible: true,
      size: 400,
      occupant: 'chat',
    });
  });

  test('placing a homeless surface vacates the displaced occupant', () => {
    const placed = placeSurface(
      DEFAULT_DEVICE_REGION_LAYOUT,
      'activity',
      'bottom',
    );

    expect(placed.bottom.occupant).toBe('activity');
    expect(occupiedDockRegion(placed, 'chat')).toBeUndefined();
  });

  test('seeds the in-memory model from resolved navigation placement and persisted sizes', () => {
    const layout = seedRegionLayoutFromDock(
      {
        chatDockHeight: 417,
        chatDockWidth: 389,
      },
      'right',
      true,
    );

    expect(layout.bottom).toEqual({
      visible: false,
      size: 417,
      occupant: null,
    });
    expect(layout.left.size).toBe(389);
    expect(layout.right).toEqual({
      visible: true,
      size: 389,
      occupant: 'chat',
    });
  });

  test('a same-visibility move mirrors placement only', () => {
    const before = updateRegion(DEFAULT_DEVICE_REGION_LAYOUT, 'bottom', {
      visible: true,
    });
    const after = placeSurface(before, 'chat', 'right');

    // `visible` is compared across the move, never re-emitted with it: the
    // mirror's `setDockState` records `lastDockMaximized` as a side effect,
    // so a spurious write here would forget a remembered maximize.
    expect(dockMirrorDiff(before, after)).toEqual({ placement: 'right' });
  });

  test('placing into a region while hidden mirrors the reveal', () => {
    const after = placeSurface(DEFAULT_DEVICE_REGION_LAYOUT, 'chat', 'right');

    expect(dockMirrorDiff(DEFAULT_DEVICE_REGION_LAYOUT, after)).toEqual({
      placement: 'right',
      visible: true,
    });
  });

  test('sync preserves the size of a region occupied by a second surface', () => {
    const withActivity = updateRegion(DEFAULT_DEVICE_REGION_LAYOUT, 'right', {
      occupant: 'activity',
      visible: true,
      size: 517,
    });
    const synced = syncRegionLayoutFromDock(
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
    const withActivity = updateRegion(DEFAULT_DEVICE_REGION_LAYOUT, 'right', {
      occupant: 'activity',
      visible: true,
    });
    const synced = syncRegionLayoutFromDock(
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
    const before = updateRegion(DEFAULT_DEVICE_REGION_LAYOUT, 'right', {
      occupant: 'activity',
      visible: true,
    });
    const after = updateRegion(before, 'right', { size: 517 });

    expect(dockMirrorDiff(before, after)).toEqual({});
  });
});
