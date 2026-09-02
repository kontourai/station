import { ChatDock } from '../components/chat-dock/ChatDock';
import { useRegionModelOptional } from '../contexts/RegionModelContext';
import type { NavigationView } from '../types';
import type { HomeViewNavigation } from '../views/home/useHomeViewModel';
import type { WorkspacePaneDockAction } from '../workspace-panes/WorkspacePaneDockContext';
import { DOCK_REGION_IDS } from './region-model';

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
            key={id}
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
