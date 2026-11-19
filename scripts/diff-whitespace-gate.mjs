#!/usr/bin/env node
/**
 * The merge-queue `diff` job in ci.yml runs `git diff --check <queue base>
 * HEAD`, and until this gate nothing on a pull request did, so an author
 * first learned of a trailing space or conflict marker when the queue
 * dequeued the PR (#4870, #4630). This runs the same check in ci:fast.
 *
 *   node scripts/diff-whitespace-gate.mjs [--base=<ref>] [--head=<commit>]
 *
 * The base defaults to STATION_CI_FAST_BASE, then origin/main. The
 * comparison is `<base>...HEAD`: only the lines this change adds are judged,
 * so whitespace already on the base, or added to the base after the branch
 * point, cannot fail it. For a queue candidate the base is an ancestor of
 * HEAD and `<base>...HEAD` is the queue job's `<base> HEAD`.
 *
 * Uncommitted edits are not judged: a local run checks the committed head,
 * which is what CI checks out. `--head` names another commit to judge (the
 * pre-push hook passes the commit being pushed). A base or head Git cannot
 * resolve fails the gate.
 */
import { spawnSync } from 'node:child_process';
import { invokedDirectly } from './lib/module-entry.mjs';

/** `git diff --check` exits 2 when it reports a whitespace problem. */
const GIT_CHECK_PROBLEM_EXIT = 2;

/**
 * `attrSource` reads `.gitattributes` from that commit rather than the working
 * tree (`git --attr-source`, Git 2.40+), so an uncommitted attribute edit
 * cannot change the verdict on a pushed commit. On an older Git the option is
 * refused; the check then runs with working-tree attributes and says so.
 */
export function runDiffWhitespaceGate({
  cwd = process.cwd(),
  base,
  head = 'HEAD',
  attrSource,
  warn = (message) => console.log(message),
}) {
  if (typeof base !== 'string' || !base || base.startsWith('-'))
    throw new Error('Invalid diff whitespace gate base');
  if (typeof head !== 'string' || !head || head.startsWith('-'))
    throw new Error('Invalid diff whitespace gate head');
  const diffArgs = [
    '--no-pager',
    '-c',
    'core.quotePath=false',
    'diff',
    '--check',
    `${base}...${head}`,
  ];
  let attrArgs = [];
  if (attrSource) {
    const probe = spawnSync('git', [`--attr-source=${attrSource}`, 'version'], {
      cwd,
      stdio: 'ignore',
      windowsHide: true,
    });
    if (probe.status === 0) attrArgs = [`--attr-source=${attrSource}`];
    else
      warn(
        '[diff-whitespace] WARNING: this Git has no --attr-source (Git 2.40+), so .gitattributes is read from the working tree, not the pushed commit.',
      );
  }
  const result = spawnSync('git', [...attrArgs, ...diffArgs], {
    cwd,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error)
    throw new Error(
      `git diff --check could not start: ${result.error.message}`,
    );
  if (result.status === 0) return { ok: true };
  if (result.status === GIT_CHECK_PROBLEM_EXIT) return { ok: false };
  throw new Error(
    `git diff --check ${base}...${head} ended with status ${result.status ?? `signal ${result.signal}`}; the base must be a fetched commit`,
  );
}

if (invokedDirectly(import.meta.url)) {
  try {
    const options = new Map();
    for (const arg of process.argv.slice(2)) {
      const match = /^--(base|head)=(.*)$/.exec(arg);
      if (!match || options.has(match[1]))
        throw new Error(
          'Usage: node scripts/diff-whitespace-gate.mjs [--base=<ref>] [--head=<commit>]',
        );
      options.set(match[1], match[2]);
    }
    const base =
      options.get('base') || process.env.STATION_CI_FAST_BASE || 'origin/main';
    const head = options.get('head') ?? 'HEAD';
    if (
      runDiffWhitespaceGate({
        base,
        head,
        attrSource: options.has('head') ? head : undefined,
      }).ok
    ) {
      console.log(
        `[diff-whitespace] OK: no whitespace errors added since ${base}.`,
      );
    } else {
      console.error(
        `[diff-whitespace] FAIL: the lines above add whitespace errors or conflict markers since ${base}; the merge queue's diff job rejects them. Fix them, or run \`git diff --check ${base}...${head}\` to list them again.`,
      );
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(
      `[diff-whitespace] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
