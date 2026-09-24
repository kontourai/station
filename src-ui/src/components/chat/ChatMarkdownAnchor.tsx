import { isWorkspaceFilePreviewRelativePath } from '@kontourai/station-contracts/workspace-file-preview';
import { usePullRequestContextQuery } from '@kontourai/station-sdk';
import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from 'react';
import { useRegionModelOptional } from '../../contexts/RegionModelContext';
import { toastStore } from '../../contexts/ToastContext';
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
import { sessionRunsInProjectDirectory } from './sessionDirectory';
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
/**
 * Where this conversation's file paths live (#2476). A session in the project
 * checkout: the checkout. A session anywhere else: its own directory, read
 * through its thread id — the server reads that directory only when it can
 * vouch it is this project's, and otherwise answers nothing (no mention links,
 * a preview is refused), never the checkout's copy. Without a thread id there
 * is no way to read it (`resolvable: false`): mentions are not linked, and an
 * explicit path link is refused with a notice rather than opened against the
 * checkout.
 */
function fileScope(link: MarkdownLinkContextValue | null): {
  roots: readonly string[];
  thread?: string;
  resolvable: boolean;
} {
  if (!link) return { roots: [], resolvable: false };
  if (
    sessionRunsInProjectDirectory(link.sessionDirectory, link.projectRoots?.[0])
  )
    return { roots: link.projectRoots ?? [], resolvable: true };
  if (link.threadId && link.sessionDirectory)
    return {
      roots: [link.sessionDirectory],
      thread: link.threadId,
      resolvable: true,
    };
  return { roots: [], resolvable: false };
}

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
  // A path in a session whose directory this UI cannot read (it runs
  // outside the checkout and there is no thread to read it through) names a
  // file the checkout may not hold, or holds at different content. Opening
  // the checkout's copy under that name would preview the wrong file, so the
  // click is refused — visibly, since a click that does nothing silently
  // reads as a broken link. Mentions never reach here: they are not linked
  // at all in that scope.
  const scope = fileScope(link);
  if (!scope.resolvable) {
    event.preventDefault();
    toastStore.show(
      "This file is in the session's own directory, which can't be previewed here.",
      undefined,
      5000,
      undefined,
      undefined,
      'warning',
    );
    return;
  }
  if (dockCanHold) {
    event.preventDefault();
    const thread = scope.thread;
    const outcome = openFilePreviewInRegion(model, {
      projectId: link.projectId,
      projectSlug: link.projectSlug,
      path: target.path,
      ...(target.lineRange ? { lineRange: target.lineRange } : {}),
      ...(thread ? { thread } : {}),
    });
    if (outcome.ok) return;
    // The model refused (a device fold, a region rule). The preview still
    // has the route it had before #2049, if this session has a layout — but
    // that route reads the CHECKOUT, so a worktree's file never takes it.
    if (!thread) link.openPathInMain?.(target.path, target.lineRange);
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
  // The layout route reads the checkout: a worktree file does not take it.
  if (!scope.thread)
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
  const scope = fileScope(link);
  const target = classifyMarkdownLink(href, { roots: scope.roots });
  if (isMention) {
    // A path written in prose is a link only inside a conversation, only when
    // it names a file in the directory that conversation's session works in,
    // and only once the server has said the file is there. Until then it is
    // the text it was.
    if (!link?.projectSlug || !scope.resolvable || target?.kind !== 'path')
      return <>{children}</>;
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
  // Raw: the text IS the href — an autolinked URL, or a path mention (whose
  // href gained a `./` so it would not parse as a scheme).
  const text = textOf(children).trim();
  const raw = text === (href ?? '').trim() || `./${text}` === href;
  const chip = target ? chipFor(target, raw) : null;
  const onClick = (event: MouseEvent<HTMLAnchorElement>) =>
    activate(event, clickTarget, link, model);
  // A web URL the handler lets through (no dock for a pull request, an
  // external site, a forge file) must not replace the running Station tab;
  // #2049 specified "a new tab on web". Paths never leave, so they get none.
  const leaves =
    !!link &&
    !!clickTarget &&
    clickTarget.kind !== 'path' &&
    anchorProps.target === undefined;
  const newTab = leaves ? { target: '_blank', rel: 'noopener noreferrer' } : {};
  if (!chip) {
    return (
      <a {...anchorProps} {...newTab} href={href} onClick={onClick}>
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
      {...newTab}
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
  const exists = useWorkspaceFileExists(
    rest.link.projectSlug,
    target.path,
    fileScope(rest.link).thread,
  );
  if (exists !== true) return <>{rest.children}</>;
  return <LinkAnchor {...rest} target={target} clickTarget={target} />;
}

/**
 * The ref and path a forge file URL names, read against the branch the
 * checkout is on. The URL alone cannot tell `blob/feature/x/a.ts` (branch
 * `feature/x`, file `a.ts`) from branch `feature`, file `x/a.ts`; knowing the
 * checkout's branch settles it for THAT branch. Any other split stays the
 * classifier's one-segment reading, which then fails the ref comparison and
 * opens on the forge.
 */
function splitForgeRefPath(
  target: Pick<
    Extract<MarkdownLinkTarget, { kind: 'repo-file' }>,
    'ref' | 'path' | 'refPath'
  >,
  branch: string | undefined,
): { ref: string; path: string } {
  if (branch?.includes('/') && target.refPath.startsWith(`${branch}/`)) {
    const path = target.refPath.slice(branch.length + 1);
    if (isWorkspaceFilePreviewRelativePath(path)) return { ref: branch, path };
  }
  return { ref: target.ref, path: target.path };
}

/**
 * A forge file link opens the LOCAL preview only when the conversation's
 * checkout is that repository on that host, on the ref the link names —
 * decided by the same repository context the pull-request list resolves, never
 * by the path merely existing here (a file of the same name in another
 * repository, or at another commit, is a different file).
 * Until that is known, and when it does not match, it opens on the forge.
 *
 * The rule, and what it does not know: the ref must equal the checkout's
 * LOCAL branch name (a branch containing `/` is split at that name, see
 * `splitForgeRefPath`). The repository context carries no ahead/behind count,
 * so a checkout behind its upstream, ahead of it, or with uncommitted edits
 * still matches and the preview shows ITS working copy, not the forge's
 * revision. The link's tooltip says so rather than implying the two agree.
 * A local branch whose name is a PREFIX of the link's slash branch (local
 * `feature`, link `feature/x`) also cannot be told apart and reads as a
 * match; the preview then names `x/...`, which usually does not exist.
 */
function RepoFileAnchor({
  target,
  ...rest
}: ResolvedAnchorProps & {
  link: MarkdownLinkContextValue;
  target: Extract<MarkdownLinkTarget, { kind: 'repo-file' }>;
}) {
  // In a worktree session the ref to compare is the WORKTREE's branch, which
  // is also the copy the preview then reads.
  const thread = fileScope(rest.link).thread;
  const context = usePullRequestContextQuery({
    project: rest.link.projectSlug ?? '',
    ...(thread ? { thread } : {}),
  });
  const identity = context.data?.available ? context.data : undefined;
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const { ref, path } = splitForgeRefPath(target, identity?.branch);
  const local =
    !!identity &&
    same(identity.host, target.host) &&
    same(identity.repository.owner, target.owner) &&
    same(identity.repository.name, target.repository) &&
    identity.branch === ref;
  const clickTarget: MarkdownLinkTarget = local
    ? {
        kind: 'path',
        path,
        ...(target.lineRange ? { lineRange: target.lineRange } : {}),
      }
    : target;
  const anchorProps = local
    ? {
        ...rest.anchorProps,
        title:
          rest.anchorProps.title ??
          `${target.url}\nOpens this checkout's working copy of ${path}, which may differ from the forge's.`,
      }
    : rest.anchorProps;
  return (
    <LinkAnchor
      {...rest}
      anchorProps={anchorProps}
      target={target}
      clickTarget={clickTarget}
    />
  );
}
