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
