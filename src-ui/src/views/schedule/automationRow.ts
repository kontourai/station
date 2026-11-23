import type {
  SchedulerJob,
  SchedulerRunOutcome,
  SchedulerSchedule,
} from '@kontourai/station-contracts/scheduler';
import { cronToHuman } from '../../components/scheduler/CronEditor';
import { formatSchedule } from '../../components/scheduler/scheduleValue';

const WEEKDAYS = [
  'Sundays',
  'Mondays',
  'Tuesdays',
  'Wednesdays',
  'Thursdays',
  'Fridays',
  'Saturdays',
];

/** "8:00 AM" for an hour and minute of the wall clock, in the reader's locale. */
function wallClock(hour: number, minute: number): string {
  return new Date(Date.UTC(2001, 0, 1, hour, minute)).toLocaleTimeString(
    undefined,
    { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' },
  );
}

/** ", Denver time" when the rule's zone is not the reader's; "" when it is. */
function zoneSuffix(zone: string, readerZone: string | undefined): string {
  if (zone === readerZone) return '';
  if (/^(Etc\/)?(UTC|GMT|UCT|Zulu|Universal)$/.test(zone)) return ', UTC';
  // POSIX signs are inverted: Etc/GMT+5 is five hours behind UTC.
  const fixed = /^Etc\/GMT([+-])(\d{1,2})$/.exec(zone);
  if (fixed) return `, UTC${fixed[1] === '+' ? '\u2212' : '+'}${fixed[2]}`;
  const city = zone.split('/').at(-1)?.replaceAll('_', ' ');
  return `, ${city ?? zone} time`;
}

/**
 * The schedule as a sentence: "Weekdays at 8:00 AM", "Mondays at 9:00 AM",
 * "Every 2 hours". A cron rule reads in the zone it is written in; the zone
 * is named only when it is not the reader's. A rule this cannot say plainly
 * falls back to the longer cron description, which names its zone.
 */
export function scheduleSentence(
  schedule: SchedulerSchedule,
  readerZone: string | undefined,
): string {
  if (schedule.kind === 'every') return formatSchedule(schedule);
  if (schedule.kind === 'at')
    return `Once, ${new Date(schedule.timeMs).toLocaleString(undefined, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
    })}`;
  const zone = schedule.timezone ?? 'UTC';
  const fields = schedule.expr.trim().split(/\s+/);
  const [minute, hour, dom, month, dow] = fields;
  const plain = (value: string | undefined) =>
    value !== undefined && /^\d{1,2}$/.test(value);
  if (fields.length === 5 && plain(minute) && plain(hour) && dom === '*') {
    const time = wallClock(Number(hour), Number(minute));
    const days =
      month !== '*'
        ? null
        : dow === '*'
          ? 'Every day'
          : dow === '1-5'
            ? 'Weekdays'
            : dow === '0,6' || dow === '6,0'
              ? 'Weekends'
              : /^[0-6]$/.test(dow ?? '')
                ? WEEKDAYS[Number(dow)]
                : null;
    if (days) return `${days} at ${time}${zoneSuffix(zone, readerZone)}`;
  }
  return (
    cronToHuman(schedule.expr, { timezone: schedule.timezone }) ?? schedule.expr
  );
}

/** "Mon 8:00 AM", with the date when it is more than six days away. */
function runLabel(at: number, now: number): string {
  const far = at - now > 6 * 86_400_000;
  return new Date(at).toLocaleString(undefined, {
    weekday: 'short',
    ...(far ? { day: 'numeric', month: 'short' } : {}),
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * A one-time automation whose time has passed and that has had a run at or
 * after that time: it will not run again, whatever its stored on or off says
 * (a one-time automation set to be removed after its run is turned off once
 * that run succeeds). Derived from the list read; nothing stores it. A run
 * started by hand before its time does not finish it.
 */
export function hasFinished(job: SchedulerJob, now: number): boolean {
  const schedule = job.schedule;
  if (schedule?.kind !== 'at' || schedule.timeMs > now) return false;
  const lastRun = Date.parse(job.lastRun ?? '');
  return Number.isFinite(lastRun) && lastRun >= schedule.timeMs;
}

/** What the row says about the next run. */
export function nextRunText(job: SchedulerJob, now: number): string {
  if (hasFinished(job, now))
    return `Ran ${new Date(Date.parse(job.lastRun ?? '')).toLocaleString(
      undefined,
      { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' },
    )}`;
  if (!job.enabled) return "Won't run while paused";
  const next = Date.parse(job.nextRun ?? '');
  if (Number.isFinite(next)) return `Next: ${runLabel(next, now)}`;
  if (job.schedule?.kind === 'at' && job.schedule.timeMs <= now)
    return 'No more runs';
  return 'Next run unknown';
}

export type AutomationStatus = 'Active' | 'Paused' | 'Running' | 'Done';

export function automationStatus(
  job: SchedulerJob,
  running: boolean,
  now: number,
): AutomationStatus {
  if (running) return 'Running';
  if (hasFinished(job, now)) return 'Done';
  return job.enabled ? 'Active' : 'Paused';
}

/** Where a row sorts: active first, then paused, then done. */
export function statusRank(job: SchedulerJob, now: number): number {
  if (hasFinished(job, now)) return 2;
  return job.enabled ? 0 : 1;
}

/**
 * The row's warning, if any: Station pausing the automation itself outranks
 * a run of them, because it is why the status reads Paused. The scheduler
 * counts a run whose outcome is unknown as not having worked, so the words
 * say "didn't work", which is true of a failed run and of an unknown one;
 * "failed" would claim more than Station knows about the unknown ones.
 */
export function automationFlag(job: SchedulerJob): string | null {
  if (job.pausedItself)
    return `Paused itself after ${job.pausedItself.failures} runs that didn't work`;
  const failures = job.consecutiveFailures ?? 0;
  if (failures === 1) return "Last run didn't work";
  if (failures > 1) return `Last ${failures} runs didn't work`;
  return null;
}

const OUTCOME_WORDS: Record<SchedulerRunOutcome, string> = {
  worked: 'worked',
  failed: 'failed',
  skipped: 'skipped',
  unknown: 'outcome unknown',
};

/**
 * The strip's accessible name: what the squares show, counted. "Last 12
 * runs: 10 worked, 2 failed." Absent outcomes are said to be unknown.
 */
export function outcomesSummary(job: SchedulerJob): string {
  const recent = job.recentOutcomes;
  if (!recent) return 'Recent runs unknown';
  const { outcomes, more } = recent;
  if (outcomes.length === 0) return 'No runs yet';
  const counts = new Map<SchedulerRunOutcome, number>();
  for (const outcome of outcomes)
    counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
  const parts = (['worked', 'failed', 'skipped', 'unknown'] as const)
    .filter((outcome) => counts.has(outcome))
    .map((outcome) => `${counts.get(outcome)} ${OUTCOME_WORDS[outcome]}`);
  const runs = outcomes.length === 1 ? 'run' : `${outcomes.length} runs`;
  return `${more ? 'Last' : 'All'} ${runs}: ${parts.join(', ')}`.replace(
    /^All run:/,
    'One run:',
  );
}

/** How the newest run ended, in words, for the phone row. */
export function lastOutcomeText(job: SchedulerJob): string | null {
  const last = job.recentOutcomes?.outcomes.at(-1);
  if (!last) return null;
  return last === 'unknown'
    ? 'Last run outcome unknown'
    : `Last run ${OUTCOME_WORDS[last]}`;
}
