import type { SchedulerJob } from '@kontourai/station-contracts/scheduler';
import { useMemo, useState } from 'react';
import { jobLabel } from '../../components/scheduler/jobName';
import { SkeletonBlock } from '../../components/state';
import { useSchedulerJobs } from '../../hooks/useScheduler';

const DAY_MS = 86_400_000;

function dateKey(date: Date, formatter: Intl.DateTimeFormat): string {
  const fields = formatter.formatToParts(date);
  const field = (name: string) =>
    fields.find((part) => part.type === name)?.value;
  return `${field('year')}-${field('month')}-${field('day')}`;
}

export function ScheduleWeek() {
  const [zone, setZone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const dayKey = useMemo(
    () =>
      new Intl.DateTimeFormat('en', {
        timeZone: zone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }),
    [zone],
  );
  const today = new Date(`${dateKey(new Date(), dayKey)}T00:00:00.000Z`);
  const monday = today.getTime() - ((today.getUTCDay() + 6) % 7) * DAY_MS;
  const weekStart = new Date(monday).toISOString().slice(0, 10);
  const week = useSchedulerJobs(weekStart, zone);
  const days = Array.from(
    { length: 7 },
    (_, index) => new Date(monday + index * DAY_MS),
  );
  const zones = [
    ...new Set(['UTC', zone, ...Intl.supportedValuesOf('timeZone')]),
  ];
  const dateLabel = new Intl.DateTimeFormat(undefined, {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  const timeLabel = new Intl.DateTimeFormat(undefined, {
    timeZone: zone,
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
  const occurrences = (week.data ?? []).flatMap((job: SchedulerJob) =>
    (job.weekOccurrences?.times ?? []).map((time) => ({
      job,
      time,
      date: new Date(time),
    })),
  );
  const unavailable =
    week.isError || week.data?.some((job) => job.weekOccurrences === undefined);
  return (
    <section aria-label="Weekly schedule">
      <label>
        Display time zone{' '}
        <select value={zone} onChange={(event) => setZone(event.target.value)}>
          {zones.map((item) => (
            <option value={item} key={item}>
              {item}
            </option>
          ))}
        </select>
      </label>
      {week.isLoading ? (
        <SkeletonBlock label="Loading weekly schedule" />
      ) : unavailable ? (
        <p role="status">
          The weekly schedule is unavailable. The job list is still available.
        </p>
      ) : (
        <>
          {(week.data ?? []).some((job) => job.weekOccurrences?.truncated) && (
            <p role="status">
              Some frequent schedules have additional occurrences.
            </p>
          )}
          <ol className="schedule__week">
            {days.map((day) => {
              const key = day.toISOString().slice(0, 10);
              const slots = occurrences
                .filter(({ date }) => dateKey(date, dayKey) === key)
                .sort((a, b) => a.date.getTime() - b.date.getTime());
              return (
                <li key={key}>
                  <h3>{dateLabel.format(day)}</h3>
                  {slots.length === 0 ? (
                    <p>None scheduled</p>
                  ) : (
                    <ul>
                      {slots.map(({ job, time, date }) => (
                        <li key={`${job.provider}:${job.name}:${time}`}>
                          <time dateTime={time}>{timeLabel.format(date)}</time>{' '}
                          {jobLabel(job)}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ol>
        </>
      )}
    </section>
  );
}
