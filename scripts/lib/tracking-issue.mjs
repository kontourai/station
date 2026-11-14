/**
 * One GitHub tracking issue per scheduled sweep (#2923): found by its exact
 * title and its author, created only when something is outstanding, updated
 * while anything is, and closed as completed once nothing is. The sweeps
 * never fail a required check; this issue is how their findings stay visible.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSyncBounded } from './bounded-capture.mjs';

/** Below GitHub's 65,536-character issue body cap, with room to spare. */
export const TRACKING_BODY_LIMIT = 60_000;

/**
 * A report is written by a job that runs installed (third-party) code and
 * posted by a job that holds `issues: write`. Before posting, refuse a body
 * over the limit and break every `@` mention, so a tampered report cannot
 * ping people through the write token. Returns the path of the copy to post.
 * @param {string} reportPath
 * @param {{ limit?: number }} [options]
 */
export function postableReport(
  reportPath,
  { limit = TRACKING_BODY_LIMIT } = {},
) {
  const body = readFileSync(reportPath, 'utf8');
  if (body.length > limit)
    throw new Error(
      `report is ${body.length} characters; refusing to post more than ${limit}`,
    );
  const path = `${reportPath}.postable`;
  // A zero-width space after `@` keeps the text readable and stops GitHub
  // from resolving it as a user or team mention.
  writeFileSync(path, body.replace(/@(?=[A-Za-z0-9_-])/g, '@\u200b'));
  return path;
}

/**
 * The login GitHub gives an issue created with a workflow's GITHUB_TOKEN
 * (checked on #2953, the documentation sweep's tracker). Anyone can open an
 * issue with a tracker's title, so only an issue this identity wrote counts.
 */
export const TRACKING_ISSUE_AUTHOR = 'github-actions[bot]';

export function runGh(args) {
  return execFileSyncBounded('gh', args, {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/**
 * @param {{ repo: string, reportPath: string, title: string, labels: readonly string[], outstanding: number, gh?: (args: string[]) => string }} input
 * @returns {{ action: 'none'|'created'|'updated'|'closed', number?: number }}
 */
export function upsertTrackingIssue({
  repo,
  reportPath,
  title,
  labels,
  outstanding,
  author = TRACKING_ISSUE_AUTHOR,
  gh = runGh,
}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? ''))
    throw new Error('--repo must be owner/name');
  const numbers = gh([
    'api',
    '--method',
    'GET',
    // Found by its stable title, not a label, so relabelling the issue
    // cannot make the next sweep open a duplicate. Search matches words;
    // the exact title is checked in the filter.
    'search/issues',
    '-f',
    `q=repo:${repo} is:issue in:title "${title}"`,
    '-f',
    'per_page=100',
    '--jq',
    `.items[] | select(.pull_request == null and .title == ${JSON.stringify(title)}) | "\\(.number)\\t\\(.user.login)"`,
  ])
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t'))
    // A same-titled issue someone else opened is ignored, so the sweep
    // writes only to an issue it created.
    .filter(([, login]) => login === author)
    .map(([number]) => Number(number))
    .sort((a, b) => a - b);
  const existing = numbers[0];
  if (existing === undefined) {
    if (!outstanding) return { action: 'none' };
    const created = gh([
      'api',
      '--method',
      'POST',
      `repos/${repo}/issues`,
      '-f',
      `title=${title}`,
      '-F',
      `body=@${reportPath}`,
      ...labels.flatMap((label) => ['-f', `labels[]=${label}`]),
      '--jq',
      '.number',
    ]);
    return { action: 'created', number: Number(created) };
  }
  gh([
    'api',
    '--method',
    'PATCH',
    `repos/${repo}/issues/${existing}`,
    '-F',
    `body=@${reportPath}`,
    '-f',
    `state=${outstanding ? 'open' : 'closed'}`,
    ...(outstanding ? [] : ['-f', 'state_reason=completed']),
    '--jq',
    '.number',
  ]);
  return { action: outstanding ? 'updated' : 'closed', number: existing };
}
