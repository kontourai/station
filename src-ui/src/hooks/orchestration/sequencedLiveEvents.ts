import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';

type SequencedLiveEvent = { sequence: number; event: CanonicalRuntimeEvent };
type Partition = {
  events: readonly SequencedLiveEvent[];
  truncatedThrough: number;
  listeners: Set<() => void>;
};

const EMPTY: readonly SequencedLiveEvent[] = [];
const MAX_EVENTS_PER_STATION = 2_048;
const partitions = new Map<string, Partition>();

export function clearSequencedLiveEvents(apiBase: string): void {
  const partition = partitions.get(apiBase);
  if (!partition) return;
  partition.events = EMPTY;
  partition.truncatedThrough = 0;
  for (const listener of partition.listeners) listener();
}

export function readSequencedLiveTruncation(apiBase: string): number {
  return partitions.get(apiBase)?.truncatedThrough ?? 0;
}

/** Test isolation for separate document lifetimes in one module process. */
export function resetSequencedLiveEventsForTests(): void {
  partitions.clear();
}

export function readSequencedLiveEvents(
  apiBase: string,
): readonly SequencedLiveEvent[] {
  return partitions.get(apiBase)?.events ?? EMPTY;
}

export function subscribeSequencedLiveEvents(
  apiBase: string,
  listener: () => void,
): () => void {
  let partition = partitions.get(apiBase);
  if (!partition) {
    partition = { events: EMPTY, truncatedThrough: 0, listeners: new Set() };
    partitions.set(apiBase, partition);
  }
  partition.listeners.add(listener);
  return () => partition?.listeners.delete(listener);
}

/** Retain canonical frames until a window read can stitch them by sequence. */
export function recordSequencedLiveEvent(
  apiBase: string,
  event: CanonicalRuntimeEvent,
  sequence: number | undefined,
): void {
  if (sequence === undefined || !event.eventId) return;
  let partition = partitions.get(apiBase);
  if (!partition) {
    partition = { events: EMPTY, truncatedThrough: 0, listeners: new Set() };
    partitions.set(apiBase, partition);
  }
  if (sequence <= partition.truncatedThrough) return;
  const last = partition.events.at(-1);
  if (last?.sequence === sequence) return;
  const ordered =
    last && sequence < last.sequence
      ? partition.events.some((item) => item.sequence === sequence)
        ? undefined
        : [...partition.events, { sequence, event }].sort(
            (left, right) => left.sequence - right.sequence,
          )
      : [...partition.events, { sequence, event }];
  if (!ordered) return;
  const overflow = ordered.length - MAX_EVENTS_PER_STATION;
  if (overflow > 0) {
    partition.truncatedThrough = Math.max(
      partition.truncatedThrough,
      ordered[overflow - 1]!.sequence,
    );
    partition.events = ordered.slice(overflow);
  } else {
    partition.events = ordered;
  }
  for (const listener of partition.listeners) listener();
}
