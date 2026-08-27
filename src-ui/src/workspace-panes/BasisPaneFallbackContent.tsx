import { lazy, Suspense } from 'react';
import { SkeletonBlock } from '../components/state';
import type { BasisPaneHostScope } from './BasisPaneLauncher';

const LazyConnectedSessionInventory = lazy(() =>
  import('./ConnectedSessionInventory').then(
    ({ ConnectedSessionInventory }) => ({
      default: ConnectedSessionInventory,
    }),
  ),
);
const LazyConnectedStationBasisPane = lazy(() =>
  import('./ConnectedStationBasisPane').then(
    ({ ConnectedStationBasisPane }) => ({
      default: ConnectedStationBasisPane,
    }),
  ),
);

/** One fallback dispatcher with per-scope chunks; neither pane is eager here. */
export function ConnectedBasisFallbackPane({
  scope,
  currentProjectId,
}: {
  scope: BasisPaneHostScope;
  currentProjectId?: string;
}) {
  return (
    <Suspense fallback={<SkeletonBlock count={3} label="Loading Basis" />}>
      {scope.kind === 'session-inventory' ? (
        <LazyConnectedSessionInventory
          sessionId={scope.sessionId}
          currentProjectId={currentProjectId}
        />
      ) : (
        <LazyConnectedStationBasisPane
          scope={scope}
          currentProjectId={currentProjectId}
        />
      )}
    </Suspense>
  );
}
