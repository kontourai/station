import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from 'react';
import { useRegionModelOptional } from '../../contexts/RegionModelContext';
import {
  openFilePreviewInRegion,
  openPullRequestInRegion,
} from '../../contexts/useOpenInRegion';
import {
  hostOwnsExternalLinks,
  openNativeExternalLink,
} from '../../platform/openExternalLink';
import { useMarkdownLinkContext } from './MarkdownLinkContext';
import { classifyMarkdownLink } from './markdownLinkTarget';

/**
 * One link in a rendered chat message (#2049).
 *
 * A model writes three kinds of link and Station could follow none of them.
 * A pull request opens as its own dock pane, a repo-relative path as a file
 * preview beside the conversation, and everything else through the host's own
 * browser — which on Tauri is a FIX, not a preservation: a plain anchor there
 * replaced the running application with the linked page.
 *
 * What it deliberately does not touch:
 *
 * - a modified click (cmd/ctrl/shift/alt) or a non-primary button, which the
 *   browser owns — "open in a new tab" must keep meaning that;
 * - a middle click, which fires `auxclick` and never reaches this handler;
 * - an event another handler already prevented;
 * - every anchor outside a conversation (no `MarkdownLinkContext` provider),
 *   which stays exactly the anchor the markdown renderer built.
 *
 * Keyboard activation takes the dock route, because an anchor's Enter
 * dispatches a primary unmodified click: the link is reachable and
 * activatable, and what it activates is the pane, not a webview navigation to
 * a relative URL that resolves against Station's own routes.
 */
export function ChatMarkdownAnchor({
  href,
  children,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & { children?: ReactNode }) {
  const link = useMarkdownLinkContext();
  const model = useRegionModelOptional();
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    if (!link) return;
    const target = classifyMarkdownLink(href);
    if (!target) return;
    if (target.kind === 'external') {
      // Only the native host has somewhere else to put it. On the web an
      // anchor already means "leave", so the default IS the behaviour.
      if (!hostOwnsExternalLinks()) return;
      event.preventDefault();
      void openNativeExternalLink(target.url);
      return;
    }
    // A dock pane binds the DOCK's project, so a conversation about another
    // project cannot have its links placed there — the region would refuse
    // the occurrence, and rebinding it to the dock's project would name a
    // file or a repository in a checkout the conversation never mentioned.
    const dockCanHold =
      model !== null &&
      !link.bottomOnly &&
      link.projectId !== null &&
      link.projectSlug !== null &&
      link.projectSlug === link.dockProjectSlug;
    if (target.kind === 'pull-request') {
      if (dockCanHold) {
        event.preventDefault();
        openPullRequestInRegion(model, target.key, link.projectId);
        return;
      }
      // No pane for it here. A review still has a home — the host's browser —
      // and on the web that is the anchor's own default.
      if (!hostOwnsExternalLinks()) return;
      event.preventDefault();
      void openNativeExternalLink(target.url);
      return;
    }
    if (dockCanHold) {
      event.preventDefault();
      const outcome = openFilePreviewInRegion(model, {
        projectId: link.projectId,
        projectSlug: link.projectSlug,
        path: target.path,
        ...(target.lineRange ? { lineRange: target.lineRange } : {}),
      });
      if (outcome.ok) return;
      // The model refused (a device fold, a region rule). The preview still
      // has the route it had before #2049, if this session has a layout.
      link.openPathInMain?.(target.path, target.lineRange);
      return;
    }
    if (!link.openPathInMain) return;
    event.preventDefault();
    link.openPathInMain(target.path, target.lineRange);
  };
  return (
    <a {...props} href={href} onClick={handleClick}>
      {children}
    </a>
  );
}
