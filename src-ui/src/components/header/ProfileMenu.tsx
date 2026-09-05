import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useMenuFocus } from '../../hooks/useMenuFocus';
import { QuestionGlyph, SettingsGlyph } from '../icons/Glyph';
import './HeaderMenu.css';

/**
 * The avatar's menu (#1552 D1).
 *
 * The toolbar's right side carried five controls — connection, notifications,
 * avatar, help, settings — three of which were unlabelled glyphs of different
 * weights, and two of which (help, settings) are things you reach for a handful
 * of times a day rather than continuously. The row is four now: Layout, the
 * status dot, Notifications, and this avatar; help and settings are rows here.
 *
 * The chords are untouched. `app.settings` is registered globally in `App.tsx`,
 * not by the control that used to render the gear, so ⌘, still toggles Settings
 * with this menu closed — which is why the row shows the chord in its tooltip
 * rather than implying the menu is the only route. Help has never had one.
 *
 * `role="menu"` with `menuitem` rows, so `useMenuFocus` gives it arrow-key
 * roving focus (that hook derives the behaviour from the role, deliberately —
 * see its own note); Escape and focus-return come from the same hook.
 */
export function ProfileMenu({
  isOpen,
  isProfileActive,
  isSettingsActive,
  settingsShortcut,
  userInitials,
  onClose,
  onOpenProfile,
  onOpenHelp,
  onToggleSettings,
}: {
  isOpen: boolean;
  isProfileActive: boolean;
  isSettingsActive: boolean;
  settingsShortcut: string;
  userInitials: string;
  onClose: () => void;
  onOpenProfile: () => void;
  onOpenHelp: () => void;
  onToggleSettings: () => void;
}) {
  const menuRef = useMenuFocus<HTMLDivElement>(isOpen, onClose);
  if (!isOpen) return null;

  const row = (
    key: string,
    label: string,
    glyph: ReactNode,
    onSelect: () => void,
    extra?: { title?: string; checked?: boolean },
  ) => (
    <button
      key={key}
      type="button"
      className="menu-row"
      role="menuitem"
      {...(extra?.title ? { title: extra.title } : {})}
      {...(extra?.checked ? { 'aria-current': 'page' as const } : {})}
      onClick={() => {
        onClose();
        onSelect();
      }}
    >
      <span className="menu-row__glyph" aria-hidden="true">
        {glyph}
      </span>
      {label}
    </button>
  );

  // Portalled for the same reason as every other header menu: the toolbar is a
  // stacking context at `--layer-navigation` on mobile and `.app-toolbar__actions`
  // holds its size, so a menu rendered inside it cannot appear over the fixed
  // chrome below.
  return createPortal(
    <>
      <button
        type="button"
        // A pointer convenience, not a tab stop — as a tab stop it sits
        // immediately before the menu in document order, so Shift+Tab off the
        // first row landed on it and `useMenuFocus`'s focusout closed the menu.
        tabIndex={-1}
        className="header-menu__dismiss-backdrop"
        aria-label="Close profile menu"
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 'calc(var(--layer-navigation) - 1)',
        }}
        onClick={onClose}
      />
      <div
        ref={menuRef}
        className="menu-surface app-toolbar__profile-menu"
        role="menu"
        aria-label="Profile and settings"
        tabIndex={-1}
      >
        {row(
          'profile',
          'Profile',
          <span className="app-toolbar__overflow-initials">
            {userInitials}
          </span>,
          onOpenProfile,
          { checked: isProfileActive },
        )}
        {row('help', 'Ask Station for help', <QuestionGlyph />, onOpenHelp)}
        {row(
          'settings',
          'Open settings',
          <SettingsGlyph />,
          onToggleSettings,
          // The chord in the tooltip, not in the label: the row is one route to
          // Settings and ⌘, is the other, and a keycap printed in a menu row
          // reads as part of the command's name.
          {
            title: `Open settings (${settingsShortcut})`,
            checked: isSettingsActive,
          },
        )}
      </div>
    </>,
    document.body,
  );
}
