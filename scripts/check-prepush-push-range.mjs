#!/usr/bin/env node
/**
 * Pre-push: three cheap checks on the commit being pushed, run on every push the
 * hook does not classify as a pure merge of main.
 *
 * - The merge queue's whitespace check (scripts/diff-whitespace-gate.mjs, the
 *   `git diff --check` the queue's `diff` job runs): a trailing space or a
 *   conflict marker in the lines this branch adds.
 * - The raw-`mkdtemp` ratchet on test files (scripts/test-temp-dir-ratchet.mjs,
 *   #2421), which the "Repository source scans" job and
 *   `verification:policy:gate` both run.
 * - A new export that no other module names (scripts/lib/new-export-check.mjs):
 *   the shape of every unused-export blocker CI's code-health gate raised in
 *   that window, without the 25-50s fallow audit the gate itself costs.
 *
 * Measured over 732 pull-request CI runs (2026-11-13 to 15), these failed up
 * to 35 runs between them, each costing a push and a CI round trip, while they
 * cost one to two seconds here. All three are judged against the pushed commit
 * itself, never the working tree: the whitespace and export checks compare
 * `<merge base with origin/main>...<pushed sha>` and search that commit's
 * tree, and the ratchet reads the files and the baseline from it (`--rev`),
 * so an uncommitted edit can neither fail nor rescue the push.
 *
 * The whitespace gate and the ratchet print their own findings and remedies;
 * this file prints the export check's.
 *
 * Reads git's pre-push ref lines on stdin.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { invokedDirectly } from './lib/module-entry.mjs';
import { newUnnamedExports } from './lib/new-export-check.mjs';

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

const fullVerdict = (base) =>
  `node scripts/code-health-gate.mjs --base=${base.base}`;
const newExportsRemedy = (base) =>
  `${fullVerdict(base)}   # CI's full unused-export verdict`;

/**
 * New exports that no other module names (scripts/lib/new-export-check.mjs).
 * Returns false when it refuses. It is a narrow subset of CI's code-health
 * gate, and says so, so a pass here is never read as the gate's verdict.
 */
function exportsRefused(update, base) {
  const result = newUnnamedExports({ base: base.base, sha: update.sha });
  if (result.findings.length === 0) {
    console.log(
      `New exports: ${result.checked} new export name(s), each named in another module.`,
    );
    return true;
  }
  console.error(
    [
      `FAIL: ${result.findings.length} new export(s) that no other file names; CI's code-health gate refuses these as unused exports:`,
      ...result.findings.map(
        ({ path, name }) =>
          `  ${path}: export ${name} is not named in any other file`,
      ),
      'Drop the `export`, or use it from where it is needed.',
      'This checks only a new export that nothing else names. A name that appears',
      'elsewhere by coincidence, or an export whose last use was removed, is left',
      "to CI. CI's exact verdict, locally (25-50s):",
      `  ${fullVerdict(base)}`,
    ].join('\n'),
  );
  return false;
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
    if (base && !exportsRefused(update, base))
      failed.push(newExportsRemedy(base));
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
