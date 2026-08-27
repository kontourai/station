/**
 * station#1498 slice 1 — `normalizeGitOrigin` as a contract in its own
 * right, independent of the verification-receipt identity path that already
 * exercises it (`scripts/__tests__/verification-receipt.test.ts`).
 * `docs/design/portable-project-identity.md` §3.3 is the source of every
 * row and every named edge case below.
 *
 * DELIBERATE DUPLICATION: `scripts/__tests__/verification-receipt.test.ts`
 * ("collectRepositoryIdentity and toolchain") owns a second, overlapping
 * canonicalization table, because it asserts the same function as the
 * receipt-identity path's dependency rather than as a contract. Keep the two
 * in agreement; if they ever disagree, the disagreement IS the bug — one of
 * the two is asserting a `repositoryId` derivation that no longer holds.
 */

import { describe, expect, test } from 'vitest';
import { normalizeGitOrigin } from '../git-remote-identity.js';

describe('normalizeGitOrigin — §3.3 canonicalization table', () => {
  test.each([
    ['scp-style ssh', 'git@github.com:kontourai/station.git'],
    ['https', 'https://github.com/kontourai/station'],
    ['ssh url', 'ssh://git@github.com/kontourai/station.git'],
    [
      'https with embedded credentials',
      'https://user:token@github.com/kontourai/station/',
    ],
    ['mixed-case host and path', 'https://GitHub.com/KontourAI/Station'],
  ])('%s canonicalizes to github.com/kontourai/station', (_label, url) => {
    expect(normalizeGitOrigin(url)).toBe('github.com/kontourai/station');
  });
});

describe('normalizeGitOrigin — named edge cases (§3.3)', () => {
  test('(a) an SSH host alias does NOT collapse to the host it aliases — a binding concern, not a canonicalization one', () => {
    // §3.3(a): `git@github-work:kontourai/station.git` canonicalizes to
    // `github-work/kontourai/station` and matches nothing manifest-side.
    // Rewriting a host alias to its real host is machine-local knowledge and
    // belongs in the binding store's `hostAliases` map, applied BEFORE this
    // function runs — never inside it.
    expect(normalizeGitOrigin('git@github-work:kontourai/station.git')).toBe(
      'github-work/kontourai/station',
    );
  });

  test('(b) a fork and its upstream canonicalize to distinct ids — matching is set-intersection at the binding layer, not collapsing here', () => {
    // §3.3(b): a personal fork's `origin` and its `upstream` are two
    // different remotes and must stay two different canonical ids. The
    // binding layer records the checkout's FULL remote set and matches by
    // set-intersection against a manifest resource's
    // `{ canonicalRemote } ∪ aliases` — this function never merges them.
    const fork = normalizeGitOrigin('git@github.com:brian/station.git');
    const upstream = normalizeGitOrigin('git@github.com:kontourai/station.git');
    expect(fork).toBe('github.com/brian/station');
    expect(upstream).toBe('github.com/kontourai/station');
    expect(fork).not.toBe(upstream);
  });

  test('(c) case sensitivity collapses Org/Repo and org/repo — an ACCEPTED, RECORDED LIMITATION, not a bug', () => {
    // §3.3 residual case: lowercasing is right for every major forge and
    // wrong in principle for a case-sensitive host. The accepted failure
    // mode is two distinct case-sensitive repos colliding on one id, which
    // requires a host that actually serves both — recorded as a known
    // limitation, not designed around.
    expect(normalizeGitOrigin('https://github.com/Org/Repo')).toBe(
      normalizeGitOrigin('https://github.com/org/repo'),
    );
    expect(normalizeGitOrigin('https://github.com/Org/Repo')).toBe(
      'github.com/org/repo',
    );
  });
});

describe('normalizeGitOrigin — degenerate inputs', () => {
  test.each([
    ['empty string', ''],
    ['whitespace only', '   \t  '],
    ['undefined', undefined],
    ['null', null],
    ['a number', 42],
    ['an object', { url: 'git@github.com:kontourai/station.git' }],
  ])('%s normalizes to the empty string', (_label, value) => {
    expect(normalizeGitOrigin(value)).toBe('');
  });
});

describe('normalizeGitOrigin — file:// and trailing-slash / trailing-.git combinations', () => {
  // The file:// row below is this function's behavior, and it is CORRECT and
  // must not change (decision 1: byte-for-byte identical to the promoted
  // original). It is also a manifest leak waiting to happen: the result is an
  // absolute filesystem path, and re-running this function on it is a no-op,
  // so it satisfies `normalizeGitOrigin(canonicalRemote) === canonicalRemote`
  // and would pass a naive already-canonical check. What stops it reaching a
  // manifest is a VALIDATOR rule, not this function —
  // `validateProjectManifest` refuses a `git` resource whose canonicalRemote
  // or alias matches an absolute/tilde path (`project-identity.ts` decision
  // 3; asserted in `project-identity.test.ts`, "§3.2 — a local filesystem
  // path can never reach a git resource"). A local clone source is a
  // `local-only` resource, not a portable `git` one.
  test.each([
    [
      'file:// URL',
      'file:///Users/brian/dev/station',
      '/users/brian/dev/station',
    ],
    [
      'trailing slash only',
      'https://github.com/kontourai/station/',
      'github.com/kontourai/station',
    ],
    [
      'trailing .git only',
      'https://github.com/kontourai/station.git',
      'github.com/kontourai/station',
    ],
    [
      'trailing .git then trailing slash',
      'https://github.com/kontourai/station.git/',
      'github.com/kontourai/station',
    ],
    [
      'multiple trailing slashes',
      'https://github.com/kontourai/station///',
      'github.com/kontourai/station',
    ],
  ])('%s -> %s', (_label, url, expected) => {
    expect(normalizeGitOrigin(url)).toBe(expected);
  });
});
