// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  DEFAULT_DEVICE_REGION_LAYOUT,
  dockMirrorDiff,
  isRegionAvailable,
  occupiedDockRegion,
  placeSurface,
  REGION_SURFACE_REGISTRY,
  seedRegionLayoutFromDock,
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

  test('registers Chat as the only step-1 surface', () => {
    expect([...REGION_SURFACE_REGISTRY.values()]).toEqual([
      expect.objectContaining({
        id: 'chat',
        title: 'Chat',
        icon: 'chat',
        shortcut: { id: 'dock.toggle', key: 'd', modifiers: ['cmd'] },
      }),
    ]);
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
});
