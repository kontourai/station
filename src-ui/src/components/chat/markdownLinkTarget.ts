import {
  isWorkspaceFilePreviewRelativePath,
  WORKSPACE_FILE_PREVIEW_MAX_LINES,
  type WorkspaceFilePreviewLineRange,
} from '@kontourai/station-contracts/workspace-file-preview';
import type { WorkspacePullRequestPaneKey } from '@kontourai/station-contracts/workspace-pull-request-pane';

/**
 * What a link in a chat message names (#2049).
 *
 * Three answers, and the third is the important one: `external` is a positive
 * classification (an absolute URL that is not a pull request), not "everything
 * left over". An href this cannot place — a bare fragment, an empty href, a
 * path with `..`, a `javascript:` scheme — resolves to `null`, and a null
 * target is an anchor Station does not touch at all. The alternative, treating
 * anything unrecognised as external and handing it to the host's browser,
 * would make a model's typo a navigation.
 */
export type MarkdownLinkTarget =
  | { kind: 'pull-request'; key: WorkspacePullRequestPaneKey; url: string }
  | {
      kind: 'path';
      path: string;
      lineRange?: WorkspaceFilePreviewLineRange;
    }
  | { kind: 'external'; url: string };

/**
 * The two path shapes Station's two providers publish a review under:
 * `/<owner>/<repo>/pull/<n>` (GitHub and every GitHub-shaped host) and
 * `/<owner>/<repo>/merge_requests/<n>` (GitLab, whose own URLs carry a
 * `/-/` segment before it). Which PROVIDER serves the host is not decided
 * here — `pullRequestProviderForHost` owns that, from the host alone.
 */
const PULL_REQUEST_PATH =
  /^\/([^/]+)\/([^/]+)(?:\/-)?\/(?:pull|merge_requests)\/(\d{1,12})(?:\/.*)?$/;

/** `#L12` or `#L12-L34` — the line anchor both forges append to a file URL. */
const LINE_ANCHOR = /^L(\d{1,9})(?:-L?(\d{1,9}))?$/;

function lineRangeFromHash(
  hash: string,
): WorkspaceFilePreviewLineRange | undefined {
  const match = LINE_ANCHOR.exec(hash);
  if (!match) return undefined;
  const start = Number(match[1]);
  const end = match[2] === undefined ? start : Number(match[2]);
  if (
    start < 1 ||
    end < start ||
    end - start + 1 > WORKSPACE_FILE_PREVIEW_MAX_LINES
  )
    return undefined;
  return { start, end };
}

/**
 * What one `href` in a rendered chat message names, or null for an href no
 * placement applies to.
 *
 * Absolute URLs are parsed rather than pattern-matched, so a host is a host:
 * `https://evil.test/x?u=https://github.com/o/r/pull/1` is external, and
 * `https://github.com/o/r/pull/1?diff=split#discussion` is the same pull
 * request as the bare one — the query and the fragment are not part of a
 * review's identity. Only `http`/`https` are URLs at all; `mailto:`,
 * `javascript:` and every other scheme resolve to null, which leaves the
 * anchor exactly as the markdown renderer built it.
 */
export function classifyMarkdownLink(
  href: string | undefined,
): MarkdownLinkTarget | null {
  if (!href) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) {
    let url: URL;
    try {
      url = new URL(href);
    } catch {
      return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const match = PULL_REQUEST_PATH.exec(url.pathname);
    if (!match) return { kind: 'external', url: url.href };
    const [, owner, repository, ref] = match as unknown as [
      string,
      string,
      string,
      string,
    ];
    return {
      kind: 'pull-request',
      key: { host: url.host, owner, repository, ref },
      url: url.href,
    };
  }
  // Relative from here down. A protocol-relative `//host/path` is a URL
  // without a scheme, not a path, and Station does not guess which scheme a
  // model meant.
  if (href.startsWith('//') || href.startsWith('/') || href.startsWith('#'))
    return null;
  const hash = href.indexOf('#');
  const path = hash === -1 ? href : href.slice(0, hash);
  if (!isWorkspaceFilePreviewRelativePath(path)) return null;
  const lineRange =
    hash === -1 ? undefined : lineRangeFromHash(href.slice(hash + 1));
  return { kind: 'path', path, ...(lineRange ? { lineRange } : {}) };
}
