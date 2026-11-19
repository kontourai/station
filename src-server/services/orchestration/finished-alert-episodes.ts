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
 * In memory: after a restart the producer replays its persisted episodes
 * (see {@link FinishedAlertEpisodeStore}): held and writing ones are pending
 * again, and a release still inside the card's alert window is restored.
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

/**
 * One persisted step of a thread's finish, keyed by thread and state: at
 * most one `held`, one `writing` and one `released` row per thread.
 *
 * - `held`: pending; a hold or the confirmation window still applies.
 * - `writing`: the release was decided and saved before the record write
 *   was attempted, so a restart neither loses it nor writes it twice (the
 *   producer looks the record up first). `attempts` counts failed writes.
 * - `released`: the record exists. Kept for the card's alert window so a
 *   restart re-dates the card's one "Agent finished" from the release.
 */
export type PersistedFinishedAlertEpisode =
  | ({ state: 'held' } & PersistedFinishedAlertFinish)
  | ({
      state: 'writing';
      attempts: number;
      nextAttemptAt?: number;
    } & PersistedFinishedAlertFinish)
  | {
      state: 'released';
      threadId: string;
      turnId: string;
      releaseKey: string;
      releasedAt: number;
    };

export interface PersistedFinishedAlertFinish {
  threadId: string;
  turnId: string;
  outcome: 'done' | 'replied';
  onActivityCard: boolean;
  /** The episode's last terminal event (the card's entry key). */
  terminalEventId?: string;
}

/**
 * Where the producer keeps its episodes. Every successful finish waits at
 * least `FINISHED_ALERT_CONFIRM_MS` before its record exists; a restart in
 * that window, while work holds it, or between the record write and its
 * acknowledgement must not lose the record or the coordinator wake that
 * reads it.
 *
 * One writer per Station home. `station start` refuses a second instance on
 * the same home (packages/cli/src/commands/lifecycle.ts), and the
 * unsupported `--allow-shared-home` override already warns that writes from
 * two processes can be lost; this file shares that limit. The server itself
 * holds no home lock, so entry paths that bypass the CLI are not shown to be
 * exclusive.
 */
export interface FinishedAlertEpisodeStore {
  load(): PersistedFinishedAlertEpisode[];
  save(episodes: readonly PersistedFinishedAlertEpisode[]): void;
}

/**
 * At most this many rows, of every state. The producer admits a new held
 * finish only below it (reclaiming released rows first) and refuses one
 * above it; a store this size is refused rather than cut.
 */
export const FINISHED_ALERT_EPISODES_MAX = 2_000;
const STORE_MAX_BYTES = 2 * 1024 * 1024;
const ID_MAX = 512;

function isId(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= ID_MAX
  );
}

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Parses one persisted row; anything malformed is dropped. */
function parsePersistedFinishedAlertEpisode(
  value: unknown,
): PersistedFinishedAlertEpisode | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const row = value as Record<string, unknown>;
  if (!isId(row.threadId) || !isId(row.turnId)) return undefined;
  if (row.state === 'released') {
    if (!isId(row.releaseKey) || !isTime(row.releasedAt)) return undefined;
    return {
      state: 'released',
      threadId: row.threadId,
      turnId: row.turnId,
      releaseKey: row.releaseKey,
      releasedAt: row.releasedAt,
    };
  }
  if (row.state !== 'held' && row.state !== 'writing') return undefined;
  if (row.outcome !== 'done' && row.outcome !== 'replied') return undefined;
  if (typeof row.onActivityCard !== 'boolean') return undefined;
  if (row.terminalEventId !== undefined && !isId(row.terminalEventId))
    return undefined;
  const finish: PersistedFinishedAlertFinish = {
    threadId: row.threadId,
    turnId: row.turnId,
    outcome: row.outcome,
    onActivityCard: row.onActivityCard,
    ...(row.terminalEventId !== undefined
      ? { terminalEventId: row.terminalEventId }
      : {}),
  };
  if (row.state === 'held') return { state: 'held', ...finish };
  if (
    typeof row.attempts !== 'number' ||
    !Number.isInteger(row.attempts) ||
    row.attempts < 0 ||
    (row.nextAttemptAt !== undefined && !isTime(row.nextAttemptAt))
  )
    return undefined;
  return {
    state: 'writing',
    ...finish,
    attempts: row.attempts,
    ...(row.nextAttemptAt !== undefined
      ? { nextAttemptAt: row.nextAttemptAt }
      : {}),
  };
}

/**
 * `finished-alert-episodes.json` in the Station home. Written whole on every
 * change: it holds at most three small rows per thread (one per state).
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
