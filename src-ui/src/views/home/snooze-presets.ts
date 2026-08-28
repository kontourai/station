/**
 * Agent-rhythm snooze presets (design (b), archive#1099): In 1 hour / This
 * evening / Tomorrow 9am / Next week Mon 9am, each computed against local
 * time so "evening"/"9am" match the wall clock the triager is actually
 * looking at.
 *
 * Deliberately its own module, separate from `home-lane-model.ts`: only the
 * lazily-loaded `SnoozeMenu` needs this date math, and `home-lane-model.ts`
 * is imported eagerly (by `useHomeWorkLanes`, on every Home render), so
 * merging the two would pull preset-menu-only code back into the entry
* bundle.
 */

export interface SnoozePreset {
  id: 'in-1-hour' | 'this-evening' | 'tomorrow-9am' | 'next-week-mon-9am';
  label: string;
  wakeAt: number;
}

const HOUR_MS = 60 * 60 * 1000;
const EVENING_HOUR = 18;
const MORNING_HOUR = 9;

function atLocalHour(base: Date, hour: number): Date {
  const next = new Date(base);
  next.setHours(hour, 0, 0, 0);
  return next;
}

export function snoozePresetTargets(now: number): SnoozePreset[] {
  const nowDate = new Date(now);

  const inOneHour = now + HOUR_MS;

  let evening = atLocalHour(nowDate, EVENING_HOUR);
  if (evening.getTime() <= now) {
    evening = new Date(evening.getTime() + 24 * HOUR_MS);
  }

  const tomorrow = new Date(nowDate);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowNine = atLocalHour(tomorrow, MORNING_HOUR);

// "Next week Monday" always lands in a week later than the current one:
// for any day other than Monday this is simply the next Monday; on a
// Monday itself it skips today and lands on the Monday seven days out.
  const nextWeekMonday = new Date(nowDate);
  const day = nextWeekMonday.getDay(); // 0 = Sunday .. 6 = Saturday
  const daysUntilMonday = ((8 - day) % 7 || 7) as number;
  nextWeekMonday.setDate(nextWeekMonday.getDate() + daysUntilMonday);
  const nextWeekMondayNine = atLocalHour(nextWeekMonday, MORNING_HOUR);

  return [
    { id: 'in-1-hour', label: 'In 1 hour', wakeAt: inOneHour },
    { id: 'this-evening', label: 'This evening', wakeAt: evening.getTime() },
    {
      id: 'tomorrow-9am',
      label: 'Tomorrow 9am',
      wakeAt: tomorrowNine.getTime(),
    },
    {
      id: 'next-week-mon-9am',
      label: 'Next week Mon 9am',
      wakeAt: nextWeekMondayNine.getTime(),
    },
  ];
}
