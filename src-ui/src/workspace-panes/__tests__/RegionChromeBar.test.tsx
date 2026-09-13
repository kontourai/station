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

import { fireEvent, render, screen, within } from '@testing-library/react';
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
    commitDesktopBottomHeight: noop,
    commitDockPlacement: vi.fn(),
    restoreDockToDocked: noop,
    onSidePanelResizePointerDown: noop,
    onMobileHeaderDragPointerDown: noop,
    onMobileHeaderDragClickCapture: noop,
    activeProjectSlug: null,
    setActiveProjectSlug: noop,
    ...overrides,
  };
}

const handlers = {
  onSelectTab: vi.fn(),
  onCloseTab: vi.fn(),
  onReorderTab: vi.fn(),
};

function renderBar({
  chrome = chromeStub(),
  tabs = TABS,
  selected = 'chat',
  closable = true,
}: {
  chrome?: DockShellChrome;
  tabs?: readonly RegionChromeTab[];
  selected?: string;
  closable?: boolean;
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
      'Expand dock region to workspace',
      'Hide Chat',
    ]);
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

  test('each tab controls the dock host’s panel by the shared group id', () => {
    renderBar();
    const tab = screen.getByRole('tab', { name: 'Activity' });
    expect(tab.id).toBeTruthy();
    expect(tab.getAttribute('aria-controls')).toBeTruthy();
    expect(tab.getAttribute('aria-controls')).not.toBe(tab.id);
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
});

describe('the region controls (from ChatDockHeader, #795 / #1385)', () => {
  // `is-collapsed` and `is-maximized` are independent classes. Carrying the
  // maximized flag through a collapse left the dock at full height with an
  // emptied body — a blank full-screen shell that only Restore or a reload
  // recovered.
  test('collapsing a maximized region clears the maximized flag', () => {
    const chrome = chromeStub({ isDockMaximized: true });
    renderBar({ chrome });
    fireEvent.click(screen.getByLabelText('Hide Chat'));
    expect(chrome.applyDockSnap).toHaveBeenCalledWith('collapsed');
  });

  test('expanding follows the shell’s own snap: Half, or Full when it collapsed from Full', () => {
    const half = chromeStub({ isDockOpen: false, dockSnap: 'half' });
    const { unmount } = renderBar({ chrome: half });
    fireEvent.click(screen.getByLabelText('Show Chat'));
    expect(half.applyDockSnap).toHaveBeenCalledWith('half');
    unmount();

    // archive#795: the reopened dock takes its height from the persisted snap
    // (the shell seeds `dockSnap` from Chat's key), so expanding after a
    // Full-height collapse comes back Full — with its extent control reading
    // Restore. #1385: a non-Chat shell reads ITS chrome's snap the same way,
    // so Chat's persisted Full can never maximize Activity.
    const full = chromeStub({
      isDockOpen: false,
      dockSnap: 'full',
      surfaceTitle: 'Activity',
      surfaceShortcutId: 'activity.toggle',
    });
    renderBar({ chrome: full, selected: 'activity' });
    fireEvent.click(screen.getByLabelText('Show Activity'));
    expect(full.applyDockSnap).toHaveBeenCalledWith('full');
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
