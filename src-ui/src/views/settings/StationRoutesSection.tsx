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
import {
  isTrustedConsentOrigin,
  type StationRoutePublication,
} from '@kontourai/station-contracts/station-routes';
import {
  useConfigQuery,
  useUpdateConfigMutation,
} from '@kontourai/station-sdk';
import { Badge, Field } from '@kontourai/ui/react';
import { type FormEvent, useState } from 'react';
import { ActionRow } from '../../components/ActionRow';
import { Button } from '../../components/Button';
import {
  useStationRoutesPreview,
  useStationRoutesQuery,
} from '../../components/connections/useStationRoutes';
import { ErrorState, SkeletonBlock } from '../../components/state';
import { useUnsavedGuard } from '../../hooks/useUnsavedGuard';
import {
  checkServerHealth,
  probeServerConnection,
} from '../../lib/serverHealth';
import { describeStationFailure } from '../../utils/stationFailure';
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
  const reported = useStationRoutesQuery(connection, true);
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
  const extra = (reported.data?.routes ?? []).filter(
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
      setError(
        cause instanceof Error &&
          cause.message ===
            'Enter an address that starts with http:// or https://.'
          ? 'Enter an address that starts with http:// or https://.'
          : describeStationFailure(cause).body,
      );
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
        {reported.isPending && (
          <SkeletonBlock count={1} label="Reading published routes" />
        )}
        {reported.isError && (
          <ErrorState
            variant="compact"
            title="Published routes could not be refreshed"
            action={
              <Button size="sm" onClick={() => void reported.refetch()}>
                Retry published routes
              </Button>
            }
          />
        )}
        {reported.data?.publication && (
          <RoutePublication
            key={connection.id}
            publication={reported.data.publication}
            refresh={() => void reported.refetch()}
          />
        )}
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

const PUBLICATION_STATUS: Record<StationRoutePublication['status'], string> = {
  ready: 'Approval HTTPS route ready',
  unavailable: 'Approval HTTPS route unavailable',
  ambiguous: 'Multiple approval HTTPS routes found; choose an origin',
  disabled: 'Approval HTTPS publication disabled',
};

function RoutePublication({
  publication,
  refresh,
}: {
  publication: StationRoutePublication;
  refresh: () => void;
}) {
  const config = useConfigQuery();
  const update = useUpdateConfigMutation();
  const savedOrigin = config.data?.trustedConsentOrigin;
  const saved = savedOrigin ?? '';
  const [draft, setDraft] = useState<string>();
  const origin = draft ?? saved;
  const dirty =
    draft !== undefined && (origin !== saved || savedOrigin === undefined);
  const { DiscardModal } = useUnsavedGuard(dirty);
  const invalid = origin !== '' && !isTrustedConsentOrigin(origin);
  const unavailable = config.isPending || config.isError || !config.data;

  return (
    <div className="content-stack">
      <p className="settings__section-note">
        App routes connect this device to a Station; approval pages use a separate
        HTTPS origin.
      </p>
      <p role="status">
        <Badge value={PUBLICATION_STATUS[publication.status]} />
      </p>
      <p className="station-routes__meta">
        Approval origin: {publication.consentOrigin ?? 'None available'}
        {' · '}Source: {publication.source}
      </p>
      <div>
        <p>Published app origins</p>
        {publication.appOrigins.length === 0 ? (
          <p className="station-routes__meta">None published</p>
        ) : (
          publication.appOrigins.map((appOrigin) => (
            <p key={appOrigin} className="station-routes__meta">
              {appOrigin}
            </p>
          ))
        )}
      </div>
      {publication.status === 'unavailable' && (
        <details>
          <summary>Set up HTTPS</summary>
          <p className="settings__section-note">
            Install and sign in to Tailscale on the Station host if needed.
          </p>
          <p className="settings__section-note">
            Manually configure an HTTPS mapping with Tailscale Serve or your
            HTTPS proxy, then refresh.
          </p>
        </details>
      )}
      <form
        className="content-stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (invalid || unavailable || update.isPending || !dirty) return;
          update.mutate(
            { trustedConsentOrigin: origin },
            {
              onSuccess: () => {
                setDraft(undefined);
                refresh();
              },
            },
          );
        }}
      >
        <Field
          label="Approval HTTPS origin"
          htmlFor="trusted-consent-origin"
          hint="Saving an empty origin enables automatic discovery instead of the startup fallback. Only this Station’s local operator can save changes."
        >
          <input
            id="trusted-consent-origin"
            className="station-routes__input"
            type="text"
            inputMode="url"
            value={origin}
            placeholder="Automatic discovery"
            aria-describedby="trusted-consent-origin-help"
            aria-invalid={invalid}
            disabled={unavailable || update.isPending}
            onChange={(event) => setDraft(event.target.value)}
          />
        </Field>
        <Button
          type="button"
          size="sm"
          disabled={
            unavailable ||
            update.isPending ||
            (savedOrigin === '' && origin === '')
          }
          onClick={() => setDraft('')}
        >
          Use automatic discovery
        </Button>
        <details>
          <summary>Origin setup</summary>
          <p
            id="trusted-consent-origin-help"
            className="settings__section-note"
          >
            Use an exact HTTPS DNS origin with no path, credentials, query, or
            fragment.
          </p>
          <p className="settings__section-note">
            STATION_TRUSTED_CONSENT_ORIGIN remains a fallback when this setting
            is absent.
          </p>
          <p className="settings__section-note">
            Publishing an origin does not grant access or configure HTTPS.
          </p>
        </details>
        {invalid && (
          <p role="alert">
            Enter an exact HTTPS DNS origin, or leave empty for automatic
            discovery.
          </p>
        )}
        {config.isPending && (
          <SkeletonBlock count={1} label="Reading approval origin setting" />
        )}
        {config.isError && (
          <ErrorState
            variant="compact"
            title="The approval origin setting could not be read"
            action={
              <Button size="sm" onClick={() => void config.refetch()}>
                Retry setting
              </Button>
            }
          />
        )}
        {update.isError && (
          <p role="alert">{describeStationFailure(update.error).body}</p>
        )}
        <ActionRow
          overflowLabel="More approval route actions"
          primary={
            <Button
              type="submit"
              size="sm"
              disabled={unavailable || invalid || !dirty || update.isPending}
            >
              {update.isPending ? 'Saving…' : 'Save approval origin'}
            </Button>
          }
          secondary={
            dirty ? (
              <Button
                size="sm"
                disabled={update.isPending}
                onClick={() => setDraft(undefined)}
              >
                Cancel
              </Button>
            ) : (
              <Button size="sm" onClick={refresh}>
                Refresh published routes
              </Button>
            )
          }
          overflow={
            dirty
              ? [
                  {
                    key: 'refresh',
                    label: 'Refresh published routes',
                    onSelect: refresh,
                  },
                ]
              : []
          }
        />
      </form>
      <DiscardModal />
    </div>
  );
}
