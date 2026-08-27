// Deep-imported from `/client` on purpose: this boundary is on the eager
// entry path, and the SDK's root barrel pulls its whole React surface with it.
import { StationHttpError } from '@kontourai/station-sdk/client';
import {
  Component,
  type ErrorInfo,
  type ReactNode,
  Suspense,
  useEffect,
} from 'react';
import { Button } from '../components/Button';
import { ErrorState } from '../components/state';
import { type LocaleContextValue, useLocale } from '../i18n/LocaleContext';
import { openConnectionsModal } from '../lib/connectionModalEvents';
import { RoutePendingSkeleton } from './RoutePendingSkeleton';
import { routeTransitionStore } from './route-transition-store';

/**
 * What actually failed, derived from the thrown error rather than assumed
 * (SHELL-06). Every route failure used to render "Reload Station to retry the
 * route download" — a sentence that is only true for the first case, and that
 * discards all UI state for the other two.
 */
export type RouteFailureKind = 'chunk' | 'authority' | 'view';

const CHUNK_LOAD_MESSAGE =
  /dynamically imported module|importing a module script failed|chunkloaderror|failed to fetch dynamically/i;

export function classifyRouteFailure(error: unknown): RouteFailureKind {
  // The status is the only fact that separates "you may not see this" from
  // "this broke": a 401/403 does not get better by retrying the same request
  // with the same credential.
  if (error instanceof StationHttpError) {
    return error.status === 401 || error.status === 403 ? 'authority' : 'view';
  }
  if (error instanceof Error) {
    if (
      error.name === 'ChunkLoadError' ||
      CHUNK_LOAD_MESSAGE.test(error.message)
    ) {
      return 'chunk';
    }
  }
  return 'view';
}

interface RouteErrorBoundaryState {
  error: unknown;
}

class RouteErrorBoundary extends Component<
  {
    children: ReactNode;
    routeKey: string;
    message: LocaleContextValue['message'];
  },
  RouteErrorBoundaryState
> {
  state: RouteErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  componentDidUpdate(previous: Readonly<{ routeKey: string }>) {
    if (previous.routeKey !== this.props.routeKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Route view failed to load:', error, info);
  }

  /**
   * Re-render the route rather than reload the document. React unmounted the
   * failed subtree when this boundary rendered its error state, so clearing
   * the error mounts the route again from scratch — while the shell, the
   * sidebar, every other open surface and the whole client cache survive.
   *
   * It is deliberately NOT offered for a rejected chunk import: React caches
   * a `lazy()` rejection for the life of the module, so mounting the same
   * lazy component replays the same rejected promise (the reason
   * `LazyBoundary` has to construct a fresh one). Offering "Try again" there
   * would be a button that cannot work.
   */
  retry = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      const kind = classifyRouteFailure(this.state.error);
      if (kind === 'chunk') {
        return (
          <ErrorState
            title={this.props.message('route.chunk.title')}
            description={this.props.message('route.chunk.description', {
              product: 'Station',
            })}
            action={
              <Button
                variant="primary"
                onClick={() => window.location.reload()}
              >
                {this.props.message('route.chunk.action')}
              </Button>
            }
          />
        );
      }
      if (kind === 'authority') {
        return (
          <ErrorState
            title={this.props.message('route.authority.title')}
            description={this.props.message('route.authority.description')}
            action={
              <>
                <Button
                  variant="primary"
                  onClick={() => openConnectionsModal()}
                >
                  {this.props.message('route.authority.reviewAction')}
                </Button>
                <Button variant="secondary" onClick={this.retry}>
                  {this.props.message('route.retryAction')}
                </Button>
              </>
            }
          />
        );
      }
      return (
        <ErrorState
          title={this.props.message('route.generic.title')}
          description={this.props.message('route.generic.description')}
          action={
            <Button variant="primary" onClick={this.retry}>
              {this.props.message('route.retryAction')}
            </Button>
          }
        />
      );
    }
    return this.props.children;
  }
}

/**
 * The route outlet's pending state, and the only thing that publishes it.
 * Rendering this component IS the suspension — React mounts a Suspense
 * fallback if and only if its children are suspended — so the shell's nav
 * chrome reads a fact rather than a guess about how long a route takes.
 *
 * The surface comes in as a PROP, and the effect depends on it. The first
 * version read `window.location.pathname` inside a `[]` effect, which is
 * wrong for the case it exists to serve: navigate to a suspended route A,
 * then to a suspended route B, and React keeps this same fallback instance
 * mounted. A `[]` effect does not re-run, so the shell went on reporting A as
 * pending for the whole of B's load — the sidebar marked the row the user had
 * already left.
 */
function RouteViewPending({
  surfaceId,
  body,
}: {
  surfaceId: string | null;
  body: ReactNode;
}) {
  useEffect(() => {
    if (!surfaceId) return;
    routeTransitionStore.setPending(surfaceId);
    return () => routeTransitionStore.clearPending(surfaceId);
  }, [surfaceId]);
  return <>{body}</>;
}

export function RouteViewBoundary({
  children,
  routeKey,
  pendingSurfaceId = null,
  pendingBody = <RoutePendingSkeleton />,
}: {
  children: ReactNode;
  routeKey: string;
  /**
   * The surface the outlet is loading, resolved by the caller from the same
   * registry the sidebar highlights from. Optional so a caller that does not
   * own a surface (tests, embedded outlets) simply publishes nothing.
   */
  pendingSurfaceId?: string | null;
  /**
   * What to show while the outlet is suspended. The caller builds it because
   * only the caller knows the route: the shell hands a `RoutePendingSkeleton`
   * bound to the arriving view and the SAME frame spec it hands `PageFrame`,
   * so the shape the placeholder holds and the shape the page arrives in are
   * one resolution rather than two. A caller with no route gets the unshaped
   * placeholder, which is what this boundary has always shown.
   */
  pendingBody?: ReactNode;
}) {
  const { message } = useLocale();
  return (
    <RouteErrorBoundary routeKey={routeKey} message={message}>
      {/* Keyed as well as prop-driven: the key guarantees a fresh instance
          per route rather than relying on React reusing this position, and
          React runs every destroy before every create in a commit, so the
          outgoing surface releases before the incoming one publishes. */}
      <Suspense
        fallback={
          <RouteViewPending
            key={routeKey}
            surfaceId={pendingSurfaceId}
            body={pendingBody}
          />
        }
      >
        {children}
      </Suspense>
    </RouteErrorBoundary>
  );
}
