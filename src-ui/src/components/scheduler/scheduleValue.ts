import type {
  SchedulerJob,
  SchedulerSchedule,
} from '@kontourai/station-contracts/scheduler';

export type ExactIntervalUnit = 'seconds' | 'minutes' | 'hours' | 'days';

const INTERVAL_UNIT_MS: Record<ExactIntervalUnit, number> = {
  seconds: 1_000,
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
};

export function splitEveryMs(everyMs: number): {
  value: number;
  unit: ExactIntervalUnit;
} {
  for (const unit of ['days', 'hours', 'minutes'] as const) {
    const divisor = INTERVAL_UNIT_MS[unit];
    if (everyMs >= divisor && everyMs % divisor === 0) {
      return { value: everyMs / divisor, unit };
    }
  }
  return { value: everyMs / INTERVAL_UNIT_MS.seconds, unit: 'seconds' };
}

export function intervalToMs(value: number, unit: ExactIntervalUnit): number {
  return value * INTERVAL_UNIT_MS[unit];
}

/**
 * The hour a local wall-clock hour falls on in UTC. Cron expressions are
 * evaluated in UTC by the built-in scheduler, so a preset that means "8am
 * where the person is" has to be written down shifted.
 */
export function utcHourForLocalHour(localHour: number): number {
  const date = new Date();
  date.setHours(localHour, 0, 0, 0);
  return date.getUTCHours();
}

/**
 * Weekdays at 8:00 AM local — the "Morning Briefing" starter's schedule, and
 * the Add Job form's default. ONE definition on purpose: the form used to
 * default to `* * * * *`, so a reader who accepted the default without
 * noticing scheduled a job that runs every single minute, forever.
 */
export function weekdayMorningCron(): string {
  return `0 ${utcHourForLocalHour(8)} * * 1-5`;
}

export function scheduleForJob(job?: SchedulerJob): SchedulerSchedule {
  if (job?.schedule) return job.schedule;
  return { kind: 'cron', expr: job?.cron || '* * * * *' };
}

export function formatSchedule(schedule: SchedulerSchedule): string {
  if (schedule.kind === 'cron') return schedule.expr;
  if (schedule.kind === 'every') {
    const seconds = schedule.everyMs / 1_000;
    if (Number.isInteger(seconds / 86_400))
      return `Every ${seconds / 86_400} day${seconds === 86_400 ? '' : 's'}`;
    if (Number.isInteger(seconds / 3_600))
      return `Every ${seconds / 3_600} hour${seconds === 3_600 ? '' : 's'}`;
    if (Number.isInteger(seconds / 60))
      return `Every ${seconds / 60} minute${seconds === 60 ? '' : 's'}`;
    return `Every ${seconds} seconds`;
  }
  return `Once at ${new Date(schedule.timeMs).toLocaleString()}`;
}

export function scheduleEquals(
  left: SchedulerSchedule,
  right: SchedulerSchedule,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'cron' && right.kind === 'cron') {
    return left.expr === right.expr && left.timezone === right.timezone;
  }
  if (left.kind === 'every' && right.kind === 'every') {
    return left.everyMs === right.everyMs;
  }
  if (left.kind === 'at' && right.kind === 'at') {
    return (
      left.timeMs === right.timeMs &&
      left.deleteAfterRun === right.deleteAfterRun
    );
  }
  return false;
}

export function datetimeLocalValue(timeMs: number): string {
  const date = new Date(timeMs);
  const local = new Date(timeMs - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}
