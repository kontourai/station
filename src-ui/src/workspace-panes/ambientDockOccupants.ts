import {
  isCanonicalWorkspaceActivityPaneInstance,
  WORKSPACE_ACTIVITY_PANE_DESCRIPTOR,
  WORKSPACE_ACTIVITY_PANE_INSTANCE,
} from '@kontourai/station-contracts/workspace-activity-pane';
import {
  createWorkspaceChatPaneInstance,
  isCanonicalWorkspaceChatPaneInstance,
  WORKSPACE_CHAT_PANE_DESCRIPTOR,
} from '@kontourai/station-contracts/workspace-chat-pane';
import {
  isCanonicalWorkspaceHomePaneInstance,
  WORKSPACE_HOME_PANE_DESCRIPTOR,
  WORKSPACE_HOME_PANE_INSTANCE,
} from '@kontourai/station-contracts/workspace-home-pane';
import {
  type WorkspacePaneDescriptor,
  type WorkspacePaneInstance,
  workspacePaneModesSatisfiableBy,
} from '@kontourai/station-contracts/workspace-pane';
import { workspacePaneHostSuppliableContexts } from '@kontourai/station-contracts/workspace-pane-host';

/**
 * The panes the ambient host can RENDER, which is the one per-pane fact
 * admission cannot derive: each entry names the exact canonical-occurrence
 * check its `renderPane` branch performs, and the canonical occurrence the
 * occupant picker offers. Everything else about admission IS derived — see
 * `ambientDockDescriptorFor`.
 *
 * This module (not `AmbientChatDockPaneHost.tsx`) owns the table so the
 * occupant picker can consume the same derivation without a module cycle;
 * both live in the ambient host's lazy chunk.
 *
 * That claim is load-bearing, not decorative (station#4460 review M4): a
 * prior version of the occupant-picker fix let `ChatDockHeader.tsx` — part
 * of the EAGER entry path via `ChatDock.tsx` → `App.tsx` — import
 * `DockOccupantPicker` directly, which dragged this module (and all three
 * pane-descriptor contracts packages it imports) out of the lazy chunk and
 * into the entry bundle (+2554B gzip, measured). The fix is structural, not
 * just "don't do that": `AmbientChatDockPaneHost.tsx` builds the picker
 * element itself and hands `ChatDockHeader` an already-rendered
 * `ReactNode`, so nothing outside this lazy chunk can import
 * `DockOccupantPicker` or this table without a component signature change
 * that a reviewer would actually see.
 */
export const AMBIENT_DOCK_RENDERABLE_PANES: readonly {
  descriptor: WorkspacePaneDescriptor;
  isCanonicalInstance(instance: WorkspacePaneInstance): boolean;
  canonicalInstance(): WorkspacePaneInstance;
}[] = [
  {
    descriptor: WORKSPACE_CHAT_PANE_DESCRIPTOR,
    isCanonicalInstance: isCanonicalWorkspaceChatPaneInstance,
    // Non-null assertion for the same reason `createAmbientChatDockPaneDocument`
    // throws: both inputs are code-owned constants, so a failure is a build
    // that shipped an invalid built-in, not a runtime condition.
    canonicalInstance: () => createWorkspaceChatPaneInstance()!,
  },
  {
    descriptor: WORKSPACE_HOME_PANE_DESCRIPTOR,
    isCanonicalInstance: isCanonicalWorkspaceHomePaneInstance,
    canonicalInstance: () => WORKSPACE_HOME_PANE_INSTANCE,
  },
  {
    descriptor: WORKSPACE_ACTIVITY_PANE_DESCRIPTOR,
    isCanonicalInstance: isCanonicalWorkspaceActivityPaneInstance,
    canonicalInstance: () => WORKSPACE_ACTIVITY_PANE_INSTANCE,
  },
];

/**
 * The one admission derivation for the ambient slot, shared by the dock
 * action, the restore path, the render table's occupant lookup and the
 * occupant picker's list: the occurrence must be the CANONICAL one of a pane
 * this host can render, and that pane's declared modes must be satisfiable by
 * the ambient scope — the SAME `workspacePaneModesSatisfiableBy` fold the
 * offered dock action runs. Until M3 the admission was a hand-written
 * chat-or-home union beside that fold: a list that had to be edited per pane,
 * and whose edit could disagree with what the action offered (the
 * label-vs-derivation shape). Now a pane added to the render table without a
 * requirement-free mode stays refused here, because admission derives instead
 * of enumerating.
 */
export function ambientDockDescriptorFor(
  instance: WorkspacePaneInstance,
): WorkspacePaneDescriptor | null {
  for (const pane of AMBIENT_DOCK_RENDERABLE_PANES) {
    if (instance.descriptorId !== pane.descriptor.id) continue;
    if (!pane.isCanonicalInstance(instance)) return null;
    if (
      workspacePaneModesSatisfiableBy(
        pane.descriptor,
        workspacePaneHostSuppliableContexts({ kind: 'ambient' }),
      ).length === 0
    )
      return null;
    return pane.descriptor;
  }
  return null;
}

/**
 * The occupant picker's list — every pane `ambientDockDescriptorFor` admits,
 * paired with the canonical occurrence choosing it would place. A DERIVATION
 * over the render table and the admission fold, never a curated array: a pane
 * that joins the table with an ambient-satisfiable mode appears here without
 * a second edit, and one that loses its requirement-free mode drops out of
 * the menu the moment admission would refuse it.
 */
export function ambientDockOccupantChoices(): readonly {
  descriptor: WorkspacePaneDescriptor;
  instance: WorkspacePaneInstance;
}[] {
  return AMBIENT_DOCK_RENDERABLE_PANES.flatMap((pane) => {
    const instance = pane.canonicalInstance();
    return ambientDockDescriptorFor(instance)
      ? [{ descriptor: pane.descriptor, instance }]
      : [];
  });
}
