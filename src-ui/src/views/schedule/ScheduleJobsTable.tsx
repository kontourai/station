import type { SchedulerJob } from '@kontourai/station-contracts/scheduler';
import { Fragment } from 'react';
import { WarningGlyph } from '../../components/icons/Glyph';
import {
  cronToHuman,
  formatSchedule,
  JobDetail,
  localTime,
  RateCell,
  relTime,
} from '../../components/scheduler';
import {
  type HostPressureKind,
  hostPressureSubject,
} from '../../utils/resourcePosture';
import { SortHeader, TableFilter } from '../SortableTable';

const IconPlay = () => (
  <svg
    viewBox="0 0 16 16"
    fill="currentColor"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M4 2.5v11l9-5.5z" />
  </svg>
);

const IconX = () => (
  <svg
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M4 4l8 8M12 4l-8 8" />
  </svg>
);

const IconChevron = () => (
  <svg
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M6 4l4 4-4 4" />
  </svg>
);

const IconSpinner = () => (
  <svg
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M8 2a6 6 0 11-4.24 1.76" strokeLinecap="round" />
  </svg>
);

const IconEdit = () => (
  <svg
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M11.5 2.5l2 2-8 8H3.5v-2z" />
  </svg>
);

export function ScheduleJobsTable({
  autoOpenRun,
  daemonOk,
  hostPressure,
  expanded,
  filterText,
  getMissedCount,
  handleRun,
  isRunning,
  runPendingJob,
  onDelete,
  onDuplicate,
  onEdit,
  onExpand,
  onFilterChange,
  onToggle,
  sortDir,
  sortKey,
  sortedJobs,
  toggleSort,
}: {
  autoOpenRun: string | null;
  daemonOk: boolean;
  /** Present only while the host is deferring scheduled runs. */
  hostPressure?: HostPressureKind;
  expanded: string | null;
  filterText: string;
  getMissedCount: (name: string) => number;
  handleRun: (name: string) => void;
  isRunning: (name: string) => boolean;
  /** Name of the job whose Run request is in flight, if any. */
  runPendingJob?: string;
  onDelete: (job: SchedulerJob) => void;
  onDuplicate: (job: SchedulerJob) => void;
  onEdit: (job: SchedulerJob) => void;
  onExpand: (jobName: string | null) => void;
  onFilterChange: (value: string) => void;
  onToggle: (job: SchedulerJob, running: boolean) => void;
  sortDir: 'asc' | 'desc';
  sortKey: string;
  sortedJobs: Array<SchedulerJob & { successRate: number }>;
  toggleSort: (key: string) => void;
}) {
  const jobKey = (job: SchedulerJob) => `${job.provider}:${job.name}`;

  return (
    <div className="schedule__table-wrap">
      <div className="schedule__filter">
        <TableFilter
          value={filterText}
          onChange={onFilterChange}
          placeholder="Filter jobs…"
        />
      </div>
      <div className="schedule__table-scroll">
        <span className="schedule__mobile-hint">Swipe for more →</span>
        <table className="schedule__table" aria-label="Scheduled jobs">
          <thead>
            <tr>
              <SortHeader
                label="Name"
                sortKey="name"
                active={sortKey === 'name'}
                dir={sortDir}
                onClick={toggleSort}
              />
              <th className="sortable-table__th">Schedule</th>
              <th className="sortable-table__th">Status</th>
              <SortHeader
                label="Last Run"
                sortKey="lastRun"
                active={sortKey === 'lastRun'}
                dir={sortDir}
                onClick={toggleSort}
              />
              <SortHeader
                label="Next Fire"
                sortKey="nextRun"
                active={sortKey === 'nextRun'}
                dir={sortDir}
                onClick={toggleSort}
              />
              <SortHeader
                label="Success%"
                sortKey="successRate"
                active={sortKey === 'successRate'}
                dir={sortDir}
                onClick={toggleSort}
              />
              <th className="sortable-table__th">Actions</th>
            </tr>
          </thead>
          <tbody>
            {sortedJobs.map((job) => {
              const key = jobKey(job);
              const isExpanded = expanded === key;
              const running = isRunning(job.name);
              const missed = getMissedCount(job.name);
              const description =
                typeof job.description === 'string' ? job.description : '';
              const command =
                typeof job.command === 'string' ? job.command : '';
              const schedule = job.schedule ?? {
                kind: 'cron' as const,
                expr: job.cron || '* * * * *',
              };

              return (
                <Fragment key={key}>
                  <tr
                    data-testid={`job-row-${job.name}`}
                    className={`schedule__row ${isExpanded ? 'schedule__row--expanded' : ''}`}
                    aria-expanded={isExpanded}
                    onClick={() => onExpand(isExpanded ? null : key)}
                  >
                    <td className="schedule__td schedule__td--name">
                      <span
                        className={`schedule__chevron ${isExpanded ? 'schedule__chevron--open' : ''}`}
                      >
                        <IconChevron />
                      </span>
                      {job.name}
                      {job.monitor?.kind === 'github-pull-request' && (
                        <span
                          className="schedule__td--muted"
                          title={job.monitor.target}
                        >
                          {' '}
                          · monitor{' '}
                          {job.monitorState?.lastOutcome ?? 'not observed'}
                        </span>
                      )}
                      {missed > 0 && (
                        <span
                          className="schedule__missed-badge"
                          title={`${missed} scheduled run${missed > 1 ? 's' : ''} missed (job still running)`}
                        >
                          <WarningGlyph /> {missed} missed
                        </span>
                      )}
                    </td>
                    <td className="schedule__td schedule__td--schedule">
                      <div>{formatSchedule(schedule)}</div>
                      {schedule.kind === 'cron' && (
                        <div className="schedule__cron-human-inline">
                          {cronToHuman(
                            schedule.expr,
                            job.nextRun ? new Date(job.nextRun) : undefined,
                          ) || ''}
                        </div>
                      )}
                    </td>
                    <td
                      className="schedule__td"
                      onClick={(event) => {
                        event.stopPropagation();
                        onToggle(job, running);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          event.currentTarget.click();
                        }
                      }}
                    >
                      <span className="schedule__status schedule__status--clickable">
                        <span
                          className={`schedule__status-dot ${
                            running
                              ? 'schedule__status-dot--running'
                              : job.enabled
                                ? daemonOk
                                  ? 'schedule__status-dot--on'
                                  : 'schedule__status-dot--warn'
                                : 'schedule__status-dot--off'
                          }`}
                        />
                        {running
                          ? 'running'
                          : hostPressure && job.enabled
                            ? `paused — ${hostPressureSubject(hostPressure)}`
                            : job.enabled
                              ? 'on'
                              : 'off'}
                      </span>
                    </td>
                    <td className="schedule__td schedule__td--muted">
                      {relTime(job.lastRun ?? null)}
                    </td>
                    <td className="schedule__td schedule__td--muted">
                      {localTime(job.nextRun ?? null)}
                    </td>
                    <td className="schedule__td">
                      <RateCell rate={job.successRate} />
                    </td>
                    <td
                      className="schedule__td schedule__td--actions"
                      onClick={(event) => event.stopPropagation()}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          event.currentTarget.click();
                        }
                      }}
                    >
                      <div className="schedule__actions">
                        <button
                          type="button"
                          title="Edit"
                          aria-label={`Edit ${job.name}`}
                          onClick={() => onEdit(job)}
                          className="schedule__action-btn"
                        >
                          <IconEdit />
                        </button>
                        <button
                          type="button"
                          title="Duplicate"
                          aria-label={`Duplicate ${job.name}`}
                          onClick={() => onDuplicate(job)}
                          className="schedule__action-btn"
                        >
                          ⧉
                        </button>
                        <button
                          type="button"
                          title="Run now"
                          aria-label={`Run ${job.name}`}
                          data-testid={`run-${job.name}`}
                          disabled={running || runPendingJob === job.name}
                          onClick={() => handleRun(job.name)}
                          className="schedule__action-btn"
                        >
                          {running ? <IconSpinner /> : <IconPlay />}
                        </button>
                        <button
                          type="button"
                          title="Delete"
                          aria-label={`Delete ${job.name}`}
                          onClick={() => onDelete(job)}
                          className="schedule__action-btn schedule__action-btn--danger"
                        >
                          <IconX />
                        </button>
                      </div>
                    </td>
                  </tr>
                  {isExpanded && (
                    <tr
                      key={`${job.id}-detail`}
                      className="schedule__detail-row"
                    >
                      <td colSpan={7}>
                        <div className="schedule__detail">
                          <div className="schedule__detail-header">
                            <span>{job.name} — Run History</span>
                          </div>
                          {(description ||
                            job.prompt ||
                            command ||
                            job.agent) && (
                            <div className="schedule__detail-meta">
                              {description && (
                                <div className="schedule__detail-desc">
                                  {description}
                                </div>
                              )}
                              {job.agent && (
                                <div className="schedule__detail-field">
                                  <span className="schedule__detail-label">
                                    Agent
                                  </span>
                                  <span className="schedule__detail-value">
                                    {job.agent}
                                  </span>
                                </div>
                              )}
                              {job.prompt && (
                                <div className="schedule__detail-field">
                                  <span className="schedule__detail-label">
                                    Instructions
                                  </span>
                                  <span className="schedule__detail-value">
                                    {job.prompt}
                                  </span>
                                </div>
                              )}
                              {command && (
                                <div className="schedule__detail-field">
                                  <span className="schedule__detail-label">
                                    Command
                                  </span>
                                  <code className="schedule__detail-code">
                                    {command}
                                  </code>
                                </div>
                              )}
                            </div>
                          )}
                          <JobDetail
                            name={job.name}
                            providerId={job.provider}
                            autoOpenRun={expanded === key ? autoOpenRun : null}
                          />
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
