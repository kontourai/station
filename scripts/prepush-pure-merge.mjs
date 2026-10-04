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
 * - The ref already exists on the remote (`remote_sha` is not all zeros) and
 *   that commit exists locally.
 * - Walking first parents from `local_sha` reaches `remote_sha`, and every
 *   commit on that walk is a two-parent merge whose second parent is an
 *   ancestor of the base ref (`origin/main`, or `STATION_BASE_REF`). Commits
 *   reached through a second parent are therefore already on main.
 * - Each merge's tree equals `git merge-tree --write-tree` of its two parents
 *   AND that automatic merge is conflict-free. A conflict resolution, or any
 *   edit amended into the merge, changes content the author wrote and is not
 *   pure.
 *
 * Anything else, including any git failure, is "not pure", and the hook runs
 * every lane. "I could not tell" must never resolve to the cheaper answer
 * (docs/guides/code-quality.md, "a default that decides").
 *
 * Exit status: 0 when every pushed ref is a pure merge of main, 1 otherwise.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { invokedDirectly } from './lib/module-entry.mjs';

const ZERO = /^0+$/;
const SHA = /^[0-9a-f]{40,64}$/;
/** A first-parent walk longer than this is not a merge of main; refuse it. */
export const MAX_PURE_MERGE_COMMITS = 20;

function defaultGit(args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
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
 * Classify one pushed ref.
 * @param {{ localSha: string, remoteSha: string, baseRef: string, git?: (args: string[]) => string }} input
 * @returns {{ pure: boolean, reason: string, merges?: number }}
 */
export function classifyPushedRef({
  localSha,
  remoteSha,
  baseRef,
  git = defaultGit,
}) {
  if (!SHA.test(localSha ?? ''))
    return { pure: false, reason: `unreadable local object ${localSha}` };
  if (!remoteSha || ZERO.test(remoteSha))
    return {
      pure: false,
      reason: 'a new remote ref has no previously gated tip',
    };
  if (!SHA.test(remoteSha))
    return { pure: false, reason: `unreadable remote object ${remoteSha}` };
  if (localSha === remoteSha)
    return { pure: false, reason: 'the ref does not move' };
  if (tryGit(git, ['cat-file', '-e', `${remoteSha}^{commit}`]) === null)
    return {
      pure: false,
      reason: `the remote tip ${remoteSha.slice(0, 12)} is not available locally`,
    };
  const base = tryGit(git, ['rev-parse', '--verify', `${baseRef}^{commit}`]);
  if (!base) return { pure: false, reason: `${baseRef} could not be resolved` };

  let commit = localSha;
  let merges = 0;
  while (commit !== remoteSha) {
    if (merges >= MAX_PURE_MERGE_COMMITS)
      return {
        pure: false,
        reason: `more than ${MAX_PURE_MERGE_COMMITS} first-parent commits before the remote tip`,
      };
    const line = tryGit(git, ['rev-list', '--parents', '-n', '1', commit]);
    if (!line)
      return {
        pure: false,
        reason: `cannot read commit ${commit.slice(0, 12)}`,
      };
    const [, ...parents] = line.split(/\s+/);
    const short = commit.slice(0, 12);
    if (parents.length !== 2)
      return {
        pure: false,
        reason:
          parents.length < 2
            ? `${short} is not a merge, so the push adds the author's own commits`
            : `${short} is an octopus merge`,
      };
    const [first, second] = parents;
    if (tryGit(git, ['merge-base', '--is-ancestor', second, base]) === null)
      return {
        pure: false,
        reason: `${short} merges ${second.slice(0, 12)}, which is not on ${baseRef}`,
      };
    // Exit 1 (conflicts) throws, so a conflicted merge reads as null here.
    const automatic = tryGit(git, [
      'merge-tree',
      '--write-tree',
      '--no-messages',
      first,
      second,
    ]);
    if (!automatic)
      return { pure: false, reason: `${short} needed conflict resolution` };
    const autoTree = automatic.split('\n')[0];
    const tree = tryGit(git, ['rev-parse', `${commit}^{tree}`]);
    if (!tree || tree !== autoTree)
      return {
        pure: false,
        reason: `${short} differs from the automatic merge of its parents (edited resolution)`,
      };
    merges += 1;
    commit = first;
  }
  return {
    pure: true,
    reason: `${merges} clean merge(s) of ${baseRef} onto the gated remote tip`,
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
 * A push is pure only if it names at least one ref and every ref is pure.
 * @returns {{ pure: boolean, reasons: string[] }}
 */
export function classifyPush(
  lines,
  { baseRef, git = defaultGit } = { baseRef: 'origin/main' },
) {
  if (lines.length === 0)
    return { pure: false, reasons: ['no pushed refs were read'] };
  const reasons = [];
  let pure = true;
  for (const line of lines) {
    const verdict = classifyPushedRef({ ...line, baseRef, git });
    reasons.push(`${line.remoteRef ?? line.localRef}: ${verdict.reason}`);
    if (!verdict.pure) pure = false;
  }
  return { pure, reasons };
}

function main() {
  const baseRef = process.env.STATION_BASE_REF ?? 'origin/main';
  let input = '';
  try {
    input = readFileSync(0, 'utf8');
  } catch {
    input = '';
  }
  const { pure, reasons } = classifyPush(parsePushLines(input), { baseRef });
  const head = pure
    ? 'Pure merge of main: yes, so the expensive lanes are skipped'
    : 'Pure merge of main: no, so every lane runs';
  console.log(`${head} (${reasons.join('; ')}).`);
  process.exitCode = pure ? 0 : 1;
}

if (invokedDirectly(import.meta.url)) main();
