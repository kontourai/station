/** @vitest-environment jsdom */

import { readFileSync } from 'node:fs';
import {
  act,
  createEvent,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const chatCss = readFileSync('src-ui/src/components/chat/chat.css', 'utf8');
/**
 * The toolbar's source with its COMMENTS removed. A retirement scan over the
 * raw file matches the paragraph that records the retirement — the docblock
 * below names `aria-disabled` to say it is gone — so the scan would red on
 * the prose and pass on the code.
 */
const toolbarCode = readFileSync(
  'src-ui/src/components/header/RegionToolbarControls.tsx',
  'utf8',
)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

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
  // #2154's chooser places through the model's own `openSurfaceInRegion`;
  // the toolbar only opens the panel (#2155).
  openSurfaceInRegion: vi.fn(() => ({ ok: true }) as { ok: true }),
  bottomOnly: false,
  /** The registry the mocked model exposes; one test narrows it. */
  surfaces: null as null | Map<string, unknown>,
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
      surfaces: harness.surfaces ?? REGION_SURFACE_REGISTRY,
      setRegion: vi.fn(),
      placeSurface: harness.placeSurface,
      showSurface: harness.showSurface,
      toggleSurface: harness.toggleSurface,
      openSurfaceInRegion: harness.openSurfaceInRegion,
    }),
    useRegionModel: () => ({
      regions: harness.regions,
      surfaces: harness.surfaces ?? REGION_SURFACE_REGISTRY,
      setRegion: harness.setRegion,
      placeSurface: harness.placeSurface,
      showSurface: harness.showSurface,
      toggleSurface: harness.toggleSurface,
      openSurfaceInRegion: harness.openSurfaceInRegion,
    }),
  };
});

// The chooser panel the toggles open carries the dock's project read
// (`RegionChooserPanel` → `useDockProject`), which is the only reason this
// file needs these three. No project: the rows that need one list disabled
// with the reason, which is #2154's own behaviour, tested there.
vi.mock('../../../contexts/DeviceSettingsContext', () => ({
  useDeviceSettings: () => ({ chatDockProjectSlug: null }),
}));

vi.mock('../../../contexts/ProjectsContext', () => ({
  useProject: () => ({ project: undefined, isLoading: false }),
}));

vi.mock('../../../hooks/useActiveProject', () => ({
  useActiveProject: () => ({ projectSlug: null }),
}));

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

import { REGION_SURFACE_REGISTRY } from '../../../regions/region-model';
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

/**
 * A hold on a toggle, as the browser delivers one: the press, the wait, the
 * release, and the CLICK the release still produces — which the control has
 * to swallow, or the hold would open the chooser and toggle the region under
 * it (#2155 D2).
 *
 * `holdMs` short of the threshold is an ordinary press; the caller passing
 * one is what makes the 500ms boundary observable rather than assumed.
 */
async function holdToggle(
  label: 'Left' | 'Bottom' | 'Right',
  holdMs = 500,
): Promise<HTMLElement> {
  const trigger = regionToggle(label);
  // A real press focuses the button before anything else happens; jsdom's
  // synthetic pointer events do not, and the panel's focus RETURN is captured
  // from whatever held focus when it opened.
  trigger.focus();
  fireEvent.pointerDown(trigger, { button: 0, clientX: 40, clientY: 10 });
  await act(async () => {
    vi.advanceTimersByTime(holdMs);
  });
  fireEvent.pointerUp(trigger);
  fireEvent.click(trigger);
  await settleChooserChunk();
  return trigger;
}

/**
 * The chooser is behind a `LazyBoundary` (it is not in the toolbar's entry
 * chunk), so the panel arrives one dynamic import after the gesture.
 */
async function settleChooserChunk(): Promise<void> {
  await act(async () => {
    await vi.dynamicImportSettled();
  });
}

/** The chooser panel for a region, as #2154 names it. */
function chooserPanel(label: 'Left' | 'Bottom' | 'Right') {
  return screen.getByRole('menu', { name: `Add to ${label} region` });
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
    harness.openSurfaceInRegion.mockClear();
    harness.bottomOnly = false;
    harness.surfaces = null;
    harness.placements = ['left', 'right', 'bottom'];
    harness.isMobile = false;
    harness.shortcuts.clear();
    // The hold is a real 500ms wait, so every test that drives one runs on
    // fake time; the rest are unaffected by an idle fake clock.
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
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
      maximized: false,
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
      ['Left region', 'false'],
      ['Bottom region', 'true'],
      ['Right region', 'false'],
    ]);
    // Bottom holds Chat and is pressed. Left and right are EMPTY and hidden,
    // and since #2155 that is `'false'`, not `null`: they are toggles too,
    // and pressing one opens its region on the chooser.
    expect(regionToggle('Bottom').title).toBe('Hide Bottom region: Chat');
    // No visible word: the glyph is the region's own edge, and the name is
    // the tooltip's and the accessible name's.
    expect(
      document.querySelector('.app-toolbar__region-layout-label'),
    ).toBeNull();
    expect(screen.queryByRole('button', { name: 'Layout regions' })).toBeNull();
  });

  /**
   * #2155 D1, as a table over all three regions in one assertion, because
   * what it pins is the ABSENCE of a second shape: every toggle reports
   * `aria-pressed`, none announces a popup, and none is disabled or inert —
   * including `left`, which is empty and hidden, the state #2143 gave a menu
   * trigger and #2143's narrowed-registry case gave an `aria-disabled`
   * button. Restoring either branch in `RegionToolbarControls.tsx` reds a
   * row here.
   */
  test('every toggle is a toggle: pressed state, no popup, nothing inert', () => {
    render(<RegionToolbarControls />);

    expect(
      [
        ...screen
          .getByRole('group', { name: 'Regions' })
          .querySelectorAll('button'),
      ].map((button) => [
        button.getAttribute('aria-label'),
        button.getAttribute('aria-pressed'),
        button.getAttribute('aria-haspopup'),
        button.getAttribute('aria-expanded'),
        button.getAttribute('aria-disabled'),
        button.hasAttribute('disabled'),
      ]),
    ).toEqual([
      ['Left region', 'false', null, null, null, false],
      ['Bottom region', 'true', null, null, null, false],
      ['Right region', 'false', null, null, null, false],
    ]);
  });

  /**
   * #2155 D5: the offer menu is retired, not hidden behind a condition. A
   * DOM assertion cannot see a branch nothing currently reaches — the #2143
   * inert button needed a narrowed registry to render at all — so the
   * retirement is pinned on the source.
   */
  test('the toolbar carries no offer menu and no inert region button', () => {
    for (const retired of [
      'RegionOfferMenu',
      'RegionToggleOffer',
      'aria-disabled',
      'nothing can be shown here',
    ])
      expect(
        toolbarCode,
        `${retired} is back in the region toolbar; #2155 retired it`,
      ).not.toContain(retired);
  });

  /**
   * #2153, settled by #2155: a visible empty region reads as ON — pressed
   * glyph — and now NAMES the act, because the press is a plain hide. The
   * empty region's tooltip says so where the pane list would be, so no state
   * of this control claims content it does not have. Reverting `visible` to
   * `held && state.visible` in the hook reds the pressed-class line.
   */
  test('a VISIBLE empty region reads as on, and its tooltip names the act and the emptiness', () => {
    const { rerender } = render(<RegionToolbarControls />);
    expect(regionToggle('Left').title).toBe('Show Left region (empty)');
    expect(regionToggle('Left').classList.contains('is-pressed')).toBe(false);
    // Hidden AND empty is the default state, not the holding one.
    expect(regionToggle('Left').classList.contains('is-holding')).toBe(false);

    harness.regions.left.visible = true;
    rerender(<RegionToolbarControls />);
    expect(regionToggle('Left').title).toBe('Hide Left region (empty)');
    expect(regionToggle('Left').classList.contains('is-pressed')).toBe(true);
    expect(regionToggle('Left').getAttribute('aria-pressed')).toBe('true');
    harness.regions.left.visible = false;
  });

  test('pressing an occupied region’s toggle hides it; pressing a hidden one shows it — the region, not a surface', () => {
    const { rerender } = render(<RegionToolbarControls />);

    fireEvent.click(regionToggle('Bottom'));
    expect(harness.setRegion).toHaveBeenCalledWith('bottom', {
      visible: false,
      maximized: false,
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
      maximized: false,
    });
    expect(harness.setRegion).toHaveBeenCalledTimes(2);
  });

  /**
   * A hidden region holding two panes is ONE unpressed toggle, and its press
   * writes the region's visibility and nothing about its panes — so both tabs
   * come back with the selection they had. The tooltip lists the panes in tab
   * order, so a reader knows what the toggle brings back before pressing it.
   *
   * #2155 D4 adds the third state to it. Hidden-and-holding is not
   * hidden-and-empty: the fixture puts both on screen at once (right holds
   * two panes, bottom holds none, both hidden), and `is-holding` is what
   * tells them apart — the class AND the glyph's outlined edge, from the one
   * fact. Deleting the `is-holding` branch reds the class assertion; deleting
   * the pane-list half of the tooltip reds the title.
   */
  test('a hidden region HOLDING panes is a third state, distinct from a hidden empty one', () => {
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
      ['Left region', 'false'],
      ['Bottom region', 'false'],
      ['Right region', 'false'],
    ]);
    const right = regionToggle('Right');
    const bottom = regionToggle('Bottom');
    expect(right.title).toBe('Show Right region: Activity, Chat');
    expect(bottom.title).toBe('Show Bottom region (empty)');
    // Same `aria-pressed`, different state: the class and the glyph carry
    // what "hidden" alone cannot say.
    expect(right.classList.contains('is-holding')).toBe(true);
    expect(right.classList.contains('is-pressed')).toBe(false);
    expect(bottom.classList.contains('is-holding')).toBe(false);
    // The edge rect is outlined for the holding region and unmarked for the
    // empty one; a filled edge is the visible state's.
    const edgeOf = (button: HTMLElement) =>
      [...button.querySelectorAll('rect')][1];
    expect(edgeOf(right)?.getAttribute('stroke')).toBe('currentColor');
    expect(edgeOf(right)?.getAttribute('fill')).toBe('none');
    expect(edgeOf(bottom)?.getAttribute('stroke')).toBe('none');
    expect(edgeOf(regionToggle('Left'))?.getAttribute('stroke')).toBe('none');

    fireEvent.click(right);
    expect(harness.setRegion).toHaveBeenCalledWith('right', {
      visible: true,
      maximized: false,
    });
    expect(harness.setRegion).toHaveBeenCalledTimes(1);
    expect(harness.placeSurface).not.toHaveBeenCalled();
  });

  /**
   * #2155 D2: the hold opens #2154's chooser — the same rows, the same panel,
   * anchored to the toggle — and it does NOT also toggle the region. The
   * suppression is the part with teeth: the browser turns the hold's release
   * into a click, so without swallowing it the gesture would open the panel
   * and hide the region under it. `setRegion` staying untouched is what
   * proves it.
   */
  test('a 500ms hold opens the chooser anchored to the toggle, and does not also toggle the region', async () => {
    render(<RegionToolbarControls />);

    const trigger = await holdToggle('Right');
    const panel = chooserPanel('Right');
    expect(panel.parentElement).toBe(document.body);
    expect(harness.setRegion).not.toHaveBeenCalled();
    expect(trigger.getAttribute('aria-pressed')).toBe('false');
    // The rows are #2154's, for the region the hold was on: every registry
    // surface declaring it, catalog entries included — which is exactly what
    // the retired offer menu could not list.
    expect(
      within(panel)
        .getAllByRole('menuitem')
        .map((row) => row.getAttribute('aria-labelledby') !== null),
    ).not.toHaveLength(0);
    expect(within(panel).getByRole('menuitem', { name: /^Chat/ })).toBeTruthy();

    fireEvent.click(within(panel).getByRole('menuitem', { name: /^Activity/ }));
    expect(harness.openSurfaceInRegion).toHaveBeenCalledWith('activity', {
      region: 'right',
    });
    // A choice closes the panel, and places through the model — not through
    // a second placement rule in the toolbar.
    expect(screen.queryByRole('menu')).toBeNull();
    expect(harness.placeSurface).not.toHaveBeenCalled();
    expect(harness.setRegion).not.toHaveBeenCalled();
  });

  /**
   * The boundary, from the other side: a press RELEASED before the threshold
   * is the ordinary toggle. Without it "the hold opens a panel" would be
   * consistent with "every press opens a panel", and the 500ms would be a
   * number nothing depends on.
   */
  test('a press released at 300ms toggles the region and opens nothing', async () => {
    render(<RegionToolbarControls />);

    await holdToggle('Right', 300);

    expect(screen.queryByRole('menu')).toBeNull();
    expect(harness.setRegion).toHaveBeenCalledWith('right', {
      visible: true,
      maximized: false,
    });
  });

  /**
   * The pointer-independent route to the same panel (#2155 D2): a right-click
   * — and the keyboard's context-menu key, which browsers deliver as the same
   * event with no pointer sequence at all. Prevented, so the control opens
   * its own chooser rather than the browser's menu, and it toggles nothing.
   */
  test('a contextmenu opens the same chooser, prevented, and toggles nothing', async () => {
    render(<RegionToolbarControls />);

    const trigger = regionToggle('Left');
    const contextMenu = createEvent.contextMenu(trigger);
    fireEvent(trigger, contextMenu);
    await settleChooserChunk();

    expect(contextMenu.defaultPrevented).toBe(true);
    expect(chooserPanel('Left')).toBeTruthy();
    expect(harness.setRegion).not.toHaveBeenCalled();

    // And the next ordinary press is NOT swallowed: the suppression belongs
    // to a completed hold, and a right-click produces no click to suppress.
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(regionToggle('Left'));
    expect(harness.setRegion).toHaveBeenCalledWith('left', {
      visible: true,
      maximized: false,
    });
  });

  /**
   * A press that WANDERS is not a hold. A finger resting on a 32px control
   * moves a little; a finger that has started scrolling has left.
   */
  test('a press that moves past the tolerance opens nothing and stays a toggle', async () => {
    render(<RegionToolbarControls />);

    const trigger = regionToggle('Right');
    fireEvent.pointerDown(trigger, { button: 0, clientX: 40, clientY: 10 });
    fireEvent.pointerMove(trigger, { clientX: 40, clientY: 60 });
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    fireEvent.pointerUp(trigger);
    fireEvent.click(trigger);
    await settleChooserChunk();

    expect(screen.queryByRole('menu')).toBeNull();
    expect(harness.setRegion).toHaveBeenCalledWith('right', {
      visible: true,
      maximized: false,
    });
  });

  /**
   * A gesture that ends in `pointercancel` — a touch the browser reclaims for
   * a scroll — is the case `click` alone never saw (#1386's shape, one layer
   * down): it produces no click either, so a timer left running would open a
   * panel after the user had moved on.
   */
  test('a press cancelled by the browser opens nothing at all', async () => {
    render(<RegionToolbarControls />);

    const trigger = regionToggle('Right');
    fireEvent.pointerDown(trigger, { button: 0, clientX: 40, clientY: 10 });
    fireEvent.pointerCancel(trigger);
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    await settleChooserChunk();

    expect(screen.queryByRole('menu')).toBeNull();
    expect(harness.setRegion).not.toHaveBeenCalled();
  });

  /**
   * The chooser carries #2154's dismiss contract, which the toolbar gets by
   * mounting that component rather than by reimplementing a panel here.
   */
  test('the chooser dismisses on Escape and on the backdrop, and returns focus', async () => {
    render(<RegionToolbarControls />);

    const trigger = await holdToggle('Right');
    expect(chooserPanel('Right')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    await holdToggle('Right');
    const backdrop = screen.getByRole('button', {
      name: 'Close the Add to Right region menu',
    });
    const pointerDown = createEvent.pointerDown(backdrop);
    fireEvent(backdrop, pointerDown);
    expect(pointerDown.defaultPrevented).toBe(true);
    expect(screen.queryByRole('menu')).not.toBeNull();
    fireEvent.click(backdrop);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(harness.openSurfaceInRegion).not.toHaveBeenCalled();
    expect(harness.setRegion).not.toHaveBeenCalled();
  });

  test('only one chooser is open at a time: holding another region’s replaces it', async () => {
    render(<RegionToolbarControls />);

    await holdToggle('Left');
    await holdToggle('Right');

    expect(screen.getAllByRole('menu')).toHaveLength(1);
    expect(chooserPanel('Right')).toBeTruthy();
  });

  /**
   * An OCCUPIED region gets the chooser too (#2154's "+" is offered for every
   * dock region, empty or not). The toolbar adds no emptiness rule of its
   * own: a region holding Chat can still be handed Activity from here, and
   * its toggle stays a toggle while the panel is open.
   */
  test('an occupied region’s toggle opens the chooser as well', async () => {
    render(<RegionToolbarControls />);

    const trigger = await holdToggle('Bottom');

    expect(chooserPanel('Bottom')).toBeTruthy();
    expect(trigger.getAttribute('aria-pressed')).toBe('true');
    expect(trigger.getAttribute('aria-haspopup')).toBeNull();
  });

  /**
   * The case that produced #2143's inert button: a region NO shell surface
   * declares. It had nothing to offer, so its control announced no popup and
   * went `aria-disabled` with the reason in its name. Since #2155 the button
   * does not offer anything in the first place — it shows and hides a region,
   * which is a thing that happens whatever the registry says — so this state
   * is an ordinary toggle, and pressing it opens the region on a chooser that
   * lists what there is.
   */
  test('an empty region nothing declares is still an ordinary toggle', () => {
    harness.surfaces = new Map(
      [...REGION_SURFACE_REGISTRY.entries()].map(([id, surface]) => [
        id,
        surface.regions.includes('left')
          ? { ...surface, regions: surface.regions.filter((r) => r !== 'left') }
          : surface,
      ]),
    );
    render(<RegionToolbarControls />);

    const left = regionToggle('Left');
    expect(left.getAttribute('aria-disabled')).toBeNull();
    expect(left.hasAttribute('disabled')).toBe(false);
    expect(left.getAttribute('aria-pressed')).toBe('false');
    expect(left.title).toBe('Show Left region (empty)');
    fireEvent.click(left);
    expect(harness.setRegion).toHaveBeenCalledWith('left', {
      visible: true,
      maximized: false,
    });
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

  test('a wide device gaining a coarse pointer closes the panel instead of re-anchoring it', async () => {
    const { rerender } = render(<RegionToolbarControls />);

    await holdToggle('Left');
    expect(screen.queryByRole('menu')).not.toBeNull();

    // A wide device can change its PRIMARY pointer to coarse without becoming
    // mobile — a touchscreen laptop, a tablet in a keyboard case. `bottomOnly`
    // flips while the overflow branch does not, so the toggles are replaced by
    // the folded control and the chooser would hang under a trigger that no
    // longer exists.
    harness.bottomOnly = true;
    harness.isMobile = false;
    rerender(<RegionToolbarControls />);

    // Neither the chooser it was showing nor the folded menu that now owns
    // the row: the flip closes, it does not re-render the state under a
    // different owner.
    expect(screen.queryByRole('menu')).toBeNull();
    expect(
      screen
        .getByRole('button', { name: 'Regions' })
        .getAttribute('aria-expanded'),
    ).toBe('false');
  });

  test('narrowing into the phone layout takes the whole control away and strands no open panel', async () => {
    const { container, rerender } = render(<RegionToolbarControls />);

    await holdToggle('Left');
    expect(screen.queryByRole('menu')).not.toBeNull();

    // `useDockSlotDevice` re-reads on resize, so the coarse branch can take
    // over with a panel already open and portalled. That portal lives on
    // `document.body`, so an unmount that forgot it would leave a menu
    // floating over the app with nothing left to dismiss it.
    harness.bottomOnly = true;
    harness.isMobile = true;
    rerender(<RegionToolbarControls />);

    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.body.querySelectorAll('button')).toHaveLength(0);
    expect(container.querySelector('fieldset')).toBeNull();

    // Going back the other way: the overflow branch returns before the panel
    // markup, so it unmounts the portal without closing it. If the state
    // survived, widening would re-open a panel the user never reopened and
    // `useMenuFocus` would pull focus into it.
    harness.bottomOnly = false;
    harness.isMobile = false;
    rerender(<RegionToolbarControls />);
    await settleChooserChunk();

    expect(screen.queryByRole('menu')).toBeNull();
    expect(regionToggle('Left').getAttribute('aria-pressed')).toBe('false');
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
