/**
 * Agent feedback's Task-branch discovery read on GitHub: one
 * `gh pr list --repo <host>/<owner>/<name> --head <branch> --state open`,
 * through the provider's own transport (an empty directory, never a
 * checkout, #2363). `--repo` names the host, so gh reads that host's login.
 *
 * GitHub matches `--head` by branch name only, whichever repository the
 * branch lives in, so every row carries where its head lives; the caller
 * decides whether it is the Task's own branch.
 */

import type {
  PullRequestByHead,
  PullRequestsByHeadResult,
} from '@kontourai/station-contracts/pull-request-feedback';
import type { PullRequestRepositoryIdentityContext } from '@kontourai/station-contracts/pull-request-provider';
import { classifyGitHubFeedbackFailure } from './github-feedback-observation.js';

/** GitHub allows one open pull request per head and base; 5 is plenty. */
const BY_HEAD_LIMIT = 5;
/** A branch git would accept and gh cannot read as a flag. */
const SAFE_BRANCH = /^[^\s-][^\s]{0,254}$/;
const SAFE_NAME = /^[A-Za-z0-9_.-]{1,100}$/;

function normalizeRow(value: unknown): PullRequestByHead | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as Record<string, unknown>;
  const owner = (row.headRepositoryOwner as { login?: unknown } | null)?.login;
  if (
    typeof row.number !== 'number' ||
    !Number.isSafeInteger(row.number) ||
    row.number < 1 ||
    typeof row.headRefName !== 'string' ||
    typeof owner !== 'string' ||
    typeof row.isCrossRepository !== 'boolean' ||
    typeof row.url !== 'string'
  )
    return undefined;
  return {
    ref: String(row.number),
    headRefName: row.headRefName,
    headOwner: owner,
    crossRepository: row.isCrossRepository,
    url: row.url,
  };
}

/** Run the read through `gh`. Never throws. */
export async function readGitHubPullRequestsByHead(
  gh: (args: string[]) => Promise<{ stdout: string }>,
  context: PullRequestRepositoryIdentityContext,
  branch: string,
): Promise<PullRequestsByHeadResult> {
  const { host, repository } = context;
  if (
    !SAFE_BRANCH.test(branch) ||
    !SAFE_NAME.test(repository.owner) ||
    !SAFE_NAME.test(repository.name) ||
    !/^[a-z0-9.-]+(?::\d+)?$/i.test(host)
  )
    return {
      state: 'unavailable',
      cause: 'error',
      reason: 'The branch or repository cannot be read.',
    };
  let stdout: string;
  try {
    stdout = (
      await gh([
        'pr',
        'list',
        '--repo',
        `${host}/${repository.owner}/${repository.name}`,
        '--head',
        branch,
        '--state',
        'open',
        '--limit',
        String(BY_HEAD_LIMIT),
        '--json',
        'number,headRefName,headRepositoryOwner,isCrossRepository,url',
      ])
    ).stdout;
  } catch (error) {
    return { state: 'unavailable', ...classifyGitHubFeedbackFailure(error) };
  }
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed)) throw new Error('not a list');
    return {
      state: 'read',
      pullRequests: parsed
        .map(normalizeRow)
        .filter((row): row is PullRequestByHead => !!row),
    };
  } catch {
    return {
      state: 'unavailable',
      cause: 'error',
      reason: 'GitHub returned an unreadable answer.',
    };
  }
}
