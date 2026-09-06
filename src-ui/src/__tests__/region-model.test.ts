// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  DEFAULT_DEVICE_REGION_ARRANGEMENT,
  dockMirrorDiff,
  firstFreeDockRegion,
  foldedDockRegion,
  occupiedDockRegion,
  occupiedRegion,
  placeSurface,
  REGION_SURFACE_REGISTRY,
  revealSurface,
  seedRegionArrangementFromDock,
  showSurfaceAlone,
  surfaceMayOccupy,
  syncRegionArrangementFromDock,
  toggleSurface,
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

  /**
   * #1523: the one decision behind a surface's chord and its folded-menu row.
   * The dock cases are what `useRegionSurfaceMenu.toggleSurface` used to
   * decide itself; the `main` cases are what it could not see.
   */
  describe('toggleSurface', () => {
    const fine = { lastShownRegion: null, bottomOnly: false };
    const activityDefault =
      REGION_SURFACE_REGISTRY.get('activity')!.defaultRegion;

    test('a visible dock occupant is hidden and a hidden one is revealed in place', () => {
      const visible = placeSurface(
        DEFAULT_DEVICE_REGION_ARRANGEMENT,
        'activity',
        'right',
      );
      const hidden = toggleSurface(visible, 'activity', activityDefault, fine);
      expect(hidden).toMatchObject({ kind: 'arrangement', shownRegion: null });
      if (hidden.kind !== 'arrangement') throw new Error('unreachable');
      expect(hidden.arrangement.right).toEqual({
        ...visible.right,
        visible: false,
      });

      const shown = toggleSurface(
        hidden.arrangement,
        'activity',
        activityDefault,
        fine,
      );
      expect(shown).toMatchObject({
        kind: 'arrangement',
        shownRegion: 'right',
      });
      if (shown.kind !== 'arrangement') throw new Error('unreachable');
      expect(shown.arrangement.right).toEqual(visible.right);
    });

    test('an unplaced surface is a show, left to showSurface', () => {
      expect(
        toggleSurface(
          DEFAULT_DEVICE_REGION_ARRANGEMENT,
          'activity',
          activityDefault,
          fine,
        ),
      ).toEqual({ kind: 'show' });
    });

    test('a main occupant moves to its default dock region, visible, and main empties to Home', () => {
      const activityInMain = placeSurface(
        DEFAULT_DEVICE_REGION_ARRANGEMENT,
        'activity',
        'main',
      );
      expect(activityInMain.main.occupant).toBe('activity');

      const toggled = toggleSurface(
        activityInMain,
        'activity',
        activityDefault,
        fine,
      );
      expect(toggled).toMatchObject({
        kind: 'arrangement',
        shownRegion: 'right',
      });
      if (toggled.kind !== 'arrangement') throw new Error('unreachable');
      expect(toggled.arrangement.right).toMatchObject({
        occupant: 'activity',
        visible: true,
      });
      // An emptied `main` is Home on screen and stays visible.
      expect(toggled.arrangement.main).toEqual({
        visible: true,
        size: 0,
        occupant: null,
      });
      // Chat's dock placement is untouched by a relocation into another region.
      expect(toggled.arrangement.bottom).toEqual(activityInMain.bottom);
    });

    test('on a coarse device a main occupant returning to the dock is the only visible dock region', () => {
      const activityInMain = updateRegion(
        placeSurface(DEFAULT_DEVICE_REGION_ARRANGEMENT, 'activity', 'main'),
        'bottom',
        { visible: true },
      );
      const toggled = toggleSurface(
        activityInMain,
        'activity',
        activityDefault,
        {
          lastShownRegion: 'bottom',
          bottomOnly: true,
        },
      );
      if (toggled.kind !== 'arrangement') throw new Error('unreachable');
      expect(toggled.arrangement.right).toMatchObject({
        occupant: 'activity',
        visible: true,
      });
      expect(toggled.arrangement.bottom).toMatchObject({
        occupant: 'chat',
        visible: false,
      });
      expect(toggled.shownRegion).toBe('right');
    });

    test('on a coarse device a visible surface that is not the folded region is a show, not a hide', () => {
      // Two visible occupied dock regions with Chat's `bottom` the folded one
      // (`lastShownRegion`). Activity in `right` is visible too, so a guard
      // reading only `visible` would HIDE it; the coarse rule is that only the
      // folded region hides, and anything else is shown alone via showSurface.
      // Review-round fixture (#1523): dropping `occupied === folded &&` from
      // the guard stayed green without this case.
      const twoVisible = placeSurface(
        updateRegion(DEFAULT_DEVICE_REGION_ARRANGEMENT, 'bottom', {
          visible: true,
        }),
        'activity',
        'right',
        true,
      );
      expect(twoVisible.right.visible).toBe(true);
      expect(foldedDockRegion(twoVisible, 'bottom')).toBe('bottom');

      expect(
        toggleSurface(twoVisible, 'activity', activityDefault, {
          lastShownRegion: 'bottom',
          bottomOnly: true,
        }),
      ).toEqual({ kind: 'show' });
    });

    test('Home in main toggles to nothing: its default region is main', () => {
      expect(
        toggleSurface(
          DEFAULT_DEVICE_REGION_ARRANGEMENT,
          'home',
          REGION_SURFACE_REGISTRY.get('home')!.defaultRegion,
          fine,
        ),
      ).toEqual({ kind: 'none' });
    });

    test('on a coarse device only the folded visible region hides; any other placed surface is a show', () => {
      // Activity placed in `right` but not the folded region (Chat in `bottom`
      // is): its toggle SHOWS it (alone, via showSurface), never hides it.
      const both = placeSurface(
        updateRegion(DEFAULT_DEVICE_REGION_ARRANGEMENT, 'bottom', {
          visible: true,
        }),
        'activity',
        'right',
        false,
      );
      const coarse = { lastShownRegion: 'bottom' as const, bottomOnly: true };
      expect(toggleSurface(both, 'activity', activityDefault, coarse)).toEqual({
        kind: 'show',
      });
      const chatHidden = toggleSurface(both, 'chat', 'bottom', coarse);
      expect(chatHidden).toMatchObject({
        kind: 'arrangement',
        shownRegion: null,
      });
      if (chatHidden.kind !== 'arrangement') throw new Error('unreachable');
      expect(chatHidden.arrangement.bottom.visible).toBe(false);
    });
  });

  test('registers Chat, Activity and Home with their default regions and the regions each declares', () => {
    expect([...REGION_SURFACE_REGISTRY.values()]).toEqual([
      expect.objectContaining({
        id: 'chat',
        title: 'Chat',
        icon: 'chat',
        shortcut: { id: 'dock.toggle', key: 'd', modifiers: ['cmd'] },
        regions: ['left', 'right', 'bottom'],
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
        regions: ['main', 'left', 'right', 'bottom'],
        defaultRegion: 'right',
      }),
      expect.objectContaining({
        id: 'home',
        title: 'Home',
        icon: 'home',
        regions: ['main'],
        defaultRegion: 'main',
      }),
    ]);
    expect(REGION_SURFACE_REGISTRY.get('home')?.shortcut).toBeUndefined();
  });

  test('Home is the default main occupant and the legacy dock seed preserves it', () => {
    expect(DEFAULT_DEVICE_REGION_ARRANGEMENT.main).toEqual({
      visible: true,
      size: 0,
      occupant: 'home',
    });
    const seeded = seedRegionArrangementFromDock(
      { chatDockHeight: 320, chatDockWidth: 400 },
      'right',
      true,
    );
    expect(seeded.main).toEqual(DEFAULT_DEVICE_REGION_ARRANGEMENT.main);
  });

  // #928 C2a: `main` is the primary area. A surface taking it replaces what
  // it shows; the replaced surface must not turn into a dock panel nobody
  // asked for.
  test('placing a surface into main unplaces the previous main occupant instead of relocating it', () => {
    const placed = placeSurface(
      DEFAULT_DEVICE_REGION_ARRANGEMENT,
      'activity',
      'main',
    );

    expect(placed.main).toEqual({
      visible: true,
      size: 0,
      occupant: 'activity',
    });
    expect(occupiedRegion(placed, 'home')).toBeUndefined();
    expect(placed.left.occupant).toBeNull();
    expect(placed.right.occupant).toBeNull();
    expect(placed.bottom).toEqual(DEFAULT_DEVICE_REGION_ARRANGEMENT.bottom);
  });

  test('placing a surface into main from a dock region vacates that dock region and still unplaces the displaced occupant', () => {
    const activityAtRight = placeSurface(
      DEFAULT_DEVICE_REGION_ARRANGEMENT,
      'activity',
      'right',
    );
    const placed = placeSurface(activityAtRight, 'activity', 'main');

    expect(placed.main.occupant).toBe('activity');
    expect(placed.right).toEqual({ visible: false, size: 400, occupant: null });
    expect(occupiedRegion(placed, 'home')).toBeUndefined();
  });

  test('a surface leaving main for a dock region leaves main empty and visible, and the displaced dock occupant relocates', () => {
    const activityInMain = placeSurface(
      DEFAULT_DEVICE_REGION_ARRANGEMENT,
      'activity',
      'main',
    );
    const moved = placeSurface(activityInMain, 'activity', 'bottom');

    expect(moved.main).toEqual({ visible: true, size: 0, occupant: null });
    expect(moved.bottom).toMatchObject({ occupant: 'activity', visible: true });
    // Chat, displaced from bottom, follows the homeless rule — it does not
    // jump into `main`, which it does not declare.
    expect(moved.right).toMatchObject({ occupant: 'chat' });
  });

  test('placing a surface into a region it does not declare is a no-op', () => {
    expect(surfaceMayOccupy('home', 'right')).toBe(false);
    expect(surfaceMayOccupy('chat', 'main')).toBe(false);
    expect(surfaceMayOccupy('activity', 'main')).toBe(true);

    expect(
      placeSurface(DEFAULT_DEVICE_REGION_ARRANGEMENT, 'home', 'right'),
    ).toBe(DEFAULT_DEVICE_REGION_ARRANGEMENT);
    expect(
      placeSurface(DEFAULT_DEVICE_REGION_ARRANGEMENT, 'chat', 'main'),
    ).toBe(DEFAULT_DEVICE_REGION_ARRANGEMENT);
    // An unregistered surface may take a dock region (fixtures rely on it)
    // but never `main`.
    expect(
      placeSurface(DEFAULT_DEVICE_REGION_ARRANGEMENT, 'fixture', 'main'),
    ).toBe(DEFAULT_DEVICE_REGION_ARRANGEMENT);
  });

  test('dock swaps still relocate the displaced occupant into the vacated dock region', () => {
    const activityAtRight = placeSurface(
      DEFAULT_DEVICE_REGION_ARRANGEMENT,
      'activity',
      'right',
    );
    const swapped = placeSurface(activityAtRight, 'activity', 'bottom');

    expect(swapped.bottom.occupant).toBe('activity');
    expect(swapped.right.occupant).toBe('chat');
    expect(swapped.main.occupant).toBe('home');
  });

  test('revealSurface targets main for Home and reveals a main occupant in place', () => {
    const shown = revealSurface(
      placeSurface(DEFAULT_DEVICE_REGION_ARRANGEMENT, 'activity', 'main'),
      'home',
      REGION_SURFACE_REGISTRY.get('home')!.defaultRegion,
    );

    expect(shown.region).toBe('main');
    expect(shown.arrangement.main.occupant).toBe('home');
    expect(occupiedRegion(shown.arrangement, 'activity')).toBeUndefined();

    const alreadyThere = revealSurface(shown.arrangement, 'home', 'main');
    expect(alreadyThere.region).toBe('main');
    expect(alreadyThere.arrangement).toBe(shown.arrangement);
  });

  test('showSurfaceAlone with a main target does not hide the dock regions', () => {
    const chatVisible = updateRegion(
      placeSurface(DEFAULT_DEVICE_REGION_ARRANGEMENT, 'activity', 'main'),
      'bottom',
      { visible: true },
    );

    const shown = showSurfaceAlone(chatVisible, 'home', 'main');

    expect(shown.region).toBe('main');
    expect(shown.arrangement.main.occupant).toBe('home');
    expect(shown.arrangement.bottom).toMatchObject({
      occupant: 'chat',
      visible: true,
    });
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
