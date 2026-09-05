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
    main: { visible: true, size: 0, occupant: 'home' as string | null },
    left: { visible: false, size: 400, occupant: null },
    right: { visible: false, size: 400, occupant: null },
    bottom: { visible: true, size: 320, occupant: 'chat' },
  },
  setDockMode: vi.fn(),
  setDockState: vi.fn(),
  setRegion: vi.fn(),
  placeSurface: vi.fn(),
  showSurface: vi.fn(),
  bottomOnly: false,
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
    }),
    useRegionModel: () => ({
      regions: harness.regions,
      surfaces: REGION_SURFACE_REGISTRY,
      setRegion: harness.setRegion,
      placeSurface: harness.placeSurface,
      showSurface: harness.showSurface,
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
    harness.bottomOnly ? ['bottom'] : ['left', 'right', 'bottom'],
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

/** The fine pointer's one control, and the menu it opens. */
function openLayoutMenu() {
  const trigger = screen.getByRole('button', { name: 'Layout regions' });
  fireEvent.click(trigger);
  return {
    trigger,
    menu: screen.getByRole('menu', { name: 'Layout regions' }),
  };
}

/** Every row under one region heading, in order. Headings are spans. */
function rowLabels(menu: HTMLElement, regionLabel: string) {
  const group = within(menu).getByRole('group', { name: regionLabel });
  return [...group.querySelectorAll('button')].map((row) => row.textContent);
}

describe('RegionToolbarControls', () => {
  beforeEach(() => {
    Object.assign(harness.regions.main, {
      visible: true,
      size: 0,
      occupant: 'home',
    });
    Object.assign(harness.regions.left, {
      visible: false,
      size: 400,
      occupant: null,
    });
    Object.assign(harness.regions.right, {
      visible: false,
      size: 400,
      occupant: null,
    });
    Object.assign(harness.regions.bottom, {
      visible: true,
      size: 320,
      occupant: 'chat',
    });
    harness.setDockMode.mockReset();
    harness.setDockState.mockReset();
    harness.setRegion.mockReset();
    harness.placeSurface.mockReset();
    harness.showSurface.mockReset();
    harness.bottomOnly = false;
    harness.isMobile = false;
    harness.shortcuts.clear();
  });

  test('registers both surface shortcuts and toggles or places from their metadata', () => {
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
    expect(harness.setRegion).toHaveBeenCalledWith('bottom', {
      visible: false,
    });
    expect(harness.regions.bottom.occupant).toBe('chat');

    harness.shortcuts.get('activity.toggle')?.handler();
    expect(harness.showSurface).toHaveBeenCalledWith('activity');

    // The same Hide the retired per-region button carried, now a menu row.
    openLayoutMenu();
    fireEvent.click(
      screen.getByRole('menuitemcheckbox', { name: 'Hide Chat' }),
    );
    expect(harness.setRegion).toHaveBeenLastCalledWith('bottom', {
      visible: false,
    });
  });

  test('the Activity chord asks the model to show an unplaced surface and computes no placement of its own (#1420)', () => {
    // Chat sits in Activity's preferred region with a free region beside it:
    // the fixture where the toolbar's own copy of the rules used to pick the
    // free region so as not to evict Chat. That choice belongs to the model's
    // `showSurface` (`revealSurface` in region-model.ts, tested there); the
    // toolbar issues the command once and places nothing itself, so a change
    // to the rules cannot leave it holding a stale copy.
    Object.assign(harness.regions.bottom, {
      visible: false,
      occupant: null,
    });
    Object.assign(harness.regions.right, { visible: true, occupant: 'chat' });
    render(<RegionToolbarControls />);

    harness.shortcuts.get('activity.toggle')?.handler();

    expect(harness.showSurface).toHaveBeenCalledTimes(1);
    expect(harness.showSurface).toHaveBeenCalledWith('activity');
    expect(harness.placeSurface).not.toHaveBeenCalled();
    expect(harness.setRegion).not.toHaveBeenCalled();
  });

  test('the Activity chord toggles its existing region hidden and visible', () => {
    Object.assign(harness.regions.right, {
      visible: true,
      occupant: 'activity',
    });
    render(<RegionToolbarControls />);

    harness.shortcuts.get('activity.toggle')?.handler();
    expect(harness.setRegion).toHaveBeenLastCalledWith('right', {
      visible: false,
    });
    harness.regions.right.visible = false;
    harness.shortcuts.get('activity.toggle')?.handler();
    expect(harness.setRegion).toHaveBeenLastCalledWith('right', {
      visible: true,
    });
  });

  /**
   * #1536 F: five unlabeled monochrome rectangles (four region glyphs plus a
   * `⋯` swap) became ONE control with a visible word. The commands did not
   * change; where they live did.
   */
  test('a fine pointer renders one region control, carrying a visible word inside its accessible name', () => {
    render(<RegionToolbarControls />);

    const buttons = [
      ...screen
        .getByRole('group', { name: 'Regions' })
        .querySelectorAll('button'),
    ];
    expect(buttons).toHaveLength(1);
    const trigger = buttons[0] as HTMLButtonElement;
    expect(trigger.getAttribute('aria-label')).toBe('Layout regions');
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    // WCAG 2.5.3: the visible word must be part of the accessible name.
    const visible = trigger.querySelector(
      '.app-toolbar__region-layout-label',
    )?.textContent;
    expect(visible).toBe('Layout');
    expect(trigger.getAttribute('aria-label')).toContain(visible);
    // And the button is no longer a fixed square glyph box.
    const layoutRule = chatCss.match(
      /\.app-toolbar__region-layout\s*\{([^}]*)\}/,
    )?.[1];
    expect(layoutRule).toMatch(/width:\s*auto/);
  });

  test('the menu opens portalled, anchored to the trigger, and closes on select', () => {
    const { container } = render(<RegionToolbarControls />);

    const trigger = screen.getByRole('button', { name: 'Layout regions' });
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      right: 760,
    } as DOMRect);
    fireEvent.click(trigger);
    const menu = screen.getByRole('menu', { name: 'Layout regions' });
    expect(menu.parentElement).toBe(document.body);
    expect(container.contains(menu)).toBe(false);
    expect(menu.style.right).toBe(`${window.innerWidth - 760}px`);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(
      within(within(menu).getByRole('group', { name: 'Left' })).getByRole(
        'menuitem',
        { name: 'Place Activity here' },
      ),
    );
    expect(harness.placeSurface).toHaveBeenCalledWith('activity', 'left');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  test('it dismisses on Escape and a backdrop click, not on pointerdown, and returns focus', () => {
    render(<RegionToolbarControls />);

    const trigger = screen.getByRole('button', { name: 'Layout regions' });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole('menu', { name: 'Layout regions' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    const backdrop = screen.getByRole('button', {
      name: 'Close layout menu',
    });
    const pointerDown = createEvent.pointerDown(backdrop);
    fireEvent(backdrop, pointerDown);
    expect(pointerDown.defaultPrevented).toBe(true);
    expect(screen.queryByRole('menu')).not.toBeNull();
    fireEvent.click(backdrop);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  /**
   * The inventory, per region, for the default arrangement — the same set of
   * commands the five buttons exposed (Main placement, an empty region's
   * placements, an occupied region's Hide plus its swap). A dropped command
   * reds this; so does a relabel.
   */
  test('the menu carries every command the five buttons exposed, grouped by region', () => {
    render(<RegionToolbarControls />);
    const { menu } = openLayoutMenu();

    expect(
      within(menu)
        .getAllByRole('group')
        .map((group) => group.getAttribute('aria-label')),
    ).toEqual(['Main', 'Left', 'Right', 'Bottom']);

    expect(rowLabels(menu, 'Main')).toEqual(['Place Activity here']);
    expect(rowLabels(menu, 'Left')).toEqual([
      'Place Chat here',
      'Place Activity here',
    ]);
    expect(rowLabels(menu, 'Right')).toEqual([
      'Place Chat here',
      'Place Activity here',
    ]);
    expect(rowLabels(menu, 'Bottom')).toEqual([
      'Hide Chat',
      'Swap in Activity',
    ]);
  });

  test('the Show/Hide row is the checked state, and the verb follows visibility', () => {
    render(<RegionToolbarControls />);

    openLayoutMenu();
    expect(
      screen
        .getByRole('menuitemcheckbox', { name: 'Hide Chat' })
        .getAttribute('aria-checked'),
    ).toBe('true');
    fireEvent.keyDown(document, { key: 'Escape' });

    harness.regions.bottom.visible = false;
    openLayoutMenu();
    const row = screen.getByRole('menuitemcheckbox', { name: 'Show Chat' });
    expect(row.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(row);
    expect(harness.setRegion).toHaveBeenCalledWith('bottom', {
      visible: true,
    });
  });

  test('the placement rows are one-shot commands, not toggles', () => {
    render(<RegionToolbarControls />);
    openLayoutMenu();

    const place = screen.getAllByRole('menuitem', {
      name: 'Place Activity here',
    });
    expect(place.length).toBeGreaterThan(0);
    for (const row of place) {
      expect(row.hasAttribute('aria-checked')).toBe(false);
    }
  });

  test('with Activity in main the menu offers Home back, and no dock group offers Home', () => {
    harness.regions.main.occupant = 'activity';
    render(<RegionToolbarControls />);
    const { menu } = openLayoutMenu();

    expect(rowLabels(menu, 'Main')).toEqual(['Place Home here']);
    expect(rowLabels(menu, 'Left')).toEqual([
      'Place Chat here',
      'Place Activity here',
    ]);
    expect(rowLabels(menu, 'Bottom')).toEqual([
      'Hide Chat',
      'Swap in Activity',
    ]);
  });

  test('an empty main (Activity left it) is Home on screen, so the menu does not offer Home', () => {
    harness.regions.main.occupant = null;
    render(<RegionToolbarControls />);
    const { menu } = openLayoutMenu();

    expect(rowLabels(menu, 'Main')).toEqual(['Place Activity here']);
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
    ).toEqual(['Hide Chat', 'Show Activity']);
    // Flat, not grouped: the folded list is one Show/Hide per surface.
    expect(
      within(
        screen.getByRole('menu', { name: 'Region surfaces' }),
      ).queryAllByRole('group'),
    ).toHaveLength(0);
  });

  test('Home registers no chord', () => {
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

    openLayoutMenu();
    expect(screen.queryByRole('menu')).not.toBeNull();

    // A wide device can change its PRIMARY pointer to coarse without becoming
    // mobile — a touchscreen laptop, a tablet in a keyboard case. `bottomOnly`
    // flips while the overflow branch does not, so the SAME trigger would open
    // a different menu: the folded flat Show/Hide list instead of the grouped
    // arrangement, under a button that just changed its name.
    harness.bottomOnly = true;
    harness.isMobile = false;
    rerender(<RegionToolbarControls />);

    expect(screen.queryByRole('menu')).toBeNull();
    expect(
      screen
        .getByRole('button', { name: 'Regions' })
        .getAttribute('aria-expanded'),
    ).toBe('false');
  });

  test('narrowing into the phone layout takes the whole control away and strands no open menu', () => {
    const { container, rerender } = render(<RegionToolbarControls />);

    openLayoutMenu();
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
    expect(
      screen
        .getByRole('button', { name: 'Layout regions' })
        .getAttribute('aria-expanded'),
    ).toBe('false');
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

    // ⌘D: Chat occupies the visible folded region, so its chord hides it.
    harness.shortcuts.get('dock.toggle')?.handler();
    expect(harness.setRegion).toHaveBeenCalledWith('bottom', {
      visible: false,
    });

    harness.setRegion.mockClear();
    // ⌘⇧A: Activity is unplaced. The coarse rule — show it ALONE rather than
    // open a second visible region beside Chat — is the model's `showSurface`
    // (`showSurfaceAlone` in region-model.ts); the chord only issues it.
    harness.shortcuts.get('activity.toggle')?.handler();
    expect(harness.showSurface).toHaveBeenCalledWith('activity');
    expect(harness.placeSurface).not.toHaveBeenCalled();
    expect(harness.setRegion).not.toHaveBeenCalled();
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
        .getByRole('menuitemcheckbox', { name: 'Hide Chat' })
        .getAttribute('aria-checked'),
    ).toBe('true');
    expect(
      screen
        .getByRole('menuitemcheckbox', { name: 'Show Activity' })
        .getAttribute('aria-checked'),
    ).toBe('false');
    fireEvent.click(
      screen.getByRole('menuitemcheckbox', { name: 'Hide Chat' }),
    );
    expect(harness.setRegion).toHaveBeenCalledWith('bottom', {
      visible: false,
    });
    expect(screen.queryByRole('menu')).toBeNull();

    harness.setRegion.mockClear();
    harness.regions.bottom.visible = false;
    rerender(<RegionToolbarControls />);
    fireEvent.click(screen.getByRole('button', { name: 'Regions' }));
    fireEvent.click(
      screen.getByRole('menuitemcheckbox', { name: 'Show Activity' }),
    );
    expect(harness.showSurface).toHaveBeenCalledWith('activity');
    expect(harness.placeSurface).not.toHaveBeenCalled();
    expect(harness.setRegion).not.toHaveBeenCalled();

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
