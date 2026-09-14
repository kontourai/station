/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

// The attention projection has its own tests; here it is a controllable value
// so these pin what the footer DOES with the count it is given. Same field
// and same registry badge the header bell reads.
const attentionState = vi.hoisted(() => ({ pendingCount: 0 }));
vi.mock('@kontourai/station-sdk', () => ({
  useAttentionQuery: () => ({
    data: { pendingCount: attentionState.pendingCount },
  }),
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
}));

// Mutable so one test can put the registry in the state it is in for the
// first tick after boot: `CommandPalette` registers `command-palette` from a
// lazily-loaded chunk, and `getDisplay` answers '' until it lands.
let paletteChord = 'Ctrl+K';
vi.mock('../hooks/useKeyboardShortcut', () => ({
  useShortcutDisplay: () => paletteChord,
}));

import { ProjectSidebarFooter } from '../components/project-sidebar/ProjectSidebarFooter';

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockImplementation(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
      media: '',
      onchange: null,
    })),
  });
});

function renderFooter(
  props: Partial<{
    activePath: string;
    navigate: (path: string) => void;
    isMobile: boolean;
    onAfterNavigate: () => void;
  }> = {},
) {
  return render(
    <ProjectSidebarFooter
      activePath={props.activePath ?? '/'}
      isMobile={props.isMobile ?? false}
      navigate={props.navigate ?? vi.fn()}
      onAfterNavigate={props.onAfterNavigate}
    />,
  );
}

describe('ProjectSidebarFooter', () => {
  beforeEach(() => {
    paletteChord = 'Ctrl+K';
    attentionState.pendingCount = 0;
  });

  // #2059 (design record D3): "Footer: presence, the attention bell, and the
  // gear." The bell and the gear are the panel's only entry points to
  // Notifications and Settings now that neither has a row.
  test('carries the presence placeholder, the palette chord, the bell and the gear', () => {
    const { container } = renderFooter();
    expect(container.querySelector('.sidebar__footer-presence')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Command palette' }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Notifications' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy();
  });

  // #2066 owns presence. Until it ships there is no presence authority to
  // read, so the placeholder must not report a count, a name or an online
  // mark — a footer that claims someone is here is worse than one that says
  // nothing. It is inert: not a button, not focusable, no handler.
  //
  // The name is the case the first cut got wrong. `role="img"` with
  // `aria-label="People here"` reads as a presence claim to a screen reader,
  // and an aria-label OVERRIDES the `title` that was meant to qualify it — so
  // the qualifier reached sighted users only. Nothing in this footer may
  // expose a name about presence until presence exists.
  test('the presence placeholder claims nothing about who is here, in any channel', () => {
    const { container } = renderFooter();
    const presence = container.querySelector<HTMLElement>(
      '.sidebar__footer-presence',
    );
    expect(presence).toBeTruthy();
    expect(presence!.tagName).toBe('SPAN');
    expect(presence!.textContent).toBe('');
    expect(presence!.getAttribute('tabindex')).toBeNull();
    // Hidden from the accessibility tree, so it has no name to get wrong.
    expect(presence!.getAttribute('aria-hidden')).toBe('true');
    expect(presence!.getAttribute('role')).toBeNull();
    expect(presence!.getAttribute('aria-label')).toBeNull();
    expect(presence!.getAttribute('title')).toBeNull();
    // And nothing else in the footer says it either: no element, of any role,
    // carries an accessible name about people or presence.
    for (const named of Array.from(
      container.querySelectorAll<HTMLElement>('[aria-label], [title]'),
    )) {
      const name = `${named.getAttribute('aria-label') ?? ''} ${
        named.getAttribute('title') ?? ''
      }`;
      expect(name).not.toMatch(/people|presence|here|online/i);
    }
  });

  test('the bell navigates to the notifications route', () => {
    const navigate = vi.fn();
    renderFooter({ navigate });
    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }));
    expect(navigate).toHaveBeenCalledWith('/notifications');
  });

  test('the gear navigates to the settings route', () => {
    const navigate = vi.fn();
    renderFooter({ navigate });
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(navigate).toHaveBeenCalledWith('/settings');
  });

  test('closes the mobile drawer after a footer navigation, and only on mobile', () => {
    const onAfterNavigate = vi.fn();
    const { unmount } = renderFooter({ isMobile: false, onAfterNavigate });
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(onAfterNavigate).not.toHaveBeenCalled();
    unmount();

    renderFooter({ isMobile: true, onAfterNavigate });
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(onAfterNavigate).toHaveBeenCalledTimes(1);
  });

  // The badge is the registry's projection of the attention count, not a
  // second derivation: the number and the phrase both come from
  // `destination-registry.ts`'s `badge`, which is what the header bell reads
  // from the same `['attention', apiBase]` cache entry.
  test('the bell carries the attention count in its accessible name and its badge', () => {
    attentionState.pendingCount = 3;
    renderFooter();
    const bell = screen.getByRole('button', {
      name: 'Notifications (3 need attention)',
    });
    expect(bell.textContent).toBe('3');
  });

  test('caps the visible badge at 9+ while the accessible name keeps the true count', () => {
    attentionState.pendingCount = 42;
    renderFooter();
    const bell = screen.getByRole('button', {
      name: 'Notifications (42 need attention)',
    });
    expect(bell.textContent).toBe('9+');
  });

  test('shows no badge at all when nothing needs attention', () => {
    attentionState.pendingCount = 0;
    renderFooter();
    const bell = screen.getByRole('button', { name: 'Notifications' });
    expect(bell.textContent).toBe('');
  });

  // Exactly one control may claim to be the current location, and it is
  // derived through the registry's view ownership rather than a path-prefix
  // comparison here (#1582 D4's rule, applied to the footer's two routed
  // controls).
  test.each([
    ['/notifications', 'Notifications', 'Settings'],
    ['/settings', 'Settings', 'Notifications'],
  ])('marks the %s control as the current page', (path, current, other) => {
    renderFooter({ activePath: path });
    expect(
      screen
        .getByRole('button', { name: current })
        .getAttribute('aria-current'),
    ).toBe('page');
    expect(
      screen.getByRole('button', { name: other }).getAttribute('aria-current'),
    ).toBeNull();
  });

  test('marks neither control on an unrelated route', () => {
    renderFooter({ activePath: '/agents' });
    expect(
      screen
        .getAllByRole('button')
        .filter((button) => button.getAttribute('aria-current') === 'page'),
    ).toHaveLength(0);
  });

  // #2059 product decision: the build identity left the footer. It is not
  // panel chrome — `ReportProblemDialog` stamps `buildLabel` into every
  // report, which is where the number is actually needed. The old
  // "renders the build identity with full detail in the tooltip" test went
  // with the element it described; what replaces it is the assertion that the
  // rail no longer carries a version at all.
  test('carries no build identity', () => {
    const { container } = renderFooter();
    expect(screen.queryByTestId('sidebar-build-version')).toBeNull();
    expect(container.textContent).not.toMatch(/v\d+\.\d+\.\d+/);
  });

  test('the palette chip shows the chord the registry reports (#1649)', () => {
    // It used to render a literal `⌘K`, which named a chord Windows and Linux
    // users cannot press and which would not have followed a rebinding from
    // Settings either. The stub is deliberately NOT the default chord: an
    // assertion of `Ctrl+K` here would pass on the static fallback too, and
    // prove nothing about which of the two the chip is reading.
    paletteChord = 'Ctrl+Shift+P';
    renderFooter();
    const chip = screen.getByRole('button', { name: 'Command palette' });
    expect(chip.textContent).toBe('Ctrl+Shift+P');
    expect(chip.textContent).not.toContain('⌘');
  });

  test('the palette chip still names a chord before the registry has one', () => {
    // The lazy-chunk window: `CommandPalette` registers `command-palette` from
    // a deferred chunk, so `getDisplay` answers '' for the first tick. An
    // empty chip would collapse the button to its padding. The fallback is
    // platform-derived, so it is never the Mac keycap on a non-Mac platform —
    // jsdom reports no Mac here, which is exactly the platform the bug was on.
    paletteChord = '';
    renderFooter();
    const chip = screen.getByRole('button', { name: 'Command palette' });
    expect(chip.textContent).toBe('Ctrl+K');
    expect(chip.textContent).not.toContain('⌘');
  });

  test('an unbound shortcut falls back rather than reading "Not set"', () => {
    paletteChord = 'Not set';
    renderFooter();
    expect(
      screen.getByRole('button', { name: 'Command palette' }).textContent,
    ).toBe('Ctrl+K');
  });

  test('the palette chip dispatches open-command-palette', () => {
    renderFooter();
    const listener = vi.fn();
    window.addEventListener('open-command-palette', listener);
    fireEvent.click(screen.getByRole('button', { name: 'Command palette' }));
    window.removeEventListener('open-command-palette', listener);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  // Keyboard operability of the panel's bottom controls, which the retired
  // status line's controls had. Every one is a real `button` element — which
  // is what carries Enter/Space activation and tab order — rather than a
  // clickable `div`, and none is removed from the tab order.
  test('every footer control is a focusable button in the tab order', () => {
    renderFooter();
    const buttons = screen.getAllByRole('button');
    expect(buttons.map((button) => button.tagName)).toEqual(
      buttons.map(() => 'BUTTON'),
    );
    expect(buttons.map((button) => button.getAttribute('type'))).toEqual(
      buttons.map(() => 'button'),
    );
    for (const button of buttons) {
      expect(button.getAttribute('tabindex')).toBeNull();
      expect(button.hasAttribute('disabled')).toBe(false);
      button.focus();
      expect(document.activeElement).toBe(button);
    }
  });
});
