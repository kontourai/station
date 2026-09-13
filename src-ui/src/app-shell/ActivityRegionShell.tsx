import {
  WORKSPACE_ACTIVITY_PANE_DESCRIPTOR,
  WORKSPACE_ACTIVITY_PANE_INSTANCE,
} from '@kontourai/station-contracts/workspace-activity-pane';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChatDockHeader } from '../components/chat-dock/ChatDockHeader';
import { LazyBoundary } from '../components/LazyBoundary';
import { PageFrame, type PageFrameSpec } from '../components/page-frame';
import { SkeletonBlock } from '../components/Skeleton';
import { useApiBase } from '../contexts/ApiBaseContext';
import {
  type SurfaceIntentRecord,
  useRegionModel,
} from '../contexts/RegionModelContext';
import type { DockShellChrome } from '../hooks/useDockShellChrome';
import { REGION_SURFACE_REGISTRY } from '../regions/region-model';
import {
  type ActivityWorkspacePaneBinding,
  ActivityWorkspacePaneBindingProvider,
} from '../views/activity/ActivityWorkspacePaneBinding';

const loadActivityWorkspacePane = () =>
  import('../views/activity/ActivityWorkspacePane').then(
    ({ ActivityWorkspacePane }) => ({ default: ActivityWorkspacePane }),
  );

/**
 * Activity in `main` (#928 C2a): the sessions surface is a split pane, so it
 * takes the same frame the retired `/activity` route had (`SPLIT_PANE` in
 * `page-frame-registry.ts`), with the surface's registered title. No dock
 * chrome — there is no region to hide, resize or move.
 */
const ACTIVITY_MAIN_FRAME: PageFrameSpec = {
  title: REGION_SURFACE_REGISTRY.get('activity')?.title,
  width: 'full',
  body: 'fill',
  flush: true,
};

/**
 * Takes delivery of Activity's surface intent and hands it to the pane as its
 * binding. Shared by both Activity placements — `main`'s page and a dock
 * region's pane — because the intent outbox does not care which one is
 * mounted, only that exactly one placement takes each record.
 *
 * A surface intent is a one-shot instruction, so the record proving it was
 * delivered has to outlive whoever acted on it. The placement unmounts
 * whenever another surface folds in front of it (bottom-only devices) or the
 * host itself goes away (a Chat workspace layout owns the whole view), and
 * every consumption record downstream of here — including `SessionsView`'s
 * `routedIntentTokenRef` — dies with that unmount. The model's record does
 * not, so the next mount used to read the SAME instruction as new and reopen
 * a session nobody asked for (#928).
 *
 * So the mount TAKES the record out of the model and keeps its own copy: the
 * model's slot is an outbox, and the take is the consumption record that
 * survives. The local copy is what keeps this mount's delivery standing after
 * the take — deleting the record without it would yank `sessionId` back out
 * from under the pane and deselect the session that was just routed to. It
 * is deliberately NOT a remembered selection: it dies with the placement, so
 * a later generic reveal opens Activity as Activity. Within one mount the
 * selection is remembered where it always was, in the sessions surface's own
 * state.
 */
function useActivitySurfaceIntent(): ActivityWorkspacePaneBinding {
  const { apiBase } = useApiBase();
  const model = useRegionModel();
  const { consumeSurfaceIntent } = model;
  const offered = model.surfaceIntents.activity;
  const [intent, setIntent] = useState<SurfaceIntentRecord | undefined>(
    undefined,
  );
  useEffect(() => {
    if (!offered) return;
    setIntent(offered);
    consumeSurfaceIntent('activity', offered.token);
  }, [offered, consumeSurfaceIntent]);
  // The routed `focus` is one-shot within the delivered intent, and the
  // session it named is not: clearing it here is what lets a second
  // `focus=evidence` for the same session read as a new instruction without
  // dropping the selection.
  const clearIntentFocus = useCallback(() => {
    setIntent((current) =>
      current?.focus ? { ...current, focus: undefined } : current,
    );
  }, []);
  return useMemo(
    () => ({
      apiBase,
      sessionId: intent?.session,
      focusHint: intent?.focus,
      intentToken: intent?.token,
      onFocusConsumed: clearIntentFocus,
    }),
    [apiBase, intent, clearIntentFocus],
  );
}

/** The Activity pane with its intent binding: what both placements render. */
function ActivityPane() {
  const binding = useActivitySurfaceIntent();
  return (
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
  );
}

/**
 * Activity as the `main` region's occupant: the route outlet's renderer for
 * it (`MainRegionSurface`). Dock regions do not come here — since #2045 they
 * render Activity as a pane of the region's host (`ActivityDockPane`, below,
 * through `RegionPaneHost`), so this shell is the primary area's alone and
 * mounts no dock chrome.
 */
export function ActivityRegionShell(_props: { regionId: 'main' }) {
  return (
    <PageFrame spec={ACTIVITY_MAIN_FRAME} routeIdentity="region:main:activity">
      <ActivityPane />
    </PageFrame>
  );
}

/**
 * Activity as a pane of a dock region's host (#2045): the shared dock header
 * — the SAME `ChatDockHeader` Chat's pane renders, driven by the chrome the
 * region's `DockShell` hands down — over the pane inside `.dock-slot__body`,
 * the one scroll container every non-Chat dock occupant renders in
 * (archive#4460, pinned by `ActivityRegionShell.dock-body.test.tsx`).
 */
export function ActivityDockPane({ chrome }: { chrome: DockShellChrome }) {
  return (
    <>
      <ChatDockHeader
        regionVisible={chrome.isDockOpen}
        shellMaximized={chrome.isDockMaximized}
        canMaximize={chrome.canMaximize}
        showMaximizeShortcut={chrome.ownsMaximizeShortcut}
        restoreSnap={chrome.dockSnap}
        surfaceShortcutId={chrome.surfaceShortcutId}
        // From the chrome, which derives it from the region's occupant —
        // one derivation for every shell's visibility name (#1386).
        surfaceTitle={chrome.surfaceTitle}
        isDragging={chrome.isDragging}
        onDockSnap={chrome.applyDockSnap}
        availableDockSlotPlacements={chrome.availableDockSlotPlacements}
        effectiveDockSlotPlacement={chrome.effectiveDockSlotPlacement}
        onDockPlacementChange={chrome.commitDockPlacement}
      />
      <div className="dock-slot__body">
        <ActivityPane />
      </div>
    </>
  );
}
