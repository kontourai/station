import type {
  RelayInvitationLifetime,
  RelayManagementView,
  RelaySetupApproval,
} from '@kontourai/station-contracts/relay-management';
import { StationHttpError } from '@kontourai/station-sdk/client';
import {
  approveRelayDevice,
  approveRelaySetup,
  createRelayInvitation,
  denyRelayDevice,
  getRelayManagement,
  getRelayManagementCapabilities,
  revokeRelaySetup,
} from '@kontourai/station-sdk/relay-management';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '../../components/Button';
import { ConfirmModal } from '../../components/modals/ConfirmModal';
import { ErrorState } from '../../components/state';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { copyToClipboard } from '../../lib/clipboard';
import { RelaySetupHelp } from './RelaySetupHelp';
import './ComputersSection.css';

export function RelayOperatorPanel() {
  const scope = useHostRequestAuthorityScope();
  if (!scope) return null;
  return (
    <OperatorPanel
      key={`${scope.apiBase}:${scope.authorityKey}`}
      scope={scope}
    />
  );
}
function OperatorPanel({
  scope,
}: {
  scope: NonNullable<ReturnType<typeof useHostRequestAuthorityScope>>;
}) {
  const [prepareText, setPrepareText] = useState('');
  const [lifetime, setLifetime] = useState<RelayInvitationLifetime>('24h');
  const [channel, setChannel] = useState<'nightly' | 'stable' | 'beta'>(
    'nightly',
  );
  const [notice, setNotice] = useState('');
  const [removing, setRemoving] = useState<RelaySetupApproval | null>(null);
  const request = { requestScope: scope, requireCredential: true };
  const capabilities = useQuery({
    queryKey: [
      'relay-management-capabilities',
      scope.apiBase,
      scope.authorityKey,
    ],
    queryFn: ({ signal }) =>
      getRelayManagementCapabilities(scope.apiBase, { ...request, signal }),
    retry: false,
    gcTime: 0,
    staleTime: 0,
    enabled: scope.isCurrent(),
  });
  const query = useQuery({
    queryKey: ['relay-management', scope.apiBase, scope.authorityKey],
    queryFn: ({ signal }) =>
      getRelayManagement(scope.apiBase, { ...request, signal }),
    retry: false,
    gcTime: 0,
    staleTime: 0,
    enabled:
      scope.isCurrent() &&
      capabilities.data?.canManage === true &&
      capabilities.data.configured,
  });
  const approval = useMutation({
    gcTime: 0,
    mutationFn: async () => {
      if (!scope.isCurrent()) throw new Error('Station access changed.');
      return approveRelaySetup(scope.apiBase, JSON.parse(prepareText), request);
    },
  });
  const invitation = useMutation({
    gcTime: 0,
    mutationFn: async () => {
      if (!scope.isCurrent()) throw new Error('Station access changed.');
      if (!query.data)
        throw new Error('Station invitation setup is unavailable.');
      return createRelayInvitation(
        scope.apiBase,
        query.data.route,
        JSON.parse(prepareText),
        lifetime,
        request,
      );
    },
  });
  const deviceApproval = useMutation({
    gcTime: 0,
    mutationFn: async (
      device: RelayManagementView['pendingDevices'][number],
    ) => {
      if (!scope.isCurrent()) throw new Error('Station access changed.');
      await approveRelayDevice(scope.apiBase, device, request);
    },
    onSuccess: () => query.refetch(),
  });
  const deny = useMutation({
    gcTime: 0,
    mutationFn: async (
      device: RelayManagementView['pendingDevices'][number],
    ) => {
      if (!scope.isCurrent()) throw new Error('Station access changed.');
      await denyRelayDevice(scope.apiBase, device, request);
    },
    onSuccess: () => query.refetch(),
  });
  const revoke = useMutation({
    gcTime: 0,
    mutationFn: async (approval: RelaySetupApproval) => {
      if (!scope.isCurrent()) throw new Error('Station access changed.');
      await revokeRelaySetup(scope.apiBase, approval, request);
    },
    onSuccess: () => {
      setRemoving(null);
      void query.refetch();
    },
  });
  const busy =
    approval.isPending ||
    invitation.isPending ||
    deviceApproval.isPending ||
    revoke.isPending ||
    deny.isPending;
  async function copy(value: string) {
    if (!scope.isCurrent()) return;
    setNotice(
      (await copyToClipboard(value))
        ? 'Link copied.'
        : 'Couldn’t copy the link.',
    );
  }
  if (
    !scope.isCurrent() ||
    capabilities.data?.canManage !== true ||
    query.isPending
  )
    return null;
  if (query.isError) {
    if (
      query.error instanceof StationHttpError &&
      [401, 403, 404].includes(query.error.status)
    )
      return null;
    return (
      <ErrorState
        title="Invitations unavailable"
        action={<Button onClick={() => void query.refetch()}>Try again</Button>}
      />
    );
  }
  const view = query.data;
  return (
    <section
      className="native-relay-setup relay-operator"
      aria-label="Invite a device"
    >
      <div className="native-relay-setup__heading">
        <h3>Invite a device</h3>
        <Button
          variant="ghost"
          disabled={busy || query.isFetching}
          onClick={() => void query.refetch()}
        >
          Refresh
        </Button>
        <RelaySetupHelp label="About device invitations">
          <p>
            Send the setup link first. The recipient sends their setup info back
            so you can approve that installation. Device approval and Project
            access are separate. Only an operator or a device explicitly allowed
            to manage relay invitations can use these controls.
          </p>
        </RelaySetupHelp>
      </div>
      <div className="relay-operator__actions">
        <select
          className="editor-input"
          aria-label="Recipient app"
          value={channel}
          disabled={busy}
          onChange={(event) => setChannel(event.target.value as typeof channel)}
        >
          <option value="nightly">Nightly</option>
          <option value="stable">Station</option>
          <option value="beta">Beta</option>
        </select>
        <Button onClick={() => void copy(view.setupLinks[channel])}>
          Copy setup link
        </Button>
      </div>
      <details>
        <summary>Approve recipient</summary>
        <label className="editor-field">
          Setup info from recipient
          <textarea
            className="editor-input"
            value={prepareText}
            disabled={busy}
            onChange={(event) => {
              setPrepareText(event.target.value);
              approval.reset();
              invitation.reset();
            }}
          />
        </label>
        <div className="relay-operator__actions">
          <Button
            disabled={busy || !prepareText.trim()}
            pending={approval.isPending}
            onClick={() => void approval.mutateAsync().catch(() => undefined)}
          >
            Approve device
          </Button>
          <select
            className="editor-input"
            aria-label="Invitation expires"
            disabled={busy}
            value={lifetime}
            onChange={(event) =>
              setLifetime(event.target.value as RelayInvitationLifetime)
            }
          >
            <option value="5m">5 minutes</option>
            <option value="15m">15 minutes</option>
            <option value="1h">1 hour</option>
            <option value="24h">24 hours</option>
            <option value="never">Never expires</option>
          </select>
          <Button
            variant="primary"
            disabled={
              busy ||
              !approval.isSuccess ||
              invitation.isError ||
              invitation.isSuccess
            }
            pending={invitation.isPending}
            onClick={() => void invitation.mutateAsync().catch(() => undefined)}
          >
            Create invitation
          </Button>
        </div>
        {(approval.isError || invitation.isError) && (
          <p role="alert">
            {invitation.isError
              ? 'Invitation delivery could not be confirmed. Check with the recipient before creating another.'
              : 'Couldn’t approve this setup info. Check it with the recipient.'}
          </p>
        )}
        {invitation.data && (
          <Button onClick={() => void copy(invitation.data.link)}>
            Copy invitation
          </Button>
        )}
      </details>
      <details>
        <summary>Station confirmation</summary>
        <p>
          Compare these with the recipient using a separate call or message.
        </p>
        <dl>
          <dt>Code</dt>
          <dd>
            <code>{view.confirmationCode}</code>
          </dd>
          <dt>Key ID</dt>
          <dd>
            <code>{view.keyId}</code>
          </dd>
        </dl>
      </details>
      {view.pendingDevices.length > 0 && (
        <div>
          <h4>Waiting for approval</h4>
          {view.pendingDevices.map((device) => (
            <div className="relay-operator__actions" key={device.enrollmentId}>
              <span>{device.account.displayName}</span>
              <RelaySetupHelp label="About this access request">
                <p>
                  Account {device.account.issuer} · {device.account.subject}
                </p>
                <p>Device key {device.candidate.deviceProofKeyThumbprint}</p>
                <p>
                  This approves a read-only Device connection. Project access is
                  managed separately.
                </p>
              </RelaySetupHelp>
              <Button
                disabled={busy}
                pending={
                  deviceApproval.isPending &&
                  deviceApproval.variables?.enrollmentId === device.enrollmentId
                }
                onClick={() =>
                  void deviceApproval.mutateAsync(device).catch(() => undefined)
                }
              >
                Approve access
              </Button>
              <Button
                variant="danger-outline"
                disabled={busy}
                onClick={() =>
                  void deny.mutateAsync(device).catch(() => undefined)
                }
              >
                Decline
              </Button>
            </div>
          ))}
        </div>
      )}
      {(deviceApproval.isError || deny.isError) && (
        <p role="alert">
          Couldn’t approve access. Refresh before trying again.
        </p>
      )}
      {view.approvals.length > 0 && (
        <details>
          <summary>Approved devices</summary>
          {view.approvals.map((entry) => (
            <div className="relay-operator__actions" key={entry.approvalId}>
              <span>
                {entry.surface.channel === 'nightly'
                  ? 'Nightly device'
                  : 'Station device'}
              </span>
              <RelaySetupHelp label="About this approved device">
                <p>Installation {entry.surface.clientInstanceId}</p>
                <p>Key {entry.surface.keyThumbprint}</p>
              </RelaySetupHelp>
              <Button
                variant="danger-outline"
                disabled={busy}
                onClick={() => {
                  revoke.reset();
                  setRemoving(entry);
                }}
              >
                Remove relay access
              </Button>
            </div>
          ))}
        </details>
      )}
      <ConfirmModal
        isOpen={removing !== null}
        title="Remove relay access?"
        message="This installation will no longer connect through the relay. Its Project membership is unchanged."
        confirmLabel="Remove relay access"
        variant="danger"
        pending={revoke.isPending}
        error={
          revoke.isError
            ? 'Couldn’t confirm removal. Refresh before trying again.'
            : null
        }
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          if (removing)
            void revoke.mutateAsync(removing).catch(() => undefined);
        }}
      />
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
