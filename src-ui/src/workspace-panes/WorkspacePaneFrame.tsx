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
  WorkspacePaneFailure,
  type WorkspacePaneFailureContext,
  type WorkspacePaneFailureDetail,
  workspacePaneFailureDetail,
} from './WorkspacePaneFailure';
import {
  WorkspacePaneHostRuntime,
  type WorkspacePaneRuntimeCallbacks,
} from './workspacePaneHostRuntime';

class WorkspacePaneErrorBoundary extends Component<
  {
    children: ReactNode;
    paneName: string;
    readFailureContext?: () => WorkspacePaneFailureContext | undefined;
    onFailure?: (
      detail: WorkspacePaneFailureDetail,
      context: WorkspacePaneFailureContext | undefined,
    ) => void;
    onRetry: () => boolean | Promise<boolean>;
  },
  {
    error: WorkspacePaneFailureDetail | null;
    context?: WorkspacePaneFailureContext;
  }
> {
  state: {
    error: WorkspacePaneFailureDetail | null;
    context?: WorkspacePaneFailureContext;
  } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error: workspacePaneFailureDetail(error) };
  }

  componentDidCatch(error: Error, _info: ErrorInfo) {
    // Pane failures are contained to this occurrence: one pane must not
    // unmount a Project surface. The error itself is handed to the host so
    // its failure state can show what failed instead of discarding it (React
    // also reports it to the console). Runtime ownership is optional because
    // direct routes deliberately retain their lightweight local boundary.
    // The pane-owned context is read HERE, once, at the moment of failure,
    // and kept: a later change (another chat opened elsewhere) must not
    // relabel this failure or redirect its actions.
    const context = this.props.readFailureContext?.();
    this.setState({ context });
    this.props.onFailure?.(workspacePaneFailureDetail(error), context);
  }

  private retry = () => {
    void Promise.resolve(this.props.onRetry()).then((recovered) => {
      if (recovered) this.setState({ error: null, context: undefined });
    });
  };

  render() {
    if (this.state.error) {
      const context = this.state.context;
      const back = context?.back;
      return (
        <WorkspacePaneFailure
          paneName={this.props.paneName}
          detail={this.state.error}
          context={
            back
              ? {
                  ...context,
                  back: {
                    label: back.label,
                    // Back changes what the pane opens; the retry remounts
                    // it on that state.
                    onBack: () => {
                      back.onBack();
                      this.retry();
                    },
                  },
                }
              : context
          }
          onRetry={this.retry}
        />
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
  readFailureContext,
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
  /** Reads the pane-owned failure context; called once, when the pane fails. */
  readFailureContext?: () => WorkspacePaneFailureContext | undefined;
  onFailure?: (
    instanceId: WorkspacePaneInstanceId,
    detail: WorkspacePaneFailureDetail,
    context?: WorkspacePaneFailureContext,
  ) => void;
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
      readFailureContext={readFailureContext}
      onFailure={(detail, context) => onFailure?.(instanceId, detail, context)}
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
