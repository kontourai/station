import {
  ConnectionStatusDot,
  type SavedConnection,
  useConnections,
} from '@kontourai/station-connect';
import { useEffect, useLayoutEffect, useState } from 'react';
import { toastStore } from '../contexts/ToastContext';
import { useActiveStationName } from '../hooks/useActiveStationName';
import { openConnectionsModal } from '../lib/connectionModalEvents';
import { retainInitialStartup } from '../lib/startup-presentation';
import { readRecentStations } from '../lib/stationSwitcher';
import './StationConnectingScreen.css';

/**
 * How long a Station may take to verify before the screen offers a way out.
 * A healthy Station answers well inside this; the observation read itself
 * may wait far longer (its deadline is the client request timeout).
 */
export const STATION_CONNECTING_SLOW_MS = 6_000;

function hostOf(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function canSwitchTo(connection: SavedConnection): boolean {
  return !(
    connection.injected &&
    (connection.injectedStatus === 'stopped' ||
      connection.injectedStatus === 'failed' ||
      connection.injectedStatus === 'starting')
  );
}

/**
 * What the app shows while the selected Station is being verified, instead of
 * anonymous placeholder cards: which Station, which step, and — once it has
 * taken longer than a Station should — a way to retry, go back, or manage
 * Stations rather than waiting out the request deadline.
 *
 * On a cold launch the launch presentation covers this screen; it is held
 * only until the wait turns slow, so a launch against an unreachable Station
 * lands on these actions instead of a splash that waits out the deadline.
 */
export function StationConnectingScreen({
  step,
  onRetry,
}: {
  /** The current step, e.g. "Checking Station access". */
  step: string;
  /** Restarts the step; omitted where the step cannot be restarted. */
  onRetry?: () => void;
}) {
  const { activeConnection, connections, setActiveConnection } =
    useConnections();
  const displayName = useActiveStationName();
  const host = hostOf(activeConnection?.url);
  const name = displayName || host || 'Station';
  const connectionId = activeConnection?.id;
  const [startedAt, setStartedAt] = useState(Date.now);
  const [now, setNow] = useState(Date.now);
  const [leaving, setLeaving] = useState(false);
  // A new Station, step, or retry is a new wait.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the reset is keyed on these.
  useEffect(() => {
    const start = Date.now();
    setStartedAt(start);
    setNow(start);
    setLeaving(false);
  }, [connectionId, step]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const elapsed = Math.max(0, now - startedAt);
  const slow = elapsed >= STATION_CONNECTING_SLOW_MS;
  useLayoutEffect(
    () => (slow ? undefined : retainInitialStartup(step)),
    [slow, step],
  );

  const recent = readRecentStations();
  const previous = recent
    .map((id) => connections.find((connection) => connection.id === id))
    .find(
      (connection): connection is SavedConnection =>
        connection !== undefined &&
        connection.id !== connectionId &&
        canSwitchTo(connection),
    );
  const previousName = previous ? previous.name || hostOf(previous.url) : '';

  const goBack = () => {
    if (!previous || leaving) return;
    setLeaving(true);
    setActiveConnection(previous.id).catch((error: unknown) => {
      setLeaving(false);
      toastStore.show(
        `Could not switch back to ${previousName}: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        5000,
        undefined,
        undefined,
        'error',
      );
    });
  };
  const retry = () => {
    if (!onRetry) return;
    const start = Date.now();
    setStartedAt(start);
    setNow(start);
    onRetry();
  };

  return (
    <div
      className="station-connecting"
      role="status"
      aria-busy={!slow}
      aria-label={`Connecting to ${name}`}
    >
      <div className="station-connecting__panel">
        <div className="station-connecting__identity">
          <span aria-hidden="true">
            <ConnectionStatusDot
              status={slow ? 'error' : 'connecting'}
              size={10}
            />
          </span>
          <div>
            <h1 className="station-connecting__title">Connecting to {name}</h1>
            {host && host !== name && (
              <p className="station-connecting__host">{host}</p>
            )}
          </div>
        </div>
        {slow ? (
          <p className="station-connecting__message">
            Still waiting after {Math.round(elapsed / 1000)}s. {name} may be
            offline or unreachable from this device.
          </p>
        ) : (
          <p className="station-connecting__message">{step}…</p>
        )}
        {slow && (
          <div className="station-connecting__actions">
            {onRetry && (
              <button
                type="button"
                className="button button--primary"
                onClick={retry}
              >
                Try again
              </button>
            )}
            {previous && (
              <button
                type="button"
                className="button button--secondary"
                disabled={leaving}
                onClick={goBack}
              >
                {leaving ? 'Switching…' : `Back to ${previousName}`}
              </button>
            )}
            <button
              type="button"
              className="button button--secondary"
              onClick={() => openConnectionsModal({ mode: 'list' })}
            >
              Manage Stations
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
