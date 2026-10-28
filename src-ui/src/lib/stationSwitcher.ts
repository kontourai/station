import type { SavedConnection } from '@kontourai/station-connect';
import { PUBLIC_STATION_HANDSHAKE_PATH } from '@kontourai/station-contracts/environment-security';

const RECENT_KEY = 'station.switcher.recent';
const RECENT_LIMIT = 20;
const PROBE_TIMEOUT_MS = 2_500;
const PROBE_FRESH_MS = 30_000;

/** Saved Station ids, most recently used first. */
export function readRecentStations(): string[] {
  try {
    const parsed: unknown = JSON.parse(
      window.localStorage.getItem(RECENT_KEY) ?? '[]',
    );
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === 'string')
      : [];
  } catch {
    return [];
  }
}

export function recordStationUse(id: string): void {
  const recent = [id, ...readRecentStations().filter((item) => item !== id)];
  try {
    window.localStorage.setItem(
      RECENT_KEY,
      JSON.stringify(recent.slice(0, RECENT_LIMIT)),
    );
  } catch {
    // Ordering is a convenience; a full or blocked storage keeps saved order.
  }
}

/** The active Station first, then by most recent use, then in saved order. */
export function orderStations(
  connections: readonly SavedConnection[],
  activeId: string | undefined,
  recent: readonly string[],
): SavedConnection[] {
  const rank = (connection: SavedConnection) => {
    if (connection.id === activeId) return -1;
    const index = recent.indexOf(connection.id);
    return index < 0 ? recent.length : index;
  };
  return connections
    .map((connection, index) => ({ connection, index }))
    .sort((a, b) => rank(a.connection) - rank(b.connection) || a.index - b.index)
    .map(({ connection }) => connection);
}

export function matchesStationFilter(
  connection: SavedConnection,
  filter: string,
): boolean {
  const needle = filter.trim().toLowerCase();
  if (!needle) return true;
  return `${connection.name} ${connection.url}`.toLowerCase().includes(needle);
}

export type StationReachability = 'online' | 'unreachable';

/** Whether a Station's address can be probed directly from this client. */
export function isProbeable(connection: SavedConnection): boolean {
  return (
    !connection.brokerRoute &&
    !connection.nativeBrokerRoute &&
    /^https?:/.test(connection.url)
  );
}

const probeCache = new Map<
  string,
  { at: number; result: Promise<StationReachability> }
>();

/**
 * Whether anything answers at a Station's public handshake. Any HTTP response
 * counts as online; only a network failure or the deadline is unreachable.
 * Results are reused briefly so reopening the switcher shows them at once.
 */
export function probeStation(url: string): Promise<StationReachability> {
  const cached = probeCache.get(url);
  if (cached && Date.now() - cached.at < PROBE_FRESH_MS) return cached.result;
  const result = fetch(new URL(PUBLIC_STATION_HANDSHAKE_PATH, url), {
    mode: 'no-cors',
    credentials: 'omit',
    cache: 'no-store',
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  }).then(
    () => 'online' as const,
    () => 'unreachable' as const,
  );
  probeCache.set(url, { at: Date.now(), result });
  return result;
}

export function forgetStationProbe(url: string): void {
  probeCache.delete(url);
}
