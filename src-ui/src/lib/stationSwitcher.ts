import type {
  ConnectionFailureReason,
  SavedConnection,
} from '@kontourai/station-connect';
import { PUBLIC_STATION_HANDSHAKE_PATH } from '@kontourai/station-contracts/environment-security';
import { relativeTime } from '../utils/relativeTime';

const RECENT_KEY = 'station.switcher.recent';
const RECENT_LIMIT = 20;
export const PROBE_TIMEOUT_MS = 2_500;
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
    .sort(
      (a, b) => rank(a.connection) - rank(b.connection) || a.index - b.index,
    )
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

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Whether a Station's address can be probed directly from this client. An
 * HTTPS page cannot reach a plain-HTTP address other than loopback (mixed
 * content), so that failure would say nothing about the Station.
 */
export function isProbeable(
  connection: SavedConnection,
  pageProtocol = window.location.protocol,
): boolean {
  if (connection.brokerRoute || connection.nativeBrokerRoute) return false;
  let target: URL;
  try {
    target = new URL(connection.url);
  } catch {
    return false;
  }
  if (target.protocol === 'https:') return true;
  if (target.protocol !== 'http:') return false;
  return pageProtocol !== 'https:' || LOOPBACK_HOSTS.has(target.hostname);
}

/** What one probe learned, and when it learned it. */
export interface StationProbe {
  reachability: StationReachability;
  /** When the probe settled (epoch ms). */
  checkedAt: number;
  /** Why an unreachable probe failed: its deadline, or a network error. */
  failure?: 'timeout' | 'network';
}

const probeCache = new Map<
  string,
  { at: number; result: Promise<StationProbe> }
>();

/**
 * Whether anything answers at a Station's public handshake. Any HTTP response
 * counts as online; only a network failure or the deadline is unreachable.
 * An answer is reused briefly so reopening the switcher shows it at once; a
 * failure is not, so a Station that just came back is never shown stale.
 */
export function probeStation(url: string): Promise<StationProbe> {
  const cached = probeCache.get(url);
  if (cached && Date.now() - cached.at < PROBE_FRESH_MS) return cached.result;
  const entry = {
    at: Date.now(),
    result: fetch(new URL(PUBLIC_STATION_HANDSHAKE_PATH, url), {
      mode: 'no-cors',
      credentials: 'omit',
      cache: 'no-store',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    }).then(
      (): StationProbe => ({ reachability: 'online', checkedAt: Date.now() }),
      (error: unknown): StationProbe => {
        if (probeCache.get(url) === entry) probeCache.delete(url);
        return {
          reachability: 'unreachable',
          checkedAt: Date.now(),
          // A no-cors fetch hides everything else about a failure.
          failure:
            error instanceof DOMException && error.name === 'TimeoutError'
              ? 'timeout'
              : 'network',
        };
      },
    ),
  };
  probeCache.set(url, entry);
  return entry.result;
}

export function forgetStationProbe(url: string): void {
  probeCache.delete(url);
}

/**
 * A few words for each failure reason, sized for a menu row. The full
 * sentences (`connectionFailureCopy`) name the host and say what to do; a row
 * already shows the name, and Manage Stations owns the remedy. Keyed by the
 * whole union so a new reason cannot ship without its phrase.
 */
const FAILURE_PHRASE: Record<ConnectionFailureReason, string> = {
  offline: 'this device is offline',
  'mixed-content': 'insecure address from this page',
  'invalid-endpoint': 'not a Station address',
  'identity-mismatch': 'a different Station answered',
  'access-method-mismatch': 'reached a different way',
  'authentication-failed': 'this device was refused',
  'unsupported-capability-version': 'Station needs an update',
  'client-protocol-unsupported': 'this app needs an update',
  timeout: 'no answer in time',
  unreachable: 'nothing answered',
  'server-restarted': 'Station restarted',
  'host-unavailable': 'server down or recovering',
  'origin-not-allowed': "won't accept this app",
  'unexpected-response': "didn't answer as a Station",
  undetermined: 'connection not confirmed',
  busy: 'answering slowly',
  'awaiting-approval': 'awaiting approval',
};

export function failurePhrase(reason: ConnectionFailureReason): string {
  return FAILURE_PHRASE[reason];
}

/** "just now", "4m ago", "2d ago", or a short date past a week. */
export function ago(at: number, now: number): string {
  const text = relativeTime(at, now);
  if (text === 'now') return 'just now';
  return /^\d/.test(text) ? `${text} ago` : text;
}

/** This device has no accepted credential for the Station. */
export function needsAccess(connection: SavedConnection): boolean {
  return (
    connection.credentialState === 'required' ||
    connection.lastError?.reason === 'authentication-failed'
  );
}

export interface StationRowStatus {
  /** The state in a word or two; also the row's accessible description. */
  label: string;
  /** Why, and when that was learned; empty when there is nothing to add. */
  detail: string;
}

export interface StationRowInput {
  connection: SavedConnection;
  now: number;
  switching: boolean;
  /** Present only for the active Station, from its health coordinator. */
  active?: {
    label: string;
    reason: ConnectionFailureReason | null;
    healthy: boolean;
    checkedAt: number | null;
  };
  probeable: boolean;
  probe?: StationProbe;
}

function join(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' · ');
}

/**
 * One row of the Station switcher: what state a Station is in, why, and when
 * that was last learned. The active Station reads its live health check; any
 * other reads the probe this opening ran, and failing that, the last result
 * this device saved, always with its age, so an old answer never reads as
 * current.
 */
export function describeStationRow({
  connection,
  now,
  switching,
  active,
  probeable,
  probe,
}: StationRowInput): StationRowStatus {
  if (switching) return { label: 'Switching…', detail: '' };
  const lastConnected = connection.lastSuccessAt
    ? `last connected ${ago(connection.lastSuccessAt, now)}`
    : '';
  if (active) {
    return {
      label: active.label,
      detail: join(
        !active.healthy && active.reason && failurePhrase(active.reason),
        active.checkedAt !== null && `checked ${ago(active.checkedAt, now)}`,
      ),
    };
  }
  if (connection.injected && connection.injectedStatus) {
    if (connection.injectedStatus === 'starting')
      return { label: 'Starting…', detail: '' };
    if (connection.injectedStatus === 'failed')
      return { label: 'Failed to start', detail: '' };
    if (connection.injectedStatus === 'stopped')
      return { label: 'Not running', detail: '' };
  }
  if (needsAccess(connection)) {
    return {
      label: 'Needs access',
      detail: connection.lastError
        ? `refused ${ago(connection.lastError.at, now)}`
        : '',
    };
  }
  if (probe?.reachability === 'online')
    return { label: 'Online', detail: `checked ${ago(probe.checkedAt, now)}` };
  if (probe?.reachability === 'unreachable') {
    return {
      label: 'Unreachable',
      detail: join(
        probe.failure === 'timeout' ? 'no answer in time' : 'nothing answered',
        `checked ${ago(probe.checkedAt, now)}`,
        lastConnected,
      ),
    };
  }
  if (probeable) return { label: 'Checking…', detail: lastConnected };
  // Not probeable from here (a broker route, or plain HTTP from an HTTPS
  // page): the last thing this device saw is all there is, so say how old it is.
  if (connection.lastError) {
    return {
      label: "Can't connect",
      detail: join(
        failurePhrase(connection.lastError.reason),
        ago(connection.lastError.at, now),
        lastConnected,
      ),
    };
  }
  return { label: 'Not checked', detail: lastConnected };
}
