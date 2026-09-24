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
function forgeForHost(host: string): Forge | null {
  const canonical = host.toLowerCase().replace(/\.$/, '');
  if (canonical === 'github.com' || canonical === 'www.github.com')
    return 'github';
  if (canonical === 'gitlab.com' || canonical === 'www.gitlab.com')
    return 'gitlab';
  return null;
}

function ForgeMark({ forge }: { forge: Forge }) {
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
function forgeUrlLabel(url: string): string | null {
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

/**
 * Suffixes that read as file extensions, not top-level domains. Consulted
 * only for BARE text (no scheme, path, port or `www.`), and only for a link
 * to an ordinary external site: `logo.png` or `go.mod` names a file, and
 * treating it as a host claim would decorate ordinary prose.
 */
const FILE_LIKE_SUFFIXES = new Set(
  (
    'asp aspx bat bmp c cc cfg cjs conf cpp cs css csv dart db dll doc docx ' +
    'env exe gif go gradle h hpp htm html ico ini ipynb jar java jpeg jpg js ' +
    'json jsx kt kts less lock log lua md mdx mjs mod mp3 mp4 net pdf php pl ' +
    'plist png ps1 py pyc rb rs sass scss sh sql sqlite sum svelte svg swift ' +
    'tar tf tgz toml ts tsv tsx txt vue wasm wav webp xls xlsx xml yaml yml zip'
  ).split(' '),
);

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
/** Dotted labels ending in a letter TLD, a punycode TLD, or a Unicode one. */
const DOMAIN = /^(?:[\p{L}\p{N}-]+\.)+(?:\p{L}{2,}|xn--[a-z0-9-]+)$/u;

interface HostClaim {
  /** The host as the text shows it, lower-cased, without a port. */
  host: string;
  /** The port the text writes, or null when it writes none. */
  port: string | null;
  /** The text starts with `http://` or `https://`. */
  scheme: boolean;
  /** A `/` follows the authority: the text reads as a URL, not a name. */
  path: boolean;
}

/**
 * The host a link's VISIBLE TEXT claims, or null when the text does not read
 * as a URL or host: `https://github.com/o/r`, `www.github.com`,
 * `github.com/o/r`, `github.com:443`, `localhost:3000`, `127.0.0.1` and a
 * bare `github.com` do; `the fix` and `src/app.ts` do not. Whether a claim
 * COUNTS for a given link is `mismatchedLinkHost`'s decision.
 *
 * The authority is read from the text as a reader sees it, not as a URL
 * parser would: in `https://github.com@evil.test` the parser's host is
 * `evil.test` (the rest is userinfo), but the reader sees `github.com`, so
 * the part before `@` is the claim. Without a scheme, `@` makes the text an
 * address, not a host. IPv6 literals are not recognised.
 */
function claimedHost(text: string): HostClaim | null {
  const value = text.trim();
  if (!value || /\s/.test(value)) return null;
  const scheme = /^https?:\/\//i.exec(value);
  const rest = scheme ? value.slice(scheme[0].length) : value;
  const end = rest.search(/[/?#]/);
  let authority = end === -1 ? rest : rest.slice(0, end);
  const at = authority.indexOf('@');
  if (at !== -1) {
    if (!scheme) return null;
    authority = authority.slice(0, at);
  }
  const match = /^(.+?)(?::(\d{1,5}))?$/.exec(authority);
  if (!match) return null;
  const host = match[1]!.toLowerCase().replace(/\.$/, '');
  if (host !== 'localhost' && !IPV4.test(host) && !DOMAIN.test(host))
    return null;
  return {
    host,
    port: match[2] ?? null,
    scheme: !!scheme,
    path: end !== -1 && rest[end] === '/',
  };
}

/**
 * Whether a claim counts for this link. Text with a scheme always does.
 * Scheme-less text is ambiguous between a host and a file or identifier —
 * `app.ts:42`, `README.md#install` and `package.json?plain=1` split into a
 * "host" and a suffix exactly as `github.com:443/x` does — so:
 *
 * - a scheme-less host whose last label reads as a file extension is a file
 *   name, whatever follows it (`www.` hosts excepted: no file starts so);
 * - for a pull request or forge file, whose text is usually a file, ref or
 *   path, only scheme-less text with a `/` path counts (`github.com/o/r`);
 * - for an ordinary external site, bare text (`github.com`, `1.2.3.4`)
 *   counts too.
 *
 * Known limit: a dotted code identifier on an external link
 * (`Array.prototype.map`, `os.path.join`) reads as a host and gets a badge.
 */
function claimCounts(claim: HostClaim, external: boolean): boolean {
  if (claim.scheme) return true;
  if (!claim.host.startsWith('www.')) {
    const suffix = claim.host.slice(claim.host.lastIndexOf('.') + 1);
    if (FILE_LIKE_SUFFIXES.has(suffix)) return false;
  }
  return external || claim.path;
}

/** `host[:port]` normalised as the URL parser would, for comparison. */
function normalisedAuthority(authority: string, protocol: string) {
  try {
    const url = new URL(`${protocol}//${authority}`);
    return {
      host: url.hostname.replace(/\.$/, '').replace(/^www\./, ''),
      port: url.port,
    };
  } catch {
    return null;
  }
}

/**
 * The host a link REALLY goes to, when its visible text names a different
 * one (`[github.com/o/r](https://evil.test/x)`), else null. A WebView shows no
 * status-bar URL on hover, so without this the reader has no signal before
 * clicking. `www.` is not a difference; a subdomain or a Unicode look-alike
 * (compared in its punycode form) is. A port is compared only when the text
 * writes one (`github.com:8443` against `github.com:9000`; a default port such
 * as `:443` on https equals none). Text that does not read as a host returns
 * null: prose link text is not a claim.
 *
 * `external` is true for a link to an ordinary external site, false for a
 * pull request or forge file; `claimCounts` says what it changes.
 */
export function mismatchedLinkHost(
  text: string,
  url: string,
  external: boolean,
): string | null {
  const claim = claimedHost(text);
  if (!claim || !claimCounts(claim, external)) return null;
  let real: URL;
  try {
    real = new URL(url);
  } catch {
    return null;
  }
  const claimed = normalisedAuthority(
    claim.port === null ? claim.host : `${claim.host}:${claim.port}`,
    real.protocol,
  );
  if (!claimed) return null;
  const actual = {
    host: real.hostname.replace(/\.$/, '').replace(/^www\./, ''),
    port: real.port,
  };
  // Text that writes no port promises none: `[localhost](http://localhost:5173)`
  // names the host it goes to. A port the text DOES write must match.
  const portMatches = claim.port === null || claimed.port === actual.port;
  return claimed.host === actual.host && portMatches ? null : real.host;
}

/**
 * The real host beside the link text, for `mismatchedLinkHost`. The visible
 * `(evil.test)` is hidden from assistive technology and replaced by a
 * sentence that says what it means, so a screen reader hears where the link
 * goes rather than a parenthetical it must interpret. The sentence is not
 * selectable, so copying the link yields the visible text alone.
 */
export function LinkHostBadge({ host }: { host: string }) {
  return (
    <span className="chat-link-host">
      <span aria-hidden="true"> ({host})</span>
      <span className="chat-link-host__sr sr-only">, goes to {host}</span>
    </span>
  );
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
