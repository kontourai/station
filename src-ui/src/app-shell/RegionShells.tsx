import { ChatDock } from '../components/chat-dock/ChatDock';
import { useRegionModelOptional } from '../contexts/RegionModelContext';
import { DOCK_REGION_IDS } from '../regions/region-model';
import type { NavigationView } from '../types';
import type { HomeViewNavigation } from '../views/home/useHomeViewModel';
import type { WorkspacePaneDockAction } from '../workspace-panes/WorkspacePaneDockContext';

/**
 * One `DockShell` per occupied dock region (#928). A surface occupies at most
 * one region (`placeSurface`, region-model.ts), which is what keeps
 * `#chat-dock` unique and `dock.maximize` singly registered, and is why the
 * shell is keyed by its OCCUPANT: moving a surface re-props the same
 * instance instead of tearing the pane down, exactly as the single ambient
 * `ChatDock` behaved before this file existed. Chat is the only registered
 * surface in this slice; `main-provider-order.test.ts` guards the provider,
 * and the no-provider branch keeps App-level tests on the legacy mount.
 */
export function RegionShells({
  homeContinuation,
  onNavigate,
  onDockActionChange,
}: {
  homeContinuation: HomeViewNavigation | null;
  onNavigate: (view: NavigationView) => void;
  onDockActionChange: (action: WorkspacePaneDockAction | null) => void;
}) {
  const model = useRegionModelOptional();
  if (!model)
    return (
      <ChatDock
        homeContinuation={homeContinuation}
        onNavigate={onNavigate}
        onDockActionChange={onDockActionChange}
      />
    );
  return (
    <>
      {DOCK_REGION_IDS.map((id) =>
        model.regions[id].occupant === 'chat' ? (
          <ChatDock
            key={model.regions[id].occupant}
            regionId={id}
            homeContinuation={homeContinuation}
            onNavigate={onNavigate}
            onDockActionChange={onDockActionChange}
          />
        ) : null,
      )}
    </>
  );
}
