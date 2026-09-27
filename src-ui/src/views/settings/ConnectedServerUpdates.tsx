import {
  type CoreUpdateStatus,
  useCoreUpdateStatusQuery,
} from '@kontourai/station-sdk';
import type { ConnectedServerUpdateContext } from '../../hooks/useConnectedServerUpdateContext';
import {
  coreUpdateScopeFromContext,
  useConnectedServerUpdateContext,
} from '../../hooks/useConnectedServerUpdateContext';
import { usePlatformProfile } from '../../platform/PlatformProfileContext';
import { CoreUpdateCheck } from './CoreUpdateCheck';
import { isArchiveInstall } from './coreUpdatePresentation';
import { SourceInstallerDisclosure } from './SourceInstallerDisclosure';

function serverHost(apiBase: string): string {
  try {
    return new URL(apiBase).host;
  } catch {
    return apiBase;
  }
}

const KNOWN_INSTALL_KINDS: ReadonlySet<CoreUpdateStatus['installKind']> =
  new Set(['source-checkout', 'desktop-bundle', 'archive', 'archive-service']);

/**
 * The server's own answer, once it has given one, outranks what the
 * connection alone can say: a status naming its install kind resolves the
 * "method unknown" guess, and one that can apply an update from here makes
 * "manage updates on that host" untrue.
 */
function statusResolvesMethod(status: CoreUpdateStatus | undefined): boolean {
  return KNOWN_INSTALL_KINDS.has(status?.installKind);
}

function statusAppliesFromHere(status: CoreUpdateStatus | undefined): boolean {
  return (
    !!status &&
    !status.selfUpdateUnavailableReason &&
    (status.applyMethod === 'service-update' ||
      status.applyMethod === 'git-pull')
  );
}

function ServerIdentitySummary({
  context,
  status,
}: {
  context: ConnectedServerUpdateContext;
  status: CoreUpdateStatus | undefined;
}) {
  const profile = usePlatformProfile();

  if (context.reachability === 'checking') {
    return <p className="settings__field-hint">Checking the connection</p>;
  }

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
      {context.kind === 'unresolved' &&
        context.identitySettled &&
        !statusResolvesMethod(status) && (
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
          {!statusAppliesFromHere(status) && (
            <p className="settings__field-hint">Manage updates on that host.</p>
          )}
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
  // The same query (same key) CoreUpdateCheck and the source disclosure
  // mount: this observer never fetches on its own, it only reads the answer
  // they asked for.
  const { data: status } = useCoreUpdateStatusQuery(
    context.apiBase,
    { enabled: false },
    {
      scopeKey: coreUpdateScopeFromContext(context),
      assertCurrent: context.isCurrent,
    },
  );

  // CoreUpdateCheck owns hooks internally, so this is a conditional RETURN,
  // not a conditional prop: for a built-in sidecar the source check must not
  // mount — and therefore not request /api/system/core-update — at all. The
  // advanced source disclosure below is the only path back to those facts,
  // and it fetches only while a person has it open.
  if (context.kind === 'embedded-sidecar') {
    return (
      <div>
        <p className="settings__update-msg" role="status">
          Built-in server — updated with this desktop app.
        </p>
        <p className="settings__field-hint">Use Desktop app updates above.</p>
        <SourceInstallerDisclosure context={context} />
      </div>
    );
  }

  return (
    <div>
      <ServerIdentitySummary context={context} status={status} />
      {/* Fail-closed enablement: identity SUCCESS (not merely settled), no
        pending native observation on a supervising desktop, no unresolved
        claim on the observed native owner, and a connected server. An
        identity error, a not-yet-delivered native snapshot, or a claimed
        owner the correlation could not establish each keep the automatic
        source check off. */}
      <CoreUpdateCheck
        apiBase={context.apiBase}
        context={context}
        enabled={
          context.identityReady &&
          !context.nativeObservationPending &&
          !context.claimedOwnerUnresolved &&
          context.reachability === 'connected'
        }
      />
      {/* A prebuilt release has no source installation to disclose. */}
      {!(status && isArchiveInstall(status)) && (
        <SourceInstallerDisclosure context={context} />
      )}
    </div>
  );
}
