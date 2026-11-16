#!/usr/bin/env node
/**
 * Pre-push: recorded documentation reviews this branch left stale.
 *
 * Runs the real `docs:freshness:check` (scripts/check-documentation-freshness.mjs
 * --json) and decides only what its verdict means for this push. It refuses
 * only on positive evidence of a defect in what is being pushed, because
 * `--no-verify` is not allowed and a wrongful refusal has no way around it:
 *
 * - fresh: one line, and the push continues;
 * - stale, the pushed commit is the checked-out commit, the tracked tree is
 *   clean (so the check saw exactly what CI will see), and that commit's
 *   range adds or changes a file under the review ledger: REFUSED, with the
 *   check's own list and remedy. The author has started recording reviews,
 *   so a stale entry is a note outdated by a later edit or a cited page
 *   missed, which is what CI's docs:truth:gate kept failing on;
 * - stale otherwise: the same list as a WARNING saying why it is only a
 *   warning, and the push continues. Before the branch records any review,
 *   refusing would force notes before the change is final; with uncommitted
 *   edits or another commit checked out, the list is not about the pushed
 *   commit at all;
 * - no verdict possible (no base ref, no merge base, a local base older than
 *   a main the branch merged, or the check crashing or timing out): a WARNING
 *   naming what could not be checked, and the push continues. The stale-base
 *   case is detected before the check runs, and its hint is printed first.
 *
 * The base is the check's own: STATION_DOCS_FRESHNESS_BASE, then
 * STATION_CI_FAST_BASE, then origin/main, so the wrapper and the check scope
 * the same range. No network call is made. Reads git's pre-push ref lines on
 * stdin.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CAPTURE_MAX_BYTES } from './lib/bounded-capture.mjs';
import { scaleLivenessMs } from './lib/liveness-scale.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';
import { describeUnusableBase, resolvePushBase } from './lib/prepush-base.mjs';
import { REVIEW_LEDGER_DIR } from './lib/review-ledger-paths.mjs';

const BASE_REF =
  process.env.STATION_DOCS_FRESHNESS_BASE ||
  process.env.STATION_CI_FAST_BASE ||
  'origin/main';
const ZERO = /^0+$/;
/** A liveness bound on the check (~5-8s here), not a performance budget. */
const CHECK_TIMEOUT_BASE_MS = 120_000;
/**
 * Test-only: replaces the base of that bound so a test can prove the timeout
 * path without a two-minute wait. Anything but a positive integer is ignored.
 */
const TIMEOUT_OVERRIDE_ENV = 'STATION_PREPUSH_DOCS_FRESHNESS_TIMEOUT_MS';
/** Stale entries shown before the rest are counted; a stale base listed 4,000. */
const SHOWN_ENTRIES = 30;

function checkTimeoutMs(env = process.env) {
  const raw = env[TIMEOUT_OVERRIDE_ENV];
  const base =
    raw && /^[1-9][0-9]*$/.test(raw) ? Number(raw) : CHECK_TIMEOUT_BASE_MS;
  return scaleLivenessMs(base, env);
}
const CHECK = fileURLToPath(
  new URL('./check-documentation-freshness.mjs', import.meta.url),
);

function git(args) {
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: CAPTURE_MAX_BYTES,
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function pushedShas(stdinText) {
  const shas = new Set();
  for (const line of String(stdinText).split('\n')) {
    const [localRef, localSha] = line.trim().split(/\s+/);
    if (localRef && localSha && !ZERO.test(localSha)) shas.add(localSha);
  }
  return [...shas];
}

function warn(message) {
  console.log(
    `WARNING: documentation freshness: ${message} The push continues; CI's docs:truth:gate will judge it.`,
  );
}

function runCheck(args) {
  const timeout = checkTimeoutMs();
  const result = spawnSync(process.execPath, [CHECK, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: CAPTURE_MAX_BYTES,
    timeout,
    killSignal: 'SIGKILL',
  });
  return { result, timeout };
}

function jsonVerdict() {
  const { result, timeout } = runCheck(['--json']);
  if (result.error || result.signal)
    return {
      state: 'error',
      detail:
        result.error?.code === 'ETIMEDOUT' || result.signal
          ? `did not finish within ${Math.round(timeout / 1000)}s`
          : String(result.error?.message ?? result.signal),
    };
  const lastLine = String(result.stdout ?? '')
    .trim()
    .split('\n')
    .at(-1);
  let parsed;
  try {
    parsed = lastLine ? JSON.parse(lastLine) : undefined;
  } catch {
    parsed = undefined;
  }
  if (parsed?.error)
    return { state: 'error', detail: String(parsed.error.message) };
  if (!parsed || !Array.isArray(parsed.blocking))
    return {
      state: 'error',
      detail: `exited ${result.status} without a result${result.stderr ? `: ${result.stderr.trim().split('\n')[0]}` : ''}`,
    };
  if (result.status === 0 && parsed.blocking.length === 0)
    return { state: 'fresh', result: parsed };
  if (result.status === 1 && parsed.blocking.length > 0)
    return { state: 'stale', result: parsed };
  return {
    state: 'error',
    detail: `exit ${result.status} disagrees with ${parsed.blocking.length} blocking entr(ies)`,
  };
}

/**
 * The check's own human report and remedy, re-run because the JSON result
 * carries no wording by design, and capped: entry lines past the first
 * {@link SHOWN_ENTRIES} are counted, not printed.
 */
function checkReport() {
  const { result } = runCheck([]);
  const text = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  const entry = /^ {2}(?:review|capture|note) /;
  let shown = 0;
  let hidden = 0;
  const kept = [];
  for (const line of text.split('\n')) {
    if (entry.test(line)) {
      if (shown >= SHOWN_ENTRIES) {
        hidden += 1;
        continue;
      }
      shown += 1;
    }
    kept.push(line);
  }
  if (hidden > 0)
    kept.splice(
      kept.findLastIndex((line) => entry.test(line)) + 1,
      0,
      `  … and ${hidden} more; run npm run docs:freshness:check for the full list`,
    );
  const report = kept.join('\n');
  return result.status === 1 && text
    ? report
    : `${report}\n(The check's human report did not repeat the stale verdict: exit ${result.status ?? result.signal}. Run npm run docs:freshness:check.)`.trim();
}

/** Ledger files a pushed range adds or changes. */
function ledgerChanges(mergeBase, sha) {
  const listed = git([
    'diff',
    '--name-only',
    '--no-renames',
    '--diff-filter=AM',
    `${mergeBase}...${sha}`,
    '--',
    REVIEW_LEDGER_DIR,
  ]);
  return listed === null ? [] : listed.split('\n').filter(Boolean);
}

function scopedLine(mergeBase) {
  const described = git(['log', '-1', '--format=%H %cI', BASE_REF]);
  return `  Scoped against ${BASE_REF}${described ? ` at ${described.replace(' ', ', committed ')}` : ''}${mergeBase ? ` (merge base ${mergeBase.slice(0, 12)})` : ''}. If the list names files this branch did not change, run \`git fetch origin main\` and push again.`;
}

function main(stdinText) {
  const pushed = pushedShas(stdinText);
  const head = git(['rev-parse', 'HEAD']);
  // Before running anything: a base that cannot support a verdict.
  const bases = pushed.map((sha) => ({
    sha,
    base: resolvePushBase(BASE_REF, sha),
  }));
  const unusable = bases.find(({ base }) => base.state !== 'ok');
  if (unusable) {
    warn(`not checked: ${describeUnusableBase(BASE_REF, unusable.base)}.`);
    return 0;
  }
  const check = jsonVerdict();
  if (check.state === 'fresh') {
    console.log(
      `Documentation freshness: ${check.result.reviews} reviews and ${check.result.captures} captures current.`,
    );
    return 0;
  }
  if (check.state === 'error') {
    warn(
      `not checked: the check could not run (${check.detail}). Reproduce with npm run docs:freshness:check.`,
    );
    return 0;
  }
  const report = checkReport();
  const scoped = scopedLine(check.result.mergeBase);
  const headPushed = head !== null && pushed.includes(head);
  const clean = git(['status', '--porcelain', '--untracked-files=no']) === '';
  const recording = headPushed
    ? ledgerChanges(bases.find(({ sha }) => sha === head).base.mergeBase, head)
    : [];
  if (headPushed && clean && recording.length > 0) {
    console.error(
      [
        report,
        scoped,
        '',
        `FAIL: this branch records documentation reviews (${recording.length} ledger file(s) since its merge base), and the pushed commit, checked out with no uncommitted changes, leaves the reviews above stale. CI's docs:truth:gate refuses the same commit.`,
        '',
      ].join('\n'),
    );
    return 1;
  }
  const why = !headPushed
    ? 'the check read the checked-out commit, which is not the commit being pushed, so this list may not describe the pushed commit'
    : !clean
      ? 'the check read a working tree with uncommitted changes, so this list may not describe the pushed commit'
      : "this branch has not recorded any review yet; CI's statics job will fail on these until they are reviewed";
  console.log(
    [
      `WARNING: documentation freshness: only a warning because ${why}.`,
      report,
      scoped,
    ].join('\n'),
  );
  return 0;
}

if (invokedDirectly(import.meta.url)) {
  try {
    process.exitCode = main(readFileSync(0, 'utf8'));
  } catch (error) {
    warn(
      `not checked: the step could not run (${error instanceof Error ? error.message : error}).`,
    );
  }
}
