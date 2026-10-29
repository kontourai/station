/**
 * One GitHub tracking issue per scheduled sweep (#2923): found by its exact
 * title, created only when something is outstanding, updated while anything
 * is, and closed as completed once nothing is. The sweeps never fail a
 * required check; this issue is how their findings stay visible.
 */
import { execFileSyncBounded } from './bounded-capture.mjs';

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
    `.items[] | select(.pull_request == null and .title == ${JSON.stringify(title)}) | .number`,
  ])
    .split('\n')
    .filter(Boolean)
    .map(Number)
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
