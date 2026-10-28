import {
  type CoreUpdateStatus,
  useCoreUpdateStatusQuery,
} from '@kontourai/station-sdk';
import type { ReactNode } from 'react';
import type { ConnectedServerUpdateContext } from '../../hooks/useConnectedServerUpdateContext';
import {
  coreUpdateScopeFromContext,
  useConnectedServerUpdateContext,
} from '../../hooks/useConnectedServerUpdateContext';
import { usePlatformProfile } from '../../platform/PlatformProfileContext';
import { CoreUpdateCheck } from './CoreUpdateCheck';
import { isArchiveInstall, ServerUpdateHeader } from './coreUpdatePresentation';
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

/** What needs attention about the connection itself: one line each. */
function ServerIdentityAlerts({
  context,
  status,
}: {
  context: ConnectedServerUpdateContext;
  status: CoreUpdateStatus | undefined;
}) {
  if (context.reachability === 'checking') {
    return <p className="settings__field-hint">Checking the connection</p>;
  }

  if (context.reachability !== 'connected') {
    return (
      <p className="settings__update-msg settings__update-msg--warning">
        Connected server unavailable. Reconnect to check its update status.
      </p>
    );
  }

  return (
    <>
      {context.kind === 'unresolved' &&
        context.identitySettled &&
        !statusResolvesMethod(status) && (
          <p className="settings__update-msg settings__update-msg--warning">
            Server update method unknown.
          </p>
        )}
      {context.kind === 'remote-server' && !statusAppliesFromHere(status) && (
        <p className="settings__update-msg">Manage updates on that host.</p>
      )}
    </>
  );
}

/** Where the server is and how it is installed: folded into Details. */
function ServerIdentityDetails({
  context,
}: {
  context: ConnectedServerUpdateContext;
}) {
  const profile = usePlatformProfile();
  if (context.reachability !== 'connected') return null;
  return (
    <>
      <p className="settings__field-hint">Address: {context.apiBase}</p>
      <p className="settings__field-hint">
        Instance: {context.identity?.instanceId ?? 'Identity unavailable'}
      </p>
      {context.kind === 'installed-local-service' && (
        <p className="settings__field-hint">
          {profile.target === 'macos'
            ? 'Installed service on this Mac.'
            : 'Installed local service.'}{' '}
          It is updated separately from the desktop app.
        </p>
      )}
      {context.kind === 'remote-server' && (
        <p className="settings__field-hint">
          Updates apply to the server at this address and affect its connected
          clients.
        </p>
      )}
    </>
  );
}

/**
 * The connected-server controls in System settings and Updates. Their shape
 * follows the correlated server identity: an established embedded sidecar
 * presents the desktop app as its update path, everything else keeps the
 * server-side source check gated on a settled identity and reachability.
 */
export function ConnectedServerUpdates({
  active = true,
  headingId,
  notices,
}: {
  active?: boolean;
  /** Renders the server's name as the heading this id labels (Updates). */
  headingId?: string;
  /** Update notices for this server, shown under its header. */
  notices?: ReactNode;
}) {
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
  const title = `Server · ${context.connectionName ?? serverHost(context.apiBase)}`;

  // CoreUpdateCheck owns hooks internally, so this is a conditional RETURN,
  // not a conditional prop: for a built-in sidecar the source check must not
  // mount — and therefore not request /api/system/core-update — at all. The
  // advanced source disclosure below is the only path back to those facts,
  // and it fetches only while a person has it open.
  if (context.kind === 'embedded-sidecar') {
    return (
      <div className="server-update">
        <ServerUpdateHeader title={title} headingId={headingId} />
        {notices}
        <p className="settings__update-msg" role="status">
          Built-in server — updated with this desktop app.
        </p>
        <SourceInstallerDisclosure context={context} />
      </div>
    );
  }

  return (
    // Fail-closed enablement: identity SUCCESS (not merely settled), no
    // pending native observation on a supervising desktop, no unresolved
    // claim on the observed native owner, and a connected server. An
    // identity error, a not-yet-delivered native snapshot, or a claimed
    // owner the correlation could not establish each keep the automatic
    // source check off.
    <CoreUpdateCheck
      active={active}
      apiBase={context.apiBase}
      context={context}
      enabled={
        context.identityReady &&
        !context.nativeObservationPending &&
        !context.claimedOwnerUnresolved &&
        context.reachability === 'connected'
      }
      title={title}
      headingId={headingId}
      alerts={
        <>
          {notices}
          <ServerIdentityAlerts context={context} status={status} />
        </>
      }
      details={
        <>
          <ServerIdentityDetails context={context} />
          {/* A prebuilt release has no source installation to disclose. */}
          {!(status && isArchiveInstall(status)) && (
            <SourceInstallerDisclosure context={context} />
          )}
        </>
      }
    />
  );
}
