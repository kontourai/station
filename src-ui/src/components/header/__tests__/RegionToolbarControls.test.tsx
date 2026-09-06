/** @vitest-environment jsdom */

import { readFileSync } from 'node:fs';
import {
  cleanup,
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

/**
 * The fine pointer's one control, and the placement picker it opens.
 *
 * `role="group"`, not `role="menu"`: #1552 D2 replaced the menu of verbs with one
 * `radiogroup` row per surface, and a menu would own the arrow keys those rows
 * need. `useMenuFocus` derives its roving handler from the role, so the change of
 * role IS the change of keyboard ownership — see `ToolbarMenuSurface`.
 */
function openLayoutMenu() {
  const trigger = screen.getByRole('button', { name: 'Layout regions' });
  fireEvent.click(trigger);
  return {
    trigger,
    menu: screen.getByRole('group', { name: 'Layout regions' }),
  };
}

/** One surface's row of the picker. */
function surfaceRow(menu: HTMLElement, surfaceTitle: string) {
  return within(menu).getByRole('radiogroup', {
    name: `${surfaceTitle} placement`,
  });
}

/**
 * Its segments, in order, as `label` plus whether the segment is pressed.
 *
 * The LABEL is the segment's own text node, not `textContent`: a segment that
 * displaces an occupant also carries a `hidden` span for its `aria-describedby`
 * description, which `textContent` would concatenate into the label (#1552
 * review L6). The description has its own assertions.
 */
function segments(menu: HTMLElement, surfaceTitle: string) {
  return within(surfaceRow(menu, surfaceTitle))
    .getAllByRole('radio')
    .map((segment) => ({
      label: [...segment.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent)
        .join(''),
      checked: segment.getAttribute('aria-checked'),
    }));
}

/** Press one segment of one surface's row. */
function chooseSegment(
  menu: HTMLElement,
  surfaceTitle: string,
  segmentLabel: string,
) {
  fireEvent.click(
    within(surfaceRow(menu, surfaceTitle)).getByRole('radio', {
      name: segmentLabel,
    }),
  );
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

    // The same Hide the retired per-region button carried, then the retired
    // "Hide Chat" menu row: on a fine pointer it is Chat's `Hidden` segment now
    // (#1552 D2).
    //
    // A SEGMENT IS NOT THE CHORD'S TOGGLE, and deliberately so. #1523 routed the
    // toggle through the model because a toggle has to decide what "the other
    // state" is for an unplaced, docked or `main` surface. A segment names its
    // destination outright, so `Hidden` must HIDE — issuing `toggleSurface` here
    // would reveal a Chat that is already hidden. It writes the region's
    // visibility through the model's own `setRegion` primitive; nothing about
    // placement is decided in this hook either way.
    const { menu } = openLayoutMenu();
    chooseSegment(menu, 'Chat', 'Hidden');
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
    // No `aria-haspopup`: this branch opens a group of radiogroups, and there
    // is no value for that — see the popup-claim test above (#1552 review M1).
    expect(trigger.getAttribute('aria-haspopup')).toBeNull();
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

  /**
   * #1552 review M1: the trigger announced `aria-haspopup="menu"` on BOTH
   * branches while the fine pointer opens a `role="group"` of `radiogroup`s.
   * Both directions here, because the folded branch really does open a menu and
   * must keep saying so.
   */
  test('the trigger claims a popup only when it opens one, and names the right kind', () => {
    render(<RegionToolbarControls />);

    const picker = screen.getByRole('button', { name: 'Layout regions' });
    expect(
      picker.getAttribute('aria-haspopup'),
      'the picker is a group of radiogroups; there is no aria-haspopup value for that, so it must claim none',
    ).toBeNull();
    expect(picker.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(picker);
    expect(picker.getAttribute('aria-expanded')).toBe('true');
    // What it actually opened.
    expect(screen.getByRole('group', { name: 'Layout regions' })).toBeTruthy();
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });

    harness.bottomOnly = true;
    harness.isMobile = false;
    cleanup();
    render(<RegionToolbarControls />);
    const folded = screen.getByRole('button', { name: 'Regions' });
    expect(folded.getAttribute('aria-haspopup')).toBe('menu');
    fireEvent.click(folded);
    expect(screen.getByRole('menu', { name: 'Region surfaces' })).toBeTruthy();
  });

  test('the menu opens portalled, anchored to the trigger, and closes on select', () => {
    const { container } = render(<RegionToolbarControls />);

    const trigger = screen.getByRole('button', { name: 'Layout regions' });
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      right: 760,
    } as DOMRect);
    fireEvent.click(trigger);
    const menu = screen.getByRole('group', { name: 'Layout regions' });
    expect(menu.parentElement).toBe(document.body);
    expect(container.contains(menu)).toBe(false);
    expect(menu.style.right).toBe(`${window.innerWidth - 760}px`);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    // The retired "Place Activity here" under a Left heading: Activity's Left
    // segment.
    chooseSegment(menu, 'Activity', 'Left');
    expect(harness.placeSurface).toHaveBeenCalledWith('activity', 'left');
    expect(screen.queryByRole('group', { name: 'Layout regions' })).toBeNull();
  });

  test('it dismisses on Escape and a backdrop click, not on pointerdown, and returns focus', () => {
    render(<RegionToolbarControls />);

    const trigger = screen.getByRole('button', { name: 'Layout regions' });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole('group', { name: 'Layout regions' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('group', { name: 'Layout regions' })).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    const backdrop = screen.getByRole('button', {
      name: 'Close layout menu',
    });
    const pointerDown = createEvent.pointerDown(backdrop);
    fireEvent(backdrop, pointerDown);
    expect(pointerDown.defaultPrevented).toBe(true);
    expect(
      screen.queryByRole('group', { name: 'Layout regions' }),
    ).not.toBeNull();
    fireEvent.click(backdrop);
    expect(screen.queryByRole('group', { name: 'Layout regions' })).toBeNull();
  });

  /**
   * #1386. `click` was the backdrop's only dismissal, and a pointer sequence
   * that never becomes a click left the menu open until the next input: a
   * touch on the backdrop that turns into a scroll ends in `pointercancel`,
   * and a press released where the browser cannot compute a click target ends
   * in neither event. Both ends of the sequence dismiss now, and `pointerdown`
   * still does not — it is swallowed so the panel keeps focus.
   */
  test('the backdrop dismisses on pointercancel and on pointerup, and a whole click closes it once', () => {
    render(<RegionToolbarControls />);
    const trigger = screen.getByRole('button', { name: 'Layout regions' });
    const openBackdrop = () => {
      trigger.focus();
      fireEvent.click(trigger);
      expect(
        screen.getByRole('group', { name: 'Layout regions' }),
      ).toBeTruthy();
      return screen.getByRole('button', { name: 'Close layout menu' });
    };

    // A cancelled sequence: press, then the gesture becomes a scroll. No
    // `click` is ever dispatched, which is what left the menu stuck.
    let backdrop = openBackdrop();
    fireEvent(backdrop, createEvent.pointerDown(backdrop));
    expect(
      screen.queryByRole('group', { name: 'Layout regions' }),
    ).not.toBeNull();
    fireEvent.pointerCancel(backdrop);
    expect(screen.queryByRole('group', { name: 'Layout regions' })).toBeNull();
    expect(document.activeElement).toBe(trigger);

    // The release itself dismisses, so a press whose click never arrives is
    // still a dismissal.
    backdrop = openBackdrop();
    fireEvent(backdrop, createEvent.pointerDown(backdrop));
    fireEvent.pointerUp(backdrop);
    expect(screen.queryByRole('group', { name: 'Layout regions' })).toBeNull();
    expect(document.activeElement).toBe(trigger);

    // The ordinary click, in browser order. `onClose` runs on `pointerup` and
    // again on `click`; the second call must be inert. Focus is returned by
    // `useMenuFocus`'s cleanup, which is the only thing a close moves, so the
    // spy's count IS the answer to "what does the second call do to focus".
    backdrop = openBackdrop();
    const returnedFocus = vi.spyOn(trigger, 'focus');
    fireEvent(backdrop, createEvent.pointerDown(backdrop));
    fireEvent.pointerUp(backdrop);
    fireEvent.click(backdrop);
    expect(screen.queryByRole('group', { name: 'Layout regions' })).toBeNull();
    expect(returnedFocus).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(trigger);
    // Dismissal is not a placement: the backdrop must never reach the model.
    expect(harness.placeSurface).not.toHaveBeenCalled();
    expect(harness.toggleSurface).not.toHaveBeenCalled();
    expect(harness.setRegion).not.toHaveBeenCalled();
    returnedFocus.mockRestore();

    // And the trigger still opens it again, so nothing was left half-closed.
    fireEvent.click(trigger);
    expect(screen.getByRole('group', { name: 'Layout regions' })).toBeTruthy();
  });

  /**
   * KEYBOARD OWNERSHIP, which is what the change of role in #1552 D2 buys.
   *
   * The picker is a stack of `radiogroup`s: the arrow keys move WITHIN one
   * surface's segments and wrap; Tab moves BETWEEN surfaces, which is what the
   * roving `tabIndex` (exactly one tabbable segment per row, the checked one)
   * expresses. A `role="menu"` container would take the arrow keys for its own
   * rows — `useMenuFocus` installs that handler only for the menu role — so
   * this test and `openLayoutMenu`'s `group` query are two halves of one claim.
   */
  test('the arrow keys move within a surface row and wrap; each row has exactly one tab stop', () => {
    render(<RegionToolbarControls />);
    const { menu } = openLayoutMenu();

    const chatRow = surfaceRow(menu, 'Chat');
    const chatSegments = within(chatRow).getAllByRole('radio');
    expect(chatSegments.map((segment) => segment.textContent)).toEqual([
      'Left',
      'Bottom',
      'Right',
      'Hidden',
    ]);

    // Exactly one tab stop per row, and it is the CHECKED segment — Tab lands on
    // where the surface currently is, not on the first choice offered.
    for (const surface of ['Chat', 'Activity']) {
      const tabbable = within(surfaceRow(menu, surface))
        .getAllByRole('radio')
        .filter((segment) => segment.getAttribute('tabindex') === '0');
      expect(
        tabbable.map((segment) => segment.getAttribute('aria-checked')),
        `${surface} must have one tab stop, on the checked segment`,
      ).toEqual(['true']);
    }

    // WHERE FOCUS LANDS ON OPEN. `useMenuFocus` focuses the first focusable
    // descendant, which here is the first row's FIRST segment — and a
    // `tabIndex={-1}` button still matches its `button:not([disabled])` query,
    // so nothing about the roving tab stop steered it. The panel therefore
    // opened proposing "Left" while telling assistive technology the checked
    // segment was the row's tab stop (#1552 review M2). The assertion this
    // replaces (`activeElement === items[0]`) was dropped in the retarget, which
    // is why the regression was invisible.
    expect(document.activeElement).toBe(
      within(chatRow).getByRole('radio', { name: 'Bottom' }),
    );
    expect(
      (document.activeElement as HTMLElement).getAttribute('aria-checked'),
      'focus must land on the CHECKED segment, not merely on a fixed one',
    ).toBe('true');

    chatSegments[1]?.focus();
    fireEvent.keyDown(chatRow, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(chatSegments[2]);
    fireEvent.keyDown(chatRow, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(chatSegments[1]);
    // Wraps at the end, as a radio group does.
    chatSegments[3]?.focus();
    fireEvent.keyDown(chatRow, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(chatSegments[0]);

    // And the arrow keys do NOT leave the row: Activity's segments are
    // unaffected by Chat's arrows.
    expect(
      within(surfaceRow(menu, 'Activity'))
        .getAllByRole('radio')
        .includes(document.activeElement as HTMLElement),
    ).toBe(false);

    expect(
      screen
        .getByRole('button', { name: 'Close layout menu' })
        .getAttribute('tabindex'),
    ).toBe('-1');
  });

  /**
   * THE INVENTORY. Every command the retired verb list carried is reachable, and
   * each is now a segment rather than an imperative:
   *   "Place Chat here" (Left)      → Chat's Left segment
   *   "Swap in Activity" (Bottom)   → Activity's Bottom segment
   *   "Hide Chat"                   → Chat's Hidden segment
   *   "Place Activity here" (Main)  → Activity's Main segment
   * A dropped segment reds this; so does a relabel.
   */
  test('every region×surface placement the verb list carried is a segment, and only the declared ones', () => {
    render(<RegionToolbarControls />);
    const { menu } = openLayoutMenu();

    // One row per dock surface, in registry order. Home is absent: its only
    // placement is `main`, so it is not a dock surface and has no row.
    expect(
      within(menu)
        .getAllByRole('radiogroup')
        .map((row) => row.getAttribute('aria-label')),
    ).toEqual(['Chat placement', 'Activity placement']);

    // Chat declares the dock regions only — no `Main` segment, because
    // `REGION_SURFACE_REGISTRY` does not give Chat a `main` placement and the
    // picker never offers one `placeSurface` would refuse.
    expect(segments(menu, 'Chat')).toEqual([
      { label: 'Left', checked: 'false' },
      { label: 'Bottom', checked: 'true' },
      { label: 'Right', checked: 'false' },
      { label: 'Hidden', checked: 'false' },
    ]);
    // Activity declares all four, and is unplaced in the default arrangement.
    expect(segments(menu, 'Activity')).toEqual([
      { label: 'Left', checked: 'false' },
      { label: 'Bottom', checked: 'false' },
      { label: 'Right', checked: 'false' },
      { label: 'Main', checked: 'false' },
      { label: 'Hidden', checked: 'true' },
    ]);
  });

  test('choosing a region places the surface there; choosing Hidden hides its region', () => {
    render(<RegionToolbarControls />);

    // "Swap in Activity" under the Bottom heading.
    let opened = openLayoutMenu();
    chooseSegment(opened.menu, 'Activity', 'Bottom');
    expect(harness.placeSurface).toHaveBeenCalledWith('activity', 'bottom');

    harness.placeSurface.mockClear();
    // "Place Activity here" under Main.
    opened = openLayoutMenu();
    chooseSegment(opened.menu, 'Activity', 'Main');
    expect(harness.placeSurface).toHaveBeenCalledWith('activity', 'main');

    // "Hide Chat".
    opened = openLayoutMenu();
    chooseSegment(opened.menu, 'Chat', 'Hidden');
    expect(harness.setRegion).toHaveBeenCalledWith('bottom', {
      visible: false,
    });
  });

  test('the pressed segment follows VISIBILITY, not merely placement, and re-choosing it reveals', () => {
    // Chat still occupies `bottom`, but hidden — so `Hidden` is pressed, not
    // `Bottom`. This is the derivation the retired "Show Chat"/"Hide Chat" verb
    // carried in its wording.
    harness.regions.bottom.visible = false;
    render(<RegionToolbarControls />);
    const { menu } = openLayoutMenu();

    expect(segments(menu, 'Chat')).toEqual([
      { label: 'Left', checked: 'false' },
      { label: 'Bottom', checked: 'false' },
      { label: 'Right', checked: 'false' },
      { label: 'Hidden', checked: 'true' },
    ]);

    // Choosing the region it already occupies is a REVEAL, not a move: the old
    // "Show Chat" row. It must not go through `placeSurface`, which would churn
    // the arrangement for a visibility change — nor through the model's
    // `toggleSurface`, which the folded menu's row uses (#1523) because a
    // TOGGLE has to pick the other state. A segment already names the state it
    // wants, and `Show` on an already-hidden Chat must show it, not flip it.
    chooseSegment(menu, 'Chat', 'Bottom');
    expect(harness.setRegion).toHaveBeenCalledWith('bottom', {
      visible: true,
    });
    expect(harness.placeSurface).not.toHaveBeenCalled();
    expect(harness.toggleSurface).not.toHaveBeenCalled();
  });

  /**
   * The tooltip is the honest form of what "Swap in X" implied. It is DERIVED by
   * running the model's own `placeSurface` over the arrangement, so it names the
   * region the displaced surface actually lands in — and says nothing at all when
   * nothing is displaced.
   */
  test('a segment whose region is taken says where its occupant goes, and an empty one promises nothing', () => {
    render(<RegionToolbarControls />);
    const { menu } = openLayoutMenu();

    // Activity → Bottom evicts Chat. Chat cannot go back to the region Activity
    // vacates (Activity is unplaced), so the model relocates it to the first
    // free dock region — and `firstFreeDockRegion` searches
    // `['bottom','right','left']`, so that is RIGHT, not Left. Written here as
    // the derivation reports it: my first draft of this expectation said Left
    // and the assertion caught me, which is the whole argument for computing the
    // sentence from `placeSurface` rather than composing it by hand.
    expect(
      within(surfaceRow(menu, 'Activity'))
        .getByRole('radio', { name: 'Bottom' })
        .getAttribute('title'),
    ).toBe('Chat moves to Right');
    // Activity → Main displaces Home, and `placeSurface` UNPLACES what leaves
    // `main` rather than relocating it (#928 C2a).
    expect(
      within(surfaceRow(menu, 'Activity'))
        .getByRole('radio', { name: 'Main' })
        .getAttribute('title'),
    ).toBe('Home is hidden');
    // Left is empty: no consequence, so no tooltip claiming one.
    const left = within(surfaceRow(menu, 'Activity')).getByRole('radio', {
      name: 'Left',
    });
    expect(left.hasAttribute('title')).toBe(false);
    expect(left.hasAttribute('aria-describedby')).toBe(false);

    // #1552 review L6: the consequence reaches a non-pointer reader too, and
    // does so WITHOUT joining the button's accessible name — the segment is
    // still called "Bottom", which is what `getByRole` above resolves it by.
    const bottom = within(surfaceRow(menu, 'Activity')).getByRole('radio', {
      name: 'Bottom',
    });
    const described = document.getElementById(
      bottom.getAttribute('aria-describedby') ?? '',
    );
    expect(described?.textContent).toBe('Chat moves to Right');
    expect(bottom.textContent).toContain('Bottom');
  });

  /**
   * #1552 review M3. `placeSurface` carries the TARGET region's previous
   * visibility across to the surface it displaces, so a relocation can arrive
   * hidden — and the note used to say "moves to Right" for exactly that, while
   * the picker's own segment for that surface then read Hidden. One arrangement,
   * two contradictory statements. Both now come from `placementOf`.
   */
  test('a displaced surface that lands hidden is described as landing hidden', () => {
    // Chat holds `right` and is SHOWN; Activity holds `bottom` and is hidden.
    // Choosing CHAT's Bottom segment sends Activity to `right` carrying
    // `bottom`'s visibility at the time of the move, which is false.
    Object.assign(harness.regions.right, { visible: true, occupant: 'chat' });
    Object.assign(harness.regions.bottom, {
      visible: false,
      occupant: 'activity',
    });
    render(<RegionToolbarControls />);
    const { menu } = openLayoutMenu();

    const note = within(surfaceRow(menu, 'Chat'))
      .getByRole('radio', { name: 'Bottom' })
      .getAttribute('title');
    expect(note).toBe('Activity moves to Right, hidden');

    // The precondition that makes "hidden" the honest word: Activity is not
    // visible now, and the move relocates it without revealing it — so a note
    // stopping at "moves to Right" would promise the reader a surface they will
    // still not see. (`checked` is the raw attribute string, so this compares
    // against 'true' rather than truthiness — every segment has the attribute.)
    expect(
      segments(menu, 'Activity').find((segment) => segment.checked === 'true')
        ?.label,
    ).toBe('Hidden');
  });

  test('with Activity in main, Main is its pressed segment and Chat is still offered no Main', () => {
    harness.regions.main.occupant = 'activity';
    render(<RegionToolbarControls />);
    const { menu } = openLayoutMenu();

    expect(segments(menu, 'Activity')).toEqual([
      { label: 'Left', checked: 'false' },
      { label: 'Bottom', checked: 'false' },
      { label: 'Right', checked: 'false' },
      { label: 'Main', checked: 'true' },
      { label: 'Hidden', checked: 'false' },
    ]);
    expect(segments(menu, 'Chat').map((segment) => segment.label)).toEqual([
      'Left',
      'Bottom',
      'Right',
      'Hidden',
    ]);
  });

  /**
   * #1523 in the picker's own vocabulary.
   *
   * The folded menu gives a `main` occupant a single "Move <title> to the dock"
   * command because a toggle cannot express anything better for it. The picker
   * has room to be specific: the same journey is choosing WHICH dock region, and
   * every one of them is offered and lands through `placeSurface`. The guarantee
   * that matters is the one #1523 names — a surface in `main` has a real route
   * out of it — and here it is three routes, not one.
   */
  test('a main occupant is offered every dock region it declares as a way out of main', () => {
    harness.regions.main.occupant = 'activity';
    render(<RegionToolbarControls />);

    for (const region of ['Left', 'Bottom', 'Right'] as const) {
      // Re-opened, and re-QUERIED, each time: choosing a segment closes the
      // panel and unmounts its portal, so a menu element captured before the
      // first choice is a detached node for every iteration after it.
      const { menu } = openLayoutMenu();
      chooseSegment(menu, 'Activity', region);
      expect(
        harness.placeSurface,
        `Activity's ${region} segment must place it there`,
      ).toHaveBeenLastCalledWith('activity', region.toLowerCase());
      // Not the folded menu's toggle: the segment names its destination, so it
      // must not hand the choice back to a command that picks one for it.
      expect(harness.toggleSurface).not.toHaveBeenCalled();
    }
  });

  test('Hidden for a surface holding main hands the primary area back to Home', () => {
    // `main` is always visible, so hiding its occupant cannot be a visibility
    // write. The only meaning is that Home has the primary area back, which is
    // `placeSurface`'s own documented rule for `main` (the displaced surface is
    // unplaced) rather than a new unplace primitive.
    harness.regions.main.occupant = 'activity';
    render(<RegionToolbarControls />);
    const { menu } = openLayoutMenu();

    chooseSegment(menu, 'Activity', 'Hidden');
    expect(harness.placeSurface).toHaveBeenCalledWith('home', 'main');
    expect(harness.setRegion).not.toHaveBeenCalled();
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
    harness.regions.main.occupant = 'activity';
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
    harness.regions.main.occupant = 'home';
    rerender(<RegionToolbarControls />);
    fireEvent.click(screen.getByRole('button', { name: 'Regions' }));
    expect(
      within(screen.getByRole('menu', { name: 'Region surfaces' }))
        .getAllByRole('menuitemcheckbox')
        .map((item) => item.textContent),
    ).toEqual(['Hide Chat from the dock', 'Show Activity in the dock']);
    expect(screen.queryByRole('menuitem')).toBeNull();
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
    expect(
      screen.queryByRole('group', { name: 'Layout regions' }),
    ).not.toBeNull();

    // A wide device can change its PRIMARY pointer to coarse without becoming
    // mobile — a touchscreen laptop, a tablet in a keyboard case. `bottomOnly`
    // flips while the overflow branch does not, so the SAME trigger would open
    // a different menu: the folded flat Show/Hide list instead of the grouped
    // arrangement, under a button that just changed its name.
    harness.bottomOnly = true;
    harness.isMobile = false;
    rerender(<RegionToolbarControls />);

    // Neither the picker it was showing nor the folded menu that now owns the
    // trigger: the flip closes, it does not re-render the state under a
    // different owner.
    expect(screen.queryByRole('group', { name: 'Layout regions' })).toBeNull();
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
    expect(
      screen.queryByRole('group', { name: 'Layout regions' }),
    ).not.toBeNull();

    // `useDockSlotDevice` re-reads on resize, so the coarse branch can take
    // over with a menu already open and portalled. That portal lives on
    // `document.body`, so an unmount that forgot it would leave a menu
    // floating over the app with nothing left to dismiss it.
    harness.bottomOnly = true;
    harness.isMobile = true;
    rerender(<RegionToolbarControls />);

    expect(screen.queryByRole('group', { name: 'Layout regions' })).toBeNull();
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

    expect(screen.queryByRole('group', { name: 'Layout regions' })).toBeNull();
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
      screen.getByRole('menuitemcheckbox', { name: 'Show Activity in the dock' }),
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
