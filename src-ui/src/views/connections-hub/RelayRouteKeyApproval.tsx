import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { cancelNativeRelayLink } from '../../platform/native/nativeRelayLinkCancellation';
import { publishNativeRelaySetupChange } from '../../platform/native/nativeRelaySetupState';
import {
  nativeRelayKeyApproval,
  type RelayKeyApprovalSurface,
  type RelayKeyCandidate,
} from '../../platform/native/relayKeyApproval';
import { RelaySetupHelp } from './RelaySetupHelp';

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
    onSettled: () => publishNativeRelaySetupChange(profileName),
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
    onSettled: () => publishNativeRelaySetupChange(profileName),
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
        'The pending confirmation was closed. Review the Station status before continuing.',
      );
      await refresh();
    },
    onError: () =>
      setMessage(
        'Couldn’t close this confirmation. Check the Station’s status before continuing.',
      ),
  });
  const prepare = useMutation({
    mutationFn: () => nativeRelayKeyApproval.prepare(profileName),
    onSuccess: (prepared) => {
      setSurface(prepared);
      setMessage('Setup info ready. Send it to the owner.');
    },
    onError: () =>
      setMessage(
        'Couldn’t prepare setup info. Your Station confirmation is unchanged.',
      ),
  });
  const approve = useMutation({
    onSettled: () => publishNativeRelaySetupChange(profileName),
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
        'Confirmation wasn’t verified. Check the Station’s confirmation status before continuing.',
      );
      setConfirmationCode('');
      setApprovalKeyId('');
      setSeparateChannelConfirmed(false);
      await refresh();
    },
  });
  const revoke = useMutation({
    onSettled: () => publishNativeRelaySetupChange(profileName),
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
      setMessage('Station confirmation removed from this device.');
      await refresh();
    },
    onError: () =>
      setMessage(
        'Removal wasn’t confirmed. Check this Station’s confirmation status.',
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
  const compactConfirmed =
    status === 'approved' && !rotationReview && !candidate;
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
      setMessage('Setup info copied. Send it to the owner.');
    } catch {
      setMessage('Couldn’t copy. Open Setup info and send it to the owner.');
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
      'Confirmation review closed. Your previously confirmed Station is unchanged.',
    );
  }

  return (
    <section
      className={`relay-route-key-approval native-relay-setup ${compactConfirmed ? 'relay-route-key-approval--confirmed' : ''}`}
      aria-label="Station signing-key trust"
    >
      {!compactConfirmed && (
        <div className="native-relay-setup__heading">
          <h3>Confirm this Station</h3>
          <RelaySetupHelp label="About Station confirmation">
            <p>
              Compare the code and full key ID with the owner using a separate
              call or message. This confirms the Station’s identity. Device and
              account access are approved separately.
            </p>
          </RelaySetupHelp>
        </div>
      )}
      {linkedInvitation && !compactConfirmed && (
        <p className="connections-computers__note">
          {linkedInvitation.expiresAt === Number.MAX_SAFE_INTEGER
            ? 'Setup link: no expiry.'
            : `Setup link expires ${new Date(linkedInvitation.expiresAt).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}.`}
        </p>
      )}
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
        {!compactConfirmed && status !== 'untrusted' && (
          <span>
            {status === 'approved'
              ? null
              : statusQuery.isError
                ? 'Try again when this device’s secure storage is available.'
                : 'Ask the Station owner to help you confirm its identity.'}
          </span>
        )}
      </div>
      {canPrepareSurface && !candidate && !surfaceMatchesRoute && (
        <div className="relay-route-key-approval__prepare">
          <p className="connections-computers__note">
            Send setup info to the owner for approval.
          </p>
          <Button
            variant="primary"
            disabled={busy}
            pending={prepare.isPending}
            pendingLabel="Preparing…"
            onClick={() => void prepare.mutateAsync().catch(() => undefined)}
          >
            Share setup info
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
              ? 'Confirm this Station with its owner.'
              : 'Send setup info to the owner for approval.'}
          </p>
          <details>
            <summary>Setup info</summary>
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
              Copy setup info
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
          <p>Get the code and key ID from the owner outside this app.</p>
          {candidate.expiresAt <= Date.now() && (
            <p role="status">
              This check expired. Open a new invitation from the owner.
            </p>
          )}

          <label className="editor-field" htmlFor={`${id}-code`}>
            <span className="editor-label">Owner’s code</span>
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
            <span className="editor-label">Owner’s key ID</span>
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
            <span>I checked both values with the owner.</span>
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
            <summary>Station identity details</summary>
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
          This confirmation belongs to another Station. Ask the owner for a
          matching link.
        </p>
      )}
      {trustStatusCurrent &&
      statusQuery.data?.status !== 'untrusted' &&
      statusQuery.data?.keyId ? (
        <details>
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
          {status === 'approved' && !rotationReview && !candidate ? (
            <Button disabled={busy} onClick={() => setRotationReview(true)}>
              Review new Station key
            </Button>
          ) : null}
          {status === 'approved' ? (
            <section aria-label="Remove Station confirmation">
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
                      expectedTrustRevision:
                        statusQuery.data?.trustRevision ?? 0,
                      fullKeyId: revokeKeyId.trim(),
                    })
                    .catch(() => undefined)
                }
              >
                Revoke Station key trust
              </Button>
            </section>
          ) : null}
        </details>
      ) : null}
      {pendingQuery.isError && (
        <p className="connections-computers__alert" role="alert">
          Couldn’t check this Station’s confirmation. Check its status before
          continuing.
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
