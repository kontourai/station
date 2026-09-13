/**
 * The pane each dock-capable surface is rendered as inside a region's pane
 * host (#2045, slice 1 of the tabbed dock).
 *
 * A region holds a `WorkspacePaneHost` document (`RegionPaneHost`), and the
 * surfaces placed there are its panes. This inventory is the join between the
 * two vocabularies: a surface id from `REGION_SURFACE_REGISTRY` on one side,
 * the canonical `WorkspacePaneInstance` the host opens for it on the other.
 * Home is absent by design: its only placement is `main`, which is the route
 * outlet, not a pane host (`MainRegionSurface`).
 *
 * Readers, named here so the inventory is never a label nothing derives:
 * `RegionShells` mounts a host only for an occupant with an entry;
 * `RegionPaneHost` builds the region's baseline document from the occupant's
 * entry and admits a persisted or opened pane only when `regionSurfaceOfPane`
 * names the surface occupying the region. `region-surface-panes.test.ts` pins
 * the keys to the registry's dock-capable surfaces in both directions.
 *
 * Kept apart from `region-model.ts` on purpose: the model is pure over ids and
 * imports no pane contract, and this module is what `RegionShells` needs
 * eagerly, so it must stay small — two contract modules, no renderer.
 */

import {
  isCanonicalWorkspaceActivityPaneInstance,
  WORKSPACE_ACTIVITY_PANE_INSTANCE,
} from '@kontourai/station-contracts/workspace-activity-pane';
import {
  createWorkspaceChatPaneInstance,
  isCanonicalWorkspaceChatPaneInstance,
  WORKSPACE_CHAT_PANE_DESCRIPTOR,
} from '@kontourai/station-contracts/workspace-chat-pane';
import type { WorkspacePaneInstance } from '@kontourai/station-contracts/workspace-pane';

export interface RegionSurfacePane {
  surfaceId: string;
  /** The one occurrence the host opens for this surface. */
  instance: WorkspacePaneInstance;
  /**
   * Whether a candidate IS this surface's canonical occurrence — the
   * descriptor's own identity check, so a same-shaped impostor (a Home
   * occurrence under a different instance id, a project-bound Chat) is
   * refused by the contract that defines the pane, not by a copy here.
   */
  isCanonical(instance: WorkspacePaneInstance): boolean;
}

/**
 * The shell has one projectless Chat occurrence; the contract builds it.
 * Throws rather than returning null for the same reason the descriptor itself
 * refuses to parse: the input is a code-owned constant, so a failure is a
 * build that shipped an invalid built-in, not a runtime condition.
 */
function ambientChatPaneInstance(): WorkspacePaneInstance {
  const chat = createWorkspaceChatPaneInstance();
  if (!chat) throw new Error('Invalid built-in ambient Chat pane occurrence');
  return chat;
}

export const REGION_SURFACE_PANES: ReadonlyMap<string, RegionSurfacePane> =
  new Map<string, RegionSurfacePane>([
    [
      'chat',
      {
        surfaceId: 'chat',
        instance: ambientChatPaneInstance(),
        // The predicate the chat-dock host used before it became the region
        // host, unchanged: a persisted project-bound Chat under the same
        // instance id is normalised to the projectless catalog record by
        // `restoreWorkspacePaneHostDocument`'s catalog match, so admission
        // needs no project rule of its own.
        isCanonical: (instance) =>
          instance.descriptorId === WORKSPACE_CHAT_PANE_DESCRIPTOR.id &&
          isCanonicalWorkspaceChatPaneInstance(instance),
      },
    ],
    [
      'activity',
      {
        surfaceId: 'activity',
        instance: WORKSPACE_ACTIVITY_PANE_INSTANCE,
        isCanonical: isCanonicalWorkspaceActivityPaneInstance,
      },
    ],
  ]);

/** The pane a surface renders as in a region host, if it has one. */
export function regionSurfacePane(
  surfaceId: string,
): RegionSurfacePane | undefined {
  return REGION_SURFACE_PANES.get(surfaceId);
}

/**
 * The surface whose canonical pane `instance` is, or null for a pane no
 * region surface owns. The host's admission and its renderer dispatch both
 * fold through this one derivation.
 */
export function regionSurfaceOfPane(
  instance: WorkspacePaneInstance,
): string | null {
  for (const pane of REGION_SURFACE_PANES.values()) {
    if (pane.isCanonical(instance)) return pane.surfaceId;
  }
  return null;
}
