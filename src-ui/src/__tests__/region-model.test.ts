// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from 'vitest';
import type { RegionId } from '../regions/region-model';
import {
  DEFAULT_DEVICE_REGION_ARRANGEMENT,
  dockMirrorDiff,
  firstFreeDockRegion,
  foldedDockRegion,
  INSTANCE_SURFACE_PREFIXES,
  moveRegionPanes,
  occupiedDockRegion,
  occupiedRegion,
  placeSurface,
  REGION_IDS,
  REGION_SURFACE_REGISTRY,
  removeRegionPane,
  revealSurface,
  seedRegionArrangementFromDock,
  selectRegionPane,
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

  test('the single-occupant patch replaces a region’s panes; the panes patch sets them', () => {
    const first = updateRegion(DEFAULT_DEVICE_REGION_ARRANGEMENT, 'bottom', {
      occupant: 'chat',
    });
    // `occupant` alone, naming a surface the region does not hold: the
    // pre-#2046 write, still a replacement.
    const second = updateRegion(first, 'bottom', { occupant: 'activity' });

    expect(second.bottom).toMatchObject({
      panes: ['activity'],
      occupant: 'activity',
    });
    expect(Object.keys(second.bottom)).toEqual([
      'visible',
      'size',
      'panes',
      'occupant',
      'maximized',
    ]);
    // `panes` sets the tab order outright; `occupant` selects within it.
    const both = updateRegion(second, 'bottom', {
      panes: ['chat', 'activity'],
      occupant: 'activity',
    });
    expect(both.bottom).toMatchObject({
      panes: ['chat', 'activity'],
      occupant: 'activity',
    });
    // `occupant` alone, naming a held pane: a select, not a replacement.
    expect(
      updateRegion(both, 'bottom', { occupant: 'chat' }).bottom,
    ).toMatchObject({ panes: ['chat', 'activity'], occupant: 'chat' });
    // `null` empties.
    expect(
      updateRegion(both, 'bottom', { occupant: null }).bottom,
    ).toMatchObject({ panes: [], occupant: null });
  });

  test('updateRegion holds the pane invariants: no duplicate, a member selected, main one pane', () => {
    const deduped = updateRegion(DEFAULT_DEVICE_REGION_ARRANGEMENT, 'right', {
      panes: ['chat', 'activity', 'chat'],
      occupant: 'fixture',
    });
    // The duplicate goes; a selection the region does not hold falls back
    // to the first pane rather than naming a pane the host cannot show.
    expect(deduped.right).toMatchObject({
      panes: ['chat', 'activity'],
      occupant: 'chat',
    });
    // `main` keeps displacement (#928 C2a): given several, it keeps the
    // selected one.
    expect(
      updateRegion(DEFAULT_DEVICE_REGION_ARRANGEMENT, 'main', {
        panes: ['home', 'activity'],
        occupant: 'activity',
      }).main,
    ).toMatchObject({ panes: ['activity'], occupant: 'activity' });
    // An unchanged set keeps its identity, so a host memoising on it does
    // not rebuild its document for a visibility write.
    const shown = updateRegion(deduped, 'right', { visible: true });
    expect(shown.right.panes).toBe(deduped.right.panes);
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
      panes: ['chat'],
      occupant: 'chat',
      maximized: false,
    });

    expect(updateRegion(sized, 'bottom', { visible: false }).bottom).toEqual({
      visible: false,
      size: 444,
      panes: ['chat'],
      occupant: 'chat',
      maximized: false,
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

  /**
   * The case the fallback ORDER decides, and the only shape that tells the
   * two orders apart: the preferred region is taken while BOTH `bottom` and
   * `right` are free. Reverting `['right', 'bottom', 'left']` to the old
   * `['bottom', 'right', 'left']` in `firstFreeDockRegion` turns this answer
   * back into `'bottom'` — a surface falling into Chat's region because its
   * own was busy, which is what #2156 stopped.
   */
  test('a taken default falls to the right before Bottom, which is Chat’s', () => {
    const chatAtLeft = placeSurface(
      DEFAULT_DEVICE_REGION_ARRANGEMENT,
      'chat',
      'left',
    );

    expect(chatAtLeft.bottom.panes).toEqual([]);
    expect(chatAtLeft.right.panes).toEqual([]);
    expect(firstFreeDockRegion(chatAtLeft, 'left')).toBe('right');
  });

  /**
   * Every dock-capable surface's default region, registered and
   * instance-keyed alike (#2156). A pin, not a derivation: changing one of
   * these is a product decision, so it should be an argued edit here rather
   * than a silent drift in the registry.
   */
  test('the default region of every dock-capable surface', () => {
    const defaults = new Map<string, RegionId>();
    for (const [id, surface] of REGION_SURFACE_REGISTRY)
      defaults.set(id, surface.defaultRegion);
    for (const prefix of INSTANCE_SURFACE_PREFIXES)
      defaults.set(prefix.prefix, prefix.defaultRegion);

    expect(Object.fromEntries(defaults)).toEqual({
      chat: 'bottom',
      'coding:terminal': 'bottom',
      activity: 'right',
      'workspace-agents': 'right',
      device: 'right',
      'coding:diff': 'right',
      'coding:file-browser': 'left',
      home: 'main',
      'pr:': 'right',
      'file-preview:': 'right',
    });
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
      panes: ['activity'],
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
      panes: ['activity'],
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
        panes: ['activity'],
        occupant: 'activity',
        visible: true,
      });
      // An emptied `main` is Home on screen and stays visible.
      expect(toggled.arrangement.main).toEqual({
        visible: true,
        size: 0,
        maximized: false,
        panes: [],
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
        panes: ['activity'],
        occupant: 'activity',
        visible: true,
      });
      expect(toggled.arrangement.bottom).toMatchObject({
        panes: ['chat'],
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

  test('registers Chat, Activity, Agents, Home, Device and the three coding panes with their default regions, the regions each declares and who offers them', () => {
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
      // #2050: this conversation's background work. Catalog-only and no
      // chord like the coding panes, dock regions only like Activity, and
      // unlike Activity it is not offered by the region's "+" either,
      // because it is not declared to the server catalog at all.
      expect.objectContaining({
        id: 'workspace-agents',
        title: 'Agents',
        icon: 'agent',
        regions: ['left', 'right', 'bottom'],
        defaultRegion: 'right',
        exposure: 'catalog',
      }),
      expect.objectContaining({
        id: 'home',
        title: 'Home',
        icon: 'home',
        regions: ['main'],
        defaultRegion: 'main',
      }),
      // #1969: a captured device screen. Catalog-only and dock-only like
      // the coding panes, and `right` by default — a device screen is
      // portrait-tall, so a side region is where its height comes from.
      expect.objectContaining({
        id: 'device',
        title: 'Device',
        icon: 'device',
        regions: ['left', 'right', 'bottom'],
        defaultRegion: 'right',
        exposure: 'catalog',
      }),
      // #2047: catalog-only, dock regions only, no chord. `exposure` is
      // asserted as the literal on each so that dropping the flag from one
      // entry — which would put a Terminal row in the Layout picker — reds
      // here as well as in `useRegionSurfaceMenu.placement.test.tsx`.
      expect.objectContaining({
        id: 'coding:terminal',
        title: 'Terminal',
        icon: 'terminal',
        regions: ['left', 'right', 'bottom'],
        // #2156: Bottom, beside Chat.
        defaultRegion: 'bottom',
        exposure: 'catalog',
      }),
      expect.objectContaining({
        id: 'coding:diff',
        title: 'Diff',
        icon: 'diff',
        regions: ['left', 'right', 'bottom'],
        defaultRegion: 'right',
        exposure: 'catalog',
      }),
      expect.objectContaining({
        id: 'coding:file-browser',
        title: 'Files',
        icon: 'files',
        regions: ['left', 'right', 'bottom'],
        defaultRegion: 'left',
        exposure: 'catalog',
      }),
    ]);
    for (const id of [
      'home',
      'workspace-agents',
      'device',
      'coding:terminal',
      'coding:diff',
      'coding:file-browser',
    ])
      expect(REGION_SURFACE_REGISTRY.get(id)?.shortcut, id).toBeUndefined();
    // Shell exposure is the ABSENT default, not a spelled-out `'shell'`: the
    // reader treats anything but `'catalog'` as the shell's.
    for (const id of ['chat', 'activity', 'home'])
      expect(REGION_SURFACE_REGISTRY.get(id)?.exposure, id).toBeUndefined();
  });

  test('Home is the default main occupant and the legacy dock seed preserves it', () => {
    expect(DEFAULT_DEVICE_REGION_ARRANGEMENT.main).toEqual({
      visible: true,
      size: 0,
      panes: ['home'],
      occupant: 'home',
      maximized: false,
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
      panes: ['activity'],
      occupant: 'activity',
      maximized: false,
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
    expect(placed.right).toEqual({
      visible: false,
      size: 400,
      panes: [],
      occupant: null,
      maximized: false,
    });
    expect(occupiedRegion(placed, 'home')).toBeUndefined();
  });

  test('a surface leaving main for an occupied dock region leaves main empty and visible and joins the dock region’s panes', () => {
    const activityInMain = placeSurface(
      DEFAULT_DEVICE_REGION_ARRANGEMENT,
      'activity',
      'main',
    );
    const moved = placeSurface(activityInMain, 'activity', 'bottom');

    expect(moved.main).toEqual({
      visible: true,
      size: 0,
      panes: [],
      occupant: null,
      maximized: false,
    });
    // Chat is not displaced (#2046 2a, decision 3): it stays in `bottom`
    // behind Activity's tab.
    expect(moved.bottom).toMatchObject({
      panes: ['chat', 'activity'],
      occupant: 'activity',
      visible: true,
    });
    expect(moved.right.panes).toEqual([]);
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

  /**
   * #2046 2a, decision 3: a placement into an occupied dock region ADDS the
   * surface as a pane — last in tab order, selected — and moves it out of
   * the region it came from. Reverting to displacement fails the first
   * assertion (`right` would hold Chat) and the second (`bottom` would hold
   * Activity alone).
   */
  test('placing a surface into an occupied dock region adds it as the selected pane and vacates its previous region', () => {
    const activityAtRight = placeSurface(
      DEFAULT_DEVICE_REGION_ARRANGEMENT,
      'activity',
      'right',
    );
    const joined = placeSurface(activityAtRight, 'activity', 'bottom');

    expect(joined.bottom).toMatchObject({
      panes: ['chat', 'activity'],
      occupant: 'activity',
      visible: true,
    });
    expect(joined.right).toEqual({
      visible: false,
      size: 400,
      panes: [],
      occupant: null,
      maximized: false,
    });
    expect(joined.main.occupant).toBe('home');
    // A surface is in at most one region.
    expect(
      REGION_IDS.filter((id) => joined[id].panes.includes('activity')),
    ).toEqual(['bottom']);
    expect(occupiedRegion(joined, 'chat')).toBe('bottom');
    expect(occupiedDockRegion(joined, 'activity')).toBe('bottom');
  });

  test('a surface leaving a multi-pane region is removed from its panes and its neighbour is selected', () => {
    const both = placeSurface(
      placeSurface(DEFAULT_DEVICE_REGION_ARRANGEMENT, 'activity', 'bottom'),
      'chat',
      'bottom',
    );
    expect(both.bottom).toMatchObject({
      panes: ['chat', 'activity'],
      occupant: 'chat',
    });

    // Chat, the selected pane, leaves for `right`: `bottom` keeps Activity,
    // selected, and stays visible.
    const chatRight = placeSurface(both, 'chat', 'right');
    expect(chatRight.bottom).toMatchObject({
      panes: ['activity'],
      occupant: 'activity',
      visible: true,
    });
    expect(chatRight.right).toMatchObject({
      panes: ['chat'],
      occupant: 'chat',
      visible: true,
    });

    // The non-selected pane leaving keeps the selection where it was.
    const activityRight = placeSurface(both, 'activity', 'right');
    expect(activityRight.bottom).toMatchObject({
      panes: ['chat'],
      occupant: 'chat',
    });
    expect(activityRight.right).toMatchObject({ panes: ['activity'] });
  });

  test('placing a surface into the region already holding it selects it and shows the region', () => {
    const behind = placeSurface(
      placeSurface(DEFAULT_DEVICE_REGION_ARRANGEMENT, 'activity', 'bottom'),
      'chat',
      'bottom',
    );
    const hidden = updateRegion(
      updateRegion(behind, 'bottom', { occupant: 'activity' }),
      'bottom',
      { visible: false },
    );

    const selected = placeSurface(hidden, 'chat', 'bottom');
    expect(selected.bottom).toMatchObject({
      panes: ['chat', 'activity'],
      occupant: 'chat',
      visible: true,
    });
    // Nothing else moved.
    expect(selected.right).toEqual(hidden.right);
    expect(selected.main).toEqual(hidden.main);
  });

  test('a placement asked not to show joins behind the pane the region is showing', () => {
    // `?dockSlotPlacement=right` without `dock=open` (RegionModelContext):
    // Chat is placed in `right`, not shown. Activity is on screen there, so
    // the region stays visible and Activity keeps the tab; Chat joins behind.
    const activityShownRight = updateRegion(
      placeSurface(DEFAULT_DEVICE_REGION_ARRANGEMENT, 'activity', 'right'),
      'right',
      { visible: true },
    );
    const placed = placeSurface(activityShownRight, 'chat', 'right', false);

    expect(placed.right).toMatchObject({
      panes: ['activity', 'chat'],
      occupant: 'activity',
      visible: true,
    });
    expect(placed.bottom).toMatchObject({ panes: [], visible: false });
    // Into a region showing nothing, "not shown" still means hidden with the
    // newcomer selected — the pre-#2046 meaning.
    const hiddenRight = updateRegion(activityShownRight, 'right', {
      visible: false,
    });
    expect(
      placeSurface(hiddenRight, 'chat', 'right', false).right,
    ).toMatchObject({
      panes: ['activity', 'chat'],
      occupant: 'chat',
      visible: false,
    });
  });

  test('joining a region keeps its size; the vacated region keeps its size and hides', () => {
    const withActivity = updateRegion(
      placeSurface(DEFAULT_DEVICE_REGION_ARRANGEMENT, 'activity', 'right'),
      'right',
      { size: 517 },
    );
    const joined = placeSurface(withActivity, 'activity', 'bottom');

    expect(joined.bottom).toEqual({
      visible: true,
      size: 320,
      panes: ['chat', 'activity'],
      occupant: 'activity',
      maximized: false,
    });
    expect(joined.right).toEqual({
      visible: false,
      size: 517,
      panes: [],
      occupant: null,
      maximized: false,
    });
  });

  test('selectRegionPane selects a held pane and ignores a surface the region does not hold', () => {
    const both = placeSurface(
      placeSurface(DEFAULT_DEVICE_REGION_ARRANGEMENT, 'activity', 'bottom'),
      'chat',
      'bottom',
    );
    expect(both.bottom.occupant).toBe('chat');

    const selected = selectRegionPane(both, 'bottom', 'activity');
    expect(selected.bottom).toMatchObject({
      panes: ['chat', 'activity'],
      occupant: 'activity',
      visible: true,
    });
    // A select places nothing: Home is not in `bottom` and does not arrive.
    expect(selectRegionPane(both, 'bottom', 'home')).toBe(both);
    expect(selectRegionPane(both, 'right', 'chat')).toBe(both);
    // Selecting the selected pane is a no-op by reference.
    expect(selectRegionPane(selected, 'bottom', 'activity')).toBe(selected);
  });

  test('revealSurface selects a pane behind another’s tab, and toggleSurface selects rather than hides it', () => {
    const activityShown = placeSurface(
      placeSurface(DEFAULT_DEVICE_REGION_ARRANGEMENT, 'chat', 'bottom'),
      'activity',
      'bottom',
    );
    expect(activityShown.bottom.occupant).toBe('activity');

    const revealed = revealSurface(activityShown, 'chat', 'bottom');
    expect(revealed.region).toBe('bottom');
    expect(revealed.arrangement.bottom).toMatchObject({
      panes: ['chat', 'activity'],
      occupant: 'chat',
      visible: true,
    });

    // ⌘D with Chat behind Activity: Chat is not on screen, so the toggle
    // shows it (selects its tab) instead of hiding the region Activity is
    // showing in. Reverting to "visible region → hide" fails this.
    const fine = { lastShownRegion: null, bottomOnly: false };
    const toggled = toggleSurface(activityShown, 'chat', 'bottom', fine);
    expect(toggled).toMatchObject({
      kind: 'arrangement',
      shownRegion: 'bottom',
    });
    if (toggled.kind !== 'arrangement') throw new Error('unreachable');
    expect(toggled.arrangement.bottom).toMatchObject({
      occupant: 'chat',
      visible: true,
    });
    // And the selected pane's toggle still hides.
    const hidden = toggleSurface(activityShown, 'activity', 'right', fine);
    if (hidden.kind !== 'arrangement') throw new Error('unreachable');
    expect(hidden.arrangement.bottom.visible).toBe(false);
    // Coarse device: a behind pane is a show (showSurface selects it).
    expect(
      toggleSurface(activityShown, 'chat', 'bottom', {
        lastShownRegion: 'bottom',
        bottomOnly: true,
      }),
    ).toEqual({ kind: 'show' });
  });

  test('main still displaces: a surface taking main unplaces the previous one and main holds one pane', () => {
    const activityInMain = placeSurface(
      DEFAULT_DEVICE_REGION_ARRANGEMENT,
      'activity',
      'main',
    );
    expect(activityInMain.main).toMatchObject({
      panes: ['activity'],
      occupant: 'activity',
    });
    expect(occupiedRegion(activityInMain, 'home')).toBeUndefined();
    const homeBack = placeSurface(activityInMain, 'home', 'main');
    expect(homeBack.main).toMatchObject({ panes: ['home'], occupant: 'home' });
    expect(occupiedRegion(homeBack, 'activity')).toBeUndefined();
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
      panes: ['chat'],
      occupant: 'chat',
      visible: true,
    });
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
      panes: [],
      occupant: null,
      maximized: false,
    });
    expect(arrangement.left.size).toBe(389);
    expect(arrangement.right).toEqual({
      visible: true,
      size: 389,
      panes: ['chat'],
      occupant: 'chat',
      maximized: false,
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
    // Chat joins Activity's `right` (#2046 2a): its region is `right` now,
    // and a region holding Chat behind or in front of another pane is still
    // the one the mirror names.
    const moved = placeSurface(sizedRight, 'chat', 'right');
    expect(moved.right).toMatchObject({ panes: ['activity', 'chat'] });
    const diff = dockMirrorDiff(sizedRight, moved);

    expect(diff).toEqual({
      placement: 'right',
      size: { right: 600 },
      visible: true,
    });
    const synced = syncRegionArrangementFromDock(
      moved,
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
        panes: ['activity'],
        occupant: 'activity',
        visible: true,
        size: 517,
        maximized: false,
      },
    );
    const synced = syncRegionArrangementFromDock(
      withActivity,
      { chatDockHeight: 333, chatDockWidth: 444 },
      false,
      'bottom',
    );

    expect(synced.right).toEqual({
      panes: ['activity'],
      occupant: 'activity',
      visible: true,
      size: 517,
      maximized: false,
    });
    expect(synced.bottom.visible).toBe(false);
  });

  test('sync never evicts a second occupant when dockMode names its region', () => {
    const withActivity = updateRegion(
      DEFAULT_DEVICE_REGION_ARRANGEMENT,
      'right',
      {
        panes: ['activity'],
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

  // #928 slice iii / #1385: maximize is a region attribute with invariants.
  describe('maximize is a region attribute', () => {
    const chatOpenActivityRight = updateRegion(
      placeSurface(DEFAULT_DEVICE_REGION_ARRANGEMENT, 'activity', 'right'),
      'bottom',
      { visible: true },
    );

    test('at most one region is maximized: maximizing one restores every other', () => {
      const chatMax = updateRegion(chatOpenActivityRight, 'bottom', {
        maximized: true,
      });
      expect(chatMax.bottom.maximized).toBe(true);

      const activityMax = updateRegion(chatMax, 'right', { maximized: true });

      expect(activityMax.right.maximized).toBe(true);
      expect(activityMax.bottom.maximized).toBe(false);
      expect(REGION_IDS.filter((id) => activityMax[id].maximized)).toEqual([
        'right',
      ]);
    });

    test('hiding a region clears its maximize; main, a hidden region and an empty region never maximize', () => {
      const chatMax = updateRegion(chatOpenActivityRight, 'bottom', {
        maximized: true,
      });
      expect(
        updateRegion(chatMax, 'bottom', { visible: false }).bottom,
      ).toMatchObject({ visible: false, maximized: false });
      expect(
        updateRegion(chatOpenActivityRight, 'main', { maximized: true }).main
          .maximized,
      ).toBe(false);
      // Hidden: Activity's right region is placed hidden-by-default here.
      const hiddenRight = updateRegion(chatOpenActivityRight, 'right', {
        visible: false,
      });
      expect(
        updateRegion(hiddenRight, 'right', { maximized: true }).right.maximized,
      ).toBe(false);
      expect(
        updateRegion(chatOpenActivityRight, 'left', {
          visible: true,
          maximized: true,
        }).left.maximized,
      ).toBe(false);
      // A no-op patch keeps the reference.
      expect(updateRegion(chatMax, 'main', { maximized: true })).toBe(chatMax);
    });

    test('placeSurface clears maximize on both ends of a move and on a join (the #1385 shape)', () => {
      const chatMax = updateRegion(chatOpenActivityRight, 'bottom', {
        maximized: true,
      });

      // Join: Activity into Chat's maximized bottom (#2046 2a). The region
      // it enters is restored; the region it leaves empties and hides.
      const joined = placeSurface(chatMax, 'activity', 'bottom');
      expect(joined.bottom).toMatchObject({
        panes: ['chat', 'activity'],
        occupant: 'activity',
        maximized: false,
      });
      expect(joined.right).toMatchObject({
        panes: [],
        occupant: null,
        visible: false,
        maximized: false,
      });

      // Move: maximized Chat into an empty left.
      const moved = placeSurface(chatMax, 'chat', 'left');
      expect(moved.left).toMatchObject({
        panes: ['chat'],
        occupant: 'chat',
        maximized: false,
      });
      expect(moved.bottom).toMatchObject({
        panes: [],
        occupant: null,
        maximized: false,
      });
      expect(REGION_IDS.some((id) => moved[id].maximized)).toBe(false);
    });

    test('dockMirrorDiff emits maximized for Chat only when Chat’s maximize changed', () => {
      const chatMax = updateRegion(chatOpenActivityRight, 'bottom', {
        maximized: true,
      });
      expect(dockMirrorDiff(chatOpenActivityRight, chatMax)).toEqual({
        maximized: true,
      });
      expect(dockMirrorDiff(chatMax, chatOpenActivityRight)).toEqual({
        maximized: false,
      });
      // A hide is a visibility change, not a maximize change: the provider
      // forwards the maximize it closed from so `lastDockMaximized` survives.
      expect(
        dockMirrorDiff(
          chatMax,
          updateRegion(chatMax, 'bottom', { visible: false }),
        ),
      ).toEqual({ visible: false });
      // Activity's maximize is never Chat's.
      expect(
        dockMirrorDiff(
          chatOpenActivityRight,
          updateRegion(chatOpenActivityRight, 'right', { maximized: true }),
        ),
      ).toEqual({});
      // A relocation that clears Chat's maximize mirrors the clear with the move.
      expect(
        dockMirrorDiff(chatMax, placeSurface(chatMax, 'chat', 'left')),
      ).toEqual({
        placement: 'left',
        size: { left: 400 },
        maximized: false,
      });
    });
  });

  test('mirror ignores size changes from a region Activity occupies', () => {
    const before = updateRegion(DEFAULT_DEVICE_REGION_ARRANGEMENT, 'right', {
      panes: ['activity'],
      occupant: 'activity',
      visible: true,
    });
    const after = updateRegion(before, 'right', { size: 517 });

    expect(dockMirrorDiff(before, after)).toEqual({});
  });

  /**
   * 2a review, test-power gaps (I8, I10). I8: `dockMirrorDiff` mirrors a
   * size change from the region that HOLDS Chat, selected or not — the
   * injection that read `occupant` instead of `panes` passed every fixture
   * because none resized a region with Chat behind a tab. I10:
   * `regionStatesEqual` compares `panes` element by element, in order — a
   * same-set reorder is a change (the tab strip's reorder depends on it),
   * which the injection that compared as a set passed every fixture for.
   */
  test('the size mirror follows a region holding Chat behind another pane’s tab, and a reorder is a change', () => {
    const chatBehind = placeSurface(
      DEFAULT_DEVICE_REGION_ARRANGEMENT,
      'activity',
      'bottom',
    );
    expect(chatBehind.bottom).toMatchObject({
      panes: ['chat', 'activity'],
      occupant: 'activity',
    });
    const resized = updateRegion(chatBehind, 'bottom', { size: 411 });
    expect(dockMirrorDiff(chatBehind, resized)).toEqual({
      size: { bottom: 411 },
    });

    const reordered = updateRegion(chatBehind, 'bottom', {
      panes: ['activity', 'chat'],
    });
    expect(reordered).not.toBe(chatBehind);
    expect(reordered.bottom).toMatchObject({
      panes: ['activity', 'chat'],
      occupant: 'activity',
    });
    // The same order again: no change, by reference.
    expect(
      updateRegion(reordered, 'bottom', { panes: ['activity', 'chat'] }),
    ).toBe(reordered);
  });

  /**
   * 2a review (MEDIUM): `dock=open` is Chat's mirror, so an inbound open
   * selects Chat's tab in the region it opens — whether that is the
   * requested region or the one Chat lives in — and a close leaves the
   * selection alone. Reverting the `occupant: 'chat'` write fails the first
   * two `occupant` assertions.
   */
  test('an inbound dock=open selects Chat’s tab in the region it opens; a close keeps the selection', () => {
    const settings = { chatDockHeight: 320, chatDockWidth: 400 };
    const chatBehind = updateRegion(
      placeSurface(DEFAULT_DEVICE_REGION_ARRANGEMENT, 'activity', 'bottom'),
      'bottom',
      { visible: false },
    );
    expect(chatBehind.bottom.occupant).toBe('activity');

    // The requested region holds Chat.
    expect(
      syncRegionArrangementFromDock(chatBehind, settings, true, 'bottom')
        .bottom,
    ).toMatchObject({ visible: true, occupant: 'chat' });
    // Chat lives elsewhere than the requested region, which is occupied
    // (an EMPTY requested region is the older rule: Chat is placed there).
    const rightTaken = updateRegion(chatBehind, 'right', {
      panes: ['fixture'],
      occupant: 'fixture',
    });
    expect(
      syncRegionArrangementFromDock(rightTaken, settings, true, 'right').bottom,
    ).toMatchObject({ visible: true, occupant: 'chat' });
    // A close: hidden, selection untouched.
    const shown = updateRegion(chatBehind, 'bottom', { visible: true });
    expect(
      syncRegionArrangementFromDock(shown, settings, false, 'bottom').bottom,
    ).toMatchObject({ visible: false, occupant: 'activity' });
  });

  // #2046 2b: the tab strip's close and the region bar's placement.
  describe('closing a tab and moving a region', () => {
    const both = updateRegion(
      placeSurface(DEFAULT_DEVICE_REGION_ARRANGEMENT, 'activity', 'bottom'),
      'bottom',
      { visible: true },
    );

    test('removeRegionPane unplaces the pane and selects its neighbour; the last pane empties and hides the region', () => {
      expect(both.bottom).toMatchObject({
        panes: ['chat', 'activity'],
        occupant: 'activity',
      });
      // The selected pane closes: its neighbour is selected, the region
      // stays visible, and the closed surface is in NO region.
      const closed = removeRegionPane(both, 'bottom', 'activity');
      expect(closed.bottom).toMatchObject({
        panes: ['chat'],
        occupant: 'chat',
        visible: true,
      });
      expect(occupiedRegion(closed, 'activity')).toBeUndefined();
      // Unplaced reads as "show" to its toggle, and the show places it
      // afresh — the way back from a closed tab.
      expect(
        toggleSurface(closed, 'activity', 'right', {
          lastShownRegion: null,
          bottomOnly: false,
        }),
      ).toEqual({ kind: 'show' });
      expect(revealSurface(closed, 'activity', 'right').region).toBe('right');

      // A pane behind the selected one closes: the selection stays.
      const behind = removeRegionPane(both, 'bottom', 'chat');
      expect(behind.bottom).toMatchObject({
        panes: ['activity'],
        occupant: 'activity',
      });

      // The last pane: the region empties and hides.
      const emptied = removeRegionPane(behind, 'bottom', 'activity');
      expect(emptied.bottom).toMatchObject({
        panes: [],
        occupant: null,
        visible: false,
      });
      // A surface the region does not hold: unchanged, by reference.
      expect(removeRegionPane(both, 'right', 'chat')).toBe(both);
    });

    /**
     * A close is a relocation and restores the region (#1385), whichever
     * pane leaves. Reverting `maximized: false` in the kept-panes branch
     * leaves `bottom` maximized after Chat's close, and the next Chat
     * reveal lands in `right` UNDER a maximized sibling — hidden.
     */
    test('closing a tab restores a maximized region, so the next reveal is not hidden under it', () => {
      const maximized = updateRegion(both, 'bottom', { maximized: true });
      const chatClosed = removeRegionPane(maximized, 'bottom', 'chat');
      expect(chatClosed.bottom).toMatchObject({
        panes: ['activity'],
        occupant: 'activity',
        visible: true,
        maximized: false,
      });
      const revealed = revealSurface(chatClosed, 'chat', 'bottom').arrangement;
      expect(revealed.right).toMatchObject({ panes: ['chat'], visible: true });
      expect(
        (['left', 'right', 'bottom'] as const).filter(
          (id) => revealed[id].maximized,
        ),
      ).toEqual([]);
      // The selected pane's close restores too.
      expect(
        removeRegionPane(maximized, 'bottom', 'activity').bottom,
      ).toMatchObject({ panes: ['chat'], occupant: 'chat', maximized: false });
    });

    test('moveRegionPanes carries the whole pane set, its order and its selection, and empties the source', () => {
      const moved = moveRegionPanes(both, 'bottom', 'right');
      expect(moved.right).toMatchObject({
        panes: ['chat', 'activity'],
        occupant: 'activity',
        visible: true,
        maximized: false,
      });
      expect(moved.bottom).toMatchObject({
        panes: [],
        occupant: null,
        visible: false,
      });
      // Chat's mirror sees the move as Chat's placement.
      expect(dockMirrorDiff(both, moved)).toEqual({
        placement: 'right',
        size: { right: 400 },
      });
      // Into a region already holding a pane: the moved panes join after
      // it, the moved selection wins, and both ends come out restored.
      const bottomMax = updateRegion(both, 'bottom', { maximized: true });
      const withLeft = updateRegion(bottomMax, 'left', {
        panes: ['fixture'],
        occupant: 'fixture',
        visible: false,
      });
      const joined = moveRegionPanes(withLeft, 'bottom', 'left');
      expect(joined.left).toMatchObject({
        panes: ['fixture', 'chat', 'activity'],
        occupant: 'activity',
        visible: true,
        maximized: false,
      });
      expect(joined.bottom.maximized).toBe(false);
      // The same region, or an empty source: unchanged, by reference.
      expect(moveRegionPanes(both, 'bottom', 'bottom')).toBe(both);
      expect(moveRegionPanes(both, 'left', 'right')).toBe(both);
    });

    test('a closed Chat tab closes the navigation mirror, and a closed dock does not re-place it', () => {
      const closed = removeRegionPane(both, 'bottom', 'chat');
      // Chat left a VISIBLE region for no region: navigation must read the
      // dock as closed, so a later `setDockState(true)` is a change.
      expect(dockMirrorDiff(both, closed)).toEqual({ visible: false });
      // Chat leaving a hidden region says nothing new.
      const hiddenBoth = updateRegion(both, 'bottom', { visible: false });
      expect(
        dockMirrorDiff(
          hiddenBoth,
          removeRegionPane(hiddenBoth, 'bottom', 'chat'),
        ),
      ).toEqual({});

      // The inbound sync with the dock closed leaves an unplaced Chat alone
      // (re-placing it hidden would undo the close on the next navigation
      // change)…
      const settings = { chatDockHeight: 320, chatDockWidth: 400 };
      expect(
        syncRegionArrangementFromDock(closed, settings, false, 'bottom'),
      ).toBe(closed);
      // …and with the dock OPEN places it the way a reveal would: the first
      // free dock region, else joining the requested one.
      const reopened = syncRegionArrangementFromDock(
        closed,
        settings,
        true,
        'bottom',
      );
      expect(reopened.right).toMatchObject({
        panes: ['chat'],
        occupant: 'chat',
        visible: true,
      });
      const noFree = updateRegion(
        updateRegion(closed, 'right', {
          panes: ['fixture'],
          occupant: 'fixture',
        }),
        'left',
        { panes: ['other'], occupant: 'other' },
      );
      expect(
        syncRegionArrangementFromDock(noFree, settings, true, 'bottom').bottom,
      ).toMatchObject({ panes: ['activity', 'chat'], occupant: 'chat' });
    });
  });
});
