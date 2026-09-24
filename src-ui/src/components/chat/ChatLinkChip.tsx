import { getConversationPullRequestLinks } from '@kontourai/station-sdk/conversation-pull-request-links';
import { useQuery } from '@tanstack/react-query';
import { isValidElement, type ReactNode } from 'react';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { BranchGlyph, DocumentGlyph } from '../icons/Glyph';
import type { MarkdownLinkTarget } from './markdownLinkTarget';
import './ChatLinkChip.css';

/**
 * How a recognised link LOOKS (#2049 follow-up): a forge mark and a compact
 * `owner/repo#123` for pull requests, issues and forge files, a file glyph and
 * `name.ts:12` for a file in the checkout. What a click does stays in
 * `ChatMarkdownAnchor`; this module only chooses the label.
 *
 * A compact label replaces the link text only when that text is the raw
 * href (an autolinked URL, a path written in prose). Text an author chose —
 * `[the fix](https://github.com/o/r/pull/1)` — is kept, with the mark beside
 * it: rewriting prose would put words in the author's mouth.
 */

export type Forge = 'github' | 'gitlab';

/**
 * The forge whose MARK a host earns. Only the two public hosts: a
 * self-hosted forge may be either (or neither), and showing a brand the
 * host has not proven would be a label nothing derives.
 */
export function forgeForHost(host: string): Forge | null {
  const canonical = host.toLowerCase().replace(/\.$/, '');
  if (canonical === 'github.com' || canonical === 'www.github.com')
    return 'github';
  if (canonical === 'gitlab.com' || canonical === 'www.gitlab.com')
    return 'gitlab';
  return null;
}

export function ForgeMark({ forge }: { forge: Forge }) {
  return (
    <svg
      aria-hidden="true"
      className="chat-link-chip__icon"
      fill="currentColor"
      focusable="false"
      height="1em"
      viewBox="0 0 16 16"
      width="1em"
    >
      {forge === 'github' ? (
        <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
      ) : (
        <path d="m15.73 6.34-.02-.06L13.53.6a.57.57 0 0 0-1.08.04l-1.47 4.5H5.02L3.55.64A.57.57 0 0 0 2.47.6L.29 6.28l-.02.06a4.04 4.04 0 0 0 1.34 4.67l.03.03 3.3 2.47 1.63 1.24 1 .75a.67.67 0 0 0 .81 0l1-.75 1.63-1.24 3.32-2.49.01-.01a4.04 4.04 0 0 0 1.34-4.67Z" />
      )}
    </svg>
  );
}

/** The plain text a link's children render, for comparing against its href. */
export function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean')
    return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement<{ children?: ReactNode }>(node))
    return textOf(node.props.children);
  return '';
}

function positionSuffix(
  lineRange: { start: number; end: number } | undefined,
): string {
  if (!lineRange) return '';
  return lineRange.start === lineRange.end
    ? `:${lineRange.start}`
    : `:${lineRange.start}-${lineRange.end}`;
}

function basename(path: string): string {
  const segments = path.split('/');
  return segments[segments.length - 1] || path;
}

/**
 * A GitHub/GitLab URL that is not a pull request or a file, in the compact
 * form its forge writes it: `owner/repo#12` for an issue, `owner/repo@abc1234`
 * for a commit, `owner/repo` for the repository. Null for anything else.
 */
export function forgeUrlLabel(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!forgeForHost(parsed.host)) return null;
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments[2] === '-') segments.splice(2, 1);
  const [owner, repo, kind, id] = segments;
  if (!owner || !repo) return null;
  const slug = `${owner}/${repo}`;
  if (segments.length === 2) return slug;
  if (kind === 'issues' && id && /^\d+$/.test(id)) return `${slug}#${id}`;
  if (kind === 'commit' && id && /^[0-9a-f]{7,40}$/i.test(id))
    return `${slug}@${id.slice(0, 7)}`;
  return null;
}

export interface ChipPresentation {
  icon: ReactNode;
  /** The compact label, or null to keep the link's own text. */
  label: string | null;
  /** Full identity for the tooltip. */
  title: string;
  modifier: 'pull-request' | 'file' | 'forge';
}

/**
 * The chip a classified link renders as, or null for a link that stays a
 * plain anchor (an ordinary external site).
 */
export function chipFor(
  target: MarkdownLinkTarget,
  raw: boolean,
): ChipPresentation | null {
  if (target.kind === 'pull-request') {
    const forge = forgeForHost(target.key.host);
    return {
      icon: forge ? (
        <ForgeMark forge={forge} />
      ) : (
        <BranchGlyph className="chat-link-chip__icon" />
      ),
      // A compact label drops the host, so only a host whose mark it earns
      // may have one: on any other host `o/r#1` would hide where it goes.
      label:
        raw && forge
          ? `${target.key.owner}/${target.key.repository}#${target.key.ref}`
          : null,
      title: target.url,
      modifier: 'pull-request',
    };
  }
  if (target.kind === 'path') {
    return {
      icon: <DocumentGlyph className="chat-link-chip__icon" />,
      label: raw
        ? `${basename(target.path)}${positionSuffix(target.lineRange)}`
        : null,
      title: `${target.path}${positionSuffix(target.lineRange)}`,
      modifier: 'file',
    };
  }
  if (target.kind === 'repo-file') {
    const forge = forgeForHost(target.host);
    return {
      icon: forge ? (
        <ForgeMark forge={forge} />
      ) : (
        <DocumentGlyph className="chat-link-chip__icon" />
      ),
      label:
        raw && forge
          ? `${target.repository}/${basename(target.path)}${positionSuffix(target.lineRange)}`
          : null,
      title: target.url,
      modifier: 'file',
    };
  }
  const forge = (() => {
    try {
      return forgeForHost(new URL(target.url).host);
    } catch {
      return null;
    }
  })();
  if (!forge) return null;
  return {
    icon: <ForgeMark forge={forge} />,
    label: raw ? forgeUrlLabel(target.url) : null,
    title: target.url,
    modifier: 'forge',
  };
}

const STATE_LABELS: Record<string, string> = {
  OPEN: 'Open',
  OPENED: 'Open',
  MERGED: 'Merged',
  CLOSED: 'Closed',
  DRAFT: 'Draft',
};

/**
 * The state of a pull request this conversation has LINKED, as the server
 * last observed it. A pull request the conversation has not linked shows no
 * state: Station has no observation of it, and a link is not one.
 */
export function PullRequestLinkState({
  conversationId,
  host,
  owner,
  repository,
  pullRequestRef,
}: {
  conversationId: string;
  host: string;
  owner: string;
  repository: string;
  pullRequestRef: string;
}) {
  const scope = useHostRequestAuthorityScope();
  const links = useQuery({
    queryKey: [
      'conversation-pull-request-links',
      scope?.apiBase,
      scope?.authorityKey,
      conversationId,
    ],
    queryFn: ({ signal }) =>
      getConversationPullRequestLinks(scope!.apiBase, conversationId, {
        signal,
        requestScope: scope!,
      }),
    enabled: !!scope?.isCurrent(),
    retry: false,
    staleTime: 60_000,
  });
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const observation = links.data?.links.find(
    (link) =>
      same(link.host, host) &&
      same(link.repository.owner, owner) &&
      same(link.repository.name, repository) &&
      link.ref === pullRequestRef,
  );
  if (observation?.status.state !== 'current') return null;
  const raw = observation.status.pullRequestState.toUpperCase();
  const label = STATE_LABELS[raw];
  if (!label) return null;
  return (
    <span
      className={`chat-link-chip__state chat-link-chip__state--${label.toLowerCase()}`}
      title={observation.status.title}
    >
      {label}
    </span>
  );
}
