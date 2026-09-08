/**
 * Repo-relative paths that mean the same string on every platform.
 *
 * `path.join` and `path.relative` emit the platform separator, so on Windows
 * they produce `src-server\routes\x.ts` where every committed allowlist,
 * expected-findings fixture, and human-written reference says
 * `src-server/routes/x.ts`. Anywhere such a path becomes an IDENTITY -- a key
 * matched against reviewed entries, or a finding string asserted by a test --
 * the platform separator silently changes the value being compared and the
 * check reports something that is not true (#1093).
 *
 * Use this at the point a filesystem path becomes a repo-relative identity.
 * It is not for paths handed back to the filesystem: Node accepts forward
 * slashes on Windows, but there is no reason to normalize a path that is
 * only ever opened.
 */
export function toPosixPath(value) {
  return String(value).replaceAll('\\', '/');
}
