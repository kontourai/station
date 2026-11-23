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
  if (zone === 'UTC') return ', UTC';
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

/** What the row says about the next run. */
export function nextRunText(job: SchedulerJob, now: number): string {
  if (!job.enabled) return "Won't run while paused";
  const next = Date.parse(job.nextRun ?? '');
  if (Number.isFinite(next)) return `Next: ${runLabel(next, now)}`;
  if (job.schedule?.kind === 'at' && job.schedule.timeMs <= now)
    return 'No more runs';
  return 'Next run unknown';
}

export type AutomationStatus = 'Active' | 'Paused' | 'Running';

export function automationStatus(
  job: SchedulerJob,
  running: boolean,
): AutomationStatus {
  if (running) return 'Running';
  return job.enabled ? 'Active' : 'Paused';
}

/**
 * The row's warning, if any: Station pausing the automation itself outranks
 * a run of failures, because it is why the status reads Paused.
 */
export function automationFlag(job: SchedulerJob): string | null {
  if (job.pausedItself)
    return `Paused itself after ${job.pausedItself.failures} failed runs`;
  const failures = job.consecutiveFailures ?? 0;
  if (failures === 1) return 'Last run failed';
  if (failures > 1) return `Last ${failures} runs failed`;
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
