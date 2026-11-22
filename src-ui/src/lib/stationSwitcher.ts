import type {
  ConnectionFailureReason,
  SavedConnection,
} from '@kontourai/station-connect';
import { PUBLIC_STATION_HANDSHAKE_PATH } from '@kontourai/station-contracts/environment-security';
import { relativeTime } from '../utils/relativeTime';
import { isStationUiProxyUnavailableResponse } from './station-ui-proxy';

const RECENT_KEY = 'station.switcher.recent';
const RECENT_LIMIT = 20;
export const PROBE_TIMEOUT_MS = 2_500;
/** How long an `online` answer is reused; the open menu re-checks after it. */
const PROBE_FRESH_MS = 10_000;

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

/**
 * What a Station's public handshake said, read without credentials:
 * - `online`: a Station handshake answered, so its host is serving.
 * - `recovering`: its UI proxy answered that the host behind it is down or
 *   restarting, so switching now would fail.
 * - `unconfirmed`: something answered, but not a readable Station handshake
 *   (this page's origin is not admitted, or another server is at the address).
 * - `unreachable`: nothing answered before the deadline.
 */
export type StationReachability =
  | 'online'
  | 'recovering'
  | 'unconfirmed'
  | 'unreachable';

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

function isTimeout(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'TimeoutError';
}

function unreachable(error: unknown): StationProbe {
  return {
    reachability: 'unreachable',
    checkedAt: Date.now(),
    failure: isTimeout(error) ? 'timeout' : 'network',
  };
}

function isStationHandshake(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const handshake = body as {
    schemaVersion?: unknown;
    environmentId?: unknown;
  };
  return (
    handshake.schemaVersion === 1 &&
    typeof handshake.environmentId === 'string' &&
    handshake.environmentId.length > 0
  );
}

async function readStationProbe(url: string): Promise<StationProbe> {
  const target = new URL(PUBLIC_STATION_HANDSHAKE_PATH, url);
  const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  const init = {
    credentials: 'omit',
    cache: 'no-store',
    signal,
  } as const satisfies RequestInit;
  let response: Response;
  try {
    response = await fetch(target, {
      ...init,
      mode: 'cors',
      headers: { Accept: 'application/json' },
    });
  } catch (error) {
    if (isTimeout(error)) return unreachable(error);
    // A readable request fails the same way for a dead address, a refused
    // origin, and a UI proxy whose host is down (its 503 carries no CORS
    // headers). An opaque request tells "nothing answered" apart from the
    // rest, but an opaque answer says nothing about the host behind it.
    try {
      await fetch(target, { ...init, mode: 'no-cors' });
      return { reachability: 'unconfirmed', checkedAt: Date.now() };
    } catch (opaqueError) {
      return unreachable(opaqueError);
    }
  }
  try {
    if (response.ok) {
      const body: unknown = await response.json().catch(() => null);
      return {
        reachability: isStationHandshake(body) ? 'online' : 'unconfirmed',
        checkedAt: Date.now(),
      };
    }
    return {
      reachability: (await isStationUiProxyUnavailableResponse(response))
        ? 'recovering'
        : 'unconfirmed',
      checkedAt: Date.now(),
    };
  } catch (error) {
    // The body stopped arriving: the deadline, or a responder that hung up.
    return unreachable(error);
  }
}

/**
 * Whether a Station's public handshake says its host is serving. Only a
 * readable Station handshake is `online`: an answer from a UI proxy whose host
 * is down, or one this page cannot read, is not, so a row never shows healthy
 * for a Station that would fail as soon as it was chosen. An `online` answer is
 * reused briefly so reopening the switcher shows it at once; anything else is
 * not, so a Station that just came back is never shown stale.
 */
export function probeStation(url: string): Promise<StationProbe> {
  const cached = probeCache.get(url);
  if (cached && Date.now() - cached.at < PROBE_FRESH_MS) return cached.result;
  const entry = {
    at: Date.now(),
    result: readStationProbe(url).then((probe) => {
      if (probe.reachability !== 'online' && probeCache.get(url) === entry)
        probeCache.delete(url);
      return probe;
    }),
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
  'authentication-rate-limited': 'sign-in checks temporarily limited',
  'access-scope-refused': 'current access does not cover this check',
  'access-check-unavailable': 'access check could not start',
  'relay-authority-unavailable': 'Station access could not be verified',
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
  if (probe?.reachability === 'recovering') {
    return {
      label: 'Recovering',
      detail: join(
        'server down or restarting',
        `checked ${ago(probe.checkedAt, now)}`,
        lastConnected,
      ),
    };
  }
  if (probe?.reachability === 'unconfirmed') {
    return {
      label: 'Not confirmed',
      detail: join(
        'answered, but not as a Station this page can read',
        `checked ${ago(probe.checkedAt, now)}`,
        lastConnected,
      ),
    };
  }
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
