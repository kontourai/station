import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useDegradedQueryState } from '../hooks/useDegradedQueryState';
import {
  getLocalUiSessionAttempt,
  recheckLocalUiSessionAfterPairing,
  resolveLocalUiSession,
  subscribeLocalUiSessionAttempt,
} from '../lib/local-ui-bootstrap';
import { LOCAL_UI_SESSION_ATTEMPT_LIMIT } from '../lib/local-ui-session-retry';
import { GuidedConnect } from './GuidedConnect';
import { LazyBoundary } from './LazyBoundary';
import { SkeletonBlock } from './state';

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
  const pairingRecheck = useRef<Promise<
    Awaited<ReturnType<typeof resolveLocalUiSession>>
  > | null>(null);
  const [sampleOpen, setSampleOpen] = useState(false);
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
    void resolveLocalUiSession(apiBase).then((next) => {
      if (active) setResolution(next);
    });
    return () => {
      active = false;
    };
  }, [apiBase]);

  const handleSessionEstablished = useCallback(() => {
    // A connection-manager success can be surfaced twice while its modal
    // completes. Keep the resulting authenticated identity check singular.
    pairingRecheck.current ??= recheckLocalUiSessionAfterPairing(apiBase);
    void pairingRecheck.current.then(setResolution).finally(() => {
      pairingRecheck.current = null;
    });
  }, [apiBase]);

  if (!resolution) {
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
          <p role="alert">
            Station is taking longer than expected to answer this
            browser&rsquo;s access check.
          </p>
          <RetryAttempt attempt={identityAttempt} />
          <button type="button" onClick={() => window.location.reload()}>
            Try again
          </button>
        </main>
      );
    }
    return (
      <main aria-live="polite">
        <p>Checking this browser's Station access…</p>
        <RetryAttempt attempt={identityAttempt} />
      </main>
    );
  }
  if (resolution.kind === 'access-required') {
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
        {resolution.message && <p role="alert">{resolution.message}</p>}
        <GuidedConnect
          onSessionEstablished={handleSessionEstablished}
          onExploreSample={() => setSampleOpen(true)}
        />
      </section>
    );
  }
  if (resolution.kind === 'host-unavailable') {
    return (
      // `local-ui-session-recovery` carries no styling: it is the hook the
      // first-run readiness wait identifies this screen by
      // (`tests/helpers/local-ui-access-readiness.ts`), and the `:not()` that
      // keeps this screen out of that wait's "still pending" selector. Removing
      // it makes a settled screen read as pending and the wait spin to its
      // deadline. Rename it there in the same change.
      <main className="local-ui-session-recovery" aria-live="polite">
        <h1>Reconnecting to this Station</h1>
        <p role="alert">
          Station&rsquo;s host process is down or recovering — it answered that
          way {LOCAL_UI_SESSION_ATTEMPT_LIMIT} times in a row. This
          browser&rsquo;s current access stays in place; reload after the host
          restarts.
        </p>
        <button type="button" onClick={() => window.location.reload()}>
          Try again
        </button>
      </main>
    );
  }
  return <>{children}</>;
}
