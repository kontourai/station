import {
  type RequestCredentialEvidence,
  useConnections,
} from '@kontourai/station-connect';
import { encodeNativeRelayLink } from '@kontourai/station-connect/native-relay-link';
import type { StationProfile } from '@kontourai/station-contracts';
import type { ProjectInvitationAcceptance } from '@kontourai/station-contracts/project-membership';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { ActionRow } from '../../components/ActionRow';
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
import {
  publishNativeRelaySetupChange,
  subscribeNativeRelaySetupState,
} from '../../platform/native/nativeRelaySetupState';
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

interface NativeAccountOperation {
  readonly kind: 'login' | 'invitation' | 'logout' | 'retire';
  readonly selectionIdentity: string;
  readonly activationEpoch: string;
  readonly credentials?: {
    readonly username: string;
    readonly password: string;
  };
  readonly invitation?: string;
  readonly capturedScope?: NonNullable<
    ReturnType<typeof useHostRequestAuthorityScope>
  >;
}

const REMOTE_LOGOUT_UNCONFIRMED_COPY =
  'Station could not confirm whether the remote account session was revoked.';

type InvitationAcceptedCallback = (
  receipt: ProjectInvitationAcceptance,
  capturedScope: NonNullable<ReturnType<typeof useHostRequestAuthorityScope>>,
) => void;

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

function relayProfileMatchesEvidence(
  profile: StationProfile,
  evidence: RequestCredentialEvidence,
): boolean {
  const selected = evidence.nativeBrokerRoute;
  const route = profile.relayRoute;
  return Boolean(
    selected &&
      route &&
      evidence.origin === profile.endpoint &&
      selected.profileName.toLowerCase() === profile.name.toLowerCase() &&
      selected.brokerOrigin === route.brokerOrigin &&
      selected.stationId === route.stationId &&
      selected.enrollmentId === route.enrollmentId,
  );
}

function NativeRelayGrantControls({
  profile,
  onInvitationAccepted,
}: {
  profile: StationProfile;
  onInvitationAccepted?: InvitationAcceptedCallback;
}) {
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
    onSettled: () => publishNativeRelaySetupChange(profile.name),
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

  if (
    profile.configurationState !== 'configured' &&
    !trust.isPending &&
    !trust.isError &&
    !trustMatchesRoute
  )
    return null;

  return (
    <section
      className="connections-computers__note"
      aria-label={`Routing grant for ${profile.name}`}
    >
      <h3>
        {profile.configurationState === 'configured'
          ? 'Device access ready'
          : 'Connect this device'}
      </h3>
      <p>
        {trustMatchesRoute
          ? 'Use the setup invitation from the Station owner to continue.'
          : 'Confirm this Station first. Device approval comes next.'}
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
        <p role="status">Confirm this Station before continuing.</p>
      ) : null}
      {trustMatchesRoute ? (
        <p role="status">Station confirmed. Your device still needs access.</p>
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
            if (refreshed.isError) throw refreshed.error;
            if (!refreshed.data)
              throw new Error('Native relay grant status is unavailable.');
            return refreshed.data;
          }}
        />
      ) : null}
      {profile.configurationState === 'configured' ? (
        <NativeRelayAccountSessionPanel
          profile={profile}
          onInvitationAccepted={onInvitationAccepted}
        />
      ) : null}
      <details>
        <summary>Advanced: paste a connection invitation</summary>
        <label>
          One-time routing invitation
          <input
            aria-label="One-time routing invitation"
            type="password"
            className="editor-input"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={invitation}
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
      </details>
      {error ? <p role="alert">{error}</p> : null}
      {redeem.isSuccess ? (
        <p role="status">Routing grant saved on this device.</p>
      ) : null}
    </section>
  );
}

function NativeRelayAccountSessionPanel({
  profile,
  onInvitationAccepted,
}: {
  readonly profile: StationProfile;
  readonly onInvitationAccepted?: InvitationAcceptedCallback;
}) {
  const { captureCredentialEvidence, isCredentialEvidenceCurrent } =
    useConnections();
  const evidence = captureCredentialEvidence();
  const isSelected = Boolean(
    evidence &&
      relayProfileMatchesEvidence(profile, evidence) &&
      isCredentialEvidenceCurrent(evidence),
  );
  const selectedIdentity = isSelected
    ? JSON.stringify([
        evidence?.connectionId,
        evidence?.nativeBrokerRoute?.profileName,
        evidence?.nativeBrokerRoute?.profileRevision,
        evidence?.activationEpoch,
        evidence?.nativeBrokerRoute?.brokerOrigin,
        evidence?.nativeBrokerRoute?.stationId,
        evidence?.nativeBrokerRoute?.enrollmentId,
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
  const operationsRef = useRef(new Map<number, NativeAccountOperation>());
  const operationSequenceRef = useRef(0);
  const selectedIdentityRef = useRef(selectedIdentity);
  const currentOperationContextRef = useRef({
    selectionIdentity: selectedIdentity,
    activationEpoch: evidence?.activationEpoch ?? '',
  });
  currentOperationContextRef.current = {
    selectionIdentity: selectedIdentity,
    activationEpoch: evidence?.activationEpoch ?? '',
  };
  const accountScopeIdentity = hasAccountSession
    ? requestScope?.authorityKey
    : 'no-account-session';
  const accountScopeIdentityRef = useRef(accountScopeIdentity);

  useEffect(() => {
    if (selectedIdentityRef.current === selectedIdentity) return;
    selectedIdentityRef.current = selectedIdentity;
    operationsRef.current.clear();
    setUsername('');
    setPassword('');
    setInvitation('');
    setError(null);
    setNotice(null);
  }, [selectedIdentity]);

  useEffect(() => {
    if (accountScopeIdentityRef.current === accountScopeIdentity) return;
    accountScopeIdentityRef.current = accountScopeIdentity;
    setUsername('');
    setPassword('');
    setInvitation('');
    if (!hasAccountSession) {
      setError((current) =>
        current === REMOTE_LOGOUT_UNCONFIRMED_COPY ? current : null,
      );
      setNotice((current) =>
        current?.startsWith(
          'Station account session is active for this selected route.',
        )
          ? null
          : current,
      );
    }
  }, [accountScopeIdentity, hasAccountSession]);

  useEffect(
    () => () => {
      operationsRef.current.clear();
    },
    [],
  );

  function registerAccountOperation(
    operation: Omit<
      NativeAccountOperation,
      'selectionIdentity' | 'activationEpoch'
    >,
  ): number {
    const id = ++operationSequenceRef.current;
    operationsRef.current.set(id, {
      ...operation,
      ...currentOperationContextRef.current,
    });
    return id;
  }

  function isCurrentAccountOperation(id: number): boolean {
    const operation = operationsRef.current.get(id);
    const current = currentOperationContextRef.current;
    return Boolean(
      operation &&
        current.selectionIdentity !== 'not-selected' &&
        operation.selectionIdentity === current.selectionIdentity &&
        operation.activationEpoch === current.activationEpoch &&
        evidence &&
        isCredentialEvidenceCurrent(evidence),
    );
  }

  function settleAccountOperation(id: number): void {
    const operation = operationsRef.current.get(id);
    if (operation && isCurrentAccountOperation(id)) {
      if (operation.kind === 'login') {
        setUsername('');
        setPassword('');
      }
      if (operation.kind === 'invitation') setInvitation('');
    }
    operationsRef.current.delete(id);
  }

  const login = useMutation({
    mutationFn: async (id: number) => {
      const operation = operationsRef.current.get(id);
      if (!operation || !isCurrentAccountOperation(id))
        throw new Error('native_relay_selection_changed');
      if (operation.kind !== 'login' || !operation.credentials)
        throw new Error('native_account_credentials_missing');
      return account.login(operation.credentials);
    },
    onSuccess: (_, id) => {
      if (!isCurrentAccountOperation(id)) return;
      setError(null);
      setNotice(
        'Station account session is active for this selected route. Device approval and Project access remain separate.',
      );
    },
    onError: (_, id) => {
      if (!isCurrentAccountOperation(id)) return;
      setError(
        'Station could not sign in this account for the selected route.',
      );
    },
    onSettled: (_, __, id) => settleAccountOperation(id),
  });

  const acceptInvitation = useMutation({
    mutationFn: async (id: number) => {
      const operation = operationsRef.current.get(id);
      if (!operation || !isCurrentAccountOperation(id))
        throw new Error('native_relay_selection_changed');
      if (operation.kind !== 'invitation' || !operation.invitation)
        throw new Error('native_account_invitation_missing');
      return account.acceptInvitation(operation.invitation);
    },
    onSuccess: (accepted, id) => {
      const operation = operationsRef.current.get(id);
      if (
        !isCurrentAccountOperation(id) ||
        operation?.kind !== 'invitation' ||
        !operation.capturedScope?.isCurrent()
      )
        return;
      setError(null);
      setNotice(
        `Access was added for Project ${accepted.scope.localProjectSlug}. Device approval remains separate.`,
      );
      onInvitationAccepted?.(accepted, operation.capturedScope);
    },
    onError: (_, id) => {
      if (!isCurrentAccountOperation(id)) return;
      setError('Station could not accept this account invitation.');
    },
    onSettled: (_, __, id) => settleAccountOperation(id),
  });

  const logout = useMutation({
    mutationFn: async (id: number) => {
      if (!isCurrentAccountOperation(id))
        throw new Error('native_relay_selection_changed');
      return account.logout();
    },
    onSuccess: (result, id) => {
      if (!isCurrentAccountOperation(id)) return;
      if (result.revoked !== true) {
        setError('Station did not confirm remote account sign-out.');
        return;
      }
      setError(null);
      setNotice(
        'Station confirmed this account session was revoked. Device access remains separate.',
      );
    },
    onError: (_, id) => {
      if (!isCurrentAccountOperation(id)) return;
      setError(REMOTE_LOGOUT_UNCONFIRMED_COPY);
    },
    onSettled: (_, __, id) => settleAccountOperation(id),
  });

  const retire = useMutation({
    mutationFn: async (id: number) => {
      if (!isCurrentAccountOperation(id))
        throw new Error('native_relay_selection_changed');
      await account.retireAccount();
    },
    onSuccess: (_, id) => {
      if (!isCurrentAccountOperation(id)) return;
      setError(null);
      setNotice(
        'The account session was cleared from this device. The remote Station account was not signed out or revoked.',
      );
    },
    onError: (_, id) => {
      if (!isCurrentAccountOperation(id)) return;
      setError('Station could not clear the local account session.');
    },
    onSettled: (_, __, id) => settleAccountOperation(id),
  });

  if (!isSelected) return null;

  const busy =
    login.isPending ||
    acceptInvitation.isPending ||
    logout.isPending ||
    retire.isPending;
  return (
    <section
      className="connections-computers__note"
      aria-label={`Station account for ${profile.name}`}
    >
      <h3>Sign in</h3>
      <p>Sign in to see the projects shared with your account.</p>
      {hasAccountSession ? (
        <>
          <label className="editor-field">
            <span className="editor-label">Account invitation token</span>
            <input
              className="editor-input"
              type="password"
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={invitation}
              onChange={(event) => setInvitation(event.target.value)}
              disabled={busy}
            />
          </label>
          <ActionRow
            overflowLabel={`More account actions for ${profile.name}`}
            primary={
              <Button
                disabled={!invitation.trim() || busy}
                pending={acceptInvitation.isPending}
                onClick={() => {
                  const id = registerAccountOperation({
                    kind: 'invitation',
                    invitation,
                    capturedScope: requestScope,
                  });
                  setInvitation('');
                  acceptInvitation.mutate(id);
                }}
              >
                Accept account invitation
              </Button>
            }
            secondary={
              <Button
                disabled={busy}
                pending={logout.isPending}
                onClick={() => {
                  const id = registerAccountOperation({ kind: 'logout' });
                  logout.mutate(id);
                }}
              >
                Sign out of this Station account
              </Button>
            }
            overflow={[
              {
                key: 'forget-local-account-session',
                label: 'Forget account session on this device',
                disabled: busy,
                onSelect: () => {
                  const id = registerAccountOperation({ kind: 'retire' });
                  retire.mutate(id);
                },
              },
            ]}
          />
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
              const id = registerAccountOperation({
                kind: 'login',
                credentials: { username, password },
              });
              login.mutate(id);
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
  if (!grant) return <p>Connection invitation needed.</p>;
  const expired = grant.expired || grant.metadata.expiresAt <= Date.now();
  return (
    <section aria-label="Saved connection status">
      <p>
        {expired
          ? 'Saved invitation expired on this device.'
          : 'Invitation saved on this device.'}{' '}
        This does not confirm a live connection or current Station access.
      </p>
      <details>
        <summary>Expiry details</summary>
        <p>
          This saved credential expires{' '}
          <time dateTime={new Date(grant.metadata.expiresAt).toISOString()}>
            {new Date(grant.metadata.expiresAt).toLocaleString()}
          </time>
          . This is its local expiry, not a live check of Station availability.
        </p>
      </details>
    </section>
  );
}

function NativeRelaySetupQueryRefresh() {
  const queryClient = useQueryClient();
  useEffect(
    () =>
      subscribeNativeRelaySetupState((profileName) => {
        void nativeProfileRepository()
          .refresh()
          .catch(() => {
            console.warn(
              'Saved Station refresh failed; retaining the last known-good list.',
            );
          });
        void queryClient.invalidateQueries({
          predicate: ({ queryKey }) =>
            (queryKey[0] === 'native-relay-key-approval' ||
              queryKey[0] === 'native-relay-grant' ||
              queryKey[0] === 'native-relay-enrollment-recovery') &&
            typeof queryKey[1] === 'string' &&
            queryKey[1].toLowerCase() === profileName.toLowerCase(),
        });
      }),
    [queryClient],
  );
  return null;
}

export function RelayRouteProfiles({
  onInvitationAccepted,
}: {
  readonly onInvitationAccepted?: InvitationAcceptedCallback;
} = {}) {
  const { isTauri, channel, pairingDeepLinkScheme } = usePlatformProfile();
  const repository = isTauri ? nativeProfileRepository() : null;
  const connectionContext = useConnections();
  const evidence = connectionContext.captureCredentialEvidence();
  const requestScope = useHostRequestAuthorityScope();
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
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [selectionPending, setSelectionPending] = useState<string | null>(null);

  if (!isTauri) return null;

  const isSelected = (profile: StationProfile) =>
    Boolean(
      evidence &&
        relayProfileMatchesEvidence(profile, evidence) &&
        connectionContext.isCredentialEvidenceCurrent(evidence),
    );

  const accountIsCurrent = (profile: StationProfile) =>
    Boolean(
      isSelected(profile) &&
        requestScope?.requiresEnrolledCredential === true &&
        requestScope.isCurrent(),
    );

  const routeStatus = (profile: StationProfile) => {
    if (isSelected(profile)) {
      return accountIsCurrent(profile)
        ? 'Station selected · account session active'
        : profile.configurationState === 'configured'
          ? 'Station selected · account sign-in required'
          : 'Station selected · Device setup required';
    }
    return profile.configurationState === 'configured'
      ? 'Device configured · not selected'
      : 'Device setup required';
  };

  async function selectStation(profile: StationProfile) {
    setSelectionError(null);
    const currentProfile = repository
      ?.getRelayRouteProfiles()
      .find(
        (candidate) =>
          candidate.name.toLowerCase() === profile.name.toLowerCase(),
      );
    if (
      !currentProfile ||
      currentProfile.updatedAt !== profile.updatedAt ||
      JSON.stringify(currentProfile.relayRoute) !==
        JSON.stringify(profile.relayRoute)
    ) {
      setSelectionError('The saved Station route changed. Refresh and retry.');
      return;
    }
    const connection = connectionContext.connections.find((candidate) => {
      const selectedRoute = candidate.nativeBrokerRoute;
      return (
        candidate.id === `station-profile:${profile.name.toLowerCase()}` &&
        candidate.url === profile.endpoint &&
        selectedRoute?.profileName.toLowerCase() ===
          profile.name.toLowerCase() &&
        selectedRoute.brokerOrigin === profile.relayRoute?.brokerOrigin &&
        selectedRoute.stationId === profile.relayRoute?.stationId &&
        selectedRoute.enrollmentId === profile.relayRoute?.enrollmentId
      );
    });
    if (!connection) {
      setSelectionError('This configured Station is no longer available.');
      return;
    }
    setSelectionPending(profile.name.toLowerCase());
    try {
      await connectionContext.setActiveConnection(connection.id);
    } catch {
      setSelectionError('Station could not select this route. Try again.');
    } finally {
      setSelectionPending(null);
    }
  }

  async function copyPublicSetupLink(profile: StationProfile) {
    if (!profile.relayRoute || !channel) return;
    try {
      const link = encodeNativeRelayLink(
        {
          version: 'station-native-relay-link/v1',
          kind: 'route-intent',
          applicationOrigin: profile.endpoint,
          ...profile.relayRoute,
        },
        {
          channel,
          devScheme: pairingDeepLinkScheme?.replace(
            /^station-dev-/u,
            'station-relay-dev-',
          ),
        },
      );
      await navigator.clipboard.writeText(link);
    } catch {
      setError('Station could not copy the public iOS setup link.');
    }
  }

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
    <section
      className="relay-route-profiles native-relay-setup"
      aria-label="Saved broker routes"
    >
      <NativeRelaySetupQueryRefresh />
      <h2 className="relay-route-profiles__heading">Your Stations</h2>
      <p className="connections-computers__note">
        Choose a Station, then finish the steps to access its shared projects.
      </p>
      <Button onClick={() => setCreating(true)}>Add a Station</Button>
      {profiles.length === 0 && (
        <p className="connections-computers__note">
          No broker routes are saved on this device yet. Save the Station and
          broker details provided by the Station operator to begin setup.
        </p>
      )}
      {profiles.length > MAX_NATIVE_RELAY_ROUTES_TO_SUPERVISE && (
        <p className="connections-computers__alert" role="alert">
          Automatic grant renewal is paused for all saved routes because there
          are more than {MAX_NATIVE_RELAY_ROUTES_TO_SUPERVISE}. Remove routes to
          resume renewal.
        </p>
      )}
      <details>
        <summary>Connection upkeep</summary>
        <p>
          Approved routing grants renew while this app is awake. Remove a
          Station to stop maintaining its connection.
        </p>
      </details>
      {profiles.map((profile) => (
        <PageRow
          key={profile.name.toLowerCase()}
          className="connections-computers__row"
          label={<>{profile.name} </>}
          status={
            <span className="connections-computers__state">
              {routeStatus(profile)}
            </span>
          }
          control={
            <ActionRow
              primary={
                !isSelected(profile) &&
                profile.configurationState === 'configured' ? (
                  <Button
                    size="sm"
                    pending={selectionPending === profile.name.toLowerCase()}
                    onClick={() => void selectStation(profile)}
                  >
                    Use this Station
                  </Button>
                ) : undefined
              }
              secondary={
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
              overflowLabel={`More actions for ${profile.name}`}
            />
          }
        >
          <RelayRouteKeyApproval
            key={`${profile.name}:${profile.updatedAt}:${profile.relayRoute!.brokerOrigin}:${profile.relayRoute!.stationId}:${profile.relayRoute!.enrollmentId}`}
            profileName={profile.name}
            brokerOrigin={profile.relayRoute!.brokerOrigin}
            stationId={profile.relayRoute!.stationId}
            enrollmentId={profile.relayRoute!.enrollmentId}
          />
          <NativeRelayGrantControls
            key={`grant:${profile.name.toLowerCase()}:${profile.endpoint}:${profile.relayRoute!.brokerOrigin}:${profile.relayRoute!.stationId}:${profile.relayRoute!.enrollmentId}`}
            profile={profile}
            onInvitationAccepted={onInvitationAccepted}
          />
          <details>
            <summary>Connection settings</summary>

            <Button onClick={() => void copyPublicSetupLink(profile)}>
              Copy public iOS setup link
            </Button>
            <p>This setup link shares connection details, not access.</p>
            <button
              type="button"
              className="connections-computers__remove tap-target"
              onClick={() => setRemoveTarget(profile)}
            >
              Remove this route
            </button>
          </details>
        </PageRow>
      ))}
      {error && (
        <p className="connections-computers__alert" role="alert">
          {error}
        </p>
      )}
      {selectionError ? (
        <p className="connections-computers__alert" role="alert">
          {selectionError}
        </p>
      ) : null}
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
