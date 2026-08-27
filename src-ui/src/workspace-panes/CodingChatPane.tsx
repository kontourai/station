import type { WorkspacePaneAvailability } from '@kontourai/station-contracts/workspace-pane-availability';
import { useEffect } from 'react';
import { useNavigation } from '../contexts/NavigationContext';
import { useDockModePreference } from '../hooks/useDockModePreference';
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
  useDockModePreference('coding', 'right');

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
    if (
      paneHostOpen.open(
        instance,
        createFilePreviewPaneStatePreparation(
          window.localStorage,
          instance.stateKey,
          state,
        ),
      )
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
