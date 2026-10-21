import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useMenuFocus } from '../../hooks/useMenuFocus';
import { StationToolLibraryProvider } from '../../views/agent-editor/ToolLibraryContext';
import { QuestionGlyph, SettingsGlyph } from '../icons/Glyph';
import { MyAccessPanel } from '../profile/MyAccessPanel';
import './HeaderMenu.css';

/**
 * The account menu (#1552 D1), opened from the sidebar footer's account
 * control (`SidebarAccountControl`) since the header's far-right slot went to
 * the region glyphs.
 *
 * The chords are untouched. `app.settings` is registered globally in `App.tsx`,
 * not by any menu, so ⌘, still toggles Settings with this menu closed — which
 * is why the row shows the chord in its tooltip rather than implying the menu
 * is the only route. Help has never had one.
 *
 * `role="menu"` with `menuitem` rows, so `useMenuFocus` gives it arrow-key
 * roving focus (that hook derives the behaviour from the role, deliberately —
 * see its own note) plus focus entry and focus return.
 *
 * ESCAPE IS THIS COMPONENT'S OWN: `useMenuFocus` dismisses on FOCUSOUT, and
 * pressing Escape moves focus nowhere. `RegionToolbarControls` and
 * `ChatDockHeaderMoreMenu` each carry the same listener for the same reason.
 * Capturing, so a key pressed while focus sits on a row still reaches it.
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
  onOpenSettings,
  anchor,
}: {
  isOpen: boolean;
  isProfileActive: boolean;
  isSettingsActive: boolean;
  settingsShortcut: string;
  userInitials: string;
  onClose: () => void;
  onOpenProfile: () => void;
  onOpenHelp: () => void;
  onOpenSettings: () => void;
  /** The trigger the menu opens from, in the sidebar footer. */
  anchor: HTMLElement | null;
}) {
  const menuRef = useMenuFocus<HTMLDivElement>(isOpen, onClose);
  const [placement, setPlacement] = useState<CSSProperties>();
  /**
   * Anchored ABOVE the trigger by its bottom edge, so the access panel's late
   * rows grow the menu upward instead of past the viewport's bottom, and
   * clamped to the viewport's width. Re-placed on resize; the footer closes
   * the menu when the rail collapses or the route changes.
   */
  useLayoutEffect(() => {
    if (!isOpen || !anchor) return;
    const place = () => {
      const box = anchor.getBoundingClientRect();
      const width = menuRef.current?.offsetWidth ?? 0;
      const gap = 8;
      setPlacement({
        top: 'auto',
        right: 'auto',
        marginTop: 0,
        left: Math.max(
          gap,
          Math.min(box.left, window.innerWidth - width - gap),
        ),
        bottom: Math.max(gap, window.innerHeight - box.top + gap),
        maxHeight: Math.max(0, box.top - 2 * gap),
        overflowY: 'auto',
      });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [anchor, isOpen, menuRef]);
  /**
   * Close when the breakpoint changes under an open menu. The footer is the
   * desktop rail on one side and the phone drawer on the other, and this panel
   * is portalled to `document.body`, so a resize across the breakpoint would
   * leave it floating over a trigger that moved or left the screen.
   */
  const isMobile = useIsMobile();
  const openedMobile = useRef(isMobile);
  useEffect(() => {
    if (!isOpen) {
      openedMobile.current = isMobile;
      return;
    }
    if (openedMobile.current !== isMobile) onClose();
  }, [isOpen, isMobile, onClose]);
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Stopped so the same press does not also reach a surface behind this
      // menu — the shell has several document-level Escape handlers.
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [isOpen, onClose]);
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
        style={placement}
        role="menu"
        aria-label="Profile and settings"
        tabIndex={-1}
      >
        <StationToolLibraryProvider>
          <MyAccessPanel compact />
        </StationToolLibraryProvider>
        {row('access', 'My access', <SettingsGlyph />, onOpenProfile)}
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
          onOpenSettings,
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
