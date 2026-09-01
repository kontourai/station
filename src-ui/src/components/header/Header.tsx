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
    goHome,
    handleHelpPrompt,
    helpPrompts,
    openConnectionModal,
    openProfile,
    settingsShortcut,
    showHelp,
    showNotifications,
    showOverflow,
    toggleHelp,
    toggleNotifications,
    toggleOverflow,
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
      {/* The brand wordmark beside it is the real, labelled home link; this
          decorative img (alt="") is a mouse convenience for the same
          destination. Both are visible at the mobile breakpoint, so giving
          the logo its own role would put two consecutive identical tab stops
          in front of a keyboard user (review finding, PR #1277 round 2). */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: mouse convenience duplicating the adjacent labelled home link. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard path is the brand link beside it. */}
      <img
        src="/favicon.png"
        alt=""
        className="app-toolbar__logo"
        onClick={goHome}
      />
      <span
        className="app-toolbar__brand"
        {...activatable(goHome, {
          role: 'link',
          label: `${productName} home`,
        })}
      >
        {productName}
      </span>

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
        userInitials={userInitials}
        onCloseHelp={closeHelp}
        onCloseNotifications={closeNotifications}
        onCloseOverflow={closeOverflow}
        onHelpPrompt={handleHelpPrompt}
        onOpenConnections={openConnectionModal}
        onOpenProfile={openProfile}
        onToggleHelp={toggleHelp}
        onToggleNotifications={toggleNotifications}
        onToggleSettings={onToggleSettings}
        onToggleOverflow={toggleOverflow}
        onViewAllNotifications={() => onNavigate({ type: 'notifications' })}
      />
    </header>
  );
}
