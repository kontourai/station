import type { WorkspaceFilePreviewLineRange } from '@kontourai/station-contracts/workspace-file-preview';
import { createContext, useContext } from 'react';

/**
 * What a conversation's rendered markdown may do with a link (#2049).
 *
 * Provided by `ChatDock` around the transcript it is showing, and by nothing
 * else: a document view, a shared answer and an ephemeral system message have
 * no conversation behind them, so they get no provider and their anchors stay
 * plain anchors. That absence is the default on purpose — a link handler that
 * guessed a project would open some other checkout's file.
 *
 * This module is in the entry chunk (`ChatDock` is), so it holds a context and
 * a hook and nothing else; the classification and the opening live in
 * `MarkdownRenderer`'s lazy chunk, where the pane contracts already are.
 */
export interface MarkdownLinkContextValue {
  /**
   * The project the CONVERSATION belongs to — the checkout whose files a
   * model's repo-relative path names. Not the dock's binding: those can
   * differ, and a path resolved against the dock's project would preview the
   * wrong file under a truthful-looking name.
   */
  projectSlug: string | null;
  projectId: string | null;
  /** The project this dock is bound to, for the same comparison. */
  dockProjectSlug: string | null;
  /**
   * True when this device's fold offers one dock region only (a phone). A
   * side-region pane is not available there, so paths keep the main route and
   * a pull request opens in the host's browser.
   */
  bottomOnly: boolean;
  /**
   * The route a file preview took before #2049 and still takes wherever a
   * dock pane is not the answer: navigate `main` to the session's coding
   * layout with an open-preview intent. Null when the session has no coding
   * layout to navigate to — and a path with neither a dock pane nor this
   * route is REFUSED rather than left to the anchor's default, on both hosts
   * (`ChatMarkdownAnchor`, the branch at the bottom of its handler).
   */
  openPathInMain:
    | ((path: string, lineRange?: WorkspaceFilePreviewLineRange) => void)
    | null;
}

export const MarkdownLinkContext =
  createContext<MarkdownLinkContextValue | null>(null);

/** The conversation a rendered link belongs to, or null outside one. */
export function useMarkdownLinkContext(): MarkdownLinkContextValue | null {
  return useContext(MarkdownLinkContext);
}
