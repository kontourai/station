import {
  CONNECTION_ROUTE_LABELS,
  type ConnectionFailureReason,
  type ConnectionRouteResult,
  connectionAcceptsRoutes,
  connectionFailureCopy,
  connectionRouteKind,
  connectionRouteRemovable,
  type SavedConnection,
  useConnectionStatus,
  useConnections,
} from '@kontourai/station-connect';
import { Badge } from '@kontourai/ui/react';
import { type FormEvent, useState } from 'react';
import { Button } from '../../components/Button';
import {
  useStationRoutesPreview,
  useStationRoutesQuery,
} from '../../components/connections/useStationRoutes';
import {
  checkServerHealth,
  probeServerConnection,
} from '../../lib/serverHealth';
import { SettingsSection } from './SettingsSection';
import { settingsRow } from './settings-catalog';
import './StationRoutesSection.css';

function reasonText(reason: ConnectionFailureReason, host: string): string {
  if (reason === 'awaiting-approval') return 'Waiting for approval';
  const copy = connectionFailureCopy(reason, host);
  return copy.short ?? copy.summary;
}

/** Only what differs from the obvious: a route that failed, and how. */
function routeNote(result: ConnectionRouteResult | undefined): string | null {
  if (result?.state === 'blocked') return "can't use here";
  if (result?.state !== 'failed') return null;
  return result.reason === 'identity-mismatch'
    ? 'different Station'
    : 'unreachable';
}

/**
 * Settings › Devices › Routes (docs/design/station-routes.md): every address
 * this device reaches the current Station on, and which one is in use.
 * Behind the Station routes preview.
 */
export function StationRoutesSection() {
  const { activeConnection } = useConnections();
  if (!useStationRoutesPreview() || !activeConnection) return null;
  return <StationRoutes connection={activeConnection} />;
}

function StationRoutes({ connection }: { connection: SavedConnection }) {
  const { addRoute, removeRoute } = useConnections();
  const health = useConnectionStatus({
    checkHealth: checkServerHealth,
    probeEndpoint: probeServerConnection,
    pollInterval: 10_000,
  });
  const editable = connectionAcceptsRoutes(connection) && Boolean(addRoute);
  // A profile that keeps one fixed route still lists what the Station reports.
  const reported = useStationRoutesQuery(connection, !editable);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [address, setAddress] = useState('');
  const [error, setError] = useState<string | null>(null);

  const host = connection.name || connection.url;
  const results = new Map(
    health.routes.map((result) => [result.endpointId, result]),
  );
  const routes = [...connection.endpoints].sort(
    (a, b) =>
      Number(b.id === connection.selectedEndpointId) -
        Number(a.id === connection.selectedEndpointId) ||
      a.priority - b.priority,
  );
  const removable = editable
    ? routes.filter((endpoint) =>
        connectionRouteRemovable(connection, endpoint),
      )
    : [];
  const extra = (reported.data ?? []).filter(
    (route) =>
      !connection.endpoints.some((endpoint) => endpoint.url === route.url),
  );
  const failure =
    health.status === 'error' && health.reason
      ? reasonText(health.reason, host)
      : null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      addRoute?.(connection.id, address);
      setAddress('');
      setAdding(false);
      health.recheck();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <SettingsSection
      icon="◉"
      title="Routes"
      id="section-station-routes"
      action={
        removable.length > 0 ? (
          <Button
            variant="link"
            size="sm"
            onClick={() => setEditing((value) => !value)}
          >
            {editing ? 'Done' : 'Edit'}
          </Button>
        ) : undefined
      }
    >
      <div
        {...settingsRow('station-routes')}
        tabIndex={-1}
        className="station-routes"
      >
        {failure && (
          <p className="station-routes__failure" role="status">
            {failure}
          </p>
        )}
        <ul className="station-routes__list">
          {routes.map((endpoint) => {
            const result = results.get(endpoint.id);
            const label =
              CONNECTION_ROUTE_LABELS[connectionRouteKind(endpoint)];
            const meta = [
              endpoint.url,
              endpoint.source === 'advertised' ? 'found automatically' : null,
              routeNote(result),
            ].filter(Boolean);
            return (
              <li key={endpoint.id} className="station-routes__row">
                <div className="station-routes__body">
                  <span className="station-routes__name">
                    {label}
                    {result?.state === 'in-use' && (
                      <Badge value="In use" tone="positive" />
                    )}
                  </span>
                  <span className="station-routes__meta">
                    {meta.join(' · ')}
                  </span>
                </div>
                {editing && removable.includes(endpoint) && (
                  <Button
                    variant="link"
                    size="sm"
                    className="station-routes__remove"
                    aria-label={`Remove ${label} route ${endpoint.url}`}
                    onClick={() => {
                      removeRoute?.(connection.id, endpoint.id);
                      health.recheck();
                    }}
                  >
                    Remove
                  </Button>
                )}
              </li>
            );
          })}
          {extra.map((route) => (
            <li key={route.url} className="station-routes__row">
              <div className="station-routes__body">
                <span className="station-routes__name">
                  {
                    CONNECTION_ROUTE_LABELS[
                      connectionRouteKind({ url: route.url, kind: 'manual' })
                    ]
                  }
                </span>
                <span className="station-routes__meta">
                  {route.url} · found automatically · not used by this app yet
                </span>
              </div>
            </li>
          ))}
        </ul>
        {editable &&
          (adding ? (
            <form className="station-routes__add" onSubmit={submit}>
              <input
                type="url"
                inputMode="url"
                aria-label="Route address"
                className="station-routes__input"
                placeholder="http://100.64.0.1:3141"
                value={address}
                // biome-ignore lint/a11y/noAutofocus: opened by an explicit Add route press
                autoFocus
                onChange={(event) => setAddress(event.target.value)}
              />
              <Button
                type="submit"
                variant="link"
                size="sm"
                disabled={!address.trim()}
              >
                Add
              </Button>
              <Button
                variant="link"
                size="sm"
                onClick={() => {
                  setAdding(false);
                  setAddress('');
                  setError(null);
                }}
              >
                Cancel
              </Button>
              {error && (
                <p className="station-routes__error" role="alert">
                  {error}
                </p>
              )}
            </form>
          ) : (
            <Button
              variant="link"
              size="sm"
              className="station-routes__add-route"
              onClick={() => setAdding(true)}
            >
              + Add route
            </Button>
          ))}
      </div>
    </SettingsSection>
  );
}
