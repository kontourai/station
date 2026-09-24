import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '../../components/Button';
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
}: {
  profileName: string;
  brokerOrigin: string;
  stationId: string;
  enrollmentId: string;
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const [invitation, setInvitation] = useState('');
  const [confirmationCode, setConfirmationCode] = useState('');
  const [approvalKeyId, setApprovalKeyId] = useState('');
  const [separateChannelConfirmed, setSeparateChannelConfirmed] =
    useState(false);
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
      setMessage('Candidate received from the native Station verifier.');
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
        'Could not discover the Station key. The invitation has been cleared; request a fresh invitation before retrying.',
      );
    },
  });
  const cancel = useMutation({
    mutationFn: () => nativeRelayKeyApproval.cancel(profileName),
    onSuccess: async () => {
      activeAttemptId.current += 1;
      hasPendingSession.current = false;
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
      setConfirmationCode('');
      setApprovalKeyId('');
      setSeparateChannelConfirmed(false);
      setMessage('Station signing key approved on this device.');
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
  const busy = begin.isPending || approve.isPending || revoke.isPending;
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
      if (hasPendingSession.current) {
        activeAttemptId.current += 1;
        invitationAttempt.current = null;
        void nativeRelayKeyApproval.cancel(profileName).catch(() => undefined);
      }
    },
    [profileName],
  );
  async function copySurfaceMetadata() {
    if (!surfaceMatchesRoute || !surface) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(surface, null, 2));
      setMessage(
        'Public install proof copied. It contains no private key or account credential.',
      );
    } catch {
      setMessage(
        'Could not copy install proof. Select the public values above and share them with the Station operator.',
      );
    }
  }

  return (
    <section
      className="relay-route-key-approval"
      aria-label="Station signing-key trust"
    >
      <h3>Station signing-key trust</h3>
      <p className="connections-computers__note">
        Approval records which Station key this device trusts. It does not
        connect the route, sign in an account, enroll a Device, or grant Project
        access.
      </p>
      <div
        className={`relay-route-trust relay-route-trust--${status}`}
        role="status"
      >
        <strong>
          {statusQuery.isPending
            ? 'Checking native key trust…'
            : status === 'approved'
              ? 'Station key approved'
              : status === 'revoked'
                ? 'Station key trust revoked'
                : status === 'mismatch'
                  ? 'Trust belongs to a different Station enrollment'
                  : statusQuery.isError
                    ? 'Native key trust unavailable'
                    : 'Station key untrusted'}
        </strong>
        <span>
          {status === 'approved'
            ? `Trust revision ${statusQuery.data?.trustRevision ?? 'unknown'}. Route remains disconnected.`
            : status === 'revoked'
              ? 'This saved route has no trusted Station signing key.'
              : status === 'mismatch'
                ? 'The stored key belongs to another Station or enrollment. This route remains untrusted.'
                : statusQuery.isError
                  ? 'The route remains untrusted until native trust can be checked.'
                  : 'The saved route does not establish Station identity.'}
        </span>
      </div>
      {trustStatusCurrent &&
        statusQuery.data?.status !== 'untrusted' &&
        statusQuery.data?.keyId && (
          <section className="relay-route-key-approval__durable">
            <strong>Durable Station key record</strong>
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
          </section>
        )}

      {!candidate && !surfaceMatchesRoute && (
        <div className="relay-route-key-approval__prepare">
          <p className="connections-computers__note">
            First prepare this device’s public install proof. The operator needs
            this surface metadata to issue an invitation bound to this app,
            channel, installation, and key.
          </p>
          <Button
            disabled={busy}
            pending={prepare.isPending}
            pendingLabel="Preparing…"
            onClick={() => void prepare.mutateAsync().catch(() => undefined)}
          >
            Prepare native Station identity
          </Button>
        </div>
      )}
      {!candidate && surfaceMatchesRoute && surface && (
        <section
          className="relay-route-key-approval__surface"
          aria-label="Public install proof metadata"
        >
          <h4>Public install proof for the Station operator</h4>
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
          <p className="connections-computers__note">
            This is public install proof, not an account, Device, or Project
            credential. Share it with the Station operator so they can issue a
            one-time invitation.
          </p>
          <Button onClick={() => void copySurfaceMetadata()}>
            Copy public install proof
          </Button>
          <label className="editor-field" htmlFor={`${id}-invitation`}>
            <span className="editor-label">One-time Station invitation</span>
            <textarea
              id={`${id}-invitation`}
              className="editor-input"
              value={invitation}
              rows={4}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="Paste the one-time v2 invitation JSON"
              onChange={(event) => setInvitation(event.target.value)}
            />
          </label>
          <Button
            disabled={!invitation.trim() || busy}
            pending={begin.isPending}
            pendingLabel="Checking Station…"
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
            Discover Station key
          </Button>
          {begin.isPending && (
            <Button
              variant="danger-outline"
              onClick={() => void cancel.mutateAsync().catch(() => undefined)}
            >
              Cancel key discovery
            </Button>
          )}
        </section>
      )}

      {candidate && candidateMatchesRoute && (
        <section
          className="relay-route-key-approval__candidate"
          aria-label="Candidate from native verification"
        >
          <h4>Candidate from native verification</h4>
          <dl>
            <div>
              <dt>Status</dt>
              <dd>Untrusted candidate</dd>
            </div>
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
              <dt>Full key ID</dt>
              <dd className="relay-route-trust-approval__key-id">
                {candidate.keyId}
              </dd>
            </div>
            <div>
              <dt>Comparison code</dt>
              <dd>
                <code>
                  {groupedConfirmationCode(
                    normalizeConfirmationCode(candidate.confirmationCode) ??
                      candidate.confirmationCode,
                  )}
                </code>
              </dd>
            </div>
            <div>
              <dt>Expires</dt>
              <dd>{new Date(candidate.expiresAt).toLocaleString()}</dd>
            </div>
          </dl>
          <p className="connections-computers__note">
            Compare the code and full key ID through a separate trusted channel
            with the Station operator. The broker-provided candidate is not
            trusted until you enter both values below.
          </p>
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
              I got these values from the Station operator through a separate
              channel, not from this invitation or broker.
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
            Approve Station key
          </Button>
          <Button
            variant="danger-outline"
            disabled={busy}
            onClick={() => void cancel.mutateAsync().catch(() => undefined)}
          >
            Cancel candidate
          </Button>
        </section>
      )}
      {candidate && !candidateMatchesRoute && (
        <p className="connections-computers__alert" role="alert">
          Pending candidate does not match this saved broker route. Start a
          fresh discovery.
        </p>
      )}
      {status === 'approved' && (
        <div className="relay-route-key-approval__revoke">
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
        </div>
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
