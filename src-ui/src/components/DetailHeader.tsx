/**
 * DetailHeader — Shared sticky header for detail panels and full-page views.
 * Enforces consistent hierarchy: identity left, contextual actions right.
 *
 * Heading level is owned by the skeleton, not by the calling view
 * (archive#2931, `docs/design/shell-skeletons.md` §2.1). Inside a
 * `SplitPaneLayout` detail slot the shell already renders the collection title
 * at page level, so this header's title is the ITEM title and renders one level
 * down; everywhere else it is the page's own subject and renders at page level.
 * A view cannot override this — that is the point.
 */
import { useSubjectHeadingLevel } from './detail-pane-context';
import './DetailHeader.css';

interface DetailHeaderProps {
  title: string;
  subtitle?: string;
  badge?: { label: string; variant?: 'success' | 'warning' | 'info' | 'muted' };
  statusDot?: 'connected' | 'disconnected';
  icon?: React.ReactNode;
  /** Inline identity/status content rendered beside the item title. */
  titleAccessory?: React.ReactNode;
  children?: React.ReactNode; // Action buttons go here
  /**
   * Mobile-only sticky action slot. DetailHeader owns detail chrome, so views
   * do not fork page-local sticky bars for the same editor interaction.
   */
  mobileFooter?: React.ReactNode;
}

export function DetailHeader({
  title,
  subtitle,
  badge,
  statusDot,
  icon,
  titleAccessory,
  children,
  mobileFooter,
}: DetailHeaderProps) {
  const Title = useSubjectHeadingLevel() === 'item' ? 'h3' : 'h2';
  return (
    <header className="detail-header">
      <div className="detail-header__left">
        {icon && <div className="detail-header__icon">{icon}</div>}
        <div className="detail-header__identity">
          <div className="detail-header__title-row">
            <Title className="detail-header__title">{title}</Title>
            {titleAccessory}
            {badge && (
              <span
                className={`detail-header__badge detail-header__badge--${badge.variant || 'muted'}`}
              >
                {badge.label}
              </span>
            )}
            {statusDot && (
              <span className={`status-dot status-dot--${statusDot}`} />
            )}
          </div>
          {subtitle && <p className="detail-header__subtitle">{subtitle}</p>}
        </div>
      </div>
      {children && <div className="detail-header__actions">{children}</div>}
      {mobileFooter && (
        <div className="detail-header__mobile-footer">{mobileFooter}</div>
      )}
    </header>
  );
}
