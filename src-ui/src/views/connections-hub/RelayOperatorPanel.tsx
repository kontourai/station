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
import { useId, useState } from 'react';
import { ActionRow } from '../../components/ActionRow';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { ConfirmModal } from '../../components/modals/ConfirmModal';
import { SkeletonList } from '../../components/Skeleton';
import { Empty, ErrorState } from '../../components/state';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { copyToClipboard } from '../../lib/clipboard';
import { usePlatformProfile } from '../../platform/PlatformProfileContext';
import { RelaySetupHelp } from './RelaySetupHelp';
import './ComputersSection.css';

type Scope = NonNullable<ReturnType<typeof useHostRequestAuthorityScope>>;
type AppChannel = 'stable' | 'beta' | 'nightly';
type PendingDevice = RelayManagementView['pendingDevices'][number];

const APP_LABEL: Record<AppChannel, string> = {
  stable: 'Station',
  beta: 'Beta',
  nightly: 'Nightly',
};
const LIFETIMES: readonly [RelayInvitationLifetime, string][] = [
  ['5m', '5 minutes'],
  ['15m', '15 minutes'],
  ['1h', '1 hour'],
  ['24h', '24 hours'],
  ['never', 'Never expires'],
];

/**
 * Reads the recipient's setup info out of whatever their share sheet sent.
 * Messaging apps wrap or prefix pasted text, so this takes the outermost JSON
 * object rather than demanding a bare document. It is a convenience preview
 * only: the server and SDK still validate and bind the tuple.
 */
function readSetupInfo(
  text: string,
  route: RelayManagementView['route'],
): { value: Record<string, unknown> } | { error: string } | null {
  if (!text.trim()) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  let value: unknown;
  try {
    value =
      start >= 0 && end > start ? JSON.parse(text.slice(start, end + 1)) : null;
  } catch {
    value = null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return {
      error: 'This isn’t complete setup info. Ask them to send it again.',
    };
  const info = value as Record<string, unknown>;
  if (
    info.stationId !== route.stationId ||
    info.enrollmentId !== route.enrollmentId ||
    info.brokerOrigin !== route.brokerOrigin
  )
    return { error: 'This setup info is for a different Station.' };
  return { value: info };
}

/**
 * The phone an invitation is bound to, within the route it names. It holds
 * public setup fields only, never the invitation link.
 */
function recipientKey(info: Record<string, unknown>): string {
  return JSON.stringify([
    info.brokerOrigin,
    info.stationId,
    info.enrollmentId,
    info.clientInstanceId,
    info.keyThumbprint,
  ]);
}

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

function OperatorPanel({ scope }: { scope: Scope }) {
  const [inviting, setInviting] = useState(false);
  const [removing, setRemoving] = useState<RelaySetupApproval | null>(null);
  // Recipients whose invitation write may have happened without its link
  // coming back. It lives here, not in the dialog, so closing the dialog or
  // changing the setup info cannot quietly allow a second invitation. This
  // panel is keyed by authority, so another account or Station starts empty.
  const [unconfirmed, setUnconfirmed] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const request = {
    requestScope: scope,
    requireCredential: scope.requiresEnrolledCredential ?? true,
  };
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
  const deviceApproval = useMutation({
    gcTime: 0,
    mutationFn: async (device: PendingDevice) => {
      if (!scope.isCurrent()) throw new Error('Station access changed.');
      await approveRelayDevice(scope.apiBase, device, request);
    },
    onSuccess: () => query.refetch(),
  });
  const deny = useMutation({
    gcTime: 0,
    mutationFn: async (device: PendingDevice) => {
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
  const busy = deviceApproval.isPending || revoke.isPending || deny.isPending;
  if (
    !scope.isCurrent() ||
    capabilities.data?.canManage !== true ||
    !capabilities.data.configured
  )
    return null;
  if (query.isPending)
    return <SkeletonList count={1} label="Loading devices" />;
  if (query.isError) {
    if (
      query.error instanceof StationHttpError &&
      [401, 403, 404].includes(query.error.status)
    )
      return null;
    return (
      <ErrorState
        title="Devices unavailable"
        action={<Button onClick={() => void query.refetch()}>Try again</Button>}
      />
    );
  }
  const view = query.data;
  return (
    <section className="native-relay-setup relay-operator" aria-label="Devices">
      <div className="relay-operator__title-row">
        <h2 className="relay-route-profiles__heading">Devices</h2>
        <RelaySetupHelp label="About devices">
          <p>
            Phones you approve reach this Station through its relay. Approving a
            device doesn’t share any Project — share Projects from Project
            settings.
          </p>
          <p>
            Station code <code>{view.confirmationCode}</code>
          </p>
        </RelaySetupHelp>
        <ActionRow
          className="relay-operator__menu"
          overflowLabel="More device actions"
          primary={
            <Button size="sm" onClick={() => setInviting(true)}>
              Invite device
            </Button>
          }
          overflow={[
            {
              key: 'refresh',
              label: query.isFetching ? 'Refreshing…' : 'Refresh',
              disabled: busy || query.isFetching,
              onSelect: () => void query.refetch(),
            },
          ]}
        />
      </div>
      {view.pendingDevices.length > 0 && (
        <ul className="relay-operator__list" aria-label="Waiting for approval">
          {view.pendingDevices.map((device) => (
            <li className="relay-operator__item" key={device.enrollmentId}>
              <span className="relay-operator__name">
                {device.account.displayName}
                <span className="connections-computers__note">
                  Wants to connect
                </span>
              </span>
              <RelaySetupHelp label={`About ${device.account.displayName}`}>
                <p>
                  Account {device.account.issuer} · {device.account.subject}
                </p>
                <p>Device key {device.candidate.deviceProofKeyThumbprint}</p>
                <p>
                  Approving allows a read-only connection. Project access is
                  separate.
                </p>
              </RelaySetupHelp>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                pending={
                  deny.isPending &&
                  deny.variables?.enrollmentId === device.enrollmentId
                }
                onClick={() =>
                  void deny.mutateAsync(device).catch(() => undefined)
                }
              >
                Decline
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={busy}
                pending={
                  deviceApproval.isPending &&
                  deviceApproval.variables?.enrollmentId === device.enrollmentId
                }
                onClick={() =>
                  void deviceApproval.mutateAsync(device).catch(() => undefined)
                }
              >
                Approve
              </Button>
            </li>
          ))}
        </ul>
      )}
      {(deviceApproval.isError || deny.isError) && (
        <p role="alert">
          Couldn’t confirm that change. Refresh before trying again.
        </p>
      )}
      {view.approvals.length > 0 ? (
        <ul className="relay-operator__list" aria-label="Approved devices">
          {view.approvals.map((entry) => (
            <li className="relay-operator__item" key={entry.approvalId}>
              <span className="relay-operator__name">
                {entry.surface.channel === 'stable' ||
                entry.surface.channel === 'beta' ||
                entry.surface.channel === 'nightly'
                  ? `${APP_LABEL[entry.surface.channel]} app`
                  : 'Station app'}
                <span className="connections-computers__note">
                  …{entry.surface.clientInstanceId.slice(-4)}
                </span>
              </span>
              <RelaySetupHelp label="About this device">
                <p>Installation {entry.surface.clientInstanceId}</p>
                <p>Key {entry.surface.keyThumbprint}</p>
              </RelaySetupHelp>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  revoke.reset();
                  setRemoving(entry);
                }}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        view.pendingDevices.length === 0 && (
          <Empty variant="compact" label="Invite a device to connect" />
        )
      )}
      {inviting && (
        <InviteDeviceDialog
          scope={scope}
          view={view}
          unconfirmed={unconfirmed}
          onUnconfirmed={(recipient, uncertain) =>
            setUnconfirmed((current) => {
              const next = new Set(current);
              if (uncertain) next.add(recipient);
              else next.delete(recipient);
              return next;
            })
          }
          onClose={() => {
            setInviting(false);
            void query.refetch();
          }}
        />
      )}
      <ConfirmModal
        isOpen={removing !== null}
        title="Remove this device?"
        message="It will stop connecting through the relay. Its Project access is unchanged."
        confirmLabel="Remove"
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
    </section>
  );
}

/**
 * The invitation journey as three short steps. Approval and invitation stay
 * two server writes in that order; the dialog runs them from one action
 * because the operator always does both with the same setup info. An
 * uncertain invitation write blocks that recipient instead of retrying, until
 * the operator explicitly allows another.
 */
function InviteDeviceDialog({
  scope,
  view,
  unconfirmed,
  onUnconfirmed,
  onClose,
}: {
  scope: Scope;
  view: RelayManagementView;
  unconfirmed: ReadonlySet<string>;
  onUnconfirmed: (recipient: string, uncertain: boolean) => void;
  onClose: () => void;
}) {
  const platformChannel = usePlatformProfile().channel;
  const [channel, setChannel] = useState<AppChannel>(
    platformChannel === 'stable' || platformChannel === 'beta'
      ? platformChannel
      : 'nightly',
  );
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [setupText, setSetupText] = useState('');
  const [lifetime, setLifetime] = useState<RelayInvitationLifetime>('24h');
  const [notice, setNotice] = useState('');
  const fieldId = useId();
  const request = {
    requestScope: scope,
    requireCredential: scope.requiresEnrolledCredential ?? true,
  };
  const setupInfo = readSetupInfo(setupText, view.route);
  const recipient =
    setupInfo && 'value' in setupInfo ? recipientKey(setupInfo.value) : null;
  const uncertain = recipient !== null && unconfirmed.has(recipient);
  const approval = useMutation({
    gcTime: 0,
    mutationFn: async (prepare: unknown) => {
      if (!scope.isCurrent()) throw new Error('Station access changed.');
      return approveRelaySetup(scope.apiBase, prepare, request);
    },
  });
  const invitation = useMutation({
    gcTime: 0,
    mutationFn: async (target: {
      prepare: Record<string, unknown>;
      recipient: string;
    }) => {
      if (!scope.isCurrent()) throw new Error('Station access changed.');
      try {
        return await createRelayInvitation(
          scope.apiBase,
          view.route,
          target.prepare,
          lifetime,
          request,
        );
      } catch (error) {
        // The server answers 400 and 403 only before it issues anything.
        // Every other failure may have left an invitation behind.
        if (
          !(
            error instanceof StationHttpError &&
            (error.status === 400 || error.status === 403)
          )
        )
          onUnconfirmed(target.recipient, true);
        throw error;
      }
    },
    onSuccess: () => setStep(3),
  });
  const busy = approval.isPending || invitation.isPending;
  async function approveAndInvite() {
    if (!setupInfo || !('value' in setupInfo) || !recipient || uncertain)
      return;
    try {
      if (!approval.isSuccess) await approval.mutateAsync(setupInfo.value);
      await invitation.mutateAsync({ prepare: setupInfo.value, recipient });
    } catch {
      /* Rendered from the mutation state below. */
    }
  }
  async function copy(value: string, label: string) {
    if (!scope.isCurrent()) return;
    setNotice(
      (await copyToClipboard(value))
        ? `${label} copied.`
        : `Couldn’t copy the ${label.toLowerCase()}.`,
    );
  }
  async function paste() {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        setSetupText(text);
        approval.reset();
        invitation.reset();
      }
    } catch {
      setNotice('Paste their setup info into the box.');
    }
  }
  const expiresAt = invitation.data?.expiresAt;
  const footer =
    step === 1 ? (
      <>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={() => setStep(2)}>
          Next
        </Button>
      </>
    ) : step === 2 ? (
      <>
        <Button disabled={busy} onClick={() => setStep(1)}>
          Back
        </Button>
        <Button
          variant="primary"
          disabled={busy || !setupInfo || !('value' in setupInfo) || uncertain}
          pending={busy}
          pendingLabel={approval.isPending ? 'Approving…' : 'Creating…'}
          onClick={() => void approveAndInvite()}
        >
          Approve and invite
        </Button>
      </>
    ) : (
      <Button variant="primary" onClick={onClose}>
        Done
      </Button>
    );
  return (
    <Dialog
      eyebrow={`Step ${step} of 3`}
      title={
        step === 1
          ? 'Send the app link'
          : step === 2
            ? 'Approve their phone'
            : 'Send the invitation'
      }
      closeLabel="Close invite device"
      onClose={onClose}
      dismissible={!busy}
      size="sm"
      footer={footer}
    >
      <div className="native-relay-setup relay-invite">
        {step === 1 && (
          <>
            <fieldset className="relay-invite__apps">
              <legend>Their app</legend>
              {(['stable', 'beta', 'nightly'] as const).map((value) => (
                <Button
                  key={value}
                  size="sm"
                  active={channel === value}
                  aria-pressed={channel === value}
                  onClick={() => setChannel(value)}
                >
                  {APP_LABEL[value]}
                </Button>
              ))}
            </fieldset>
            <p>
              They open the link on their phone and send you the setup info it
              shows.
            </p>
            <Button onClick={() => void copy(view.setupLinks[channel], 'Link')}>
              Copy link
            </Button>
          </>
        )}
        {step === 2 && (
          <>
            {setupInfo && 'value' in setupInfo ? (
              // Valid setup info collapses to what it means; the raw JSON is
              // never the thing the operator has to read.
              <div className="relay-invite__field relay-invite__recipient">
                <span>
                  <strong>
                    {typeof setupInfo.value.channel === 'string' &&
                    setupInfo.value.channel in APP_LABEL
                      ? `${APP_LABEL[setupInfo.value.channel as AppChannel]} app`
                      : 'Station app'}
                  </strong>{' '}
                  for this Station
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setSetupText('');
                    approval.reset();
                    invitation.reset();
                  }}
                >
                  Change
                </Button>
              </div>
            ) : (
              <>
                <div className="relay-invite__field">
                  <label htmlFor={fieldId}>Their setup info</label>
                  {typeof navigator.clipboard?.readText === 'function' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void paste()}
                    >
                      Paste
                    </Button>
                  )}
                </div>
                <textarea
                  id={fieldId}
                  className="editor-input relay-invite__input"
                  rows={2}
                  placeholder="Paste what they sent"
                  spellCheck={false}
                  value={setupText}
                  disabled={busy}
                  onChange={(event) => {
                    setSetupText(event.target.value);
                    approval.reset();
                    invitation.reset();
                  }}
                />
                {setupInfo && 'error' in setupInfo && (
                  <p role="alert">{setupInfo.error}</p>
                )}
              </>
            )}
            <div className="relay-invite__field">
              <label htmlFor={`${fieldId}-expiry`}>Invitation expires</label>
              <select
                id={`${fieldId}-expiry`}
                className="editor-input relay-invite__select"
                disabled={busy}
                value={lifetime}
                onChange={(event) =>
                  setLifetime(event.target.value as RelayInvitationLifetime)
                }
              >
                {LIFETIMES.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <p className="connections-computers__note">
              The invitation works once, on this phone only. It doesn’t share
              any Project.
            </p>
            {approval.isError && (
              <p role="alert">
                Couldn’t approve this setup info. Check it with them.
              </p>
            )}
            {uncertain ? (
              <div role="alert" className="relay-invite__field">
                <p>
                  This phone’s last invitation wasn’t confirmed. Creating
                  another may leave an unused one.
                </p>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    if (recipient) onUnconfirmed(recipient, false);
                    invitation.reset();
                  }}
                >
                  Allow another
                </Button>
              </div>
            ) : (
              invitation.isError && (
                <p role="alert">
                  Couldn’t create the invitation. Check it with them.
                </p>
              )
            )}
          </>
        )}
        {step === 3 && invitation.data && (
          <>
            <p>
              Send this invitation. It works once
              {expiresAt === Number.MAX_SAFE_INTEGER || expiresAt === undefined
                ? '.'
                : ` until ${new Date(expiresAt).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}.`}
            </p>
            <Button
              variant="primary"
              onClick={() => void copy(invitation.data.link, 'Invitation')}
            >
              Copy invitation
            </Button>
            <div className="relay-invite__code">
              <div className="native-relay-setup__heading">
                <span>Station code</span>
                <RelaySetupHelp label="About the Station code">
                  <p>
                    Their phone asks for this code and key ID to confirm it
                    reached your Station. Share them by call or a different
                    message than the invitation.
                  </p>
                </RelaySetupHelp>
              </div>
              <code className="native-relay-setup__code">
                {view.confirmationCode}
              </code>
              <Button size="sm" onClick={() => void copy(view.keyId, 'Key ID')}>
                Copy key ID
              </Button>
            </div>
            <p className="connections-computers__note">
              When they accept, they appear under Devices for you to approve.
            </p>
          </>
        )}
        {notice && <p role="status">{notice}</p>}
      </div>
    </Dialog>
  );
}
