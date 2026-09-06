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
  toggleSurface: vi.fn(),
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
    harness.toggleSurface.mockReset();
    harness.bottomOnly = false;
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

    fireEvent.click(
      screen.getByRole('button', { name: 'Hide Chat Bottom region' }),
    );
    expectOnlyToggle('chat', 3);
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
      occupant: null,
    });
    Object.assign(harness.regions.right, { visible: true, occupant: 'chat' });
    const { rerender } = render(<RegionToolbarControls />);

    harness.shortcuts.get('activity.toggle')?.handler();
    expectOnlyToggle('activity');

    Object.assign(harness.regions.right, {
      visible: true,
      occupant: 'activity',
    });
    rerender(<RegionToolbarControls />);
    harness.shortcuts.get('activity.toggle')?.handler();
    expectOnlyToggle('activity', 2);

    // ⌘⇧A with Activity occupying `main` (#1523): the same command. The
    // model relocates it to its dock region; the toolbar must not turn this
    // into a `showSurface` that reveals it where it already is.
    harness.regions.right.occupant = null;
    harness.regions.main.occupant = 'activity';
    rerender(<RegionToolbarControls />);
    harness.shortcuts.get('activity.toggle')?.handler();
    expectOnlyToggle('activity', 3);
  });

  test('an empty region opens a portalled menu and places either registered surface', () => {
    const { container } = render(<RegionToolbarControls />);

    const trigger = screen.getByRole('button', {
      name: 'Choose a surface for Left region',
    });
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.hasAttribute('aria-pressed')).toBe(false);
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      right: 760,
    } as DOMRect);
    fireEvent.click(trigger);
    const menu = screen.getByRole('menu', { name: 'Left region surfaces' });
    expect(menu.parentElement).toBe(document.body);
    expect(container.contains(menu)).toBe(false);
    expect(menu.style.right).toBe(`${window.innerWidth - 760}px`);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(
      screen.getByRole('menuitem', { name: 'Place Chat here' }),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole('menuitem', { name: 'Place Activity here' }),
    );
    expect(harness.placeSurface).toHaveBeenCalledWith('activity', 'left');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  test('an occupied region exposes a keyboard-reachable swap menu that dismisses on Escape and a backdrop click, not on pointerdown', () => {
    render(<RegionToolbarControls />);

    const trigger = screen.getByRole('button', {
      name: 'Change Bottom region surface',
    });
    expect(trigger.classList.contains('app-toolbar__region-swap')).toBe(true);
    const swapRule = chatCss.match(
      /\.app-toolbar__region-swap\s*\{([^}]*)\}/,
    )?.[1];
    expect(swapRule).toMatch(/position:\s*static/);
    expect(swapRule).toMatch(/min-width:\s*24px/);
    expect(swapRule).toMatch(/min-height:\s*24px/);
    trigger.focus();
    fireEvent.click(trigger);
    expect(
      screen.getByRole('menuitem', { name: 'Swap in Activity' }),
    ).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    const backdrop = screen.getByRole('button', {
      name: 'Close Bottom region menu',
    });
    const pointerDown = createEvent.pointerDown(backdrop);
    fireEvent(backdrop, pointerDown);
    expect(pointerDown.defaultPrevented).toBe(true);
    expect(screen.queryByRole('menu')).not.toBeNull();
    fireEvent.click(backdrop);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  /**
   * #928 C2a: `main` is a choosable region. Its control has no show/hide half
   * (`main` is always visible), so the primary click opens the placement
   * menu; the menu offers the surfaces that declare `main`, minus the one in
   * it. Home declares only `main`, so no dock menu ever offers Home.
   */
  const dockControlLabels = () =>
    [
      ...screen
        .getByRole('group', { name: 'Regions' })
        .querySelectorAll(
          'button:not([aria-label="Change Main region surface"])',
        ),
    ].map((button) => button.getAttribute('aria-label'));

  test('the main control opens a placement menu of the surfaces that declare main, minus its occupant', () => {
    render(<RegionToolbarControls />);

    const trigger = screen.getByRole('button', {
      name: 'Change Main region surface',
    });
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.hasAttribute('aria-pressed')).toBe(false);
    expect(
      screen.getByRole('group', { name: 'Regions' }).querySelector('button'),
      'main comes before the dock controls',
    ).toBe(trigger);
    fireEvent.click(trigger);

    const menu = screen.getByRole('menu', { name: 'Main region surfaces' });
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Place Activity here']);
    fireEvent.click(
      screen.getByRole('menuitem', { name: 'Place Activity here' }),
    );
    expect(harness.placeSurface).toHaveBeenCalledWith('activity', 'main');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  test('with Activity in main the control offers Home back, and no dock menu offers Home', () => {
    harness.regions.main.occupant = 'activity';
    render(<RegionToolbarControls />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Change Main region surface' }),
    );
    expect(
      within(screen.getByRole('menu', { name: 'Main region surfaces' }))
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Place Home here']);
    fireEvent.keyDown(document, { key: 'Escape' });

    fireEvent.click(
      screen.getByRole('button', { name: 'Choose a surface for Left region' }),
    );
    expect(
      within(screen.getByRole('menu', { name: 'Left region surfaces' }))
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Place Chat here', 'Place Activity here']);
    fireEvent.keyDown(document, { key: 'Escape' });

    fireEvent.click(
      screen.getByRole('button', { name: 'Change Bottom region surface' }),
    );
    expect(
      within(screen.getByRole('menu', { name: 'Bottom region surfaces' }))
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Swap in Activity']);
  });

  test('an empty main (Activity left it) is Home on screen, so the menu does not offer Home', () => {
    harness.regions.main.occupant = null;
    render(<RegionToolbarControls />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Change Main region surface' }),
    );
    expect(
      within(screen.getByRole('menu', { name: 'Main region surfaces' }))
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Place Activity here']);
  });

  test('the dock control labels are what they were before main became choosable', () => {
    render(<RegionToolbarControls />);

    // The exact strings the pre-C2a toolbar rendered for the default
    // arrangement, in order. A relabel of any dock control reds this.
    expect(dockControlLabels()).toEqual([
      'Choose a surface for Left region',
      'Choose a surface for Right region',
      'Hide Chat Bottom region',
      'Change Bottom region surface',
    ]);
  });

  test('a bottom-only device gets no main control (#1400 occlusion floor)', () => {
    harness.bottomOnly = true;
    harness.isMobile = false;
    render(<RegionToolbarControls />);

    expect(
      screen.queryByRole('button', { name: 'Change Main region surface' }),
    ).toBeNull();
    expect(
      screen.getByRole('group', { name: 'Regions' }).querySelectorAll('button'),
    ).toHaveLength(1);
    // Nor does the folded menu list Home: it is not a dock toggle.
    fireEvent.click(screen.getByRole('button', { name: 'Regions' }));
    expect(
      within(screen.getByRole('menu', { name: 'Region surfaces' }))
        .getAllByRole('menuitemcheckbox')
        .map((item) => item.textContent),
    ).toEqual(['Hide Chat', 'Show Activity']);
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
    harness.regions.main.occupant = 'activity';
    const { rerender } = render(<RegionToolbarControls />);

    fireEvent.click(screen.getByRole('button', { name: 'Regions' }));
    const menu = screen.getByRole('menu', { name: 'Region surfaces' });
    expect(
      within(menu)
        .getAllByRole('menuitemcheckbox')
        .map((item) => item.textContent),
    ).toEqual(['Hide Chat']);
    const move = within(menu).getByRole('menuitem', {
      name: 'Move Activity to the dock',
    });
    expect(move.hasAttribute('aria-checked')).toBe(false);
    expect(within(menu).queryByText('Show Activity')).toBeNull();
    fireEvent.click(move);
    expectOnlyToggle('activity');
    expect(screen.queryByRole('menu')).toBeNull();

    // Once the model has moved it out of `main`, the row is a toggle again.
    harness.regions.main.occupant = 'home';
    rerender(<RegionToolbarControls />);
    fireEvent.click(screen.getByRole('button', { name: 'Regions' }));
    expect(
      within(screen.getByRole('menu', { name: 'Region surfaces' }))
        .getAllByRole('menuitemcheckbox')
        .map((item) => item.textContent),
    ).toEqual(['Hide Chat', 'Show Activity']);
    expect(screen.queryByRole('menuitem')).toBeNull();
  });

  test('Home registers no chord', () => {
    render(<RegionToolbarControls />);
    expect([...harness.shortcuts.keys()].sort()).toEqual([
      'activity.toggle',
      'dock.toggle',
    ]);
  });

  test('the region fieldset holds its controls\u2019 width (#917)', () => {
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

    fireEvent.click(
      screen.getByRole('button', { name: 'Choose a surface for Left region' }),
    );
    expect(screen.queryByRole('menu')).not.toBeNull();

    // A wide device can change its PRIMARY pointer to coarse without becoming
    // mobile — a touchscreen laptop, a tablet in a keyboard case. `bottomOnly`
    // flips while the overflow branch does not, so this renders the folded
    // Regions menu: an open per-region popover would silently become a
    // different menu, still anchored to the trigger that is now gone.
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

    fireEvent.click(
      screen.getByRole('button', { name: 'Choose a surface for Left region' }),
    );
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
        .getByRole('button', { name: 'Choose a surface for Left region' })
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
    expectOnlyToggle('chat');
    expect(screen.queryByRole('menu')).toBeNull();

    harness.regions.bottom.visible = false;
    rerender(<RegionToolbarControls />);
    fireEvent.click(screen.getByRole('button', { name: 'Regions' }));
    fireEvent.click(
      screen.getByRole('menuitemcheckbox', { name: 'Show Activity' }),
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
