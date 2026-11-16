#!/usr/bin/env node
/**
 * Pre-push warning: does the commit being pushed still merge into main?
 *
 * CI's `PR source admission` job (scripts/pr-source-admission.mjs) defers a
 * pull request that GitHub reports as conflicting with main, and then no
 * source check runs at all; the author learns of it a CI round trip after the
 * push. Git can answer the same question here, offline, against the main the
 * checkout last fetched: `git merge-tree --write-tree` is the merge Git would
 * make, computed without touching the index or the working tree.
 *
 * It only ever warns. The local `origin/main` may be stale, so a conflict it
 * reports may already be resolved on the server, and a clean answer here
 * proves nothing about the server's main either; refusing on that evidence
 * would block honest pushes. It is silent when `origin/main` is unknown, when
 * the merge is clean, and for deletions. A Git fault prints one line saying
 * the check could not run; it never fails the push.
 *
 * Reads git's pre-push ref lines (`<local ref> <local sha> <remote ref>
 * <remote sha>`) on stdin, the same lines scripts/commit-message-gate.mjs reads.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { CAPTURE_MAX_BYTES } from './lib/bounded-capture.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';

// The base the scoped pre-push gates use, overridable the same way.
const MAIN_REF = process.env.STATION_BASE_REF ?? 'origin/main';
const ZERO = /^0+$/;
const SHOWN_FILES = 20;

function git(args, cwd) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: CAPTURE_MAX_BYTES,
  });
}

/** The distinct non-deletion local commits in git's pre-push ref lines. */
function pushedCommits(stdinText) {
  const commits = [];
  for (const line of String(stdinText).split('\n')) {
    const [localRef, localSha] = line.trim().split(/\s+/);
    if (!localRef || !localSha || ZERO.test(localSha)) continue;
    if (!commits.some((entry) => entry.sha === localSha))
      commits.push({ ref: localRef, sha: localSha });
  }
  return commits;
}

/**
 * `{ state: 'unknown' }` when there is no local main, `clean`, `conflict`
 * with the conflicting paths, or `error` with Git's reason.
 */
function mainConflict(sha, cwd = process.cwd()) {
  const main = git(
    ['rev-parse', '--verify', '--quiet', `${MAIN_REF}^{commit}`],
    cwd,
  );
  if (main.status !== 0) return { state: 'unknown' };
  const mainSha = main.stdout.trim();
  const merge = git(
    [
      'merge-tree',
      '--write-tree',
      '--name-only',
      '--no-messages',
      mainSha,
      sha,
    ],
    cwd,
  );
  if (merge.status === 0) return { state: 'clean', mainSha };
  if (merge.status === 1) {
    // First line is the tree Git wrote; the rest are the conflicted paths.
    const [, ...files] = merge.stdout.split('\n').filter(Boolean);
    return { state: 'conflict', mainSha, files: [...new Set(files)] };
  }
  return {
    state: 'error',
    mainSha,
    reason: (merge.stderr || merge.error?.message || `exit ${merge.status}`)
      .trim()
      .split('\n')[0],
  };
}

function conflictWarning({ ref, sha }, { mainSha, files }) {
  const shown = files.slice(0, SHOWN_FILES);
  return [
    `[station pre-push] WARNING: ${ref} (${sha.slice(0, 12)}) does not merge cleanly into ${MAIN_REF} (${mainSha.slice(0, 12)}, as last fetched here). Conflicting file(s):`,
    ...shown.map((file) => `  ${file}`),
    ...(files.length > shown.length
      ? [`  … and ${files.length - shown.length} more`]
      : []),
    '  CI will refuse to run source checks on a pull request that conflicts with',
    '  main ("PR source admission"). Merge origin/main and resolve these first.',
    '  This is a warning only; the push continues.',
  ].join('\n');
}

function main({ stdinText, cwd = process.cwd(), log = console.log }) {
  for (const commit of pushedCommits(stdinText)) {
    const result = mainConflict(commit.sha, cwd);
    if (result.state === 'conflict') log(conflictWarning(commit, result));
    else if (result.state === 'error')
      log(
        `[station pre-push] note: could not check ${commit.ref} against ${MAIN_REF} (${result.reason}); CI will report a conflict if there is one.`,
      );
  }
}

if (invokedDirectly(import.meta.url)) {
  try {
    main({ stdinText: readFileSync(0, 'utf8') });
  } catch (error) {
    console.log(
      `[station pre-push] note: the main-conflict check could not run (${error instanceof Error ? error.message : error}).`,
    );
  }
}
