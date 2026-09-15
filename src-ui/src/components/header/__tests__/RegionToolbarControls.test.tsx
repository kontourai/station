/** @vitest-environment jsdom */

import { readFileSync } from 'node:fs';
import {
  createEvent,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const chatCss = readFileSync('src-ui/src/components/chat/chat.css', 'utf8');

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
  setDockMode: vi.fn(),
  setDockState: vi.fn(),
  setRegion: vi.fn(),
  placeSurface: vi.fn(),
  showSurface: vi.fn(),
  toggleSurface: vi.fn(),
  bottomOnly: false,
  /** The fine pointer's placements; overridden by one test. */
  placements: ['left', 'right', 'bottom'] as string[],
  // The `⋯` overflow button only exists under the mobile media query, so a
  // coarse device is not automatically one whose commands can move there.
  isMobile: false,
  shortcuts: new Map<
    string,
    {
      id: string;
      key: string;
      modifiers: string[];
      description: string;
      handler: () => void;
    }
  >(),
}));

vi.mock('../../../contexts/RegionModelContext', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../../contexts/RegionModelContext')
    >();
  const { REGION_SURFACE_REGISTRY } = await import(
    '../../../regions/region-model'
  );
  return {
    ...actual,
    useRegionModelOptional: () => ({
      regions: harness.regions,
      surfaces: REGION_SURFACE_REGISTRY,
      setRegion: vi.fn(),
      placeSurface: harness.placeSurface,
      showSurface: harness.showSurface,
      toggleSurface: harness.toggleSurface,
    }),
    useRegionModel: () => ({
      regions: harness.regions,
      surfaces: REGION_SURFACE_REGISTRY,
      setRegion: harness.setRegion,
      placeSurface: harness.placeSurface,
      showSurface: harness.showSurface,
      toggleSurface: harness.toggleSurface,
    }),
  };
});

vi.mock('../../../contexts/NavigationContext', () => ({
  useNavigation: () => ({
    dockMode: 'bottom',
    isDockMaximized: false,
    pathname: '/',
    setDockMode: harness.setDockMode,
    setDockState: harness.setDockState,
  }),
}));

vi.mock('../../../hooks/useIsMobile', () => ({
  useIsMobile: () => harness.isMobile,
  useDockSlotDevice: () => ({
    viewportWidth: harness.bottomOnly ? 390 : 1024,
    coarsePointer: harness.bottomOnly,
  }),
  availablePlacements: () =>
    harness.bottomOnly ? ['bottom'] : harness.placements,
}));

vi.mock('../../../hooks/useKeyboardShortcut', () => ({
  useKeyboardShortcut: (
    id: string,
    key: string,
    modifiers: string[],
    description: string,
    handler: () => void,
  ) => {
    harness.shortcuts.set(id, { id, key, modifiers, description, handler });
  },
}));

import { RegionToolbarControls } from '../RegionToolbarControls';

/** The fine pointer's three region toggles (#2143), by region label. */
function regionToggle(label: 'Left' | 'Bottom' | 'Right') {
  return screen.getByRole('button', { name: `${label} region` });
}

/** Each toggle as `[label, aria-pressed]`, in DOM order. */
function toggleStates() {
  return [
    ...screen
      .getByRole('group', { name: 'Regions' })
      .querySelectorAll('button'),
  ].map((button) => [
    button.getAttribute('aria-label'),
    button.getAttribute('aria-pressed'),
  ]);
}

/** Open an EMPTY region's offer menu from its control. */
function openOfferMenu(label: 'Left' | 'Bottom' | 'Right') {
  const trigger = regionToggle(label);
  fireEvent.click(trigger);
  return {
    trigger,
    menu: screen.getByRole('menu', { name: `Show in ${label} region` }),
  };
}

describe('RegionToolbarControls', () => {
  beforeEach(() => {
    Object.assign(harness.regions.main, {
      visible: true,
      size: 0,
      panes: ['home'],
      occupant: 'home',
    });
    Object.assign(harness.regions.left, {
      visible: false,
      size: 400,
      panes: [],
      occupant: null,
    });
    Object.assign(harness.regions.right, {
      visible: false,
      size: 400,
      panes: [],
      occupant: null,
    });
    Object.assign(harness.regions.bottom, {
      visible: true,
      size: 320,
      panes: ['chat'],
      occupant: 'chat',
    });
    harness.setDockMode.mockReset();
    harness.setDockState.mockReset();
    harness.setRegion.mockReset();
    harness.placeSurface.mockReset();
    harness.showSurface.mockReset();
    harness.toggleSurface.mockReset();
    harness.bottomOnly = false;
    harness.placements = ['left', 'right', 'bottom'];
    harness.isMobile = false;
    harness.shortcuts.clear();
  });

  /** The toolbar issued the model's toggle for `surfaceId`, and nothing else. */
  const expectOnlyToggle = (surfaceId: string, times = 1) => {
    expect(harness.toggleSurface).toHaveBeenCalledTimes(times);
    expect(harness.toggleSurface).toHaveBeenLastCalledWith(surfaceId);
    expect(harness.placeSurface).not.toHaveBeenCalled();
    expect(harness.setRegion).not.toHaveBeenCalled();
    expect(harness.showSurface).not.toHaveBeenCalled();
  };

  test('registers both surface shortcuts and issues the model toggle from their metadata', () => {
    render(<RegionToolbarControls />);

    expect(harness.shortcuts.get('dock.toggle')).toMatchObject({
      id: 'dock.toggle',
      key: 'd',
      modifiers: ['cmd'],
      description: 'Toggle Chat region',
    });
    expect(harness.shortcuts.get('activity.toggle')).toMatchObject({
      key: 'a',
      modifiers: ['cmd', 'shift'],
      description: 'Toggle Activity region',
    });
    harness.shortcuts.get('dock.toggle')?.handler();
    expectOnlyToggle('chat');

    harness.shortcuts.get('activity.toggle')?.handler();
    expectOnlyToggle('activity', 2);

    // The same Hide the retired per-region button carried, then the retired
    // "Hide Chat" menu row, then #1552 D2's `Hidden` segment: on a fine
    // pointer it is the Bottom region's TOGGLE now (#2143).
    //
    // A TOGGLE IS NOT THE CHORD'S TOGGLE, and deliberately so. #1523 routed the
    // chord through the model because it has to decide what "the other state"
    // is for an unplaced, docked or `main` surface. The region toggle names a
    // REGION, whose other state is only ever hidden or shown, so it writes the
    // region's visibility through the model's own `setRegion` primitive;
    // nothing about placement is decided in this hook either way.
    fireEvent.click(regionToggle('Bottom'));
    expect(harness.setRegion).toHaveBeenLastCalledWith('bottom', {
      visible: false,
    });
    // And it is not ALSO issuing the toggle: the chords above are the only
    // callers that did, so the count is still theirs.
    expect(harness.toggleSurface).toHaveBeenCalledTimes(2);
  });

  /**
   * #1420, then #1523: the chord issues ONE model command and decides nothing
   * itself — not where an unplaced surface lands (Chat in Activity's preferred
   * region with a free region beside it was the fixture where the toolbar's
   * own copy of the rules used to pick the free region), not whether a placed
   * one is hidden or shown, and not what happens to a `main` occupant. Each
   * of those is `toggleSurface` in region-model.ts, tested there; a change to
   * the rules cannot leave the toolbar holding a stale copy.
   */
  test('the Activity chord issues the model toggle whether Activity is unplaced, docked or in main', () => {
    Object.assign(harness.regions.bottom, {
      visible: false,
      panes: [],
      occupant: null,
    });
    Object.assign(harness.regions.right, {
      visible: true,
      panes: ['chat'],
      occupant: 'chat',
    });
    const { rerender } = render(<RegionToolbarControls />);

    harness.shortcuts.get('activity.toggle')?.handler();
    expectOnlyToggle('activity');

    Object.assign(harness.regions.right, {
      visible: true,
      panes: ['activity'],
      occupant: 'activity',
    });
    rerender(<RegionToolbarControls />);
    harness.shortcuts.get('activity.toggle')?.handler();
    expectOnlyToggle('activity', 2);

    // ⌘⇧A with Activity occupying `main` (#1523): the same command. The
    // model relocates it to its dock region; the toolbar must not turn this
    // into a `showSurface` that reveals it where it already is.
    Object.assign(harness.regions.right, { panes: [], occupant: null });
    Object.assign(harness.regions.main, {
      panes: ['activity'],
      occupant: 'activity',
    });
    rerender(<RegionToolbarControls />);
    harness.shortcuts.get('activity.toggle')?.handler();
    expectOnlyToggle('activity', 3);
  });

  /**
   * #2143: one control per dock region, each a TOGGLE whose pressed state is
   * the region's visibility from the model. #1536 F folded five unlabeled
   * rectangles into one control and #1552 D2 made it a per-surface picker;
   * this is per region again, but each button says what it is ("Bottom
   * region"), says whether it is on (`aria-pressed`), and says what it holds
   * (the tooltip) — the three things the five rectangles lacked.
   */
  test('a fine pointer renders one toggle per dock region, pressed where the region is visible', () => {
    render(<RegionToolbarControls />);

    expect(toggleStates()).toEqual([
      ['Left region', null],
      ['Bottom region', 'true'],
      ['Right region', null],
    ]);
    // Bottom holds Chat and is a pressed toggle. Left and right are EMPTY,
    // so they are not toggles at all — `null`, not `'false'`: an empty
    // region has no visibility to report (the next test) — and a hidden
    // OCCUPIED region is what reads `'false'` (the two-pane test below).
    expect(regionToggle('Bottom').title).toBe('Hide Bottom region: Chat');
    // No visible word: the glyph is the region's own edge, and the name is
    // the tooltip's and the accessible name's.
    expect(
      document.querySelector('.app-toolbar__region-layout-label'),
    ).toBeNull();
    expect(screen.queryByRole('button', { name: 'Layout regions' })).toBeNull();
  });

  /**
   * An empty region cannot be shown — `RegionShells` mounts no host for it and
   * the model hides a region its last pane leaves — so its control is not a
   * toggle (no `aria-pressed`, which would be a state nothing can change) but
   * a menu trigger offering what can go there. Never both on one button.
   */
  test('an empty region is a menu trigger, not a toggle; an occupied one is a toggle, not a trigger', () => {
    render(<RegionToolbarControls />);

    const left = regionToggle('Left');
    expect(left.getAttribute('aria-pressed')).toBeNull();
    expect(left.getAttribute('aria-haspopup')).toBe('menu');
    expect(left.getAttribute('aria-expanded')).toBe('false');
    expect(left.title).toBe('Left region: empty');

    const bottom = regionToggle('Bottom');
    expect(bottom.getAttribute('aria-pressed')).toBe('true');
    expect(bottom.getAttribute('aria-haspopup')).toBeNull();
    expect(bottom.getAttribute('aria-expanded')).toBeNull();
  });

  test('pressing an occupied region’s toggle hides it; pressing a hidden one shows it — the region, not a surface', () => {
    const { rerender } = render(<RegionToolbarControls />);

    fireEvent.click(regionToggle('Bottom'));
    expect(harness.setRegion).toHaveBeenCalledWith('bottom', {
      visible: false,
    });
    expect(harness.placeSurface).not.toHaveBeenCalled();
    expect(harness.toggleSurface).not.toHaveBeenCalled();

    harness.regions.bottom.visible = false;
    rerender(<RegionToolbarControls />);
    expect(regionToggle('Bottom').getAttribute('aria-pressed')).toBe('false');
    expect(regionToggle('Bottom').title).toBe('Show Bottom region: Chat');
    fireEvent.click(regionToggle('Bottom'));
    expect(harness.setRegion).toHaveBeenLastCalledWith('bottom', {
      visible: true,
    });
    expect(harness.setRegion).toHaveBeenCalledTimes(2);
  });

  /**
   * A hidden region holding two panes is ONE unpressed toggle, and its press
   * writes the region's visibility and nothing about its panes — so both tabs
   * come back with the selection they had. The tooltip lists the panes in tab
   * order, so a reader knows what the toggle brings back before pressing it.
   */
  test('a two-pane region is one toggle that names both panes, and its press touches no pane', () => {
    Object.assign(harness.regions.right, {
      visible: false,
      panes: ['activity', 'chat'],
      occupant: 'chat',
    });
    Object.assign(harness.regions.bottom, {
      visible: false,
      panes: [],
      occupant: null,
    });
    render(<RegionToolbarControls />);

    expect(toggleStates()).toEqual([
      ['Left region', null],
      ['Bottom region', null],
      ['Right region', 'false'],
    ]);
    expect(regionToggle('Right').title).toBe(
      'Show Right region: Activity, Chat',
    );
    fireEvent.click(regionToggle('Right'));
    expect(harness.setRegion).toHaveBeenCalledWith('right', { visible: true });
    expect(harness.setRegion).toHaveBeenCalledTimes(1);
    expect(harness.placeSurface).not.toHaveBeenCalled();
  });

  test('an empty region’s menu offers the shell surfaces declaring it, and a choice is the model’s placeSurface', () => {
    render(<RegionToolbarControls />);

    const { trigger, menu } = openOfferMenu('Left');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    // The shell surfaces in registry order; catalog-only ones (Agents,
    // Device, the coding panes) are the "+"'s and never here.
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Show Chat here', 'Show Activity here']);

    fireEvent.click(
      within(menu).getByRole('menuitem', { name: 'Show Activity here' }),
    );
    expect(harness.placeSurface).toHaveBeenCalledWith('activity', 'left');
    expect(harness.setRegion).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  test('the offer menu opens portalled, anchored to its trigger, and dismisses on Escape and the backdrop', () => {
    const { container } = render(<RegionToolbarControls />);

    const trigger = regionToggle('Right');
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      right: 760,
    } as DOMRect);
    trigger.focus();
    fireEvent.click(trigger);
    const menu = screen.getByRole('menu', { name: 'Show in Right region' });
    expect(menu.parentElement).toBe(document.body);
    expect(container.contains(menu)).toBe(false);
    expect(menu.style.right).toBe(`${window.innerWidth - 760}px`);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    const backdrop = screen.getByRole('button', { name: 'Close region menu' });
    const pointerDown = createEvent.pointerDown(backdrop);
    fireEvent(backdrop, pointerDown);
    expect(pointerDown.defaultPrevented).toBe(true);
    expect(screen.queryByRole('menu')).not.toBeNull();
    fireEvent.click(backdrop);
    expect(screen.queryByRole('menu')).toBeNull();
    // Dismissal is not a placement.
    expect(harness.placeSurface).not.toHaveBeenCalled();
    expect(harness.setRegion).not.toHaveBeenCalled();
  });

  /**
   * #1386. `click` was the backdrop's only dismissal, and a pointer sequence
   * that never becomes a click left the menu open until the next input. Both
   * ends of the sequence dismiss, and `pointerdown` still does not.
   */
  test('the backdrop dismisses on pointercancel and on pointerup, and a whole click closes it once', () => {
    render(<RegionToolbarControls />);
    const trigger = regionToggle('Left');
    const openBackdrop = () => {
      trigger.focus();
      fireEvent.click(trigger);
      expect(screen.getByRole('menu')).toBeTruthy();
      return screen.getByRole('button', { name: 'Close region menu' });
    };

    let backdrop = openBackdrop();
    fireEvent(backdrop, createEvent.pointerDown(backdrop));
    expect(screen.queryByRole('menu')).not.toBeNull();
    fireEvent.pointerCancel(backdrop);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    backdrop = openBackdrop();
    fireEvent(backdrop, createEvent.pointerDown(backdrop));
    fireEvent.pointerUp(backdrop);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    backdrop = openBackdrop();
    const returnedFocus = vi.spyOn(trigger, 'focus');
    fireEvent(backdrop, createEvent.pointerDown(backdrop));
    fireEvent.pointerUp(backdrop);
    expect(backdrop.isConnected).toBe(false);
    fireEvent.click(backdrop);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(returnedFocus).toHaveBeenCalledTimes(1);
    returnedFocus.mockRestore();
    fireEvent.click(trigger);
    expect(screen.getByRole('menu')).toBeTruthy();
  });

  test('only one offer menu is open at a time: opening another region’s replaces it', () => {
    render(<RegionToolbarControls />);
    openOfferMenu('Left');
    fireEvent.click(regionToggle('Right'));
    expect(screen.getAllByRole('menu')).toHaveLength(1);
    expect(
      screen.getByRole('menu', { name: 'Show in Right region' }),
    ).toBeTruthy();
    expect(regionToggle('Left').getAttribute('aria-expanded')).toBe('false');
    expect(regionToggle('Right').getAttribute('aria-expanded')).toBe('true');
  });

  /**
   * A main occupant is not a dock toggle's business (#1523): with Activity
   * in `main`, the empty regions still offer it — choosing one is
   * `placeSurface` out of `main`, the way out the picker used to give it —
   * and Chat, which declares no `main`, is unaffected.
   */
  test('with Activity in main, an empty region still offers it as its way out', () => {
    Object.assign(harness.regions.main, {
      panes: ['activity'],
      occupant: 'activity',
    });
    render(<RegionToolbarControls />);

    const { menu } = openOfferMenu('Right');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Show Chat here', 'Show Activity here']);
    fireEvent.click(
      within(menu).getByRole('menuitem', { name: 'Show Activity here' }),
    );
    expect(harness.placeSurface).toHaveBeenCalledWith('activity', 'right');
  });

  test('the toggles follow this device’s placements: a two-edge device has two', () => {
    harness.placements = ['bottom', 'right'];
    render(<RegionToolbarControls />);
    expect(toggleStates().map(([label]) => label)).toEqual([
      'Bottom region',
      'Right region',
    ]);
  });

  test('a bottom-only device keeps its glyph-only folded control (#1400 occlusion floor)', () => {
    harness.bottomOnly = true;
    harness.isMobile = false;
    render(<RegionToolbarControls />);

    expect(screen.queryByRole('button', { name: 'Layout regions' })).toBeNull();
    const trigger = screen.getByRole('button', { name: 'Regions' });
    expect(
      trigger.querySelector('.app-toolbar__region-layout-label'),
    ).toBeNull();
    expect(
      screen.getByRole('group', { name: 'Regions' }).querySelectorAll('button'),
    ).toHaveLength(1);
    // Nor does the folded menu list Home: it is not a dock toggle.
    fireEvent.click(trigger);
    expect(
      within(screen.getByRole('menu', { name: 'Region surfaces' }))
        .getAllByRole('menuitemcheckbox')
        .map((item) => item.textContent),
    ).toEqual(['Hide Chat from the dock', 'Show Activity in the dock']);
    // Flat, not grouped: the folded list is one Show/Hide per surface.
    expect(
      within(
        screen.getByRole('menu', { name: 'Region surfaces' }),
      ).queryAllByRole('group'),
    ).toHaveLength(0);
  });

  /**
   * #1523: a surface occupying `main` is neither shown nor hidden by a dock
   * toggle. Its folded-menu row says what the toggle does — return it to the
   * dock — and is a one-shot command (`menuitem`, no checked state), not the
   * `Show <title>` checkbox an unplaced surface gets, which would reveal it
   * where it already is and read as nothing happening.
   */
  test('the folded menu offers to move a main occupant to the dock, and to show an unplaced one', () => {
    harness.bottomOnly = true;
    harness.isMobile = false;
    Object.assign(harness.regions.main, {
      panes: ['activity'],
      occupant: 'activity',
    });
    const { rerender } = render(<RegionToolbarControls />);

    fireEvent.click(screen.getByRole('button', { name: 'Regions' }));
    const menu = screen.getByRole('menu', { name: 'Region surfaces' });
    expect(
      within(menu)
        .getAllByRole('menuitemcheckbox')
        .map((item) => item.textContent),
    ).toEqual(['Hide Chat from the dock']);
    const move = within(menu).getByRole('menuitem', {
      name: 'Move Activity to the dock',
    });
    expect(move.hasAttribute('aria-checked')).toBe(false);
    expect(within(menu).queryByText('Show Activity in the dock')).toBeNull();
    fireEvent.click(move);
    expectOnlyToggle('activity');
    expect(screen.queryByRole('menu')).toBeNull();

    // Once the model has moved it out of `main`, the row is a toggle again.
    Object.assign(harness.regions.main, { panes: ['home'], occupant: 'home' });
    rerender(<RegionToolbarControls />);
    fireEvent.click(screen.getByRole('button', { name: 'Regions' }));
    expect(
      within(screen.getByRole('menu', { name: 'Region surfaces' }))
        .getAllByRole('menuitemcheckbox')
        .map((item) => item.textContent),
    ).toEqual(['Hide Chat from the dock', 'Show Activity in the dock']);
    expect(screen.queryByRole('menuitem')).toBeNull();
  });

  /**
   * #2046 2b, D2: the folded rows are per REGION, in the region's TAB ORDER.
   * A region holding two panes contributes both: the selected pane's row is
   * the region's Hide (checked), the pane behind its tab gets a Show row
   * (unchecked) that selects it — both through the model's own toggle. With
   * the region hidden, both read Show. The fixture puts Activity FIRST in
   * tab order, the reverse of registry order: the per-surface rows this
   * replaced walked the registry and would list Chat first, so a revert
   * fails on the order.
   */
  test('the folded menu lists a two-pane region’s panes in tab order, the selected one as the region’s Hide', () => {
    harness.bottomOnly = true;
    harness.isMobile = false;
    Object.assign(harness.regions.bottom, {
      visible: true,
      panes: ['activity', 'chat'],
      occupant: 'chat',
    });
    const { rerender } = render(<RegionToolbarControls />);

    fireEvent.click(screen.getByRole('button', { name: 'Regions' }));
    let menu = screen.getByRole('menu', { name: 'Region surfaces' });
    expect(
      within(menu)
        .getAllByRole('menuitemcheckbox')
        .map((item) => [item.textContent, item.getAttribute('aria-checked')]),
    ).toEqual([
      ['Show Activity in the dock', 'false'],
      ['Hide Chat from the dock', 'true'],
    ]);
    expect(within(menu).queryByRole('menuitem')).toBeNull();
    fireEvent.click(
      within(menu).getByRole('menuitemcheckbox', {
        name: 'Show Activity in the dock',
      }),
    );
    expectOnlyToggle('activity');

    harness.regions.bottom.visible = false;
    rerender(<RegionToolbarControls />);
    fireEvent.click(screen.getByRole('button', { name: 'Regions' }));
    menu = screen.getByRole('menu', { name: 'Region surfaces' });
    expect(
      within(menu)
        .getAllByRole('menuitemcheckbox')
        .map((item) => [item.textContent, item.getAttribute('aria-checked')]),
    ).toEqual([
      ['Show Activity in the dock', 'false'],
      ['Show Chat in the dock', 'false'],
    ]);
  });

  test('the shell dock surfaces are the only chord registrations', () => {
    // #2047: this set pins the SHELL surfaces — the ones that reach a chord at
    // all. Chords are built from `useRegionSurfaceMenu`'s `surfaceList`, which
    // is already filtered by exposure and by dock region, so a stray
    // `shortcut` on a catalog-only entry (the three coding surfaces) or on a
    // main-only entry (`home`, `regions: ['main']`) can never arrive here —
    // this assertion cannot observe one. That guarantee comes from the filter,
    // pinned in `useRegionSurfaceMenu.placement.test.tsx`, plus the registry
    // pin in `region-model.test.ts`, which asserts `shortcut` is undefined per
    // catalog entry.
    render(<RegionToolbarControls />);
    expect([...harness.shortcuts.keys()].sort()).toEqual([
      'activity.toggle',
      'dock.toggle',
    ]);
  });

  test('the region fieldset holds its controls’ width (#917)', () => {
    const regionsRule = chatCss.match(
      /\.app-toolbar__regions\s*\{([^}]*)\}/,
    )?.[1];
    expect(regionsRule).toMatch(/flex-shrink:\s*0/);
    // `min-width: 0` here is what let the fieldset pack below its controls and
    // put the last one under the first connection action.
    expect(regionsRule).not.toMatch(/min-width:\s*0/);
  });

  test('a wide device gaining a coarse pointer closes the menu instead of re-anchoring it', () => {
    const { rerender } = render(<RegionToolbarControls />);

    openOfferMenu('Left');
    expect(screen.queryByRole('menu')).not.toBeNull();

    // A wide device can change its PRIMARY pointer to coarse without becoming
    // mobile — a touchscreen laptop, a tablet in a keyboard case. `bottomOnly`
    // flips while the overflow branch does not, so the SAME trigger would open
    // a different menu: the folded flat Show/Hide list instead of the grouped
    // arrangement, under a button that just changed its name.
    harness.bottomOnly = true;
    harness.isMobile = false;
    rerender(<RegionToolbarControls />);

    // Neither the offer menu it was showing nor the folded menu that now
    // owns the trigger: the flip closes, it does not re-render the state
    // under a different owner.
    expect(screen.queryByRole('menu')).toBeNull();
    expect(
      screen
        .getByRole('button', { name: 'Regions' })
        .getAttribute('aria-expanded'),
    ).toBe('false');
  });

  test('narrowing into the phone layout takes the whole control away and strands no open menu', () => {
    const { container, rerender } = render(<RegionToolbarControls />);

    openOfferMenu('Left');
    expect(screen.queryByRole('menu')).not.toBeNull();

    // `useDockSlotDevice` re-reads on resize, so the coarse branch can take
    // over with a menu already open and portalled. That portal lives on
    // `document.body`, so an unmount that forgot it would leave a menu
    // floating over the app with nothing left to dismiss it.
    harness.bottomOnly = true;
    harness.isMobile = true;
    rerender(<RegionToolbarControls />);

    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.body.querySelectorAll('button')).toHaveLength(0);
    expect(container.querySelector('fieldset')).toBeNull();

    // Going back the other way: the overflow branch returns before the menu
    // markup, so it unmounts the portal without closing the menu. If the state
    // survived, widening would re-open a menu the user never reopened and
    // `useMenuFocus` would pull focus into it.
    harness.bottomOnly = false;
    harness.isMobile = false;
    rerender(<RegionToolbarControls />);

    expect(screen.queryByRole('menu')).toBeNull();
    expect(regionToggle('Left').getAttribute('aria-expanded')).toBe('false');
  });

  test('a phone renders no region control in the toolbar row at all (#917)', () => {
    harness.bottomOnly = true;
    harness.isMobile = true;
    const { container } = render(<RegionToolbarControls />);

    // The whole point: the row gives its 44px back. Not an empty fieldset —
    // that still costs its own box and its legend — and not a hidden button.
    // The commands live in the `⋯` overflow menu instead.
    expect(container.querySelector('fieldset')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Regions' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Regions' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Layout regions' })).toBeNull();
    // Including anything portalled out of the component.
    expect(document.body.querySelectorAll('button')).toHaveLength(0);
  });

  test('the chords still fold surfaces on a phone that has no toolbar control', () => {
    harness.bottomOnly = true;
    harness.isMobile = true;
    render(<RegionToolbarControls />);

    // ⌘D: Chat occupies the visible folded region; the model's toggle hides
    // it. ⌘⇧A: Activity is unplaced; the coarse rule — show it ALONE rather
    // than open a second visible region beside Chat — is the model's too
    // (`toggleSurface` → `showSurface` → `showSurfaceAlone`, region-model.ts).
    // The chords only issue the command.
    harness.shortcuts.get('dock.toggle')?.handler();
    expectOnlyToggle('chat');
    harness.shortcuts.get('activity.toggle')?.handler();
    expectOnlyToggle('activity', 2);
  });

  test('a coarse device too wide to be mobile keeps the folded Regions menu in the toolbar', () => {
    // A tablet in landscape is bottom-only (`availablePlacements` says so for
    // ANY coarse pointer) but does NOT match the mobile media query, so
    // chat.css never displays the `⋯` button. Moving its region commands there
    // would leave it with no route to them at all, so the toolbar keeps them.
    harness.bottomOnly = true;
    harness.isMobile = false;
    const { rerender } = render(<RegionToolbarControls />);

    const group = screen.getByRole('group', { name: 'Regions' });
    expect(group.querySelectorAll('button')).toHaveLength(1);
    const trigger = screen.getByRole('button', { name: 'Regions' });
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(trigger);
    expect(screen.getByRole('menu', { name: 'Region surfaces' })).toBeTruthy();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    // The verb is the only visible state; the checked state is what an
    // assistive technology reads.
    expect(
      screen
        .getByRole('menuitemcheckbox', { name: 'Hide Chat from the dock' })
        .getAttribute('aria-checked'),
    ).toBe('true');
    expect(
      screen
        .getByRole('menuitemcheckbox', { name: 'Show Activity in the dock' })
        .getAttribute('aria-checked'),
    ).toBe('false');
    fireEvent.click(
      screen.getByRole('menuitemcheckbox', { name: 'Hide Chat from the dock' }),
    );
    expectOnlyToggle('chat');
    expect(screen.queryByRole('menu')).toBeNull();

    harness.regions.bottom.visible = false;
    rerender(<RegionToolbarControls />);
    fireEvent.click(screen.getByRole('button', { name: 'Regions' }));
    fireEvent.click(
      screen.getByRole('menuitemcheckbox', {
        name: 'Show Activity in the dock',
      }),
    );
    expectOnlyToggle('activity', 2);

    fireEvent.click(screen.getByRole('button', { name: 'Regions' }));
    const backdrop = screen.getByRole('button', {
      name: 'Close regions menu',
    });
    const pointerDown = createEvent.pointerDown(backdrop);
    fireEvent(backdrop, pointerDown);
    expect(pointerDown.defaultPrevented).toBe(true);
    expect(screen.queryByRole('menu')).not.toBeNull();
    fireEvent.click(backdrop);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
