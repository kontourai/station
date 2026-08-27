import { Skeleton, SkeletonList } from '../components/state';

/**
 * Layout-shaped placeholder rendered in place of `AppViewContent` at `/`
 * while `resolveHomeSurface` is still `pending` (#223) — never a bare
 * spinner, and never `AppViewContent` with a guessed `currentView`, so
 * `NewProjectModal` cannot flash on-screen while restore is still in flight.
 * This is an inline content state, not shell chrome.
 */
export function HomeRoutePendingSkeleton() {
  return (
    <div
      className="home-route-skeleton"
      role="status"
      aria-busy="true"
      aria-label="Loading your workspace"
    >
      <Skeleton variant="line" className="home-route-skeleton__title" />
      <SkeletonList count={4} />
    </div>
  );
}
