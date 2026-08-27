/**
 * command-frecency — pure, bounded command-use scoring.
 *
 * This module deliberately knows nothing about browser storage or the command
 * registry. The palette supplies its existing registry order as the final tie
 * break, so history can make equally literal matches easier to reach without
 * inventing a second source of commands.
 */

export interface CommandFrecencyEntry {
  commandId: string;
  count: number;
  lastUsedAt: number;
}

export const COMMAND_FRECENCY_MAX_ENTRIES = 100;
export const COMMAND_FRECENCY_MAX_COUNT = 20;
export const COMMAND_FRECENCY_MAX_BOOST = 12;
const DECAY_WINDOW_MS = 28 * 24 * 60 * 60 * 1000;

function isEntry(value: unknown): value is CommandFrecencyEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  const { commandId, count, lastUsedAt } = entry;
  return (
    typeof commandId === 'string' &&
    commandId.length > 0 &&
    typeof count === 'number' &&
    Number.isInteger(count) &&
    count > 0 &&
    typeof lastUsedAt === 'number' &&
    Number.isFinite(lastUsedAt) &&
    lastUsedAt >= 0
  );
}

/**
 * Validate and deterministically bound persisted history. Duplicate ids keep
 * the most-recent entry; ties remain deterministic by count then id.
 */
export function normalizeCommandFrecency(
  entries: unknown,
  maxEntries = COMMAND_FRECENCY_MAX_ENTRIES,
): CommandFrecencyEntry[] {
  if (!Array.isArray(entries)) return [];
  const byId = new Map<string, CommandFrecencyEntry>();
  for (const candidate of entries) {
    if (!isEntry(candidate)) return [];
    const entry = {
      commandId: candidate.commandId,
      count: Math.min(candidate.count, COMMAND_FRECENCY_MAX_COUNT),
      lastUsedAt: candidate.lastUsedAt,
    };
    const prior = byId.get(entry.commandId);
    if (
      !prior ||
      entry.lastUsedAt > prior.lastUsedAt ||
      (entry.lastUsedAt === prior.lastUsedAt && entry.count > prior.count)
    ) {
      byId.set(entry.commandId, entry);
    }
  }
  return [...byId.values()]
    .sort(
      (a, b) =>
        b.lastUsedAt - a.lastUsedAt ||
        b.count - a.count ||
        a.commandId.localeCompare(b.commandId),
    )
    .slice(0, Math.max(0, maxEntries));
}

/** Record one successful executable selection, preserving a bounded history. */
export function recordCommandFrecency(
  entries: readonly CommandFrecencyEntry[],
  commandId: string,
  now: number,
): CommandFrecencyEntry[] {
  if (!commandId || !Number.isFinite(now) || now < 0) {
    return normalizeCommandFrecency(entries);
  }
  const prior = entries.find((entry) => entry.commandId === commandId);
  return normalizeCommandFrecency([
    ...entries.filter((entry) => entry.commandId !== commandId),
    {
      commandId,
      count: Math.min((prior?.count ?? 0) + 1, COMMAND_FRECENCY_MAX_COUNT),
      lastUsedAt: now,
    },
  ]);
}

/** A small count-and-recency boost, which fades to zero after 28 days. */
export function commandFrecencyBoost(
  entry: CommandFrecencyEntry | undefined,
  now: number,
): number {
  if (!entry || !Number.isFinite(now)) return 0;
  const age = Math.max(0, now - entry.lastUsedAt);
  const recency = Math.max(0, 1 - age / DECAY_WINDOW_MS);
  const frequency = Math.min(1, entry.count / COMMAND_FRECENCY_MAX_COUNT);
  return Math.min(
    COMMAND_FRECENCY_MAX_BOOST,
    Math.round(COMMAND_FRECENCY_MAX_BOOST * recency * (0.5 + frequency / 2)),
  );
}
