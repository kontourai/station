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

import {
  type LayoutPaneReferences,
  type LayoutPresentationDeclaration,
  layoutClaimsPrimaryChat,
  layoutPresentationDeclaration,
  layoutPresentsAsStack,
} from '@kontourai/station-contracts/layout';

/** The keys of `layoutRegistry.ts`'s `layoutTypeRegistry`, restated. */
export const LAYOUT_TYPE_REGISTRY_KEYS = [
  'chat',
  'tasks',
  'session-board',
  'review',
] as const;

type LayoutTypeRegistryKey = (typeof LAYOUT_TYPE_REGISTRY_KEYS)[number];

/**
 * `stack` is the generic stack host (`LayoutStackHost`), chosen by a
 * layout's declared `presentation: 'stack'` — built-in Coding and any
 * contributed layout alike (#2995).
 */
type ProjectLayoutRendererKind =
  | 'layout-view'
  | 'stack'
  | LayoutTypeRegistryKey;

/** The subset of `LayoutConfig` (as a read answers it) the dispatch reads. */
interface ProjectLayoutRendererFacts {
  type?: string;
  config?: Record<string, unknown> | null;
  catalogContribution?: {
    provenance: { origin: string };
  };
  /** The declaration a layout read states (`LayoutPresentationReadFields`). */
  primary?: unknown;
  presentation?: unknown;
  drillIns?: unknown;
  /**
   * The read verdict from #2090. Its PRESENCE is what this dispatch needs:
   * a response carrying it has had `config.plugin` and `catalogContribution`
   * withheld, which are the two facts below that route a contributed layout
   * to `LayoutView`. Without this a withheld `type: 'coding'` plugin layout
   * would fall through to the built-in Coding reading — a different renderer
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
 * The layout's declaration, as the shell reads it: the contracts reader
 * (`layoutPresentationDeclaration`), which owns the withheld and legacy
 * rules, so App and the renderer answer from one derivation.
 */
export function resolveLayoutDeclaration(
  layout: ProjectLayoutRendererFacts | null | undefined,
): LayoutPresentationDeclaration {
  return layoutPresentationDeclaration(layout);
}

/**
 * Mirrors `ProjectLayoutRenderer`'s dispatch order exactly: no layout yet →
 * `LayoutView`; a layout declaring `presentation: 'stack'` → the stack host,
 * whoever contributed it; a contributed layout (catalog provenance
 * `plugin`/`mcp`), a persisted `config.plugin`, or a response whose plugin
 * binding was withheld (#2090) → `LayoutView`, whatever its `type`; a
 * registry key → that registry entry; anything else → `LayoutView`.
 *
 * The stack host is not a built-in privilege: it renders only the panes the
 * layout declares, through the ordinary catalog. What stays built-in is
 * Coding's own composition inside it, which `ProjectLayoutRenderer` grants
 * only to a non-contributed `type: 'coding'` record (`isBuiltinCodingLayout`).
 */
export function resolveProjectLayoutRendererKind(
  layout: ProjectLayoutRendererFacts | null | undefined,
): ProjectLayoutRendererKind {
  if (!layout) return 'layout-view';

  if (layoutPresentsAsStack(layout)) return 'stack';

  if (isContributedOrWithheld(layout)) return 'layout-view';

  if (typeof layout.type === 'string' && isLayoutTypeRegistryKey(layout.type)) {
    return layout.type;
  }

  return 'layout-view';
}

function isContributedOrWithheld(layout: ProjectLayoutRendererFacts): boolean {
  const config = layout.config ?? {};
  const declaredPlugin =
    typeof config.plugin === 'string' && config.plugin.length > 0;
  const contributionOrigin = layout.catalogContribution?.provenance.origin;
  const isContributedLayout =
    contributionOrigin === 'plugin' || contributionOrigin === 'mcp';
  const bindingWithheld = layout.paneReferences !== undefined;
  return isContributedLayout || declaredPlugin || bindingWithheld;
}

/**
 * Whether the stack host also mounts built-in Coding's own composition (its
 * Coding occurrence, Files/Diff/Terminal and evidence compositions). Only a
 * record nobody contributed may: a plugin layout typed `coding` gets the
 * generic host with its own declared drill-ins and nothing more.
 */
export function isBuiltinCodingLayout(
  layout: ProjectLayoutRendererFacts | null | undefined,
): boolean {
  return (
    !!layout &&
    layout.type === 'coding' &&
    !isContributedOrWithheld(layout) &&
    resolveProjectLayoutRendererKind(layout) === 'stack'
  );
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

/**
 * Where a layout route puts Station's one Chat controller, decided at render
 * time from the same facts the renderer dispatches on, so App (which suspends
 * the ambient `chat` surface) and the layout (which mounts Chat) can never
 * disagree for a frame and mount two controllers.
 *
 * - `viewport`: the Station-owned Chat layout owns the whole view; App mounts
 *   no region shells at all.
 * - `center`: a stack layout declaring `primary: 'chat'` puts Chat in its own
 *   centre (the Chat page of its navigation stack). The ambient `chat`
 *   surface is SUSPENDED — not moved — while the other region panes keep
 *   rendering, and ⌘D goes to that Chat page.
 * - `none`: Chat stays wherever the region model placed it. That includes a
 *   plugin or withheld layout that merely carries the word `coding` or `chat`,
 *   and a contributed stack layout whose plugin lacks `layout.primaryChat`
 *   (the server answers it without the claim). A `center` layout keeps Chat
 *   in its workbench on phones as well; the keyboard must not squeeze a
 *   second dock above an empty chat page.
 */
export type LayoutChatPlacement = 'viewport' | 'center' | 'none';

export function resolveLayoutChatPlacement(
  layout: ProjectLayoutRendererFacts | null | undefined,
): LayoutChatPlacement {
  const kind = resolveProjectLayoutRendererKind(layout);
  if (kind === 'chat') return 'viewport';
  if (kind === 'stack' && layoutClaimsPrimaryChat(layout)) return 'center';
  return 'none';
}
