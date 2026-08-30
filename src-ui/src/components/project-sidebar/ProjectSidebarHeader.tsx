interface ProjectSidebarHeaderProps {
  appName: string;
  /** Exact local package identity for assistive technology and the tooltip. */
  homeLabel: string;
  /** Release-channel presentation is intentionally separate from the title. */
  channelBadge?: string;
  collapsed: boolean;
  isMobile: boolean;
  onCloseMobile: () => void;
  onGoHome: () => void;
  onToggleCollapse: () => void;
}

export function ProjectSidebarHeader({
  appName,
  homeLabel,
  channelBadge,
  collapsed,
  isMobile,
  onCloseMobile,
  onGoHome,
  onToggleCollapse,
}: ProjectSidebarHeaderProps) {
  const collapseLabel = collapsed ? 'Expand sidebar' : 'Collapse sidebar';

  return (
    <div className="sidebar__header" data-tauri-drag-region>
      <button
        type="button"
        className="sidebar__home-button"
        aria-label={`${homeLabel} home`}
        title={`${homeLabel} home`}
        onClick={onGoHome}
      >
        <img
          src="/favicon.png"
          alt=""
          aria-hidden="true"
          className="sidebar__logo"
        />
        <span className="sidebar__brand-identity">
          <span className="sidebar__brand-name">{appName}</span>
          {channelBadge && (
            <span className="sidebar__channel-badge">{channelBadge}</span>
          )}
        </span>
      </button>
      {!isMobile && (
        <button
          type="button"
          className="sidebar__collapse-button"
          aria-label={collapseLabel}
          title={collapseLabel}
          onClick={(event) => {
            event.stopPropagation();
            onToggleCollapse();
          }}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d={collapsed ? 'm9 18 6-6-6-6' : 'm15 18-6-6 6-6'} />
          </svg>
        </button>
      )}
      {isMobile && (
        <button
          type="button"
          className="sidebar__mobile-close"
          aria-label="Close navigation"
          title="Close navigation"
          onClick={(event) => {
            event.stopPropagation();
            onCloseMobile();
          }}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      )}
    </div>
  );
}
