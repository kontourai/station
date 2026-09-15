/**
 * What a stored Layout's own tabs may be shown to the CALLER reading it
 * (#2090), and what a layout read must withhold about the plugin those tabs
 * belong to (#2103).
 *
 * ## Why this exists at all
 *
 * #2067 projected DISCOVERY: `GET /api/projects/:slug/panes` drops a hidden
 * plugin's panes, so nobody composes a layout from a pane they cannot see.
 * It left REFERENCE unanswered — a layout that ALREADY names such a pane.
 * The layout host never reads the Pane catalogue at all (a plugin-provenance
 * layout dispatches to `LayoutView` → `layoutWorkspaceShape` →
 * `LayoutRenderer`, which resolves each tab against the client plugin
 * registry only), so there was no seam between a saved layout's tabs and any
 * availability verdict. This module is that seam, and both layout read
 * routes — the project's and the Board's — consult it.
 *
 * ## The verdict is deliberately NOT a `WorkspacePaneAvailability`
 *
 * `workspace-pane-catalog.ts` records the precedent: a pane whose subject is
 * not here gets no availability sentence at all. Reusing
 * `pane-not-available-to-viewer` would stamp `source: 'visibility'` on this,
 * and its presentation string names an operator and an action
 * (`workspacePaneAvailabilityPresentation.ts`). Neither is derivable here:
 * this verdict cannot tell a plugin that is HIDDEN from one that was NEVER
 * INSTALLED, because {@link PluginVisibilityService.canSee} answers `false`
 * for both — which is exactly what makes the read stop being an existence
 * oracle. A reason code asserting a cause would re-arm it.
 *
 * So the wire verdict carries NO reason, NO source, and NO action: only
 * which of this layout's own tabs cannot be shown. The one causeless
 * sentence a reader sees is client-side copy
 * (`src-ui/src/layouts/index.tsx`).
 *
 * ## Absence is not a verdict
 *
 * Every entry point takes `canSeePlugin` as OPTIONAL and emits nothing when
 * it is absent — the same convention the Pane catalogue and
 * `projectLayoutCatalogItems` use. A composition that forgot to wire the
 * projection must render exactly as it did before, not hide every plugin
 * layout from every caller.
 *
 * ## Presence of the verdict means the binding was withheld
 *
 * {@link resolveLayoutPaneReferences} emits a verdict whenever the owning
 * plugin is withheld, INCLUDING when the layout has no tabs, so the verdict's
 * presence and {@link withoutPluginBinding}'s stripping stay in lockstep.
 * The client dispatch depends on that: `resolveProjectLayoutRendererKind`
 * routes a contributed layout to `LayoutView` by reading `config.plugin` /
 * `catalogContribution`, and this module removes both. Without the verdict as
 * the replacement signal, a withheld plugin layout whose `type` happens to
 * name a built-in host would dispatch to that host instead. (Spelled this
 * way on purpose: `coding-composition-inventory-gate.mjs` reads source text,
 * and naming the type literally here would enrol a module with no Coding
 * dependency into that inventory.)
 */
import type { LayoutPaneReferences } from '@kontourai/station-contracts/layout';

/** The subset of a stored Layout every function here reads. */
export interface LayoutPluginBindingSource {
  config?: Record<string, unknown> | null;
  catalogContribution?: {
    provenance: { origin: string; pluginId?: string };
  };
}

export interface LayoutPaneReferenceOptions {
  /**
   * Whether the request's own caller may see a named plugin (#2067).
   * Absent means this composition has no caller to project onto: nothing is
   * withheld and no verdict is emitted.
   */
  canSeePlugin?: (pluginId: string) => boolean;
}

/**
 * The plugin a stored layout's panes belong to, or `undefined`.
 *
 * Catalog attribution first, because it is SERVER-ISSUED — stripped from
 * client bodies on create and copied from the stored record on update — and
 * `config.plugin` second, because it is the older reference and a caller can
 * write it. A Kit layout carries `config.kit.contributionRef` and no
 * `config.plugin`, so it answers `undefined` and falls into the
 * emit-nothing path.
 */
export function layoutOwningPluginId(
  layout: LayoutPluginBindingSource,
): string | undefined {
  const contribution = layout.catalogContribution;
  if (contribution?.provenance.origin === 'plugin') {
    return contribution.provenance.pluginId;
  }
  const declared = layout.config?.plugin;
  return typeof declared === 'string' && declared.length > 0
    ? declared
    : undefined;
}

/**
 * True when this caller may not be told anything the server derives about
 * the layout's owning plugin.
 *
 * The SAME answer for a plugin that is installed-but-hidden and for a name
 * nobody ever installed, by construction: `canSeePlugin` is
 * `PluginVisibilityService.canSee`, which reads a grant list rather than the
 * install tree.
 */
export function layoutPluginBindingWithheld(
  layout: LayoutPluginBindingSource,
  options: LayoutPaneReferenceOptions,
): boolean {
  const { canSeePlugin } = options;
  if (!canSeePlugin) return false;
  const pluginId = layoutOwningPluginId(layout);
  if (pluginId === undefined) return false;
  return !canSeePlugin(pluginId);
}

/** The ids of a stored layout's tabs, in order, skipping malformed entries. */
function layoutTabIds(layout: LayoutPluginBindingSource): string[] {
  const tabs = layout.config?.tabs;
  if (!Array.isArray(tabs)) return [];
  return tabs.flatMap((tab) => {
    const id = (tab as { id?: unknown } | null)?.id;
    return typeof id === 'string' && id.length > 0 ? [id] : [];
  });
}

/**
 * The per-tab verdict a layout READ attaches, or `undefined` when there is
 * nothing to say — in which case the response is byte-identical to what it
 * was before this existed.
 *
 * Keyed on `tab.id`, never on a minted Workspace Pane descriptor id: that id
 * is `pane:` plus the encoded plugin id plus the layout slug plus the tab id
 * (`workspace-pane-layout-adapter-helpers.ts`), so putting it on the wire
 * would leak the name this change withholds.
 */
export function resolveLayoutPaneReferences(
  layout: LayoutPluginBindingSource,
  options: LayoutPaneReferenceOptions,
): LayoutPaneReferences | undefined {
  if (!layoutPluginBindingWithheld(layout, options)) return undefined;
  return { unavailableTabIds: layoutTabIds(layout) };
}

/**
 * The layout with everything that NAMES its owning plugin removed.
 *
 * `catalogContribution` carries the plugin's id, its version and its
 * `plugins/<name>` source identity. `config.plugin` carries the name.
 * `config.actions` and `config.globalSkills` are the plugin's own global
 * surface: `LayoutView` suppresses them today precisely BECAUSE
 * `config.plugin` is present (`hostOwnsGlobalActions`), so removing the name
 * without removing them would start rendering a hidden plugin's saved
 * actions in the layout header.
 *
 * `config.tabs` stays. It is the project's own stored record, written when
 * somebody who could see the plugin applied it, and the per-tab verdict
 * above is keyed on those ids. What does NOT stay is anything read LIVE from
 * the plugin on this request — the caller of this function skips that read.
 */
export function withoutPluginBinding<T extends LayoutPluginBindingSource>(
  layout: T,
): T {
  const { catalogContribution: _catalogContribution, ...withoutContribution } =
    layout;
  const {
    plugin: _plugin,
    actions: _actions,
    globalSkills: _globalSkills,
    ...config
  } = layout.config ?? {};
  return { ...withoutContribution, config } as T;
}
