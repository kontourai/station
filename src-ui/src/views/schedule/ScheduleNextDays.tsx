import type { SchedulerJob } from '@kontourai/station-contracts/scheduler';
import { useMemo } from 'react';
import { Button } from '../../components/Button';
import { jobLabel } from '../../components/scheduler/jobName';
import { browserTimeZone } from '../../components/scheduler/scheduleValue';
import { ErrorState, SkeletonBlock } from '../../components/state';
import { useSchedulerJobs } from '../../hooks/useScheduler';
import {
  type ForecastDay,
  forecastWeekStarts,
  nextSevenDays,
  type UpcomingRun,
} from './nextSevenDays';
import './automations-list.css';

/** Runs a desktop day cell lists before "N more". */
const RUNS_PER_DAY = 3;
/** Rows "Next up" shows on a phone before "N more". */
const NEXT_UP_ROWS = 3;

/** "8 AM", "4:30 PM": the reader's clock, minutes only when they matter. */
function shortTime(at: number, zone: string): string {
  const date = new Date(at);
  const minutes = new Intl.DateTimeFormat('en', {
    timeZone: zone,
    minute: 'numeric',
  }).format(date);
  return date.toLocaleTimeString(undefined, {
    timeZone: zone,
    hour: 'numeric',
    ...(Number(minutes) === 0 ? {} : { minute: '2-digit' }),
  });
}

function dayParts(key: string) {
  const date = new Date(`${key}T12:00:00.000Z`);
  return {
    weekday: date.toLocaleDateString(undefined, {
      timeZone: 'UTC',
      weekday: 'short',
    }),
    day: date.toLocaleDateString(undefined, {
      timeZone: 'UTC',
      day: 'numeric',
    }),
    long: date.toLocaleDateString(undefined, {
      timeZone: 'UTC',
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    }),
  };
}

/** "and 2 more", or "and more" when the forecast did not count them all. */
function moreText(hidden: number, uncounted: boolean): string | null {
  if (hidden > 0) return uncounted ? `${hidden}+ more` : `${hidden} more`;
  return uncounted ? 'More not shown' : null;
}

/** Shows an automation's own row: opens it and brings it into view. */
type OpenAutomation = (job: SchedulerJob) => void;

function RunChip({
  run,
  zone,
  day,
  onOpen,
}: {
  run: UpcomingRun;
  zone: string;
  /** The day it is on, said before the time so each chip's name is unique. */
  day: string;
  onOpen: OpenAutomation;
}) {
  const time = shortTime(run.at, zone);
  const label = jobLabel(run.job);
  return (
    <li>
      {/* The chip truncates the name; the title carries the whole of it for
          a pointer, and the button's own text is its full accessible name. */}
      <button
        type="button"
        className="automations-week__run"
        title={`${time} ${label}`}
        onClick={() => onOpen(run.job)}
      >
        <span className="sr-only">{day}, </span>
        <time dateTime={run.time} className="automations-week__time">
          {time}
        </time>{' '}
        <span className="automations-week__name">{label}</span>
      </button>
    </li>
  );
}

function DayCell({
  day,
  zone,
  onOpen,
}: {
  day: ForecastDay;
  zone: string;
  onOpen: OpenAutomation;
}) {
  const parts = dayParts(day.key);
  const shown = day.runs.slice(0, RUNS_PER_DAY);
  const more = moreText(day.runs.length - shown.length, day.moreUncounted);
  return (
    <li
      className={`automations-week__day${day.isToday ? ' automations-week__day--today' : ''}`}
      aria-label={day.isToday ? `Today, ${parts.long}` : parts.long}
    >
      <div className="automations-week__day-head" aria-hidden="true">
        <span>{day.isToday ? 'Today' : parts.weekday}</span>
        <span className="automations-week__date">
          {day.isToday ? `${parts.weekday} ${parts.day}` : parts.day}
        </span>
      </div>
      {shown.length === 0 && !more ? (
        <p className="automations-week__none">Nothing scheduled</p>
      ) : (
        <ul className="automations-week__runs">
          {shown.map((run) => (
            <RunChip
              key={`${run.job.provider}:${run.job.name}:${run.time}`}
              run={run}
              zone={zone}
              day={day.isToday ? 'Today' : parts.long}
              onOpen={onOpen}
            />
          ))}
          {more && <li className="automations-week__more">{more}</li>}
        </ul>
      )}
    </li>
  );
}

/**
 * The section's title: "Next 7 days" over the strip on a desktop, "Next up"
 * over the three rows on a phone. CSS shows one; the hidden one is out of
 * the accessibility tree too.
 */
export function NextDaysTitle() {
  return (
    <>
      <span className="automations-title--wide">Next 7 days</span>
      <span className="automations-title--narrow">Next up</span>
    </>
  );
}

/**
 * "Next 7 days": what runs from now to the end of the sixth day after
 * today, in the reader's zone, read from the scheduler's week forecasts.
 * Paused automations have no forecast, so they are not here. On a phone it
 * is "Next up", the next three runs in one column.
 */
export function ScheduleNextDays({
  onOpen,
  now = Date.now(),
}: {
  onOpen: OpenAutomation;
  now?: number;
}) {
  const zone = browserTimeZone() ?? 'UTC';
  const [thisWeek, nextWeek] = forecastWeekStarts(now, zone);
  const first = useSchedulerJobs(thisWeek, zone);
  // When today is a Monday one week covers all seven days; asking for it
  // twice is one shared query.
  const second = useSchedulerJobs(nextWeek ?? thisWeek, zone);
  const forecast = useMemo(
    () =>
      nextSevenDays({
        weeks: nextWeek ? [first.data, second.data] : [first.data],
        now,
        zone,
      }),
    [first.data, second.data, nextWeek, now, zone],
  );

  if (first.isLoading || second.isLoading)
    return <SkeletonBlock count={2} label="Loading the next 7 days" />;
  if (first.isError || second.isError || forecast.kind === 'unknown')
    return (
      <ErrorState
        variant="compact"
        title="The next 7 days can't be shown"
        description="The list of automations below is up to date."
        action={
          <Button
            size="sm"
            onClick={() => {
              void first.refetch();
              void second.refetch();
            }}
          >
            Retry
          </Button>
        }
      />
    );

  const upcoming = forecast.days.flatMap((day) =>
    day.runs.map((run) => ({ run, day })),
  );
  const nextUp = upcoming.slice(0, NEXT_UP_ROWS);
  const nextUpMore = moreText(
    upcoming.length - nextUp.length,
    forecast.days.some((day) => day.moreUncounted),
  );
  return (
    <>
      <ol className="automations-week" aria-label="Next 7 days">
        {forecast.days.map((day) => (
          <DayCell key={day.key} day={day} zone={zone} onOpen={onOpen} />
        ))}
      </ol>
      <div className="automations-next-up">
        {nextUp.length === 0 && !nextUpMore ? (
          <p className="automations-next-up__none">
            Nothing scheduled in the next 7 days
          </p>
        ) : (
          <ol className="automations-next-up__list" aria-label="Next up">
            {nextUp.map(({ run, day }) => (
              <li key={`${run.job.provider}:${run.job.name}:${run.time}`}>
                <button
                  type="button"
                  className="automations-next-up__row"
                  onClick={() => onOpen(run.job)}
                >
                  <time
                    dateTime={run.time}
                    className="automations-next-up__when"
                  >
                    {day.isToday ? 'Today' : dayParts(day.key).weekday}{' '}
                    {shortTime(run.at, zone)}
                  </time>
                  <span className="automations-next-up__name">
                    {jobLabel(run.job)}
                  </span>
                </button>
              </li>
            ))}
            {nextUpMore && (
              <li className="automations-next-up__more">
                {nextUpMore} in the next 7 days
              </li>
            )}
          </ol>
        )}
      </div>
    </>
  );
}
