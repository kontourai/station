import {
  createWorkspaceHomeRoleRequest,
  fetchWorkspaceHomeRoleRequest,
  useRevokeWorkspaceHomeRoleMutation,
  useWorkspaceHomeRoleCandidatesQuery,
  useWorkspaceHomeRoleQuery,
  WORKSPACE_HOME_ROLE_QUERY_KEY,
} from '@kontourai/station-sdk';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { useApiBase } from '../../contexts/ApiBaseContext';
import { useNativeConsentBroker } from '../../platform/native/useNativeConsentBroker';

const wait = (milliseconds: number) =>
  new Promise((resolve) => window.setTimeout(resolve, milliseconds));

/**
 * The Home role's production grant surface (archive#3122), following
 * `PermissionManager.requestTrustedApproval`'s isolated-review-page flow:
 * this button only OPENS a request — the consent itself happens on a
 * server-rendered page (which names the pane, the plugin, its version, and
 * the full Home projection, field by field), and only a user-activated
 * navigation from that page can decide it. Same-origin code, this component
 * included, cannot approve anything.
 */
export function WorkspaceHomeRoleSection({
  pluginName,
}: {
  pluginName: string;
}) {
  const { apiBase } = useApiBase();
  const queryClient = useQueryClient();
  const status = useWorkspaceHomeRoleQuery();
  const candidates = useWorkspaceHomeRoleCandidatesQuery();
  const revoke = useRevokeWorkspaceHomeRoleMutation();
  const [pendingPaneId, setPendingPaneId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const flightRef = useRef(0);
// archive#3677: on a Tauri host the review happens in native OS
// chrome instead of the popup — a WebView cannot open the distinct-origin
// consent page at all on some targets (mobile decisively).
  const reviewNatively = useNativeConsentBroker();

  const pluginCandidates = (candidates.data ?? []).filter(
    (candidate) => candidate.pluginName === pluginName,
  );

  const requestGrant = useCallback(
    async (paneId: string) => {
      flightRef.current += 1;
      const flight = flightRef.current;
      setError(null);
      setPendingPaneId(paneId);
// The popup opens BEFORE the network call: window.open must run inside
// the click's transient activation, and a slow request can outlive that
 // window on strict browsers (archive#3720). On any later failure the
// blank popup is closed rather than stranded. The native path opens no
// popup at all — the review is an OS dialog the native host draws.
      const reviewWindow = reviewNatively
        ? null
        : window.open(
            'about:blank',
            'station-home-role-review',
            'popup,width=620,height=760',
          );
      try {
        if (!reviewNatively && !reviewWindow) {
          throw new Error('Allow pop-ups to open the Home role review page');
        }
        if (reviewWindow) reviewWindow.opener = null;
        const request = await createWorkspaceHomeRoleRequest({
          pluginName,
          paneId,
        });
        if (reviewNatively) {
// The native host reviews and decides with its OWN local-grant
// credential; the outcome is the server-settled status. Nothing in
// this webview context can approve — the server refuses every
// credential a JS context can hold.
          const outcome = await reviewNatively(request.id);
          if (outcome.status !== 'ok') {
            throw new Error(
              outcome.status === 'error' ? outcome.message : outcome.reason,
            );
          }
        } else if (reviewWindow) {
          if (!request.reviewUrl) {
            throw new Error('Could not open a Home role request');
          }
          const reviewTarget = new URL(request.reviewUrl, apiBase);
// The server mints a fixed-scheme URL on the consent origin; this
// check is the client refusing to navigate the popup anywhere else
// if that invariant ever breaks (mirrors PermissionManager).
          if (
            reviewTarget.protocol !== 'http:' &&
            reviewTarget.protocol !== 'https:'
          ) {
            throw new Error('Unexpected consent review URL');
          }
          reviewWindow.location.replace(reviewTarget.toString());
          for (let attempt = 0; attempt < 600; attempt += 1) {
            await wait(500);
            if (flightRef.current !== flight) return;
            let current: Awaited<
              ReturnType<typeof fetchWorkspaceHomeRoleRequest>
            >;
            try {
              current = await fetchWorkspaceHomeRoleRequest(request.id);
            } catch {
              continue;
            }
            if (current.status !== 'pending') break;
            if (reviewWindow.closed) break;
          }
        }
      } catch (cause) {
        reviewWindow?.close();
        if (flightRef.current === flight) {
          setError(
            cause instanceof Error
              ? cause.message
              : 'Could not open a Home role request',
          );
        }
      } finally {
        if (flightRef.current === flight) {
          setPendingPaneId(null);
          queryClient.invalidateQueries({
            queryKey: [...WORKSPACE_HOME_ROLE_QUERY_KEY],
          });
        }
      }
    },
    [apiBase, pluginName, queryClient, reviewNatively],
  );

  if (pluginCandidates.length === 0 && status.data?.state !== 'granted') {
    return null;
  }

  const granted = status.data?.state === 'granted' ? status.data.grant : null;
  const grantedHere =
    granted !== null && granted.descriptor.provenance.pluginId === pluginName;

  if (pluginCandidates.length === 0 && !grantedHere) {
    return null;
  }

  return (
    <div className="detail-panel__section">
      <div className="plugins__settings-header">Home role</div>
      <div className="plugins__home-role">
        {pluginCandidates.map((candidate) => {
          const holdsRole =
            grantedHere && granted.descriptor.id === candidate.paneId;
          return (
            <div key={candidate.paneId} className="plugins__home-role-row">
              <span className="plugins__home-role-name">
                {candidate.name}
                {candidate.version ? (
                  <span className="plugins__home-role-version">
                    {' '}
                    v{candidate.version}
                  </span>
                ) : null}
              </span>
              {holdsRole ? (
                <Button
                  size="sm"
                  onClick={() => revoke.mutate()}
                  pending={revoke.isPending}
                >
                  Use built-in Home
                </Button>
              ) : (
                <Button
                  size="sm"
                  onClick={() => requestGrant(candidate.paneId)}
                  disabled={pendingPaneId !== null}
                  pending={pendingPaneId === candidate.paneId}
                  pendingLabel="Waiting for review…"
                >
                  Use as Home…
                </Button>
              )}
            </div>
          );
        })}
        {grantedHere &&
          !pluginCandidates.some(
            (candidate) => candidate.paneId === granted.descriptor.id,
          ) && (
            <div className="plugins__home-role-row">
              <span className="plugins__home-role-name">
                “{granted.descriptor.name}” currently holds the Home role.
              </span>
              <Button
                size="sm"
                onClick={() => revoke.mutate()}
                pending={revoke.isPending}
              >
                Use built-in Home
              </Button>
            </div>
          )}
        {error && <div className="plugins__home-role-error">{error}</div>}
        <p className="plugins__home-role-hint">
          Granting opens a separate review page that lists everything Home shows
          before anything changes. The built-in Home always remains available.
        </p>
      </div>
    </div>
  );
}
