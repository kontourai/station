import {
  Component,
  type ComponentType,
  createElement,
  type LazyExoticComponent,
  lazy,
  type ReactNode,
  Suspense,
  useMemo,
  useState,
} from 'react';
import { markTranscriptPhase } from './chat/transcriptLayoutTrace';
import './LazyBoundary.css';

type AnyLoad = () => Promise<{ default: ComponentType<any> }>;
type AnyLazy = LazyExoticComponent<ComponentType<any>>;

/**
 * One lazy component per loader, for boundaries that opt in with
 * `shareAcrossMounts`: a surface whose chunk has loaded then renders without
 * suspending when another instance mounts (a list of icons would otherwise
 * blank each new row for a tick).
 *
 * Opt-in, not the default: sharing moves a later mount's child into the same
 * commit as its parent, so the child's effects run BEFORE the parent's instead
 * of after them. Existing callers were written against the deferred mount —
 * turning it on for all of them broke five tests in four suites, including a
 * pairing reconciler whose decline no longer withdrew the waiting banner.
 */
const sharedLazy = new WeakMap<AnyLoad, AnyLazy>();

/**
 * React gets the tracing promise, even when a loader reuses its own native
 * promise. Passing the loader promise through can hang a later lazy mount.
 */
function traced(load: AnyLoad): AnyLazy {
  return lazy(() =>
    load().then((module) => {
      // A production build minifies `load.name`; it names the loader only
      // in development.
      markTranscriptPhase('lazy-chunk-resolved', {
        loader: load.name || 'anonymous',
      });
      return module;
    }),
  );
}

function lazyFor(load: AnyLoad): AnyLazy {
  let component = sharedLazy.get(load);
  if (!component) {
    component = traced(load);
    sharedLazy.set(load, component);
  }
  return component;
}

/**
 * React caches a lazy component's rejection for good, so a failed one is
 * dropped: the next retry or mount, in this boundary or any other, imports
 * again instead of replaying the cached failure.
 */
function forgetLazy(load: AnyLoad, component: AnyLazy) {
  if (sharedLazy.get(load) === component) sharedLazy.delete(load);
}

/**
 * The chunk-failure row the boundary renders by default. Exported so a
 * consumer with its own chrome around a lazy surface (the conversation
 * history's header and close button) renders the same row in its
 * `unavailable` slot instead of copying the markup — one place changes when
 * this block's UX does.
 */
type LazySurface = { id: string; label: string };

export function LazyBoundaryError({
  onRetry,
  surface,
}: {
  onRetry: () => void;
  surface?: LazySurface;
}) {
  return (
    <div
      className="lazy-boundary__error"
      data-lazy-surface={surface?.id}
      role="alert"
    >
      <span>Unable to load {surface?.label ?? 'this part of Station'}.</span>
      <button type="button" onClick={onRetry}>
        Retry
      </button>
      <button type="button" onClick={() => window.location.reload()}>
        Reload
      </button>
    </div>
  );
}

class LazyImportErrorBoundary extends Component<
  { children: ReactNode; onError: () => void; renderError: () => ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    this.props.onError();
  }

  render() {
    return this.state.failed ? this.props.renderError() : this.props.children;
  }
}

export interface LazyBoundaryProps<Props extends object> {
  load: () => Promise<{ default: ComponentType<Props> }>;
  componentProps: Props;
  /** Stable identity and user-facing name of the surface that owns failure. */
  surface?: LazySurface;
  /**
   * Rendered while the chunk is in flight. Named `pending`, not `fallback`:
   * nothing here substitutes for the real surface, it reports that the real
   * surface is loading. (This repo reserves "fallback" for the degraded
   * alternate implementations it does not allow.)
   */
  pending: ReactNode;
  /** Rendered when the import rejects, with a retry that re-runs it. */
  unavailable?: (onRetry: () => void) => ReactNode;
  /**
   * Share one lazy component with every boundary on the same (module-level)
   * `load`, so a mount after the chunk has loaded renders in the same commit.
   * Only for leaf content whose parent does not depend on the child mounting
   * after its own effects; see `sharedLazy`.
   */
  shareAcrossMounts?: boolean;
}

/**
 * Contains a code-split surface's pending and rejected states. Retrying uses a
 * newly-created lazy component, which invokes the import factory again rather
 * than reusing React's cached rejected promise.
 */
export function LazyBoundary<Props extends object>({
  load,
  componentProps,
  pending,
  unavailable,
  surface,
  shareAcrossMounts = false,
}: LazyBoundaryProps<Props>) {
  const [attempt, setAttempt] = useState(0);
  // `attempt` is a dependency on purpose: a retry must build (or, when
  // shared, look up again after forgetting the failed one) a new component.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above.
  const component = useMemo(
    () => (shareAcrossMounts ? lazyFor(load) : traced(load)),
    [load, attempt, shareAcrossMounts],
  );

  const retry = () => setAttempt((current) => current + 1);
  return (
    <LazyImportErrorBoundary
      key={attempt}
      onError={() => forgetLazy(load, component)}
      renderError={() =>
        unavailable ? (
          unavailable(retry)
        ) : (
          <LazyBoundaryError onRetry={retry} surface={surface} />
        )
      }
    >
      <Suspense fallback={pending}>
        {createElement(component as ComponentType<Props>, componentProps)}
      </Suspense>
    </LazyImportErrorBoundary>
  );
}
