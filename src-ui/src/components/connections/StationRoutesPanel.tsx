import type { ConnectionFailureReason } from '@kontourai/station-connect';
import {
  CONNECTION_ROUTE_LABELS,
  type ConnectionRouteResult,
  connectionAcceptsRoutes,
  connectionFailureCopy,
  connectionRouteKind,
  connectionRouteRemovable,
  type SavedConnection,
  useConnectionStatus,
  useConnections,
} from '@kontourai/station-connect';
import { type SemanticTone, StatusBadge } from '@kontourai/ui/react';
import { type FormEvent, useId, useState } from 'react';
import {
  checkServerHealth,
  probeServerConnection,
} from '../../lib/serverHealth';
import { Button } from '../Button';
import {
  useStationRoutesPreview,
  useStationRoutesQuery,
} from './useStationRoutes';
import './StationRoutesPanel.css';

function reasonText(reason: ConnectionFailureReason, host: string): string {
  if (reason === 'awaiting-approval') return 'Waiting for approval';
  const copy = connectionFailureCopy(reason, host);
  return copy.short ?? copy.summary;
}

function routeBadge(result: ConnectionRouteResult | undefined): {
  label: string;
  tone: SemanticTone;
} {
  if (!result || result.state === 'not-checked') {
    return { label: 'Not checked', tone: 'neutral' };
  }
  if (result.state === 'in-use') return { label: 'In use', tone: 'positive' };
  if (result.state === 'blocked') {
    return { label: "Can't use here", tone: 'neutral' };
  }
  return result.reason === 'identity-mismatch'
    ? { label: 'Different Station', tone: 'negative' }
    : { label: 'Unreachable', tone: 'caution' };
}

/**
 * Station routes (docs/design/station-routes.md): every address this saved
 * Station is reached on, which one is in use, and why the others are not.
 * Shown in the Station's details in the connection manager, behind the
 * Station routes preview.
 */
export function StationRoutesPanel({
  connection,
}: {
  connection: SavedConnection;
}) {
  return useStationRoutesPreview() ? (
    <StationRoutes connection={connection} />
  ) : null;
}

function StationRoutes({ connection }: { connection: SavedConnection }) {
  const { activeConnection, addRoute, removeRoute } = useConnections();
  const health = useConnectionStatus({
    checkHealth: checkServerHealth,
    probeEndpoint: probeServerConnection,
    pollInterval: 10_000,
  });
  const isActive = activeConnection?.id === connection.id;
  const editable = connectionAcceptsRoutes(connection) && Boolean(addRoute);
  // A profile that keeps one fixed route still shows what the Station reports.
  const reported = useStationRoutesQuery(connection, isActive && !editable);
  const [address, setAddress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();

  const host = connection.name || connection.url;
  const results = new Map(
    (isActive ? health.routes : []).map((result) => [
      result.endpointId,
      result,
    ]),
  );
  const routes = [...connection.endpoints].sort(
    (a, b) =>
      Number(b.id === connection.selectedEndpointId) -
        Number(a.id === connection.selectedEndpointId) ||
      a.priority - b.priority,
  );
  const inUse = routes.find(
    (endpoint) => results.get(endpoint.id)?.state === 'in-use',
  );
  const status = !isActive
    ? 'Not the current Station'
    : health.status === 'connected'
      ? inUse
        ? `Connected over ${CONNECTION_ROUTE_LABELS[connectionRouteKind(inUse)]}`
        : 'Connected'
      : health.status === 'error' && health.reason
        ? `Couldn't connect. ${reasonText(health.reason, host)}`
        : 'Checking routes…';
  const extra = (reported.data ?? []).filter(
    (route) =>
      !connection.endpoints.some((endpoint) => endpoint.url === route.url),
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      addRoute?.(connection.id, address);
      setAddress('');
      if (isActive) health.recheck();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <section className="station-routes" aria-label={`Routes for ${host}`}>
      <p className="station-routes__status" role="status">
        {status}
      </p>
      <h4 className="station-routes__title">Routes</h4>
      <ul className="station-routes__list">
        {routes.map((endpoint) => {
          const result = results.get(endpoint.id);
          const badge = routeBadge(result);
          const kind = connectionRouteKind(endpoint);
          const detail = [
            endpoint.source === 'advertised' ? 'Found automatically' : null,
            result?.reason && result.state !== 'in-use'
              ? reasonText(result.reason, host)
              : null,
          ].filter(Boolean);
          return (
            <li key={endpoint.id} className="station-routes__row">
              <div className="station-routes__main">
                <span className="station-routes__label">
                  {CONNECTION_ROUTE_LABELS[kind]}
                </span>
                <span className="station-routes__address">{endpoint.url}</span>
                {detail.length > 0 && (
                  <span className="station-routes__detail">
                    {detail.join(' · ')}
                  </span>
                )}
              </div>
              <div className="station-routes__aside">
                <StatusBadge status={badge.label} tone={badge.tone} />
                {editable && connectionRouteRemovable(connection, endpoint) && (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove route ${endpoint.url}`}
                    onClick={() => {
                      removeRoute?.(connection.id, endpoint.id);
                      if (isActive) health.recheck();
                    }}
                  >
                    Remove
                  </Button>
                )}
              </div>
            </li>
          );
        })}
        {extra.map((route) => (
          <li key={route.url} className="station-routes__row">
            <div className="station-routes__main">
              <span className="station-routes__label">
                {
                  CONNECTION_ROUTE_LABELS[
                    connectionRouteKind({ url: route.url, kind: 'manual' })
                  ]
                }
              </span>
              <span className="station-routes__address">{route.url}</span>
              <span className="station-routes__detail">
                Found automatically · Not used by this app yet
              </span>
            </div>
          </li>
        ))}
      </ul>
      {editable && (
        <form className="station-routes__add" onSubmit={submit}>
          <label htmlFor={inputId} className="station-routes__add-label">
            Add route
          </label>
          <div className="station-routes__add-row">
            <input
              id={inputId}
              type="url"
              inputMode="url"
              className="station-routes__input"
              placeholder="http://100.64.0.1:3141"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
            />
            <Button type="submit" size="sm" disabled={!address.trim()}>
              Add
            </Button>
          </div>
          {error && (
            <p className="station-routes__error" role="alert">
              {error}
            </p>
          )}
        </form>
      )}
    </section>
  );
}
