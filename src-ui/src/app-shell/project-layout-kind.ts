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
 * components). The renderer derivation and registry keys live in contracts,
 * pinned to the real registry by `__tests__/project-layout-kind.test.ts`.
 */

import {
  type LayoutPresentationDeclaration,
  layoutClaimsPrimaryChat,
  layoutPresentationDeclaration,
  type ProjectLayoutRendererFacts,
  resolveProjectLayoutRendererKind,
} from '@kontourai/station-contracts/layout';

export {
  isBuiltinCodingLayout,
  LAYOUT_TYPE_REGISTRY_KEYS,
  resolveProjectLayoutRendererKind,
} from '@kontourai/station-contracts/layout';

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
