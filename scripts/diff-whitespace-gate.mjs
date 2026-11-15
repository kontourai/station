#!/usr/bin/env node
/**
 * The merge-queue `diff` job in ci.yml runs `git diff --check <queue base>
 * HEAD`, and until this gate nothing on a pull request did, so an author
 * first learned of a trailing space or conflict marker when the queue
 * dequeued the PR (#4870, #4630). This runs the same check in ci:fast.
 *
 *   node scripts/diff-whitespace-gate.mjs [--base=<ref>]
 *
 * The base defaults to STATION_CI_FAST_BASE, then origin/main. The
 * comparison is `<base>...HEAD`: only the lines this change adds are judged,
 * so whitespace already on the base, or added to the base after the branch
 * point, cannot fail it. For a queue candidate the base is an ancestor of
 * HEAD and `<base>...HEAD` is the queue job's `<base> HEAD`.
 *
 * Uncommitted edits are not judged: a local run checks the committed head,
 * which is what CI checks out. A base Git cannot resolve fails the gate.
 */
import { spawnSync } from 'node:child_process';
import { invokedDirectly } from './lib/module-entry.mjs';

/** `git diff --check` exits 2 when it reports a whitespace problem. */
const GIT_CHECK_PROBLEM_EXIT = 2;

function runDiffWhitespaceGate({ cwd = process.cwd(), base }) {
  if (typeof base !== 'string' || !base || base.startsWith('-'))
    throw new Error('Invalid diff whitespace gate base');
  const result = spawnSync(
    'git',
    [
      '--no-pager',
      '-c',
      'core.quotePath=false',
      'diff',
      '--check',
      `${base}...HEAD`,
    ],
    { cwd, stdio: 'inherit', windowsHide: true },
  );
  if (result.error)
    throw new Error(
      `git diff --check could not start: ${result.error.message}`,
    );
  if (result.status === 0) return { ok: true };
  if (result.status === GIT_CHECK_PROBLEM_EXIT) return { ok: false };
  throw new Error(
    `git diff --check ${base}...HEAD ended with status ${result.status ?? `signal ${result.signal}`}; the base must be a fetched commit`,
  );
}

if (invokedDirectly(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length && !args[0].startsWith('--base=')))
      throw new Error(
        'Usage: node scripts/diff-whitespace-gate.mjs [--base=<ref>]',
      );
    const base =
      args[0]?.slice('--base='.length) ||
      process.env.STATION_CI_FAST_BASE ||
      'origin/main';
    if (runDiffWhitespaceGate({ base }).ok) {
      console.log(
        `[diff-whitespace] OK: no whitespace errors added since ${base}.`,
      );
    } else {
      console.error(
        `[diff-whitespace] FAIL: the lines above add whitespace errors or conflict markers since ${base}; the merge queue's diff job rejects them. Fix them, or run \`git diff --check ${base}...HEAD\` to list them again.`,
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
