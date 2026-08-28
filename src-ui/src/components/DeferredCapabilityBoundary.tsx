import { useConnectionStatus } from '@kontourai/station-connect';
import {
  Component,
  type ComponentType,
  type ErrorInfo,
  lazy,
  type ReactNode,
  Suspense,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from 'react';
import {
  BANNER_IDS,
  BANNER_PRIORITY,
  bannerStore,
} from '../contexts/banner-store';
import { checkServerHealth, probeServerConnection } from '../lib/serverHealth';

export interface DeferredCapabilityCopy {
  failureTitle: string;
  failure: string;
}

class DeferredCapabilityErrorBoundary extends Component<
  {
    connectionHealthy: boolean;
    children: ReactNode;
    onFailureClassified: (failure: 'consequence' | 'defect') => void;
  },
  { failure: 'pending' | 'consequence' | 'defect' | null }
> {
  state: { failure: 'pending' | 'consequence' | 'defect' | null } = {
    failure: null,
  };

  static getDerivedStateFromError() {
    return { failure: 'pending' as const };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo) {
// The visible diagnostic is deliberately durable. Logging here would only
// duplicate React's development error reporting without repairing a chunk.
    const failure = this.props.connectionHealthy ? 'defect' : 'consequence';
    this.setState({ failure });
    this.props.onFailureClassified(failure);
  }

  render() {
    if (this.state.failure) return null;
    return this.props.children;
  }
}

type DeferredCapabilityModule = Promise<{ default: ComponentType }>;

function createCapabilityAttempt(
  load: () => DeferredCapabilityModule,
  _attempt: number,
) {
// `_attempt` is the retry identity for useMemo; React.lazy itself only needs
// the loader. A new identity is what discards React.lazy's cached rejection.
  return lazy(load);
}

/**
 * Loads an optional shell capability without allowing its import to blank the
 * already-mounted Station workspace. Healthy-connection failures remain loud;
 * failures caught before health is confirmed stay quiet and are retried with a
 * fresh React.lazy identity when the shared connection recovers.
 */
export function DeferredCapabilityBoundary({
  children,
  copy,
  id,
  load,
}: {
  children?: ReactNode;
  copy: DeferredCapabilityCopy;
/** Stable instance id; sibling boundaries must never overwrite each other. */
  id: string;
/** Loader form permits a failed React.lazy import to be attempted again after reconnect. */
  load?: () => DeferredCapabilityModule;
}) {
  const { status } = useConnectionStatus({
    checkHealth: checkServerHealth,
    probeEndpoint: probeServerConnection,
    pollInterval: 10_000,
  });
  const connectionHealthy = status === 'connected';
  const [failure, setFailure] = useState<'consequence' | 'defect' | null>(null);
  const [attempt, setAttempt] = useState(0);
  const bannerId = `${BANNER_IDS.deferredCapability}:${id}`;

  useEffect(() => {
    if (failure !== 'defect') {
      bannerStore.dismiss(bannerId);
      return;
    }

    bannerStore.present({
      id: bannerId,
      priority: BANNER_PRIORITY.capabilityFailure,
      tone: 'error',
      badge: copy.failureTitle,
      message: copy.failure,
      occurrence: `${id}:${attempt}`,
      actions: [
        {
          label: 'Reload Station',
          onClick: () => window.location.reload(),
        },
      ],
      dismissible: false,
    });

    return () => bannerStore.dismiss(bannerId);
  }, [attempt, bannerId, copy.failure, copy.failureTitle, failure, id]);

  useLayoutEffect(() => {
    if (!connectionHealthy || failure !== 'consequence') return;
    setAttempt((current) => current + 1);
    setFailure(null);
  }, [connectionHealthy, failure]);

  const LoadedCapability = useMemo(
    () => (load ? createCapabilityAttempt(load, attempt) : null),
    [load, attempt],
  );
  const content = LoadedCapability ? <LoadedCapability /> : children;

  return (
    <DeferredCapabilityErrorBoundary
      key={attempt}
      connectionHealthy={connectionHealthy}
      onFailureClassified={setFailure}
    >
      <Suspense
        fallback={<span aria-hidden="true" data-deferred-capability-pending />}
      >
        {content}
      </Suspense>
    </DeferredCapabilityErrorBoundary>
  );
}
