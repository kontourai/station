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
import { runDiffWhitespaceGate } from './diff-whitespace-gate.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';
import { newUnnamedExports } from './lib/new-export-check.mjs';
import { describeUnusableBase, resolvePushBase } from './lib/prepush-base.mjs';

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
 * `origin/main` (what CI's base becomes once the branch is a pull request).
 * When that base cannot support a verdict (no ref, no shared history, or a
 * stale ref under a merged newer main), the whitespace check falls back to
 * the tip the remote already holds when that is an ancestor, and otherwise
 * warns; the export check only warns.
 */
function pushBase(update) {
  const resolved = resolvePushBase(MAIN_REF, update.sha);
  if (resolved.state === 'ok')
    return {
      resolved,
      base: resolved.mergeBase,
      described: `its merge base with ${MAIN_REF}`,
    };
  const { remoteSha, sha } = update;
  if (
    remoteSha &&
    !ZERO.test(remoteSha) &&
    gitOutput(['merge-base', '--is-ancestor', remoteSha, sha]) !== null
  )
    return {
      resolved,
      base: remoteSha,
      described: 'the tip the remote already holds',
      fallback: true,
    };
  return { resolved, base: null };
}

const fullVerdict = (base) =>
  `node scripts/code-health-gate.mjs --base=${base}`;

function warn(message) {
  console.log(`WARNING: ${message} CI will judge it; the push continues.`);
}

/** Whitespace on the pushed lines; false only on a real finding. */
function whitespacePasses(update, base) {
  const short = update.sha.slice(0, 12);
  if (!base.base) {
    warn(
      `whitespace not checked for ${update.ref}: ${describeUnusableBase(MAIN_REF, base.resolved)}, and the remote holds no earlier tip of this branch.`,
    );
    return true;
  }
  console.log(
    `Whitespace: checking ${update.ref} (${short}) against ${base.described}.`,
  );
  let result;
  try {
    result = runDiffWhitespaceGate({
      base: base.base,
      head: update.sha,
      attrSource: update.sha,
    });
  } catch (error) {
    warn(
      `whitespace not checked for ${update.ref}: ${error instanceof Error ? error.message : error}.`,
    );
    return true;
  }
  if (result.ok) {
    console.log(
      `[diff-whitespace] OK: no whitespace errors added since ${base.base}.`,
    );
    return true;
  }
  console.error(
    `[diff-whitespace] FAIL: the lines above add whitespace errors or conflict markers since ${base.base}; the merge queue's diff job rejects them. Fix them, or run \`git diff --check ${base.base}...${update.sha}\` to list them again.`,
  );
  return false;
}

/** The raw-mkdtemp ratchet at the pushed commit; exit 1 is a finding. */
function ratchetPasses(update) {
  console.log(
    `Test temp dirs: checking ${update.ref} (${update.sha.slice(0, 12)}).`,
  );
  const result = spawnSync(
    process.execPath,
    ['scripts/test-temp-dir-ratchet.mjs', `--rev=${update.sha}`],
    { stdio: 'inherit', windowsHide: true },
  );
  if (result.status === 1) return false;
  if (result.status !== 0)
    warn(
      `test temp dirs not checked for ${update.ref}: the ratchet did not run (${result.error?.message ?? (result.signal ? `signal ${result.signal}` : `exit ${result.status}`)}).`,
    );
  return true;
}

/**
 * New exports that no other module names (scripts/lib/new-export-check.mjs);
 * false only on a finding. It is a heuristic for the one case CI's
 * code-health gate kept refusing, not the gate, and says so.
 */
function exportsPass(update, base) {
  if (base.resolved.state !== 'ok') {
    warn(
      `new exports not checked for ${update.ref}: ${describeUnusableBase(MAIN_REF, base.resolved)}.`,
    );
    return true;
  }
  let result;
  try {
    result = newUnnamedExports({ base: base.base, sha: update.sha });
  } catch (error) {
    warn(
      `new exports not checked for ${update.ref}: ${error instanceof Error ? error.message : error}.`,
    );
    return true;
  }
  if (result.findings.length === 0) {
    console.log(
      `New exports: ${result.checked} new export name(s), each named in another module.`,
    );
    return true;
  }
  console.error(
    [
      `FAIL: ${result.findings.length} new export(s) that no other module names; CI's code-health gate refuses these as unused exports:`,
      ...result.findings.map(
        ({ path, name }) =>
          `  ${path}: export ${name} is not named in any other file`,
      ),
      'Drop the `export`, or use it from where it is needed.',
      'This checks only a new export that nothing else names. A name that appears',
      'elsewhere by coincidence, or an export whose last use was removed, is left',
      "to CI. CI's exact verdict, locally (25-50s):",
      `  ${fullVerdict(base.base)}`,
    ].join('\n'),
  );
  return false;
}

function main(stdinText) {
  const failed = [];
  for (const update of pushedUpdates(stdinText)) {
    const base = pushBase(update);
    if (base.resolved.state === 'stale')
      // Said first, because every later line is judged against that base.
      warn(
        `${update.ref}: ${describeUnusableBase(MAIN_REF, base.resolved)}. Whitespace is compared against the remote's tip when it has one; new exports are not checked.`,
      );
    if (!whitespacePasses(update, base))
      failed.push(
        `git diff --check ${base.base}...${update.sha}   # whitespace`,
      );
    if (!ratchetPasses(update))
      failed.push(`node scripts/test-temp-dir-ratchet.mjs --rev=${update.sha}`);
    if (!exportsPass(update, base))
      failed.push(
        `${fullVerdict(base.base)}   # CI's full unused-export verdict`,
      );
  }
  if (failed.length > 0) {
    console.error(
      [
        '',
        `FAIL: ${failed.length} push-range check(s) found a problem in the pushed commit, so this push is refused.`,
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
  try {
    process.exitCode = main(readFileSync(0, 'utf8'));
  } catch (error) {
    warn(
      `the push-range checks could not run (${error instanceof Error ? error.message : error}).`,
    );
  }
}
