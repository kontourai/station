import { useCallback, useEffect, useRef, useState } from 'react';
import { getPathForView, resolveViewFromPath } from '../../app-shell/routing';
import { useAuth } from '../../contexts/AuthContext';
import { useShortcutDisplay } from '../../hooks/useKeyboardShortcut';
import { getInitials } from '../../utils/layout';
import { requestHelpMenu } from '../header/helpMenuRequest';
import { LazyBoundary } from '../LazyBoundary';

/**
 * The account menu, deferred on the same grounds it was in the header: its
 * first statement is `if (!isOpen) return null`, so mounting it on open keeps
 * its markup and the access panel it carries out of the footer's chunk.
 */
const loadProfileMenu = () =>
  import('../header/ProfileMenu').then((module) => ({
    default: module.ProfileMenu,
  }));

interface SidebarAccountControlProps {
  activePath: string;
  collapsed: boolean;
  /** The footer's navigation: closes its popover and, on a phone, the drawer. */
  onNavigate: (path: string) => void;
  /** Closes the phone drawer for a row that opens something over the app. */
  onDismissDrawer?: () => void;
}

/**
 * The account control beside Live work in the sidebar footer. It is a
 * separate control from presence: Live work reads paired-device participants
 * and sessions, this opens the signed-in account's access, Profile, Help and
 * Settings. The header's `⋯` overflow keeps its Profile row as the phone
 * fallback while the drawer is closed.
 */
export function SidebarAccountControl({
  activePath,
  collapsed,
  onNavigate,
  onDismissDrawer,
}: SidebarAccountControlProps) {
  const { user } = useAuth();
  const userInitials = getInitials(user?.name || user?.alias || 'User');
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: The anchored menu closes when its route or the rail's presentation moves its trigger.
  useEffect(close, [collapsed, activePath, close]);
  const view = resolveViewFromPath(activePath);
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`sidebar__footer-action sidebar__account${
          view.type === 'profile' || open
            ? ' sidebar__footer-action--active'
            : ''
        }`}
        aria-label="Profile and settings"
        title="Profile and settings"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {userInitials}
      </button>
      {open && (
        <AccountMenu
          anchor={triggerRef.current}
          viewType={view.type}
          userInitials={userInitials}
          onClose={close}
          onNavigate={onNavigate}
          onDismissDrawer={onDismissDrawer}
        />
      )}
    </>
  );
}

/**
 * The open menu. Its own component so the chord registry is read only while
 * the menu is open, the way the menu's chunk is loaded only then.
 */
function AccountMenu({
  anchor,
  viewType,
  userInitials,
  onClose,
  onNavigate,
  onDismissDrawer,
}: {
  anchor: HTMLElement | null;
  viewType: string;
  userInitials: string;
  onClose: () => void;
  onNavigate: (path: string) => void;
  onDismissDrawer?: () => void;
}) {
  const settingsShortcut = useShortcutDisplay('app.settings');
  const profilePath = getPathForView({ type: 'profile' }) ?? '/profile';
  const settingsPath = getPathForView({ type: 'settings' }) ?? '/settings';
  return (
    <LazyBoundary
      load={loadProfileMenu}
      pending={null}
      componentProps={{
        isOpen: true,
        anchor,
        isProfileActive: viewType === 'profile',
        isSettingsActive: viewType === 'settings',
        settingsShortcut,
        userInitials,
        onClose,
        onOpenProfile: () => onNavigate(profilePath),
        onOpenHelp: () => {
          onDismissDrawer?.();
          requestHelpMenu();
        },
        onOpenSettings: () => onNavigate(settingsPath),
      }}
    />
  );
}
