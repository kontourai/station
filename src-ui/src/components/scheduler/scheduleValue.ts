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
 * The reader's own IANA zone, or `undefined` where the runtime will not name
 * one. `@kontourai/ephemeris` evaluates a cron in `schedule.timezone` and is
 * DST-aware there; ABSENT means UTC, so omitting it is a real (if blunt)
 * fallback rather than a broken one.
 */
export function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/**
 * A cron in LOCAL wall-clock terms, paired with the zone that makes it mean
 * that.
 *
 * #1536 L1: these presets used to shift only the HOUR into UTC
 * (`0 ${utcHourForLocalHour(8)} * * 1-5`), which is wrong for any zone where
 * the shift crosses midnight — at UTC+10, "weekdays 8:00 local" fired Tuesday
 * through SATURDAY, because the day-of-week field was never shifted with it.
 * There is no correct fixed-UTC spelling of a local weekday rule; the zone has
 * to travel with the expression. It also survives DST, which the shifted form
 * could not: `utcHourForLocalHour` read the offset in force the day the form
 * was opened.
 */
export function localCronSchedule(
  expr: string,
  timezone = browserTimeZone(),
): SchedulerSchedule {
  return { kind: 'cron', expr, ...(timezone ? { timezone } : {}) };
}

/** Weekdays 8:00 AM local, in local terms. */
export const WEEKDAY_MORNING_CRON = '0 8 * * 1-5';

/**
 * The "Morning Briefing" starter's schedule, and the Add Job form's default.
 * ONE definition on purpose: the form used to default to `* * * * *`, so a
 * reader who accepted the default without noticing scheduled a job that ran
 * every single minute, forever.
 */
export function weekdayMorningSchedule(
  timezone = browserTimeZone(),
): SchedulerSchedule {
  return localCronSchedule(WEEKDAY_MORNING_CRON, timezone);
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
