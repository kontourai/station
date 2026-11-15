#!/usr/bin/env node
/**
 * Pre-push: two cheap checks on the commit being pushed, run on every push the
 * hook does not classify as a pure merge of main.
 *
 * - The merge queue's whitespace check (scripts/diff-whitespace-gate.mjs, the
 *   `git diff --check` the queue's `diff` job runs): a trailing space or a
 *   conflict marker in the lines this branch adds.
 * - The raw-`mkdtemp` ratchet on test files (scripts/test-temp-dir-ratchet.mjs,
 *   #2421), which the "Repository source scans" job and
 *   `verification:policy:gate` both run.
 *
 * Measured over 732 pull-request CI runs (2026-11-13 to 15), these two failed
 * up to 19 runs between them, each costing a push and a CI round trip, while
 * they cost about a second here. Both are judged against the pushed commit
 * itself, never the working tree: the whitespace check compares
 * `<merge base with origin/main>...<pushed sha>`, and the ratchet reads the
 * files and the baseline from the pushed commit's tree (`--rev`), so an
 * uncommitted edit can neither fail nor rescue the push.
 *
 * This file decides only what to run and against which commit; the checks,
 * their counts and their remedies stay in the two scripts, which print them.
 *
 * Reads git's pre-push ref lines on stdin.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { invokedDirectly } from './lib/module-entry.mjs';

// The base the other scoped pre-push gates use, overridable the same way.
const MAIN_REF = process.env.STATION_BASE_REF ?? 'origin/main';
const ZERO = /^0+$/;

function gitOutput(args) {
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    windowsHide: true,
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function pushedUpdates(stdinText) {
  const updates = [];
  for (const line of String(stdinText).split('\n')) {
    const [localRef, localSha, , remoteSha] = line.trim().split(/\s+/);
    if (!localRef || !localSha || ZERO.test(localSha)) continue;
    if (!updates.some((entry) => entry.sha === localSha))
      updates.push({ ref: localRef, sha: localSha, remoteSha });
  }
  return updates;
}

/**
 * What the pushed lines are compared against: the merge base with the local
 * `origin/main` (what CI's base becomes once the branch is a pull request),
 * else the tip the remote already holds, else nothing.
 */
function whitespaceBase({ sha, remoteSha }) {
  const mergeBase = gitOutput(['merge-base', MAIN_REF, sha]);
  if (mergeBase)
    return { base: mergeBase, described: `its merge base with ${MAIN_REF}` };
  if (
    remoteSha &&
    !ZERO.test(remoteSha) &&
    gitOutput(['merge-base', '--is-ancestor', remoteSha, sha]) !== null
  )
    return { base: remoteSha, described: 'the tip the remote already holds' };
  return null;
}

function run(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function main(stdinText) {
  const failed = [];
  for (const update of pushedUpdates(stdinText)) {
    const short = update.sha.slice(0, 12);
    const base = whitespaceBase(update);
    if (base) {
      console.log(
        `Whitespace: checking ${update.ref} (${short}) against ${base.described}.`,
      );
      const args = [`--base=${base.base}`, `--head=${update.sha}`];
      if (run('scripts/diff-whitespace-gate.mjs', args) !== 0)
        failed.push(`node scripts/diff-whitespace-gate.mjs ${args.join(' ')}`);
    } else {
      console.log(
        `Whitespace: skipped for ${update.ref} — no ${MAIN_REF} here and no remote tip below it, so there is no base to compare against; the merge queue's diff job still checks it.`,
      );
    }
    console.log(`Test temp dirs: checking ${update.ref} (${short}).`);
    const ratchetArgs = [`--rev=${update.sha}`];
    if (run('scripts/test-temp-dir-ratchet.mjs', ratchetArgs) !== 0)
      failed.push(`node scripts/test-temp-dir-ratchet.mjs ${ratchetArgs[0]}`);
  }
  if (failed.length > 0) {
    console.error(
      [
        '',
        `FAIL: ${failed.length} push-range check(s) did not pass, so this push is refused.`,
        'Each printed its own finding and remedy above. Reproduce with:',
        '',
        ...failed.map((command) => `  ${command}`),
        '',
      ].join('\n'),
    );
    return 1;
  }
  return 0;
}

if (invokedDirectly(import.meta.url)) {
  process.exitCode = main(readFileSync(0, 'utf8'));
}
