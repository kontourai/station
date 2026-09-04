import {
  WORKSPACE_ACTIVITY_PANE_DESCRIPTOR,
  WORKSPACE_ACTIVITY_PANE_INSTANCE,
} from '@kontourai/station-contracts/workspace-activity-pane';
import { useMemo } from 'react';
import { ChatDockHeader } from '../components/chat-dock/ChatDockHeader';
import { DockShell } from '../components/chat-dock/DockShell';
import { LazyBoundary } from '../components/LazyBoundary';
import { SkeletonBlock } from '../components/Skeleton';
import { useApiBase } from '../contexts/ApiBaseContext';
import { useRegionModel } from '../contexts/RegionModelContext';
import { reportRegionClearance } from '../regions/region-clearance';
import {
  type DockRegionId,
  REGION_SURFACE_REGISTRY,
} from '../regions/region-model';
import { ActivityWorkspacePaneBindingProvider } from '../views/activity/ActivityWorkspacePaneBinding';

const loadActivityWorkspacePane = () =>
  import('../views/activity/ActivityWorkspacePane').then(
    ({ ActivityWorkspacePane }) => ({ default: ActivityWorkspacePane }),
  );

export function ActivityRegionShell({ regionId }: { regionId: DockRegionId }) {
  const { apiBase } = useApiBase();
  const model = useRegionModel();
  const { clearSurfaceIntentFocus } = model;
  const intent = model.surfaceIntents.activity;
  const binding = useMemo(
    () => ({
      apiBase,
      sessionId: intent?.session,
      focusHint: intent?.focus,
      intentToken: intent?.token,
      onFocusConsumed: () => clearSurfaceIntentFocus('activity'),
    }),
    [apiBase, intent, clearSurfaceIntentFocus],
  );
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
            surfaceTitle={REGION_SURFACE_REGISTRY.get('activity')?.title}
            isDragging={chrome.isDragging}
            onDockSnap={chrome.applyDockSnap}
            availableDockSlotPlacements={chrome.availableDockSlotPlacements}
            effectiveDockSlotPlacement={chrome.effectiveDockSlotPlacement}
            onDockPlacementChange={chrome.commitDockPlacement}
          />
          <div className="dock-slot__body">
            <ActivityWorkspacePaneBindingProvider binding={binding}>
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
