import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { cancelNativeRelayLink } from '../../platform/native/nativeRelayLinkAdapter';
import {
  nativeRelayKeyApproval,
  type RelayKeyApprovalSurface,
  type RelayKeyCandidate,
} from '../../platform/native/relayKeyApproval';

function normalizeConfirmationCode(value: string): string | null {
  const normalized = value.replace(/[ -]/gu, '').toUpperCase();
  return /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{16}$/u.test(normalized)
    ? normalized
    : null;
}

function groupedConfirmationCode(code: string) {
  return code.match(/.{1,4}/gu)?.join('-') ?? code;
}

export function RelayRouteKeyApproval({
  profileName,
  brokerOrigin,
  stationId,
  enrollmentId,
  linkedInvitation,
  publicSetupIntent = false,
}: {
  profileName: string;
  brokerOrigin: string;
  stationId: string;
  enrollmentId: string;
  publicSetupIntent?: boolean;
  linkedInvitation?: {
    pendingId: string;
    expectedUpdatedAt: number;
    surface: Omit<
      RelayKeyApprovalSurface,
      | 'profileName'
      | 'brokerOrigin'
      | 'stationId'
      | 'enrollmentId'
      | 'publicKey'
    >;
    expiresAt: number;
  };
}) {
  const linkedPendingId = linkedInvitation?.pendingId;
  const id = useId();
  const queryClient = useQueryClient();
  const [invitation, setInvitation] = useState('');
  const [confirmationCode, setConfirmationCode] = useState('');
  const [approvalKeyId, setApprovalKeyId] = useState('');
  const [separateChannelConfirmed, setSeparateChannelConfirmed] =
    useState(false);
  const [rotationReview, setRotationReview] = useState(false);
  const [revokeKeyId, setRevokeKeyId] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [surface, setSurface] = useState<RelayKeyApprovalSurface | null>(null);
  const hasPendingSession = useRef(false);
  const activeAttemptId = useRef(0);
  const invitationAttempt = useRef<{ id: number; json: string } | null>(null);
  const key = ['native-relay-key-approval', profileName] as const;
  const statusQuery = useQuery({
    queryKey: [...key, 'status'],
    queryFn: () => nativeRelayKeyApproval.status(profileName),
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
  const pendingQuery = useQuery({
    queryKey: [...key, 'pending'],
    queryFn: () => nativeRelayKeyApproval.pending(profileName),
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: [...key, 'status'] }),
      queryClient.invalidateQueries({ queryKey: [...key, 'pending'] }),
    ]);
  };
  const begin = useMutation({
    mutationFn: (attemptId: number) => {
      if (linkedInvitation) {
        if (
          !surface ||
          surface.appIdentifier !== linkedInvitation.surface.appIdentifier ||
          surface.channel !== linkedInvitation.surface.channel ||
          surface.clientInstanceId !==
            linkedInvitation.surface.clientInstanceId ||
          surface.keyThumbprint !== linkedInvitation.surface.keyThumbprint ||
          linkedInvitation.expiresAt <= Date.now()
        )
          throw new Error(
            'Linked invitation does not match this native install proof.',
          );
        return nativeRelayKeyApproval.beginLinked({
          pendingId: linkedInvitation.pendingId,
          profileName,
          expectedUpdatedAt: linkedInvitation.expectedUpdatedAt,
        });
      }
      const input = invitationAttempt.current;
      invitationAttempt.current = null;
      if (!input || input.id !== attemptId) {
        throw new Error('Station invitation is no longer available.');
      }
      return nativeRelayKeyApproval.begin(profileName, input.json);
    },
    onSuccess: async (_candidate, attemptId) => {
      if (attemptId !== activeAttemptId.current) return;
      setInvitation('');
      setConfirmationCode('');
      setApprovalKeyId('');
      setSeparateChannelConfirmed(false);
      setMessage('Enter both values from the Station owner, then confirm.');
      await refresh();
    },
    onError: (_error, attemptId) => {
      if (attemptId !== activeAttemptId.current) return;
      setInvitation('');
      invitationAttempt.current = null;
      setConfirmationCode('');
      setApprovalKeyId('');
      setSeparateChannelConfirmed(false);
      setMessage(
        'Couldn’t check this Station. Ask its owner for a new setup link.',
      );
    },
  });
  const cancel = useMutation({
    mutationFn: () =>
      linkedInvitation
        ? cancelNativeRelayLink(linkedInvitation.pendingId)
        : nativeRelayKeyApproval.cancel(profileName),
    onSuccess: async () => {
      activeAttemptId.current += 1;
      hasPendingSession.current = false;
      setRotationReview(false);
      setSurface(null);
      setInvitation('');
      invitationAttempt.current = null;
      setConfirmationCode('');
      setApprovalKeyId('');
      setSeparateChannelConfirmed(false);
      setMessage(
        'Pending Station key discovery was cancelled. Durable trust was not changed.',
      );
      await refresh();
    },
    onError: () =>
      setMessage(
        'Could not cancel pending Station key discovery. Check native status before continuing.',
      ),
  });
  const prepare = useMutation({
    mutationFn: () => nativeRelayKeyApproval.prepare(profileName),
    onSuccess: (prepared) => {
      setSurface(prepared);
      setMessage(
        'Native install proof is ready. Share this public surface metadata with the Station operator to create a matching invitation.',
      );
    },
    onError: () =>
      setMessage(
        'Could not prepare this native Station identity. The route remains untrusted.',
      ),
  });
  const approve = useMutation({
    mutationFn: ({
      candidate,
      normalizedCode,
      fullKeyId,
    }: {
      candidate: RelayKeyCandidate;
      normalizedCode: string;
      fullKeyId: string;
    }) =>
      nativeRelayKeyApproval.approve({
        pendingId: candidate.pendingId,
        confirmationCode: normalizedCode,
        fullKeyId,
      }),
    onSuccess: async () => {
      hasPendingSession.current = false;
      setRotationReview(false);
      setConfirmationCode('');
      setApprovalKeyId('');
      setSeparateChannelConfirmed(false);
      setMessage('Station confirmed. Device access comes next.');
      await refresh();
    },
    onError: async () => {
      setMessage(
        'Approval failed. The comparison values have been cleared; start a fresh key discovery and compare again.',
      );
      setConfirmationCode('');
      setApprovalKeyId('');
      setSeparateChannelConfirmed(false);
      await refresh();
    },
  });
  const revoke = useMutation({
    mutationFn: (input: { expectedTrustRevision: number; fullKeyId: string }) =>
      nativeRelayKeyApproval.revoke({
        profileName,
        expectedTrustRevision: input.expectedTrustRevision,
        fullKeyId: input.fullKeyId,
      }),
    onSuccess: async () => {
      setRevokeKeyId('');
      setSurface(null);
      setInvitation('');
      setMessage('Station signing-key trust revoked on this device.');
      await refresh();
    },
    onError: () =>
      setMessage(
        'Could not revoke Station key trust. Confirm native key storage is available and retry.',
      ),
  });
  const candidate = pendingQuery.data;
  useEffect(() => {
    if (candidate) hasPendingSession.current = true;
  }, [candidate]);
  const busy =
    begin.isPending ||
    approve.isPending ||
    revoke.isPending ||
    cancel.isPending;
  const candidateMatchesRoute =
    candidate?.brokerOrigin === brokerOrigin &&
    candidate.stationId === stationId &&
    candidate.enrollmentId === enrollmentId;
  const surfaceMatchesRoute =
    surface?.profileName === profileName &&
    surface.brokerOrigin === brokerOrigin &&
    surface.stationId === stationId &&
    surface.enrollmentId === enrollmentId;
  const trustStatusCurrent =
    !statusQuery.isPending &&
    !statusQuery.isFetching &&
    !statusQuery.isError &&
    statusQuery.data !== undefined;
  const statusMatchesRoute =
    trustStatusCurrent &&
    statusQuery.data?.profileName === profileName &&
    statusQuery.data.brokerOrigin === brokerOrigin &&
    statusQuery.data.stationId === stationId &&
    statusQuery.data.enrollmentId === enrollmentId;
  const status = statusQuery.isError
    ? 'unavailable'
    : !trustStatusCurrent
      ? 'checking'
      : statusQuery.data
        ? statusMatchesRoute
          ? statusQuery.data.status
          : 'mismatch'
        : 'untrusted';
  const canStartEnrollment =
    trustStatusCurrent &&
    (status === 'untrusted' ||
      status === 'revoked' ||
      (status === 'approved' && rotationReview));
  const canPrepareSurface =
    canStartEnrollment ||
    (publicSetupIntent &&
      trustStatusCurrent &&
      statusMatchesRoute &&
      status === 'approved');
  const canApprove = Boolean(
    candidate &&
      candidateMatchesRoute &&
      trustStatusCurrent &&
      (status === 'untrusted' ||
        status === 'revoked' ||
        (status === 'approved' &&
          candidate.keyId !== statusQuery.data?.keyId)) &&
      separateChannelConfirmed &&
      normalizeConfirmationCode(candidate.confirmationCode) !== null &&
      normalizeConfirmationCode(candidate.confirmationCode) ===
        normalizeConfirmationCode(confirmationCode) &&
      candidate.keyId === approvalKeyId.trim() &&
      candidate.expiresAt > Date.now(),
  );
  const canRevoke = Boolean(
    trustStatusCurrent &&
      statusQuery.data?.status === 'approved' &&
      statusMatchesRoute &&
      statusQuery.data.keyId &&
      statusQuery.data.keyId === revokeKeyId.trim(),
  );
  useEffect(
    () => () => {
      activeAttemptId.current += 1;
      if (hasPendingSession.current && !linkedPendingId) {
        invitationAttempt.current = null;
        void nativeRelayKeyApproval.cancel(profileName).catch(() => undefined);
      }
    },
    [profileName, linkedPendingId],
  );
  async function copySurfaceMetadata() {
    if (!surfaceMatchesRoute || !surface) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(surface, null, 2));
      setMessage('Device details copied. Share them with the Station owner.');
    } catch {
      setMessage(
        'Could not copy install proof. Select the public values above and share them with the Station operator.',
      );
    }
  }
  function cancelKeyReview() {
    setRotationReview(false);
    setSurface(null);
    setInvitation('');
    setConfirmationCode('');
    setApprovalKeyId('');
    setSeparateChannelConfirmed(false);
    if (hasPendingSession.current) {
      activeAttemptId.current += 1;
      void cancel.mutateAsync().catch(() => undefined);
      return;
    }
    setMessage(
      'New Station key review cancelled. The currently approved key remains trusted.',
    );
  }

  return (
    <section
      className="relay-route-key-approval native-relay-setup"
      aria-label="Station signing-key trust"
    >
      <h3>Confirm this Station</h3>
      <p className="connections-computers__note">
        Confirm who you’re connecting to before giving this device access.
      </p>
      <div
        className={`relay-route-trust relay-route-trust--${status}`}
        role="status"
      >
        <strong>
          {statusQuery.isPending
            ? 'Checking Station identity…'
            : status === 'approved'
              ? 'Station confirmed'
              : status === 'revoked'
                ? 'Station confirmation removed'
                : status === 'mismatch'
                  ? 'Station identity changed'
                  : statusQuery.isError
                    ? 'Station identity unavailable'
                    : 'Station needs confirmation'}
        </strong>
        <span>
          {status === 'approved'
            ? 'Identity confirmed. Device access is a separate step.'
            : statusQuery.isError
              ? 'Try again when this device’s secure storage is available.'
              : 'Ask the Station owner to help you confirm its identity.'}
        </span>
      </div>
      {trustStatusCurrent &&
        statusQuery.data?.status !== 'untrusted' &&
        statusQuery.data?.keyId && (
          <details className="relay-route-key-approval__durable">
            <summary>Confirmation details</summary>
            <dl>
              <div>
                <dt>Station ID</dt>
                <dd>{statusQuery.data.stationId}</dd>
              </div>
              <div>
                <dt>Enrollment ID</dt>
                <dd>{statusQuery.data.enrollmentId}</dd>
              </div>
              <div>
                <dt>Generation</dt>
                <dd>{statusQuery.data.generation ?? 'unknown'}</dd>
              </div>
              <div>
                <dt>Full key ID</dt>
                <dd className="relay-route-trust-approval__key-id">
                  {statusQuery.data.keyId}
                </dd>
              </div>
              <div>
                <dt>Trust revision</dt>
                <dd>{statusQuery.data.trustRevision}</dd>
              </div>
            </dl>
          </details>
        )}

      {status === 'approved' && !rotationReview && !candidate && (
        <details open={Boolean(linkedInvitation)}>
          <summary>Review a changed Station identity</summary>
          <Button disabled={busy} onClick={() => setRotationReview(true)}>
            Review new Station key
          </Button>
        </details>
      )}

      {canPrepareSurface && !candidate && !surfaceMatchesRoute && (
        <div className="relay-route-key-approval__prepare">
          <p className="connections-computers__note">
            Share this device’s public details with the Station owner. They’ll
            send you a setup link.
          </p>
          <Button
            variant="primary"
            disabled={busy}
            pending={prepare.isPending}
            pendingLabel="Preparing…"
            onClick={() => void prepare.mutateAsync().catch(() => undefined)}
          >
            Prepare device details
          </Button>
          {status === 'approved' && rotationReview && (
            <Button
              variant="danger-outline"
              disabled={cancel.isPending}
              onClick={cancelKeyReview}
            >
              Cancel key review
            </Button>
          )}
        </div>
      )}
      {canPrepareSurface && !candidate && surfaceMatchesRoute && surface && (
        <section
          className="relay-route-key-approval__surface"
          aria-label="Public install proof metadata"
        >
          <p>
            {linkedInvitation
              ? 'Check this Station with its owner before continuing.'
              : 'Share these device details with the Station owner for approval.'}
          </p>
          <details>
            <summary>Device details (public)</summary>
            <dl>
              <div>
                <dt>App</dt>
                <dd>{surface.appIdentifier}</dd>
              </div>
              <div>
                <dt>Channel</dt>
                <dd>{surface.channel}</dd>
              </div>
              <div>
                <dt>Client instance</dt>
                <dd>{surface.clientInstanceId}</dd>
              </div>
              <div>
                <dt>Key thumbprint</dt>
                <dd>
                  <code>{surface.keyThumbprint}</code>
                </dd>
              </div>
              <div>
                <dt>Public key</dt>
                <dd>
                  <code className="relay-route-trust-approval__key-id">
                    {JSON.stringify(surface.publicKey)}
                  </code>
                </dd>
              </div>
            </dl>
          </details>
          {!linkedInvitation && (
            <Button
              variant="primary"
              onClick={() => void copySurfaceMetadata()}
            >
              Copy device details
            </Button>
          )}
          {!linkedInvitation && (
            <details>
              <summary>Advanced: paste a setup invitation</summary>
              <label className="editor-field" htmlFor={`${id}-invitation`}>
                <span className="editor-label">
                  One-time Station invitation
                </span>
                <input
                  id={`${id}-invitation`}
                  className="editor-input"
                  type="password"
                  value={invitation}
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="Paste the one-time v2 invitation JSON"
                  onChange={(event) => setInvitation(event.target.value)}
                  onPaste={(event) => {
                    const text =
                      event.clipboardData.getData('text/plain') ||
                      event.clipboardData.getData('text');
                    if (!text) return;
                    event.preventDefault();
                    setInvitation(text.replace(/\r\n?|\n/gu, ''));
                  }}
                />
              </label>
            </details>
          )}
          <Button
            disabled={
              (!linkedInvitation && !invitation.trim()) ||
              busy ||
              Boolean(
                linkedInvitation && linkedInvitation.expiresAt <= Date.now(),
              )
            }
            pending={begin.isPending}
            onClick={() => {
              const attemptId = ++activeAttemptId.current;
              const oneTimeInvitation = invitation;
              setInvitation('');
              invitationAttempt.current = {
                id: attemptId,
                json: oneTimeInvitation,
              };
              hasPendingSession.current = true;
              void begin.mutateAsync(attemptId).catch(() => undefined);
            }}
          >
            Check this Station
          </Button>
          {begin.isPending && (
            <Button
              variant="danger-outline"
              onClick={() => {
                if (rotationReview) cancelKeyReview();
                else void cancel.mutateAsync().catch(() => undefined);
              }}
            >
              Cancel key discovery
            </Button>
          )}
          {status === 'approved' && rotationReview && !begin.isPending && (
            <Button
              variant="danger-outline"
              disabled={cancel.isPending}
              onClick={cancelKeyReview}
            >
              Cancel key review
            </Button>
          )}
        </section>
      )}

      {candidate && candidateMatchesRoute && (
        <section
          className="relay-route-key-approval__candidate"
          aria-label="Candidate from native verification"
        >
          <p>
            Ask the Station owner for the code and full key ID through a
            separate trusted channel. Compare both before confirming.
          </p>
          <div className="native-relay-setup__code">
            {groupedConfirmationCode(
              normalizeConfirmationCode(candidate.confirmationCode) ??
                candidate.confirmationCode,
            )}
          </div>
          <div className="native-relay-setup__comparison-key">
            <span>Station key ID</span>
            <code>{candidate.keyId}</code>
          </div>

          <label className="editor-field" htmlFor={`${id}-code`}>
            <span className="editor-label">Operator comparison code</span>
            <input
              id={`${id}-code`}
              className="editor-input"
              value={confirmationCode}
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              onChange={(event) => setConfirmationCode(event.target.value)}
            />
          </label>
          <label className="editor-field" htmlFor={`${id}-key-id`}>
            <span className="editor-label">
              Full key ID confirmed by operator
            </span>
            <input
              id={`${id}-key-id`}
              className="editor-input"
              value={approvalKeyId}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              onChange={(event) => setApprovalKeyId(event.target.value)}
            />
          </label>
          <label className="relay-route-key-approval__attestation">
            <input
              type="checkbox"
              checked={separateChannelConfirmed}
              onChange={(event) =>
                setSeparateChannelConfirmed(event.target.checked)
              }
            />
            <span>
              I compared both values with the Station owner through a separate
              trusted channel.
            </span>
          </label>
          <Button
            variant="primary"
            disabled={!canApprove || busy}
            pending={approve.isPending}
            pendingLabel="Approving…"
            onClick={() => {
              const normalizedCode =
                normalizeConfirmationCode(confirmationCode);
              if (!candidate || !normalizedCode) return;
              void approve
                .mutateAsync({
                  candidate,
                  normalizedCode,
                  fullKeyId: approvalKeyId.trim(),
                })
                .catch(() => undefined);
            }}
          >
            Confirm Station
          </Button>
          <Button
            variant="danger-outline"
            disabled={busy}
            onClick={() => void cancel.mutateAsync().catch(() => undefined)}
          >
            Cancel confirmation
          </Button>
          <details>
            <summary>Route and timing details</summary>
            <dl>
              <div>
                <dt>Saved route</dt>
                <dd>
                  {candidate.profileName} · {candidate.brokerOrigin}
                </dd>
              </div>
              <div>
                <dt>Station ID</dt>
                <dd>{candidate.stationId}</dd>
              </div>
              <div>
                <dt>Enrollment ID</dt>
                <dd>{candidate.enrollmentId}</dd>
              </div>
              <div>
                <dt>Generation</dt>
                <dd>{candidate.generation}</dd>
              </div>
              <div>
                <dt>Expires</dt>
                <dd>{new Date(candidate.expiresAt).toLocaleString()}</dd>
              </div>
            </dl>
          </details>
        </section>
      )}
      {candidate && !candidateMatchesRoute && (
        <p className="connections-computers__alert" role="alert">
          Pending candidate does not match this saved broker route. Start a
          fresh discovery.
        </p>
      )}
      {status === 'approved' && (
        <details className="relay-route-key-approval__revoke">
          <summary>Advanced: remove Station confirmation</summary>
          <label className="editor-field" htmlFor={`${id}-revoke-key-id`}>
            <span className="editor-label">
              Type the current full key ID to confirm revocation
            </span>
            <input
              id={`${id}-revoke-key-id`}
              className="editor-input"
              value={revokeKeyId}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              onChange={(event) => setRevokeKeyId(event.target.value)}
            />
          </label>
          <Button
            variant="danger"
            disabled={!canRevoke || busy}
            onClick={() =>
              void revoke
                .mutateAsync({
                  expectedTrustRevision: statusQuery.data?.trustRevision ?? 0,
                  fullKeyId: revokeKeyId.trim(),
                })
                .catch(() => undefined)
            }
          >
            Revoke Station key trust
          </Button>
        </details>
      )}

      {pendingQuery.isError && (
        <p className="connections-computers__alert" role="alert">
          Could not load the native pending candidate. Retry after checking
          native key trust.
        </p>
      )}
      {message && (
        <p className="connections-computers__note" role="status">
          {message}
        </p>
      )}
    </section>
  );
}
