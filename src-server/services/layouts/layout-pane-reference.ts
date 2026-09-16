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
    sourceIdentity?: { id?: string };
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
 * EVERY plugin name a layout response derives from — not one owning id.
 *
 * ## Why this is a set, and why the first version of it was a hole
 *
 * The first version answered ONE id, preferring
 * `catalogContribution.provenance.pluginId` because it is server-issued.
 * That trusted the server-issued field to speak for a caller-writable one:
 * the live merge on the read route is keyed on `config.plugin`, so when the
 * two disagree the gate decided about the contribution while the merge read
 * the config. A member who can see ANY plugin could apply that plugin's
 * layout (apply is the only writer of the contribution, and is available to
 * members), then `PUT` a body whose `config.plugin` names a guess: the
 * decision, computed from the stored record's contribution, said "visible",
 * nothing was restored, `config` was replaced wholesale, and the next `GET`
 * merged the guess and answered with the hidden plugin's live tabs. That is
 * the enumeration oracle #2103 exists to close, reproduced by review.
 *
 * So the rule is: the decision is computed over every name the RESPONSE can
 * derive from, and it fails closed if ANY of them is not visible. The merge
 * key (`config.plugin`) and the contribution's two names (`provenance
 * .pluginId` and `sourceIdentity.id`, both emitted in the response; the
 * latter is the BARE plugin name — it is `sourceIdentity.source` beside it
 * that reads `plugins/<name>`) are all in that set. Do not "correct" this to
 * compare against a `plugins/`-prefixed value: the visibility grant list is
 * keyed on bare names, so a prefixed lookup would miss every grant and
 * withhold every plugin layout from everyone, the operator included.
 *
 * A plugin-origin contribution that names NO plugin at all is reported as
 * {@link LayoutPluginReferences.unattributed}, and its callers treat that as
 * withheld. Not route-reachable today, but a gate that fails open on a
 * malformed record is the wrong default in this family.
 */
export interface LayoutPluginReferences {
  /** Distinct plugin names, in no meaningful order. */
  readonly pluginIds: readonly string[];
  /** A `plugin`-origin contribution carrying no usable name. */
  readonly unattributed: boolean;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function layoutReferencedPluginIds(
  layout: LayoutPluginBindingSource,
): LayoutPluginReferences {
  const pluginIds = new Set<string>();
  let unattributed = false;

  // The merge key. A caller can write it, which is exactly why it is read
  // here rather than inferred from the contribution beside it.
  const declared = layout.config?.plugin;
  if (nonEmpty(declared)) pluginIds.add(declared);

  const contribution = layout.catalogContribution;
  if (contribution?.provenance.origin === 'plugin') {
    const attributions = [
      contribution.provenance.pluginId,
      contribution.sourceIdentity?.id,
    ].filter(nonEmpty);
    if (attributions.length === 0) unattributed = true;
    for (const id of attributions) pluginIds.add(id);
  }

  return { pluginIds: [...pluginIds], unattributed };
}

/**
 * True when this caller may not be told anything the server derives about
 * any plugin this layout names.
 *
 * The SAME answer for a plugin that is installed-but-hidden and for a name
 * nobody ever installed, by construction: `canSeePlugin` is
 * `PluginVisibilityService.canSee`, which reads a grant list rather than the
 * install tree.
 *
 * A Kit layout carries `config.kit.contributionRef` and no `config.plugin`,
 * so it names nothing and falls into the emit-nothing path.
 */
export function layoutPluginBindingWithheld(
  layout: LayoutPluginBindingSource,
  options: LayoutPaneReferenceOptions,
): boolean {
  const { canSeePlugin } = options;
  if (!canSeePlugin) return false;
  const { pluginIds, unattributed } = layoutReferencedPluginIds(layout);
  if (unattributed) return true;
  return pluginIds.some((pluginId) => !canSeePlugin(pluginId));
}

/**
 * The ids of the tabs a withheld binding can actually be about.
 *
 * NOT every tab. A tab whose `component` is `{kind: 'builtin-component'}` or
 * `{kind: 'mcp-tool-ui'}` is by construction not owned by a plugin, and a
 * Board legitimately mixes those with plugin ones — marking them unavailable
 * would blank tabs the derivation never showed were plugin-owned. A bare
 * string normalizes to a plugin component (`normalizeLayoutComponentRef`),
 * so it counts, as does an explicit `plugin-component`.
 *
 * It remains an over-approximation within that set: the server cannot tell
 * WHICH plugin a component id belongs to, because those ids are
 * plugin-author-chosen with no namespacing requirement. A layout naming
 * components from two plugins, one visible and one not, marks both. Telling
 * them apart would mean resolving a component id against the install tree,
 * which is the existence oracle this whole change closes.
 */
function withheldTabIds(layout: LayoutPluginBindingSource): string[] {
  const tabs = layout.config?.tabs;
  if (!Array.isArray(tabs)) return [];
  return tabs.flatMap((tab) => {
    const entry = tab as { id?: unknown; component?: unknown } | null;
    const id = entry?.id;
    if (typeof id !== 'string' || id.length === 0) return [];
    const component = entry?.component;
    if (typeof component === 'string') return [id];
    if (component === undefined || component === null) return [id];
    const kind = (component as { kind?: unknown }).kind;
    return kind === undefined || kind === 'plugin-component' ? [id] : [];
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
  return { unavailableTabIds: withheldTabIds(layout) };
}

/**
 * The `config` keys a withheld read removes — the ONE list, shared with
 * {@link withPluginBindingRestored} so the strip and the restore cannot
 * drift apart.
 */
const WITHHELD_CONFIG_KEYS = ['plugin', 'actions', 'globalSkills'] as const;

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
 *
 * ## The residual, stated plainly
 *
 * A withheld response TYPICALLY STILL SPELLS THE PLUGIN'S NAME, and anyone
 * reading this should not believe otherwise:
 *
 *  - stored tab `component` ids, which real plugins namespace by convention
 *    (`survey-review-workbench-main`, `fieldwork-review-main`);
 *  - the layout `name`, which the catalog parser falls back from the
 *    layout's own to `manifest.displayName` and finally to the PLUGIN NAME
 *    (`distribution-profile-service.ts`), and `description` likewise to the
 *    manifest's — apply persists both and this function removes neither;
 *  - the layout `slug`, which is plugin-authored and IS the route address,
 *    so it cannot be withheld at all.
 *
 * What this closes is the ENUMERATION question: whether a plugin the caller
 * NAMES is installed here. It does not make a project's own applied layout
 * anonymous to that project's members, and it is not written as though it
 * does. `pane-visibility.routes.test.ts` asserts the withheld FIELDS rather
 * than a whole-body string, for the same reason.
 */
export function withoutPluginBinding<T extends LayoutPluginBindingSource>(
  layout: T,
): T {
  const { catalogContribution: _catalogContribution, ...withoutContribution } =
    layout;
  const config = { ...(layout.config ?? {}) };
  for (const key of WITHHELD_CONFIG_KEYS) delete config[key];
  return { ...withoutContribution, config } as T;
}

/**
 * The inverse, and the reason it is in this file rather than at the route.
 *
 * A caller who read a withheld layout PUTs back a `config` with these keys
 * MISSING, and the update route replaces `config` wholesale — so every key
 * {@link withoutPluginBinding} removed has to come back from the stored
 * record or the write destroys it. The first version of this pair restored
 * `plugin` and forgot `actions` and `globalSkills`, and `actions` is not
 * re-derived by anything: the read route's live merge restores `tabs`,
 * `globalSkills`, `defaultAgent`, `availableAgents` and `requiredProviders`,
 * never `actions`. The loss was permanent, for the operator too, and it also
 * silently dropped the layout out of `buildLayoutAgentReferences`
 * (`domain/file-storage-records.ts`), which reads exactly `config.actions`
 * and `config.globalSkills` for its global-reference half.
 *
 * So the two functions share ONE key list and live beside each other. That
 * is the whole point: a key added to the strip is restored by construction
 * rather than by somebody remembering a second site.
 *
 * `catalogContribution` is deliberately not handled here — the update route
 * already carries it over from the stored record unconditionally, for every
 * caller, and has since before any of this existed.
 */
export function withPluginBindingRestored<T extends LayoutPluginBindingSource>(
  next: T,
  stored: LayoutPluginBindingSource,
): T {
  const storedConfig = stored.config ?? {};
  const config = { ...(next.config ?? {}) };
  for (const key of WITHHELD_CONFIG_KEYS) {
    if (Object.hasOwn(storedConfig, key)) config[key] = storedConfig[key];
    else delete config[key];
  }
  return { ...next, config } as T;
}
