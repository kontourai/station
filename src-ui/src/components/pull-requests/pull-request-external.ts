/**
 * What the "open elsewhere" action is called for a pull request's URL: the
 * forge by name where Station knows it, else the browser. Derived from the
 * URL the provider supplied, so the label names where the click goes.
 */
export function pullRequestExternalLabel(url: string): string {
  const name = pullRequestHostName(url);
  return name ? `Open on ${name}` : 'Open in browser';
}

/**
 * "GitHub" or "GitLab" for the two hosts Station names, else null. gitlab.com
 * only: any `gitlab.*` host is a name anyone can register, and a self-managed
 * instance is not "GitLab" to the reader either way.
 */
export function pullRequestHostName(url: string): string | null {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (hostname === 'github.com' || hostname.endsWith('.github.com'))
    return 'GitHub';
  if (hostname === 'gitlab.com' || hostname === 'www.gitlab.com')
    return 'GitLab';
  return null;
}
