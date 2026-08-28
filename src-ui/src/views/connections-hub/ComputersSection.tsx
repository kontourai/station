/**
 * Computers — one list, one row shape, for every computer this Station knows
* (lane design §4).
 *
 * It replaces `KnownEnvironmentsSection` + `SshEnvironmentsSection`, which
 * rendered two lists with two card grammars — and, because both folded the
 * same SSH profiles, listed an SSH computer twice. The fold below is the one
 * archive#1096 built (identity merge across paired/manual/SSH); what changed
 * is that a folded SSH row now carries the server's phase state and its
 * connect/stop action rather than a second, weaker copy of it.
 *
 * Rules this section keeps:
 * - Every row: name · kind chip · one server-derived state · one action.
 * - Loading is the shared `SkeletonList`, never a "Loading environments…"
* string ; a failed read is `ErrorState` + Retry, never an empty
*   list pretending there is nothing to show.
 * - No state word this client invented: a paired connection is "Authorized"
*   or "Not authorized" from its own credential state, never "Ready" (which
*   on this page means evidenced and currently reachable).
 */

import { useConnections } from '@kontourai/station-connect';
import {
  useConnectSshEnvironmentMutation,
  useDisconnectSshEnvironmentMutation,
  usePeerCredentialsQuery,
  useRemoveSshEnvironmentMutation,
} from '@kontourai/station-sdk';
import { useSystemInstanceQuery } from '@kontourai/station-sdk/developer-runtime';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { ConfirmModal } from '../../components/modals/ConfirmModal';
import { PageRow } from '../../components/PageRow';
import { Empty, ErrorState, SkeletonList } from '../../components/state';
import { useIsMobile } from '../../hooks/useIsMobile';
import { copyToClipboard } from '../../lib/clipboard';
import { sshLauncher } from '../../platform/native/sshLauncher';
// `.page-row` — the row primitive this section renders every computer
// through — lives in the shared page stylesheet, which no other component on
// this route imports. Without it the rows render as unstyled text.
import '../page-layout.css';
import './ComputersSection.css';
import { type ComputerRowModel, isSshBusy } from './computer-rows';
import { knownEnvironmentRegistry } from './known-environment-registry';
import {
  deriveSshForwardProbeState,
  sshForwardLifecycleLabel,
  sshForwardProvenanceWarning,
} from './sshForwardState';
import { useComputerRows } from './useComputerRows';

const PEER_CREDENTIAL_COMMAND = 'station environment peers add';

function SshForwardState({
  connection,
}: {
  connection: import('@kontourai/station-connect').SavedConnection;
}) {
  const forward = connection.sshForward;
  const instance = useSystemInstanceQuery(connection.url, {
    enabled: Boolean(forward),
  });
  const [launcherError, setLauncherError] = useState<string>();
  const [launcherUnknown, setLauncherUnknown] = useState(false);
  useEffect(() => {
    if (!forward) return;
    let disposed = false;
    const poll = () =>
      void sshLauncher
        .status(forward.launchId)
        .then((status) => {
          if (!disposed) {
            setLauncherUnknown(false);
            setLauncherError(
              status.phase === 'failed' ? status.error : undefined,
            );
          }
        })
        .catch((cause) => {
          if (!disposed) {
            const message =
              cause instanceof Error ? cause.message : String(cause);
            setLauncherUnknown(message.includes('not found'));
          }
        });
    poll();
    const timer = window.setInterval(poll, 5_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [forward]);
  if (!forward) return null;
  const warning = sshForwardProvenanceWarning(
    forward.provenance.sha,
    instance.data?.buildSha,
  );
  const lifecycle = sshForwardLifecycleLabel({
    transport: forward.transport,
    launcherError,
    launcherUnknown,
// archive#3711: derived in sshForwardState, not here — a caller-side
// ternary is exactly the shape that regressed to `isSuccess`-as-boolean.
    probe: deriveSshForwardProbeState(instance),
  });
  return (
    <>
      {warning && (
        <span className="connections-computers__alert" role="alert">
          {warning}
        </span>
      )}
      {lifecycle && (
        <span className="connections-computers__note">{lifecycle}</span>
      )}
    </>
  );
}

export function ComputersSection() {
  const isMobile = useIsMobile();
  const { connections } = useConnections();
// An SSH forward is bound to this Station's loopback device. Showing that
// URL on a phone implies the phone can open it, though its own 127.0.0.1 is
// a different machine. This only changes a row's DETAIL text, never the row
// set — which is why the rail can share the same derivation without knowing
// anything about viewport.
  const hideEndpoint = useCallback(
    (endpointUrl: string, kind: string) =>
      isMobile &&
      (kind === 'ssh-forward' ||
        connections.some(
          (connection) =>
            Boolean(connection.sshForward) && connection.url === endpointUrl,
        )),
    [connections, isMobile],
  );
  const { rows, environments, sshEnvironments, isLoading, isError, refetch } =
    useComputerRows({ hideEndpoint });
  const registry = knownEnvironmentRegistry();
 // archive#settings-revamp: outbound peer credentials' one UI home,
// read-only — the CLI stays the whole provisioning mechanism. `GET
// /api/environments/peers` is `access:manage`-gated for a REMOTE caller, so
// a non-operator browser session can 403; render this only on success.
  const peerCredentialsQuery = usePeerCredentialsQuery();
  const connect = useConnectSshEnvironmentMutation();
  const disconnect = useDisconnectSshEnvironmentMutation();
  const remove = useRemoveSshEnvironmentMutation();
  const [activeAction, setActiveAction] = useState<{
    id: string;
    action: 'connect' | 'disconnect';
  } | null>(null);
  const [removeTarget, setRemoveTarget] = useState<ComputerRowModel | null>(
    null,
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  const [copied, setCopied] = useState(false);

  const priorForwardIds = useRef(new Set<string>());
  useEffect(() => {
    const current = new Set(
      connections.flatMap((connection) =>
        connection.sshForward ? [connection.sshForward.launchId] : [],
      ),
    );
    for (const launchId of priorForwardIds.current) {
      if (!current.has(launchId))
        void sshLauncher.cancel(launchId).catch(() => undefined);
    }
    priorForwardIds.current = current;
  }, [connections]);
  async function runSshAction(id: string, action: 'connect' | 'disconnect') {
    setActionError(null);
    setActiveAction({ id, action });
    try {
      await (action === 'connect' ? connect : disconnect).mutateAsync(id);
    } catch (cause) {
      setActionError(
        cause instanceof Error ? cause.message : 'Computer action failed',
      );
    } finally {
      setActiveAction(null);
    }
  }

  async function confirmRemove() {
    if (!removeTarget) return;
    setActionError(null);
    try {
      if (removeTarget.sshEnvironmentId) {
        await remove.mutateAsync(removeTarget.sshEnvironmentId);
      } else if (removeTarget.removableManualEntryId) {
        registry.remove(removeTarget.removableManualEntryId);
      }
      setRemoveTarget(null);
    } catch (cause) {
      setActionError(
        cause instanceof Error ? cause.message : 'Could not remove computer',
      );
    }
  }

  async function copyPeerCommand() {
    const ok = await copyToClipboard(PEER_CREDENTIAL_COMMAND);
    setCopied(ok);
    setCopyFailed(!ok);
    window.setTimeout(() => {
      setCopied(false);
      setCopyFailed(false);
    }, 2_000);
  }

  function sshControl(row: ComputerRowModel) {
    const view = sshEnvironments.find(
      (candidate) => candidate.profile.id === row.sshEnvironmentId,
    );
    if (!view) return null;
    const pendingAction =
      activeAction?.id === view.profile.id ? activeAction.action : null;
    const busy = Boolean(pendingAction) || isSshBusy(view.state);
    const connected = view.state.phase === 'connected';
    return (
      <Button
        size="sm"
        disabled={busy}
        pending={busy}
        pendingLabel={pendingAction === 'disconnect' ? 'Stopping…' : 'Working…'}
        onClick={() =>
          void runSshAction(
            view.profile.id,
            connected ? 'disconnect' : 'connect',
          )
        }
      >
        {connected
          ? 'Stop'
          : view.profile.lastConnectedAt
            ? 'Resume'
            : 'Connect'}
      </Button>
    );
  }

  const loading = isLoading;
  const failed = isError;

  return (
    <>
 {/* The shared page wrapper: this is a single-subject section (design §3),
          so it takes page-layout's own width and padding rhythm rather than
          bleeding to the frame's edges. */}
      <div className="page page--narrow connections-computers">
        {loading ? (
          <SkeletonList count={2} label="Loading computers" />
        ) : failed ? (
          <ErrorState
            variant="compact"
            title="Computers could not be loaded"
            description="Station could not read the computers it can run work on."
            action={
              <Button size="sm" onClick={refetch}>
                Retry
              </Button>
            }
          />
        ) : rows.length === 0 ? (
/* empty-state action: the frame's "Add computer" is adjacent. */
          <Empty
            variant="compact"
            label="No other computers yet"
            description="Add a computer to pair a device, reach another Station, or run work over SSH."
          />
        ) : (
          rows.map((row) => {
            const connection = connections.find(
              (candidate) =>
                candidate.id === row.id.replace(/^paired:/, '') ||
                (candidate.environmentId &&
                  candidate.environmentId ===
                    environments.find((entry) => entry.id === row.id)
                      ?.environmentId),
            );
            return (
              <PageRow
                key={row.id}
                className="connections-computers__row"
                label={
                  <>
                    {row.name}{' '}
                    <span className="connections-computers__chip">
                      {row.kind}
                    </span>
                  </>
                }
                description={row.detail}
                status={
                  <span
                    className={`connections-computers__state connections-computers__state--${row.state.tone}`}
                  >
                    {row.state.label}
                  </span>
                }
                control={
                  row.sshEnvironmentId ? (
                    sshControl(row)
                  ) : row.removableManualEntryId ? (
                    <Button size="sm" onClick={() => setRemoveTarget(row)}>
                      Remove
                    </Button>
                  ) : null
                }
              >
                <span className="connections-computers__note">
                  {row.relationship}
                </span>
                {row.state.detail && (
                  <span className="connections-computers__note">
                    {row.state.detail}
                  </span>
                )}
{/*
                  Deviation from "exactly one action per row", disclosed: an SSH
                  computer this section can now CREATE must also be removable,
                  or the creator becomes the next view-but-can't-act dead end.
                  The row's action cell still holds exactly one control; removal
                  is a low-emphasis link inside the row body.
*/}
                {row.sshEnvironmentId && (
                  <button
                    type="button"
                    className="connections-computers__remove tap-target"
                    onClick={() => setRemoveTarget(row)}
                  >
                    Remove this computer
                  </button>
                )}
                {connection?.sshForward ? (
                  <SshForwardState connection={connection} />
                ) : null}
              </PageRow>
            );
          })
        )}
        {actionError && (
          <p className="connections-computers__alert" role="alert">
            {actionError}
          </p>
        )}

        {peerCredentialsQuery.isSuccess &&
          (peerCredentialsQuery.data.length === 0 ? (
/*
* this was a card with a second empty-state grammar whose
* only content was a CLI command the reader could not act on.
* `POST /api/environments/peers` exists, but provisioning means
* obtaining a bearer from the OTHER Station, which the CLI owns
* end to end — so the honest UI action is to hand over the exact
* command, in the same row shape as everything else here.
*/
            <PageRow
              className="connections-computers__row"
              label="Outbound peer credentials"
              description={`Not configured. Station needs one before it can delegate tasks to another Station. Add it with the CLI: ${PEER_CREDENTIAL_COMMAND}`}
              control={
                <Button
                  size="sm"
                  className={copyFailed ? 'copy-affordance--failed' : undefined}
                  onClick={() => void copyPeerCommand()}
                >
                  {copied
                    ? 'Copied'
                    : copyFailed
                      ? "Can't copy"
                      : 'Copy command'}
                </Button>
              }
            />
          ) : (
            peerCredentialsQuery.data.map((peer) => (
              <PageRow
                key={peer.environmentId}
                className="connections-computers__row"
                label={
                  <>
                    {peer.label ?? peer.environmentId}{' '}
                    <span className="connections-computers__chip">
                      Peer credential
                    </span>
                  </>
                }
                description={`${peer.apiBase} · ${peer.scope}`}
              />
            ))
          ))}
      </div>

      <ConfirmModal
        isOpen={!!removeTarget}
        title="Remove computer?"
        message={
          removeTarget
            ? `${removeTarget.name} will be disconnected and removed from this Station. Your SSH configuration and remote files are not changed.`
            : ''
        }
        confirmLabel={remove.isPending ? 'Removing…' : 'Remove'}
        onConfirm={confirmRemove}
        onCancel={() => setRemoveTarget(null)}
        variant="danger"
      />
    </>
  );
}
