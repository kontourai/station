import { useUserQuery } from '@kontourai/station-sdk';
import {
  ResponsiveDialogCloseButton,
  ResponsiveDialogSurface,
} from '../ResponsiveDialogSurface';
import { SkeletonBlock } from '../state';

function getInitials(name: string): string {
  return (
    name
      .split(' ')
      .map((w) => w[0])
      .filter(Boolean)
      .slice(0, 2)
      .join('')
      .toUpperCase() || '?'
  );
}

export function UserDetailModal({
  alias,
  onClose,
}: {
  alias: string;
  onClose: () => void;
}) {
  const {
    data: person,
    isLoading: loading,
    error: queryError,
    refetch,
  } = useUserQuery(alias);
  const error = queryError?.message || null;

  const hasDetails =
    person &&
    (person.title ||
      person.team ||
      person.email ||
      person.manager ||
      person.location);
  const displayName =
    person?.name && person.name !== person.alias ? person.name : null;
  const initials = displayName
    ? getInitials(displayName)
    : alias[0]?.toUpperCase() || '?';

  return (
    <ResponsiveDialogSurface
      onClose={onClose}
      ariaLabel={`${displayName || alias} profile`}
      overlayClassName="user-detail-overlay"
      panelClassName="user-detail-modal"
    >
      {loading ? (
        <SkeletonBlock count={3} label="Loading profile" />
      ) : error ? (
        <>
          <div className="user-detail-hero">
            <div className="user-detail-avatar-wrap">
              <div className="user-detail-avatar">
                <span className="user-detail-avatar-initial">
                  {alias[0]?.toUpperCase() || '?'}
                </span>
              </div>
            </div>
            <div className="user-detail-hero-info">
              <div className="user-detail-name">{alias}</div>
              <div className="user-detail-subtitle user-detail-subtitle--warning">
                Could not load profile
              </div>
            </div>
            <ResponsiveDialogCloseButton
              onClick={onClose}
              label="Close user details"
            />
          </div>
          <div className="user-detail-error-body">
            <p>{error}</p>
            <button
              type="button"
              onClick={() => refetch()}
              className="user-detail-retry-btn"
            >
              Retry
            </button>
          </div>
        </>
      ) : person ? (
        <>
          <div className="user-detail-hero">
            <div className="user-detail-avatar-wrap">
              <div className="user-detail-avatar">
                {person.avatarUrl ? (
                  <img
                    src={person.avatarUrl}
                    alt={displayName || alias}
                    className="user-detail-avatar-img"
                  />
                ) : (
                  <span className="user-detail-avatar-initial">{initials}</span>
                )}
              </div>
              {person.badges?.length > 0 && (
                <span className="user-detail-badge-pill">
                  {person.badges[0]}
                </span>
              )}
            </div>
            <div className="user-detail-hero-info">
              <div className="user-detail-name">{displayName || alias}</div>
              {displayName && (
                <div className="user-detail-alias">{person.alias}</div>
              )}
              {person.title && (
                <div className="user-detail-subtitle">{person.title}</div>
              )}
            </div>
            <ResponsiveDialogCloseButton
              onClick={onClose}
              label="Close user details"
            />
          </div>

          {hasDetails ? (
            <div className="user-detail-body">
              {person.team && <Row label="Team" value={person.team} />}
              {person.location && (
                <Row label="Location" value={person.location} />
              )}
              {person.manager && (
                <div className="user-detail-row">
                  <span className="user-detail-label">Manager</span>
                  <span>{person.manager.name || person.manager.alias}</span>
                </div>
              )}
              {person.email && (
                <div className="user-detail-row">
                  <span className="user-detail-label">Email</span>
                  <a
                    href={`mailto:${person.email}`}
                    className="user-detail-link"
                  >
                    {person.email}
                  </a>
                </div>
              )}
              {person.tenure && <Row label="Tenure" value={person.tenure} />}
              {person.directReports != null && person.directReports > 0 && (
                <div className="user-detail-tags">
                  <span className="user-detail-tag">
                    {person.directReports} reports
                  </span>
                </div>
              )}
            </div>
          ) : (
            <div className="user-detail-empty">
              No additional details available. Install a user directory plugin
              for richer profiles.
            </div>
          )}

          {person.profileUrl && (
            <div className="user-detail-footer">
              <a
                href={person.profileUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="user-detail-link"
              >
                View Profile →
              </a>
            </div>
          )}
        </>
      ) : null}
    </ResponsiveDialogSurface>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="user-detail-row">
      <span className="user-detail-label">{label}</span>
      <span>{value}</span>
    </div>
  );
}
