import type { PullRequestLinkIdentity } from '@kontourai/station-contracts/conversation-pull-request-links';

/** Where a bare number or `owner/repo#n` is read against. */
export interface PullRequestReferenceScope {
  provider?: string;
  host?: string;
  repository?: { owner?: string; name?: string };
}

/**
 * One typed field in place of five (#3045, design round): the identity a
 * pull request link needs, read from what people paste or type.
 *
 * Accepted:
 * - a GitHub pull URL `https://host/owner/repo/pull/42`
 * - a GitLab merge request URL `https://host/group/sub/project/-/merge_requests/42`
 * - `owner/repo#42` against the scope's provider and host
 * - `#42` or `42` against the whole scope
 *
 * The provider of a URL comes from its SHAPE, not its host: `/-/merge_requests/`
 * is GitLab's path on every GitLab, self-managed included, and `/pull/` is
 * GitHub's on GitHub Enterprise too. (The host rule the pull-request pane id
 * uses names gitlab.com alone, which would link a self-managed GitLab as
 * GitHub.) Returns null for anything else; the caller says what it accepts,
 * and never guesses a repository that was not named.
 */
export function parsePullRequestReference(
  input: string,
  scope: PullRequestReferenceScope = {},
): PullRequestLinkIdentity | null {
  const text = input.trim();
  if (!text) return null;
  const url = parseUrl(text);
  if (url) {
    const segments = url.pathname.split('/').filter(Boolean);
    const merge = segments.indexOf('-');
    let owner: string[] = [];
    let name = '';
    let ref = '';
    let provider: 'github' | 'gitlab' = 'github';
    if (
      merge > 0 &&
      segments[merge + 1] === 'merge_requests' &&
      isNumber(segments[merge + 2])
    ) {
      provider = 'gitlab';
      owner = segments.slice(0, merge - 1);
      name = segments[merge - 1] ?? '';
      ref = segments[merge + 2] ?? '';
    } else if (
      segments.length >= 4 &&
      (segments[segments.length - 2] === 'pull' ||
        segments[segments.length - 2] === 'pulls') &&
      isNumber(segments[segments.length - 1])
    ) {
      owner = segments.slice(0, -3);
      name = segments[segments.length - 3] ?? '';
      ref = segments[segments.length - 1] ?? '';
    }
    if (owner.length === 0 || !name || !ref) return null;
    const host = url.host.toLowerCase();
    return {
      provider,
      host,
      repository: { owner: owner.join('/'), name },
      ref,
    };
  }
  const scoped = /^(?:([^\s#/]+(?:\/[^\s#/]+)*)\/([^\s#/]+))?#?(\d+)$/.exec(
    text,
  );
  if (!scoped) return null;
  const [, owner, name, ref] = scoped;
  const provider = scope.provider ?? '';
  const host = scope.host ?? '';
  const repository = {
    owner: owner ?? scope.repository?.owner ?? '',
    name: name ?? scope.repository?.name ?? '',
  };
  if (!provider || !host || !repository.owner || !repository.name) return null;
  return { provider, host, repository, ref: ref! };
}

function parseUrl(text: string): URL | null {
  if (!/^https?:\/\//i.test(text)) return null;
  try {
    return new URL(text);
  } catch {
    return null;
  }
}

const isNumber = (value: string | undefined) =>
  value !== undefined && /^\d+$/.test(value);
