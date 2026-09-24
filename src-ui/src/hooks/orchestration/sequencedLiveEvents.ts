import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';

type SequencedLiveEvent = { sequence: number; event: CanonicalRuntimeEvent };
type Partition = {
  events: readonly SequencedLiveEvent[];
  listeners: Set<() => void>;
};

const EMPTY: readonly SequencedLiveEvent[] = [];
const MAX_EVENTS_PER_STATION = 10_000;
const partitions = new Map<string, Partition>();

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
    partition = { events: EMPTY, listeners: new Set() };
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
    partition = { events: EMPTY, listeners: new Set() };
    partitions.set(apiBase, partition);
  }
  if (partition.events.some((item) => item.sequence === sequence)) return;
  partition.events = [...partition.events, { sequence, event }]
    .sort((left, right) => left.sequence - right.sequence)
    .slice(-MAX_EVENTS_PER_STATION);
  for (const listener of partition.listeners) listener();
}
