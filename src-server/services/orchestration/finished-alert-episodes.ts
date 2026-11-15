import { join } from 'node:path';
import { JsonFileStore } from '../infra/json-store.js';

/**
 * The one record of each thread's "finished" completion episode, shared by
 * the push producer (`turn-completion-notifications.ts`, the only writer)
 * and the phone card (`agent-activity-publisher.ts`, a reader). Both then
 * agree on exactly one finish per episode, sent after confirmation:
 *
 * - `isPending`: a completion is being decided, held by running work, or in
 *   its confirmation window. The card reads Running and raises no "Agent
 *   finished" while this holds.
 * - `releaseFor`: the episode's finish was released. `key` names the
 *   episode's last terminal event (`event:<eventId>`, the key the card
 *   derives from the event log), and `at` is when it was released. The card
 *   dates that entry from the release, on every rebuild, so a long hold
 *   still falls inside the alert window.
 *
 * In memory: after a restart the producer replays its persisted pending
 * episodes (see {@link FinishedAlertEpisodeStore}) and marks them pending
 * again. A release from before the restart is forgotten, and the card falls
 * back to the terminal event's time and the same key, which the phone's
 * remembered alert ids already cover.
 */
export interface FinishedAlertRelease {
  key: string;
  at: number;
}

/** Releases older than this are dropped; the card's alert window is 2 min. */
const RELEASE_RETENTION_MS = 30 * 60_000;
/** At most this many releases are remembered, oldest dropped first. */
const RELEASE_MAX = 1_000;

export class FinishedAlertEpisodes {
  private readonly deciding = new Map<string, number>();
  private readonly held = new Set<string>();
  private readonly releases = new Map<string, FinishedAlertRelease>();
  private readonly listeners = new Set<(threadId: string) => void>();

  isPending(threadId: string): boolean {
    return this.held.has(threadId) || this.deciding.has(threadId);
  }

  releaseFor(threadId: string): FinishedAlertRelease | undefined {
    return this.releases.get(threadId);
  }

  /** Calls `listener` when a thread's `isPending` or `releaseFor` changes. */
  subscribe(listener: (threadId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * A terminal that may start or extend an episode was observed and is not
   * decided yet. Marked synchronously on the bus, so the card cannot read
   * the finished turn as Done in the moment before the producer decides.
   */
  beginDeciding(threadId: string): void {
    const wasPending = this.isPending(threadId);
    this.deciding.set(threadId, (this.deciding.get(threadId) ?? 0) + 1);
    if (!wasPending) this.notify(threadId);
  }

  endDeciding(threadId: string): void {
    const count = this.deciding.get(threadId) ?? 0;
    if (count <= 1) this.deciding.delete(threadId);
    else this.deciding.set(threadId, count - 1);
    if (!this.isPending(threadId)) this.notify(threadId);
  }

  setHeld(threadId: string, held: boolean): void {
    const wasPending = this.isPending(threadId);
    if (held) this.held.add(threadId);
    else this.held.delete(threadId);
    if (wasPending !== this.isPending(threadId)) this.notify(threadId);
  }

  /** The episode's finish went out now (or was decided not to need one). */
  recordRelease(threadId: string, release: FinishedAlertRelease): void {
    this.held.delete(threadId);
    this.releases.delete(threadId);
    this.releases.set(threadId, release);
    for (const [id, entry] of this.releases) {
      if (
        this.releases.size <= RELEASE_MAX &&
        release.at - entry.at <= RELEASE_RETENTION_MS
      )
        break;
      this.releases.delete(id);
    }
    this.notify(threadId);
  }

  clear(): void {
    this.deciding.clear();
    this.held.clear();
    this.releases.clear();
  }

  private notify(threadId: string): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(threadId);
      } catch {
        // A reader's failure must not break the producer.
      }
    }
  }
}

/** A pending episode as persisted, so a restart does not lose its alert. */
export interface PersistedFinishedAlertEpisode {
  threadId: string;
  turnId: string;
  outcome: 'done' | 'replied';
  onActivityCard: boolean;
  /** The episode's last terminal event (the card's entry key). */
  terminalEventId?: string;
}

/**
 * Where the producer keeps its pending episodes. Every successful finish
 * waits at least `FINISHED_ALERT_CONFIRM_MS` before its record exists; a
 * restart in that window, or while work holds it, must not lose the record
 * or the coordinator wake that reads it.
 */
export interface FinishedAlertEpisodeStore {
  load(): PersistedFinishedAlertEpisode[];
  save(episodes: readonly PersistedFinishedAlertEpisode[]): void;
}

/** One episode per thread; a store this size is refused rather than cut. */
export const FINISHED_ALERT_EPISODES_MAX = 2_000;
const STORE_MAX_BYTES = 2 * 1024 * 1024;
const ID_MAX = 512;

function isId(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= ID_MAX
  );
}

/** Parses one persisted row; anything malformed is dropped. */
export function parsePersistedFinishedAlertEpisode(
  value: unknown,
): PersistedFinishedAlertEpisode | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const row = value as Record<string, unknown>;
  if (!isId(row.threadId) || !isId(row.turnId)) return undefined;
  if (row.outcome !== 'done' && row.outcome !== 'replied') return undefined;
  if (typeof row.onActivityCard !== 'boolean') return undefined;
  if (row.terminalEventId !== undefined && !isId(row.terminalEventId))
    return undefined;
  return {
    threadId: row.threadId,
    turnId: row.turnId,
    outcome: row.outcome,
    onActivityCard: row.onActivityCard,
    ...(row.terminalEventId !== undefined
      ? { terminalEventId: row.terminalEventId }
      : {}),
  };
}

/**
 * `finished-alert-episodes.json` in the Station home. Written whole on every
 * change: it holds at most one small row per thread with a pending finish.
 * A store with more than {@link FINISHED_ALERT_EPISODES_MAX} rows is read as
 * corrupt (throws), so the producer starts empty and says so.
 */
export function createFileFinishedAlertEpisodeStore(
  homeDir: string,
): FinishedAlertEpisodeStore {
  const store = new JsonFileStore<unknown>(
    join(homeDir, 'finished-alert-episodes.json'),
    [],
    {
      onCorruption: 'throw',
      durableAtomicWrite: true,
      maxReadBytes: STORE_MAX_BYTES,
    },
  );
  return {
    load() {
      const raw = store.read();
      if (!Array.isArray(raw))
        throw new Error('finished-alert episodes: not a list');
      if (raw.length > FINISHED_ALERT_EPISODES_MAX)
        throw new Error('finished-alert episodes: over the bound');
      return raw.flatMap((row) => {
        const parsed = parsePersistedFinishedAlertEpisode(row);
        return parsed ? [parsed] : [];
      });
    },
    save(episodes) {
      if (episodes.length > FINISHED_ALERT_EPISODES_MAX)
        throw new Error('finished-alert episodes: over the bound');
      store.write(episodes);
    },
  };
}
