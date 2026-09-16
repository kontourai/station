/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const setDockState = vi.fn();
const onNewChat = vi.fn();
const setShowChatSettings = vi.fn();
let isDockOpen = true;

vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({
    isDockOpen,
    isDockMaximized: false,
    setDockState,
    dockMode: 'bottom',
    pathname: '/',
  }),
}));

// A real chord string, not '': `withShortcutHint` returns the bare label for an
// empty display, so a stub of '' makes every tooltip assertion vacuous.
const SHORTCUT_DISPLAY: Record<string, string> = {
  'dock.toggle': '⌘D',
  'dock.maximize': '⌃⌘M',
};
vi.mock('../hooks/useKeyboardShortcut', () => ({
  useShortcutDisplay: (id: string) => SHORTCUT_DISPLAY[id] ?? '',
  useShortcutDisplayLookup: () => (id: string) => SHORTCUT_DISPLAY[id] ?? '',
}));

import {
  ChatDockHeader,
  type ChatDockWorkspaceControls,
} from '../components/chat-dock/ChatDockHeader';
import { RegionChromeSlotsContext } from '../workspace-panes/RegionChromeSlots';

/**
 * #2046 2b: the region's controls — placement grab, maximize, visibility
 * chevron, the click surface that collapses the bar — left this header for
 * the region bar (`RegionChromeBar`, pinned in `RegionChromeBar.test.tsx`
 * with the #795/#800/#1385 rules they carried). What this file still pins
 * is Chat's OWN toolbar: the collapsed "Start a chat" affordance (#800), the
 * folded Chat-settings command (#1536 F), the keycap-free bar, and the
 * control set the pane contributes — rendered inline (the full-screen
 * placement, or no region host) and into the region bar's slots (the dock).
 */
function renderHeader({
  fullscreen = false,
  chatIdentity,
  projectContext,
  workspaceControls,
}: {
  fullscreen?: boolean;
  chatIdentity?: ReactNode;
  projectContext?: ReactNode;
  workspaceControls?: ChatDockWorkspaceControls;
} = {}) {
  return render(
    <ChatDockHeader
      chatIdentity={chatIdentity}
      projectContext={projectContext}
      chatControls={{
        sessions: [],
        unreadCount: 0,
        focusSession: vi.fn(),
        onNewChat,
        setShowChatSettings,
      }}
      fullscreen={fullscreen}
      regionVisible={isDockOpen}
      workspaceControls={workspaceControls}
    />,
  );
}

// archive#800: this label read "Start a chat" and carried a pointer cursor, but was
// inert text — the click it appeared to offer only toggled the dock open (the
// header's own handler), leaving the user to hunt for "New".
describe('collapsed dock "Start a chat" affordance (#800)', () => {
  beforeEach(() => {
    setDockState.mockClear();
    onNewChat.mockClear();
    setShowChatSettings.mockClear();
    window.localStorage.clear();
    isDockOpen = true;
  });

  test('is a real control that starts a chat', () => {
    isDockOpen = false;
    renderHeader();

    const control = screen.getByRole('button', { name: 'Start a chat' });
    fireEvent.click(control);

    expect(onNewChat).toHaveBeenCalledTimes(1);
    // Starting a chat must not double as a dock toggle.
    expect(setDockState).not.toHaveBeenCalled();
  });

  // archive#800: the header renders unconditionally, so without an open-state
  // guard the dock-open-and-empty state showed two identical "Start a chat"
  // controls — the header's and the body's — and any role-based query would
  // resolve to both.
  test('yields to the body CTA once the dock is open', () => {
    isDockOpen = true;
    renderHeader();

    expect(screen.queryByRole('button', { name: 'Start a chat' })).toBeNull();
    expect(screen.getByText('Start a chat')).toBeTruthy();
  });

  test('Chat settings is still one press', () => {
    isDockOpen = false;
    renderHeader();

    // #1536 F: the unlabelled gear left the bar. The command did not — and with
    // no pane open Chat settings is the ONLY folded command, so it renders as
    // its own labelled button rather than behind a ⋯ that would open a list of
    // one (D2).
    expect(
      screen.queryByRole('button', { name: /^More dock actions/ }),
    ).toBeNull();
    const settings = screen.getByRole('button', { name: 'Chat settings' });
    expect(settings.textContent).toBe('Chat settings');
    fireEvent.click(settings);
    expect(setShowChatSettings).toHaveBeenCalledTimes(1);
  });

  /**
   * #1536 F: the bar carried two bare keycap spans — a ⌘D beside the settings
   * gear and a ⌘M inside Maximize — as visible chrome. Every other shortcut in
   * this bar lives in its control's tooltip, which is where these are now.
   */
  test('renders no bare keycap chrome', () => {
    const { container } = renderHeader();

    expect(container.querySelector('.chat-dock__toggle-shortcut')).toBeNull();
    // Every keycap in the bar, not just the one the retired span carried: the
    // activity dropdown's own ⌘1…⌘9 rows use this class too and are the only
    // remaining consumer, so an empty count here is only meaningful because the
    // dropdown is present but has no active sessions in this fixture.
    expect(
      container.querySelectorAll('.chat-dock__header .chat-dock__subtitle'),
    ).toHaveLength(0);
  });
});

/**
 * #928 C2b deleted the dock header's occupant picker; #1536 F folded the gear
 * and the pane commands into the More menu; #2046 2b moved the region's own
 * controls (the placement grab, maximize and the visibility chevron) out to
 * the region bar. This pins the control set the PANE still contributes, BY
 * ACCESSIBLE NAME, in order, so a header that loses (or gains, or renames) a
 * control reds here by name instead of shipping as a quiet chrome regression.
 *
 * Projected as aria-label OR text content, not aria-label alone: an
 * icon-only control is named by its label and a text control by its text, and
 * reading only the first scored the labelled text button as `''` — a set with a
 * hole in it still "matched" as long as the hole stayed the same size.
 */
describe('the Chat pane toolbar control set (#928 C2b, #2046 2b)', () => {
  beforeEach(() => {
    setDockState.mockClear();
    onNewChat.mockClear();
    setShowChatSettings.mockClear();
    isDockOpen = true;
  });

  const controlNames = (root: ParentNode = document) =>
    Array.from(root.querySelectorAll('button')).map(
      (button) => button.getAttribute('aria-label') ?? button.textContent ?? '',
    );

  test('an open dock pane offers exactly this control, by accessible name; the region controls are not its to offer', () => {
    renderHeader();
    expect(controlNames()).toEqual(['Chat settings']);
    expect(screen.queryByLabelText('Move the dock')).toBeNull();
    expect(screen.queryByLabelText(/dock region/)).toBeNull();
    expect(screen.queryByLabelText('Hide Chat')).toBeNull();
  });

  /**
   * Inside a region host the header renders no bar of its own: its two
   * clusters go INTO the region bar's slots. Reverting the portal (rendering
   * the inline bar under the region bar) fails the first assertion — a second
   * `.chat-dock__header` — and reverting the slot routing fails the second.
   */
  test('inside a region host it renders into the bar’s slots and no bar of its own', () => {
    const bar = document.createElement('div');
    bar.className = 'chat-dock__header';
    const leading = document.createElement('span');
    const trailing = document.createElement('span');
    bar.append(leading, trailing);
    document.body.append(bar);
    try {
      const { container } = render(
        <RegionChromeSlotsContext.Provider value={{ leading, trailing }}>
          <ChatDockHeader
            chatIdentity={<span>Active conversation</span>}
            chatControls={{
              sessions: [],
              unreadCount: 0,
              focusSession: vi.fn(),
              onNewChat,
              setShowChatSettings,
            }}
            regionVisible={false}
          />
        </RegionChromeSlotsContext.Provider>,
      );
      expect(container.querySelector('.chat-dock__header')).toBeNull();
      expect(leading.textContent).toContain('Active conversation');
      // With an identity on screen the collapsed CTA yields to it (#800's
      // guard), so the trailing slot holds the one folded command.
      expect(controlNames(trailing)).toEqual(['Chat settings']);
      // The full-screen placement has no region bar and keeps its own.
      render(
        <RegionChromeSlotsContext.Provider value={{ leading, trailing }}>
          <ChatDockHeader
            fullscreen
            chatControls={{
              sessions: [],
              unreadCount: 0,
              focusSession: vi.fn(),
              onNewChat,
              setShowChatSettings,
            }}
            regionVisible
          />
        </RegionChromeSlotsContext.Provider>,
      );
      expect(document.querySelectorAll('.chat-dock__header')).toHaveLength(2);
    } finally {
      bar.remove();
    }
  });

  /**
   * The open-pane half of this set — the ⋯ replacing that single command, plus
   * the pane's Open/New pair — lives in
   * `ChatDockHeaderWorkspaceControls.test.tsx`, whose harness already mocks what
   * the lazily loaded Open/New pair needs.
   */
});
