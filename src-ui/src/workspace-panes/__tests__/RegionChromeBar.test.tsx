/** @vitest-environment jsdom */

/**
 * #2046 2b: the region bar — placement grab, tab strip, maximize, visibility
 * — built from a `DockShellChrome`. The #795/#800-adjacent rules the
 * controls carried in `ChatDockHeader` (collapse clears maximize, reopen
 * follows the shell's own snap, chords live in tooltips, extent and
 * visibility are named apart, the bar's own surface toggles) are pinned
 * here, against the bar that owns them now, plus the strip's own contract:
 * select, close, reorder, and when it does not render at all.
 */

import {
  createEvent,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { DockShellChrome } from '../../hooks/useDockShellChrome';
import { RegionChromeBar, type RegionChromeTab } from '../RegionChromeBar';

const SHORTCUT_DISPLAY: Record<string, string> = {
  'dock.toggle': '⌘D',
  'activity.toggle': '⌘⇧A',
  'dock.maximize': '⌃⌘M',
};
vi.mock('../../hooks/useKeyboardShortcut', () => ({
  useShortcutDisplay: (id: string) => SHORTCUT_DISPLAY[id] ?? '',
}));

const TABS: readonly RegionChromeTab[] = [
  { surfaceId: 'chat', instanceId: 'workspace-chat', title: 'Chat' },
  {
    surfaceId: 'activity',
    instanceId: 'workspace-activity',
    title: 'Activity',
  },
];

function chromeStub(overrides: Partial<DockShellChrome> = {}): DockShellChrome {
  const noop = () => {};
  return {
    isDockOpen: true,
    isDockMaximized: false,
    dockMode: 'bottom',
    dockHeight: 320,
    dockWidth: 400,
    setDockHeight: noop,
    setDockWidth: noop,
    previousDockHeight: 320,
    setPreviousDockHeight: noop,
    previousDockOpen: true,
    setPreviousDockOpen: noop,
    isDragging: false,
    setIsDragging: noop,
    dockSnap: 'half',
    liveDragHeight: null,
    setLiveDragHeight: noop,
    isCollapsedDragPreview: false,
    toolbarHeight: 46,
    collapsedHeight: 38,
    isMobile: false,
    visualViewport: { style: {}, height: 800, offsetTop: 0 } as never,
    availableDockSlotPlacements: ['left', 'bottom', 'right'],
    effectiveDockSlotPlacement: 'bottom',
    surfaceShortcutId: 'dock.toggle',
    surfaceTitle: 'Chat',
    canMaximize: true,
    regionPanes: [],
    selectRegionPane: noop,
    ownsMaximizeShortcut: true,
    applyDockSnap: vi.fn(),
    setRegionOpen: vi.fn(),
    commitDesktopBottomHeight: noop,
    commitDockPlacement: vi.fn(),
    restoreDockToDocked: noop,
    onSidePanelResizePointerDown: noop,
    onHeaderDragPointerDown: noop,
    onHeaderDragClickCapture: noop,
    activeProjectSlug: null,
    setActiveProjectSlug: noop,
    ...overrides,
  };
}

const handlers = {
  onSelectTab: vi.fn(),
  onCloseTab: vi.fn(),
  onReorderTab: vi.fn(),
  onMoveTab: vi.fn(),
};

function renderBar({
  chrome = chromeStub(),
  tabs = TABS,
  selected = 'chat',
  closable = true,
  movable = true,
  onAddPane,
  addPaneOpen,
}: {
  chrome?: DockShellChrome;
  tabs?: readonly RegionChromeTab[];
  selected?: string;
  closable?: boolean;
  movable?: boolean;
  onAddPane?: (trigger: HTMLButtonElement) => void;
  addPaneOpen?: boolean;
} = {}) {
  return render(
    <RegionChromeBar
      chrome={chrome}
      groupId="region:bottom"
      tabs={tabs}
      selectedSurfaceId={selected}
      onSelectTab={handlers.onSelectTab}
      onCloseTab={closable ? handlers.onCloseTab : undefined}
      onReorderTab={handlers.onReorderTab}
      onMoveTab={movable ? handlers.onMoveTab : undefined}
      onAddPane={onAddPane}
      addPaneOpen={addPaneOpen}
      leadingSlotRef={() => {}}
      trailingSlotRef={() => {}}
    />,
  );
}

// Every `<button>`, tabs included (`role="tab"` takes them out of a
// `getAllByRole('button')` query): the set is the bar's, in DOM order.
const controlNames = () =>
  Array.from(document.querySelectorAll('button')).map(
    (button) => button.getAttribute('aria-label') ?? button.textContent ?? '',
  );

beforeEach(() => {
  handlers.onSelectTab.mockClear();
  handlers.onCloseTab.mockClear();
  handlers.onReorderTab.mockClear();
  handlers.onMoveTab.mockClear();
});

afterEach(() => vi.restoreAllMocks());

describe('the region bar control set', () => {
  /**
   * The set the dock header used to pin (`ChatDockHeaderCollapse.test.tsx`,
   * #928 C2b), now the region's: the grab, the strip's tabs and their closes,
   * the two region controls. Chat's own "Chat settings" is the pane's and
   * renders into the bar's slot, which this harness leaves empty.
   */
  test('an open two-pane region offers exactly these controls, by accessible name', () => {
    renderBar();
    expect(controlNames()).toEqual([
      'Move the dock',
      'Chat',
      'Close Chat',
      'Activity',
      'Close Activity',
      'Move Chat',
      'Expand dock region to workspace',
      'Hide Chat',
    ]);
  });

  /**
   * #2047 D4: the "+" is the region's, in the actions cluster beside
   * maximize, and renders for a ONE-pane region (no strip) — the case the
   * acceptance starts from. Fine pointer only (D2), and only when the host
   * offers it (a model-less mount has nothing to place with). Since #2154 it
   * is a MENU TRIGGER: `aria-haspopup="menu"`, `aria-expanded` from the
   * host's `addPaneOpen`, and the callback receives the button so the
   * chooser can anchor to it. Reverting the `!chrome.isMobile` guard fails
   * the coarse assertion; dropping the prop's gate fails the "absent" one;
   * moving the button out of the cluster fails the ordered control-set pin;
   * dropping `aria-haspopup` or `aria-expanded` fails the popup assertions.
   */
  test('the "+" renders beside maximize for a one-pane region on a fine pointer as a menu trigger, and calls back with itself; not on a coarse device, not without a host offer', () => {
    const onAddPane = vi.fn();
    const one = renderBar({ tabs: [TABS[0]!], closable: false, onAddPane });
    expect(controlNames()).toEqual([
      'Move the dock',
      'Move Chat',
      'Add pane to Bottom',
      'Expand dock region to workspace',
      'Hide Chat',
    ]);
    const add = screen.getByLabelText('Add pane to Bottom');
    expect(add.getAttribute('aria-haspopup')).toBe('menu');
    expect(add.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(add);
    expect(onAddPane).toHaveBeenCalledTimes(1);
    expect(onAddPane).toHaveBeenCalledWith(add);
    expect(handlers.onSelectTab).not.toHaveBeenCalled();
    expect(add.title).toBe('Add pane to Bottom');
    one.unmount();

    const open = renderBar({
      tabs: [TABS[0]!],
      closable: false,
      onAddPane,
      addPaneOpen: true,
    });
    expect(
      screen.getByLabelText('Add pane to Bottom').getAttribute('aria-expanded'),
    ).toBe('true');
    open.unmount();

    const right = renderBar({
      chrome: chromeStub({ effectiveDockSlotPlacement: 'right' }),
      onAddPane,
    });
    expect(screen.getByLabelText('Add pane to Right')).toBeTruthy();
    right.unmount();

    const coarse = renderBar({
      chrome: chromeStub({ isMobile: true, surfaceTitle: 'Activity' }),
      selected: 'activity',
      onAddPane,
    });
    expect(screen.queryByLabelText(/^Add pane to /)).toBeNull();
    coarse.unmount();

    renderBar({ tabs: [TABS[0]!], closable: false });
    expect(screen.queryByLabelText(/^Add pane to /)).toBeNull();
  });

  /**
   * #2153: an EMPTY region's bar. It has no pane to be named after, so the
   * chrome names the region ("Right region", `useDockShellChrome`'s
   * `surfaceTitle`) and the chevron follows — "Hide Right region" open,
   * "Show Right region" collapsed. `canMaximize` is false for an empty
   * region, so the bar offers no maximize; there are no tabs, and the "+"
   * is the host's to offer (#2154 offers it for an empty region too; this
   * harness passes none), which leaves the grab and the chevron.
   *
   * Reverting `useDockShellChrome`'s `surfaceTitle` fallback to the bare
   * `'Chat'` puts "Hide Chat" on a region holding no Chat; this file feeds
   * the chrome directly, so the assertion that catches it is in
   * `DockShellControlParity.test.tsx`, which drives the real hook. What
   * this pins is that the bar RENDERS the name it is handed, for a pane set
   * that is empty.
   */
  test('an empty region’s bar is the grab and a chevron named for the region', () => {
    const emptyChrome = {
      surfaceTitle: 'Right region',
      canMaximize: false,
      effectiveDockSlotPlacement: 'right' as const,
    };
    const open = renderBar({
      chrome: chromeStub(emptyChrome),
      tabs: [],
      selected: undefined,
      closable: false,
      movable: false,
    });
    expect(controlNames()).toEqual(['Move the dock', 'Hide Right region']);
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByLabelText(/^Add pane to /)).toBeNull();
    open.unmount();

    renderBar({
      chrome: chromeStub({ ...emptyChrome, isDockOpen: false }),
      tabs: [],
      selected: undefined,
      closable: false,
      movable: false,
    });
    expect(screen.getByLabelText('Show Right region')).toBeTruthy();
  });

  /**
   * #2160: a LONE pane renders no strip, so it has no tab to right-click and
   * its only move was the ⋮⋮ grab — which moves the whole region and offers
   * dock edges only, never `main`. The bar's Move button opens the SAME
   * `RegionTabMoveMenu` for the pane the region shows, so Activity alone in a
   * region reaches Main directly.
   *
   * Deleting the button fails the ordered control-set pins above and the open
   * here; dropping `!chrome.isMobile` fails the coarse assertion; dropping the
   * `onMoveTab` gate fails the model-less one; dropping the
   * `moveTargets(...).length > 0` gate fails the nowhere-to-go one; and
   * reporting the wrong opener — `from: 'tab'` where the button sets the state
   * — fails the `aria-expanded` assertion.
   *
   * WHAT THE LAST ASSERTION DOES NOT PIN, measured rather than assumed:
   * restoring a SECOND, strip-local `moving` state beside the bar's (the
   * pre-#2160 shape, both menus rendered) still leaves one `role="menu"` here,
   * because `useMenuFocus` focuses the newly mounted menu and the one that
   * loses focus dismisses itself on `focusout`. So the count states the
   * user-visible outcome, not the single-state mechanism; `aria-expanded`,
   * which only one owner of the state can derive, is what carries that.
   */
  test('the bar’s Move button opens the same menu for the selected pane, including for a lone pane; absent on a coarse device, without a move handler, and with nowhere to go', () => {
    const lone = renderBar({
      chrome: chromeStub({ surfaceTitle: 'Activity' }),
      tabs: [TABS[1]!],
      selected: 'activity',
      closable: false,
    });
    expect(screen.queryByRole('tablist')).toBeNull();
    const button = () => screen.getByRole('button', { name: 'Move Activity' });
    expect(button().getAttribute('aria-haspopup')).toBe('menu');
    expect(button().getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(button());
    expect(button().getAttribute('aria-expanded')).toBe('true');
    const menu = screen.getByRole('menu', { name: 'Move Activity' });
    // The same derivation the tab's menu uses: Activity declares every
    // region, so from `bottom` it is offered the other two edges and Main.
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Move to Left', 'Move to Right', 'Move to Main']);
    fireEvent.click(
      within(menu).getByRole('menuitem', { name: 'Move to Main' }),
    );
    expect(handlers.onMoveTab).toHaveBeenCalledWith('activity', 'main');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(button().getAttribute('aria-expanded')).toBe('false');
    lone.unmount();

    const coarse = renderBar({
      chrome: chromeStub({ isMobile: true, surfaceTitle: 'Activity' }),
      tabs: [TABS[1]!],
      selected: 'activity',
      closable: false,
    });
    expect(screen.queryByRole('button', { name: 'Move Activity' })).toBeNull();
    coarse.unmount();

    const modelLess = renderBar({ movable: false });
    expect(screen.queryByRole('button', { name: 'Move Chat' })).toBeNull();
    modelLess.unmount();

    // Nowhere to go: a device with one dock edge, holding a pane that
    // declares no `main`. The button would name a menu with no rows.
    const alone = renderBar({
      chrome: chromeStub({
        availableDockSlotPlacements: ['bottom'],
        effectiveDockSlotPlacement: 'bottom',
      }),
      tabs: [TABS[0]!],
      closable: false,
    });
    expect(screen.queryByRole('button', { name: 'Move Chat' })).toBeNull();
    alone.unmount();

    // One menu at a time: the bar owns the state, so opening from the button
    // replaces the menu a tab opened rather than adding a second.
    renderBar();
    fireEvent.contextMenu(screen.getByRole('tab', { name: 'Activity' }));
    expect(screen.getByRole('menu', { name: 'Move Activity' })).toBeTruthy();
    // The tab opened it, so the button is not the expanded control.
    expect(
      screen
        .getByRole('button', { name: 'Move Chat' })
        .getAttribute('aria-expanded'),
    ).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Move Chat' }));
    expect(screen.getAllByRole('menu')).toHaveLength(1);
    expect(screen.getByRole('menu', { name: 'Move Chat' })).toBeTruthy();
  });

  /**
   * The menu acts on ONE pane and closes with it. Before #2160 it lived in the
   * strip and unmounted with the strip; at bar level it would outlive a pane
   * that ⌘D, a chord, a route or an agent took out of the region — the
   * backdrop absorbs pointer presses but only Escape is intercepted — and a
   * row would then re-place a pane no longer here. Deleting the
   * `movingIsStale` effect AND its render gate keeps the menu open below.
   */
  test('the move menu closes when its pane leaves the region', () => {
    const { rerender } = render(
      <RegionChromeBar
        chrome={chromeStub()}
        groupId="region:bottom"
        tabs={TABS}
        selectedSurfaceId="chat"
        onSelectTab={handlers.onSelectTab}
        onCloseTab={handlers.onCloseTab}
        onReorderTab={handlers.onReorderTab}
        onMoveTab={handlers.onMoveTab}
        leadingSlotRef={() => {}}
        trailingSlotRef={() => {}}
      />,
    );
    fireEvent.contextMenu(screen.getByRole('tab', { name: 'Chat' }));
    expect(screen.getByRole('menu', { name: 'Move Chat' })).toBeTruthy();

    // Chat leaves; Activity stays alone (no strip).
    rerender(
      <RegionChromeBar
        chrome={chromeStub({ surfaceTitle: 'Activity' })}
        groupId="region:bottom"
        tabs={[TABS[1]!]}
        selectedSurfaceId="activity"
        onSelectTab={handlers.onSelectTab}
        onCloseTab={undefined}
        onReorderTab={handlers.onReorderTab}
        onMoveTab={handlers.onMoveTab}
        leadingSlotRef={() => {}}
        trailingSlotRef={() => {}}
      />,
    );
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.queryByLabelText('Close move menu for Chat')).toBeNull();
    expect(handlers.onMoveTab).not.toHaveBeenCalled();
  });

  /**
   * `aria-expanded` is THIS button's: the bar opened the menu for Chat, then
   * the selection moved to Activity, so the button now names Activity and
   * must not claim the open menu that moves Chat. Reverting the derivation to
   * `moving?.from === 'bar'` reds the second assertion.
   */
  test('the bar button reports expanded only for the pane it names', () => {
    const { rerender } = render(
      <RegionChromeBar
        chrome={chromeStub()}
        groupId="region:bottom"
        tabs={TABS}
        selectedSurfaceId="chat"
        onSelectTab={handlers.onSelectTab}
        onCloseTab={handlers.onCloseTab}
        onReorderTab={handlers.onReorderTab}
        onMoveTab={handlers.onMoveTab}
        leadingSlotRef={() => {}}
        trailingSlotRef={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Move Chat' }));
    expect(
      screen
        .getByRole('button', { name: 'Move Chat' })
        .getAttribute('aria-expanded'),
    ).toBe('true');

    rerender(
      <RegionChromeBar
        chrome={chromeStub({ surfaceTitle: 'Activity' })}
        groupId="region:bottom"
        tabs={TABS}
        selectedSurfaceId="activity"
        onSelectTab={handlers.onSelectTab}
        onCloseTab={handlers.onCloseTab}
        onReorderTab={handlers.onReorderTab}
        onMoveTab={handlers.onMoveTab}
        leadingSlotRef={() => {}}
        trailingSlotRef={() => {}}
      />,
    );
    // The menu still moves Chat (its pane is still in the region)…
    expect(screen.getByRole('menu', { name: 'Move Chat' })).toBeTruthy();
    // …and the button, now Activity's, does not claim it.
    expect(
      screen
        .getByRole('button', { name: 'Move Activity' })
        .getAttribute('aria-expanded'),
    ).toBe('false');
  });

  test('the strip hides while the region is collapsed (D1), on a coarse device, and for one pane', () => {
    const { unmount } = renderBar({
      chrome: chromeStub({ isDockOpen: false }),
    });
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.getByLabelText('Show Chat')).toBeTruthy();
    unmount();

    const coarse = renderBar({
      chrome: chromeStub({ isMobile: true, surfaceTitle: 'Activity' }),
      selected: 'activity',
    });
    expect(screen.queryByRole('tablist')).toBeNull();
    // The bar itself still renders for a non-Chat pane on a coarse device:
    // its maximize and visibility are the pane's only dock controls there.
    expect(screen.getByLabelText('Hide Activity')).toBeTruthy();
    coarse.unmount();

    renderBar({ tabs: [TABS[0]!], closable: false });
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByLabelText(/^Close /)).toBeNull();
  });

  test('a coarse device showing Chat renders no bar: Chat’s mobile header is the bar there', () => {
    const { container } = renderBar({
      chrome: chromeStub({ isMobile: true }),
      selected: 'chat',
    });
    expect(container.querySelector('.chat-dock__header')).toBeNull();
  });

  test('the strip shows during a drag from collapsed, like the pane’s own controls', () => {
    renderBar({
      chrome: chromeStub({ isDockOpen: false, isCollapsedDragPreview: true }),
    });
    expect(screen.getByRole('tablist')).toBeTruthy();
  });
});

describe('the tab strip writes the model', () => {
  test('a tab click selects; the pressed tab is the selected pane', () => {
    renderBar({ selected: 'activity' });
    const strip = screen.getByRole('tablist', { name: 'Region panes' });
    expect(
      within(strip)
        .getAllByRole('tab')
        .map((tab) => tab.getAttribute('aria-selected')),
    ).toEqual(['false', 'true']);
    fireEvent.click(within(strip).getByRole('tab', { name: 'Chat' }));
    expect(handlers.onSelectTab).toHaveBeenCalledWith('chat');
    expect(handlers.onCloseTab).not.toHaveBeenCalled();
  });

  test('the selected tab controls the dock host’s panel by the shared group id; a tab behind it names no panel', () => {
    renderBar();
    const tab = screen.getByRole('tab', { name: 'Chat' });
    expect(tab.id).toBeTruthy();
    expect(tab.getAttribute('aria-controls')).toBeTruthy();
    expect(tab.getAttribute('aria-controls')).not.toBe(tab.id);
    // The dock host mounts one tabpanel — the selected pane's — so an
    // `aria-controls` on the other tab would point at nothing.
    expect(
      screen
        .getByRole('tab', { name: 'Activity' })
        .getAttribute('aria-controls'),
    ).toBeNull();
  });

  test('close closes that tab and nothing else', () => {
    renderBar();
    fireEvent.click(screen.getByLabelText('Close Activity'));
    expect(handlers.onCloseTab).toHaveBeenCalledWith('activity');
    expect(handlers.onSelectTab).not.toHaveBeenCalled();
  });

  test('the arrow keys select the neighbour; Alt+arrow reorders the focused tab', () => {
    renderBar();
    const chat = screen.getByRole('tab', { name: 'Chat' });
    fireEvent.keyDown(chat, { key: 'ArrowRight' });
    expect(handlers.onSelectTab).toHaveBeenLastCalledWith('activity');
    fireEvent.keyDown(chat, { key: 'ArrowLeft' });
    // Wraps, the tablist contract (`nextTabIndex`).
    expect(handlers.onSelectTab).toHaveBeenLastCalledWith('activity');
    expect(handlers.onReorderTab).not.toHaveBeenCalled();

    fireEvent.keyDown(chat, { key: 'ArrowRight', altKey: true });
    expect(handlers.onReorderTab).toHaveBeenCalledWith('chat', 1);
    // Off either end: nothing.
    fireEvent.keyDown(chat, { key: 'ArrowLeft', altKey: true });
    expect(handlers.onReorderTab).toHaveBeenCalledTimes(1);
  });

  test('dragging a tab over another reorders it as it passes', () => {
    renderBar();
    const chat = screen.getByRole('tab', { name: 'Chat' });
    const activity = screen.getByRole('tab', { name: 'Activity' });
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: () => activity,
    });
    fireEvent.pointerDown(chat, { button: 0, pointerId: 1 });
    fireEvent.pointerMove(chat, { pointerId: 1, clientX: 60, clientY: 10 });
    expect(handlers.onReorderTab).toHaveBeenCalledWith('chat', 1);
    fireEvent.pointerUp(chat, { pointerId: 1 });
    // After the release, a move is not a drag.
    fireEvent.pointerMove(chat, { pointerId: 1, clientX: 60, clientY: 10 });
    expect(handlers.onReorderTab).toHaveBeenCalledTimes(1);
  });

  /**
   * #2143: a tab's placement is the tab's own menu. The rows are the regions
   * this device can use plus `main`, minus the one the tab is in, filtered by
   * the model's `surfaceMayOccupy`: Chat declares no `main`, so its menu has
   * two rows; Activity declares every region, so its has three. Choosing a
   * row moves that ONE pane (the grab moves the region).
   */
  test('a tab’s context menu offers the regions the pane may move to, and a choice moves that pane', () => {
    renderBar();
    const chat = screen.getByRole('tab', { name: 'Chat' });
    fireEvent.contextMenu(chat, { clientX: 40, clientY: 12 });
    const menu = screen.getByRole('menu', { name: 'Move Chat' });
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Move to Left', 'Move to Right']);
    fireEvent.click(
      within(menu).getByRole('menuitem', { name: 'Move to Right' }),
    );
    expect(handlers.onMoveTab).toHaveBeenCalledWith('chat', 'right');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(handlers.onSelectTab).not.toHaveBeenCalled();
    expect(handlers.onReorderTab).not.toHaveBeenCalled();

    fireEvent.contextMenu(screen.getByRole('tab', { name: 'Activity' }));
    expect(
      within(screen.getByRole('menu', { name: 'Move Activity' }))
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Move to Left', 'Move to Right', 'Move to Main']);
  });

  test('the move menu dismisses on Escape and on its backdrop, and a model-less mount has none', () => {
    const { unmount } = renderBar();
    fireEvent.contextMenu(screen.getByRole('tab', { name: 'Chat' }));
    expect(screen.getByRole('menu', { name: 'Move Chat' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();

    // #1386: every end of a backdrop gesture dismisses, and the press alone
    // does not — the same contract as the toolbar's menus.
    const open = () => {
      fireEvent.contextMenu(screen.getByRole('tab', { name: 'Chat' }));
      return screen.getByLabelText('Close move menu for Chat');
    };
    let backdrop = open();
    const down = createEvent.pointerDown(backdrop);
    fireEvent(backdrop, down);
    expect(down.defaultPrevented).toBe(true);
    expect(screen.queryByRole('menu')).not.toBeNull();
    fireEvent.pointerCancel(backdrop);
    expect(screen.queryByRole('menu')).toBeNull();
    backdrop = open();
    // The right-click that OPENED the menu releases onto this backdrop:
    // Chromium fires `contextmenu` on the press, so the release arrives
    // with no press of its own. That release must not dismiss.
    fireEvent.pointerUp(backdrop);
    expect(screen.queryByRole('menu')).not.toBeNull();
    fireEvent(backdrop, createEvent.pointerDown(backdrop));
    fireEvent.pointerUp(backdrop);
    expect(screen.queryByRole('menu')).toBeNull();
    backdrop = open();
    fireEvent.click(backdrop);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(handlers.onMoveTab).not.toHaveBeenCalled();
    unmount();

    renderBar({ movable: false });
    const event = fireEvent.contextMenu(
      screen.getByRole('tab', { name: 'Chat' }),
    );
    // Not intercepted: the browser's own context menu is left alone.
    expect(event).toBe(true);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  /**
   * Under the tab, whatever the pointer said (the keyboard has none); pulled
   * back sideways at the right edge; and FLIPPED ABOVE the tab when there is
   * no room below — never slid up over it, which would put the panel on its
   * own trigger (#2112). Each branch is asserted against its own geometry so
   * deleting the clamp, or replacing the flip with a slide, reds here.
   */
  test('the move menu sits under its tab, is pulled back from the right edge, and flips above when there is no room below', () => {
    renderBar();
    const tab = screen.getByRole('tab', { name: 'Chat' });
    const viewport = { w: window.innerWidth, h: window.innerHeight };
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 800,
    });
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 600,
    });
    const tabBox = { left: 40, top: 0, bottom: 20, right: 100 };
    vi.spyOn(tab, 'getBoundingClientRect').mockReturnValue(tabBox as DOMRect);
    const measure = vi
      .spyOn(HTMLDivElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({ width: 160, height: 100 } as DOMRect);
    const open = () => {
      fireEvent.contextMenu(tab, { clientX: 300, clientY: 300 });
      const menu = screen.getByRole('menu', { name: 'Move Chat' });
      const at = [menu.style.left, menu.style.top];
      fireEvent.keyDown(document, { key: 'Escape' });
      return at;
    };
    try {
      expect(open()).toEqual(['40px', '24px']);

      // At the right edge: pulled back by the menu's own width.
      tabBox.left = 790;
      expect(open()).toEqual(['640px', '24px']);

      // Low in the viewport: 100px of menu will not fit under a tab whose
      // bottom is at 560, so it opens above the tab's top (540 - 4 - 100).
      tabBox.left = 40;
      tabBox.top = 540;
      tabBox.bottom = 560;
      expect(open()).toEqual(['40px', '436px']);
    } finally {
      measure.mockRestore();
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        value: viewport.w,
      });
      Object.defineProperty(window, 'innerHeight', {
        configurable: true,
        value: viewport.h,
      });
    }
  });
});

describe('the region controls (from ChatDockHeader, #795 / #1385)', () => {
  // `is-collapsed` and `is-maximized` are independent classes. Carrying the
  // maximized flag through a collapse left the dock at full height with an
  // emptied body — a blank full-screen shell that only Restore or a reload
  // recovered.
  /**
   * The chevron presses `setRegionOpen`, the chrome's own show/hide, rather
   * than a snap expression written here (#2155): the toolbar's toggle for the
   * same region presses the SAME derivation, so "hidden from the toolbar" and
   * "hidden from the chevron" cannot mean two different things. What that
   * derivation DOES with a snap — collapse clears `maximized`, and a reopen
   * follows the shell's own snap so a Full-height collapse comes back Full
   * (archive#795) while Chat's persisted Full can never maximize Activity
   * (#1385) — is the chrome's, tested against the real hook through both
   * controls in `RegionShellParity.test.tsx`. What is this bar's to prove is
   * that its chevron asks for the opposite of the current state, in both
   * directions, and asks for nothing else.
   */
  test('the chevron asks the chrome to flip the region, and decides no snap itself', () => {
    const open = chromeStub({ isDockMaximized: true });
    const { unmount } = renderBar({ chrome: open });
    fireEvent.click(screen.getByLabelText('Hide Chat'));
    expect(open.setRegionOpen).toHaveBeenCalledWith(false);
    expect(open.applyDockSnap).not.toHaveBeenCalled();
    unmount();

    const collapsed = chromeStub({ isDockOpen: false, dockSnap: 'full' });
    renderBar({ chrome: collapsed });
    fireEvent.click(screen.getByLabelText('Show Chat'));
    expect(collapsed.setRegionOpen).toHaveBeenCalledWith(true);
    expect(collapsed.applyDockSnap).not.toHaveBeenCalled();
  });

  test('routes explicit maximize and restore through the snap owner', () => {
    const chrome = chromeStub();
    const { unmount } = renderBar({ chrome });
    fireEvent.click(screen.getByLabelText('Expand dock region to workspace'));
    expect(chrome.applyDockSnap).toHaveBeenCalledWith('full');
    unmount();

    const maximized = chromeStub({ isDockMaximized: true });
    renderBar({ chrome: maximized });
    fireEvent.click(screen.getByLabelText('Restore dock region size'));
    expect(maximized.applyDockSnap).toHaveBeenLastCalledWith('half');
  });

  /**
   * #1536 F: the chords live in the controls' tooltips, with a real display
   * string so this cannot pass on an empty one. The maximize hint follows
   * ownership (#928 slice iii): a shell whose region does not hold Chat does
   * not advertise a chord that acts on Chat's region.
   */
  test('keeps the chords in tooltips, and the ⌘M hint only where the shell owns it', () => {
    const { unmount } = renderBar({
      chrome: chromeStub({ isDockMaximized: true }),
    });
    expect(screen.getByLabelText('Hide Chat').title).toBe('Hide Chat (⌘D)');
    expect(screen.getByLabelText('Restore dock region size').title).toBe(
      'Restore dock region size (⌃⌘M)',
    );
    expect(document.querySelector('.chat-dock__subtitle')).toBeNull();
    unmount();

    renderBar({
      chrome: chromeStub({
        ownsMaximizeShortcut: false,
        surfaceTitle: 'Activity',
        surfaceShortcutId: 'activity.toggle',
      }),
      selected: 'activity',
    });
    expect(screen.getByLabelText('Hide Activity').title).toBe(
      'Hide Activity (⌘⇧A)',
    );
    expect(screen.getByLabelText('Expand dock region to workspace').title).toBe(
      'Expand dock region to workspace',
    );
  });

  test('mirrors the collapse direction for a left-side region', () => {
    renderBar({
      chrome: chromeStub({ effectiveDockSlotPlacement: 'left' }),
    });
    expect(
      screen.getByLabelText('Hide Chat').querySelector('svg')?.classList,
    ).toContain('is-left-open');
  });

  test('names and depicts region extent separately from region visibility', () => {
    renderBar();
    const extent = screen.getByLabelText('Expand dock region to workspace');
    const visibility = screen.getByLabelText('Hide Chat');
    expect(extent.getAttribute('aria-label')).not.toBe(
      visibility.getAttribute('aria-label'),
    );
    expect(extent.querySelector('.chat-dock__extent-svg')).not.toBeNull();
    expect(visibility.querySelector('.chat-dock__chevron-svg')).not.toBeNull();
  });

  test('a shell that cannot maximize offers no extent control', () => {
    renderBar({ chrome: chromeStub({ canMaximize: false }) });
    expect(
      screen.queryByLabelText('Expand dock region to workspace'),
    ).toBeNull();
  });

  test('the placement grab moves the region through the chrome', () => {
    const chrome = chromeStub();
    renderBar({ chrome });
    fireEvent.click(screen.getByRole('button', { name: 'Move the dock' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Right' }));
    expect(chrome.commitDockPlacement).toHaveBeenCalledWith('right');
  });
});

describe('the bar’s own click surface', () => {
  /**
   * #1064: the bar toggles the region, but its interactive descendants — and
   * anything in the actions cluster, whose text sits beside controls — must
   * not. The tab strip is exempt too: a tab is a control. Native bubbling,
   * so content a pane portals into the bar's slots counts as the bar.
   */
  test('toggles from the bar’s non-interactive surface, not from its controls', () => {
    const chrome = chromeStub();
    const { container } = renderBar({ chrome });
    const bar = container.querySelector('.chat-dock__header') as HTMLElement;
    const text = document.createElement('span');
    text.textContent = 'Active conversation';
    bar.querySelector('.chat-dock__title')?.append(text);

    fireEvent.click(text);
    expect(chrome.applyDockSnap).toHaveBeenCalledTimes(1);
    expect(chrome.applyDockSnap).toHaveBeenCalledWith('collapsed');

    fireEvent.click(screen.getByRole('tab', { name: 'Activity' }));
    fireEvent.click(screen.getByLabelText('Close Activity'));
    const counter = document.createElement('span');
    counter.textContent = '2 sessions';
    bar.querySelector('.chat-dock__header-actions')?.append(counter);
    fireEvent.click(counter);
    expect(chrome.applyDockSnap).toHaveBeenCalledTimes(1);
  });

  test('a collapsed bar expands to Half from its surface', () => {
    const chrome = chromeStub({ isDockOpen: false });
    const { container } = renderBar({ chrome });
    fireEvent.click(container.querySelector('.chat-dock__title') as Element);
    expect(chrome.applyDockSnap).toHaveBeenCalledWith('half');
  });
});

describe('the bar is a header drag surface (the chrome pair)', () => {
  /**
   * The bar's bare surface now carries the chrome's one header drag gesture
   * (`onHeaderDragPointerDown` — the pair `ChatDockMobileHeader` wears), so a
   * non-chat dock's header resizes like chat's. What is THIS bar's to pin is
   * the wiring and its two bails: the gesture is offered only on the bar's
   * own bare surface, never where another gesture lives. The pointer
   * mechanics itself (capture, live height, snap/commit) is the shared
   * hook's, covered by `useChatDockVerticalDrag.test.tsx` and driven against
   * the real chrome in `DockShellControlParity.test.tsx`.
   */
  test('a bare-surface press forwards to the chrome gesture; a press on a control does not', () => {
    const onHeaderDragPointerDown = vi.fn();
    const chrome = chromeStub({ onHeaderDragPointerDown });
    const { container } = renderBar({ chrome });
    const bar = container.querySelector('.chat-dock__header') as HTMLElement;
    expect(bar.getAttribute('data-dock-drag-surface')).toBe('');

    const title = bar.querySelector('.chat-dock__title') as HTMLElement;
    fireEvent.pointerDown(title, { button: 0, pointerId: 1 });
    expect(onHeaderDragPointerDown).toHaveBeenCalledTimes(1);

    // Every control keeps its own gesture: tabs reorder, the grab moves the
    // region, the chevron and the action cluster click. The TOGGLE_EXEMPT set
    // is the bail, so a control added to the strip inherits the exemption.
    fireEvent.pointerDown(screen.getByRole('tab', { name: 'Activity' }), {
      button: 0,
      pointerId: 2,
    });
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Move the dock' }), {
      button: 0,
      pointerId: 3,
    });
    fireEvent.pointerDown(screen.getByLabelText('Hide Chat'), {
      button: 0,
      pointerId: 4,
    });
    fireEvent.pointerDown(screen.getByLabelText('Close Chat'), {
      button: 0,
      pointerId: 5,
    });
    expect(onHeaderDragPointerDown).toHaveBeenCalledTimes(1);
  });

  /**
   * The move menu is `createPortal(document.body)` INSIDE this bar's React
   * tree, so a press on it reaches the bar's React `onPointerDown` with a
   * target the bar's DOM does not contain. Starting the gesture there would
   * capture the pointer away from the menu — the #1638 shape — so the bail is
   * DOM containment, before the capture, and this pins the real portal the
   * bar itself renders.
   */
  test('a press inside content the bar portals out does not start the gesture', () => {
    const onHeaderDragPointerDown = vi.fn();
    const { container } = renderBar({
      chrome: chromeStub({ onHeaderDragPointerDown }),
    });
    const bar = container.querySelector('.chat-dock__header') as HTMLElement;
    fireEvent.contextMenu(screen.getByRole('tab', { name: 'Chat' }));
    const menu = screen.getByRole('menu', { name: 'Move Chat' });
    expect(
      bar.contains(menu),
      'the move menu stopped portaling out of the bar; the containment bail ' +
        'is no longer exercised and this test proves nothing',
    ).toBe(false);

    fireEvent.pointerDown(menu, { button: 0, pointerId: 6 });
    expect(onHeaderDragPointerDown).not.toHaveBeenCalled();
  });

  test('clicks cross the chrome click-capture seam that retires a drag’s click', () => {
    const onHeaderDragClickCapture = vi.fn();
    renderBar({ chrome: chromeStub({ onHeaderDragClickCapture }) });
    fireEvent.click(screen.getByRole('tab', { name: 'Chat' }));
    expect(onHeaderDragClickCapture).toHaveBeenCalledTimes(1);
  });
});
