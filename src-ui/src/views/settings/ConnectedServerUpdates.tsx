import type { ConnectedServerUpdateContext } from '../../hooks/useConnectedServerUpdateContext';
import { useConnectedServerUpdateContext } from '../../hooks/useConnectedServerUpdateContext';
import { usePlatformProfile } from '../../platform/PlatformProfileContext';
import { CoreUpdateCheck } from './CoreUpdateCheck';

function serverHost(apiBase: string): string {
  try {
    return new URL(apiBase).host;
  } catch {
    return apiBase;
  }
}

function ServerIdentitySummary({
  context,
}: {
  context: ConnectedServerUpdateContext;
}) {
  const profile = usePlatformProfile();

  if (context.reachability !== 'connected') {
    return (
      <p className="settings__field-hint">
        Connected server unavailable. Reconnect to check its update status.
      </p>
    );
  }

  return (
    <>
      {context.connectionName && (
        <p className="settings__field-hint">
          Connected to {context.connectionName} · {context.apiBase}
        </p>
      )}
      {context.kind === 'unresolved' && context.identitySettled && (
        <p className="settings__update-msg settings__update-msg--warning">
          Server update method unknown.
        </p>
      )}
      {context.kind === 'installed-local-service' && (
        <>
          <p className="settings__update-msg" role="status">
            {profile.target === 'macos'
              ? 'Installed service on this Mac.'
              : 'Installed local service.'}
          </p>
          <p className="settings__field-hint">
            This service is updated separately from the desktop app.
          </p>
        </>
      )}
      {context.kind === 'remote-server' && (
        <>
          <p className="settings__update-msg" role="status">
            Server on {serverHost(context.apiBase)}.
          </p>
          <p className="settings__field-hint">Manage updates on that host.</p>
          <p className="settings__field-hint">
            Updates apply to the server at this address and affect its connected
            clients.
          </p>
        </>
      )}
    </>
  );
}

/**
 * The connected-server side of the System settings card. The card's shape
 * follows the correlated server identity: an established embedded sidecar
 * presents the desktop app as its update path, everything else keeps the
 * server-side source check gated on a settled identity and reachability.
 */
export function ConnectedServerUpdates() {
  const context = useConnectedServerUpdateContext();

  // CoreUpdateCheck owns hooks internally, so this is a conditional RETURN,
  // not a conditional prop: for a built-in sidecar the source check must not
  // mount — and therefore not request /api/system/core-update — at all.
  if (context.kind === 'embedded-sidecar') {
    return (
      <div>
        <p className="settings__update-msg" role="status">
          Built-in server — updated with this desktop app.
        </p>
        <p className="settings__field-hint">Use Desktop app updates above.</p>
      </div>
    );
  }

  return (
    <div>
      <ServerIdentitySummary context={context} />
      <CoreUpdateCheck
        apiBase={context.apiBase}
        enabled={
          context.identitySettled && context.reachability === 'connected'
        }
      />
    </div>
  );
}
