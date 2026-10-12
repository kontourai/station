#!/usr/bin/env node
/**
 * Pre-push classifier: is this push nothing but clean merges of main onto a
 * branch tip the remote already holds? (#3101, slice F)
 *
 * Merging `origin/main` into a branch changes the merge base, so every scoped
 * pre-push lane (static gates, SDK barrel, typecheck, transfer, readiness)
 * re-runs over the branch's own unchanged delta, and the transfer gate asks
 * for a fresh baseline. The author added nothing; main's content was gated by
 * the merge queue that put it there; and the required CI checks gate the
 * combined head again after the push. So the hook may skip those lanes for
 * such a push, and this file decides when that is true.
 *
 * ## The record of "last gated push"
 *
 * There is no stored receipt, and none is needed: the remote ref itself is
 * the record. Git updates a remote ref only after `pre-push` exits 0, so the
 * `<remote_sha>` git hands this hook is the tip of the last push this hook
 * accepted, or one made with an explicitly bypassed hook (forbidden here:
 * AGENTS.md) or by another client such as GitHub's "Update branch" (itself a
 * merge of main). By induction each push either ran every lane or added only
 * clean merges of main on top of such a tip, so every commit the author wrote
 * passed the full hook at least once.
 *
 * ## What counts as pure, per pushed ref
 *
 * - The ref is a branch (`refs/heads/...`) that already exists on the remote
 *   (`remote_sha` is not all zeros), both pushed objects are commits, and the
 *   remote tip exists locally and is an ancestor of the pushed tip.
 * - Walking first parents from `local_sha` reaches `remote_sha`, and every
 *   commit on that walk is a two-parent merge whose second parent is an
 *   ancestor of `main` AS THE REMOTE REPORTS IT (`git ls-remote <remote>
 *   refs/heads/main`, the remote being the hook's `$1`). A local ref such as
 *   `origin/main` is never trusted: anyone can point it at arbitrary content
 *   with `git update-ref`. The remote's main must also exist locally.
 * - Each merge's tree equals `git merge-tree --write-tree` of its two parents
 *   AND that automatic merge is conflict-free. A conflict resolution, or any
 *   edit amended into the merge, changes content the author wrote and is not
 *   pure.
 *
 * Every git call runs with replace objects and grafts disabled, so a
 * `git replace` ref cannot make a plain commit read as a clean merge.
 *
 * Anything else, including any git or network failure, is "not pure", and
 * the hook runs every lane. "I could not tell" must never resolve to the
 * cheaper answer (docs/guides/code-quality.md, "a default that decides").
 *
 * Usage: `node scripts/prepush-pure-merge.mjs <remote>` with git's pre-push
 * lines on stdin. Exit status: 0 when every pushed ref is a pure merge of
 * main, 1 otherwise.
 */

import { readFileSync } from 'node:fs';
import { execFileSyncBounded } from './lib/bounded-capture.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';

const ZERO = /^0+$/;
const SHA = /^[0-9a-f]{40,64}$/;
/** A first-parent walk longer than this is not a merge of main; refuse it. */
export const MAX_PURE_MERGE_COMMITS = 20;
const MAIN_REF = 'refs/heads/main';

/**
 * Object substitution off: `git replace` refs and a graft file would let a
 * commit's parents read differently from the bytes that are pushed.
 */
export const CLASSIFIER_GIT_ENV = Object.freeze({
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_GRAFT_FILE: '/nonexistent/station-no-grafts',
});

function defaultGit(args) {
  return execFileSyncBounded('git', args, {
    encoding: 'utf8',
    env: { ...process.env, ...CLASSIFIER_GIT_ENV },
    stdio: ['ignore', 'pipe', 'pipe'],
    // ls-remote is the one network call; a hung remote must not hang the push.
    timeout: 30_000,
    windowsHide: true,
  }).trim();
}

/** Run git; `null` on a non-zero exit rather than an exception. */
function tryGit(git, args) {
  try {
    return git(args);
  } catch {
    return null;
  }
}

/**
 * The remote's own `main` tip, available locally, or a refusal reason.
 * @returns {{ sha: string } | { reason: string }}
 */
export function remoteMainTip(remote, git = defaultGit) {
  if (!remote) return { reason: 'the hook did not name the remote' };
  const listed = tryGit(git, ['ls-remote', '--exit-code', remote, MAIN_REF]);
  const sha = listed?.split(/\s+/)[0] ?? '';
  if (!SHA.test(sha))
    return { reason: `cannot read ${MAIN_REF} from ${remote}` };
  if (tryGit(git, ['cat-file', '-e', `${sha}^{commit}`]) === null)
    return {
      reason: `${remote}'s main (${sha.slice(0, 12)}) is not available locally; fetch first`,
    };
  return { sha };
}

/**
 * Classify one pushed ref against `base`, the remote's main tip.
 * @param {{ localSha: string, remoteSha: string, remoteRef?: string, base: string, baseName?: string, git?: (args: string[]) => string }} input
 * @returns {{ pure: boolean, reason: string, merges?: number }}
 */
export function classifyPushedRef({
  localSha,
  remoteSha,
  remoteRef = 'refs/heads/unknown',
  base,
  baseName = 'main',
  git = defaultGit,
}) {
  const not = (reason) => ({ pure: false, reason });
  if (!String(remoteRef).startsWith('refs/heads/'))
    return not(`${remoteRef} is not a branch`);
  if (!SHA.test(localSha ?? ''))
    return not(`unreadable local object ${localSha}`);
  if (!remoteSha || ZERO.test(remoteSha))
    return not('a new remote ref has no previously gated tip');
  if (!SHA.test(remoteSha)) return not(`unreadable remote object ${remoteSha}`);
  if (localSha === remoteSha) return not('the ref does not move');
  if (!SHA.test(base ?? '')) return not(`no verified ${baseName} tip`);
  if (tryGit(git, ['cat-file', '-e', `${remoteSha}^{commit}`]) === null)
    return not(
      `the remote tip ${remoteSha.slice(0, 12)} is not available locally`,
    );
  const localType = tryGit(git, ['cat-file', '-t', localSha]);
  if (localType !== 'commit')
    return not(
      `the pushed object ${localSha.slice(0, 12)} is a ${localType ?? 'missing object'}, not a commit`,
    );
  if (
    tryGit(git, ['merge-base', '--is-ancestor', remoteSha, localSha]) === null
  )
    return not(
      `the remote tip ${remoteSha.slice(0, 12)} is not an ancestor of the pushed tip (history rewritten)`,
    );

  let commit = localSha;
  let merges = 0;
  while (commit !== remoteSha) {
    if (merges >= MAX_PURE_MERGE_COMMITS)
      return not(
        `more than ${MAX_PURE_MERGE_COMMITS} first-parent commits before the remote tip`,
      );
    const line = tryGit(git, ['rev-list', '--parents', '-n', '1', commit]);
    if (!line) return not(`cannot read commit ${commit.slice(0, 12)}`);
    const [, ...parents] = line.split(/\s+/);
    const short = commit.slice(0, 12);
    if (parents.length !== 2)
      return not(
        parents.length < 2
          ? `${short} is not a merge, so the push adds the author's own commits`
          : `${short} is an octopus merge`,
      );
    const [first, second] = parents;
    if (tryGit(git, ['merge-base', '--is-ancestor', second, base]) === null)
      return not(
        `${short} merges ${second.slice(0, 12)}, which is not on ${baseName}`,
      );
    // Exit 1 (conflicts) throws, so a conflicted merge reads as null here.
    const automatic = tryGit(git, [
      'merge-tree',
      '--write-tree',
      '--no-messages',
      first,
      second,
    ]);
    if (!automatic) return not(`${short} needed conflict resolution`);
    const autoTree = automatic.split('\n')[0];
    const tree = tryGit(git, ['rev-parse', `${commit}^{tree}`]);
    if (!tree || tree !== autoTree)
      return not(
        `${short} differs from the automatic merge of its parents (edited resolution)`,
      );
    merges += 1;
    commit = first;
  }
  return {
    pure: true,
    reason: `${merges} clean merge(s) of ${baseName} onto the gated remote tip`,
    merges,
  };
}

/** Parse git's four-field pre-push lines; deletions are skipped by the hook. */
export function parsePushLines(text) {
  return String(text)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [localRef, localSha, remoteRef, remoteSha] = line.split(/\s+/);
      return { localRef, localSha, remoteRef, remoteSha };
    });
}

/**
 * A push is pure only if it names at least one ref, the remote's main tip is
 * verified, and every ref is pure against that tip.
 * @returns {{ pure: boolean, reasons: string[] }}
 */
export function classifyPush(lines, { remote, git = defaultGit } = {}) {
  if (lines.length === 0)
    return { pure: false, reasons: ['no pushed refs were read'] };
  const tip = remoteMainTip(remote, git);
  if (!('sha' in tip)) return { pure: false, reasons: [tip.reason] };
  const baseName = `${remote}'s main`;
  const reasons = [];
  let pure = true;
  for (const line of lines) {
    const verdict = classifyPushedRef({
      ...line,
      base: tip.sha,
      baseName,
      git,
    });
    reasons.push(`${line.remoteRef ?? line.localRef}: ${verdict.reason}`);
    if (!verdict.pure) pure = false;
  }
  return { pure, reasons };
}

function main() {
  let input = '';
  try {
    input = readFileSync(0, 'utf8');
  } catch {
    input = '';
  }
  const { pure, reasons } = classifyPush(parsePushLines(input), {
    remote: process.argv[2],
  });
  const head = pure
    ? 'Pure merge of main: yes, so the expensive lanes are skipped'
    : 'Pure merge of main: no, so every lane runs';
  console.log(`${head} (${reasons.join('; ')}).`);
  process.exitCode = pure ? 0 : 1;
}

if (invokedDirectly(import.meta.url)) main();
