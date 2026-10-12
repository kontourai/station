import { useAgents } from '../../contexts/AgentsContext';
import { usePlatformProfile } from '../../platform/PlatformProfileContext';
import type { NavigationView } from '../../types';
import { activatable } from '../../utils/activatable';
import { MenuGlyph } from '../icons/Glyph';
import { HeaderActions } from './HeaderActions';
import { LayoutSwitcher } from './LayoutSwitcher';
import { RegionToolbarControls } from './RegionToolbarControls';
import { useHeaderViewModel } from './useHeaderViewModel';
import '../chat/chat.css';

interface HeaderProps {
  currentView?: NavigationView;
  onToggleSettings: () => void;
  onNavigate: (view: NavigationView) => void;
}

export function Header({
  currentView,
  onToggleSettings,
  onNavigate,
}: HeaderProps) {
  const agents = useAgents();
  const { productName: configuredProductName } = usePlatformProfile();
  const productName = configuredProductName ?? 'Station';
  const {
    breadcrumb,
    closeHelp,
    closeNotifications,
    closeOverflow,
    closeProfileMenu,
    goHome,
    handleHelpPrompt,
    helpPrompts,
    openConnectionModal,
    openProfile,
    settingsShortcut,
    showHelp,
    showNotifications,
    showOverflow,
    showProfileMenu,
    openHelp,
    openNotifications,
    toggleOverflow,
    toggleProfileMenu,
    userInitials,
  } = useHeaderViewModel({ currentView, agents, onNavigate });

  return (
    <header className="app-toolbar" data-tauri-drag-region>
      {/* Mobile: hamburger + logo (opens sidebar drawer) */}
      <button
        type="button"
        className="app-toolbar__sidebar-toggle"
        onClick={(event) =>
          window.dispatchEvent(
            new CustomEvent('toggle-sidebar', {
              detail: { trigger: event.currentTarget },
            }),
          )
        }
        aria-label="Toggle menu"
        aria-controls="mobile-navigation"
      >
        <MenuGlyph />
      </button>
      {/* The lockup owns the "full name or no name" rule: it is a one-line
          wrapping box, so a wordmark that cannot fit beside the logo wraps
          out of view as a whole instead of truncating to "S…". */}
      <div className="app-toolbar__lockup">
        {/* The LOGO is the home link: the one tab stop and the one link in the
            accessibility tree. The wordmark beside it is a visual repeat that
            wraps out of view when the row is too narrow to show it whole (see
            `.app-toolbar__lockup`), and a link that can vanish must not be the
            only one - it would leave an invisible tab stop. The global
            focus-visible rule rings the logo. */}
        <img
          src="/favicon.png"
          alt=""
          className="app-toolbar__logo"
          {...activatable(goHome, {
            role: 'link',
            label: `${productName} home`,
          })}
        />
        {/* Aria-hidden and click-only: a mouse convenience repeating the logo link. */}
        <span
          className="app-toolbar__brand"
          aria-hidden="true"
          onClick={goHome}
        >
          {productName}
        </span>
      </div>

      {/* Breadcrumb — always show where you are: project/layout for project
          views, the section name (clickable up to its root) for standalone
          views. */}
      {breadcrumb && (
        <div className="app-toolbar__breadcrumb">
          {breadcrumb.projectSlug ? (
            <>
              <span
                className="app-toolbar__breadcrumb-link"
                {...activatable(
                  () =>
                    onNavigate({
                      type: 'project',
                      slug: breadcrumb.projectSlug as string,
                    }),
                  { role: 'link' },
                )}
              >
                {breadcrumb.projectSlug}
              </span>
              {breadcrumb.layoutSlug && (
                <>
                  <span className="app-toolbar__breadcrumb-sep">/</span>
                  <LayoutSwitcher
                    projectSlug={breadcrumb.projectSlug}
                    layoutSlug={breadcrumb.layoutSlug}
                  />
                </>
              )}
            </>
          ) : breadcrumb.section ? (
            <span
              className="app-toolbar__breadcrumb-link"
              // Inert without a route behind it — no role, no tab stop. The
              // old handler was already a no-op in that case; this stops it
              // also being an empty promise to a keyboard user.
              {...activatable(
                breadcrumb.sectionRoot
                  ? () => onNavigate(breadcrumb.sectionRoot as NavigationView)
                  : undefined,
                { role: 'link' },
              )}
            >
              {breadcrumb.section}
            </span>
          ) : null}
        </div>
      )}

      <div className="app-toolbar__spacer" />

      <RegionToolbarControls />

      <HeaderActions
        currentViewType={currentView?.type}
        helpPrompts={helpPrompts}
        settingsShortcut={settingsShortcut}
        showHelp={showHelp}
        showNotifications={showNotifications}
        showOverflow={showOverflow}
        showProfileMenu={showProfileMenu}
        userInitials={userInitials}
        onCloseHelp={closeHelp}
        onCloseNotifications={closeNotifications}
        onCloseOverflow={closeOverflow}
        onCloseProfileMenu={closeProfileMenu}
        onHelpPrompt={handleHelpPrompt}
        onOpenConnections={openConnectionModal}
        onOpenProfile={openProfile}
        onOpenHelp={openHelp}
        onOpenNotifications={openNotifications}
        onToggleSettings={onToggleSettings}
        onToggleOverflow={toggleOverflow}
        onToggleProfileMenu={toggleProfileMenu}
        onViewAllNotifications={() => onNavigate({ type: 'notifications' })}
      />
    </header>
  );
}
