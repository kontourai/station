import type { OrchestrationSequencedEvent } from '@kontourai/station-contracts/orchestration';

/**
 * Where the reader is in a transcript, as the list reports it to the window
 * that feeds it.
 */
export interface ReaderPlace {
  away: boolean;
  /** The turn of the first row the reader sees, when they are away. */
  turnId?: string;
}

/** Turns held for a reader away from the end, at most. */
export const AWAY_HELD_TURN_CAP = 200;
/** Turns kept above the reader's turn when the cap trims. */
const AWAY_TRIM_MARGIN_TURNS = 5;

/**
 * The sequence below which a window kept for a reader away from the end is
 * trimmed: the newest `AWAY_HELD_TURN_CAP` turns, but never the reader's turn
 * or the `AWAY_TRIM_MARGIN_TURNS` above it. Undefined when nothing is
 * trimmed, including when the reader's turn is unknown.
 */
export function awayTrimSequence(
  events: readonly OrchestrationSequencedEvent[],
  readingTurnId: string | undefined,
): number | undefined {
  const starts: Array<{ turnId: string; sequence: number }> = [];
  const seen = new Set<string>();
  for (const item of events) {
    const { event } = item;
    if (event.method !== 'turn.started' || !event.turnId) continue;
    if (seen.has(event.turnId)) continue;
    seen.add(event.turnId);
    starts.push({ turnId: event.turnId, sequence: item.sequence });
  }
  if (starts.length <= AWAY_HELD_TURN_CAP || !readingTurnId) return undefined;
  const reading = starts.findIndex((start) => start.turnId === readingTurnId);
  if (reading < 0) return undefined;
  const keepFrom = Math.min(
    starts.length - AWAY_HELD_TURN_CAP,
    Math.max(0, reading - AWAY_TRIM_MARGIN_TURNS),
  );
  return keepFrom > 0 ? starts[keepFrom]!.sequence : undefined;
}

/**
 * Whether a reload keeps the events held and merges the newest page into
 * them, instead of replacing them with it. Held older pages are kept, as is
 * whatever a reader away from the end holds: replacing would drop the oldest
 * turns from the front, and with them the rows they are reading.
 */
export function reloadKeepsHeld(state: {
  olderLoaded: boolean;
  readerAway: boolean;
  holding: boolean;
}): boolean {
  return state.olderLoaded || (state.readerAway && state.holding);
}
