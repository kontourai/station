import type { WorkspacePaneAvailability } from '@kontourai/station-contracts/workspace-pane-availability';
import { useEffect } from 'react';
import { useNavigation } from '../contexts/NavigationContext';
import { useIsMobile } from '../hooks/useIsMobile';
import { BrowserPreviewPaneLauncher } from './BrowserPreviewPaneLauncher';
import { createFilePreviewPaneInstance } from './filePreviewPaneInstance';
import { createFilePreviewPaneStatePreparation } from './filePreviewPaneStateStorage';
import { clearOpenFilePreviewIntent } from './openFilePreviewIntent';
import {
  useWorkspacePaneHostOpenAction,
  type WorkspacePaneHostOpenAction,
} from './WorkspacePaneHostOpenContext';

/**
 * What the Coding layout's Chat position does besides showing Chat, shared by
 * the Coding occurrence's pane (`CodingChatPane`) and the Coding layout's
 * navigation stack (`CodingWorkbench`, whose Chat page replaced that pane in
 * the layout):
 *
 * - on a phone-sized viewport, Chat is the dock, so while the Chat position is
 *   on screen (`ownsMobileDock`) the dock is open and maximized, and closed
 *   again when it leaves;
 * - a one-shot File Preview deep link (`openFilePreviewIntent`) is opened
 *   through the layout's pane host and cleared once the host admits it.
 */
export function useCodingChatPositionEffects({
  projectId,
  projectSlug,
  paneHostOpen,
  ownsMobileDock,
  existingPreviewFor,
  focusExisting,
}: {
  projectId: string;
  projectSlug: string;
  paneHostOpen: WorkspacePaneHostOpenAction | null;
  ownsMobileDock: boolean;
  /**
   * The id of a preview the host already holds for this path, when the
   * host can say (the Coding stack can: its rail names each preview's
   * path). A reloaded or shared URL that names both a preview pane and its
   * intent then shows the one preview rather than opening a second.
   */
  existingPreviewFor?: (path: string) => string | null;
  /** Shows that existing preview, in the host's own way. */
  focusExisting?: (instanceId: string) => void;
}) {
  const isMobile = useIsMobile();
  const {
    openFilePreviewIntent,
    openFilePreviewIntentFrom,
    setDockState,
    updateParams,
  } = useNavigation();

  useEffect(() => {
    if (!isMobile || !ownsMobileDock) return;
    setDockState(true, true);
    return () => setDockState(false, false);
  }, [isMobile, ownsMobileDock, setDockState]);

  useEffect(() => {
    if (!openFilePreviewIntent || !paneHostOpen) return;
    // The Files pane's own row write: it opens its own preview, whichever
    // page or panel it is on.
    if (openFilePreviewIntentFrom === 'pane') return;
    const existing = existingPreviewFor?.(openFilePreviewIntent.path) ?? null;
    if (existing && focusExisting) {
      focusExisting(existing);
      updateParams(clearOpenFilePreviewIntent());
      return;
    }
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
    // hook's owners have no notice slot to put it in, so a sentence here would
    // be a new surface invented at a refusal site. The intent also survives in
    // the URL, so the deep link is retried rather than lost. Giving this a
    // voice means giving the Coding Chat position a notice region first; that
    // is a separate change.
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
    existingPreviewFor,
    focusExisting,
    openFilePreviewIntent,
    openFilePreviewIntentFrom,
    paneHostOpen,
    projectId,
    projectSlug,
    updateParams,
  ]);
}

/**
 * The Coding occurrence's pane. The built-in Coding layout no longer places
 * it — its Chat page is `CodingWorkbench`'s — but the occurrence is still a
 * catalog pane, so a host that does render it keeps the behaviour it always
 * had: the Chat position's effects above, plus the Browser Preview launcher.
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
  const paneHostOpen = useWorkspacePaneHostOpenAction();
  useCodingChatPositionEffects({
    projectId,
    projectSlug,
    paneHostOpen,
    ownsMobileDock: true,
  });

  return browserPreviewAvailability ? (
    <BrowserPreviewPaneLauncher
      projectId={projectId}
      projectSlug={projectSlug}
      host={paneHostOpen}
      availability={browserPreviewAvailability}
    />
  ) : null;
}
