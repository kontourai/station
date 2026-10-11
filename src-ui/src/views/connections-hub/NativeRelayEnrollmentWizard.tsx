import {
  captureNativeEnrollmentFailure,
  type NativeEnrollmentFailureDiagnostic,
  type NativeEnrollmentFailureStage,
  nativeEnrollmentFailureDiagnostic,
} from '@kontourai/station-connect/native-enrollment';
import type { StationProfile } from '@kontourai/station-contracts';
import type { NativeRelayEnrollmentHostResumeAttempt } from '@kontourai/station-contracts/native-relay-enrollment';
import { readProjectInvitationToken } from '@kontourai/station-sdk/project-access-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { SkeletonBlock } from '../../components/state';
import { createNativeRelayEnrollmentClient } from '../../platform/native/nativeRelayEnrollmentClient';
import {
  type NativeRelayGrantState,
  NativeRelayGrantStatusError,
  nativeRelayGrantAdapter,
} from '../../platform/native/nativeRelayGrantAdapter';
import { nativeRelayKeyApproval } from '../../platform/native/relayKeyApproval';
import { RelaySetupHelp } from './RelaySetupHelp';

type EnrollmentClient = ReturnType<typeof createNativeRelayEnrollmentClient>;
type EnrollmentAttempt = NativeRelayEnrollmentHostResumeAttempt;
type EnrollmentPhase =
  | 'idle'
  | 'challenge'
  | 'expired'
  | 'pending'
  | 'staged'
  | 'verifying'
  | 'cancel-required'
  | 'configured';

interface NativeRelayEnrollmentWizardProps {
  readonly profile: StationProfile;
  readonly onEnrollmentStart: () => void;
  readonly onEnrollmentCancel: () => void;
  readonly refreshGrantStatus: () => Promise<NativeRelayGrantState>;
}

interface LoginCredentials {
  username: string;
  password: string;
  registration?: { invitation: string };
}

function enrollmentFailureCopy(cause: unknown): string {
  if (cause instanceof Error && cause.message === 'staleProfile')
    return 'This Station’s connection changed. Close setup and open it again.';
  if (
    cause instanceof Error &&
    cause.message === 'native_enrollment_peer_capacity_reached'
  )
    return 'Another setup is still closing. Wait a moment before continuing.';
  if (
    cause instanceof Error &&
    cause.message === 'native_enrollment_recovery_required'
  )
    return 'Finish or close the saved setup before starting another.';
  if (
    (cause instanceof Error && cause.message === 'native_enrollment_expired') ||
    nativeEnrollmentFailureDiagnostic(cause)?.httpStatus === 410
  )
    return 'This device setup expired. Close the expired request, then request device access again.';
  return 'Station couldn’t confirm this device setup step. Keep this screen open and ask the Station owner what to do next.';
}

function reportEnrollmentFailure(
  cause: unknown,
  setError: (message: string) => void,
): void {
  if (cause instanceof Error && cause.name === 'AbortError') return;
  setError(enrollmentFailureCopy(cause));
}

function hasUnknownActivationPublication(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    cause.message === 'native_enrollment_transition_retired'
  );
}

export function NativeRelayEnrollmentWizard({
  profile,
  onEnrollmentStart,
  onEnrollmentCancel,
  refreshGrantStatus,
}: NativeRelayEnrollmentWizardProps) {
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<EnrollmentPhase>('idle');
  const [candidate, setCandidate] = useState<NonNullable<
    EnrollmentAttempt['candidate']
  > | null>(null);
  const [registrationAvailable, setRegistrationAvailable] = useState(false);
  const [expiresAt, setExpiresAt] = useState<number>();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [invitation, setInvitation] = useState('');
  const [registerAccount, setRegisterAccount] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [beginDiagnostic, setBeginDiagnostic] =
    useState<NativeEnrollmentFailureDiagnostic>();
  const [notice, setNotice] = useState<string | null>(null);
  const clientRef = useRef<EnrollmentClient | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const credentialsRef = useRef<LoginCredentials | null>(null);
  const terminalRef = useRef(false);
  const attemptStartedRef = useRef(false);
  const activationUncertainRef = useRef(false);
  const route = profile.relayRoute!;
  const selection = {
    brokerOrigin: route.brokerOrigin,
    stationId: route.stationId,
    enrollmentId: route.enrollmentId,
  };
  const routeQueryKey = [
    'native-relay-grant',
    profile.name.toLowerCase(),
    profile.updatedAt,
    route.brokerOrigin,
    route.stationId,
    route.enrollmentId,
  ] as const;

  useEffect(
    () => () => {
      controllerRef.current?.abort();
      const client = clientRef.current;
      if (client) void client.dispose().catch(() => undefined);
      credentialsRef.current = null;
    },
    [],
  );

  useEffect(() => {
    if (phase !== 'challenge' || expiresAt === undefined) return;
    const timer = setTimeout(
      () => {
        setPhase('expired');
        credentialsRef.current = null;
        setUsername('');
        setPassword('');
        setInvitation('');
        setNotice(null);
      },
      Math.max(0, expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [phase, expiresAt]);

  function reportStepFailure(cause: unknown) {
    setBeginDiagnostic(nativeEnrollmentFailureDiagnostic(cause));
    if (
      (cause instanceof Error &&
        cause.message === 'native_enrollment_expired') ||
      nativeEnrollmentFailureDiagnostic(cause)?.httpStatus === 410
    )
      setPhase('expired');
    reportEnrollmentFailure(cause, setError);
  }

  function reportActivationUncertainty(cause: unknown) {
    activationUncertainRef.current = true;
    setBeginDiagnostic(nativeEnrollmentFailureDiagnostic(cause));
    setPhase('verifying');
    setError(null);
    setNotice(null);
  }

  async function validatedProfileRevision(
    signal: AbortSignal,
  ): Promise<number> {
    let stage: NativeEnrollmentFailureStage = 'route-status';
    try {
      const grantStatus = await refreshGrantStatus();
      signal.throwIfAborted();
      const grant = grantStatus.grants[0];
      const cleanupPending = grantStatus.cleanups.some(
        (cleanup) =>
          !cleanup.brokerRetired ||
          (cleanup.localCleanupRequired && !cleanup.localCleanupComplete),
      );
      if (
        grantStatus.profileName !== profile.name ||
        grantStatus.stationId !== selection.stationId ||
        grantStatus.enrollmentId !== selection.enrollmentId ||
        !grant ||
        grant.expired ||
        grant.metadata.expiresAt <= Date.now() ||
        cleanupPending
      )
        throw new Error('staleProfile');
      stage = 'route-currentness';
      await nativeRelayGrantAdapter.assertCurrentRoute({
        profileName: profile.name,
        expectedProfileRevision: grantStatus.profileRevision,
        expectedUpdatedAt: profile.updatedAt,
        expectedRoute: selection,
      });
      signal.throwIfAborted();
      stage = 'station-trust';
      const trust = await queryClient.fetchQuery({
        queryKey: ['native-relay-key-approval', profile.name, 'status'],
        queryFn: () => nativeRelayKeyApproval.status(profile.name),
        staleTime: 0,
      });
      signal.throwIfAborted();
      if (
        trust.status !== 'approved' ||
        trust.profileName !== profile.name ||
        trust.brokerOrigin !== route.brokerOrigin ||
        trust.stationId !== route.stationId ||
        trust.enrollmentId !== route.enrollmentId
      )
        throw new Error('stationTrustRequired');
      return grantStatus.profileRevision;
    } catch (cause) {
      throw captureNativeEnrollmentFailure(
        cause instanceof NativeRelayGrantStatusError &&
          cause.code === 'ambiguous'
          ? new Error('native_enrollment_saved_connections_ambiguous')
          : cause,
        stage,
      );
    }
  }

  const recoveryKey = [
    'native-relay-enrollment-recovery',
    ...routeQueryKey.slice(1),
  ] as const;
  const recovery = useQuery({
    queryKey: recoveryKey,
    queryFn: async () => {
      const controller = new AbortController();
      const revision = await validatedProfileRevision(controller.signal);
      const client = createNativeRelayEnrollmentClient({
        profileName: profile.name,
        expectedProfileRevision: revision,
        stationAudience: profile.endpoint,
        signal: controller.signal,
      });
      try {
        return await client.recovery();
      } finally {
        await client.dispose().catch(() => undefined);
      }
    },
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const begin = useMutation({
    mutationFn: async () => {
      setError(null);
      setBeginDiagnostic(undefined);
      setNotice(null);
      const controller = new AbortController();
      controllerRef.current = controller;
      terminalRef.current = false;

      try {
        const revision = await validatedProfileRevision(controller.signal);

        const client = createNativeRelayEnrollmentClient({
          profileName: profile.name,
          expectedProfileRevision: revision,
          stationAudience: profile.endpoint,
          signal: controller.signal,
        });
        clientRef.current = client;
        const currentRecovery = await client.recovery();
        if (currentRecovery.attempts.length > 0)
          throw new Error('native_enrollment_recovery_required');
        return await client.begin();
      } catch (cause) {
        controller.abort();
        const client = clientRef.current;
        clientRef.current = null;
        if (client && !terminalRef.current)
          await client.abort().catch(() => undefined);
        throw captureNativeEnrollmentFailure(cause, 'begin-preflight');
      }
    },
    onSuccess: (result) => {
      setCandidate(result.candidate);
      setRegistrationAvailable(result.registrationAvailable);
      setExpiresAt(result.expiresAt);
      setPhase('challenge');
      void queryClient.invalidateQueries({ queryKey: recoveryKey });
    },
    onError: (cause) => {
      setBeginDiagnostic(nativeEnrollmentFailureDiagnostic(cause));
      reportEnrollmentFailure(cause, setError);
      void queryClient.invalidateQueries({ queryKey: recoveryKey });
    },
  });

  const setupDiagnostic =
    phase === 'idle' && recovery.isError
      ? nativeEnrollmentFailureDiagnostic(recovery.error)
      : error || phase === 'verifying'
        ? beginDiagnostic
        : undefined;

  const savedConnectionsAmbiguous =
    setupDiagnostic?.code === 'native_enrollment_saved_connections_ambiguous';

  const resume = useMutation({
    mutationFn: async (selectedHandle: string) => {
      setError(null);
      setBeginDiagnostic(undefined);
      setNotice(null);
      const controller = new AbortController();
      controllerRef.current = controller;
      terminalRef.current = false;
      const revision = await validatedProfileRevision(controller.signal);
      const client = createNativeRelayEnrollmentClient({
        profileName: profile.name,
        expectedProfileRevision: revision,
        stationAudience: profile.endpoint,
        signal: controller.signal,
      });
      clientRef.current = client;
      const attempt = await client.resume(selectedHandle);
      attemptStartedRef.current = true;
      onEnrollmentStart();
      return { client, attempt };
    },
    onSuccess: async ({ client, attempt }) => {
      setCandidate(attempt.candidate);
      setRegistrationAvailable(attempt.registrationAvailable);
      setExpiresAt(attempt.expiresAt);
      if (attempt.phase === 'begin-required') {
        const result = await client.begin();
        setCandidate(result.candidate);
        setRegistrationAvailable(result.registrationAvailable);
        setExpiresAt(result.expiresAt);
        setPhase('challenge');
        setNotice(
          'Resumed the saved Device setup. Continue with Station account sign-in.',
        );
      } else if (attempt.phase === 'candidate') {
        setPhase('challenge');
        setNotice(
          'Resumed the saved Device setup. Continue with Station account sign-in.',
        );
      } else if (attempt.phase === 'staged') {
        setPhase('staged');
        setNotice(
          'The saved Device delivery is staged. Review it before explicitly activating this Device.',
        );
      } else if (attempt.phase === 'activation-unknown') {
        activationUncertainRef.current = true;
        setPhase('verifying');
        setNotice('Checking the saved Device activation with Station.');
        checkStatus.mutate();
      } else if (attempt.phase === 'cancel-required') {
        setPhase('cancel-required');
        setNotice(
          'Station requires this saved Device setup to be cancelled before another can begin.',
        );
      } else {
        terminalRef.current = true;
        setPhase('configured');
        setNotice('Station confirmed this Device is configured.');
      }
      await queryClient.invalidateQueries({ queryKey: recoveryKey });
    },
    onError: reportStepFailure,
  });

  async function finishTerminalSetup() {
    activationUncertainRef.current = false;
    terminalRef.current = true;
    setPhase('idle');
    setCandidate(null);
    setError(null);
    setBeginDiagnostic(undefined);
    setNotice(
      'The previous request is closed. Request device access again to start a fresh setup.',
    );
    attemptStartedRef.current = false;
    clientRef.current = null;
    controllerRef.current?.abort();
    controllerRef.current = null;
    onEnrollmentCancel();
    await queryClient.invalidateQueries({ queryKey: recoveryKey });
  }

  const cancelRecovered = useMutation({
    mutationFn: () => requireClient().cancel(),
    onSuccess: async (result) => {
      if (
        result.state === 'cancelled' ||
        result.state === 'expired' ||
        result.state === 'revoked'
      ) {
        await finishTerminalSetup();
      } else {
        setError(
          'Station has not confirmed cancellation of this Device setup.',
        );
      }
    },
    onError: reportStepFailure,
  });

  const login = useMutation({
    mutationFn: async () => {
      const client = clientRef.current;
      const credentials = credentialsRef.current;
      if (!client || !credentials)
        throw new Error('native_enrollment_credentials_unavailable');
      try {
        return await client.login(
          { username: credentials.username, password: credentials.password },
          credentials.registration,
        );
      } finally {
        credentialsRef.current = null;
        setUsername('');
        setPassword('');
        setInvitation('');
      }
    },
    onSuccess: (result) => {
      if (result.state === 'pending') {
        setPhase('pending');
        setNotice(
          'The request is waiting for Station operator approval. Check again after the operator reviews it.',
        );
      } else {
        setError('Station did not accept this enrollment request.');
      }
    },
    onError: reportStepFailure,
  });

  const checkStatus = useMutation({
    mutationFn: () => requireClient().status(),
    onSuccess: (result) => {
      if (result.state === 'active') {
        terminalRef.current = true;
        setPhase('configured');
        setNotice('Station confirmed this Device is configured.');
      } else if (result.state === 'pending') {
        if (activationUncertainRef.current) {
          setNotice(
            'Station has not confirmed activation yet. Check Device status again.',
          );
        } else {
          setPhase('pending');
          setNotice('The Station operator has not completed approval yet.');
        }
      } else {
        void finishTerminalSetup();
      }
    },
    onError: (cause) => {
      if (
        activationUncertainRef.current ||
        hasUnknownActivationPublication(cause)
      )
        reportActivationUncertainty(cause);
      else reportStepFailure(cause);
    },
  });

  const finalize = useMutation({
    mutationFn: () => requireClient().finalize(),
    onSuccess: (result) => {
      if (result.state === 'staged') {
        setPhase('staged');
        setNotice(
          'The Device delivery is staged on this device. Review and activate it to finish.',
        );
      } else if (result.state === 'pending') {
        setPhase('pending');
        setNotice(
          'Operator approval is still pending. You can check again later.',
        );
      } else {
        setError(
          'This enrollment is no longer pending. Start a new setup if needed.',
        );
      }
    },
    onError: reportStepFailure,
  });

  const activate = useMutation({
    mutationFn: () => requireClient().activate(),
    onSuccess: (result) => {
      if (result.state === 'active') {
        terminalRef.current = true;
        setPhase('configured');
        setNotice('Station confirmed this Device is configured.');
        void queryClient.invalidateQueries({ queryKey: routeQueryKey });
      } else if (result.state === 'pending') {
        setPhase('pending');
        setNotice('Activation is still pending operator approval.');
      } else {
        setError('Station did not activate this Device.');
      }
    },
    onError: reportActivationUncertainty,
  });

  function requireClient(): EnrollmentClient {
    const client = clientRef.current;
    if (!client) throw new Error('native_enrollment_not_started');
    return client;
  }

  async function cancelSetup() {
    const client = clientRef.current;
    const controller = controllerRef.current;
    credentialsRef.current = null;
    controller?.abort();
    if (client && !terminalRef.current) {
      try {
        await client.abort();
      } catch {
        setError(
          'Station could not confirm cancellation. Keep this setup open and retry cancellation before starting another Device setup.',
        );
        return;
      }
    }
    clientRef.current = null;
    controllerRef.current = null;
    if (terminalRef.current) return;
    attemptStartedRef.current = false;
    activationUncertainRef.current = false;
    onEnrollmentCancel();
    setCandidate(null);
    setRegistrationAvailable(false);
    setPhase('idle');
    setUsername('');
    setPassword('');
    setInvitation('');
    setRegisterAccount(false);
    setError(null);
    setBeginDiagnostic(undefined);
    setNotice(null);
    begin.reset();
    login.reset();
    checkStatus.reset();
    finalize.reset();
    activate.reset();
    void queryClient.invalidateQueries({ queryKey: recoveryKey });
  }

  function submitLogin() {
    if (expiresAt !== undefined && expiresAt <= Date.now()) {
      setPhase('expired');
      setUsername('');
      setPassword('');
      setInvitation('');
      return;
    }
    const projectInvitation = registerAccount
      ? readProjectInvitationToken(invitation)
      : undefined;
    if (registerAccount && !projectInvitation) {
      setError('Paste a Project invitation link or code.');
      return;
    }
    credentialsRef.current = {
      username,
      password,
      ...(projectInvitation
        ? { registration: { invitation: projectInvitation } }
        : {}),
    };
    login.mutate();
  }

  const busy =
    begin.isPending ||
    resume.isPending ||
    cancelRecovered.isPending ||
    login.isPending ||
    checkStatus.isPending ||
    finalize.isPending ||
    activate.isPending;

  return (
    <section
      className="relay-route-enrollment native-relay-setup connections-computers__note"
      aria-label={`Device setup for ${profile.name}`}
    >
      <div className="native-relay-setup__heading">
        <h3>Approve this device</h3>
        <RelaySetupHelp label="About device approval">
          <p>
            Sign in to request approval from the Station owner. After approval,
            sign in again to open your shared projects. Device approval and
            Project membership are separate permissions.
          </p>
        </RelaySetupHelp>
      </div>
      <p>Sign in to request device approval.</p>
      {phase === 'idle' ? (
        <>
          {recovery.isPending ? (
            <SkeletonBlock count={1} label="Checking for saved Device setup" />
          ) : null}
          {recovery.isError ? (
            <>
              <p role="status">
                {savedConnectionsAmbiguous
                  ? 'More than one connection is saved on this device. Ask the Station owner for a new setup invitation, then review and remove saved connections before continuing.'
                  : 'Saved Device setup could not be checked. Retry before starting another setup.'}
              </p>
              <Button onClick={() => void recovery.refetch()}>
                {savedConnectionsAmbiguous
                  ? 'Check after connection recovery'
                  : 'Retry saved setup check'}
              </Button>
            </>
          ) : null}
          {recovery.isSuccess &&
          !recovery.isFetching &&
          recovery.data.attempts.length > 0 ? (
            <section aria-label="Saved Device setups">
              <h4>Saved Device setup</h4>
              <p>Resume a saved setup to continue.</p>
              {recovery.data.attempts.map((attempt, index) => (
                <Button
                  key={attempt.enrollmentHandle}
                  disabled={busy}
                  pending={
                    resume.isPending &&
                    resume.variables === attempt.enrollmentHandle
                  }
                  onClick={() => resume.mutate(attempt.enrollmentHandle)}
                >
                  {attempt.phase !== 'active' &&
                  attempt.phase !== 'activation-unknown' &&
                  attempt.phase !== 'staged' &&
                  attempt.expiresAt <= Date.now()
                    ? 'Close expired'
                    : 'Resume'}{' '}
                  {attempt.candidate
                    ? `Device ${attempt.candidate.deviceId}`
                    : `saved setup ${index + 1}`}
                </Button>
              ))}
            </section>
          ) : null}
          {recovery.isSuccess &&
          !recovery.isFetching &&
          recovery.data.attempts.length === 0 ? (
            <Button
              variant="primary"
              pending={begin.isPending}
              pendingLabel="Preparing…"
              onClick={() => {
                attemptStartedRef.current = true;
                onEnrollmentStart();
                begin.mutate();
              }}
            >
              Request device access
            </Button>
          ) : null}
        </>
      ) : null}

      {candidate ? (
        <details
          className="connections-computers__note"
          aria-label="Public Device candidate"
        >
          <summary>Device request details</summary>
          <dl>
            <div>
              <dt>Device ID</dt>
              <dd>{candidate.deviceId}</dd>
            </div>
            <div>
              <dt>Binding ID</dt>
              <dd>{candidate.bindingId}</dd>
            </div>
            <div>
              <dt>Device proof key thumbprint</dt>
              <dd>
                <code>{candidate.deviceProofKeyThumbprint}</code>
              </dd>
            </div>
          </dl>
          <details>
            <summary>Public Device key</summary>
            <pre>{JSON.stringify(candidate.deviceProofJwk, null, 2)}</pre>
          </details>
        </details>
      ) : null}

      {phase === 'challenge' ? (
        <section aria-label="Station account enrollment">
          <p>Submit your account details within five minutes.</p>
          <label className="editor-field">
            <span className="editor-label">Station account username</span>
            <input
              className="editor-input"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              autoComplete="username"
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
          {registrationAvailable ? (
            <>
              <label className="editor-field editor-field--row">
                <input
                  type="checkbox"
                  checked={registerAccount}
                  onChange={(event) => setRegisterAccount(event.target.checked)}
                  disabled={busy}
                />
                Create an account with a Project invitation
              </label>
              {registerAccount ? (
                <label className="editor-field">
                  <span className="editor-label">
                    Project invitation link or code
                  </span>
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
              ) : null}
            </>
          ) : null}
          <Button
            variant="primary"
            pending={login.isPending}
            pendingLabel="Submitting…"
            disabled={
              !username.trim() ||
              !password ||
              (registerAccount && !invitation.trim())
            }
            onClick={submitLogin}
          >
            {registerAccount
              ? 'Register and request Device approval'
              : 'Sign in and request Device approval'}
          </Button>
        </section>
      ) : null}

      {phase === 'expired' ? (
        <section aria-label="Device setup expired">
          <p>
            This device setup expired. Close this request, then request device
            access again.
          </p>
          <Button
            variant="primary"
            disabled={busy}
            pending={cancelRecovered.isPending}
            onClick={() => cancelRecovered.mutate()}
          >
            Close expired request
          </Button>
        </section>
      ) : null}

      {phase === 'pending' ? (
        <section aria-label="Pending operator approval">
          <p>Waiting for the Station owner to approve this device.</p>
          <Button
            disabled={busy}
            pending={checkStatus.isPending}
            onClick={() => checkStatus.mutate()}
          >
            Check approval
          </Button>
          <Button
            disabled={busy}
            pending={finalize.isPending}
            onClick={() => finalize.mutate()}
          >
            Continue after approval
          </Button>
        </section>
      ) : null}

      {phase === 'staged' ? (
        <section aria-label="Device delivery staged">
          <p>
            The Station owner approved this device. Finish device setup to
            continue.
          </p>
          <Button
            variant="primary"
            disabled={busy}
            pending={activate.isPending}
            pendingLabel="Activating…"
            onClick={() => activate.mutate()}
          >
            Finish device setup
          </Button>
        </section>
      ) : null}

      {phase === 'verifying' ? (
        <section aria-label="Device activation status unknown">
          <p>
            Station couldn’t confirm whether device setup finished. Check its
            status before starting another setup.
          </p>
          <Button
            variant="primary"
            disabled={busy}
            pending={checkStatus.isPending}
            onClick={() => checkStatus.mutate()}
          >
            Check Device status
          </Button>
        </section>
      ) : null}

      {phase === 'cancel-required' ? (
        <section aria-label="Device setup cancellation required">
          <p>
            Station requires cancellation of this saved Device setup before
            another can begin.
          </p>
          <Button
            variant="primary"
            disabled={busy}
            pending={cancelRecovered.isPending}
            onClick={() => cancelRecovered.mutate()}
          >
            Confirm Device setup cancellation
          </Button>
        </section>
      ) : null}

      {phase === 'configured' ? (
        <p role="status">
          <strong>Device configured</strong>. Account sign-in and Project access
          remain separate.
        </p>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {setupDiagnostic ? (
        <details>
          <summary>Device setup troubleshooting</summary>
          <p>
            Stage: {setupDiagnostic.stage}. Code: {setupDiagnostic.code}.
          </p>
          {setupDiagnostic.httpStatus === undefined ? null : (
            <p>HTTP status: {setupDiagnostic.httpStatus}</p>
          )}
          {setupDiagnostic.cleanup?.map((failure) => (
            <p key={failure.stage}>
              Cleanup: {failure.stage}. Code: {failure.code}.
            </p>
          ))}
        </details>
      ) : null}
      {(attemptStartedRef.current &&
        phase !== 'configured' &&
        phase !== 'verifying' &&
        phase !== 'cancel-required' &&
        phase !== 'expired') ||
      begin.isPending ? (
        <Button variant="ghost" onClick={() => void cancelSetup()}>
          Cancel Device setup
        </Button>
      ) : null}
    </section>
  );
}
