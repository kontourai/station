import type {
  SchedulerJob,
  SchedulerRunOutcome,
} from '@kontourai/station-contracts/scheduler';
import { ActionOverflowMenu } from '../../components/ActionOverflowMenu';
import { WarningGlyph } from '../../components/icons/Glyph';
import { JobDetail, relTime } from '../../components/scheduler/JobDetail';
import { jobLabel } from '../../components/scheduler/jobName';
import {
  browserTimeZone,
  scheduleForJob,
} from '../../components/scheduler/scheduleValue';
import type { AgentData } from '../../contexts/AgentsContext';
import {
  automationFlag,
  automationStatus,
  hasFinished,
  lastOutcomeText,
  nextRunText,
  outcomesSummary,
  scheduleSentence,
} from './automationRow';
import './automations-list.css';

const OUTCOME_LABELS: Record<SchedulerRunOutcome, string> = {
  worked: 'Worked',
  failed: 'Failed',
  skipped: 'Skipped',
  unknown: 'Unknown',
};

/** Who runs it and where its results go, in the reader's words. */
function whoAndWhere(
  job: SchedulerJob,
  agents: readonly AgentData[],
  projectName: (id: string) => string | undefined,
): string {
  const slug = job.target?.kind === 'dedicated' ? job.target.agent : job.agent;
  const agent = slug ? agents.find((entry) => entry.slug === slug) : undefined;
  const where = job.projectId
    ? `a new task in ${projectName(job.projectId) ?? 'a project'}`
    : job.target?.kind === 'dedicated'
      ? 'its own chat'
      : job.target?.kind === 'conversation'
        ? 'a chat'
        : 'an output file';
  const line = [agent?.name ?? slug, agent?.engineDisplayName, where]
    .filter(Boolean)
    .join(' · ');
  return line.charAt(0).toUpperCase() + line.slice(1);
}

function OutcomeStrip({ job }: { job: SchedulerJob }) {
  const outcomes = job.recentOutcomes?.outcomes ?? [];
  const summary = outcomesSummary(job);
  if (outcomes.length === 0)
    return <span className="automations-row__no-runs">{summary}</span>;
  return (
    <span className="automations-strip" role="img" aria-label={summary}>
      {outcomes.map((outcome, index) => (
        <span
          // Position is the identity: the strip is a fixed window.
          key={index}
          className={`automations-strip__cell automations-strip__cell--${outcome}`}
          title={OUTCOME_LABELS[outcome]}
        />
      ))}
    </span>
  );
}

/** The legend for every strip on the page; Unknown only when one is shown. */
export function OutcomeLegend({ jobs }: { jobs: readonly SchedulerJob[] }) {
  const shown = new Set(
    jobs.flatMap((job) => job.recentOutcomes?.outcomes ?? []),
  );
  const entries = (['worked', 'failed', 'skipped', 'unknown'] as const).filter(
    (outcome) => outcome !== 'unknown' || shown.has(outcome),
  );
  return (
    <ul className="automations-legend" aria-label="Run outcomes">
      {entries.map((outcome) => (
        <li key={outcome} className="automations-legend__item">
          <span
            className={`automations-strip__cell automations-strip__cell--${outcome}`}
            aria-hidden="true"
          />
          {OUTCOME_LABELS[outcome]}
        </li>
      ))}
    </ul>
  );
}

/** The row's element id, so another part of the page can bring it into view. */
export function automationRowId(job: SchedulerJob): string {
  return `automation-row-${job.provider}-${job.name}`;
}

export interface AutomationRowActions {
  onRun: (job: SchedulerJob) => void;
  onPause: (job: SchedulerJob, running: boolean) => void;
  onResume: (job: SchedulerJob) => void;
  onEdit: (job: SchedulerJob) => void;
  onDuplicate: (job: SchedulerJob) => void;
  onDelete: (job: SchedulerJob) => void;
}

/** A pause, resume or delete whose request is in flight. */
export type PendingRowAction = Readonly<{
  name: string;
  action: 'pause' | 'resume' | 'delete';
}>;

const PENDING_WORDS: Record<PendingRowAction['action'], string> = {
  pause: 'Pausing…',
  resume: 'Resuming…',
  delete: 'Deleting…',
};

export function ScheduleAutomationList({
  jobs,
  agents,
  projectName,
  expanded,
  onExpand,
  autoOpenRun,
  isRunning,
  getMissedCount,
  runPendingJob,
  pendingAction,
  actions,
  now = Date.now(),
}: {
  jobs: readonly SchedulerJob[];
  agents: readonly AgentData[];
  projectName: (id: string) => string | undefined;
  expanded: string | null;
  onExpand: (key: string | null) => void;
  autoOpenRun: string | null;
  isRunning: (name: string) => boolean;
  getMissedCount: (name: string) => number;
  /** Name of the job whose Run request is in flight, if any. */
  runPendingJob?: string;
  pendingAction?: PendingRowAction;
  actions: AutomationRowActions;
  now?: number;
}) {
  const readerZone = browserTimeZone();
  return (
    <ul className="automations-list" aria-label="All automations">
      {jobs.map((job) => {
        const key = `${job.provider}:${job.name}`;
        const label = jobLabel(job);
        const open = expanded === key;
        const running = isRunning(job.name);
        const status = automationStatus(job, running, now);
        const finished = hasFinished(job, now);
        const pending =
          pendingAction?.name === job.name ? pendingAction.action : undefined;
        const flag = automationFlag(job);
        const missed = getMissedCount(job.name);
        const detailId = `automation-detail-${job.provider}-${job.name}`;
        const lastOutcome = lastOutcomeText(job);
        return (
          <li
            key={key}
            className="automations-row"
            id={automationRowId(job)}
            data-testid={`job-row-${job.name}`}
            aria-busy={pending ? true : undefined}
          >
            <div className="automations-row__main">
              <button
                type="button"
                className="automations-row__name"
                aria-expanded={open}
                aria-controls={open ? detailId : undefined}
                onClick={() => onExpand(open ? null : key)}
              >
                {label}
              </button>
              <p className="automations-row__who">
                <span>{whoAndWhere(job, agents, projectName)}</span>
                {flag && (
                  <span className="automations-row__flag">
                    <WarningGlyph /> {flag}
                  </span>
                )}
                {missed > 0 && (
                  <span className="automations-row__flag">
                    <WarningGlyph /> Missed {missed} while running
                  </span>
                )}
              </p>
            </div>
            <div className="automations-row__when">
              <span>{scheduleSentence(scheduleForJob(job), readerZone)}</span>
              <span className="automations-row__muted">
                {nextRunText(job, now)}
              </span>
            </div>
            <div className="automations-row__runs">
              <OutcomeStrip job={job} />
              {job.lastRun && (
                <span className="automations-row__muted automations-row__last-run">
                  Last run: {relTime(job.lastRun)}
                </span>
              )}
              {lastOutcome && (
                <span className="automations-row__muted automations-row__last-outcome">
                  {lastOutcome}
                </span>
              )}
            </div>
            <span
              className={`automations-row__status automations-row__status--${status.toLowerCase()}`}
            >
              <span
                className="automations-row__status-dot"
                aria-hidden="true"
              />
              {pending ? PENDING_WORDS[pending] : status}
            </span>
            <div className="automations-row__menu">
              <ActionOverflowMenu
                label={`Actions for ${label}`}
                actions={[
                  {
                    key: 'run',
                    label: 'Run now',
                    disabled:
                      running ||
                      runPendingJob === job.name ||
                      pending === 'delete',
                    onSelect: () => actions.onRun(job),
                  },
                  // A finished one-time automation has nothing to pause or
                  // resume: turning it on would not run it again.
                  ...(finished
                    ? []
                    : [
                        job.enabled
                          ? {
                              key: 'pause',
                              label: 'Pause',
                              disabled: Boolean(pending),
                              onSelect: () => actions.onPause(job, running),
                            }
                          : {
                              key: 'resume',
                              label: 'Resume',
                              disabled: Boolean(pending),
                              onSelect: () => actions.onResume(job),
                            },
                      ]),
                  {
                    key: 'edit',
                    label: 'Edit',
                    haspopup: 'dialog' as const,
                    onSelect: () => actions.onEdit(job),
                  },
                  {
                    key: 'duplicate',
                    label: 'Duplicate',
                    haspopup: 'dialog' as const,
                    onSelect: () => actions.onDuplicate(job),
                  },
                  {
                    key: 'delete',
                    label: 'Delete',
                    tone: 'danger' as const,
                    haspopup: 'dialog' as const,
                    disabled: Boolean(pending),
                    onSelect: () => actions.onDelete(job),
                  },
                ]}
              />
            </div>
            {open && (
              <div id={detailId} className="automations-row__detail">
                {job.prompt && (
                  <dl className="automations-row__instructions">
                    <dt>Instructions</dt>
                    <dd>{job.prompt}</dd>
                  </dl>
                )}
                <section aria-label={`Runs of ${label}`}>
                  <JobDetail
                    name={job.name}
                    providerId={job.provider}
                    autoOpenRun={autoOpenRun}
                  />
                </section>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
