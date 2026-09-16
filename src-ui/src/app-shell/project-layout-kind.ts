/**
 * Which renderer `ProjectLayoutRenderer` picks for a project layout, derived
 * once from the layout's own facts so that every reader of "is this the
 * full-viewport Chat placement?" answers from the same derivation the
 * renderer dispatches on (#1446).
 *
 * `type === 'chat'` alone is a label: a plugin-contributed layout may carry
 * that word and still render its declared tabs through `LayoutView`. Only the
 * layout that actually reaches `layoutTypeRegistry.chat` owns the whole
 * viewport, and only that layout may suspend the ambient regions in App.
 *
 * This module is imported by the eager entry chunk (`App.tsx`); it must stay
 * pure and must not import `layoutRegistry` (which imports the layout
 * components). The registry keys are restated here and pinned to the real
 * registry by `__tests__/project-layout-kind.test.ts`.
 */

import type { LayoutPaneReferences } from '@kontourai/station-contracts/layout';

/** The keys of `layoutRegistry.ts`'s `layoutTypeRegistry`, restated. */
export const LAYOUT_TYPE_REGISTRY_KEYS = [
  'chat',
  'tasks',
  'session-board',
  'review',
] as const;

type LayoutTypeRegistryKey = (typeof LAYOUT_TYPE_REGISTRY_KEYS)[number];

type ProjectLayoutRendererKind =
  | 'layout-view'
  | 'coding'
  | LayoutTypeRegistryKey;

/** The subset of `LayoutConfig` the dispatch reads. */
interface ProjectLayoutRendererFacts {
  type?: string;
  config?: Record<string, unknown> | null;
  catalogContribution?: {
    provenance: { origin: string };
  };
  /**
   * The read verdict from #2090. Its PRESENCE is what this dispatch needs:
   * a response carrying it has had `config.plugin` and `catalogContribution`
   * withheld, which are the two facts below that route a contributed layout
   * to `LayoutView`. Without this a withheld `type: 'coding'` plugin layout
   * would fall through to the BUILT-IN coding host — a different renderer
   * for a layout whose panes were withheld, and one that never reaches the
   * per-tab branch. `unavailableTabIds` may legitimately be empty; the field
   * being absent, not empty, is what means nothing was withheld.
   */
  paneReferences?: LayoutPaneReferences;
}

const registryKeys: ReadonlySet<string> = new Set(LAYOUT_TYPE_REGISTRY_KEYS);

function isLayoutTypeRegistryKey(
  value: string,
): value is LayoutTypeRegistryKey {
  return registryKeys.has(value);
}

/**
 * Mirrors `ProjectLayoutRenderer`'s dispatch order exactly: no layout yet →
 * `LayoutView`; a contributed layout (catalog provenance `plugin`/`mcp`), a
 * persisted `config.plugin`, or a response whose plugin binding was withheld
 * (#2090) → `LayoutView`, whatever its `type`; `coding` → the built-in
 * Coding host; a registry key → that registry entry; anything else →
 * `LayoutView`.
 */
export function resolveProjectLayoutRendererKind(
  layout: ProjectLayoutRendererFacts | null | undefined,
): ProjectLayoutRendererKind {
  if (!layout) return 'layout-view';

  const config = layout.config ?? {};
  const declaredPlugin =
    typeof config.plugin === 'string' && config.plugin.length > 0;
  const contributionOrigin = layout.catalogContribution?.provenance.origin;
  const isContributedLayout =
    contributionOrigin === 'plugin' || contributionOrigin === 'mcp';
  const bindingWithheld = layout.paneReferences !== undefined;
  if (isContributedLayout || declaredPlugin || bindingWithheld) {
    return 'layout-view';
  }

  if (layout.type === 'coding') return 'coding';

  if (typeof layout.type === 'string' && isLayoutTypeRegistryKey(layout.type)) {
    return layout.type;
  }

  return 'layout-view';
}

/**
 * True only for the layout that renders `ChatWorkspaceLayout` — the placement
 * that owns the whole viewport and so is the only one App may suspend its
 * ambient regions for.
 */
export function rendersChatWorkspaceLayout(
  layout: ProjectLayoutRendererFacts | null | undefined,
): boolean {
  return resolveProjectLayoutRendererKind(layout) === 'chat';
}
