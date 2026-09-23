import type {
  OpenProjectChatsDetail,
  ProjectChatComposerDraft,
} from '../../lib/projectChatEvents';

export type ClaimedComposerDraftRequest = OpenProjectChatsDetail & {
  projectSlug: string;
  composerDraft: ProjectChatComposerDraft;
};

/**
 * Decides whether THIS mounted chat pane takes a "new chat with a composer
 * draft" request, and claims it when it does.
 *
 * Every mounted chat pane (the ambient dock and each fullscreen, layout-bound
 * pane) listens for the same window event. Without a claim, each would open
 * its own New Chat picker. So:
 * - a pane bound to one Project (immutable scope) never takes a draft for a
 *   different Project; its picker would start the chat in its own Project
 *   and the draft would land in the wrong place;
 * - the first pane that may take the request claims it with
 *   `preventDefault()`, and every later listener sees `defaultPrevented` and
 *   leaves it alone. Exactly one picker opens.
 *
 * Returns the request when this pane should open its picker, else `null`.
 * Requests without a composer draft are not handled here.
 */
export function claimComposerDraftRequest(
  event: Event,
  pane: { hasImmutableProjectScope: boolean; projectSlug?: string },
): ClaimedComposerDraftRequest | null {
  const detail = (event as CustomEvent<OpenProjectChatsDetail>).detail;
  if (!detail?.projectSlug || !detail.composerDraft) return null;
  if (event.defaultPrevented) return null;
  if (pane.hasImmutableProjectScope && pane.projectSlug !== detail.projectSlug)
    return null;
  event.preventDefault();
  return detail as ClaimedComposerDraftRequest;
}
