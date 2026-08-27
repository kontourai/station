import { execFileSync } from 'node:child_process';

export const SHA40 = /^[a-f0-9]{40}$/i;
export function validatePushRange(before, after) {
  return (
    SHA40.test(before ?? '') && SHA40.test(after ?? '') && before !== after
  );
}
/** Bounded local commit range; no shell and no branch/ref interpolation. */
export function commitsInRange(before, after, execFile = execFileSync) {
  if (!validatePushRange(before, after)) return null;
  let output;
  try {
    output = execFile(
      'git',
      ['rev-list', '--max-count=257', `${before}..${after}`],
      { encoding: 'utf8', timeout: 5_000 },
    );
  } catch {
    return null;
  }
  const source = String(output).trim();
  if (!source) return null;
  const commits = source.split(/\s+/);
  if (commits.some((sha) => !SHA40.test(sha))) return null;
  return commits.length > 0 && commits.length <= 256 && commits.includes(after)
    ? commits
    : null;
}
/** Admit only merged same-repo PRs into main whose merge SHA is in the exact push range. */
export function mergedIssueFacts({ pulls, commits, owner, repo, main }) {
  if (!Array.isArray(pulls) || !Array.isArray(commits) || pulls.length > 256)
    return null;
  const range = new Set(commits);
  const issues = new Set();
  for (const pr of pulls) {
    if (
      pr?.merged_at == null ||
      pr?.base?.ref !== main ||
      pr?.base?.repo?.full_name !== `${owner}/${repo}` ||
      !range.has(pr.merge_commit_sha)
    )
      continue;
    if (!Array.isArray(pr.closingIssues) || pr.closingIssues.length > 100)
      return null;
    for (const issue of pr.closingIssues) {
      if (issue?.repository?.full_name !== `${owner}/${repo}`) continue;
      if (!Number.isSafeInteger(issue.number) || issue.number < 1) return null;
      issues.add(issue.number);
    }
  }
  return [...issues].sort((a, b) => a - b);
}
