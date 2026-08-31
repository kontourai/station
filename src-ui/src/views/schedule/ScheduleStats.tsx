import { relTime } from '../../components/scheduler';
import { getScheduleStatusLabel, getScheduleStatusTone } from './utils';

export function ScheduleStats({
  daemonOk,
  jobsCount,
  lastTickAt,
  schedulerHealthy,
  statusError,
  successRate,
  totalRuns,
}: {
  daemonOk: boolean;
  jobsCount: number;
  lastTickAt?: string;
  schedulerHealthy: boolean;
  statusError: boolean;
  successRate: number;
  totalRuns: number;
}) {
  const tone = getScheduleStatusTone({
    statusError,
    daemonOk,
    schedulerHealthy,
  });
  const statusLabel = getScheduleStatusLabel({
    statusError,
    daemonOk,
    schedulerHealthy,
  });

  return (
    <div
      className="schedule__stats"
      role="status"
      aria-label="Scheduler statistics"
    >
      <div className={`stat-card stat-card--${tone}`}>
        <div className="stat-card__label">Scheduler</div>
        <div className={`stat-card__value stat-card__value--${tone}`}>
          {statusLabel}
        </div>
        {lastTickAt && (
          <div className="stat-card__hint">Last tick {relTime(lastTickAt)}</div>
        )}
      </div>
      <div className="stat-card stat-card--accent">
        <div className="stat-card__label">Jobs</div>
        <div className="stat-card__value">{jobsCount}</div>
      </div>
      <div className="stat-card stat-card--accent">
        <div className="stat-card__label">Success Rate</div>
        <div className="stat-card__value">
          {successRate >= 0 ? `${successRate}%` : '—'}
        </div>
      </div>
      <div className="stat-card stat-card--accent">
        <div className="stat-card__label">Total Runs</div>
        <div className="stat-card__value">
          {totalRuns >= 0 ? totalRuns : '—'}
        </div>
      </div>
    </div>
  );
}
