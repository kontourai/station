import {
  CODING_PANELS_SESSION_BOUND,
  type CodingSessionPanels,
  type CodingSessionPanelsRecord,
} from '@kontourai/station-contracts/device-settings';

/**
 * The per-session Coding panels record (#3051): what the `codingPanels`
 * device setting holds, read and written as a whole. Pure functions, so the
 * device-settings store can validate an imported value with the same parser
 * the layout reads with, and the bound is one number in one place.
 *
 * A session with no entry is closed: no tool beside Chat, no Terminal, the
 * default sizes. That is what a new session starts as.
 */

/** What a session the record does not know starts as. */
export const CLOSED_CODING_SESSION_PANELS: CodingSessionPanels = {
  side: null,
  sideWidth: null,
  terminalOpen: false,
  terminalHeight: null,
  inbox: null,
  at: 0,
};

/** The key a reader with no conversation on screen is remembered under. */
export const NO_SESSION_PANELS_KEY = '~';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteOrNull(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function parseSessionPanels(value: unknown): CodingSessionPanels | null {
  if (!isPlainObject(value)) return null;
  const side =
    value.side === null || value.side === undefined
      ? null
      : typeof value.side === 'string' && value.side.length > 0
        ? value.side
        : undefined;
  const sideWidth = finiteOrNull(value.sideWidth);
  const terminalHeight = finiteOrNull(value.terminalHeight);
  const terminalOpen =
    value.terminalOpen === undefined ? false : value.terminalOpen;
  const inbox =
    value.inbox === undefined || value.inbox === null ? null : value.inbox;
  const at = value.at === undefined ? 0 : value.at;
  if (
    side === undefined ||
    sideWidth === undefined ||
    terminalHeight === undefined ||
    typeof terminalOpen !== 'boolean' ||
    (inbox !== null && typeof inbox !== 'boolean' && inbox !== 'layout') ||
    typeof at !== 'number' ||
    !Number.isFinite(at)
  )
    return null;
  return { side, sideWidth, terminalOpen, terminalHeight, inbox, at };
}

/**
 * A record from storage or an import, or null when it is not one. A session
 * entry that does not parse drops on its own (the rest of the record is
 * still the reader's memory); a record that is not `{version: 1, sessions}`
 * is refused whole. More entries than the bound keep the newest.
 */
export function parseCodingSessionPanelsRecord(
  value: unknown,
): CodingSessionPanelsRecord | null {
  if (!isPlainObject(value) || value.version !== 1) return null;
  if (!isPlainObject(value.sessions)) return null;
  const sessions: Record<string, CodingSessionPanels> = {};
  for (const [key, entry] of Object.entries(value.sessions)) {
    if (!key) continue;
    const parsed = parseSessionPanels(entry);
    if (parsed) sessions[key] = parsed;
  }
  return evictCodingSessionPanels({ version: 1, sessions });
}

/** The session's panels, or the closed default when it has none. */
export function readCodingSessionPanels(
  record: CodingSessionPanelsRecord,
  sessionKey: string,
): CodingSessionPanels {
  return Object.hasOwn(record.sessions, sessionKey)
    ? record.sessions[sessionKey]!
    : CLOSED_CODING_SESSION_PANELS;
}

/**
 * The record with the session's entry patched and touched now, and the
 * oldest entries evicted past the bound. Returns the same record when the
 * patch changes nothing, so a write-through caller can skip the store.
 */
export function writeCodingSessionPanels(
  record: CodingSessionPanelsRecord,
  sessionKey: string,
  patch: Partial<Omit<CodingSessionPanels, 'at'>>,
  now: number,
): CodingSessionPanelsRecord {
  const current = readCodingSessionPanels(record, sessionKey);
  const next: CodingSessionPanels = { ...current, ...patch, at: now };
  const unchanged = (
    ['side', 'sideWidth', 'terminalOpen', 'terminalHeight', 'inbox'] as const
  ).every((field) => current[field] === next[field]);
  if (unchanged && Object.hasOwn(record.sessions, sessionKey)) return record;
  return evictCodingSessionPanels({
    version: 1,
    sessions: { ...record.sessions, [sessionKey]: next },
  });
}

/**
 * At most `CODING_PANELS_SESSION_BOUND` sessions: beyond it the entries
 * touched longest ago (`at`, then insertion order for ties) go.
 */
function evictCodingSessionPanels(
  record: CodingSessionPanelsRecord,
): CodingSessionPanelsRecord {
  const entries = Object.entries(record.sessions);
  if (entries.length <= CODING_PANELS_SESSION_BOUND) return record;
  const kept = entries
    .map(([key, panels], index) => ({ key, panels, index }))
    .sort(
      (left, right) =>
        right.panels.at - left.panels.at || right.index - left.index,
    )
    .slice(0, CODING_PANELS_SESSION_BOUND)
    .sort((left, right) => left.index - right.index);
  return {
    version: 1,
    sessions: Object.fromEntries(kept.map(({ key, panels }) => [key, panels])),
  };
}
