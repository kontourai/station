import { useConnections } from '@kontourai/station-connect';
import type { StationProfile } from '@kontourai/station-contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { Button } from '../../components/Button';
import { ConfirmModal } from '../../components/modals/ConfirmModal';
import { PageRow } from '../../components/PageRow';
import { SkeletonBlock } from '../../components/state';
import {
  useHostRequestAuthorityScope,
  useNativeRelayAccountSession,
} from '../../contexts/ApiBaseContext';
import {
  type NativeRelayGrantRedemptionFailureCode,
  type NativeRelayGrantState,
  nativeRelayGrantAdapter,
} from '../../platform/native/nativeRelayGrantAdapter';
import { MAX_NATIVE_RELAY_ROUTES_TO_SUPERVISE } from '../../platform/native/nativeRelayGrantRenewalSupervisor';
import { nativeRelayKeyApproval } from '../../platform/native/relayKeyApproval';
import {
  nativeProfileRepository,
  usePlatformProfile,
} from '../../platform/PlatformProfileContext';
import { NativeRelayEnrollmentWizard } from './NativeRelayEnrollmentWizard';
import { RelayRouteKeyApproval } from './RelayRouteKeyApproval';
import { RelayRouteProfileDialog } from './RelayRouteProfileDialog';
import './ComputersSection.css';

const NO_RELAY_PROFILES: readonly StationProfile[] = [];
const NO_SUBSCRIBE = () => () => {};

const grantFailureCopy: Record<NativeRelayGrantRedemptionFailureCode, string> =
  {
    invalidProfile:
      'The saved route is unavailable. Refresh the route list and try again.',
    staleProfile: 'The saved route changed. Review it and try again.',
    stationTrustRequired:
      'Approve this Station signing key separately before redeeming a routing grant.',
    invitationInvalid:
      'The operator invitation was rejected. Check that you pasted the complete invitation.',
    invitationExpired:
      'This operator invitation has expired. Ask the Station operator for a new one.',
    stationTrustUnavailable:
      'Station trust could not be verified. Try again when the device key store is available.',
    proofKey: 'The native Station proof key could not be used.',
    proofKeyMissing:
      'The native Station proof key is unavailable on this device.',
    brokerTransport:
      'The broker could not be reached. Check the saved broker address and connection.',
    brokerRejected: 'The broker did not accept this invitation.',
    grantInvalid: 'The broker returned a grant Station could not verify.',
    grantStore: 'Station could not safely store the routing grant.',
    grantMissing: 'No existing grant was available for this route.',
    grantExists:
      'A routing grant already exists for this route. Refresh its status.',
    grantExpired:
      'The routing grant has expired. Ask the operator for a new invitation.',
    grantRenewalConflict:
      'The routing grant changed during setup. Refresh its status.',
    grantRenewalNotDue: 'The routing grant is not ready for renewal.',
  };

function grantQueryKey(profile: StationProfile) {
  const route = profile.relayRoute!;
  return [
    'native-relay-grant',
    profile.name.toLowerCase(),
    profile.updatedAt,
    route.brokerOrigin,
    route.stationId,
    route.enrollmentId,
  ] as const;
}

function grantSelection(profile: StationProfile) {
  const route = profile.relayRoute!;
  return {
    profileName: profile.name,
    expectedRoute: {
      brokerOrigin: route.brokerOrigin,
      stationId: route.stationId,
      enrollmentId: route.enrollmentId,
    },
  };
}

function NativeRelayGrantControls({ profile }: { profile: StationProfile }) {
  const [enrollmentStarted, setEnrollmentStarted] = useState(false);
  const queryClient = useQueryClient();
  const [invitation, setInvitation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const selection = grantSelection(profile);
  const queryKey = grantQueryKey(profile);
  const status = useQuery({
    queryKey,
    queryFn: () => nativeRelayGrantAdapter.status(selection),
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
  const trust = useQuery({
    queryKey: ['native-relay-key-approval', profile.name, 'status'],
    queryFn: () => nativeRelayKeyApproval.status(profile.name),
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
  const trustMatchesRoute = Boolean(
    trust.data?.status === 'approved' &&
      trust.data.profileName === profile.name &&
      trust.data.brokerOrigin === selection.expectedRoute.brokerOrigin &&
      trust.data.stationId === selection.expectedRoute.stationId &&
      trust.data.enrollmentId === selection.expectedRoute.enrollmentId,
  );
  const activeGrant = status.data?.grants[0];
  const cleanupPending = Boolean(
    status.data?.cleanups.some(
      (cleanup) =>
        !cleanup.brokerRetired ||
        (cleanup.localCleanupRequired && !cleanup.localCleanupComplete),
    ),
  );
  const canEnroll = Boolean(
    trustMatchesRoute &&
      activeGrant &&
      !activeGrant.expired &&
      activeGrant.metadata.expiresAt > Date.now() &&
      !cleanupPending,
  );
  const redeem = useMutation({
    mutationFn: async (invitationJson: string) => {
      setError(null);
      const currentProfile = nativeProfileRepository()
        .getRelayRouteProfiles()
        .find(
          (candidate) =>
            candidate.name.toLowerCase() === profile.name.toLowerCase(),
        );
      if (
        !currentProfile ||
        currentProfile.updatedAt !== profile.updatedAt ||
        JSON.stringify(currentProfile.relayRoute) !==
          JSON.stringify(profile.relayRoute)
      )
        throw new Error('staleProfile');

      const freshStatus = await status.refetch();
      if (!freshStatus.data || freshStatus.data.profileRevision < 1)
        throw new Error('statusUnavailable');

      const trustStatus = await queryClient.fetchQuery({
        queryKey: ['native-relay-key-approval', profile.name, 'status'],
        queryFn: () => nativeRelayKeyApproval.status(profile.name),
        staleTime: 0,
      });
      if (
        trustStatus.status !== 'approved' ||
        trustStatus.profileName !== profile.name ||
        trustStatus.brokerOrigin !== selection.expectedRoute.brokerOrigin ||
        trustStatus.stationId !== selection.expectedRoute.stationId ||
        trustStatus.enrollmentId !== selection.expectedRoute.enrollmentId
      )
        throw new Error('stationTrustRequired');

      const result = await nativeRelayGrantAdapter.redeem({
        profileName: profile.name,
        expectedProfileRevision: freshStatus.data.profileRevision,
        expectedUpdatedAt: profile.updatedAt,
        invitationJson,
        expectedRoute: selection.expectedRoute,
      });
      if (result.status === 'failed') throw new Error(result.failure.primary);
      return result;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
    onError: (cause) => {
      const code = cause instanceof Error ? cause.message : 'statusUnavailable';
      setError(
        code in grantFailureCopy
          ? grantFailureCopy[code as NativeRelayGrantRedemptionFailureCode]
          : 'Station could not verify routing grant status. Try again.',
      );
    },
  });

  function redeemInvitation() {
    const copy = invitation;
    setInvitation('');
    redeem.mutate(copy);
  }

  return (
    <section
      className="connections-computers__note"
      aria-label={`Routing grant for ${profile.name}`}
    >
      <h3>Broker routing grant</h3>
      <p>
        Station trust must be approved separately before redemption. The native
        host checks trust again when it redeems the invitation. A routing grant
        only authorizes broker signaling; account access, device approval, and
        Project access remain separate steps.
      </p>
      {trust.isPending ? (
        <SkeletonBlock count={1} label="Checking Station key trust" />
      ) : null}
      {trust.isError ? (
        <p role="status">
          Station key trust could not be checked. Retry when the device key
          store is available.
        </p>
      ) : null}
      {!trust.isPending && !trust.isError && !trustMatchesRoute ? (
        <p role="status">
          Approve the Station signing key below before redeeming a routing
          grant.
        </p>
      ) : null}
      {trustMatchesRoute ? (
        <p role="status">
          Station key trust is approved for this saved route; the native host
          will verify it again at redemption.
        </p>
      ) : null}
      {status.isPending ? (
        <SkeletonBlock count={1} label="Checking this device’s routing grant" />
      ) : null}
      {status.isError ? (
        <p role="status">
          Routing grant status is unavailable. Retry before using an invitation.
        </p>
      ) : null}
      {status.data ? <NativeRelayGrantSummary state={status.data} /> : null}
      {cleanupPending ? (
        <p role="status">
          A previous grant cleanup is still pending on this device.
        </p>
      ) : null}
      {canEnroll || enrollmentStarted ? (
        <NativeRelayEnrollmentWizard
          profile={profile}
          onEnrollmentStart={() => setEnrollmentStarted(true)}
          onEnrollmentCancel={() => setEnrollmentStarted(false)}
          refreshGrantStatus={async () => {
            const refreshed = await status.refetch();
            if (refreshed.isError || !refreshed.data)
              throw new Error('Native relay grant status is unavailable.');
            return refreshed.data;
          }}
        />
      ) : null}
      <NativeRelayAccountSessionPanel profile={profile} />
      <label>
        One-time routing invitation
        <textarea
          aria-label="One-time routing invitation"
          autoComplete="off"
          spellCheck={false}
          value={invitation}
          onChange={(event) => setInvitation(event.target.value)}
          rows={4}
        />
      </label>
      <Button
        variant="primary"
        disabled={
          !invitation.trim() ||
          status.isError ||
          status.isFetching ||
          !trustMatchesRoute ||
          Boolean(status.data?.grants.length)
        }
        pending={redeem.isPending}
        pendingLabel="Redeeming…"
        onClick={redeemInvitation}
      >
        Redeem routing grant
      </Button>
      {error ? <p role="alert">{error}</p> : null}
      {redeem.isSuccess ? (
        <p role="status">Routing grant saved on this device.</p>
      ) : null}
    </section>
  );
}

export function NativeRelayAccountSessionPanel({
  profile,
}: {
  readonly profile: StationProfile;
}) {
  const { captureCredentialEvidence, isCredentialEvidenceCurrent } =
    useConnections();
  const evidence = captureCredentialEvidence();
  const selected = evidence?.nativeBrokerRoute;
  const route = profile.relayRoute!;
  const isSelected = Boolean(
    selected &&
      evidence &&
      evidence.origin === profile.endpoint &&
      selected.profileName.toLowerCase() === profile.name.toLowerCase() &&
      selected.brokerOrigin === route.brokerOrigin &&
      selected.stationId === route.stationId &&
      selected.enrollmentId === route.enrollmentId &&
      isCredentialEvidenceCurrent(evidence),
  );
  const selectedIdentity = isSelected
    ? JSON.stringify([
        evidence?.connectionId,
        selected?.profileName,
        selected?.profileRevision,
        selected?.brokerOrigin,
        selected?.stationId,
        selected?.enrollmentId,
      ])
    : 'not-selected';
  const requestScope = useHostRequestAuthorityScope();
  const hasAccountSession = Boolean(
    isSelected &&
      requestScope?.requiresEnrolledCredential === true &&
      requestScope.isCurrent(),
  );
  const account = useNativeRelayAccountSession();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [invitation, setInvitation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const credentialsRef = useRef<{ username: string; password: string } | null>(
    null,
  );
  const invitationRef = useRef<string | null>(null);
  const selectedIdentityRef = useRef(selectedIdentity);
  const accountScopeIdentity = hasAccountSession
    ? requestScope?.authorityKey
    : 'no-account-session';
  const accountScopeIdentityRef = useRef(accountScopeIdentity);

  useEffect(() => {
    if (selectedIdentityRef.current === selectedIdentity) return;
    selectedIdentityRef.current = selectedIdentity;
    credentialsRef.current = null;
    invitationRef.current = null;
    setUsername('');
    setPassword('');
    setInvitation('');
    setError(null);
    setNotice(null);
  }, [selectedIdentity]);

  useEffect(() => {
    if (accountScopeIdentityRef.current === accountScopeIdentity) return;
    accountScopeIdentityRef.current = accountScopeIdentity;
    credentialsRef.current = null;
    invitationRef.current = null;
    setUsername('');
    setPassword('');
    setInvitation('');
  }, [accountScopeIdentity]);

  useEffect(
    () => () => {
      credentialsRef.current = null;
      invitationRef.current = null;
    },
    [],
  );

  const login = useMutation({
    mutationFn: async () => {
      if (!isCredentialEvidenceCurrent(evidence!))
        throw new Error('native_relay_selection_changed');
      const credentials = credentialsRef.current;
      if (!credentials) throw new Error('native_account_credentials_missing');
      return account.login(credentials);
    },
    onSuccess: () => {
      setError(null);
      setNotice(
        'Station account session is active for this selected route. Device approval and Project access remain separate.',
      );
    },
    onError: () => {
      setError(
        'Station could not sign in this account for the selected route.',
      );
    },
    onSettled: () => {
      credentialsRef.current = null;
      setUsername('');
      setPassword('');
    },
  });

  const acceptInvitation = useMutation({
    mutationFn: async () => {
      if (!isCredentialEvidenceCurrent(evidence!))
        throw new Error('native_relay_selection_changed');
      const token = invitationRef.current;
      if (!token) throw new Error('native_account_invitation_missing');
      return account.acceptInvitation(token);
    },
    onSuccess: () => {
      setError(null);
      setNotice(
        'Station returned an invitation response. Check shared Projects for any new access; this response alone does not confirm Project membership or Device approval.',
      );
    },
    onError: () => {
      setError('Station could not accept this account invitation.');
    },
    onSettled: () => {
      invitationRef.current = null;
      setInvitation('');
    },
  });

  const retire = useMutation({
    mutationFn: async () => {
      if (!isCredentialEvidenceCurrent(evidence!))
        throw new Error('native_relay_selection_changed');
      account.retireAccount();
    },
    onSuccess: () => {
      credentialsRef.current = null;
      invitationRef.current = null;
      setUsername('');
      setPassword('');
      setInvitation('');
      setError(null);
      setNotice(
        'The account session was cleared from this device. The remote Station account was not signed out or revoked.',
      );
    },
    onError: () => {
      setError('Station could not clear the local account session.');
    },
  });

  if (!isSelected) return null;

  const busy =
    login.isPending || acceptInvitation.isPending || retire.isPending;
  return (
    <section
      className="connections-computers__note"
      aria-label={`Station account for ${profile.name}`}
    >
      <h3>Station account session</h3>
      <p>
        Account sign-in uses the selected native relay. It does not authorize
        Device approval or Project membership.
      </p>
      {hasAccountSession ? (
        <>
          <label className="editor-field">
            <span className="editor-label">Account invitation token</span>
            <input
              className="editor-input"
              autoComplete="off"
              spellCheck={false}
              value={invitation}
              onChange={(event) => setInvitation(event.target.value)}
              disabled={busy}
            />
          </label>
          <Button
            disabled={!invitation.trim() || busy}
            pending={acceptInvitation.isPending}
            onClick={() => {
              invitationRef.current = invitation;
              setInvitation('');
              acceptInvitation.mutate();
            }}
          >
            Accept account invitation
          </Button>
          <Button
            variant="ghost"
            disabled={busy}
            pending={retire.isPending}
            onClick={() => retire.mutate()}
          >
            Forget account session on this device
          </Button>
        </>
      ) : (
        <>
          <label className="editor-field">
            <span className="editor-label">Station account username</span>
            <input
              className="editor-input"
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="username"
              spellCheck={false}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              disabled={busy}
            />
          </label>
          <label className="editor-field">
            <span className="editor-label">Station account password</span>
            <input
              className="editor-input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={busy}
            />
          </label>
          <Button
            variant="primary"
            disabled={!username.trim() || !password || busy}
            pending={login.isPending}
            onClick={() => {
              credentialsRef.current = { username, password };
              login.mutate();
            }}
          >
            Sign in to this Station account
          </Button>
        </>
      )}
      {notice ? <p role="status">{notice}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}

function NativeRelayGrantSummary({ state }: { state: NativeRelayGrantState }) {
  const grant = state.grants[0];
  if (!grant) return <p>A routing grant has not been saved on this device.</p>;
  const expired = grant.expired || grant.metadata.expiresAt <= Date.now();
  return (
    <p>
      {expired ? 'Routing grant expired' : 'Routing grant active'} · expires{' '}
      <time dateTime={new Date(grant.metadata.expiresAt).toISOString()}>
        {new Date(grant.metadata.expiresAt).toLocaleString()}
      </time>
    </p>
  );
}

export function RelayRouteProfiles() {
  const { isTauri, isDesktop } = usePlatformProfile();
  const repository = isTauri ? nativeProfileRepository() : null;
  const subscribe = useCallback(
    (listener: () => void) =>
      repository?.subscribeRelayRouteProfiles(listener) ?? NO_SUBSCRIBE(),
    [repository],
  );
  const getSnapshot = useCallback(
    () => repository?.getRelayRouteProfiles() ?? NO_RELAY_PROFILES,
    [repository],
  );
  const profiles = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const [editing, setEditing] = useState<StationProfile | undefined>();
  const [creating, setCreating] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<StationProfile | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!isTauri) return null;

  async function removeRoute() {
    if (!removeTarget || !repository) return;
    setError(null);
    try {
      await repository.removeRelayRouteProfile(
        `station-profile:${removeTarget.name.toLowerCase()}`,
        removeTarget.updatedAt,
      );
      setRemoveTarget(null);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not remove route.',
      );
    }
  }

  return (
    <section className="relay-route-profiles" aria-label="Saved broker routes">
      <h2 className="relay-route-profiles__heading">Saved broker routes</h2>
      <p className="connections-computers__note">
        These routes are saved locally. They are not connected, signed in, or
        available for work until the broker transport is enabled.
        {isDesktop && (
          <>
            {' '}
            Existing approved routing grants renew while this desktop app is
            awake; remove a saved route to stop maintaining it.
          </>
        )}
      </p>
      <Button onClick={() => setCreating(true)}>Add broker route</Button>
      {profiles.length === 0 && (
        <p className="connections-computers__note">
          No broker routes are saved on this device yet. Save the Station and
          broker details provided by the Station operator to begin setup.
        </p>
      )}
      {isDesktop && profiles.length > MAX_NATIVE_RELAY_ROUTES_TO_SUPERVISE && (
        <p className="connections-computers__alert" role="alert">
          Automatic grant renewal is paused for all saved routes because there
          are more than {MAX_NATIVE_RELAY_ROUTES_TO_SUPERVISE}. Remove routes to
          resume renewal.
        </p>
      )}
      {profiles.map((profile) => (
        <PageRow
          key={profile.name.toLowerCase()}
          className="connections-computers__row"
          label={
            <>
              {profile.name}{' '}
              <span className="connections-computers__chip">Broker route</span>
            </>
          }
          description={`${profile.relayRoute!.brokerOrigin} · ${profile.endpoint}`}
          status={
            <span className="connections-computers__state">Not connected</span>
          }
          control={
            <Button
              size="sm"
              onClick={() => {
                setCreating(false);
                setEditing(profile);
              }}
            >
              Edit
            </Button>
          }
        >
          <NativeRelayGrantControls
            key={`grant:${profile.name.toLowerCase()}:${profile.endpoint}:${profile.relayRoute!.brokerOrigin}:${profile.relayRoute!.stationId}:${profile.relayRoute!.enrollmentId}`}
            profile={profile}
          />
          <RelayRouteKeyApproval
            key={`${profile.name}:${profile.updatedAt}:${profile.relayRoute!.brokerOrigin}:${profile.relayRoute!.stationId}:${profile.relayRoute!.enrollmentId}`}
            profileName={profile.name}
            brokerOrigin={profile.relayRoute!.brokerOrigin}
            stationId={profile.relayRoute!.stationId}
            enrollmentId={profile.relayRoute!.enrollmentId}
          />
          <button
            type="button"
            className="connections-computers__remove tap-target"
            onClick={() => setRemoveTarget(profile)}
          >
            Remove this route
          </button>
        </PageRow>
      ))}
      {error && (
        <p className="connections-computers__alert" role="alert">
          {error}
        </p>
      )}
      {(creating || editing) && (
        <RelayRouteProfileDialog
          profile={editing}
          onClose={() => {
            setCreating(false);
            setEditing(undefined);
          }}
        />
      )}
      <ConfirmModal
        isOpen={removeTarget !== null}
        title="Remove broker route?"
        message={
          removeTarget
            ? `Remove the saved route to ${removeTarget.name}? This does not change the Station or revoke its separately stored trust.`
            : ''
        }
        confirmLabel="Remove route"
        onConfirm={() => void removeRoute()}
        onCancel={() => setRemoveTarget(null)}
        variant="danger"
      />
    </section>
  );
}
