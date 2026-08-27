/**
 * @vitest-environment jsdom
 */

import { StationHttpError } from '@kontourai/station-sdk/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { Component, type ReactNode, useEffect } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  classifyRouteFailure,
  RouteViewBoundary,
} from '../app-shell/RouteViewBoundary';
import { routeTransitionStore } from '../app-shell/route-transition-store';
import { OPEN_CONNECTIONS_MODAL_EVENT } from '../lib/connectionModalEvents';

class ThrowingView extends Component<{ error?: unknown }> {
  render(): ReactNode {
    throw this.props.error ?? new Error('seeded route failure');
  }
}

function SuspendedView(): ReactNode {
  throw new Promise(() => undefined);
}

/**
 * Throws for as long as the shared flag says to, and counts its own mounts.
 * The flag is flipped from the test, not by the component itself: React
 * re-renders a failed tree synchronously after a concurrent error, so a
 * "throw once" fixture recovers before the boundary is ever exercised.
 */
function ConditionallyThrowingView({
  state,
}: {
  state: { shouldThrow: boolean; mounts: number };
}): ReactNode {
  useEffect(() => {
    state.mounts += 1;
  }, [state]);
  if (state.shouldThrow) throw new Error('transient view failure');
  return <div>Route recovered</div>;
}

describe('RouteViewBoundary', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('shows an accessible loading state while a route chunk resolves', () => {
    render(
      <RouteViewBoundary routeKey="activity:all">
        <SuspendedView />
      </RouteViewBoundary>,
    );

    expect(screen.getByRole('status', { name: 'Loading view' })).toBeTruthy();
  });

  test('publishes the suspended route so the shell can mark it pending', () => {
    // SHELL-05: the nav row the user clicked said nothing for the ~1.4 s a
    // cold route chunk takes. The pending state is the mounted fallback
    // itself — a fact, not a timer started optimistically at click time — so
    // it must appear only while suspended and clear on resolution.
    expect(routeTransitionStore.getSnapshot()).toBeNull();

    const { rerender } = render(
      <RouteViewBoundary routeKey="activity:all" pendingSurfaceId="activity">
        <SuspendedView />
      </RouteViewBoundary>,
    );
    expect(routeTransitionStore.getSnapshot()).toBe('activity');

    rerender(
      <RouteViewBoundary routeKey="activity:all" pendingSurfaceId="activity">
        <div>Route content</div>
      </RouteViewBoundary>,
    );
    expect(routeTransitionStore.getSnapshot()).toBeNull();
  });

  test('a second navigation through the SAME boundary republishes, while the first is still suspended', () => {
    // The production structure, which the previous version of this test did
    // not reproduce: ONE boundary, rerendered from route A to route B while
    // A's chunk has not arrived. React reuses the fallback instance in that
    // position, so a publisher that captured its route on mount (in a `[]`
    // effect reading `window.location`) never re-ran — the shell went on
    // marking the row the user had already left for the whole of B's load.
    // Two independent render roots, as before, could never catch that.
    const { rerender } = render(
      <RouteViewBoundary routeKey="activity:all" pendingSurfaceId="activity">
        <SuspendedView />
      </RouteViewBoundary>,
    );
    expect(routeTransitionStore.getSnapshot()).toBe('activity');

    rerender(
      <RouteViewBoundary routeKey="schedule" pendingSurfaceId="schedule">
        <SuspendedView />
      </RouteViewBoundary>,
    );
    expect(routeTransitionStore.getSnapshot()).toBe('schedule');

    rerender(
      <RouteViewBoundary routeKey="schedule" pendingSurfaceId="schedule">
        <div>Route content</div>
      </RouteViewBoundary>,
    );
    expect(routeTransitionStore.getSnapshot()).toBeNull();
  });

  test('a stale boundary releasing cannot clear a newer route’s pending state', () => {
    // Two boundaries alive at once (a transition, or an outlet rendered in
    // two places): the older one unmounting must not erase what the newer one
    // published. This is what the id guard in `clearPending` is for.
    const first = render(
      <RouteViewBoundary routeKey="activity:all" pendingSurfaceId="activity">
        <SuspendedView />
      </RouteViewBoundary>,
    );
    const second = render(
      <RouteViewBoundary routeKey="schedule" pendingSurfaceId="schedule">
        <SuspendedView />
      </RouteViewBoundary>,
    );
    expect(routeTransitionStore.getSnapshot()).toBe('schedule');

    first.unmount();
    expect(routeTransitionStore.getSnapshot()).toBe('schedule');
    second.unmount();
    expect(routeTransitionStore.getSnapshot()).toBeNull();
  });

  test('publishes nothing when the outlet owns no surface', () => {
    render(
      <RouteViewBoundary routeKey="not-found:/nope">
        <SuspendedView />
      </RouteViewBoundary>,
    );
    expect(routeTransitionStore.getSnapshot()).toBeNull();
  });

  test('contains a route failure and resets when navigation changes', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { rerender } = render(
      <RouteViewBoundary routeKey="activity:all">
        <ThrowingView />
      </RouteViewBoundary>,
    );

    expect(screen.getByRole('alert').textContent).toContain(
      'This view stopped working.',
    );

    rerender(
      <RouteViewBoundary routeKey="settings">
        <div>Settings loaded</div>
      </RouteViewBoundary>,
    );
    expect(screen.getByText('Settings loaded')).toBeTruthy();
  });

  /**
   * SHELL-06: every failure used to say "Reload Station to retry the route
   * download", which is only true for a chunk that could not be fetched, and
   * which throws away all UI state for the two cases where it is false.
   */
  describe('classification (SHELL-06)', () => {
    test('reads the kind from the error, not from the boundary', () => {
      expect(
        classifyRouteFailure(
          new Error('Failed to fetch dynamically imported module: /x.js'),
        ),
      ).toBe('chunk');
      const chunkError = new Error('boom');
      chunkError.name = 'ChunkLoadError';
      expect(classifyRouteFailure(chunkError)).toBe('chunk');
      expect(classifyRouteFailure(new StationHttpError(401))).toBe('authority');
      expect(classifyRouteFailure(new StationHttpError(403))).toBe('authority');
      expect(classifyRouteFailure(new StationHttpError(500))).toBe('view');
      expect(classifyRouteFailure(new TypeError('undefined is not a fn'))).toBe(
        'view',
      );
    });

    test('a failed chunk download is the only case that offers a reload', () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      render(
        <RouteViewBoundary routeKey="activity:all">
          <ThrowingView
            error={new Error('Failed to fetch dynamically imported module')}
          />
        </RouteViewBoundary>,
      );

      expect(
        screen.getByRole('button', { name: 'Reload Station' }),
      ).toBeTruthy();
      // A retry here cannot work: React caches the rejected lazy promise.
      expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    });

    test('an authority failure offers the connection, not a reload', () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const opened = vi.fn();
      window.addEventListener(OPEN_CONNECTIONS_MODAL_EVENT, opened);
      render(
        <RouteViewBoundary routeKey="activity:all">
          <ThrowingView error={new StationHttpError(403, 'forbidden')} />
        </RouteViewBoundary>,
      );

      expect(screen.getByRole('alert').textContent).toContain(
        'not available to you',
      );
      expect(
        screen.queryByRole('button', { name: 'Reload Station' }),
      ).toBeNull();
      fireEvent.click(
        screen.getByRole('button', { name: 'Review connection' }),
      );
      expect(opened).toHaveBeenCalled();
      window.removeEventListener(OPEN_CONNECTIONS_MODAL_EVENT, opened);
    });

    test('a view failure retries by remounting the route, not by reloading', () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const reloadSpy = vi.fn();
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: { ...window.location, reload: reloadSpy },
      });
      const state = { shouldThrow: true, mounts: 0 };
      render(
        <RouteViewBoundary routeKey="activity:all">
          <ConditionallyThrowingView state={state} />
        </RouteViewBoundary>,
      );

      expect(screen.getByRole('alert').textContent).toContain(
        'This view stopped working.',
      );

      // Whatever made the view throw is now fixed; only a REMOUNT can
      // discover that — a re-render of the same failed tree cannot.
      state.shouldThrow = false;
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

      // The route mounted and committed for the first time on the retry —
      // the failed attempt never committed, so this is a genuine mount of the
      // route inside the same document, not a page reload.
      expect(screen.getByText('Route recovered')).toBeTruthy();
      expect(state.mounts).toBe(1);
      expect(reloadSpy).not.toHaveBeenCalled();
    });
  });
});
