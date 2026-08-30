import {
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useDegradedQueryState } from '../hooks/useDegradedQueryState';
import {
  recheckLocalUiSessionAfterPairing,
  resolveLocalUiSession,
} from '../lib/local-ui-bootstrap';
import { GuidedConnect } from './GuidedConnect';
import { SkeletonBlock } from './state';

const UnpairedSampleWorkspace = lazy(async () => {
  const module = await import('./first-run/UnpairedSampleWorkspace');
  return { default: module.UnpairedSampleWorkspace };
});

interface LocalUiSessionGateProps {
  apiBase: string;
  children: ReactNode;
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
          <button type="button" onClick={() => window.location.reload()}>
            Try again
          </button>
        </main>
      );
    }
    return (
      <main aria-live="polite">Checking this browser's Station access…</main>
    );
  }
  if (resolution.kind === 'access-required') {
    if (sampleOpen) {
      return (
        <section aria-label="Station sample workspace">
          <Suspense
            fallback={
              // SHELL-13: not a twelfth wait sentence. The wait names itself
              // in the skeleton's `label`; only the pre-auth access check
              // above still renders a full-screen sentence, and it is the one
              // recorded exception to the vocabulary.
              <SkeletonBlock count={2} label="Opening the sample workspace" />
            }
          >
            <UnpairedSampleWorkspace onConnect={() => setSampleOpen(false)} />
          </Suspense>
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
      <main className="local-ui-session-recovery" aria-live="polite">
        <h1>Reconnecting to this Station</h1>
        <p role="alert">
          Station&rsquo;s host process is down or recovering. This
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
