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
  | {
      /**
       * A file on a forge (`/<owner>/<repo>/blob/<ref>/<path>`). It is only a
       * LOCAL file once the conversation's project is known to be that
       * repository — the anchor decides that, not this classifier.
       */
      kind: 'repo-file';
      host: string;
      owner: string;
      repository: string;
      /** The branch, tag or commit the URL shows the file at. */
      ref: string;
      path: string;
      lineRange?: WorkspaceFilePreviewLineRange;
      url: string;
    }
  | { kind: 'external'; url: string };

export interface MarkdownLinkClassifyOptions {
  /**
   * Absolute directories the conversation's files live under (the project's
   * checkout, the session's worktree). An absolute path or `file://` URL
   * inside one of them is that file, relative to it; anything else absolute
   * stays unplaced. Without roots no absolute path is ever a file link.
   */
  roots?: readonly string[];
}

/**
 * The two path shapes Station's two providers publish a review under:
 * `/<owner>/<repo>/pull/<n>` (GitHub and every GitHub-shaped host) and
 * `/<owner>/<repo>/merge_requests/<n>` (GitLab, whose own URLs carry a
 * `/-/` segment before it). Which PROVIDER serves the host is not decided
 * here — `pullRequestProviderForHost` owns that, from the host alone.
 */
const PULL_REQUEST_PATH =
  /^\/([^/]+)\/([^/]+)(?:\/-)?\/(?:pull|merge_requests)\/(\d{1,12})(?:\/.*)?$/;

/**
 * A forge's file view: GitHub's `/<owner>/<repo>/blob/<ref>/<path>` and
 * GitLab's `/<owner>/<repo>/-/blob/<ref>/<path>`. The ref is taken as ONE
 * segment (a sha, a tag, a simple branch); a branch name with a slash in it
 * is indistinguishable from a directory here and shifts the path by a
 * segment, which the preview then reports as a missing file.
 */
const REPO_FILE_PATH = /^\/([^/]+)\/([^/]+)(?:\/-)?\/blob\/([^/]+)\/(.+)$/;

/**
 * The `:12`, `:12:5` and `:12-34` suffixes a model (and most terminals) write
 * after a path. Column numbers are accepted and dropped: a preview addresses
 * lines.
 */
const LINE_SUFFIX = /:(\d{1,9})(?::\d{1,9}|-(\d{1,9}))?$/;

/** `#L12` or `#L12-L34` — the line anchor both forges append to a file URL. */
const LINE_ANCHOR = /^L(\d{1,9})(?:-L?(\d{1,9}))?$/;

function lineRangeFromHash(
  hash: string,
): WorkspaceFilePreviewLineRange | undefined {
  const match = LINE_ANCHOR.exec(hash);
  if (!match) return undefined;
  const start = Number(match[1]);
  return lineRangeFrom(
    start,
    match[2] === undefined ? start : Number(match[2]),
  );
}

function lineRangeFrom(
  start: number,
  end: number,
): WorkspaceFilePreviewLineRange | undefined {
  if (
    start < 1 ||
    end < start ||
    end - start + 1 > WORKSPACE_FILE_PREVIEW_MAX_LINES
  )
    return undefined;
  return { start, end };
}

/**
 * `path` relative to the first root it is inside, or null. Roots are compared
 * as literal path prefixes on a segment boundary — no normalization — so a
 * root of `/a/b` never claims `/a/bc/x`, and a path with `..` in it is refused
 * afterwards by the relative-path validator rather than resolved here.
 */
function relativeToRoot(
  absolute: string,
  roots: readonly string[],
): string | null {
  for (const raw of roots) {
    const root = raw.replace(/\/+$/, '');
    if (!root) continue;
    if (absolute.startsWith(`${root}/`)) return absolute.slice(root.length + 1);
  }
  return null;
}

/**
 * A path-and-position string (`src/a.ts`, `src/a.ts:12`, `./src/a.ts#L3`,
 * `/abs/root/src/a.ts:4-9`) as a `path` target, or null when it is not a file
 * inside the conversation's checkout. Shared by explicit markdown links and
 * by path mentions in prose, so both spell a position the same way.
 */
function classifyPathReference(
  value: string,
  options: MarkdownLinkClassifyOptions = {},
): Extract<MarkdownLinkTarget, { kind: 'path' }> | null {
  let rest = value;
  let lineRange: WorkspaceFilePreviewLineRange | undefined;
  const hash = rest.indexOf('#');
  if (hash !== -1) {
    lineRange = lineRangeFromHash(rest.slice(hash + 1));
    rest = rest.slice(0, hash);
  }
  const suffix = LINE_SUFFIX.exec(rest);
  if (suffix) {
    const start = Number(suffix[1]);
    const end = suffix[2] === undefined ? start : Number(suffix[2]);
    lineRange ??= lineRangeFrom(start, end);
    rest = rest.slice(0, suffix.index);
  }
  if (rest.startsWith('/')) {
    const relative = relativeToRoot(rest, options.roots ?? []);
    if (relative === null) return null;
    rest = relative;
  } else if (rest.startsWith('./')) {
    // `./` names the directory the path is relative to, not a traversal.
    rest = rest.slice(2);
  }
  if (!isWorkspaceFilePreviewRelativePath(rest)) return null;
  return { kind: 'path', path: rest, ...(lineRange ? { lineRange } : {}) };
}

/**
 * What one `href` in a rendered chat message names, or null for an href no
 * placement applies to.
 *
 * Absolute URLs are parsed rather than pattern-matched, so a host is a host:
 * `https://evil.test/x?u=https://github.com/o/r/pull/1` is external, and
 * `https://github.com/o/r/pull/1?diff=split#discussion` is the same pull
 * request as the bare one — the query and the fragment are not part of a
 * review's identity. Only `http`/`https` are URLs; `mailto:`, `file:`,
 * `javascript:` and every other scheme resolve to null, which leaves the
 * anchor exactly as the markdown renderer built it. (A `file:` link never
 * reaches here with its href anyway: react-markdown's URL transform blanks
 * it.)
 */
export function classifyMarkdownLink(
  href: string | undefined,
  options: MarkdownLinkClassifyOptions = {},
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
    if (match) {
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
    const file = REPO_FILE_PATH.exec(url.pathname);
    if (file) {
      const [, owner, repository, ref, encodedPath] = file as unknown as [
        string,
        string,
        string,
        string,
        string,
      ];
      let path: string;
      try {
        path = decodeURIComponent(encodedPath);
      } catch {
        return { kind: 'external', url: url.href };
      }
      if (!isWorkspaceFilePreviewRelativePath(path))
        return { kind: 'external', url: url.href };
      const lineRange = lineRangeFromHash(url.hash.slice(1));
      return {
        kind: 'repo-file',
        host: url.host,
        owner,
        repository,
        ref,
        path,
        ...(lineRange ? { lineRange } : {}),
        url: url.href,
      };
    }
    return { kind: 'external', url: url.href };
  }
  // Relative from here down. A protocol-relative `//host/path` is a URL
  // without a scheme, not a path, and Station does not guess which scheme a
  // model meant. An absolute path is a file only inside a known root.
  if (href.startsWith('//') || href.startsWith('#')) return null;
  return classifyPathReference(href, options);
}
