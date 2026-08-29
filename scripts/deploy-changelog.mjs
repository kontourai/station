#!/usr/bin/env node
/**
 * Deploy-ledger changelog slices (station#4572).
 *
 * One ledger entry names the commit a channel shipped; this script derives
 * WHAT CHANGED in that ship: the commits between the previous recorded ship
 * SHA of the same channel and the new SHA, grouped by conventional-commit
 * type, each line linked to the pull request that carried it.
 *
 * Everything is split so the derivation is testable without Git: the parsers
 * and the grouping are pure functions over `git log --format` text, and only
 * `deriveChangelogSlice` runs Git (through the injected executor, so callers
 * stay hermetic).
 *
 * Honesty rules, stated because a changelog is a claim:
 * - A merge commit itself never emits a line ("Merge pull request #N from
 *   …" carries no information a reader wants). It ATTRIBUTES its pull-request
 *   number to the commits it brought in, which are the real changes.
 * - A commit with no conventional prefix and no reachable pull-request number
 *   still appears, unlinked, under `other`. Silence would be a false "no
 *   changes" signal.
 * - `docs(ledger):` commits are the ledger recording itself. They are excluded
 *   from every slice: bookkeeping about the record is not a product change,
 *   and including them would make every slice reference the previous slice's
 *   commit — noise with no reader.
 */

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CHANGELOG_GROUP_ORDER = Object.freeze([
  'feat',
  'fix',
  'ci',
  'docs',
  'other',
]);

/** Conventional types mapped onto the five published groups. */
const TYPE_TO_GROUP = new Map(
  Object.entries({
    feat: 'feat',
    fix: 'fix',
    ci: 'ci',
    docs: 'docs',
    chore: 'other',
    test: 'other',
    refactor: 'other',
    perf: 'other',
    style: 'other',
    build: 'other',
    revert: 'other',
  }),
);

/** Subjects the ledger itself writes; excluded from every slice. */
export const LEDGER_COMMIT_SUBJECT_PATTERN = /^docs\(ledger\):/;

const MERGE_SUBJECT_PATTERN = /^Merge pull request #(\d+) from \S+/;
const TRAILING_PR_PATTERN = /\(#(\d+)\)$/;

/** `Merge pull request #4572 from kontourai/feat/x` → `4572`. */
export function parseMergePullRequest(subject) {
  const match = MERGE_SUBJECT_PATTERN.exec(subject);
  return match ? Number(match[1]) : null;
}

/** `feat(x): do a thing (#4572)` → `4572` (squash-merge style). */
export function parseTrailingPullRequest(subject) {
  const match = TRAILING_PR_PATTERN.exec(subject);
  return match ? Number(match[1]) : null;
}

/** `fix(ci): subject` → the published group; unknown prefixes → `other`. */
export function classifyCommitGroup(subject) {
  const match = /^([a-z]+)(?:\([^)]*\))?!?:\s+/.exec(subject);
  if (!match) return 'other';
  return TYPE_TO_GROUP.get(match[1]) ?? 'other';
}

/**
 * Parse `git log --format='%H%x00%P%x00%s'` output. Subject lines cannot
 * contain newlines (Git strips them), so one line is exactly one commit.
 */
export function parseGitLogOutput(raw) {
  if (typeof raw !== 'string') {
    throw new Error('git log output must be a string');
  }
  const entries = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    const [sha, parents, subject] = line.split('\0');
    if (!/^[0-9a-f]{40}$/.test(sha ?? '')) {
      throw new Error(`unexpected git log line (bad sha): ${line}`);
    }
    entries.push({
      sha,
      parents: parents === '' ? [] : parents.split(' '),
      subject: subject ?? '',
    });
  }
  return entries;
}

export function pullRequestUrl(githubRepo, pr) {
  return `https://github.com/${githubRepo}/pull/${pr}`;
}

/**
 * Build the grouped markdown lines for one slice. `commits` are the
 * non-merge, non-ledger commits of the range, each optionally carrying the
 * pull-request number that delivered them.
 */
export function groupChangelogSlice({ commits, githubRepo }) {
  if (!Array.isArray(commits)) {
    throw new Error('changelog commits must be an array');
  }
  if (
    typeof githubRepo !== 'string' ||
    !/^[^/\s]+\/[^/\s]+$/.test(githubRepo)
  ) {
    throw new Error(
      `githubRepo must look like owner/name: ${String(githubRepo)}`,
    );
  }
  const groups = Object.fromEntries(
    CHANGELOG_GROUP_ORDER.map((group) => [group, []]),
  );
  for (const commit of commits) {
    const subject = String(commit.subject ?? '').trim();
    if (subject === '') continue;
    const group = classifyCommitGroup(subject);
    let displayed = subject;
    let pr = commit.pr ?? null;
    if (pr === null) {
      const trailing = parseTrailingPullRequest(displayed);
      if (trailing !== null) {
        pr = trailing;
        displayed = displayed.replace(TRAILING_PR_PATTERN, '').trimEnd();
      }
    } else {
      displayed = displayed.replace(TRAILING_PR_PATTERN, '').trimEnd();
    }
    const line = pr
      ? `[#${pr}](${pullRequestUrl(githubRepo, pr)}) ${displayed}`
      : displayed;
    groups[group].push(line);
  }
  return { groups };
}

/**
 * The Git-backed derivation. `execGit` is injected so tests and callers with
 * pre-captured log output never spawn a process.
 */
export function deriveChangelogSlice({
  repoRoot,
  previousSha,
  sha,
  githubRepo,
  execGit = (args) =>
    execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      windowsHide: true,
    }),
}) {
  if (!/^[0-9a-f]{40}$/.test(sha ?? '')) {
    throw new Error(`changelog sha must be 40 lowercase hex: ${String(sha)}`);
  }
  if (previousSha !== null && !/^[0-9a-f]{40}$/.test(previousSha ?? '')) {
    throw new Error(
      `changelog previousSha must be 40 lowercase hex or null: ${String(previousSha)}`,
    );
  }
  if (previousSha === null) {
    // First entry for a channel: there is no previous ship SHA to slice
    // from, so the slice is OMITTED (not "everything since the beginning",
    // which would attribute the whole repository's history to one deploy).
    return {
      previousSha: null,
      groups: Object.fromEntries(CHANGELOG_GROUP_ORDER.map((g) => [g, []])),
      note: 'First recorded entry for this channel; no previous ship SHA exists in the ledger, so no changelog slice was derived.',
      commitCount: 0,
    };
  }
  // A previous ship SHA can be absent from this repository entirely: the
  // ledger survives history resets, so a predecessor row may point into a
  // history this repository no longer carries. No commit range exists to
  // slice in that case — disclose the gap on this one entry rather than
  // failing every subsequent ship on the channel forever.
  try {
    execGit(['cat-file', '-e', `${previousSha}^{commit}`]);
  } catch (error) {
    // Only a genuinely missing OBJECT is the disclosed case. Everything
    // else a failed probe can mean — git missing (ENOENT), not a
    // repository, a corrupt or unreadable object store — must stay loud,
    // or a broken environment would masquerade as an honest history gap.
    const stderr =
      typeof error?.stderr === 'string'
        ? error.stderr
        : (error?.stderr?.toString?.() ?? '');
    const failureText = `${stderr}\n${error?.message ?? ''}`;
    if (!/Not a valid object name/.test(failureText)) throw error;
    return {
      previousSha,
      groups: Object.fromEntries(CHANGELOG_GROUP_ORDER.map((g) => [g, []])),
      note: `Changelog slice omitted: previous ship SHA ${previousSha.slice(0, 7)} is not reachable in this repository's history, so no commit range exists to derive.`,
      commitCount: 0,
    };
  }
  const entries = parseGitLogOutput(
    execGit(['log', '--format=%H%x00%P%x00%s', `${previousSha}..${sha}`]),
  );
  const prBySha = new Map();
  for (const entry of entries) {
    if (entry.parents.length < 2) continue;
    const pr = parseMergePullRequest(entry.subject);
    if (pr === null) continue;
    const inner = execGit(['rev-list', `${entry.sha}^1..${entry.sha}`])
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^[0-9a-f]{40}$/.test(line));
    for (const innerSha of inner) {
      if (!prBySha.has(innerSha)) prBySha.set(innerSha, pr);
    }
  }
  const commits = entries
    .filter((entry) => entry.parents.length < 2)
    .filter((entry) => !LEDGER_COMMIT_SUBJECT_PATTERN.test(entry.subject))
    .map((entry) => ({
      sha: entry.sha,
      subject: entry.subject,
      pr: prBySha.get(entry.sha) ?? null,
    }));
  const { groups } = groupChangelogSlice({ commits, githubRepo });
  return {
    previousSha,
    groups,
    note: null,
    commitCount: commits.length,
  };
}

function usage() {
  return [
    'usage: node scripts/deploy-changelog.mjs --sha <40-hex> [--previous-sha <40-hex>|none]',
    '                     --github-repo owner/name [--repo-root <path>]',
    '',
    'Prints the changelog slice for one ledger entry as JSON.',
    'Pass --previous-sha none (or omit it) for a channel\u2019s first entry.',
  ].join('\n');
}

function main(argv) {
  const flags = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    flags.set(argv[i], argv[i + 1]);
  }
  if (
    flags.get('--sha') === undefined ||
    flags.get('--github-repo') === undefined
  ) {
    console.error(usage());
    return 1;
  }
  const previousFlag = flags.get('--previous-sha');
  const previousSha =
    previousFlag === undefined || previousFlag === 'none' ? null : previousFlag;
  const slice = deriveChangelogSlice({
    repoRoot: resolve(
      dirname(fileURLToPath(import.meta.url)),
      flags.get('--repo-root') ?? '..',
    ),
    previousSha,
    sha: flags.get('--sha'),
    githubRepo: flags.get('--github-repo'),
  });
  process.stdout.write(`${JSON.stringify(slice, null, 2)}\n`);
  return 0;
}

// realpathSync both sides: an unresolved argv[1] under a symlinked workspace
// makes this compare false, the script imports as a module, and it exits 0
// having recorded nothing — the exact silent-unrecorded-ship gap this
// feature exists to close.
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exit(main(process.argv.slice(2)));
}
