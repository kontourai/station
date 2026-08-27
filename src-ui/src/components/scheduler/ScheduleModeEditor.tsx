import { useState } from 'react';
import { CronEditor } from './CronEditor';

export type ScheduleMode = 'interval' | 'weekly' | 'cron';
export type IntervalUnit = 'minutes' | 'hours' | 'days';

type ParsedSchedule = {
  mode: ScheduleMode;
  intervalValue: number;
  intervalUnit: IntervalUnit;
  weeklyDays: number[];
  localTime: string;
};

const DAYS = [
  { value: 1, short: 'M', label: 'Monday' },
  { value: 2, short: 'T', label: 'Tuesday' },
  { value: 3, short: 'W', label: 'Wednesday' },
  { value: 4, short: 'T', label: 'Thursday' },
  { value: 5, short: 'F', label: 'Friday' },
  { value: 6, short: 'S', label: 'Saturday' },
  { value: 0, short: 'S', label: 'Sunday' },
] as const;

const ALL_DAYS = DAYS.map((day) => day.value);

function modulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function expandDays(value: string): number[] | null {
  if (value === '*') return [...ALL_DAYS];
  const result = new Set<number>();
  for (const part of value.split(',')) {
    if (/^\d$/.test(part)) {
      const day = Number(part);
      if (day > 6) return null;
      result.add(day);
      continue;
    }
    const match = part.match(/^(\d)-(\d)$/);
    if (!match) return null;
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (start > 6 || end > 6 || start > end) return null;
    for (let day = start; day <= end; day += 1) result.add(day);
  }
  return result.size > 0 ? [...result] : null;
}

function localTimeFromUtc(
  utcHour: number,
  utcMinute: number,
  utcDays: number[],
  timezoneOffsetMinutes: number,
): { time: string; days: number[] } {
  const localTotal = utcHour * 60 + utcMinute - timezoneOffsetMinutes;
  const dayShift = Math.floor(localTotal / (24 * 60));
  const minuteOfDay = modulo(localTotal, 24 * 60);
  return {
    time: `${String(Math.floor(minuteOfDay / 60)).padStart(2, '0')}:${String(
      minuteOfDay % 60,
    ).padStart(2, '0')}`,
    days: utcDays.map((day) => modulo(day + dayShift, 7)),
  };
}

export function parseFriendlySchedule(
  cron: string,
  timezoneOffsetMinutes = new Date().getTimezoneOffset(),
): ParsedSchedule {
  const trimmed = cron.trim();
  let match = trimmed.match(/^\*\/(\d+) \* \* \* \*$/);
  if (match) {
    return {
      mode: 'interval',
      intervalValue: Number(match[1]),
      intervalUnit: 'minutes',
      weeklyDays: [...ALL_DAYS],
      localTime: '09:00',
    };
  }
  match = trimmed.match(/^0 \*\/(\d+) \* \* \*$/);
  if (match) {
    return {
      mode: 'interval',
      intervalValue: Number(match[1]),
      intervalUnit: 'hours',
      weeklyDays: [...ALL_DAYS],
      localTime: '09:00',
    };
  }
  match = trimmed.match(/^0 0 \*\/(\d+) \* \*$/);
  if (match) {
    return {
      mode: 'interval',
      intervalValue: Number(match[1]),
      intervalUnit: 'days',
      weeklyDays: [...ALL_DAYS],
      localTime: '09:00',
    };
  }

  match = trimmed.match(/^(\d{1,2}) (\d{1,2}) \* \* ([\d,*-]+)$/);
  if (match) {
    const minute = Number(match[1]);
    const hour = Number(match[2]);
    const utcDays = expandDays(match[3]);
    if (minute < 60 && hour < 24 && utcDays) {
      const local = localTimeFromUtc(
        hour,
        minute,
        utcDays,
        timezoneOffsetMinutes,
      );
      return {
        mode: 'weekly',
        intervalValue: 1,
        intervalUnit: 'hours',
        weeklyDays: local.days,
        localTime: local.time,
      };
    }
  }

  return {
    mode: 'cron',
    intervalValue: 1,
    intervalUnit: 'hours',
    weeklyDays: [1, 2, 3, 4, 5],
    localTime: '09:00',
  };
}

export function compileIntervalSchedule(
  value: number,
  unit: IntervalUnit,
): string | null {
  const maximum = unit === 'minutes' ? 59 : unit === 'hours' ? 23 : 31;
  if (!Number.isInteger(value) || value < 1 || value > maximum) return null;
  if (unit === 'minutes') return `*/${value} * * * *`;
  if (unit === 'hours') return `0 */${value} * * *`;
  return `0 0 */${value} * *`;
}

export function compileWeeklySchedule(
  localTime: string,
  localDays: number[],
  timezoneOffsetMinutes = new Date().getTimezoneOffset(),
): string | null {
  const match = localTime.match(/^(\d{2}):(\d{2})$/);
  if (!match || localDays.length === 0) return null;
  const localHour = Number(match[1]);
  const localMinute = Number(match[2]);
  if (localHour > 23 || localMinute > 59) return null;

  const utcTotal = localHour * 60 + localMinute + timezoneOffsetMinutes;
  const dayShift = Math.floor(utcTotal / (24 * 60));
  const minuteOfDay = modulo(utcTotal, 24 * 60);
  const utcDays = [
    ...new Set(localDays.map((day) => modulo(day + dayShift, 7))),
  ].sort((a, b) => a - b);
  const dayExpression = utcDays.length === 7 ? '*' : utcDays.join(',');
  return `${minuteOfDay % 60} ${Math.floor(minuteOfDay / 60)} * * ${dayExpression}`;
}

export function ScheduleModeEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (cron: string) => void;
}) {
  const [initial] = useState(() => parseFriendlySchedule(value));
  const [mode, setMode] = useState<ScheduleMode>(initial.mode);
  const [intervalValue, setIntervalValue] = useState(initial.intervalValue);
  const [intervalUnit, setIntervalUnit] = useState<IntervalUnit>(
    initial.intervalUnit,
  );
  const [weeklyDays, setWeeklyDays] = useState(initial.weeklyDays);
  const [localTime, setLocalTime] = useState(initial.localTime);

  const updateInterval = (nextValue: number, nextUnit: IntervalUnit) => {
    setIntervalValue(nextValue);
    setIntervalUnit(nextUnit);
    const cron = compileIntervalSchedule(nextValue, nextUnit);
    if (cron) onChange(cron);
  };

  const updateWeekly = (nextTime: string, nextDays: number[]) => {
    setLocalTime(nextTime);
    setWeeklyDays(nextDays);
    const cron = compileWeeklySchedule(nextTime, nextDays);
    if (cron) onChange(cron);
  };

  const selectMode = (nextMode: ScheduleMode) => {
    setMode(nextMode);
    if (nextMode === 'interval') {
      onChange(
        compileIntervalSchedule(intervalValue, intervalUnit) ?? '0 */1 * * *',
      );
    } else if (nextMode === 'weekly') {
      const nextDays = weeklyDays.length > 0 ? weeklyDays : [1, 2, 3, 4, 5];
      setWeeklyDays(nextDays);
      const cron = compileWeeklySchedule(localTime, nextDays);
      if (cron) onChange(cron);
    }
  };

  const intervalMaximum =
    intervalUnit === 'minutes' ? 59 : intervalUnit === 'hours' ? 23 : 31;

  return (
    <div className="schedule-mode-editor">
      <fieldset
        className="schedule-mode-editor__tabs"
        aria-label="Schedule type"
      >
        {(
          [
            ['interval', 'Every'],
            ['weekly', 'Weekly'],
            ['cron', 'Cron'],
          ] as const
        ).map(([nextMode, label]) => (
          <button
            key={nextMode}
            type="button"
            className="schedule-mode-editor__tab"
            aria-pressed={mode === nextMode}
            onClick={() => selectMode(nextMode)}
          >
            {label}
          </button>
        ))}
      </fieldset>

      {mode === 'interval' && (
        <div className="schedule-mode-editor__row">
          <span className="schedule-mode-editor__sentence">Run every</span>
          <input
            className="schedule-mode-editor__number"
            aria-label="Interval"
            type="number"
            inputMode="numeric"
            min={1}
            max={intervalMaximum}
            value={intervalValue}
            onChange={(event) =>
              updateInterval(Number(event.target.value), intervalUnit)
            }
          />
          <select
            aria-label="Interval unit"
            value={intervalUnit}
            onChange={(event) =>
              updateInterval(
                Math.min(
                  intervalValue,
                  event.target.value === 'minutes'
                    ? 59
                    : event.target.value === 'hours'
                      ? 23
                      : 31,
                ),
                event.target.value as IntervalUnit,
              )
            }
          >
            <option value="minutes">minutes</option>
            <option value="hours">hours</option>
            <option value="days">days</option>
          </select>
          {(intervalValue < 1 || intervalValue > intervalMaximum) && (
            <span className="schedule__field-error" role="alert">
              Choose 1–{intervalMaximum} {intervalUnit}.
            </span>
          )}
        </div>
      )}

      {mode === 'weekly' && (
        <div className="schedule-mode-editor__weekly">
          <fieldset
            className="schedule-mode-editor__days"
            aria-label="Run on days"
          >
            {DAYS.map((day) => {
              const selected = weeklyDays.includes(day.value);
              return (
                <button
                  key={day.label}
                  type="button"
                  className="schedule-mode-editor__day"
                  aria-label={day.label}
                  aria-pressed={selected}
                  onClick={() =>
                    updateWeekly(
                      localTime,
                      selected
                        ? weeklyDays.filter((value) => value !== day.value)
                        : [...weeklyDays, day.value],
                    )
                  }
                >
                  {day.short}
                </button>
              );
            })}
          </fieldset>
          <label className="schedule-mode-editor__time-row">
            <span>At</span>
            <input
              aria-label="Local time"
              type="time"
              value={localTime}
              onChange={(event) => updateWeekly(event.target.value, weeklyDays)}
            />
            <span className="schedule-mode-editor__local-label">
              local time
            </span>
          </label>
          {weeklyDays.length === 0 && (
            <span className="schedule__field-error" role="alert">
              Choose at least one day.
            </span>
          )}
          <span className="schedule-mode-editor__note">
            Station currently stores UTC schedules. Daylight-saving changes may
            shift the local run time.
          </span>
        </div>
      )}

      {mode === 'cron' && <CronEditor value={value} onChange={onChange} />}
    </div>
  );
}
