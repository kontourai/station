import {
  WORKSPACE_ACTIVITY_PANE_DESCRIPTOR,
  WORKSPACE_ACTIVITY_PANE_INSTANCE,
} from '@kontourai/station-contracts/workspace-activity-pane';
import { ChatDockHeader } from '../components/chat-dock/ChatDockHeader';
import { DockShell } from '../components/chat-dock/DockShell';
import { LazyBoundary } from '../components/LazyBoundary';
import { SkeletonBlock } from '../components/Skeleton';
import { useApiBase } from '../contexts/ApiBaseContext';
import { reportRegionClearance } from '../regions/region-clearance';
import type { DockRegionId } from '../regions/region-model';
import { ActivityWorkspacePaneBindingProvider } from '../views/activity/ActivityWorkspacePaneBinding';

const loadActivityWorkspacePane = () =>
  import('../views/activity/ActivityWorkspacePane').then(
    ({ ActivityWorkspacePane }) => ({ default: ActivityWorkspacePane }),
  );

export function ActivityRegionShell({ regionId }: { regionId: DockRegionId }) {
  const { apiBase } = useApiBase();
  return (
    <DockShell
      regionId={regionId}
      onRenderedRegionGeometryChange={reportRegionClearance}
    >
      {(chrome) => (
        <>
          <ChatDockHeader
            regionVisible={chrome.isDockOpen}
            shellMaximized={chrome.isDockMaximized}
            canMaximize={chrome.canMaximize}
            surfaceShortcutId={chrome.surfaceShortcutId}
            isDragging={chrome.isDragging}
            onDockSnap={chrome.applyDockSnap}
            availableDockSlotPlacements={chrome.availableDockSlotPlacements}
            effectiveDockSlotPlacement={chrome.effectiveDockSlotPlacement}
            onDockPlacementChange={chrome.commitDockPlacement}
          />
          <div className="dock-slot__body">
            <ActivityWorkspacePaneBindingProvider binding={{ apiBase }}>
              <LazyBoundary
                load={loadActivityWorkspacePane}
                componentProps={{
                  descriptor: WORKSPACE_ACTIVITY_PANE_DESCRIPTOR,
                  instance: WORKSPACE_ACTIVITY_PANE_INSTANCE,
                }}
                pending={<SkeletonBlock count={3} label="Loading Activity" />}
              />
            </ActivityWorkspacePaneBindingProvider>
          </div>
        </>
      )}
    </DockShell>
  );
}
