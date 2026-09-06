import type { WorkspacePaneAvailability } from '@kontourai/station-contracts/workspace-pane-availability';
import { useEffect } from 'react';
import { useNavigation } from '../contexts/NavigationContext';
import { useIsMobile } from '../hooks/useIsMobile';
import { BrowserPreviewPaneLauncher } from './BrowserPreviewPaneLauncher';
import { createFilePreviewPaneInstance } from './filePreviewPaneInstance';
import { createFilePreviewPaneStatePreparation } from './filePreviewPaneStateStorage';
import { clearOpenFilePreviewIntent } from './openFilePreviewIntent';
import { useWorkspacePaneHostOpenAction } from './WorkspacePaneHostOpenContext';

/**
 * Coding's chat composition lives in the app dock. WorkspacePaneHost owns
 * every Coding surface's placement; this pane only selects the existing chat
 * behavior when its catalog-admitted occurrence is active.
 */
export function CodingChatPane({
  projectId,
  projectSlug,
  browserPreviewAvailability,
}: {
  projectId: string;
  projectSlug: string;
  browserPreviewAvailability?: WorkspacePaneAvailability;
}) {
  const isMobile = useIsMobile();
  const { openFilePreviewIntent, setDockState, updateParams } = useNavigation();
  const paneHostOpen = useWorkspacePaneHostOpenAction();

  useEffect(() => {
    if (!isMobile) return;
    setDockState(true, true);
    return () => setDockState(false, false);
  }, [isMobile, setDockState]);

  useEffect(() => {
    if (!openFilePreviewIntent || !paneHostOpen) return;
    const state = {
      version: '1.0' as const,
      projectSlug,
      path: openFilePreviewIntent.path,
      ...(openFilePreviewIntent.lineRange
        ? { lineRange: openFilePreviewIntent.lineRange }
        : {}),
      wrap: true,
    };
    const instance = createFilePreviewPaneInstance(state, projectId);
    if (!instance) return;
    // #1596: a refused deep link is left unreported ON PURPOSE, and this is the
    // one place in the change where a reason is available and not shown. This
    // component has no notice slot to put it in — it renders the Browser
    // Preview launcher or literally nothing, so a sentence here would be a new
    // surface invented at a refusal site, in a pane whose own job is to select
    // existing chat behaviour. The intent also survives in the URL, so the
    // deep link is retried rather than lost. Giving this a voice means giving
    // the Coding chat pane a notice region first; that is a separate change.
    if (
      paneHostOpen.open(
        instance,
        createFilePreviewPaneStatePreparation(
          window.localStorage,
          instance.stateKey,
          state,
        ),
      ).ok
    ) {
      updateParams(clearOpenFilePreviewIntent());
    }
  }, [
    openFilePreviewIntent,
    paneHostOpen,
    projectId,
    projectSlug,
    updateParams,
  ]);

  return browserPreviewAvailability ? (
    <BrowserPreviewPaneLauncher
      projectId={projectId}
      host={paneHostOpen}
      availability={browserPreviewAvailability}
    />
  ) : null;
}
