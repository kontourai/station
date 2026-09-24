import { usePullRequestContextQuery } from '@kontourai/station-sdk';
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
import { chipFor, PullRequestLinkState, textOf } from './ChatLinkChip';
import {
  type MarkdownLinkContextValue,
  useMarkdownLinkContext,
} from './MarkdownLinkContext';
import {
  classifyMarkdownLink,
  type MarkdownLinkTarget,
} from './markdownLinkTarget';
import { PATH_MENTION_ATTRIBUTE } from './remarkPathMentions';
import { useWorkspaceFileExists } from './useWorkspaceFileExists';

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
 * What it does touch even when it can do nothing with it: a repo-relative
 * path with no dock to hold it and no layout route to send it to. That click
 * is refused rather than followed — see the branch at the bottom of the
 * handler for why letting a relative href resolve against Station's own
 * origin is a loss on both hosts.
 *
 * Keyboard activation takes the dock route, because an anchor's Enter
 * dispatches a primary unmodified click: the link is reachable and
 * activatable, and what it activates is the pane, not a webview navigation to
 * a relative URL that resolves against Station's own routes.
 */
function activate(
  event: MouseEvent<HTMLAnchorElement>,
  target: MarkdownLinkTarget | null,
  link: MarkdownLinkContextValue | null,
  model: ReturnType<typeof useRegionModelOptional>,
) {
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
  if (!target) return;
  // A forge file this checkout is not known to hold opens on the forge.
  if (target.kind === 'external' || target.kind === 'repo-file') {
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
  // No dock that may hold it: a bottom-only fold, or a dock bound to a
  // different project than the conversation. The layout route below is
  // still taken when this session has one — that is the pre-#2049
  // behaviour, preserved. What changes is the case where it does not:
  // the click is now refused on BOTH hosts rather than followed, because
  // following it is not "the anchor's default behaviour" in any useful
  // sense — a
  // repo-relative href names a file in a checkout, and resolved against
  // Station's own origin it is a route Station does not have. On Tauri that
  // replaces the running application and loses every open conversation
  // (`openExternalLink.ts`, the failure the external branch above exists to
  // prevent); on the web it is a same-origin navigation to a Station
  // route-miss, dropping the conversation's query pointer, recoverable only
  // by Back. A click that does nothing is worse than a click that works and
  // better than either of those, and it is the same on both hosts, which is
  // one behaviour to reason about instead of two wrong ones.
  event.preventDefault();
  link.openPathInMain?.(target.path, target.lineRange);
}

type AnchorProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  children?: ReactNode;
};

export function ChatMarkdownAnchor({ href, children, ...props }: AnchorProps) {
  const link = useMarkdownLinkContext();
  const model = useRegionModelOptional();
  // The marker `remarkPathMentions` sets; stripped so it never reaches the DOM.
  const { [PATH_MENTION_ATTRIBUTE]: mentionMarker, ...anchorProps } =
    props as AnchorProps & { [PATH_MENTION_ATTRIBUTE]?: unknown };
  const isMention = mentionMarker !== undefined;
  const target = classifyMarkdownLink(href, { roots: link?.projectRoots });
  if (isMention) {
    // A path written in prose is a link only inside a conversation, only when
    // it names a file in that conversation's checkout, and only once the
    // server has said the file is there. Until then it is the text it was.
    if (!link?.projectSlug || target?.kind !== 'path') return <>{children}</>;
    return (
      <PathMentionAnchor
        anchorProps={anchorProps}
        href={href}
        link={link}
        model={model}
        target={target}
      >
        {children}
      </PathMentionAnchor>
    );
  }
  if (target?.kind === 'repo-file' && link?.projectSlug) {
    return (
      <RepoFileAnchor
        anchorProps={anchorProps}
        href={href}
        link={link}
        model={model}
        target={target}
      >
        {children}
      </RepoFileAnchor>
    );
  }
  return (
    <LinkAnchor
      anchorProps={anchorProps}
      href={href}
      link={link}
      model={model}
      target={link ? target : null}
      clickTarget={target}
    >
      {children}
    </LinkAnchor>
  );
}

interface ResolvedAnchorProps {
  anchorProps: AnchorHTMLAttributes<HTMLAnchorElement>;
  href: string | undefined;
  link: MarkdownLinkContextValue | null;
  model: ReturnType<typeof useRegionModelOptional>;
  children?: ReactNode;
}

/**
 * The anchor itself, decorated as a chip when `target` is one Station
 * recognises. `target` (what it LOOKS like) and `clickTarget` (what a click
 * opens) differ only for a forge file whose repository is this checkout's.
 */
function LinkAnchor({
  anchorProps,
  href,
  link,
  model,
  target,
  clickTarget,
  children,
}: ResolvedAnchorProps & {
  target: MarkdownLinkTarget | null;
  clickTarget: MarkdownLinkTarget | null;
}) {
  const raw = textOf(children).trim() === (href ?? '').trim();
  const chip = target ? chipFor(target, raw) : null;
  const onClick = (event: MouseEvent<HTMLAnchorElement>) =>
    activate(event, clickTarget, link, model);
  if (!chip) {
    return (
      <a {...anchorProps} href={href} onClick={onClick}>
        {children}
      </a>
    );
  }
  const className = [
    anchorProps.className,
    'chat-link-chip',
    `chat-link-chip--${chip.modifier}`,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <a
      {...anchorProps}
      className={className}
      href={href}
      onClick={onClick}
      title={anchorProps.title ?? chip.title}
    >
      {chip.icon}
      {chip.label ? (
        <span className="chat-link-chip__label">{chip.label}</span>
      ) : (
        children
      )}
      {target?.kind === 'pull-request' && link?.conversationId ? (
        <PullRequestLinkState
          conversationId={link.conversationId}
          host={target.key.host}
          owner={target.key.owner}
          repository={target.key.repository}
          pullRequestRef={target.key.ref}
        />
      ) : null}
    </a>
  );
}

function PathMentionAnchor({
  target,
  ...rest
}: ResolvedAnchorProps & {
  link: MarkdownLinkContextValue;
  target: Extract<MarkdownLinkTarget, { kind: 'path' }>;
}) {
  const exists = useWorkspaceFileExists(rest.link.projectSlug, target.path);
  if (exists !== true) return <>{rest.children}</>;
  return <LinkAnchor {...rest} target={target} clickTarget={target} />;
}

/**
 * A forge file link opens the LOCAL preview only when the conversation's
 * checkout is that repository on that host — decided by the same repository
 * context the pull-request list resolves, never by the path merely existing
 * here (a file of the same name in another repository is a different file).
 * Until that is known, and when it does not match, it opens on the forge.
 */
function RepoFileAnchor({
  target,
  ...rest
}: ResolvedAnchorProps & {
  link: MarkdownLinkContextValue;
  target: Extract<MarkdownLinkTarget, { kind: 'repo-file' }>;
}) {
  const context = usePullRequestContextQuery({
    project: rest.link.projectSlug ?? '',
  });
  const identity = context.data?.available ? context.data : undefined;
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const local =
    !!identity &&
    same(identity.host, target.host) &&
    same(identity.repository.owner, target.owner) &&
    same(identity.repository.name, target.repository);
  const clickTarget: MarkdownLinkTarget = local
    ? {
        kind: 'path',
        path: target.path,
        ...(target.lineRange ? { lineRange: target.lineRange } : {}),
      }
    : target;
  return <LinkAnchor {...rest} target={target} clickTarget={clickTarget} />;
}
