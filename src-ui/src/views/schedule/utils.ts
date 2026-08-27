import type { SchedulerJob } from '@kontourai/station-contracts/scheduler';
import { SchedulerResponseError } from '@kontourai/station-sdk';
import { errorText } from '../../utils/errorText';
import { isStationTransportFailure } from '../../utils/stationTransportFailure';

type ScheduleTone = 'success' | 'warning' | 'error';

export function getScheduleStatusTone({
  statusError,
  daemonOk,
  schedulerHealthy,
}: {
  statusError: boolean;
  daemonOk: boolean;
  schedulerHealthy: boolean;
}): ScheduleTone {
  if (statusError) {
    return 'warning';
  }
  if (daemonOk && schedulerHealthy) {
    return 'success';
  }
  if (daemonOk) {
    return 'warning';
  }
  return 'error';
}

export function getScheduleStatusLabel({
  statusError,
  daemonOk,
  schedulerHealthy,
}: {
  statusError: boolean;
  daemonOk: boolean;
  schedulerHealthy: boolean;
}): string {
  if (statusError) {
    return 'Unreachable';
  }
  if (daemonOk && schedulerHealthy) {
    return '● Healthy';
  }
  if (daemonOk) {
    return 'Degraded';
  }
  return '○ Stopped';
}

function getUtcHour(localHour: number): number {
  const date = new Date();
  date.setHours(localHour, 0, 0, 0);
  return date.getUTCHours();
}

export function getScheduleStarterTemplates(): Array<{
  name: string;
  label: string;
  cron: string;
  prompt: string;
  meta: string;
}> {
  return [
    {
      name: 'good-morning',
      label: 'Morning Briefing',
      cron: `0 ${getUtcHour(8)} * * 1-5`,
      prompt:
        'Review my calendar and email for today. Summarize priorities, prep for meetings, and flag anything urgent.',
      meta: 'Weekdays · 8:00 AM',
    },
    {
      name: 'catch-up-emails',
      label: 'Email Catch-up',
      cron: `0 ${getUtcHour(12)} * * 1-5`,
      prompt:
        'Check my recent emails and summarize anything I need to respond to or follow up on.',
      meta: 'Weekdays · 12:00 PM',
    },
    {
      name: 'wrap-up-day',
      label: 'End of Day Wrap',
      cron: `0 ${getUtcHour(17)} * * 1-5`,
      prompt:
        'Summarize what I accomplished today. Check for any customer meetings that need activity logging. Preview tomorrow.',
      meta: 'Weekdays · 5:00 PM',
    },
    {
      name: 'prep-week',
      label: 'Weekly Prep',
      cron: `0 ${getUtcHour(8)} * * 1`,
      prompt:
        'Prepare my weekly overview: key meetings, customer engagements, deadlines, and priorities for the week ahead.',
      meta: 'Mondays · 8:00 AM',
    },
  ];
}

export function buildEnrichedSchedulerJobs({
  jobs,
  stats,
}: {
  jobs: SchedulerJob[];
  stats?: {
    providers?: Record<
      string,
      { jobs?: { name: string; total: number; success_rate: number }[] }
    >;
  };
}): Array<SchedulerJob & { successRate: number }> {
  const statsMap = new Map<
    string,
    { name: string; total: number; success_rate: number }
  >();

  if (stats?.providers) {
    for (const providerStats of Object.values(stats.providers)) {
      for (const jobStats of providerStats.jobs || []) {
        statsMap.set(jobStats.name, jobStats);
      }
    }
  }

  return jobs.map((job) => {
    const jobStats = statsMap.get(job.name);
    return {
      ...job,
      successRate: jobStats
        ? jobStats.total > 0
          ? jobStats.success_rate
          : -1
        : -1,
    };
  });
}

/**
 * How a scheduler failure was actually observed. Every member names something
 * computed, never assumed:
 *
 * - `answered` — a response was observed. The scheduler client raises
 *   `SchedulerResponseError` only from the branch that holds a `Response`, so
 *   the class arriving here is the observation, not a guess about one.
 * - `unreachable` — the transport itself failed, matched against the exact
 *   phrases Station's transports emit (`isStationTransportFailure`).
 * - `unknown` — neither. We do not know whether the server was reached, so
 *   nothing here may claim that it was not.
 */
export type SchedulerFailureKind = 'answered' | 'unreachable' | 'unknown';

export interface SchedulerFailureNotice {
  kind: SchedulerFailureKind;
  title: string;
  description: string;
}

/**
 * Turns a scheduler query failure into the banner `ScheduleView` shows.
 *
 * This exists because that banner used to be a constant (station#3252): it
 * read "Could not connect to the scheduler service. Check that the server is
 * running." whether the server was unreachable or had answered in full. A
 * corrupt ledger answers HTTP 500 with a body naming `station home restore`
 * (station#3220), and that instruction died here. The rule this encodes: the
 * copy may only assert what the error object proves, and when the server said
 * something, what it said is the message — we never replace it with advice of
 * our own.
 */
export function describeSchedulerFailure(
  error: unknown,
): SchedulerFailureNotice {
  if (error instanceof SchedulerResponseError) {
    return {
      kind: 'answered',
      title: 'Scheduler Error',
      description: error.detail
        ? `The scheduler service answered with HTTP ${error.status}: ${error.detail}`
        : `The scheduler service answered with HTTP ${error.status} but gave no reason.`,
    };
  }
  if (isStationTransportFailure(error)) {
    return {
      kind: 'unreachable',
      title: 'Scheduler Unavailable',
      description:
        'Could not connect to the scheduler service. Check that the server is running.',
    };
  }
  return {
    kind: 'unknown',
    title: 'Scheduler Unavailable',
    description: `The scheduler could not be loaded: ${errorText(error)}`,
  };
}

/**
 * Picks which of the two failed scheduler queries to speak for. An answered
 * failure outranks an unobserved one because it is the only one carrying what
 * the server actually said; ordering is otherwise stable on `jobs`, the query
 * whose data the view exists to show.
 */
export function selectSchedulerFailure(
  jobsError: unknown,
  statusError: unknown,
): SchedulerFailureNotice {
  const jobs = describeSchedulerFailure(jobsError);
  if (jobs.kind === 'answered') return jobs;
  const status = describeSchedulerFailure(statusError);
  return status.kind === 'answered' ? status : jobs;
}
