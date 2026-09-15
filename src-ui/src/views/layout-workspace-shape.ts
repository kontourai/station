import type { AgentId } from '@kontourai/station-contracts/agent-identity';
import type { LayoutPaneReferences } from '@kontourai/station-contracts/layout';

/**
 * The one `LayoutConfig` → workspace-shape derivation (#2062).
 *
 * `LayoutRenderer` (`src-ui/src/layouts/index.tsx`) renders a workspace shape,
 * not a stored `LayoutConfig`: the stored record keeps its panes under
 * `config`, and the renderer wants tabs, actions and skills at the top level.
 * That translation lived inline in `LayoutView` while a project was the only
 * thing that could own a Layout. A Board is a Layout too, so it has to reach
 * the renderer through the same translation — copying it into a second host
 * is exactly how one renderer becomes two that drift.
 *
 * What stays with the CALLER is everything that needs to know who owns the
 * Layout: annotating an agent reference as unavailable is defined in terms of
 * a project's agent filter, and the plugin-host action rewriting is a project
 * workspace-pane-host concern. They arrive as functions, so this module holds
 * the shape and nothing about ownership.
 */

/** An action or skill as stored on a layout's tab. */
interface LayoutActionLike {
  label: string;
  agent?: AgentId;
  [key: string]: unknown;
}

export interface LayoutWorkspaceShapeOptions {
  /**
   * Rewrites an action/skill whose `agent` is not available where this Layout
   * is being rendered. Identity for a host with no project to filter against.
   */
  annotateAgentRef: <T extends LayoutActionLike>(item: T) => T;
  /**
   * Rewrites a plugin-contributed global action for a host that owns the
   * global action bar itself. Identity for a host that does not.
   */
  reviewPluginAction: <T extends { label: string }>(item: T) => T;
  /**
   * When true the host renders the layout's global actions and skills in its
   * own chrome, so the shape must not carry them too — they would render
   * twice, in two places, from one declaration.
   */
  hostOwnsGlobalActions: boolean;
}

/** The subset of a stored Layout this derivation reads. */
export interface LayoutWorkspaceSource {
  slug: string;
  name: string;
  icon?: string;
  description?: string;
  config?: Record<string, any> | null;
  /**
   * The read verdict this response carried (#2090), if any. Response-only:
   * it is never part of the stored record, and the tabs below take their
   * `unavailable` flag from THIS and never from a stored tab field, so a
   * value somebody persisted into `config.tabs` cannot forge one.
   */
  paneReferences?: LayoutPaneReferences;
}

/**
 * Build the workspace shape `LayoutRenderer` takes, or `null` when there is
 * no Layout yet (still loading, or missing).
 */
export function layoutWorkspaceShape(
  layoutData: LayoutWorkspaceSource | null | undefined,
  options: LayoutWorkspaceShapeOptions,
) {
  if (!layoutData) return null;
  const { annotateAgentRef, reviewPluginAction, hostOwnsGlobalActions } =
    options;
  // #2090 — the one place a layout tab learns it cannot be shown. Both hosts
  // reach `LayoutRenderer` through here, so the project Layout and the Board
  // get the same branch rather than two that drift.
  const unavailableTabIds = new Set(
    layoutData.paneReferences?.unavailableTabIds ?? [],
  );
  return {
    slug: layoutData.slug,
    name: layoutData.name,
    icon: layoutData.icon,
    description: layoutData.description,
    tabs: (layoutData.config?.tabs ?? []).map((t: any) => ({
      id: t.id,
      label: t.label,
      component: t.component,
      icon: t.icon,
      description: t.description,
      actions: (t.actions ?? []).map(annotateAgentRef).map(reviewPluginAction),
      skills: (t.skills ?? []).map(annotateAgentRef).map(reviewPluginAction),
      unavailable: unavailableTabIds.has(t.id),
    })),
    globalSkills: (hostOwnsGlobalActions
      ? []
      : (layoutData.config?.globalSkills ?? [])
    ).map(annotateAgentRef),
    actions: hostOwnsGlobalActions
      ? []
      : layoutData.config?.actions?.map(annotateAgentRef),
    defaultAgent: layoutData.config?.defaultAgent,
    availableAgents: layoutData.config?.availableAgents,
    // Host-owned, read-only metadata used by the builtin standard-view
    // fallback. It never authorizes a Kit action or interprets Kit code.
    kit: layoutData.config?.kit,
  };
}
