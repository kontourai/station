#!/usr/bin/env node
import { spawn } from 'node:child_process';
/**
 * Decides whether a push to main may leave the open version PR alone.
 *
 * Every regeneration force-pushes `changeset-release/main`, which restarts
 * all of the PR's checks, cancels the run in progress and takes the PR out of
 * the merge queue. Most pushes to main do not change what the PR releases.
 * This probe runs the same version script the action would run, on the same
 * checkout, and compares the tree it produces with the tree that merging the
 * existing PR head into this main produces. Only when they are identical (and
 * the merge is clean) does it report `current=true`: landing the existing PR
 * then yields exactly the bytes a regeneration would have pushed, so nothing
 * about the release (notes consumed, versions, dependency ranges, changelog
 * commit references, lockfile) can differ.
 *
 * It fails open. Any unreadable or unexpected state is `current=false`, which
 * leaves the action to regenerate exactly as before.
 */
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSyncBounded } from './lib/bounded-capture.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';
import { executeOwnedProcess } from './lib/owned-process.mjs';

export const VERSION_BRANCH = 'changeset-release/main';
export const VERSION_BASE = 'main';
export const VERSION_PR_AUTHOR = 'station-automation[bot]';
// The App's bot user (GET /users/station-automation%5Bbot%5D). Login, type and
// id together identify it; a look-alike login matches none of the others.
export const VERSION_PR_AUTHOR_ID = 335214120;
// `version-packages` took 24 s in run 43942898848; a hung one must not run
// to the job limit, which would fail the job instead of regenerating.
export const VERSION_TIMEOUT_MS = 180_000;
// After SIGKILL the group should vanish at once; this only bounds the wait.
export const VERSION_SETTLE_MS = 10_000;
// One small request; undici's own defaults would allow 300 s each for headers
// and body.
export const LISTING_TIMEOUT_MS = 30_000;

const OBJECT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * Picks the one open version PR from a GitHub REST `GET /pulls` listing, or
 * explains why there is none it can trust.
 */
export function selectVersionPr(pulls, repository) {
  if (!Array.isArray(pulls))
    return { reason: 'pull request listing is not an array' };
  if (pulls.length !== 1)
    return { reason: `expected one open version PR, found ${pulls.length}` };
  const [pr] = pulls;
  if (pr?.state !== 'open') return { reason: 'version PR is not open' };
  if (pr.head?.ref !== VERSION_BRANCH)
    return { reason: `PR head branch is not ${VERSION_BRANCH}` };
  if (pr.head?.repo?.full_name !== repository)
    return { reason: 'PR head is not a branch of this repository' };
  if (pr.base?.ref !== VERSION_BASE)
    return { reason: `PR base is not ${VERSION_BASE}` };
  if (
    pr.user?.login !== VERSION_PR_AUTHOR ||
    pr.user?.type !== 'Bot' ||
    pr.user?.id !== VERSION_PR_AUTHOR_ID
  )
    return { reason: `PR author is not ${VERSION_PR_AUTHOR}` };
  if (typeof pr.head.sha !== 'string' || !OBJECT_ID.test(pr.head.sha))
    return { reason: 'PR head sha is unreadable' };
  if (!Number.isInteger(pr.number))
    return { reason: 'PR number is unreadable' };
  return { pr };
}

/**
 * The decision, on already-gathered state. `head` describes the PR head
 * commit as read from Git; `merge` is `git merge-tree --write-tree` of the
 * checked-out main with that head; `regeneratedTree` is the tree the version
 * script produced on the checked-out main.
 */
export function decideVersionPrCurrent({
  pulls,
  repository,
  head,
  merge,
  regeneratedTree,
}) {
  const selected = selectVersionPr(pulls, repository);
  if (!selected.pr) return { current: false, reason: selected.reason };
  const { pr } = selected;
  const regenerate = (reason) => ({
    current: false,
    reason,
    number: pr.number,
  });
  if (head?.sha !== pr.head.sha)
    return regenerate('local PR head differs from the listed PR head');
  // One commit on top of a main ancestor is the shape the action writes; the
  // review ledger's release-versioning contract reads exactly that unit.
  if (!Array.isArray(head.parents) || head.parents.length !== 1)
    return regenerate('PR head is not a single commit');
  if (head.parentOnMain !== true)
    return regenerate('PR head is not based on an ancestor of main');
  if (merge?.clean !== true)
    return regenerate('PR head does not merge cleanly into main');
  if (typeof merge.tree !== 'string' || !OBJECT_ID.test(merge.tree))
    return regenerate('merge result is unreadable');
  if (typeof regeneratedTree !== 'string' || !OBJECT_ID.test(regeneratedTree))
    return regenerate('regenerated tree is unreadable');
  // Tree equality alone cannot tell "nothing left to release" from "the head
  // already contains what main now has": a head written on a main from before
  // the previous version PR landed merges into the new main as a no-op, while
  // its diff and body still list released notes. The kept head must still be
  // a pending release on this main.
  if (head.consumedNotesPending !== true)
    return regenerate('notes the PR consumes are no longer pending on main');
  if (typeof head.empty !== 'boolean')
    return regenerate('PR head diff is unreadable');
  if (!head.empty && merge.tree === merge.mainTree)
    return regenerate('PR head adds nothing to main');
  if (merge.tree !== regeneratedTree)
    return regenerate('regenerating would change what the PR releases');
  return {
    current: true,
    reason: 'merging the open PR yields exactly the regenerated release',
    number: pr.number,
  };
}

function git(cwd, args, env) {
  const result = spawnSyncBounded('git', args, {
    cwd,
    encoding: 'utf8',
    env: env ? { ...process.env, ...env } : process.env,
  });
  if (result.error) throw result.error;
  return result;
}

function gitOut(cwd, args, env) {
  const result = git(cwd, args, env);
  if (result.status !== 0)
    throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function readHead(cwd, sha) {
  if (git(cwd, ['cat-file', '-e', `${sha}^{commit}`]).status !== 0)
    return { sha: undefined };
  const parents = gitOut(cwd, ['rev-list', '--parents', '-n', '1', sha])
    .split(' ')
    .slice(1);
  const parentOnMain =
    parents.length === 1 &&
    git(cwd, ['merge-base', '--is-ancestor', parents[0], 'HEAD']).status === 0;
  if (!parentOnMain) return { sha, parents, parentOnMain };
  const [parent] = parents;
  const empty = git(cwd, ['diff', '--quiet', parent, sha]).status === 0;
  // Every note the head's commit deletes must still be on main, unchanged.
  const consumed = gitOut(cwd, [
    'diff',
    '--name-only',
    '--no-renames',
    '--diff-filter=D',
    parent,
    sha,
    '--',
    '.changeset/',
  ])
    .split('\n')
    .filter(Boolean);
  const blob = (rev, path) => {
    const result = git(cwd, ['rev-parse', '--verify', '-q', `${rev}:${path}`]);
    return result.status === 0 ? result.stdout.trim() : undefined;
  };
  const consumedNotesPending = consumed.every((path) => {
    const before = blob(parent, path);
    return before !== undefined && before === blob('HEAD', path);
  });
  return { sha, parents, parentOnMain, empty, consumedNotesPending };
}

function mergeTree(cwd, sha) {
  const result = git(cwd, ['merge-tree', '--write-tree', 'HEAD', sha]);
  // 0 is a clean merge, 1 a conflicted one; anything else is an error.
  if (result.status === 1) return { clean: false };
  if (result.status !== 0)
    throw new Error(`git merge-tree failed: ${result.stderr.trim()}`);
  return {
    clean: true,
    tree: result.stdout.split('\n')[0].trim(),
    mainTree: gitOut(cwd, ['rev-parse', 'HEAD^{tree}']),
  };
}

/** Something the version script started may still write into the checkout. */
export class VersionGroupSurvivedError extends Error {}

/**
 * Kills whatever is left of the version script's process group and waits
 * until the group is gone. Descendants (pnpm, changeset) can outlive the
 * leader, so this runs on every exit path, not only on a timeout.
 */
export async function settleVersionGroup(
  execution,
  { deadlineMs = VERSION_SETTLE_MS, pollMs = 50 } = {},
) {
  try {
    await execution.forceTerminate();
  } catch {
    // An unsignallable group is judged by the liveness poll below.
  }
  const deadline = Date.now() + deadlineMs;
  while (execution.isAlive()) {
    if (Date.now() >= deadline)
      throw new VersionGroupSurvivedError(
        `version command process group ${execution.child.pid} is still alive after SIGKILL`,
      );
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

async function runVersionCommand(cwd, versionCommand, timeoutMs, settleMs) {
  const [command, ...args] = versionCommand;
  // The token is for this probe's own PR read; the version script gets none.
  const { GH_TOKEN: _gh, GITHUB_TOKEN: _github, ...env } = process.env;
  // Its own process group (owned-process spawns detached), so a timeout or
  // an early exit can kill every descendant, not only the leader.
  const execution = executeOwnedProcess(
    command,
    args,
    spawn,
    'version script',
    { cwd, env, stdio: 'inherit' },
  );
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  const result = await Promise.race([execution.completion, timeout]);
  clearTimeout(timer);
  await settleVersionGroup(execution, { deadlineMs: settleMs });
  if (result === 'timeout')
    throw new Error(`version command timed out after ${timeoutMs} ms`);
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`version command exited ${result.status ?? result.signal}`);
}

async function regeneratedTree(cwd, versionCommand, timeoutMs, settleMs) {
  await runVersionCommand(cwd, versionCommand, timeoutMs, settleMs);
  // A throwaway index records the working tree as the action's commit would
  // (tracked and untracked, ignored files excluded) without touching the
  // checkout's own index.
  const dir = mkdtempSync(join(tmpdir(), 'version-pr-current-'));
  try {
    const env = { GIT_INDEX_FILE: join(dir, 'index') };
    gitOut(cwd, ['read-tree', 'HEAD'], env);
    gitOut(cwd, ['add', '-A'], env);
    return gitOut(cwd, ['write-tree'], env);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function restore(cwd) {
  gitOut(cwd, ['reset', '-q', '--hard', 'HEAD']);
  gitOut(cwd, ['clean', '-fdq']);
}

export async function fetchOpenVersionPulls({
  repository,
  token,
  apiUrl = 'https://api.github.com',
  fetchImpl = fetch,
  timeoutMs = LISTING_TIMEOUT_MS,
}) {
  const owner = repository.split('/')[0];
  const query = new URLSearchParams({
    state: 'open',
    base: VERSION_BASE,
    head: `${owner}:${VERSION_BRANCH}`,
    per_page: '10',
  });
  const response = await fetchImpl(
    `${apiUrl}/repos/${repository}/pulls?${query}`,
    {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
      },
      // Covers the body read below too.
      signal: AbortSignal.timeout(timeoutMs),
    },
  );
  if (!response.ok)
    throw new Error(`listing version PRs returned HTTP ${response.status}`);
  return response.json();
}

/**
 * Gathers state and decides. Never throws: every failure is a regeneration.
 * The checkout is restored before returning.
 */
export async function probeVersionPrCurrent({
  cwd,
  eventName,
  ref,
  repository,
  listPulls,
  versionCommand = ['npm', 'run', 'version-packages'],
  versionTimeoutMs = VERSION_TIMEOUT_MS,
  versionSettleMs = VERSION_SETTLE_MS,
}) {
  try {
    if (eventName !== 'push' || ref !== `refs/heads/${VERSION_BASE}`)
      return { current: false, reason: 'only a push to main may skip' };
    if (gitOut(cwd, ['status', '--porcelain']) !== '')
      return {
        current: false,
        reason: 'checkout is not clean before the probe',
      };
    const pulls = await listPulls();
    const selected = selectVersionPr(pulls, repository);
    if (!selected.pr) return { current: false, reason: selected.reason };
    const head = readHead(cwd, selected.pr.head.sha);
    const merge = head.sha ? mergeTree(cwd, head.sha) : undefined;
    let tree;
    try {
      tree = await regeneratedTree(
        cwd,
        versionCommand,
        versionTimeoutMs,
        versionSettleMs,
      );
    } catch (error) {
      // Restoring under a live writer proves nothing; the workflow must stop.
      if (error instanceof VersionGroupSurvivedError)
        return { current: false, reason: error.message, unsettled: true };
      restore(cwd);
      throw error;
    }
    restore(cwd);
    return decideVersionPrCurrent({
      pulls,
      repository,
      head,
      merge,
      regeneratedTree: tree,
    });
  } catch (error) {
    return {
      current: false,
      reason: `unreadable state: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

if (invokedDirectly(import.meta.url)) {
  const output = process.env.GITHUB_OUTPUT;
  const repository = process.env.GITHUB_REPOSITORY ?? '';
  const decision = await probeVersionPrCurrent({
    cwd: process.cwd(),
    eventName: process.env.GITHUB_EVENT_NAME,
    ref: process.env.GITHUB_REF,
    repository,
    listPulls: () =>
      fetchOpenVersionPulls({
        repository,
        token: process.env.GH_TOKEN ?? '',
        apiUrl: process.env.GITHUB_API_URL,
      }),
  });
  console.log(
    `version PR ${decision.current ? 'is current; leaving it unchanged' : 'will be regenerated'}: ${decision.reason}`,
  );
  if (!output) {
    console.error('Missing workflow output path');
    process.exitCode = 1;
  } else {
    appendFileSync(
      output,
      `current=${decision.current}\npr-number=${decision.number ?? ''}\nsettled=${decision.unsettled !== true}\n`,
    );
  }
}
