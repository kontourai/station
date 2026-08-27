import {
  Component,
  type ComponentType,
  createElement,
  lazy,
  type ReactNode,
  Suspense,
  useMemo,
  useState,
} from 'react';

interface LazyImportErrorBoundaryProps {
  children: ReactNode;
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
}

function LazyAttempt<Props extends object>({
  load,
  componentProps,
  pending,
}: Omit<LazyBoundaryProps<Props>, 'unavailable'>) {
  const LazyComponent = useMemo(() => lazy(load), [load]);

  return (
    <Suspense fallback={pending}>
      {createElement(LazyComponent, componentProps)}
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
}: LazyBoundaryProps<Props>) {
  const [attempt, setAttempt] = useState(0);

  return (
    <LazyImportErrorBoundary
      key={attempt}
      onRetry={() => setAttempt((currentAttempt) => currentAttempt + 1)}
      unavailable={unavailable}
    >
      <LazyAttempt
        key={attempt}
        load={load}
        componentProps={componentProps}
        pending={pending}
      />
    </LazyImportErrorBoundary>
  );
}
