interface ProjectSidebarHeaderProps {
  appName: string;
  /** Exact local package identity for assistive technology and the tooltip. */
  homeLabel: string;
  /** Release-channel presentation is intentionally separate from the title. */
  channelBadge?: string;
  isMobile: boolean;
  onCloseMobile: () => void;
  onGoHome: () => void;
}

export function ProjectSidebarHeader({
  appName,
  homeLabel,
  channelBadge,
  isMobile,
  onCloseMobile,
  onGoHome,
}: ProjectSidebarHeaderProps) {
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
        <span className="sidebar__brand-name">
          <span>{appName}</span>
          {channelBadge && (
            <small className="sidebar__channel-badge">{channelBadge}</small>
          )}
        </span>
      </button>
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
