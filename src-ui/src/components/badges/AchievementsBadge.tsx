import { useAnalytics } from '../../contexts/AnalyticsContext';
import './AchievementsBadge.css';

export interface AchievementLink {
  label: string;
  href: string;
  icon?: string;
}

export function AchievementsBadge({
  compact = false,
  links = [],
}: {
  compact?: boolean;
  links?: AchievementLink[];
}) {
  const { achievements, loading } = useAnalytics();

  if (loading || !achievements?.length) return null;

  const unlockedCount = achievements.filter((a: any) => a.unlocked).length;
  const totalCount = achievements.length;

  if (compact) {
    return (
      <div className="achievements-compact">
        <span>🏆</span>
        <span>
          {unlockedCount}/{totalCount}
        </span>
      </div>
    );
  }

  return (
    <div className="achievements-panel">
      <div className="achievements-header">
        <h3 className="achievements-title">
          <span>🏆</span>
          <span>Achievements</span>
        </h3>
        <div className="achievements-header-actions">
          {links.map((link) => (
            <a
              key={link.href}
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              className="achievements-link"
            >
              {link.icon && (
                <img
                  src={link.icon}
                  alt=""
                  width={14}
                  height={14}
                  className="achievements-link-icon"
                />
              )}
              {link.label} ↗
            </a>
          ))}
          <div className="achievements-count">
            {unlockedCount}/{totalCount} unlocked
          </div>
        </div>
      </div>

      <div className="achievements-list">
        {achievements.map((achievement: any) => (
          <AchievementCard key={achievement.id} achievement={achievement} />
        ))}
      </div>
    </div>
  );
}

function AchievementCard({
  achievement,
}: {
  achievement: Record<string, any>;
}) {
  const progress =
    achievement.progressPercent !== undefined
      ? achievement.progressPercent / 100
      : achievement.threshold
        ? Math.min((achievement.progress || 0) / achievement.threshold, 1)
        : 0;

  const progressPercent = Math.round(progress * 100);

  /**
   * The fill ramp, on the same three tokens `.schedule__rate-fill--*` already
   * uses for its success-rate bar.
   *
   * This used to be four steps on `--accent-success` / `--accent-warning` /
   * `--accent-secondary` / `--accent-primary`, and only the last one existed
   * (station#1254). An undefined `var()` makes `background-color` invalid at
   * computed-value time, so the fill collapsed to `transparent`: every
   * achievement past 25% progress drew an **empty track**, at every width, in
   * both themes. Only the 0-25% step was ever visible.
   *
   * The 25% step is dropped rather than given a colour: there is no token
   * between brand and warning, and a fourth band carries no information the
   * bar's own width does not already show.
   */
  const getProgressColor = () => {
    if (progressPercent > 75) return 'var(--success-text)';
    if (progressPercent > 50) return 'var(--warning-text)';
    return 'var(--accent-primary)';
  };

  return (
    <div
      className={`achievement-card ${achievement.unlocked ? 'achievement-card-unlocked' : 'achievement-card-locked'}`}
    >
      <div
        className={`achievement-icon ${achievement.unlocked ? '' : 'achievement-icon-locked'}`}
      >
        {achievement.unlocked ? '🏆' : '🔒'}
      </div>

      <div className="achievement-content">
        <div className="achievement-header">
          <div className="achievement-name">{achievement.name}</div>
          {achievement.unlocked && (
            <div className="achievement-unlocked-badge">✓ UNLOCKED</div>
          )}
        </div>

        <div className="achievement-description">{achievement.description}</div>

        {!achievement.unlocked && achievement.threshold && (
          <div>
            <div className="achievement-progress-header">
              <span>Progress: {progressPercent}%</span>
              <span>
                {achievement.lowerIsBetter
                  ? `${achievement.progress <= achievement.threshold ? 'Under budget' : 'Over budget'}: $${achievement.progress?.toFixed(4)} / $${achievement.threshold.toFixed(4)}`
                  : `${achievement.progress?.toLocaleString()} / ${achievement.threshold.toLocaleString()}`}
              </span>
            </div>
            {achievement.precondition && (
              <div className="achievement-progress-header">
                <span>{achievement.precondition.label}</span>
                <span>
                  {achievement.precondition.current.toLocaleString()} /{' '}
                  {achievement.precondition.threshold.toLocaleString()}
                </span>
              </div>
            )}
            <div className="achievement-progress-bar">
              <div
                className="achievement-progress-fill"
                style={{
                  backgroundColor: getProgressColor(),
                  width: `${progressPercent}%`,
                }}
              />
            </div>
          </div>
        )}

        {achievement.unlocked && achievement.unlockedAt && (
          <div className="achievement-unlocked-date">
            <span>🎉</span>
            <span>
              Unlocked {new Date(achievement.unlockedAt).toLocaleDateString()}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
