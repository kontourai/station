/** Rows from one author this close together share a group. */
export const ROOM_GROUP_WINDOW_MS = 5 * 60_000;

export interface RoomGroupInput {
  readonly kind: 'message' | 'system';
  /** Stable author identity; a label is not an identity. */
  readonly authorId?: string;
  /** ISO timestamp of the row. */
  readonly at?: string;
  /** A reply carries its own context, so it never joins a neighbour's group. */
  readonly reply?: boolean;
}

export interface RoomRowPlacement {
  /** Continues the group above: no avatar or name line. */
  readonly stackPrevious: boolean;
  /** The row below continues this row's group. */
  readonly stackNext: boolean;
  /** The first row of a calendar day (local time): draw a day divider above it. */
  readonly newDay: boolean;
}

function time(at: string | undefined) {
  const value = at === undefined ? Number.NaN : Date.parse(at);
  return Number.isFinite(value) ? value : undefined;
}

/** Local calendar day, as the reader's clock sees it. */
export function roomDayKey(at: string | undefined): string | undefined {
  const value = time(at);
  if (value === undefined) return undefined;
  const date = new Date(value);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function stacks(previous: RoomGroupInput, row: RoomGroupInput) {
  if (previous.kind !== 'message' || row.kind !== 'message') return false;
  if (previous.reply || row.reply) return false;
  if (!previous.authorId || previous.authorId !== row.authorId) return false;
  const before = time(previous.at);
  const after = time(row.at);
  if (before === undefined || after === undefined) return false;
  const gap = after - before;
  return (
    gap >= 0 &&
    gap <= ROOM_GROUP_WINDOW_MS &&
    roomDayKey(previous.at) === roomDayKey(row.at)
  );
}

/**
 * Places each row of an oldest-first conversation. Rows group when they share
 * an author, sit within five minutes of the row above and fall on the same
 * day; system rows and replies always start a new group.
 */
export function groupRows(rows: readonly RoomGroupInput[]): RoomRowPlacement[] {
  return rows.map((row, index) => {
    const previous = rows[index - 1];
    const next = rows[index + 1];
    const day = roomDayKey(row.at);
    let newDay = false;
    if (day !== undefined) {
      // Compare against the nearest earlier row that has a time.
      let earlier: string | undefined;
      for (
        let cursor = index - 1;
        cursor >= 0 && earlier === undefined;
        cursor--
      )
        earlier = roomDayKey(rows[cursor]?.at);
      newDay = earlier !== day;
    }
    return {
      stackPrevious: !!previous && stacks(previous, row),
      stackNext: !!next && stacks(row, next),
      newDay,
    };
  });
}

function sameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** "Today", "Yesterday", "Tuesday, November 3", or a dated label for older years. */
export function roomDayLabel(at: string, now = Date.now()): string {
  const date = new Date(at);
  const today = new Date(now);
  if (sameDay(date, today)) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (sameDay(date, yesterday)) return 'Yesterday';
  return date.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    ...(date.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
  });
}

/** The short time shown on a row: hours and minutes only. */
export function roomShortTime(at: string): string {
  return new Date(at).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** The full timestamp shown in a row's tooltip. */
export function roomFullTime(at: string): string {
  return new Date(at).toLocaleString([], {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
