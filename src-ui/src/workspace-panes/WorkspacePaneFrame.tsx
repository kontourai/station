import type { WorkspacePaneInstanceId } from '@kontourai/station-contracts/workspace-pane';
import {
  Component,
  type ErrorInfo,
  type ReactNode,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import {
  WorkspacePaneHostRuntime,
  type WorkspacePaneRuntimeCallbacks,
} from './workspacePaneHostRuntime';

class WorkspacePaneErrorBoundary extends Component<
  {
    children: ReactNode;
    paneName: string;
    onFailure?: () => void;
    onRetry: () => boolean | Promise<boolean>;
  },
  { error: boolean }
> {
  state = { error: false };

  static getDerivedStateFromError() {
    return { error: true };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo) {
    // Pane failures are intentionally contained to this occurrence. The host
    // has no reason to expose renderer details or let one pane unmount a
    // Project surface. Runtime ownership is optional because direct routes
    // deliberately retain their lightweight local boundary.
    this.props.onFailure?.();
  }

  render() {
    if (this.state.error) {
      return (
        <section aria-label={`${this.props.paneName} unavailable`}>
          <h3>{this.props.paneName} could not open</h3>
          <p>This pane encountered a local rendering problem.</p>
          <button
            type="button"
            onClick={() => {
              void Promise.resolve(this.props.onRetry()).then((recovered) => {
                if (recovered) this.setState({ error: false });
              });
            }}
          >
            Retry pane
          </button>
        </section>
      );
    }
    return this.props.children;
  }
}

/**
 * The first deliberately small Workspace Pane host. Its key is the placed
 * instance identity, so a retry or a different occurrence gets a fresh local
 * error boundary without introducing tabs, persistence, or geometry policy.
 */
export function WorkspacePaneFrame({
  instanceId,
  paneName,
  children,
  onFailure,
  onRetry,
  runtime,
  elementless,
}: {
  instanceId: WorkspacePaneInstanceId;
  paneName: string;
  children: ReactNode;
  /**
   * Render the error boundary around the occupant and NOTHING else — no
   * element of this frame's own.
   *
   * It exists for the shell's ambient dock (archive#3973). `display: contents`
   * is not enough there: it removes a wrapper's BOX but not its place in the
   * DOM, and the shell positions the dock with child combinators
   * (`.app__main > [data-region="left"]`, `:has(> [data-region])`), which stop
   * matching the moment anything sits between them. An occupant that owns its
   * own placement needs the frame to contribute no node at all.
   *
   * The cost, stated rather than hidden: no element means no
   * `data-workspace-pane-lifecycle` and no `inert` toggling, so this occupant
   * is never suspended. That is sound only where suspension has no meaning —
   * a host with a single always-active occupant and no tabs — which is what
   * the chromeless presentation already is. It must not be passed by a host
   * that can switch between panes.
   */
  elementless?: boolean;
  onFailure?: (instanceId: WorkspacePaneInstanceId) => void;
  onRetry?: (instanceId: WorkspacePaneInstanceId) => boolean | Promise<boolean>;
  /** The host runtime invokes these callbacks only after this renderer frame exists. */
  runtime?: WorkspacePaneHostRuntime;
}) {
  const [retry, setRetry] = useState(0);
  const root = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (!runtime) return;
    const element = root.current;
    if (!element) return;
    const setLifecycle = (state: 'ready' | 'suspended' | 'disposed') => {
      element.dataset.workspacePaneLifecycle = state;
      element.inert = state !== 'ready';
    };
    const callbacks: WorkspacePaneRuntimeCallbacks = {
      mount: () => setLifecycle('ready'),
      resume: () => setLifecycle('ready'),
      suspend: () => setLifecycle('suspended'),
      dispose: () => setLifecycle('disposed'),
    };
    runtime.register(instanceId, callbacks);
  }, [instanceId, runtime]);

  const boundary = (
    <WorkspacePaneErrorBoundary
      key={`${instanceId}:${retry}`}
      paneName={paneName}
      onFailure={() => onFailure?.(instanceId)}
      onRetry={async () => {
        const recovered = (await onRetry?.(instanceId)) ?? true;
        if (recovered) setRetry((current) => current + 1);
        return recovered;
      }}
    >
      {children}
    </WorkspacePaneErrorBoundary>
  );

  if (elementless) return boundary;

  return (
    <section ref={root} data-workspace-pane-lifecycle="suspended">
      {boundary}
    </section>
  );
}
