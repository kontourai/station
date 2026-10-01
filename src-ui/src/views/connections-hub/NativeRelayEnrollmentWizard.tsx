import type { StationProfile } from '@kontourai/station-contracts';
import type { NativeRelayEnrollmentHostChallengeAccepted } from '@kontourai/station-contracts/native-relay-enrollment';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { createNativeRelayEnrollmentClient } from '../../platform/native/nativeRelayEnrollmentClient';
import {
  type NativeRelayGrantState,
  nativeRelayGrantAdapter,
} from '../../platform/native/nativeRelayGrantAdapter';
import { nativeRelayKeyApproval } from '../../platform/native/relayKeyApproval';

type EnrollmentClient = ReturnType<typeof createNativeRelayEnrollmentClient>;
type EnrollmentPhase =
  | 'idle'
  | 'challenge'
  | 'pending'
  | 'staged'
  | 'verifying'
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
    return 'The saved route changed. Reopen setup and try again.';
  if (
    cause instanceof Error &&
    cause.message === 'native_enrollment_peer_capacity_reached'
  )
    return 'Another native setup is still closing. Wait a moment and retry.';
  return 'Station could not verify this Device enrollment. Check the broker route, Station trust and connection, then retry.';
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

function retainUnknownActivation(
  cause: unknown,
  setPhase: (phase: EnrollmentPhase) => void,
  setNotice: (notice: string) => void,
  setError: (message: string | null) => void,
): boolean {
  if (!hasUnknownActivationPublication(cause)) return false;
  setPhase('verifying');
  setError(null);
  setNotice(
    'Station may have completed Device activation, but could not confirm the result. Keep setup open and check Device status again.',
  );
  return true;
}

export function NativeRelayEnrollmentWizard({
  profile,
  onEnrollmentStart,
  onEnrollmentCancel,
  refreshGrantStatus,
}: NativeRelayEnrollmentWizardProps) {
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<EnrollmentPhase>('idle');
  const [challenge, setChallenge] =
    useState<NativeRelayEnrollmentHostChallengeAccepted | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [invitation, setInvitation] = useState('');
  const [registerAccount, setRegisterAccount] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const clientRef = useRef<EnrollmentClient | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const credentialsRef = useRef<LoginCredentials | null>(null);
  const terminalRef = useRef(false);
  const attemptStartedRef = useRef(false);
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

  const begin = useMutation({
    mutationFn: async () => {
      setError(null);
      setNotice(null);
      const controller = new AbortController();
      controllerRef.current = controller;
      terminalRef.current = false;

      try {
        const grantStatus = await refreshGrantStatus();
        controller.signal.throwIfAborted();
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
        await nativeRelayGrantAdapter.assertCurrentRoute({
          profileName: profile.name,
          expectedProfileRevision: grantStatus.profileRevision,
          expectedUpdatedAt: profile.updatedAt,
          expectedRoute: selection,
        });
        controller.signal.throwIfAborted();

        const trust = await queryClient.fetchQuery({
          queryKey: ['native-relay-key-approval', profile.name, 'status'],
          queryFn: () => nativeRelayKeyApproval.status(profile.name),
          staleTime: 0,
        });
        controller.signal.throwIfAborted();
        if (
          trust.status !== 'approved' ||
          trust.profileName !== profile.name ||
          trust.brokerOrigin !== route.brokerOrigin ||
          trust.stationId !== route.stationId ||
          trust.enrollmentId !== route.enrollmentId
        )
          throw new Error('stationTrustRequired');

        const client = createNativeRelayEnrollmentClient({
          profileName: profile.name,
          expectedProfileRevision: grantStatus.profileRevision,
          stationAudience: profile.endpoint,
          signal: controller.signal,
        });
        clientRef.current = client;
        return await client.begin();
      } catch (cause) {
        controller.abort();
        const client = clientRef.current;
        clientRef.current = null;
        if (client && !terminalRef.current)
          await client.abort().catch(() => undefined);
        throw cause;
      }
    },
    onSuccess: (result) => {
      setChallenge(result);
      setPhase('challenge');
    },
    onError: (cause) => reportEnrollmentFailure(cause, setError),
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
    onError: (cause) => reportEnrollmentFailure(cause, setError),
  });

  const checkStatus = useMutation({
    mutationFn: () => requireClient().status(),
    onSuccess: (result) => {
      if (result.state === 'active') {
        terminalRef.current = true;
        setPhase('configured');
        setNotice('Station confirmed this Device is configured.');
      } else if (result.state === 'pending') {
        setPhase('pending');
        setNotice('The Station operator has not completed approval yet.');
      } else {
        setError(
          'This enrollment is no longer pending. Start a new setup if needed.',
        );
      }
    },
    onError: (cause) => {
      if (!retainUnknownActivation(cause, setPhase, setNotice, setError))
        reportEnrollmentFailure(cause, setError);
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
    onError: (cause) => reportEnrollmentFailure(cause, setError),
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
    onError: (cause) => {
      if (!retainUnknownActivation(cause, setPhase, setNotice, setError))
        reportEnrollmentFailure(cause, setError);
    },
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
    onEnrollmentCancel();
    setChallenge(null);
    setPhase('idle');
    setUsername('');
    setPassword('');
    setInvitation('');
    setRegisterAccount(false);
    setError(null);
    setNotice(null);
    begin.reset();
    login.reset();
    checkStatus.reset();
    finalize.reset();
    activate.reset();
  }

  function submitLogin() {
    credentialsRef.current = {
      username,
      password,
      ...(registerAccount ? { registration: { invitation } } : {}),
    };
    login.mutate();
  }

  const candidate = challenge?.candidate;
  const busy =
    begin.isPending ||
    login.isPending ||
    checkStatus.isPending ||
    finalize.isPending ||
    activate.isPending;

  return (
    <section
      className="relay-route-enrollment connections-computers__note"
      aria-label={`Device setup for ${profile.name}`}
    >
      <h3>Device setup</h3>
      <p>
        This flow enrolls a Device with this Station account after operator
        approval. It does not sign in for application use or grant Project
        access.
      </p>
      {phase === 'idle' ? (
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
          Begin Device setup
        </Button>
      ) : null}

      {candidate ? (
        <section
          className="connections-computers__note"
          aria-label="Public Device candidate"
        >
          <h4>Public Device candidate for the Station operator</h4>
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
        </section>
      ) : null}

      {phase === 'challenge' ? (
        <section aria-label="Station account enrollment">
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
          {challenge?.registrationAvailable ? (
            <>
              <label className="editor-field editor-field--row">
                <input
                  type="checkbox"
                  checked={registerAccount}
                  onChange={(event) => setRegisterAccount(event.target.checked)}
                  disabled={busy}
                />
                I have an operator invitation to register a new Station account
              </label>
              {registerAccount ? (
                <label className="editor-field">
                  <span className="editor-label">
                    Operator registration invitation
                  </span>
                  <input
                    className="editor-input"
                    autoComplete="off"
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

      {phase === 'pending' ? (
        <section aria-label="Pending operator approval">
          <p>Waiting for the Station operator to approve this Device.</p>
          <Button
            disabled={busy}
            pending={checkStatus.isPending}
            onClick={() => checkStatus.mutate()}
          >
            Check operator approval
          </Button>
          <Button
            disabled={busy}
            pending={finalize.isPending}
            onClick={() => finalize.mutate()}
          >
            Check and stage Device delivery
          </Button>
        </section>
      ) : null}

      {phase === 'staged' ? (
        <section aria-label="Device delivery staged">
          <p>
            The Device delivery is staged. Activate this Device to finish setup.
          </p>
          <Button
            variant="primary"
            disabled={busy}
            pending={activate.isPending}
            pendingLabel="Activating…"
            onClick={() => activate.mutate()}
          >
            Activate this Device
          </Button>
        </section>
      ) : null}

      {phase === 'verifying' ? (
        <section aria-label="Device activation status unknown">
          <p>
            Station may have completed Device activation, but the current status
            has not been confirmed. Check again before starting another setup.
          </p>
          <Button
            disabled={busy}
            pending={checkStatus.isPending}
            onClick={() => checkStatus.mutate()}
          >
            Check Device status
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
      {(attemptStartedRef.current &&
        phase !== 'configured' &&
        phase !== 'verifying') ||
      begin.isPending ? (
        <Button variant="ghost" onClick={() => void cancelSetup()}>
          Cancel Device setup
        </Button>
      ) : null}
    </section>
  );
}
