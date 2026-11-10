#!/usr/bin/env node
// Duplicate-after-merge sweep (report-only). When a PR merges, find open
// sibling PRs that look superseded and comment the evidence on the merged PR.
// This script NEVER closes anything: closing is owner work until the
// shadow run earns enforcement (see the tracking issue).
//
//   node scripts/pr-duplicate-sweep.mjs --pr 2629            # report to stdout
//   node scripts/pr-duplicate-sweep.mjs --pr 2629 --apply    # comment once on the merged PR
import { execFileSyncBounded } from './lib/bounded-capture.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';

const COMMENT_MARKER = '<!-- pr-duplicate-sweep -->';
const CLOSING_RE = /(?:closes|fixes|resolves)\s+#(\d+)/gi;
const MERGED_LIMIT = 100;
const OPEN_LIMIT = 200;

/** Every `gh` failure throws: a lookup that failed is not an empty answer. */
function runGh(args, { input } = {}) {
  return execFileSyncBounded('gh', args, {
    encoding: 'utf8',
    windowsHide: true,
    ...(input === undefined ? {} : { input }),
  }).trim();
}

export function parseClosingIssues(body) {
  const numbers = new Set();
  for (const match of String(body ?? '').matchAll(CLOSING_RE)) {
    numbers.add(Number(match[1]));
  }
  return numbers;
}

function commonFiles(a, b) {
  const other = new Set(b);
  return a.filter((file) => other.has(file));
}

export function findSupersededCandidates(
  merged,
  candidates,
  { minCommonFiles = 3, ratio = 0.6 } = {},
) {
  const mergedIssues = merged.closingIssueNumbers;
  const results = [];
  for (const candidate of candidates) {
    const sharedIssues = [...candidate.closingIssueNumbers].filter((number) =>
      mergedIssues.has(number),
    );
    const overlap = commonFiles(merged.files, candidate.files);
    const smaller = Math.max(
      1,
      Math.min(merged.files.length, candidate.files.length),
    );
    const shareRatio = overlap.length / smaller;
    if (sharedIssues.length > 0) {
      results.push({
        number: candidate.number,
        reason: 'shared-linked-issue',
        evidence: `both reference issue(s) ${sharedIssues.map((n) => `#${n}`).join(', ')}`,
      });
    } else if (overlap.length >= minCommonFiles && shareRatio >= ratio) {
      results.push({
        number: candidate.number,
        reason: 'file-overlap',
        evidence: `${overlap.length} common file(s) (${Math.round(shareRatio * 100)}% of the smaller diff): ${overlap.slice(0, 8).join(', ')}${overlap.length > 8 ? ', …' : ''}`,
      });
    }
  }
  return results;
}

function buildComment(candidates) {
  if (candidates.length === 0) return null;
  return [
    COMMENT_MARKER,
    `**Possible superseded sibling PRs.** Report-only sweep; nothing was closed. Candidates cite this PR's merged change — confirm intent before closing.`,
    '',
    ...candidates.map(
      (candidate) =>
        `- #${candidate.number} — ${candidate.reason}: ${candidate.evidence}`,
    ),
    '',
  ].join('\n');
}

function listMergedSince(since) {
  const listing = runGh([
    'pr',
    'list',
    '--repo',
    process.env.GITHUB_REPOSITORY,
    '--state',
    'merged',
    '--search',
    `merged:>=${since}`,
    '--json',
    'number',
    '--limit',
    String(MERGED_LIMIT),
  ]);
  const numbers = JSON.parse(listing || '[]').map((pull) => pull.number);
  if (numbers.length >= MERGED_LIMIT)
    console.log(
      `[pr-duplicate] the merged listing reached its ${MERGED_LIMIT}-PR limit; older merges in range were not swept`,
    );
  return numbers;
}

/**
 * The open pull requests every merged PR is compared against. Fetched once
 * per run: the listing carries each PR's files, and it does not change
 * between the merged PRs of one sweep.
 */
function listOpenCandidates(repoArgs) {
  const open = JSON.parse(
    runGh([
      'pr',
      'list',
      ...repoArgs,
      '--state',
      'open',
      '--json',
      'number,title,body,files',
      '--limit',
      String(OPEN_LIMIT),
    ]),
  );
  if (open.length >= OPEN_LIMIT)
    console.log(
      `[pr-duplicate] the open listing reached its ${OPEN_LIMIT}-PR limit; older open PRs were not compared`,
    );
  return open.map((pull) => ({
    number: pull.number,
    files: (pull.files ?? []).map((file) => file.path),
    closingIssueNumbers: parseClosingIssues(pull.body),
  }));
}

function sweepPr(pr, argv, repoArgs, openCandidates) {
  const merged = JSON.parse(
    runGh(['pr', 'view', pr, ...repoArgs, '--json', 'number,title,body,files']),
  );
  const mergedFiles = (merged.files ?? []).map((file) => file.path);
  const candidates = findSupersededCandidates(
    {
      files: mergedFiles,
      closingIssueNumbers: parseClosingIssues(merged.body),
    },
    openCandidates,
  );
  const comment = buildComment(candidates);
  if (!comment) {
    console.log('[pr-duplicate] no superseded candidates');
    return;
  }
  console.log(comment);
  if (argv.includes('--apply')) {
    // Fails closed: if the existing comments cannot be read this throws
    // rather than reading as "none", which would post a second report.
    const existing = runGh([
      'pr',
      'view',
      pr,
      ...repoArgs,
      '--json',
      'comments',
      '--jq',
      '[.comments[].body] | join("\\n")',
    ]);
    if (existing.includes(COMMENT_MARKER)) {
      console.log(
        '[pr-duplicate] report comment already present; not duplicating',
      );
      return;
    }
    runGh(['pr', 'comment', pr, ...repoArgs, '--body-file', '-'], {
      input: comment,
    });
    console.log(`[pr-duplicate] commented on #${pr}`);
  }
}

function main(argv) {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo)
    throw new Error(
      'GITHUB_REPOSITORY is required; name the remedy in the caller',
    );
  const repoArgs = ['--repo', repo];
  const prIndex = argv.indexOf('--pr');
  const sinceIndex = argv.indexOf('--since');
  if (prIndex < 0 && sinceIndex < 0) {
    throw new Error('--pr <number> or --since <date> is required');
  }
  const targets =
    prIndex >= 0 ? [argv[prIndex + 1]] : listMergedSince(argv[sinceIndex + 1]);
  if (targets.length === 0) {
    console.log('[pr-duplicate] no merged PRs in range');
    return;
  }
  const openCandidates = listOpenCandidates(repoArgs);
  for (const pr of targets) sweepPr(pr, argv, repoArgs, openCandidates);
}

if (invokedDirectly(import.meta.url)) {
  main(process.argv.slice(2));
}
