/** @vitest-environment jsdom */

/**
 * The account menu (#1552 D1) — Profile, Help and Settings as rows, opened from
 * the sidebar footer's account control and anchored above it.
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
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * The breakpoint, flippable between renders. `useIsMobile` reads
 * `MOBILE_MEDIA_QUERY` — the same query the CSS rule that hides this menu's
 * trigger matches on — so driving the hook is driving the real condition.
 */
const harness = vi.hoisted(() => ({ isMobile: false }));

vi.mock('../../../hooks/useIsMobile', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../hooks/useIsMobile')>()),
  useIsMobile: () => harness.isMobile,
}));

vi.mock('../../../views/agent-editor/ToolLibraryContext', () => ({
  StationToolLibraryProvider: ({ children }: { children: ReactNode }) =>
    children,
  useToolLibraryClient: () => ({ apiBase: 'http://station.test' }),
}));
vi.mock('@kontourai/station-sdk/tool-library', () => ({
  useOwnToolAccess: () => ({
    data: { station: { operator: true, name: 'My Mac' } },
  }),
}));

import { ProfileMenu } from '../ProfileMenu';

/** The sidebar footer's trigger, at a known box near the viewport's bottom. */
function anchorAt(box: { left: number; top: number }): HTMLElement {
  const anchor = document.createElement('button');
  document.body.append(anchor);
  anchor.getBoundingClientRect = () =>
    ({
      left: box.left,
      top: box.top,
      right: box.left + 32,
      bottom: box.top + 32,
      width: 32,
      height: 32,
      x: box.left,
      y: box.top,
      toJSON: () => ({}),
    }) as DOMRect;
  return anchor;
}

function menuProps(overrides: Partial<Parameters<typeof ProfileMenu>[0]> = {}) {
  const handlers = {
    onClose: vi.fn(),
    onOpenProfile: vi.fn(),
    onOpenHelp: vi.fn(),
    onOpenSettings: vi.fn(),
  };
  return {
    handlers,
    props: {
      isOpen: true as boolean,
      isProfileActive: false,
      isSettingsActive: false,
      settingsShortcut: '⌘,',
      userInitials: 'ST',
      anchor: anchorAt({ left: 12, top: 700 }),
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
    expect(rows).toHaveLength(4);
    expect(rows).toEqual([
      screen.getByRole('menuitem', { name: 'My access' }),
      screen.getByRole('menuitem', { name: 'Profile' }),
      screen.getByRole('menuitem', { name: 'Ask Station for help' }),
      screen.getByRole('menuitem', { name: 'Open settings' }),
    ]);
    // The chip really is present and really is excluded — otherwise the line
    // above would pass for a row that simply never rendered it.
    expect(screen.getByRole('menuitem', { name: 'Profile' }).textContent).toBe(
      'STProfile',
    );
    expect(menu.parentElement).toBe(document.body);

    for (const [name, spy] of [
      ['Profile', handlers.onOpenProfile],
      ['Ask Station for help', handlers.onOpenHelp],
      ['Open settings', handlers.onOpenSettings],
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
   * The trigger is the sidebar footer's account control, so the menu opens
   * ABOVE it by its bottom edge — the access panel's rows arrive late and must
   * grow the menu upward, not past the viewport — and its left edge follows
   * the trigger, clamped inside the viewport.
   */
  test('anchors above its sidebar trigger and stays inside the viewport', () => {
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 800,
    });
    renderMenu({ anchor: anchorAt({ left: 12, top: 700 }) });

    const menu = screen.getByRole('menu', { name: 'Profile and settings' });
    expect(menu.style.bottom).toBe('108px');
    expect(menu.style.left).toBe('12px');
    expect(menu.style.top).toBe('auto');
    expect(menu.style.maxHeight).toBe('684px');
  });

  /**
   * A phone opens this menu from the drawer's footer, so opening at the
   * mobile breakpoint must keep it open; the header-era rule closed every
   * mobile render because the header's trigger was hidden there.
   */
  test('stays open when it was opened at the mobile breakpoint', () => {
    harness.isMobile = true;
    const { handlers, props } = menuProps();
    const { rerender } = render(<ProfileMenu {...props} />);
    rerender(<ProfileMenu {...props} />);

    expect(
      screen.getByRole('menu', { name: 'Profile and settings' }),
    ).toBeTruthy();
    expect(handlers.onClose).not.toHaveBeenCalled();
  });

  /**
   * #1552 review L4, kept for the footer's trigger: the panel is portalled to
   * `document.body`, and crossing the breakpoint moves its trigger between the
   * desktop rail and the phone drawer, so a resize with the menu open would
   * leave it floating over a trigger that moved or left the screen.
   *
   * Driven by RERENDERING across the flip, not by opening at a mobile width: a
   * resize is the case, and a mount-time-only check would pass while the live
   * transition still stranded the panel.
   */
  test('closes itself when the breakpoint changes under it', () => {
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
