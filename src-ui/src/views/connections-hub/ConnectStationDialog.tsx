import {
  completeVerifiedPairing,
  decodeDevicePairingPayload,
  JoinDevicePairingPanel,
  normalizeHostInput,
  type PendingPairingExchange,
  QRScanner,
  savePendingExchange,
  useConnections,
} from '@kontourai/station-connect';
import { PUBLIC_STATION_HANDSHAKE_PATH } from '@kontourai/station-contracts';
import type { PeerEnrollment } from '@kontourai/station-contracts/environment-security';
import {
  useCancelPeerEnrollmentMutation,
  useCompletePeerEnrollmentMutation,
  usePeerEnrollmentQuery,
  useStartPeerEnrollmentMutation,
} from '@kontourai/station-sdk';
import { useMutation } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { checkHostCompatibility } from '../../lib/compatibilityLoader';
import type { OpenConnectionsModalDetail } from '../../lib/connectionModalEvents';
import { usePlatformProfile } from '../../platform/PlatformProfileContext';
import './ConnectStationDialog.css';

interface Destination {
  apiBase: string;
  environmentId: string;
  label: string;
}

export interface ConnectStationDialogProps {
  isOpen: boolean;
  intent: OpenConnectionsModalDetail;
  onClose: () => void;
  onReopen: () => void;
  onApprovalPending: (pending: PendingPairingExchange) => void;
}

export function ConnectStationDialog({
  isOpen,
  intent,
  onClose,
  onReopen,
  onApprovalPending,
}: ConnectStationDialogProps) {
  const connections = useConnections();
  const profile = usePlatformProfile();
  const currentScope = useHostRequestAuthorityScope();
  // Setup belongs to the Station that opened it, including late status reads.
  const scope = useRef(currentScope).current;
  const controller = useRef({
    apiBase: connections.apiBase,
    name: connections.activeConnection?.name || connections.apiBase,
  }).current;
  const [address, setAddress] = useState('');
  const [code, setCode] = useState('');
  const [method, setMethod] = useState<'address' | 'code' | 'scan'>('address');
  const [destination, setDestination] = useState<Destination | null>(null);
  const [pairingPayload, setPairingPayload] = useState<string>();
  const [peerInvitation, setPeerInvitation] = useState(false);
  const [manualPairingCode, setManualPairingCode] = useState<string>();
  const [deviceSelected, setDeviceSelected] = useState(!intent.peerOnly);
  const [peerSelected, setPeerSelected] = useState(Boolean(intent.peerOnly));
  const [deviceStarted, setDeviceStarted] = useState(false);
  const [deviceSaved, setDeviceSaved] = useState(false);
  const [devicePending, setDevicePending] = useState(false);
  const [reservation, setReservation] = useState<string>();
  const [enrollment, setEnrollment] = useState<PeerEnrollment>();
  const [error, setError] = useState<string>();
  const stale =
    !scope ||
    scope.isCurrent() === false ||
    connections.apiBase !== controller.apiBase;

  const reservationKey = (target: Destination) =>
    `station-peer-enrollment:${controller.apiBase}:${scope?.authorityKey ?? 'unscoped'}:${target.apiBase}:${target.environmentId}`;

  const identify = useMutation({
    mutationFn: async (input: {
      address: string;
      payload?: string;
      manualCode?: string;
    }) => {
      const url = new URL(normalizeHostInput(input.address));
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        (url.pathname !== '/' && url.pathname !== '')
      ) {
        throw new Error(
          'Enter the Station address without a path, password, query, or fragment.',
        );
      }
      const apiBase = url.origin;
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 10_000);
      try {
        const compatibility = await checkHostCompatibility(
          apiBase,
          controller.signal,
        );
        if (compatibility.blocking) throw new Error(compatibility.reason);
        const transport = profile.isTauri
          ? (await import('../../platform/native/publicHandshakeTransport'))
              .nativePublicHandshakeTransport
          : fetch;
        const response = await transport(
          `${apiBase}${PUBLIC_STATION_HANDSHAKE_PATH}`,
          { signal: controller.signal, credentials: 'omit', redirect: 'error' },
        );
        if (!response.ok)
          throw new Error(
            'The Station could not be identified. Check its address and retry.',
          );
        const reader = response.body?.getReader();
        if (!reader)
          throw new Error('The Station returned no identity response.');
        let text = '';
        let bytes = 0;
        const decoder = new TextDecoder();
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 32 * 1024) {
            await reader.cancel();
            throw new Error(
              'The Station returned an oversized identity response.',
            );
          }
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
        const handshake: unknown = JSON.parse(text);
        if (
          !handshake ||
          typeof handshake !== 'object' ||
          !('environmentId' in handshake) ||
          typeof handshake.environmentId !== 'string' ||
          !handshake.environmentId
        ) {
          throw new Error('This address did not return a Station identity.');
        }
        const offer = input.payload
          ? decodeDevicePairingPayload(input.payload)
          : null;
        if (
          input.payload &&
          (!offer || offer.environmentId !== handshake.environmentId)
        )
          throw new Error(
            'The pairing code and this Station report different identities. Request a fresh code.',
          );
        return {
          apiBase,
          environmentId: handshake.environmentId,
          label: apiBase,
        };
      } finally {
        window.clearTimeout(timeout);
      }
    },
    onSuccess: (result, input) => {
      if (
        scope?.isCurrent() === false ||
        connections.apiBase !== controller.apiBase
      )
        return;
      setDestination(result);
      const invitation = input.payload
        ? decodeDevicePairingPayload(input.payload)
        : null;
      setManualPairingCode(input.manualCode);
      setPeerInvitation(invitation?.kind === 'delegation');
      setPairingPayload(
        invitation?.kind === 'delegation' ? undefined : input.payload,
      );
      if (invitation?.kind === 'delegation') {
        setDeviceSelected(false);
        setPeerSelected(true);
      }
      setError(undefined);
      try {
        const saved = sessionStorage.getItem(reservationKey(result));
        if (saved) {
          const parsed: unknown = JSON.parse(saved);
          if (
            parsed &&
            typeof parsed === 'object' &&
            'apiBase' in parsed &&
            parsed.apiBase === result.apiBase &&
            'id' in parsed &&
            typeof parsed.id === 'string'
          ) {
            setReservation(parsed.id);
            setPeerSelected(true);
          } else {
            setError(
              'The saved request reference is invalid. Review existing peer access before starting another request.',
            );
          }
        }
      } catch {
        setError(
          'The saved request reference could not be read. Review existing peer access before starting another request.',
        );
      }
    },
  });
  const peerStatus = usePeerEnrollmentQuery(
    controller.apiBase,
    reservation,
    scope,
    {
      enabled: Boolean(reservation) && !stale,
      refetchInterval:
        enrollment?.status === 'connected' || enrollment?.status === 'cancelled'
          ? false
          : 3_000,
    },
  );
  const observed =
    stale || peerStatus.isError ? undefined : (peerStatus.data ?? enrollment);
  const start = useStartPeerEnrollmentMutation(controller.apiBase, scope);
  const complete = useCompletePeerEnrollmentMutation(controller.apiBase, scope);
  const cancel = useCancelPeerEnrollmentMutation(controller.apiBase, scope);
  const requestPeer = () => {
    if (!destination || stale) {
      setError(
        'Station access changed. Reopen setup from the original Station.',
      );
      return;
    }
    const id = reservation ?? crypto.randomUUID();
    try {
      sessionStorage.setItem(
        reservationKey(destination),
        JSON.stringify({ id, apiBase: destination.apiBase }),
      );
    } catch {
      setError(
        'The request reference could not be saved on this device. Nothing was submitted. Restore browser storage before requesting access.',
      );
      return;
    }
    setReservation(id);
    start.mutate(
      {
        id,
        apiBase: destination.apiBase,
        environmentId: destination.environmentId,
        label: destination.label,
      },
      { onSuccess: setEnrollment },
    );
  };
  const cancelPeer = () => {
    if (!reservation) return;
    cancel.mutate(reservation, {
      onSuccess: (result) => {
        setEnrollment(result);
        if (destination) {
          try {
            sessionStorage.removeItem(reservationKey(destination));
          } catch {
            setError(
              'The cancelled request reference could not be removed. Its cancellation is retained on the sending Station.',
            );
          }
        }
      },
    });
  };

  const acceptCode = (payload: string) => {
    const offer = decodeDevicePairingPayload(payload);
    if (!offer) {
      if (address.trim() && /^[A-Za-z0-9]{6,16}$/.test(payload)) {
        identify.mutate({ address, manualCode: payload.toUpperCase() });
      } else
        setError(
          'Enter an unexpired invitation, or the Station address and its short pairing code.',
        );
      return;
    }
    identify.mutate({ address: offer.endpoint, payload });
  };
  const close = () => onClose();
  const status = observed?.status;
  const peerBusy = start.isPending || complete.isPending || cancel.isPending;
  const failure =
    error ||
    identify.error?.message ||
    start.error?.message ||
    complete.error?.message ||
    cancel.error?.message;

  if (!isOpen) {
    return reservation && status !== 'cancelled' ? (
      <aside className="connect-station-status" aria-live="polite">
        <span>
          {destination?.label}:{' '}
          {status === 'connected'
            ? 'Peer access approved'
            : status === 'pending'
              ? 'Waiting for peer approval'
              : (status ?? 'Request outcome unknown')}
        </span>
        <Button onClick={onReopen}>Review Station connection</Button>
      </aside>
    ) : null;
  }

  return (
    <Dialog
      title="Connect a Station"
      closeLabel="Close Station setup"
      onClose={close}
      subtitle={
        intent.projectName
          ? `Keep ${intent.projectName} and its draft here while connecting another Station.`
          : 'Choose a destination, then approve each kind of access separately.'
      }
      footer={
        <Button onClick={close}>
          {intent.setupRequestId ? 'Return to task' : 'Done'}
        </Button>
      }
    >
      <div className="connect-station-setup">
        <p>
          Sending Station: <strong>{controller.name}</strong>
        </p>
        {stale ? (
          <p role="alert">
            Station access changed. This setup cannot send requests under a
            different Station or credential. Return and reopen it.
          </p>
        ) : null}
        {!destination ? (
          <>
            <fieldset
              className="connect-station-methods"
              aria-label="Identify a Station"
            >
              <Button
                onClick={() => setMethod('address')}
                aria-pressed={method === 'address'}
              >
                Station address
              </Button>
              <Button
                onClick={() => setMethod('scan')}
                aria-pressed={method === 'scan'}
              >
                Scan QR
              </Button>
              <Button
                onClick={() => setMethod('code')}
                aria-pressed={method === 'code'}
              >
                Pairing code
              </Button>
            </fieldset>
            {method === 'scan' ? (
              <QRScanner
                onScan={acceptCode}
                onCancel={() => setMethod('address')}
                onManualEntry={() => setMethod('code')}
              />
            ) : method === 'code' ? (
              <>
                <label className="editor-field">
                  Station address for a short code
                  <input
                    className="editor-input"
                    value={address}
                    onChange={(event) => setAddress(event.target.value)}
                    placeholder="https://station.example"
                  />
                </label>
                <label className="editor-field">
                  Pairing code
                  <textarea
                    className="editor-input"
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                  />
                </label>
              </>
            ) : (
              <label className="editor-field">
                Station address
                <input
                  className="editor-input"
                  value={address}
                  onChange={(event) => setAddress(event.target.value)}
                  placeholder="https://station.example"
                  autoCapitalize="none"
                  autoCorrect="off"
                />
              </label>
            )}
            {method !== 'scan' ? (
              <Button
                variant="primary"
                disabled={
                  identify.isPending ||
                  stale ||
                  !(method === 'code' ? code.trim() : address.trim())
                }
                onClick={() =>
                  method === 'code'
                    ? acceptCode(code.trim())
                    : identify.mutate({ address })
                }
              >
                {identify.isPending ? 'Checking Station…' : 'Continue'}
              </Button>
            ) : null}
          </>
        ) : (
          <>
            <div className="connect-station-destination">
              <strong>{destination.label}</strong>
              <code>{destination.environmentId}</code>
              <span>
                Reported identity. Approval verifies the destination before
                access is saved.
              </span>
            </div>
            {!reservation &&
            !deviceStarted &&
            !devicePending &&
            !deviceSaved ? (
              <>
                <label>
                  <input
                    type="checkbox"
                    checked={deviceSelected}
                    disabled={peerInvitation}
                    onChange={(event) =>
                      setDeviceSelected(event.target.checked)
                    }
                  />{' '}
                  Use {destination.label} from this device
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={peerSelected}
                    onChange={(event) => setPeerSelected(event.target.checked)}
                  />{' '}
                  Let {controller.name} send work to {destination.label}
                </label>
                {peerInvitation ? (
                  <p>
                    This code offers peer access. Device access needs its own
                    invitation.
                  </p>
                ) : null}
                <p>
                  Each grant is approved and revoked separately. Peer access
                  does not grant Project execution consent.
                </p>
                <Button
                  variant="primary"
                  disabled={
                    stale ||
                    Boolean(error) ||
                    (!deviceSelected && !peerSelected)
                  }
                  onClick={() => {
                    if (peerSelected) requestPeer();
                    if (deviceSelected) setDeviceStarted(true);
                  }}
                >
                  Request selected access
                </Button>
                <Button
                  onClick={() => {
                    setDestination(null);
                    identify.reset();
                  }}
                >
                  Choose another Station
                </Button>
              </>
            ) : null}
            {peerSelected && reservation ? (
              <section aria-label="Peer access">
                <h3>
                  {controller.name} → {destination.label}
                </h3>
                <p role="status">
                  {status === 'connected'
                    ? 'Peer access approved. Project and Agent eligibility are checked separately when you choose a task destination.'
                    : status === 'pending'
                      ? 'Waiting for approval on the destination Station. Use its trusted operator session or host CLI; this device cannot approve itself.'
                      : status === 'outcome-unknown' || !status
                        ? 'The request outcome is unknown. Check this same request before starting any replacement.'
                        : `Peer setup: ${status}.`}
                </p>
                {observed?.error ? <p role="alert">{observed.error}</p> : null}
                {peerStatus.error ? (
                  <p role="alert">
                    The request status could not be read. Peer setup requires a
                    trusted operator session on {controller.name}; ordinary
                    device access cannot provision peers.
                  </p>
                ) : null}
                <p>
                  Approval expires:{' '}
                  {observed
                    ? new Date(observed.expiresAt).toLocaleString()
                    : 'Not yet reported'}
                </p>
                {start.error ? (
                  <Button disabled={peerBusy || stale} onClick={requestPeer}>
                    Retry this same request
                  </Button>
                ) : null}
                {status !== 'connected' && status !== 'cancelled' ? (
                  <>
                    <Button
                      disabled={peerBusy || stale}
                      onClick={() =>
                        complete.mutate(reservation, {
                          onSuccess: setEnrollment,
                        })
                      }
                    >
                      Check approval
                    </Button>
                    <Button disabled={peerBusy || stale} onClick={cancelPeer}>
                      Cancel peer request
                    </Button>
                  </>
                ) : null}
              </section>
            ) : null}
            {deviceStarted && !deviceSaved && !stale ? (
              <section aria-label="Device access">
                <h3>This device → {destination.label}</h3>
                <JoinDevicePairingPanel
                  initialMode={
                    pairingPayload || manualPairingCode ? 'manual' : 'direct'
                  }
                  initialManualEndpoint={destination.apiBase}
                  initialManualCode={manualPairingCode}
                  initialPairingPayload={pairingPayload}
                  directEndpoint={destination.apiBase}
                  directLabel={destination.label}
                  originIsStation={!profile.isTauri}
                  hostAppName={
                    profile.isTauri ? profile.productName : undefined
                  }
                  onCancel={() => setDeviceStarted(false)}
                  onApprovalPending={(pending) => {
                    const existing = connections.connections.find(
                      (connection) =>
                        connection.environmentId ===
                          destination.environmentId ||
                        connection.url === destination.apiBase,
                    );
                    const target =
                      existing ??
                      connections.addConnection(
                        destination.label,
                        destination.apiBase,
                      );
                    const persisted = {
                      ...pending,
                      expectedEnvironmentId: destination.environmentId,
                      targetConnectionId: target.id,
                      targetConnectionLabel: destination.label,
                      activateConnection: false,
                    };
                    savePendingExchange(persisted);
                    onApprovalPending(persisted);
                    setDeviceStarted(false);
                    setDevicePending(true);
                  }}
                  onPaired={async (result) => {
                    if (
                      scope?.isCurrent() === false ||
                      connections.apiBase !== controller.apiBase
                    )
                      throw new Error(
                        'Station access changed. Nothing was saved.',
                      );
                    if (
                      result.environmentId !== destination.environmentId ||
                      new URL(result.endpoint).origin !== destination.apiBase
                    )
                      throw new Error(
                        'Approved Station identity changed. Nothing was saved.',
                      );
                    const compatibility = await checkHostCompatibility(
                      destination.apiBase,
                    );
                    if (compatibility.blocking)
                      throw new Error(compatibility.reason);
                    if (
                      scope?.isCurrent() === false ||
                      connections.apiBase !== controller.apiBase
                    )
                      throw new Error(
                        'Station access changed. Nothing was saved.',
                      );
                    const existing = connections.connections.find(
                      (connection) =>
                        connection.environmentId ===
                          destination.environmentId ||
                        connection.url === destination.apiBase,
                    );
                    const target =
                      existing ??
                      connections.addConnection(
                        destination.label,
                        destination.apiBase,
                      );
                    await completeVerifiedPairing(
                      connections,
                      {
                        connectionId: target.id,
                        name: target.name,
                        endpoint: destination.apiBase,
                        activate: false,
                      },
                      result,
                    );
                    connections.reconcileHandshake(target.id, {
                      environmentId: result.environmentId,
                      authentication: { scheme: 'bearer', protocolVersion: 1 },
                    });
                    if (
                      scope?.isCurrent() === false ||
                      connections.apiBase !== controller.apiBase
                    )
                      throw new Error(
                        'Device access was saved, but Station access changed. Return to the original Station to review it.',
                      );
                    setDeviceSaved(true);
                  }}
                />
              </section>
            ) : null}
            {devicePending ? (
              <p role="status">
                Device access requested. Approval, denial, and expiry stay
                visible in connection status while you continue working here.
              </p>
            ) : null}
            {deviceSaved ? (
              <p role="status">
                Device access saved. Your current Station stays selected; choose
                the destination from Stations when you want to use it.
              </p>
            ) : null}
          </>
        )}
        {failure ? <p role="alert">{failure}</p> : null}
      </div>
    </Dialog>
  );
}
