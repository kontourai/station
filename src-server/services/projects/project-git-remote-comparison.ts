import { normalizeGitOrigin } from '@kontourai/station-contracts/git-remote-identity';
import { isLocalCloneSource } from '@kontourai/station-contracts/project-identity';
import {
  applyHostAlias,
  canonicalizeCheckoutRemotes,
} from './project-binding-store.js';

export const PROJECT_GIT_REMOTE_COMPARISON_UNAVAILABLE =
  'A repository remote has an unsupported or ambiguous identity. Use an explicit SSH/HTTPS URL or a supported repository alias before verifying this checkout.';

/**
 * Comparison only: stored resource IDs and verification-receipt repository IDs
 * retain normalizeGitOrigin's existing bytes. Historical non-git SSH users and
 * bracketed IPv6 hosts can leave host:path in those IDs instead of host/path.
 * Numeric authority suffixes remain ports; they never alias the default host.
 */
function comparisonKey(identity: string): string | undefined {
  // The legacy git@ rewrite also consumed the first colon inside [IPv6].
  // Repair that spelling only in this comparison and validate the resulting IP.
  const comparable = identity.replace(
    /^(\[[^/\]]*)\/([^\]]*\])(?=[:/])/,
    '$1:$2',
  );
  if (
    isLocalCloneSource(comparable) ||
    /[\s\\@?#]/.test(comparable) ||
    /(?:^|\/)\.{1,2}(?:\/|$)/.test(comparable)
  ) {
    return undefined;
  }
  const parts = /^(\[[^\]]+\]|[^/:]+)([:/])(.+)$/.exec(comparable);
  if (!parts) return undefined;
  const [, host, separator, rest] = parts;
  let authority = host;
  let path = rest;
  if (separator === ':' && /^\d+(?:\/|$)/.test(rest)) {
    const slash = rest.indexOf('/');
    if (slash < 0) return undefined;
    authority = `${host}:${rest.slice(0, slash)}`;
    path = rest.slice(slash + 1);
  }
  if (!path || path.startsWith('/')) return undefined;
  try {
    // URL validates bracketed IPv6 and port bounds. Keep the original authority
    // bytes: URL's default-port removal must not change the persisted convention.
    const parsed = new URL(`ssh://${authority}/${path}`);
    if (parsed.username || parsed.password || !parsed.hostname)
      return undefined;
  } catch {
    return undefined;
  }
  return `${authority}/${path}`;
}

function supportedCheckoutUrl(url: string, identity: string): boolean {
  if (/[\s\\?#]/.test(url) || /^[a-z][a-z0-9+.-]*::/i.test(url)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    try {
      const parsed = new URL(url);
      return ['ssh:', 'https:', 'http:', 'git:'].includes(parsed.protocol);
    } catch {
      return false;
    }
  }
  // The old canonical form cannot distinguish a non-git-user SCP repository
  // beginning with digits from a host:port URL. Require an explicit URL rather
  // than treating that SCP path as a port. Ordinary git@host:path stays supported.
  return !/^(?:\[[^\]]+\]|[^/:]+):\d+(?:\/|$)/.test(identity);
}

export function compareProjectGitRemotes(
  remoteUrls: string[],
  hostAliases: Record<string, string>,
  manifestRemotes: string[],
): {
  outcome: 'matched' | 'different' | 'unverifiable';
  checkoutRemotes: string[];
} {
  const checkoutRemotes = canonicalizeCheckoutRemotes(remoteUrls, hostAliases);
  let unsupported = false;
  const checkoutKeys = new Set<string>();
  for (const raw of remoteUrls) {
    const url = applyHostAlias(raw.trim(), hostAliases);
    if (!url) continue;
    const identity = normalizeGitOrigin(url);
    const key = supportedCheckoutUrl(url, identity)
      ? comparisonKey(identity)
      : undefined;
    if (key) checkoutKeys.add(key);
    else unsupported = true;
  }
  for (const identity of manifestRemotes) {
    const key = comparisonKey(identity);
    if (key && checkoutKeys.has(key)) {
      return { outcome: 'matched', checkoutRemotes };
    }
    if (!key) unsupported = true;
  }
  return {
    outcome: unsupported ? 'unverifiable' : 'different',
    checkoutRemotes,
  };
}
