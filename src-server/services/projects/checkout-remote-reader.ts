/**
 * archive#1499 — reading a local checkout's git remotes
 * (`docs/design/portable-project-identity.md` §3.3(a)/(b), §5).
 *
 * Two consumers, one reader: manifest backfill derives a project's `repos`
 * from the checkout's `origin` (§5), and the resolver re-reads the checkout's
 * full remote set on every resolution to decide `bound` vs `drifted` (§3.6).
 *
 * Load-bearing decisions:
 *
 * 1. **Every git invocation goes through `git-exec.ts`.** An inherited
 *    `GIT_DIR`/`GIT_WORK_TREE` silently retargets a spawned `git` at another
 *    repository, which has caused real `core.bare` corruption here (archive#104).
 *    `execGit` strips both and sets `windowsHide: true`; a raw `execFile`
 *    would reintroduce the bug this module cannot afford.
 * 2. **"This directory has no remotes" and "git could not be run" are
 *    DIFFERENT answers, and collapsing them is a default that decides**
 *    (`docs/guides/code-quality.md`, "a default that decides"). An empty
 *    remote set participates in the drift decision — no intersection with the
 *    manifest means `drifted`. If a missing `git` binary returned `[]`, every
 *    bound resource on that host would confidently report a repository
 *    identity change that never happened. So the result is a discriminated
 *    union and the caller must handle the unverifiable case explicitly.
 * 3. **Exit 128 means "git refused", NOT "this is not a repository", so it is
 *    never accepted on its own.** Measured on git 2.50.1, all five of these
 *    exit 128: a plain non-repo directory; a real repo whose `.git/config` is
 *    unreadable; a real repo whose `.git` is unreadable; a repo with `.git/HEAD`
 *    removed; a repo with a malformed `.git/config`. Only the first is "no
 *    remotes"; the rest are failures to observe. Parsing the message text
 *    instead is no better — it is translatable and not a contract. So exit 128
 *    is downgraded to `{ ok: true, remotes: [] }` ONLY when non-repo-ness is
 *    positively confirmed by {@link findGitEntryOnPath}: no `.git` entry exists
 *    anywhere from the path up to the filesystem root. If one does, git had a
 *    repository in view and refused for some other reason, and this returns
 *    `ok: false`.
 *
 *    This matters because the misclassification happens BEFORE any consumer's
 *    mitigation can see it: a checkout whose config went unreadable would be
 *    read as a successful observation of zero remotes, which the backfill
 *    persists as `local-only` forever and the resolver reports as `drifted`
 *    ("advertises no remotes") — a confident assertion that a repository's
 *    identity changed, about a repository that never changed.
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execGit } from '../../utils/git-exec.js';

export interface CheckoutRemote {
  /** Remote name as git reports it (`origin`, `upstream`, …). */
  name: string;
  /** Remote URL EXACTLY as configured — un-aliased and un-canonicalized. */
  url: string;
}

export type CheckoutRemotesResult =
  | { ok: true; remotes: CheckoutRemote[] }
  /** Verification could not be performed at all — never confused with "no remotes". */
  | { ok: false; reason: string };

export interface CheckoutRemoteReadOptions {
  /**
   * Wall-clock bound on the spawned `git`. See
   * {@link DEFAULT_CHECKOUT_REMOTE_TIMEOUT_MS} for why this exists and why it
   * is a parameter rather than a constant buried in `execGit`.
   */
  timeoutMs?: number;
}

export type CheckoutRemoteReader = (
  absolutePath: string,
  options?: CheckoutRemoteReadOptions,
) => Promise<CheckoutRemotesResult>;

/**
 * archive#1501 review, FIX 3.
 *
 * `git remote -v` reads `.git/config` in `absolutePath`. When that directory
 * lives on a stale network mount (an unreachable NFS/SMB server, a
 * disconnected sshfs), the read blocks in the kernel and `git` never exits.
 * `execGit` passes no `timeout`, so the returned promise never settles, and
 * every awaiting caller inherits that: the resolver's resolution never
 * completes, and `AttachedSessionFollowService.poll()` — which resolves every
 * project's root on a 2s interval behind a single-flight `activePoll` guard —
 * stops discovering sessions permanently, with no log and no metric.
 *
 * A bounded read turns "never" into an ordinary `{ ok: false }`, which every
 * caller already handles: the resolver reports `stale` ("could not verify"),
 * and the follow service keeps the project's stored `workingDirectory` as its
 * candidate root.
 *
 * **Why a parameter here, not a default inside `execGit`.** `execGit` is the
 * single sanitized-environment chokepoint for *every* git invocation in
 * Station, including `clone`, `fetch`, and `worktree add` — operations whose
 * legitimate runtime is minutes. A default timeout there would silently kill
 * them, so the bound belongs at the call site that knows the operation is a
 * sub-second local config read. Named and defaulted rather than inlined so a
 * caller on a genuinely slow filesystem can raise it without editing this
 * module.
 *
 * Five seconds is ~3 orders of magnitude above the observed local cost of
 * `git remote -v` (single-digit ms), so it cannot fire on a healthy host; it
 * exists only to bound the pathological case.
 *
 * **Residual, disclosed:** `execFile`'s timeout delivers SIGTERM. A process
 * wedged in an uninterruptible kernel wait (classic hard-mount NFS `D` state)
 * does not die on a signal, and the promise still will not settle. Bounding
 * that would need a detached watchdog, which is out of scope here; the common
 * cases (soft mounts, sshfs, an unreachable host after the TCP layer gives up)
 * are all killable.
 */
export const DEFAULT_CHECKOUT_REMOTE_TIMEOUT_MS = 5_000;

/**
 * `git` exits with this both when the cwd is not inside a repository AND when
 * it found a repository it could not read. See decision 3 — the code alone is
 * never enough to tell those apart.
 */
const GIT_REFUSED_EXIT_CODE = 128;

/**
 * Walks from `startPath` up to the filesystem root looking for a `.git` entry
 * (a directory, or the file a worktree/submodule uses). Returns the first one
 * found, or `undefined` when there is none — which is the only positive
 * confirmation available that a directory is genuinely not in a repository.
 */
export function findGitEntryOnPath(startPath: string): string | undefined {
  let current = resolve(startPath);
  for (;;) {
    // `existsSync` stats the candidate, which needs no permission on `.git`
    // itself — only on its parent. A `.git` directory with mode 000 (one of
    // the measured exit-128 shapes) is therefore still found here.
    const candidate = join(current, '.git');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * Reads the remotes configured in `absolutePath`, deduplicated by remote name
 * (git prints one `(fetch)` and one `(push)` line per remote; the first line
 * for a name wins, which is the fetch URL).
 */
export const readCheckoutRemotes: CheckoutRemoteReader = async (
  absolutePath,
  options,
) => {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_CHECKOUT_REMOTE_TIMEOUT_MS;
  let stdout: string;
  try {
    ({ stdout } = await execGit(['remote', '-v'], {
      cwd: absolutePath,
      timeout: timeoutMs,
    }));
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    const message = error instanceof Error ? error.message : String(error);
    // A timed-out read was KILLED, so it never reported an exit code at all —
    // it must not fall through to the exit-128 branch and be mistaken for
    // "git refused". Naming the timeout explicitly is the difference between
    // an operator seeing "that checkout is on a wedged mount" and seeing a
    // generic "command failed".
    if ((error as { killed?: unknown }).killed === true) {
      return {
        ok: false,
        reason: `git remote read in ${absolutePath} exceeded ${timeoutMs}ms and was terminated: ${message}`,
      };
    }
    if (code === GIT_REFUSED_EXIT_CODE) {
      const gitEntry = findGitEntryOnPath(absolutePath);
      if (gitEntry === undefined) {
        // A real, truthful answer: the directory exists, there is no `.git`
        // anywhere above it, so it is not a repository and advertises no
        // remotes.
        return { ok: true, remotes: [] };
      }
      // Decision 3: git found a repository and refused. Reporting that as
      // "no remotes" would turn a failure into a successful observation.
      return {
        ok: false,
        reason: `git refused to read remotes in ${absolutePath} even though ${gitEntry} exists: ${message}`,
      };
    }
    return {
      ok: false,
      reason: `could not read git remotes in ${absolutePath}: ${message}`,
    };
  }

  const remotes: CheckoutRemote[] = [];
  const seen = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^(\S+)\s+(\S+)\s+\((?:fetch|push)\)$/.exec(line.trim());
    if (!match) continue;
    const [, name, url] = match;
    if (seen.has(name)) continue;
    seen.add(name);
    remotes.push({ name, url });
  }
  return { ok: true, remotes };
};
