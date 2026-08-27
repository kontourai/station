// LOAD-BEARING RUNTIME CONSTRAINT: this module is imported by
// `scripts/lib/test-reliability.mjs`, which plain Node loads directly (no
// bundler, no ts-node) from `scripts/run-verification.mjs` and from real
// child processes in `scripts/__tests__/verification-receipt.test.ts`. It
// must therefore stay TYPE-STRIPPABLE (no `enum`, no `namespace`, no
// parameter properties, no other construct that needs emit) and free of
// RELATIVE IMPORTS. Its sibling `project-identity.ts` already cannot load
// under plain Node — `ERR_MODULE_NOT_FOUND` on `./git-remote-identity.js` —
// so adding a relative import here breaks `ci:fast` at module load with a
// cause that does not name this file.

/**
 * station#1498 slice 1 — pure git-remote canonicalization
 * (`docs/design/portable-project-identity.md` §2.4, §3.3).
 *
 * `normalizeGitOrigin` is promoted verbatim out of
 * `scripts/lib/test-reliability.mjs:224-235`, where it already backs
 * {@link https://github.com/kontourai/station | every verification receipt's}
 * `repositoryId` derivation
 * (`collectRepositoryIdentity`, `scripts/lib/test-reliability.mjs:284-320`).
 * That file now re-exports this module instead of carrying a second copy —
 * see its docblock for why the copy would have silently invalidated every
 * existing receipt.
 *
 * Load-bearing decisions:
 *
 * 1. **Byte-for-byte identical algorithm to the promoted original.** This is
 *    not a rewrite. The verification-receipt identity path
 *    (`scripts/__tests__/verification-receipt.test.ts`) already asserts this
 *    function's behavior against real git remotes; changing so much as the
 *    order of two `replace` calls changes every `repositoryId` a consumer has
 *    ever recorded. `git-remote-identity.test.ts` re-asserts the same table
 *    independently, as a contract in its own right rather than as a receipt
 *    implementation detail.
 * 2. **Pure and deterministic — no filesystem, no `~/.ssh/config`, no
 *    network** (§3.3). Every member of a shared manifest must derive the same
 *    canonical id from the same remote string; anything machine-dependent
 *    (an SSH host alias, a local git config) is by definition a *binding*
 *    concern, not a canonicalization concern, and does not belong in this
 *    function. See the module for `ProjectBinding.remotes` for where a
 *    binding's host-alias rewriting is applied instead, *before* calling this
 *    function.
 * 3. **Case-insensitive on purpose, and it is a recorded, accepted
 *    limitation, not an oversight** (§3.3 residual case). Lowercasing is
 *    correct for every major forge and wrong in principle for a
 *    case-sensitive host; the accepted failure mode is two distinct
 *    case-sensitive repos colliding on one canonical id, which requires a
 *    host that actually serves both. See the test file's dedicated case for
 *    the citation of this tradeoff.
 * 4. **Two cases this function deliberately does NOT collapse, each handled
 *    at a different layer** (§3.3): an SSH host alias
 *    (`git@github-work:org/repo.git`) does not resolve to the host it
 *    aliases — that rewrite is machine-local knowledge and belongs in the
 *    binding store's `hostAliases` map, applied before calling this
 *    function. And two different remotes (a fork's `origin` vs its
 *    `upstream`) canonicalize to two different, non-colliding ids — matching
 *    across them is set-intersection at the binding layer, not collapsing
 *    here. Both are asserted as documented behavior, not bugs, in
 *    `git-remote-identity.test.ts`.
 */

/**
 * Normalizes a git remote URL to a canonical, clone-path-independent form so
 * the same repository cloned over SSH, HTTPS, or with `.git`/credentials
 * derives one stable identity. Returns the empty string for a non-string,
 * empty, or whitespace-only input.
 */
export function normalizeGitOrigin(url: unknown): string {
  if (typeof url !== 'string') return '';
  let normalized = url.trim();
  if (normalized.length === 0) return '';
  normalized = normalized.replace(/^(?:https?|git|ssh|file):\/\//i, '');
  normalized = normalized.replace(/^git@([^:/]+):/i, '$1/');
  normalized = normalized.replace(/^[^/@]+@/, '');
  normalized = normalized.replace(/\/+$/, '');
  normalized = normalized.replace(/\.git$/i, '');
  normalized = normalized.replace(/\/+$/, '');
  return normalized.toLowerCase();
}
