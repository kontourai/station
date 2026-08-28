/**
 * Sequence-cursor dedup guard (archive#1092). The server sets each SSE
 * frame's `id:` to the orchestration event store's global sequence number
 * (see `EventStore.headGlobalSequence`/`listEventsAfterGlobalSequence`); a
 * reconnect can legitimately re-deliver a frame the client already applied
 * (the replay-vs-snapshot boundary, or a retry racing a `ping`), so every
 * consumer of the stream drops anything at or behind the last sequence it
 * already applied.
 *
 * Pre-#1092 hosts never set `id:` at all, so `raw.id` is `undefined` and
 * `parseStreamSequence` returns `undefined` — `shouldApplyStreamFrame`
 * always applies in that case. The guard is therefore safe to run
 * unconditionally regardless of the `eventStreamResume` capability flag: it
 * only ever drops a frame when a real sequence number said to.
 */

/** Parses an SSE frame's `id` into a finite sequence number, or `undefined`. */
export function parseStreamSequence(
  id: string | undefined,
): number | undefined {
  if (id === undefined || id === '') return undefined;
  const value = Number(id);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * `true` when a frame at `sequence` should be applied given the last
 * sequence already applied. A frame without a parseable sequence always
 * applies (graceful degradation against a pre-#1092 host).
 */
export function shouldApplyStreamFrame(
  sequence: number | undefined,
  lastAppliedSequence: number,
): boolean {
  if (sequence === undefined) return true;
  return sequence > lastAppliedSequence;
}

/** Tiny mutable tracker so callers don't each hand-roll the same `let`. */
export function createStreamCursorTracker() {
  let lastAppliedSequence = -1;
  return {
    /** `true` if the frame should be applied; also advances the cursor when it does. */
    admit(id: string | undefined): boolean {
      const sequence = parseStreamSequence(id);
      if (!shouldApplyStreamFrame(sequence, lastAppliedSequence)) return false;
      if (sequence !== undefined) lastAppliedSequence = sequence;
      return true;
    },
    /** Unconditionally adopts a cursor (e.g. a snapshot frame's resume point). */
    adopt(id: string | undefined): void {
      const sequence = parseStreamSequence(id);
      if (sequence !== undefined) lastAppliedSequence = sequence;
    },
  };
}
