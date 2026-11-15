#!/usr/bin/env node
/**
 * Deploy-ledger commit-back with bounded re-derive-and-retry (archive#4572).
 * One checked-in implementation shared by nightly.yml,
 * publish-release.yml, and publish-packages.yml.
 *
 * ## Why retry is the normal case, not the exception
 *
 * Every channel PREPENDS to the same JSON array in
 * docs/reference/deploy-ledger.json, and every publishing workflow commits
 * its entry back to `main`. Two ships recording concurrently therefore
 * conflict on the same file by construction — the nightly's two records, a
 * stable npm publish, and a stable release can all race. The previous shape
 * (commit, `git rebase origin/main`, push once) failed permanently on that
 * conflict, losing the commit-back of a ship that had already happened.
 *
 * ## Why re-deriving on retry is safe, and why there is no rebase
 *
 * Each attempt FETCHES origin/main, detaches the checkout onto it, and
 * re-runs the appender (scripts/deploy-ledger.mjs) against main's current
 * ledger files, so the commit is CREATED with origin/main as its parent:
 * there is nothing to rebase, and the push is a fast-forward by
 * construction. A first design that committed on the shipped checkout and
 * then rebased onto main was proven (scratch repo, two writers) to conflict
 * deterministically: the rebased patch contains the OTHER writer's entry —
 * the parent is stale even though the content is fresh — and git's 3-way
 * merge refuses partially-overlapping insertions. Detaching removes the
 * race window that rebase cannot: the only remaining race is main moving
 * between fetch and push, which rejects the push (never corrupts it) and
 * is what the bounded retry handles.
 *
 * Re-running the appender is safe because it refuses a true duplicate —
 * identity is `channel|sha|version`, regardless of artifacts — so a retry
 * can never double-record a ship: neither this run's own entry (a rejected
 * push landed nothing) nor a concurrent writer's identical one (which
 * fails loud, honestly: the ship is already recorded). The record argv is
 * the same on every attempt, so a successful attempt always appends
 * exactly this run's entry to exactly `origin/main`'s current ledger, and
 * the pushed commit carries ledger files only.
 *
 * ## The ancestry guard
 *
 * With `--require-ancestor <sha>` (publish-release.yml passes the release
 * SHA), the script refuses before committing anything unless that SHA is an
 * ancestor of `origin/main`. Without the guard, a tag cut off-main would make
 * `git rebase origin/main` replay EVERY commit in `origin/main..HEAD` — the
 * whole off-main release history — onto main as a ledger side effect. A
 * ledger commit may carry ledger files only, never another ref's commits.
 *
 * ## Standing constraints inherited from the workflows' own commit-backs
 *
 * - The push is `--no-verify`: `npm run dependencies:ci` arms `.githooks`,
 *   and no repo gate may run inside a generated-docs push.
 * - The push credential is a GitHub App token (the require-green ruleset's
 *   bypass actor), whose pushes DO dispatch workflows. Loop safety is
 *   structural, not credential-based: no push-triggered workflow can reach
 *   a ledger record (publish-packages gates on PUBLISH_RUN, dispatch-only;
 *   nightly and publish-release have no push trigger). The push-triggered
 *   CI runs each ledger commit does start are an accepted cost — they
 *   verify the commit like any other.
 * - If the ruleset ever rejects this push (e.g. the app loses bypass),
 *   this fails loudly after the publish (never blocking it) and the entry
 *   survives in the artifact and job summary. The remedy is a deliberate
 *   credential-policy choice, not something this script may decide
 *   silently.
 *
 * ## Several rows, one commit
 *
 * Every ledger push to main discards the merge groups in flight, so the
 * Nightly records all of a run's rows (npm, Android, desktop) in ONE commit:
 * each `--record` group is one appender invocation, all of them run against
 * the same detached origin/main inside one attempt, and the attempt commits
 * once. A retry re-runs every group, exactly as it re-runs the single record.
 * With `--subject-run-id <run>` the subject is derived from the rows the
 * attempt actually added (`docs(ledger): record <channel> <version>, …
 * from run <run>`) and is refused unless it matches GENERATED_LEDGER_SUBJECT,
 * the shape normalize-deploy-ledger-head.mjs peels. A group may pass the
 * appender's `--if-absent`; when every group finds its row already on main,
 * the attempt changes nothing and exits 0 without committing or pushing.
 *
 * Interface:
 *   node scripts/lib/deploy-ledger-commit.mjs \
 *     --repo-root <path> (default: the repo containing this script) \
 *     (--commit-subject "docs(ledger): ..." | --subject-run-id <run-id>) \
 *     [--summary-line "- recorded: ..."] \
 *     [--require-ancestor <40-hex>] \
 *     (-- <record argv, e.g. node scripts/deploy-ledger.mjs ...>
 *      | --record <record argv> [--record <record argv>]...)
 *
 * Environment: `GITHUB_TOKEN` (when set, git fetch/push authenticate with a
 * process-scoped extraheader exactly like the workflows' other pushes — never
 * a persisted credential) and `GITHUB_STEP_SUMMARY` (when set, the summary
 * line is appended once the record succeeds, so a push that never succeeds
 * still leaves the summary + artifact fallback the review requires).
 *
 * Exit codes: 0 = recorded AND pushed, or every offered row was already on
 * main (only reachable through the appender's --if-absent); 1 = validation refusal, duplicate,
 * ancestry refusal, or three failed attempts (each named loudly).
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEPLOY_LEDGER_JSON_PATH,
  DEPLOY_LEDGER_MD_PATH,
  entryIdentityKey,
} from '../deploy-ledger.mjs';
import { GENERATED_LEDGER_SUBJECT } from '../normalize-deploy-ledger-head.mjs';
import { execFileSyncBounded } from './bounded-capture.mjs';
import { invokedDirectly } from './module-entry.mjs';

export const LEDGER_COMMIT_MAX_ATTEMPTS = 3;
const REMOTE = 'origin';
const BRANCH = 'main';

class LedgerCommitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LedgerCommitError';
  }
}

function runGit(args, { repoRoot, env, allowFailure = false }) {
  const gitEnv = { ...env };
  if (env.GITHUB_TOKEN) {
    gitEnv.GIT_CONFIG_COUNT = '1';
    gitEnv.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader';
    gitEnv.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(
      `x-access-token:${env.GITHUB_TOKEN}`,
    ).toString('base64')}`;
  }
  try {
    return execFileSyncBounded('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      env: gitEnv,
      windowsHide: true,
    });
  } catch (error) {
    if (allowFailure) return null;
    throw error;
  }
}

const RUN_ID_PATTERN = /^[1-9][0-9]*$/;

function readLedgerEntries(repoRoot) {
  const path = resolve(repoRoot, DEPLOY_LEDGER_JSON_PATH);
  if (!existsSync(path)) return [];
  const entries = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(entries)) {
    throw new LedgerCommitError(
      'deploy ledger JSON must be an array (newest first)',
    );
  }
  return entries;
}

/** `<channel> <version>`, with the npm package name when the row has one. */
function rowLabel(entry) {
  const version =
    typeof entry.package === 'string'
      ? `${entry.package}@${entry.version}`
      : entry.version;
  return `${entry.channel} ${version}`;
}

/** The rows this attempt added, in the order the groups recorded them. */
function addedRows(before, after) {
  const known = new Set(before.map((entry) => entryIdentityKey(entry)));
  return after.filter((entry) => !known.has(entryIdentityKey(entry))).reverse();
}

/**
 * The subject `--subject-run-id` writes for `rows` (in record order),
 * refused unless the head normalizer would peel it.
 *
 * @param {Array<{channel: string, version: string, package?: string}>} rows
 * @param {string} runId
 */
export function generatedLedgerSubject(rows, runId) {
  const subject = `docs(ledger): record ${rows.map(rowLabel).join(', ')} from run ${runId}`;
  if (!GENERATED_LEDGER_SUBJECT.test(subject)) {
    throw new LedgerCommitError(
      `derived ledger commit subject does not match the shape normalize-deploy-ledger-head.mjs peels: ${subject}`,
    );
  }
  return subject;
}

/**
 * The bounded re-derive-and-retry loop. `onBeforePush(attempt)` is a
 * test-injection seam (the two-writer convergence proof uses it to land the
 * other writer's push between this writer's derive and its push — the exact
 * race the retry exists for); production callers omit it.
 *
 * @param {object} options
 * @param {string} options.repoRoot
 * @param {string[] | null} [options.recordArgv] One record (the original interface).
 * @param {string[][] | null} [options.recordArgvs] Several records, one commit.
 * @param {string | null} [options.commitSubject]
 * @param {string | null} [options.subjectRunId] Derive the subject from the added rows.
 * @param {string | null} [options.summaryLine]
 * @param {string | null} [options.requireAncestorSha]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {number} [options.maxAttempts]
 * @param {((attempt: number) => void) | null} [options.onBeforePush]
 * @returns {{ pushed: boolean, attempts: number, recorded: string[] }}
 */
export function commitLedgerWithRetry({
  repoRoot,
  recordArgv = null,
  recordArgvs = null,
  commitSubject = null,
  subjectRunId = null,
  summaryLine = null,
  requireAncestorSha = null,
  env = process.env,
  maxAttempts = LEDGER_COMMIT_MAX_ATTEMPTS,
  onBeforePush = null,
}) {
  if ((recordArgv === null) === (recordArgvs === null)) {
    throw new LedgerCommitError(
      'pass exactly one of recordArgv or recordArgvs',
    );
  }
  const records = recordArgv === null ? recordArgvs : [recordArgv];
  if (
    !Array.isArray(records) ||
    records.length === 0 ||
    records.some((argv) => !Array.isArray(argv) || argv.length === 0)
  ) {
    throw new LedgerCommitError(
      'every record must be a non-empty argv array, and at least one is required',
    );
  }
  if ((commitSubject === null) === (subjectRunId === null)) {
    throw new LedgerCommitError(
      'pass exactly one of commitSubject or subjectRunId',
    );
  }
  if (
    commitSubject !== null &&
    (typeof commitSubject !== 'string' || commitSubject.trim() === '')
  ) {
    throw new LedgerCommitError('commitSubject must be a non-empty string');
  }
  if (
    subjectRunId !== null &&
    (typeof subjectRunId !== 'string' || !RUN_ID_PATTERN.test(subjectRunId))
  ) {
    throw new LedgerCommitError(
      `--subject-run-id must be a positive decimal run id: ${String(subjectRunId)}`,
    );
  }
  if (
    requireAncestorSha !== null &&
    !/^[0-9a-f]{40}$/.test(requireAncestorSha)
  ) {
    throw new LedgerCommitError(
      `--require-ancestor must be 40 lowercase hex: ${String(requireAncestorSha)}`,
    );
  }
  const git = (args, options = {}) =>
    runGit(args, { repoRoot, env, ...options });
  git(['config', 'user.name', 'github-actions[bot]']);
  git([
    'config',
    'user.email',
    '41898282+github-actions[bot]@users.noreply.github.com',
  ]);

  let summaryWritten = false;
  let lastFailure = 'no attempt ran';

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    git(['fetch', REMOTE, BRANCH]);
    const remoteHead = `${REMOTE}/${BRANCH}`;

    if (requireAncestorSha !== null) {
      const isAncestor = git(
        ['merge-base', '--is-ancestor', requireAncestorSha, remoteHead],
        { allowFailure: true },
      );
      if (isAncestor === null) {
        throw new LedgerCommitError(
          `refusing to commit the ledger back to main: the required sha ${requireAncestorSha} is not an ancestor of ${remoteHead}. A tag cut off main must never have its commits pushed to main as a ledger side effect; this is a human decision, not a retryable race.`,
        );
      }
    }

    // Build the ledger commit ON origin/main: detach the checkout onto it,
    // so the working tree IS main's tree and the appender derives from
    // main's current ledger. The commit's parent is then origin/main itself
    // — no rebase, and the push below is a fast-forward by construction.
    // Safety against a dirty tree comes from the explicit two-path `git add`
    // below (only the ledger files can enter the commit) — NOT from this
    // checkout: git carries non-conflicting local modifications forward
    // silently and refuses only when the checkout would overwrite them

    // earlier workflow steps leaving tracked modifications is exactly the
    // kind of state this commit must not silently absorb.
    // A record that failed part-way (an earlier call's later group refused)
    // leaves rows appended to the two ledger files but never committed.
    // Discard exactly those two files first: if main has since moved them,
    // the detach below would otherwise refuse to overwrite the edits and
    // lose this call's row. Nothing else in the tree is touched.
    for (const path of [DEPLOY_LEDGER_JSON_PATH, DEPLOY_LEDGER_MD_PATH]) {
      if (
        git(['cat-file', '-e', `HEAD:${path}`], { allowFailure: true }) !== null
      )
        git(['checkout', 'HEAD', '--', path]);
    }
    git(['checkout', '--detach', remoteHead]);
    // Then take main's copies, so every attempt derives from main's ledger
    // alone even where HEAD had no copy to reset to.
    for (const path of [DEPLOY_LEDGER_JSON_PATH, DEPLOY_LEDGER_MD_PATH]) {
      if (
        git(['cat-file', '-e', `${remoteHead}:${path}`], {
          allowFailure: true,
        }) !== null
      )
        git(['checkout', remoteHead, '--', path]);
    }
    const before = readLedgerEntries(repoRoot);

    for (const argv of records) {
      const record = spawnSync(argv[0], argv.slice(1), {
        cwd: repoRoot,
        stdio: 'inherit',
        env,
        windowsHide: true,
      });
      if (record.error) throw record.error;
      if (record.status !== 0) {
        throw new LedgerCommitError(
          `the ledger record step failed (exit ${record.status}); its output above is the cause. This is not retryable — a validation refusal or duplicate is the appender being honest.`,
        );
      }
    }

    const ledgerChanged = git([
      'status',
      '--porcelain',
      '--',
      DEPLOY_LEDGER_JSON_PATH,
      DEPLOY_LEDGER_MD_PATH,
    ]).trim();
    // Only an `--if-absent` group can succeed without writing; when every
    // group did, main already holds every offered row and there is nothing
    // to commit or push.
    if (ledgerChanged === '') {
      return { pushed: false, attempts: attempt, recorded: [] };
    }
    const rows = addedRows(before, readLedgerEntries(repoRoot));
    const recorded = rows.map(rowLabel);
    const subject = commitSubject ?? generatedLedgerSubject(rows, subjectRunId);
    const summary =
      summaryLine ??
      (subjectRunId !== null ? `- recorded: ${recorded.join(', ')}` : null);
    if (summary !== null && !summaryWritten && env.GITHUB_STEP_SUMMARY) {
      appendFileSync(
        env.GITHUB_STEP_SUMMARY,
        `### Deploy ledger\n\n${summary}\n`,
      );
      summaryWritten = true;
    }

    git(['add', DEPLOY_LEDGER_JSON_PATH, DEPLOY_LEDGER_MD_PATH]);
    git(['commit', '-m', subject]);

    if (onBeforePush !== null) onBeforePush(attempt);

    const pushed = git(
      ['push', '--no-verify', REMOTE, `HEAD:refs/heads/${BRANCH}`],
      {
        allowFailure: true,
      },
    );
    if (pushed !== null) {
      return { pushed: true, attempts: attempt, recorded };
    }
    lastFailure = `attempt ${attempt}: push to ${REMOTE}/${BRANCH} was rejected (main moved again during this attempt)`;
  }

  throw new LedgerCommitError(
    `could not commit the deploy ledger back to main after ${maxAttempts} attempts (${lastFailure}). The ship IS recorded — the ledger files in this checkout and the run summary carry the entry, and the "Retain this run's deploy ledger files" artifact uploads them — but main does not. Reconcile by hand from the artifact; do not re-publish.`,
  );
}

function usage() {
  return [
    'usage: node scripts/lib/deploy-ledger-commit.mjs \\',
    '         (--commit-subject "docs(ledger): ..." | --subject-run-id <run-id>) \\',
    '         [--summary-line <line>] [--require-ancestor <40-hex>] [--repo-root <path>] \\',
    '         (-- <record argv...> | --record <record argv...> [--record <record argv...>]...)',
  ].join('\n');
}

/**
 * Split everything from the first `--record` into one argv per group. A
 * group is everything up to the next literal `--record`; an empty group is
 * refused rather than skipped.
 */
function splitRecordGroups(tokens) {
  const groups = [];
  for (const token of tokens) {
    if (token === '--record') groups.push([]);
    else groups[groups.length - 1].push(token);
  }
  return groups.some((group) => group.length === 0) ? null : groups;
}

function main(argv) {
  let commitSubject = null;
  let subjectRunId = null;
  let summaryLine = null;
  let requireAncestorSha = null;
  let repoRoot = null;
  let recordArgv = null;
  let recordArgvs = null;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--') {
      recordArgv = argv.slice(i + 1);
      break;
    }
    if (flag === '--record') {
      recordArgvs = splitRecordGroups(argv.slice(i));
      if (recordArgvs === null) {
        console.error('every --record group needs a record argv');
        console.error(usage());
        return 1;
      }
      break;
    }
    const value = argv[i + 1];
    if (value === undefined) {
      console.error(`malformed argument: ${flag}`);
      console.error(usage());
      return 1;
    }
    if (flag === '--commit-subject') commitSubject = value;
    else if (flag === '--subject-run-id') subjectRunId = value;
    else if (flag === '--summary-line') summaryLine = value;
    else if (flag === '--require-ancestor') requireAncestorSha = value;
    else if (flag === '--repo-root') repoRoot = value;
    else {
      console.error(`unknown argument: ${flag}`);
      console.error(usage());
      return 1;
    }
    i += 1;
  }
  if (
    (commitSubject === null) === (subjectRunId === null) ||
    (recordArgv === null && recordArgvs === null) ||
    (recordArgv !== null && recordArgv.length === 0)
  ) {
    console.error(usage());
    return 1;
  }
  repoRoot = resolve(
    repoRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
  );
  if (!existsSync(resolve(repoRoot, '.git'))) {
    console.error(`--repo-root is not a git repository: ${repoRoot}`);
    return 1;
  }
  try {
    const result = commitLedgerWithRetry({
      repoRoot,
      recordArgv,
      recordArgvs,
      commitSubject,
      subjectRunId,
      summaryLine,
      requireAncestorSha,
    });
    process.stdout.write(
      result.pushed
        ? `deploy ledger committed to main (attempt ${result.attempts}): ${result.recorded.join(', ')}\n`
        : 'deploy ledger on main already records every offered row; nothing committed\n',
    );
    return 0;
  } catch (error) {
    console.error(`::error::${error.message}`);
    return 1;
  }
}

// invokedDirectly realpaths both sides: an unresolved argv[1] under a symlinked workspace
// makes this compare false, the script imports as a module, and it exits 0
// having recorded nothing — the exact silent-unrecorded-ship gap this
// feature exists to close.
if (invokedDirectly(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
