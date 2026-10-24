import type {
  WorkspacePaneDescriptor,
  WorkspacePaneInstance,
} from '@kontourai/station-contracts/workspace-pane';
import type { WorkspacePaneAvailability } from '@kontourai/station-contracts/workspace-pane-availability';
import type { ReactNode } from 'react';
import type { ResolvedWorkspacePaneCatalogEntry } from '../workspace-panes/resolvedWorkspacePaneCatalog';
import { isWorkspacePaneInstanceOwnedByProject } from '../workspace-panes/workspacePaneHostAdmission';

/**
 * What the stack host (`LayoutStackHost`) pushes for one layout: its own
 * drill-ins, already bound to the layout, and the few presentation facts
 * that depend on which panes they are.
 */
export interface LayoutStackDrillIns {
  /** The layout's own drill-ins, bound to it, in document order. */
  readonly instances: readonly WorkspacePaneInstance[];
  /** Drawn in the lower panel past the wide fold (Coding's Terminal). */
  readonly terminal?: WorkspacePaneInstance;
  /** A pane's descriptor when its catalog entry is not found by occurrence. */
  descriptorFor(descriptorId: string): WorkspacePaneDescriptor | null;
  /** The descriptor whose built-in renderer receives the instance itself. */
  readonly occurrenceDescriptorId?: string;
  /** The rail's "Open Browser" launcher, when the layout offers it. */
  readonly browserPreviewAvailability?: WorkspacePaneAvailability;
  /** Receipts and partial-availability notices drawn with the drill-in page. */
  readonly notices?: ReactNode;
}

/**
 * The host cannot mount yet; only the Chat page renders, with this notice.
 */
export type LayoutStackDrillInOutcome =
  | { readonly state: 'ready'; readonly drillIns: LayoutStackDrillIns }
  | { readonly state: 'blocked'; readonly notice: ReactNode };

/**
 * The drill-ins of a layout that declares them (`drillIns`), resolved
 * through the ordinary pane catalog (#2995): each id is the descriptor of a
 * Project-issued occurrence, which the host shows whatever its availability
 * — an unavailable pane explains itself on its page. An id the catalog does
 * not issue for this Project (a disabled plugin, a hidden one) is simply not
 * on the rail. Nothing here grants a pane: the catalog's verdict stands.
 * `null` when an issued occurrence cannot be bound to the layout.
 */
export function resolveDeclaredStackDrillIns({
  entries,
  projectId,
  drillIns,
  bind,
}: {
  entries: readonly ResolvedWorkspacePaneCatalogEntry[];
  projectId: string;
  drillIns: readonly string[];
  bind(instance: WorkspacePaneInstance): WorkspacePaneInstance | null;
}): LayoutStackDrillIns | null {
  const instances: WorkspacePaneInstance[] = [];
  for (const descriptorId of drillIns) {
    const entry = entries.find(
      (candidate) =>
        candidate.descriptor.id === descriptorId &&
        candidate.instance !== undefined &&
        isWorkspacePaneInstanceOwnedByProject(candidate.instance, projectId),
    );
    if (!entry?.instance) continue;
    const bound = bind(entry.instance);
    // An occurrence that cannot be bound to this layout is not shown
    // half-bound: the host reports it cannot mount.
    if (!bound) return null;
    instances.push(bound);
  }
  return {
    instances,
    descriptorFor: (descriptorId) =>
      entries.find((candidate) => candidate.descriptor.id === descriptorId)
        ?.descriptor ?? null,
  };
}
