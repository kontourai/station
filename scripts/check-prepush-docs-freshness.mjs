#!/usr/bin/env node
/**
 * Pre-push: recorded documentation reviews this branch left stale.
 *
 * Runs the real `docs:freshness:check` (scripts/check-documentation-freshness.mjs
 * --json) and decides only what its verdict means for this push:
 *
 * - fresh: one line, and the push continues;
 * - stale, and some pushed commit's range (merge base with origin/main up to
 *   the pushed sha) adds or changes a file under the review ledger: REFUSED,
 *   with the check's own list and remedy. The author has started recording
 *   reviews, so a stale entry now is a note outdated by a later edit or a
 *   cited page missed, which is what CI's docs:truth:gate kept failing on;
 * - stale, and no pushed range touches the ledger: the same list as a
 *   WARNING, and the push continues. Refusing here would force notes before
 *   the change is final, and every later edit would make them stale again;
 * - the check itself fails to run, or does not finish within its bound:
 *   REFUSED, saying so. "Could not check" never reads as "fresh" or "stale".
 *
 * When stale, it names the base commit and date the check was scoped
 * against: a local origin/main older than the main this branch merged makes
 * main's own changes look like this branch's. A merge on the branch whose
 * second parent that base does not contain is that case, and it is named
 * explicitly. No network call is made.
 *
 * Reads git's pre-push ref lines on stdin. The check reads the working tree,
 * like the static gates.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CAPTURE_MAX_BYTES } from './lib/bounded-capture.mjs';
import { scaleLivenessMs } from './lib/liveness-scale.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';
import { REVIEW_LEDGER_DIR } from './lib/review-ledger-paths.mjs';

const BASE_REF = process.env.STATION_BASE_REF ?? 'origin/main';
const ZERO = /^0+$/;
/** A liveness bound on the check (~5-8s here), not a performance budget. */
const CHECK_TIMEOUT_BASE_MS = 120_000;
/**
 * Test-only: replaces the base of that bound so a test can prove the timeout
 * path without a two-minute wait. Anything but a positive integer refuses.
 */
const TIMEOUT_OVERRIDE_ENV = 'STATION_PREPUSH_DOCS_FRESHNESS_TIMEOUT_MS';

function checkTimeoutMs(env = process.env) {
  const raw = env[TIMEOUT_OVERRIDE_ENV];
  if (raw === undefined || raw === '')
    return scaleLivenessMs(CHECK_TIMEOUT_BASE_MS, env);
  if (!/^[1-9][0-9]*$/.test(raw))
    throw new Error(
      `${TIMEOUT_OVERRIDE_ENV} must be a positive integer of milliseconds, not '${raw.slice(0, 32)}'`,
    );
  return scaleLivenessMs(Number(raw), env);
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

/** Ledger files a pushed range adds or changes; null when it cannot tell. */
function ledgerChanges(sha) {
  const mergeBase = git(['merge-base', BASE_REF, sha]);
  if (!mergeBase) return null;
  const listed = git([
    'diff',
    '--name-only',
    '--no-renames',
    '--diff-filter=AM',
    `${mergeBase}...${sha}`,
    '--',
    REVIEW_LEDGER_DIR,
  ]);
  return listed === null ? null : listed.split('\n').filter(Boolean);
}

function runCheck() {
  const timeout = checkTimeoutMs();
  const result = spawnSync(process.execPath, [CHECK, '--json'], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: CAPTURE_MAX_BYTES,
    timeout,
    killSignal: 'SIGKILL',
  });
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
  if (result.error || result.signal)
    return {
      state: 'error',
      detail:
        result.error?.code === 'ETIMEDOUT' || result.signal
          ? `did not finish within ${Math.round(timeout / 1000)}s`
          : String(result.error?.message ?? result.signal),
    };
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
 * The check's own human report and remedy, verbatim: the JSON result carries
 * no wording by design, so a stale verdict is re-run in its human form. That
 * costs a second run only when something is stale.
 */
function checkReport() {
  const result = spawnSync(process.execPath, [CHECK], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: CAPTURE_MAX_BYTES,
    timeout: checkTimeoutMs(),
    killSignal: 'SIGKILL',
  });
  const text = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  return result.status === 1 && text
    ? text
    : `${text}\n(The check's human report did not repeat the stale verdict: exit ${result.status ?? result.signal}. Run npm run docs:freshness:check.)`.trim();
}

/** Which base it was scoped against, and whether that base looks stale. */
function baseLines(result) {
  const base = result.base ?? BASE_REF;
  const described = git(['log', '-1', '--format=%H %cI', base]);
  const lines = [
    `  Scoped against ${base}${described ? ` at ${described.replace(' ', ', committed ')}` : ''}${result.mergeBase ? ` (merge base ${result.mergeBase.slice(0, 12)})` : ''}.`,
  ];
  const mergeBase = result.mergeBase;
  const unknownMerges = mergeBase
    ? (git(['rev-list', '--merges', '--parents', `${mergeBase}..HEAD`]) ?? '')
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split(' ')[2])
        .filter(
          (parent) =>
            parent &&
            git(['merge-base', '--is-ancestor', parent, base]) === null,
        )
    : [];
  if (unknownMerges.length > 0)
    lines.push(
      `  This branch merges ${unknownMerges.length} commit(s) ${base} here does not contain (${unknownMerges
        .slice(0, 3)
        .map((sha) => sha.slice(0, 12))
        .join(
          ', ',
        )}). If that was main, the local ${base} is stale and main's own changes are counted as this branch's: run \`git fetch origin main\` and push again.`,
    );
  else
    lines.push(
      `  If the list names files this branch did not change, run \`git fetch origin main\` and push again.`,
    );
  return lines;
}

function main(stdinText) {
  const check = runCheck();
  if (check.state === 'fresh') {
    console.log(
      `Documentation freshness: ${check.result.reviews} reviews and ${check.result.captures} captures current.`,
    );
    return 0;
  }
  if (check.state === 'error') {
    console.error(
      `FAIL: the documentation freshness check could not run (${check.detail}), so this push is refused rather than assumed current. Reproduce with:\n\n  npm run docs:freshness:check\n`,
    );
    return 1;
  }
  const report = checkReport();
  const ranges = pushedShas(stdinText).map((sha) => ({
    sha,
    ledger: ledgerChanges(sha),
  }));
  const recording = ranges.filter((range) => range.ledger?.length);
  // A range whose ledger changes cannot be read is treated as recording:
  // "could not tell" must not decide for the lenient side.
  const unknown = ranges.filter((range) => range.ledger === null);
  if (recording.length > 0 || unknown.length > 0) {
    console.error(
      [
        report,
        ...baseLines(check.result),
        '',
        recording.length > 0
          ? `FAIL: this branch records documentation reviews (${recording[0].ledger.length} ledger file(s) since its merge base), so the stale entries above refuse the push. CI's docs:truth:gate refuses them too.`
          : `FAIL: could not tell whether this branch records documentation reviews (no merge base with ${BASE_REF}), so the stale entries above refuse the push.`,
        '',
      ].join('\n'),
    );
    return 1;
  }
  console.log(
    [
      "WARNING: CI's statics job will fail on these until they are reviewed. The push is allowed because this branch has not recorded any review yet.",
      report,
      ...baseLines(check.result),
    ].join('\n'),
  );
  return 0;
}

if (invokedDirectly(import.meta.url)) {
  try {
    process.exitCode = main(readFileSync(0, 'utf8'));
  } catch (error) {
    console.error(
      `FAIL: the documentation freshness step could not run (${error instanceof Error ? error.message : error}), so this push is refused.`,
    );
    process.exitCode = 1;
  }
}
