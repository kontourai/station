import { ConnectionStatusDot } from '@kontourai/station-connect';
import type { ComponentProps } from 'react';
import { createPortal } from 'react-dom';
import { useRegionModelOptional } from '../../contexts/RegionModelContext';
import { toastStore } from '../../contexts/ToastContext';
import { useMenuFocus } from '../../hooks/useMenuFocus';
import { nativePlatformPromise } from '../../platform/native';
import { usePlatformProfile } from '../../platform/PlatformProfileContext';
import './HeaderMenu.css';
import { useRegionSurfaceMenu } from './useRegionSurfaceMenu';

type ConnectionStatus = ComponentProps<typeof ConnectionStatusDot>['status'];

/**
 * #917: where the `⋯` button is rendered, the region commands live here rather
 * than in the toolbar row, whose width budget could not hold a 44px region
 * control and still keep the Settings gear on a 402px viewport. The hook, not
 * this component, decides which devices those are.
 *
 * Split into its own component so the hook that reads the region model is only
 * called where a `RegionModelProvider` is known to be above it — the overflow
 * menu itself is rendered in tests and stories without one.
 *
 * Toggle buttons, not `menuitemcheckbox`: that role must be owned by a `menu`,
 * and this container has never been one — its other rows are plain buttons. The
 * toolbar's own region menu IS a `role="menu"` and keeps `menuitemcheckbox`
 * there. `aria-pressed` carries the same state without claiming a menu
 * structure that does not exist. The `fieldset`/clipped `legend` names the
 * section.
 */
function RegionMenuSection({ onClose }: { onClose: () => void }) {
  const { commandsInOverflowMenu, menuItems } = useRegionSurfaceMenu();
  if (!commandsInOverflowMenu) return null;
  return (
    <fieldset className="app-toolbar__overflow-regions">
      <legend>Regions</legend>
      {menuItems.map((item) => (
        <button
          key={item.key}
          type="button"
          aria-pressed={item.checked}
          onClick={() => {
            onClose();
            item.onSelect();
          }}
        >
          {item.label}
        </button>
      ))}
    </fieldset>
  );
}

interface OverflowMenuProps {
  isOpen: boolean;
  connStatus: ConnectionStatus;
  userInitials: string;
  onClose: () => void;
  onOpenConnections: () => void;
  onOpenDesktopTrayMenu?: () => void | Promise<void>;
  onOpenHelp: () => void;
  onOpenProfile: () => void;
}

export function OverflowMenu({
  isOpen,
  connStatus,
  userInitials,
  onClose,
  onOpenConnections,
  onOpenDesktopTrayMenu,
  onOpenHelp,
  onOpenProfile,
}: OverflowMenuProps) {
  const menuRef = useMenuFocus<HTMLDivElement>(isOpen, onClose);
  const { isDesktop } = usePlatformProfile();
  const hasRegionModel = useRegionModelOptional() !== null;
  if (!isOpen) return null;
  const openDesktopTrayMenu =
    onOpenDesktopTrayMenu ??
    (isDesktop
      ? async () => {
          const native = await nativePlatformPromise;
          const result = await native.openDesktopTrayMenu();
          if (result.status !== 'ok') {
            toastStore.show(
              result.status === 'unsupported' ? result.reason : result.message,
            );
          }
        }
      : undefined);

  // Portalled to the document: the toolbar is `position: sticky; z-index: 200`
  // on mobile, which makes it a stacking context, so a descendant cannot
  // outrank the fixed coding tabs (202) or dock (201) no matter how high its
  // z-index. `.app-toolbar__actions` also sets `overflow: hidden`, which clips
  // the dropdown outright. Escaping both is why this cannot live in the header.
  return createPortal(
    <>
      <button
        type="button"
        className="header-menu__dismiss-backdrop"
        aria-label="Close more actions menu"
        style={{
          position: 'fixed',
          inset: 0,
          // One below the menu's own layer (`--layer-navigation`, set on
          // `.app-toolbar__overflow-menu`): the backdrop must beat the fixed
          // mobile chrome — the dock, the toolbar, and the notice band above
          // them (archive#3766) — to catch outside taps, but stay under its
          // own menu or it swallows the menu's clicks. Derived from the same
          // token as the menu so raising one cannot silently strand the other.
          zIndex: 'calc(var(--layer-navigation) - 1)',
        }}
        onClick={onClose}
      />
      <div ref={menuRef} className="app-toolbar__overflow-menu" tabIndex={-1}>
        <button
          type="button"
          aria-label="Connections"
          onClick={() => {
            onClose();
            onOpenConnections();
          }}
        >
          <ConnectionStatusDot status={connStatus} size={7} />
          Connections
        </button>
        {openDesktopTrayMenu && (
          <button
            type="button"
            onClick={() => {
              onClose();
              void openDesktopTrayMenu();
            }}
          >
            <svg
              aria-hidden="true"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="4" y="4" width="16" height="13" rx="2" />
              <path d="M9 21h6M12 17v4" />
            </svg>
            Open desktop tray
          </button>
        )}
        {/* archive#3311: on mobile the profile lives here rather than in the
            toolbar, whose slot the connection status chip now occupies. LAST,
            not first: it is the demoted item, and this menu is painted at
            --layer-popover, below the banner host's --layer-notice — the
            banner's own action buttons keep `pointer-events: auto`, so any row
            pushed down into their band stops being clickable. Putting Profile
            above Connections did exactly that to Connections on a phone with a
            reconnect banner up. */}
        <button
          type="button"
          aria-label="Profile"
          onClick={() => {
            onClose();
            onOpenProfile();
          }}
        >
          <span className="app-toolbar__overflow-initials" aria-hidden="true">
            {userInitials}
          </span>
          Profile
        </button>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onClose();
            onOpenHelp();
          }}
        >
          <svg
            aria-hidden="true"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          Help
        </button>
        {/* Appended, not prepended: every row above keeps the position the
            banner-overlap note describes, and the region rows are the ones a
            phone user reaches for repeatedly, so they sit closest to the
            thumb. */}
        {hasRegionModel && <RegionMenuSection onClose={onClose} />}
      </div>
    </>,
    document.body,
  );
}
