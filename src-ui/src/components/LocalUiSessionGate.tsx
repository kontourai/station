import { useConnections } from '@kontourai/station-connect';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useDegradedQueryState } from '../hooks/useDegradedQueryState';
import {
  browserRelayAccountScopeKey,
  getBrowserRelayAccountScope,
  subscribeBrowserRelayAccountScope,
} from '../lib/browserRelayAccountScope';
import { captureBrowserRelayRoute } from '../lib/browserRelayRouteBinding';
import { deviceSettingsStore } from '../lib/device-settings-store';
import {
  getLocalUiSessionAttempt,
  recheckLocalUiSession,
  resolveLocalUiSession,
  subscribeLocalUiSessionAttempt,
} from '../lib/local-ui-bootstrap';
import { LOCAL_UI_SESSION_ATTEMPT_LIMIT } from '../lib/local-ui-session-retry';
import { probeServerConnection } from '../lib/serverHealth';
import { primeNativeNotifications } from '../platform/native/notify';
import { Button } from './Button';
import { ElapsedWait } from './ElapsedWait';
import { LazyBoundary } from './LazyBoundary';
import { StartupHandoff } from './StartupHandoff';
import { StartupScreen } from './StartupScreen';
import { SkeletonBlock } from './state';
import './LocalUiSessionGate.css';

const loadGuidedConnect = () =>
  import('./GuidedConnect').then((module) => ({
    default: module.GuidedConnect,
  }));

const loadUnpairedSampleWorkspace = async () => {
  const module = await import('./first-run/UnpairedSampleWorkspace');
  return { default: module.UnpairedSampleWorkspace };
};

interface LocalUiSessionGateProps {
  apiBase: string;
  children: ReactNode;
}

/**
 * The retry the resolution is currently making, in both of the gate's pending
 * treatments (#1639). Not a new surface: the wait already had a sentence and a
 * degraded alert, and this says which attempt they are waiting on.
 *
 * Renders nothing on the first attempt, so an ordinary resolution reads exactly
 * as it did. Only a real retry — a host that answered `unavailable` and is being
 * asked again — puts a sentence on screen.
 */
function RetryAttempt({ attempt }: { attempt: number }) {
  if (attempt <= 1) return null;
  return (
    <p>
      Station&rsquo;s host was not ready. Asking again — attempt {attempt} of{' '}
      {LOCAL_UI_SESSION_ATTEMPT_LIMIT}.
    </p>
  );
}

/**
 * Keeps the protected application tree unmounted until this browser has a
 * device session. The access screen mounts pairing actions and the unpaired
 * sample workspace (#2652 / #1772). Neither path starts query providers,
 * polling, or protected-data retries.
 */
export function LocalUiSessionGate({
  apiBase,
  children,
}: LocalUiSessionGateProps) {
  const [resolution, setResolution] = useState<
    Awaited<ReturnType<typeof resolveLocalUiSession>> | undefined
  >();
  const { activeConnection } = useConnections();
  const relayRoute = activeConnection?.brokerRoute;
  const relayScopeKey =
    relayRoute && activeConnection
      ? browserRelayAccountScopeKey({
          connectionId: activeConnection.id,
          applicationOrigin: activeConnection.url,
          route: relayRoute,
          clientOrigin: window.location.origin,
        })
      : null;
  const relayScope = useSyncExternalStore(
    subscribeBrowserRelayAccountScope,
    () => getBrowserRelayAccountScope(relayScopeKey),
    () => null,
  );
  const [verifiedRelay, setVerifiedRelay] = useState<{
    connectionId: string;
    scopeKey: string;
    authenticated: boolean;
  } | null>(null);
  const [relayOnboardingOpen, setRelayOnboardingOpen] = useState(false);
  const sessionCheck = useRef<{
    promise: Promise<Awaited<ReturnType<typeof resolveLocalUiSession>>>;
    reason: 'launcher' | 'pairing' | 'recovery';
  } | null>(null);
  const [sampleOpen, setSampleOpen] = useState(false);
  const [checkingRecovery, setCheckingRecovery] = useState(false);
  const resolutionRequest = useRef(0);
  const [accessStartedAt] = useState(Date.now);
  // Deliberately NOT passed as `useDegradedQueryState`'s `resetKey`: the
  // degraded window measures how long this browser has been waiting for ONE
  // answer, and a retry does not restart that wait — it is part of it. Bumping
  // it per attempt would let a resolution spend the whole ladder without ever
  // admitting it was slow.
  const identityAttempt = useSyncExternalStore(
    subscribeLocalUiSessionAttempt,
    getLocalUiSessionAttempt,
    getLocalUiSessionAttempt,
  );
  const accessCheck = useDegradedQueryState({ isPending: !resolution });

  useEffect(() => {
    let active = true;
    const resolve = () => {
      const current = ++resolutionRequest.current;
      const pending = resolveLocalUiSession(apiBase);
      sessionCheck.current = { promise: pending, reason: 'launcher' };
      setCheckingRecovery(true);
      void pending
        .then((next) => {
          if (active && current === resolutionRequest.current)
            setResolution(next);
        })
        .finally(() => {
          if (active && sessionCheck.current?.promise === pending) {
            sessionCheck.current = null;
            setCheckingRecovery(false);
          }
        });
    };
    const acceptLauncherLink = () => {
      if (
        !new URLSearchParams(window.location.hash.slice(1)).has(
          'station-ui-bootstrap',
        )
      )
        return;
      resolve();
    };
    resolve();
    window.addEventListener('hashchange', acceptLauncherLink);
    return () => {
      active = false;
      resolutionRequest.current += 1;
      sessionCheck.current = null;
      window.removeEventListener('hashchange', acceptLauncherLink);
    };
  }, [apiBase]);

  useEffect(() => {
    if (
      !activeConnection ||
      !relayRoute ||
      !relayScopeKey ||
      relayScope?.state !== 'ready' ||
      !relayScope.authorityKey
    )
      return;
    const connection = activeConnection;
    const scope = relayScope;
    const controller = new AbortController();
    let current = true;
    void (async () => {
      let authenticated = false;
      try {
        const result = await probeServerConnection(
          connection.url,
          undefined,
          null,
          controller.signal,
          relayRoute,
        );
        authenticated =
          typeof result === 'object' &&
          result !== null &&
          result.ok &&
          typeof result.bootId === 'string' &&
          result.bootId.length > 0;
      } catch {
        // Missing or rejected account/Device authority keeps the access
        // screen visible. It is not evidence that the broker route is offline.
      }
      if (
        current &&
        !controller.signal.aborted &&
        getBrowserRelayAccountScope(relayScopeKey) === scope &&
        captureBrowserRelayRoute(
          connection.id,
          connection.url,
          relayRoute,
        )?.isCurrent()
      )
        setVerifiedRelay({
          connectionId: connection.id,
          scopeKey: scope.scopeKey,
          authenticated,
        });
    })();
    return () => {
      current = false;
      controller.abort();
    };
  }, [activeConnection, relayRoute, relayScopeKey, relayScope]);

  const relayAuthenticated = Boolean(
    activeConnection &&
      relayRoute &&
      relayScope?.state === 'ready' &&
      relayScope.authorityKey &&
      verifiedRelay?.connectionId === activeConnection.id &&
      verifiedRelay.scopeKey === relayScope.scopeKey &&
      verifiedRelay.authenticated &&
      !relayOnboardingOpen &&
      captureBrowserRelayRoute(
        activeConnection.id,
        activeConnection.url,
        relayRoute,
      )?.isCurrent(),
  );
  const effectiveResolution = relayRoute
    ? relayAuthenticated
      ? ({ kind: 'authenticated' } as const)
      : ({ kind: 'access-required' } as const)
    : resolution;

  const recheckSession = useCallback(
    (reason: 'pairing' | 'recovery' = 'recovery') => {
      if (
        !sessionCheck.current ||
        (reason === 'pairing' && sessionCheck.current.reason !== 'pairing')
      ) {
        const current = ++resolutionRequest.current;
        const pending = recheckLocalUiSession(apiBase);
        sessionCheck.current = { promise: pending, reason };
        setCheckingRecovery(true);
        void pending
          .then((next) => {
            if (current === resolutionRequest.current) setResolution(next);
          })
          .finally(() => {
            if (sessionCheck.current?.promise === pending) {
              sessionCheck.current = null;
              setCheckingRecovery(false);
            }
          });
      }
    },
    [apiBase],
  );

  const handleSessionEstablished = useCallback(() => {
    recheckSession('pairing');
    // First usable session in this browser: the moment the boot-time prime
    // skips on a fresh device (see PlatformProfileContext). Idempotent, so a
    // boot prime makes this a no-op.
    void primeNativeNotifications();
  }, [recheckSession]);

  useEffect(() => {
    if (effectiveResolution?.kind !== 'host-unavailable') return;
    const resume = () => {
      if (document.visibilityState === 'visible') recheckSession();
    };
    window.addEventListener('online', resume);
    window.addEventListener('focus', resume);
    document.addEventListener('visibilitychange', resume);
    return () => {
      window.removeEventListener('online', resume);
      window.removeEventListener('focus', resume);
      document.removeEventListener('visibilitychange', resume);
    };
  }, [effectiveResolution?.kind, recheckSession]);

  // No session: the connect screen is this device's, not the account's whose
  // appearance the startup path painted from its cache (lib/appearance-cache.ts).
  // The protected tree, and with it the account boundary that otherwise
  // releases that cache, never mounts here. Only a definite answer counts: on
  // a relay route the gate shows the connect screen while the account and its
  // Station identity are still being checked, which is "not checked yet", not
  // "signed out". There the definite answer is a completed identity check
  // for the current account that refused it.
  const relayRefused = Boolean(
    activeConnection &&
      relayRoute &&
      relayScope?.state === 'ready' &&
      verifiedRelay !== null &&
      verifiedRelay.connectionId === activeConnection.id &&
      verifiedRelay.scopeKey === relayScope.scopeKey &&
      !verifiedRelay.authenticated,
  );
  const noSession = relayRoute
    ? relayRefused
    : resolution?.kind === 'access-required';
  useLayoutEffect(() => {
    if (noSession) deviceSettingsStore.releaseBootAppearance();
  }, [noSession]);

  if (!effectiveResolution) {
    // The ONE loading treatment that legitimately replaces the shell: nothing
    // else can render until this browser is known to have a device session
    // (SHELL-13 keeps full-screen loaders pre-shell only, and this is the
    // pre-shell case). What it did not have was a bound — a bootstrap request
    // that never settles left this sentence on screen forever with nothing to
    // press. Past the shared degraded window it says so and offers a reload,
    // the same contract every other bounded wait in the app uses.
    if (accessCheck === 'degraded') {
      return (
        <main aria-live="polite">
          <StartupHandoff recovery />
          <p role="alert">
            Station is taking longer than expected to answer this
            browser&rsquo;s access check.
          </p>
          <RetryAttempt attempt={identityAttempt} />
          <ElapsedWait startedAt={accessStartedAt} />
          <button type="button" onClick={() => window.location.reload()}>
            Try again
          </button>
        </main>
      );
    }
    return (
      <main aria-live="polite">
        <StartupScreen message="Checking this browser's Station access…" />
        <RetryAttempt attempt={identityAttempt} />
        <ElapsedWait startedAt={accessStartedAt} />
      </main>
    );
  }
  if (effectiveResolution.kind === 'access-required') {
    if (sampleOpen) {
      return (
        <section aria-label="Station sample workspace">
          <LazyBoundary
            load={loadUnpairedSampleWorkspace}
            componentProps={{ onConnect: () => setSampleOpen(false) }}
            pending={
              <SkeletonBlock count={2} label="Opening the sample workspace" />
            }
          />
        </section>
      );
    }
    return (
      <section aria-label="Station access required">
        <LazyBoundary
          load={loadGuidedConnect}
          componentProps={{
            // Inside the connect screen: it covers the viewport, so a message
            // rendered beside it was never visible (#2612).
            notice:
              'message' in effectiveResolution
                ? effectiveResolution.message
                : undefined,
            onSessionEstablished: handleSessionEstablished,
            onExploreSample: () => setSampleOpen(true),
            onRelayOnboardingChange: setRelayOnboardingOpen,
          }}
          pending={
            <SkeletonBlock count={1} label="Opening connection options" />
          }
        />
      </section>
    );
  }
  if (effectiveResolution.kind === 'host-unavailable') {
    return (
      // `local-ui-session-recovery` carries no styling: it is the hook the
      // first-run readiness wait identifies this screen by
      // (`tests/helpers/local-ui-access-readiness.ts`), and the `:not()` that
      // keeps this screen out of that wait's "still pending" selector. Removing
      // it makes a settled screen read as pending and the wait spin to its
      // deadline. Rename it there in the same change.
      <main className="local-ui-session-recovery" aria-live="polite">
        <StartupHandoff recovery />
        <h1>Reconnecting to this Station</h1>
        <p role="alert">Keep Station running on your computer, then retry.</p>
        <Button onClick={() => recheckSession()} disabled={checkingRecovery}>
          Try again
        </Button>
      </main>
    );
  }
  return <>{children}</>;
}
