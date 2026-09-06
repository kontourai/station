/** @vitest-environment jsdom */

/**
 * The avatar's menu (#1552 D1) — the header's Help and Settings controls, folded
 * into rows.
 *
 * The Escape case is here because it was a REAL defect, found by looking at a
 * screenshot rather than by any assertion: the component's own docblock claimed
 * "Escape and focus-return come from the same hook", and `useMenuFocus` supplies
 * focus return but dismisses on FOCUSOUT. Pressing Escape moves focus nowhere, so
 * the menu stayed open — visible in the capture that was meant to show the next
 * surface. A label nothing computes, written into the change that exists to
 * remove them.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * The breakpoint, flippable between renders. `useIsMobile` reads
 * `MOBILE_MEDIA_QUERY` — the same query the CSS rule that hides this menu's
 * trigger matches on — so driving the hook is driving the real condition.
 */
const harness = vi.hoisted(() => ({ isMobile: false }));

vi.mock('../../../hooks/useIsMobile', () => ({
  useIsMobile: () => harness.isMobile,
}));

import { ProfileMenu } from '../ProfileMenu';

function menuProps(overrides: Partial<Parameters<typeof ProfileMenu>[0]> = {}) {
  const handlers = {
    onClose: vi.fn(),
    onOpenProfile: vi.fn(),
    onOpenHelp: vi.fn(),
    onToggleSettings: vi.fn(),
  };
  return {
    handlers,
    props: {
      isOpen: true as boolean,
      isProfileActive: false,
      isSettingsActive: false,
      settingsShortcut: '⌘,',
      userInitials: 'ST',
      ...handlers,
      ...overrides,
    },
  };
}

function renderMenu(
  overrides: Partial<Parameters<typeof ProfileMenu>[0]> = {},
) {
  const { handlers, props } = menuProps(overrides);
  render(<ProfileMenu {...props} />);
  return handlers;
}

describe('ProfileMenu', () => {
  beforeEach(() => {
    harness.isMobile = false;
  });

  test('carries Profile, Help and Settings, and each row runs its own command', () => {
    const handlers = renderMenu();

    const menu = screen.getByRole('menu', { name: 'Profile and settings' });
    // Three rows, in order, each resolvable BY ITS ACCESSIBLE NAME — which is
    // what `getByRole(..., { name })` computes, unlike `textContent`. The
    // distinction is load-bearing for the first row: its glyph slot holds the
    // initials chip, whose "ST" is in the DOM and deliberately not in the name.
    const rows = screen.getAllByRole('menuitem');
    expect(rows).toHaveLength(3);
    expect(rows).toEqual([
      screen.getByRole('menuitem', { name: 'Profile' }),
      screen.getByRole('menuitem', { name: 'Ask Station for help' }),
      screen.getByRole('menuitem', { name: 'Open settings' }),
    ]);
    // The chip really is present and really is excluded — otherwise the line
    // above would pass for a row that simply never rendered it.
    expect(rows[0]?.textContent).toBe('STProfile');
    expect(menu.parentElement).toBe(document.body);

    for (const [name, spy] of [
      ['Profile', handlers.onOpenProfile],
      ['Ask Station for help', handlers.onOpenHelp],
      ['Open settings', handlers.onToggleSettings],
    ] as const) {
      fireEvent.click(screen.getByRole('menuitem', { name }));
      expect(spy, `${name} did not run its command`).toHaveBeenCalledTimes(1);
    }
    // Every row closes the menu on its way out — three rows, three closes.
    expect(handlers.onClose).toHaveBeenCalledTimes(3);
  });

  test('closes on Escape', () => {
    const handlers = renderMenu();

    // From a focused row, which is where focus lands on open — the case the
    // defect hid in, since a keypress with focus inside the menu never produces
    // the focusout `useMenuFocus` dismisses on.
    screen.getByRole('menuitem', { name: 'Profile' }).focus();
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(handlers.onClose).toHaveBeenCalledTimes(1);
  });

  test('the Settings row shows the chord in its tooltip, not in its name', () => {
    // The row is one route to Settings and ⌘, is the other. A keycap printed in
    // the label would read as part of the command's name and would also put the
    // chord in the accessible name, where WCAG 2.5.3 then binds it to visible
    // text that does not exist.
    renderMenu();

    const settings = screen.getByRole('menuitem', { name: 'Open settings' });
    expect(settings.getAttribute('title')).toBe('Open settings (⌘,)');
    expect(settings.textContent).toBe('Open settings');
  });

  test('every row reserves the shared glyph slot, so the labels align', () => {
    renderMenu();

    for (const row of screen.getAllByRole('menuitem')) {
      const slot = row.querySelector('.menu-row__glyph');
      expect(slot, `${row.textContent} has no glyph slot`).not.toBeNull();
      // Decorative: the row's own text is its name, and an initials chip or a
      // glyph beside it must not be read twice.
      expect(slot?.getAttribute('aria-hidden')).toBe('true');
      expect(row.className).toContain('menu-row');
    }
  });

  test('names the current view rather than styling it silently', () => {
    renderMenu({ isSettingsActive: true });

    expect(
      screen
        .getByRole('menuitem', { name: 'Open settings' })
        .getAttribute('aria-current'),
    ).toBe('page');
    expect(
      screen
        .getByRole('menuitem', { name: 'Profile' })
        .hasAttribute('aria-current'),
    ).toBe(false);
  });

  test('renders nothing while closed', () => {
    renderMenu({ isOpen: false });

    expect(screen.queryByRole('menu')).toBeNull();
  });

  /**
   * #1552 review L4. This panel is portalled to `document.body` while its
   * TRIGGER — the avatar — lives in `.app-toolbar__action--secondary`, which the
   * mobile query hides (archive#3311 demoted the profile into the `⋯` menu
   * there). Crossing the breakpoint with the menu open therefore left it
   * floating over the app with nothing on screen that could have opened it and
   * no trigger to return focus to.
   *
   * Driven by RERENDERING across the flip, not by opening at a mobile width: a
   * resize is the case, and a mount-time-only check would pass while the live
   * transition still stranded the panel.
   */
  test('closes itself when the breakpoint takes its trigger away', () => {
    const { handlers, props } = menuProps();
    const { rerender } = render(<ProfileMenu {...props} />);

    // Precondition: still open on a fine pointer, and closing has not fired for
    // some unrelated reason.
    expect(
      screen.getByRole('menu', { name: 'Profile and settings' }),
    ).toBeTruthy();
    expect(handlers.onClose).not.toHaveBeenCalled();

    // A rerender at the SAME breakpoint must not close it either — otherwise the
    // assertion below would pass for a menu that closes on every render.
    rerender(<ProfileMenu {...props} />);
    expect(handlers.onClose).not.toHaveBeenCalled();

    harness.isMobile = true;
    rerender(<ProfileMenu {...props} />);

    expect(handlers.onClose).toHaveBeenCalledTimes(1);
  });
});
