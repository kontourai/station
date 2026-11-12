import {
  ConnectionStatusDot,
  type SavedConnection,
  useConnections,
} from '@kontourai/station-connect';
import { useEffect, useLayoutEffect, useState } from 'react';
import {
  SEEDED_STATION_CONNECTION_NAME,
  useActiveStationName,
} from '../hooks/useActiveStationName';
import { openConnectionsModal } from '../lib/connectionModalEvents';
import { retainInitialStartup } from '../lib/startup-presentation';
import { readRecentStations } from '../lib/stationSwitcher';
import { describeStationFailure } from '../utils/stationFailure';
import { ActionRow } from './ActionRow';
import { Button } from './Button';
import './StationConnectingScreen.css';

/**
 * How long a Station may take before the screen offers a way out. A healthy
 * Station answers well inside this; the observation read itself may wait far
 * longer (its deadline is the client request timeout).
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
 * A saved name. The seeded placeholder names no machine, and the machine name
 * the header shows for it comes from that Station's own status, which is not
 * readable from here, so it is called what it is to the person.
 */
function savedName(connection: SavedConnection): string {
  const name = connection.name?.trim();
  return name && name !== SEEDED_STATION_CONNECTION_NAME
    ? name
    : 'previous Station';
}

/**
 * What the app shows while the selected Station is being verified, instead of
 * anonymous placeholder cards: which Station, which step, and, once it has
 * taken longer than a Station should, a way to retry, go back, or manage
 * Stations rather than waiting out the request deadline.
 *
 * The caller keys this on the Station and step, so each wait starts fresh.
 * On a cold launch the launch presentation covers this screen; it is held
 * only until the wait turns slow, so a launch against an unreachable Station
 * lands on these actions instead of a splash that waits out the deadline.
 */
export function StationConnectingScreen({
  step,
  onRetry,
  answered = false,
}: {
  /** The current step, e.g. "Checking Station access". */
  step: string;
  /** Restarts the step; omitted where the step cannot be restarted. */
  onRetry?: () => void;
  /** The Station already answered and only its data is still loading. */
  answered?: boolean;
}) {
  const { activeConnection, connections, setActiveConnection } =
    useConnections();
  const displayName = useActiveStationName();
  const host = hostOf(activeConnection?.url);
  const name =
    (displayName && displayName !== SEEDED_STATION_CONNECTION_NAME
      ? displayName
      : host) || 'Station';
  const connectionId = activeConnection?.id;
  const [startedAt, setStartedAt] = useState(Date.now);
  const [now, setNow] = useState(Date.now);
  const [leaving, setLeaving] = useState(false);
  const [backError, setBackError] = useState<string | null>(null);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const slow = now - startedAt >= STATION_CONNECTING_SLOW_MS;
  useLayoutEffect(
    () => (slow ? undefined : retainInitialStartup(step)),
    [slow, step],
  );

  const previous = readRecentStations()
    .map((id) => connections.find((connection) => connection.id === id))
    .find(
      (connection): connection is SavedConnection =>
        connection !== undefined &&
        connection.id !== connectionId &&
        canSwitchTo(connection),
    );
  const previousName = previous ? savedName(previous) : '';

  const goBack = () => {
    if (!previous || leaving) return;
    setLeaving(true);
    setBackError(null);
    // The toast layer lives in the tree this screen stands in for, so a
    // failure is shown here.
    setActiveConnection(previous.id).catch((error: unknown) => {
      setLeaving(false);
      setBackError(
        `Could not switch to ${previousName}: ${describeStationFailure(error).body}`,
      );
    });
  };
  const retry = () => {
    if (!onRetry) return;
    const start = Date.now();
    setStartedAt(start);
    setNow(start);
    setBackError(null);
    onRetry();
  };

  const manageStations = () => openConnectionsModal({ mode: 'list' });
  const labelled = [
    onRetry && (
      <Button key="retry" variant="primary" onClick={retry}>
        Try again
      </Button>
    ),
    previous && (
      <Button key="back" disabled={leaving} onClick={goBack}>
        {leaving ? 'Switching…' : `Back to ${previousName}`}
      </Button>
    ),
    <Button key="manage" onClick={manageStations}>
      Manage Stations
    </Button>,
  ].filter(Boolean);

  const message = !slow
    ? `${step}…`
    : answered
      ? `${name} answered, but is still loading its data.`
      : `Still no answer from ${name}. It may be offline or unreachable from this device.`;

  return (
    <div className="station-connecting" aria-busy={!slow}>
      <div className="station-connecting__panel">
        <div className="station-connecting__identity">
          <span aria-hidden="true">
            <ConnectionStatusDot
              status={slow && !answered ? 'error' : 'connecting'}
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
        {/* Only the sentence is live, so it is announced when it changes and
            the actions below are not read out as status. */}
        <p className="station-connecting__message" role="status">
          {message}
        </p>
        {slow && (
          // Two labelled actions at most (#3045): retrying and going back are
          // the likely next steps, so Manage Stations takes a button only
          // when one of them is unavailable and otherwise waits in the menu.
          <ActionRow
            className="station-connecting__actions"
            overflowLabel="More Station actions"
            primary={labelled[0]}
            secondary={labelled[1]}
            overflow={
              labelled.length > 2
                ? [
                    {
                      key: 'manage',
                      label: 'Manage Stations',
                      haspopup: 'dialog',
                      onSelect: manageStations,
                    },
                  ]
                : []
            }
          />
        )}
        {backError && (
          <p className="station-connecting__error" role="alert">
            {backError}
          </p>
        )}
      </div>
    </div>
  );
}
