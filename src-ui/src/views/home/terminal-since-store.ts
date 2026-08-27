/**
 * Persists "when did this item first go terminal" (station#1099 review, AC3
 * fix). Without this, `terminalSinceRef` was in-memory only — a reload
 * re-anchored every currently-terminal item's linger clock to "now", so a
 * long-settled item would re-linger in the active lane for another
 * `TERMINAL_LINGER_MS` after every reload instead of landing straight in the
 * settled tail. Same localStorage-map pattern as
 * `utils/activity-snooze-store.ts`, kept as its own module (not shared)
 * because this key space is Home-lane-specific, unlike snooze, which the
 * mobile chat-dock inbox also observes.
 */

const TERMINAL_SINCE_STORAGE_KEY = 'station.activity.terminalSince';

/** item id -> epoch ms of the first observed terminal transition. */
export type TerminalSinceMap = Record<string, number>;

/**
 * `maxAgeMs` prunes anchors older than the linger window plus a safety
 * margin on read: an item that lingered past that point is settled
 * regardless of the exact anchor value. When an old terminal item appears
 * after pruning, `useHomeWorkLanes` seeds its anchor from the item's
 * authoritative `updatedAt`, so pruning does not make it recent again.
 */
export function readTerminalSince(
  now: number,
  maxAgeMs: number,
): TerminalSinceMap {
  try {
    const raw = localStorage.getItem(TERMINAL_SINCE_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, number] =>
          typeof entry[1] === 'number' && now - entry[1] <= maxAgeMs,
      ),
    );
  } catch {
    return {};
  }
}

export function writeTerminalSince(map: TerminalSinceMap): void {
  try {
    localStorage.setItem(TERMINAL_SINCE_STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* ignore — source timestamps still classify historical work correctly */
  }
}
