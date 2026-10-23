import {
  LAYOUT_PANELS_LAYOUT_BOUND,
  LAYOUT_PANELS_SESSION_BOUND,
  type LayoutPanelsRecord,
  type LayoutSessionPanels,
} from '@kontourai/station-contracts/device-settings';
import { isRecord } from '../utils/isRecord';

export const CLOSED_LAYOUT_SESSION_PANELS: LayoutSessionPanels = {
  side: null,
  sideWidth: null,
  lowerOpen: false,
  lowerHeight: null,
  inbox: null,
  at: 0,
};
export const NO_SESSION_PANELS_KEY = '~';
function finiteOrNull(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function parseSessionPanels(value: unknown): LayoutSessionPanels | null {
  if (!isRecord(value)) return null;
  const side =
    value.side == null
      ? null
      : typeof value.side === 'string' && value.side.length > 0
        ? value.side
        : undefined;
  const sideWidth = finiteOrNull(value.sideWidth);
  const lowerHeight = finiteOrNull(value.lowerHeight);
  const lowerOpen = value.lowerOpen === undefined ? false : value.lowerOpen;
  const inbox = value.inbox ?? null;
  const at = value.at === undefined ? 0 : value.at;
  if (
    side === undefined ||
    sideWidth === undefined ||
    lowerHeight === undefined ||
    typeof lowerOpen !== 'boolean' ||
    (inbox !== null && typeof inbox !== 'boolean' && inbox !== 'layout') ||
    typeof at !== 'number' ||
    !Number.isFinite(at)
  )
    return null;
  return { side, sideWidth, lowerOpen, lowerHeight, inbox, at };
}

function boundedSessions(sessions: Record<string, LayoutSessionPanels>) {
  const entries = Object.entries(sessions);
  if (entries.length <= LAYOUT_PANELS_SESSION_BOUND) return sessions;
  const kept = entries
    .map(([key, value], index) => ({ key, value, index }))
    .sort((a, b) => b.value.at - a.value.at || b.index - a.index)
    .slice(0, LAYOUT_PANELS_SESSION_BOUND)
    .sort((a, b) => a.index - b.index);
  return Object.fromEntries(kept.map(({ key, value }) => [key, value]));
}

function boundLayouts(record: LayoutPanelsRecord): LayoutPanelsRecord {
  const entries = Object.entries(record.layouts);
  if (entries.length <= LAYOUT_PANELS_LAYOUT_BOUND) return record;
  const kept = entries
    .map(([key, value], index) => ({
      key,
      value,
      index,
      at: Math.max(
        0,
        ...Object.values(value.sessions).map((entry) => entry.at),
      ),
    }))
    .sort((a, b) => b.at - a.at || b.index - a.index)
    .slice(0, LAYOUT_PANELS_LAYOUT_BOUND)
    .sort((a, b) => a.index - b.index);
  return {
    version: 1,
    layouts: Object.fromEntries(kept.map(({ key, value }) => [key, value])),
  };
}

export function parseLayoutPanelsRecord(
  value: unknown,
): LayoutPanelsRecord | null {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.layouts))
    return null;
  const entries: Array<
    [string, { sessions: Record<string, LayoutSessionPanels> }]
  > = [];
  for (const [key, layout] of Object.entries(value.layouts)) {
    if (!key || !isRecord(layout) || !isRecord(layout.sessions)) continue;
    const sessions = Object.fromEntries(
      Object.entries(layout.sessions).flatMap(([id, candidate]) => {
        const parsed = id ? parseSessionPanels(candidate) : null;
        return parsed ? [[id, parsed]] : [];
      }),
    );
    entries.push([key, { sessions: boundedSessions(sessions) }]);
  }
  return boundLayouts({ version: 1, layouts: Object.fromEntries(entries) });
}

function sessionsFor(
  record: LayoutPanelsRecord,
  key: string,
): Record<string, LayoutSessionPanels> {
  return Object.hasOwn(record.layouts, key)
    ? record.layouts[key]!.sessions
    : {};
}

export function readLayoutSessionPanels(
  record: LayoutPanelsRecord,
  layoutKey: string,
  sessionKey: string,
): LayoutSessionPanels {
  const sessions = sessionsFor(record, layoutKey);
  return Object.hasOwn(sessions, sessionKey)
    ? sessions[sessionKey]!
    : CLOSED_LAYOUT_SESSION_PANELS;
}

export function writeLayoutSessionPanels(
  record: LayoutPanelsRecord,
  layoutKey: string,
  sessionKey: string,
  patch: Partial<Omit<LayoutSessionPanels, 'at'>>,
  now: number,
): LayoutPanelsRecord {
  const current = readLayoutSessionPanels(record, layoutKey, sessionKey);
  const next = { ...current, ...patch, at: now };
  if (
    Object.hasOwn(sessionsFor(record, layoutKey), sessionKey) &&
    (['side', 'sideWidth', 'lowerOpen', 'lowerHeight', 'inbox'] as const).every(
      (field) => current[field] === next[field],
    )
  )
    return record;
  return boundLayouts({
    version: 1,
    layouts: {
      ...record.layouts,
      [layoutKey]: {
        sessions: boundedSessions({
          ...sessionsFor(record, layoutKey),
          [sessionKey]: next,
        }),
      },
    },
  });
}
