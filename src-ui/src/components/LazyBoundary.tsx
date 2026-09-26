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

function lazyFor(load: AnyLoad): AnyLazy {
  let component = sharedLazy.get(load);
  if (!component) {
    component = lazy(load);
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

interface LazyImportErrorBoundaryProps {
  children: ReactNode;
  onError: () => void;
  onRetry: () => void;
  unavailable?: (onRetry: () => void) => ReactNode;
}

interface LazyImportErrorBoundaryState {
  error: Error | null;
}

class LazyImportErrorBoundary extends Component<
  LazyImportErrorBoundaryProps,
  LazyImportErrorBoundaryState
> {
  state: LazyImportErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): LazyImportErrorBoundaryState {
    return { error };
  }

  componentDidCatch() {
    this.props.onError();
  }

  render() {
    if (this.state.error) {
      if (this.props.unavailable) {
        return this.props.unavailable(this.props.onRetry);
      }
      return (
        <div className="lazy-boundary__error" role="alert">
          <span>Unable to load this part of Station.</span>
          <button type="button" onClick={this.props.onRetry}>
            Retry
          </button>
          <button type="button" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

export interface LazyBoundaryProps<Props extends object> {
  load: () => Promise<{ default: ComponentType<Props> }>;
  componentProps: Props;
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

function LazyAttempt<Props extends object>({
  component,
  componentProps,
  pending,
}: {
  component: ComponentType<Props>;
  componentProps: Props;
  pending: ReactNode;
}) {
  return (
    <Suspense fallback={pending}>
      {createElement(component, componentProps)}
    </Suspense>
  );
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
  shareAcrossMounts = false,
}: LazyBoundaryProps<Props>) {
  const [attempt, setAttempt] = useState(0);
  // `attempt` is a dependency on purpose: a retry must build (or, when
  // shared, look up again after forgetting the failed one) a new component.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above.
  const component = useMemo(
    () => (shareAcrossMounts ? lazyFor(load) : lazy(load)),
    [load, attempt, shareAcrossMounts],
  );

  return (
    <LazyImportErrorBoundary
      key={attempt}
      onError={() => forgetLazy(load, component)}
      onRetry={() => setAttempt((currentAttempt) => currentAttempt + 1)}
      unavailable={unavailable}
    >
      <LazyAttempt
        key={attempt}
        component={component as ComponentType<Props>}
        componentProps={componentProps}
        pending={pending}
      />
    </LazyImportErrorBoundary>
  );
}
