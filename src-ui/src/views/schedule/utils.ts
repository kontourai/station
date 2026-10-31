import type {
  SchedulerJob,
  SchedulerSchedule,
} from '@kontourai/station-contracts/scheduler';
import { SchedulerResponseError } from '@kontourai/station-sdk';
import {
  localCronSchedule,
  weekdayMorningSchedule,
} from '../../components/scheduler/scheduleValue';
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

/**
 * #1536 L1: each starter carries a SCHEDULE (a local cron plus the reader's IANA
 * zone), not a UTC-shifted cron string. Shifting only the hour was wrong for
 * every zone where the shift crosses midnight — at UTC+10 the three weekday
 * presets fired Tuesday through Saturday, and "Mondays" fired on Tuesday — and
 * it could not survive DST either, since the offset was read once at render.
 * The `meta` line beside each is the claim this now actually keeps.
 */
export function getScheduleStarterTemplates(): Array<{
  name: string;
  label: string;
  schedule: SchedulerSchedule;
  prompt: string;
  meta: string;
}> {
  // Only work an agent can do with a workspace and its tools. No template
  // assumes an email, calendar or other connector Station does not back.
  return [
    {
      name: 'daily-repo-digest',
      label: 'Daily repo digest',
      schedule: weekdayMorningSchedule(),
      prompt:
        'Summarize what changed in this repository since the last run: merged commits, open pull requests and failing checks. Keep it short.',
      meta: 'Weekdays · 8:00 AM',
    },
    {
      name: 'open-work-check-back',
      label: 'Check back on open work',
      schedule: localCronSchedule('0 16 * * 1-5'),
      prompt:
        'Look back over the open work in this conversation. What is still unfinished, and what should happen next?',
      meta: 'Weekdays · 4:00 PM',
    },
    {
      name: 'weekly-dependency-check',
      label: 'Weekly dependency check',
      schedule: localCronSchedule('0 9 * * 1'),
      prompt:
        "Check this project's dependencies for available updates and known security advisories. List what needs action, most urgent first.",
      meta: 'Mondays · 9:00 AM',
    },
    {
      name: 'stale-pull-requests',
      label: 'Stale pull requests',
      schedule: localCronSchedule('0 14 * * 5'),
      prompt:
        'List open pull requests in this repository with no activity for a week, with a suggested next step for each.',
      meta: 'Fridays · 2:00 PM',
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
type SchedulerFailureKind = 'answered' | 'unreachable' | 'unknown';

interface SchedulerFailureNotice {
  kind: SchedulerFailureKind;
  title: string;
  description: string;
}

/**
 * Turns a scheduler query failure into the banner `ScheduleView` shows.
 *
 * This exists because that banner used to be a constant (archive#3252): it
 * read "Could not connect to the scheduler service. Check that the server is
 * running." whether the server was unreachable or had answered in full. A
 * corrupt ledger answers HTTP 500 with a body naming `station home restore`
 * (archive#3220), and that instruction died here. The rule this encodes: the
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
