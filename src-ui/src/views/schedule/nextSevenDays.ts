import type { SchedulerJob } from '@kontourai/station-contracts/scheduler';

const DAY_MS = 86_400_000;

/**
 * Most occurrences the scheduler forecasts for one job on one day
 * (`SchedulerService.projectWeek`). A job that reached it on a day it marks
 * `truncated` may have more there, uncounted.
 */
const FORECAST_PER_DAY_CAP = 8;

/** The calendar date `instant` falls on in `zone`, as `YYYY-MM-DD`. */
function dateKeyIn(instant: number, zone: string): string {
  const fields = new Intl.DateTimeFormat('en', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const field = (name: string) =>
    fields.find((part) => part.type === name)?.value;
  return `${field('year')}-${field('month')}-${field('day')}`;
}

/** `key` (`YYYY-MM-DD`) moved by `days` calendar days. */
function addDays(key: string, days: number): string {
  return new Date(Date.parse(`${key}T00:00:00.000Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/**
 * The Mondays of the forecast weeks that cover today and the six days after
 * it, in `zone`. The scheduler forecasts Monday-first weeks, so the next
 * seven days span this week and, unless today is a Monday, the next one.
 */
export function forecastWeekStarts(now: number, zone: string): string[] {
  const today = dateKeyIn(now, zone);
  const weekday = new Date(`${today}T00:00:00.000Z`).getUTCDay();
  const monday = addDays(today, -((weekday + 6) % 7));
  return monday === today ? [monday] : [monday, addDays(monday, 7)];
}

export interface UpcomingRun {
  job: SchedulerJob;
  /** The occurrence's instant, as the scheduler gave it. */
  time: string;
  at: number;
}

export interface ForecastDay {
  /** The day's date in the reader's zone, `YYYY-MM-DD`. */
  key: string;
  isToday: boolean;
  /** Every forecast run still ahead on this day, in time order. */
  runs: UpcomingRun[];
  /** Some job may have more runs this day than the forecast lists. */
  moreUncounted: boolean;
}

export type NextSevenDays =
  | { kind: 'known'; days: ForecastDay[] }
  /** A forecast read failed or a job came back without one. */
  | { kind: 'unknown' };

/**
 * The runs ahead from `now` to the end of the sixth day after today, in
 * `zone`, from the scheduler's Monday-week forecasts (`weeks`, one job list
 * per week from `forecastWeekStarts`). Runs earlier today are over and are
 * left out. A job with no forecast makes the whole answer unknown rather than
 * silently showing fewer runs.
 */
export function nextSevenDays({
  weeks,
  now,
  zone,
}: {
  weeks: ReadonlyArray<readonly SchedulerJob[] | undefined>;
  now: number;
  zone: string;
}): NextSevenDays {
  if (weeks.some((week) => week === undefined)) return { kind: 'unknown' };
  const today = dateKeyIn(now, zone);
  const days: ForecastDay[] = Array.from({ length: 7 }, (_, index) => ({
    key: addDays(today, index),
    isToday: index === 0,
    runs: [],
    moreUncounted: false,
  }));
  const byKey = new Map(days.map((day) => [day.key, day]));
  const seen = new Set<string>();
  for (const week of weeks as ReadonlyArray<readonly SchedulerJob[]>) {
    for (const job of week) {
      if (!job.weekOccurrences) return { kind: 'unknown' };
      const perDay = new Map<string, number>();
      for (const time of job.weekOccurrences.times) {
        const at = Date.parse(time);
        if (!Number.isFinite(at)) continue;
        const key = dateKeyIn(at, zone);
        perDay.set(key, (perDay.get(key) ?? 0) + 1);
        const identity = `${job.provider}\u0000${job.name}\u0000${time}`;
        if (at < now || seen.has(identity)) continue;
        seen.add(identity);
        byKey.get(key)?.runs.push({ job, time, at });
      }
      if (job.weekOccurrences.truncated)
        for (const [key, count] of perDay)
          if (count >= FORECAST_PER_DAY_CAP) {
            const day = byKey.get(key);
            if (day) day.moreUncounted = true;
          }
    }
  }
  for (const day of days) day.runs.sort((left, right) => left.at - right.at);
  return { kind: 'known', days };
}
