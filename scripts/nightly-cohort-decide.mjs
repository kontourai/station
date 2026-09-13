#!/usr/bin/env node
/**
 * CLI for the native Nightly cohort decision (#1780).
 *
 * `nightly-native-stage.yml`'s decide step runs this after normalizing HEAD
 * against each rolling marker. It reads the deploy ledger from `origin/main`
 * and asks `decideNativeCohort` whether a cohort is needed, then writes
 * `build=<true|false>` to `$GITHUB_OUTPUT` and the reasons to
 * `$GITHUB_STEP_SUMMARY` (both also echoed to stdout).
 *
 * Why `origin/main`'s ledger and not the checkout's: the stage job checks
 * out the exact SOURCE SHA under decision, and ledger rows are committed to
 * main AFTER a ship — so the checkout's own ledger can never contain the
 * row for the ship that moved the marker to that SHA. The ref the decide
 * step fetched (`git fetch --no-tags origin main` in its `source` step) is
 * the authority for what has been recorded. Reading from git rather than
 * the network keeps this deterministic for the run and fail-closed: a
 * missing ref or unreadable ledger is an error, never "no rows".
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEPLOY_LEDGER_JSON_PATH } from './deploy-ledger.mjs';
import {
  decideNativeCohort,
  NO_COHORT_NEEDED,
} from './lib/nightly-cohort-decision.mjs';

export const DEFAULT_LEDGER_REF = 'origin/main';

const FLAGS = new Map([
  ['--head-sha', 'headSha'],
  ['--android-marker', 'androidMarker'],
  ['--android-candidate', 'androidCandidate'],
  ['--desktop-marker', 'desktopMarker'],
  ['--desktop-candidate', 'desktopCandidate'],
  ['--rebuild-index', 'rebuildIndex'],
  ['--ledger-ref', 'ledgerRef'],
  ['--repo-root', 'repoRoot'],
]);
const REQUIRED = [
  '--head-sha',
  '--android-marker',
  '--android-candidate',
  '--desktop-marker',
  '--desktop-candidate',
];

function usage() {
  return [
    'usage: node scripts/nightly-cohort-decide.mjs \\',
    '         --head-sha <40-hex> \\',
    '         --android-marker <40-hex-or-empty> --android-candidate <40-hex> \\',
    '         --desktop-marker <40-hex-or-empty> --desktop-candidate <40-hex> \\',
    '         [--rebuild-index <value-or-empty>] [--ledger-ref <git-ref>] [--repo-root <path>]',
    '',
    'Decides whether a native Nightly cohort is needed from the rolling markers',
    `and the deploy ledger at <git-ref> (default ${DEFAULT_LEDGER_REF}); writes build=`,
    'to $GITHUB_OUTPUT and the reasons to $GITHUB_STEP_SUMMARY when set.',
  ].join('\n');
}

export function parseArgs(argv) {
  const options = {
    rebuildIndex: '',
    ledgerRef: DEFAULT_LEDGER_REF,
    repoRoot: process.cwd(),
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!FLAGS.has(flag) || value === undefined || seen.has(flag)) {
      return null;
    }
    seen.add(flag);
    options[FLAGS.get(flag)] = value;
  }
  if (!REQUIRED.every((flag) => seen.has(flag))) return null;
  return options;
}

/**
 * The ledger as recorded at `ref`, read through `git show` so the run's own
 * fetched ref is the authority. A ref that cannot be shown or a document that
 * does not parse throws — the decision must not run on a guess.
 */
export function readLedgerFromGit(repoRoot, ref) {
  const result = spawnSync(
    'git',
    ['show', `${ref}:${DEPLOY_LEDGER_JSON_PATH}`],
    { cwd: repoRoot, encoding: 'utf8', windowsHide: true },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `git show ${ref}:${DEPLOY_LEDGER_JSON_PATH} failed: ${(result.stderr || result.stdout || '').trim()}`,
    );
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(
      `deploy ledger at ${ref} is not valid JSON: ${error.message}`,
    );
  }
}

function emitOutput(line) {
  process.stdout.write(`${line}\n`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`);
  }
}

function emitSummary(lines) {
  const text = `${lines.join('\n')}\n`;
  process.stdout.write(text);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  }
}

export function main(argv, { readLedger = readLedgerFromGit } = {}) {
  const options = parseArgs(argv);
  if (options === null) {
    console.error(usage());
    return 1;
  }
  let decision;
  try {
    const ledgerEntries = readLedger(options.repoRoot, options.ledgerRef);
    decision = decideNativeCohort({
      headSha: options.headSha,
      platforms: {
        android: {
          markerSha: options.androidMarker,
          candidateSha: options.androidCandidate,
        },
        macos: {
          markerSha: options.desktopMarker,
          candidateSha: options.desktopCandidate,
        },
      },
      ledgerEntries,
      rebuildIndex: options.rebuildIndex,
    });
  } catch (error) {
    console.error(`::error::${error.message}`);
    return 1;
  }
  emitOutput(`build=${decision.build}`);
  emitSummary(
    decision.build
      ? [
          `Native cohort builds for ${options.headSha}:`,
          ...decision.reasons.map((reason) => `- ${reason}`),
        ]
      : [NO_COHORT_NEEDED],
  );
  return 0;
}

// realpathSync both sides so a symlinked workspace cannot make this import
// as a module and exit 0 without deciding anything.
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exit(main(process.argv.slice(2)));
}
