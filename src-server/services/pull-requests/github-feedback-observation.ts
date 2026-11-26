/**
 * The one GitHub read pull request agent feedback makes per pull request:
 * a single `gh api graphql --hostname <host>` for state, head and base,
 * mergeability, the head commit's checks, review threads (with their
 * resolved and outdated state, which the REST review-comment read cannot
 * give) and each reviewer's latest review.
 *
 * gh runs through the provider's own transport, so it starts in an empty
 * directory and never reads a checkout (#2363). Strings are passed with
 * `-f` (raw); only the validated number uses `-F`, which would otherwise
 * read a value starting with `@` as a file.
 */
import type {
  LinkedPullRequestSnapshot,
  PullRequestLinkIdentity,
} from '@kontourai/station-contracts/conversation-pull-request-links';
import type {
  PullRequestFeedbackCheck,
  PullRequestFeedbackObservation,
  PullRequestFeedbackObservationResult,
  PullRequestFeedbackReview,
  PullRequestReviewThread,
} from '@kontourai/station-contracts/pull-request-feedback';

export const GITHUB_FEEDBACK_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number
      title
      updatedAt
      mergedAt
      closedAt
      additions
      deletions
      changedFiles
      isInMergeQueue
      mergeQueueEntry { position }
      autoMergeRequest { enabledAt }
      queueRemovals: timelineItems(last: 1, itemTypes: [REMOVED_FROM_MERGE_QUEUE_EVENT]) {
        nodes { ... on RemovedFromMergeQueueEvent { id createdAt reason } }
      }
      url
      state
      merged
      isDraft
      headRefOid
      baseRefOid
      headRefName
      baseRefName
      headRepositoryOwner { login }
      mergeable
      reviewDecision
      commits(last: 1) {
        nodes {
          commit {
            oid
            statusCheckRollup {
              state
              contexts(first: 100) {
                totalCount
                nodes {
                  __typename
                  ... on CheckRun {
                    name
                    status
                    conclusion
                    detailsUrl
                    title
                    isRequired(pullRequestNumber: $number)
                    checkSuite { workflowRun { workflow { name } } }
                  }
                  ... on StatusContext {
                    context
                    state
                    targetUrl
                    description
                    isRequired(pullRequestNumber: $number)
                  }
                }
              }
            }
          }
        }
      }
      reviewThreads(first: 50) {
        totalCount
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          subjectType
          comments(last: 3) {
            totalCount
            nodes { databaseId author { login } body url createdAt }
          }
        }
      }
      latestReviews(first: 20) {
        nodes { databaseId author { login } state body submittedAt url }
      }
    }
  }
}`;

const NUMBER = /^[1-9]\d{0,9}$/;
/**
 * Forge text is cut once gh's answer is parsed, so the stored observation
 * (and every message, which quotes at most 600 characters) does not grow
 * with whatever a reviewer or CI wrote. gh's output itself is bounded only
 * by what the query asks for: it leaves out check summaries, and the
 * transport's maxBuffer covers the rest.
 */
const BODY_CHARS = 1000;
const EXCERPT_CHARS = 600;
const NAME_CHARS = 300;
const capped = <T extends string | undefined>(value: T, max: number): T =>
  (value !== undefined && value.length > max
    ? `${value.slice(0, max - 1)}…`
    : value) as T;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const HOST = /^[a-z0-9.-]{1,253}(?::\d{1,5})?$/;

/** The gh argv for one read; refuses an identity that is not plainly one. */
function githubFeedbackArgs(
  identity: Pick<PullRequestLinkIdentity, 'host' | 'repository' | 'ref'>,
): string[] {
  const host = identity.host.toLowerCase();
  if (
    !HOST.test(host) ||
    !NAME.test(identity.repository.owner) ||
    !NAME.test(identity.repository.name) ||
    !NUMBER.test(identity.ref)
  )
    throw new Error('The pull request identity is not readable.');
  return [
    'api',
    'graphql',
    '--hostname',
    host,
    '-f',
    `query=${GITHUB_FEEDBACK_QUERY}`,
    '-f',
    `owner=${identity.repository.owner}`,
    '-f',
    `name=${identity.repository.name}`,
    '-F',
    `number=${identity.ref}`,
  ];
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;
const login = (value: unknown): string =>
  text((value as { login?: unknown } | null)?.login) ?? '';
const id = (value: unknown): string | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value)
    ? String(value)
    : undefined;

function normalizeCheck(node: any): PullRequestFeedbackCheck | undefined {
  if (node?.__typename === 'CheckRun') {
    const job = text(node.name);
    if (!job) return undefined;
    const workflow = text(node.checkSuite?.workflowRun?.workflow?.name);
    // The title only: the query leaves out summaries, which can run to
    // 64 KB each, times a hundred checks.
    const excerpt = capped(text(node.title)?.trim(), EXCERPT_CHARS);
    return {
      name: capped(
        workflow && !workflow.includes('/') ? `${workflow} / ${job}` : job,
        NAME_CHARS,
      ),
      conclusion: text(node.conclusion)?.toUpperCase() ?? null,
      completed: node.status === 'COMPLETED',
      required: node.isRequired === true,
      ...(text(node.detailsUrl) ? { url: node.detailsUrl } : {}),
      ...(excerpt ? { excerpt } : {}),
    };
  }
  if (node?.__typename === 'StatusContext') {
    const name = text(node.context);
    const state = text(node.state)?.toUpperCase();
    if (!name || !state) return undefined;
    const pending = state === 'PENDING' || state === 'EXPECTED';
    return {
      name,
      // A commit status says ERROR or FAILURE; both read as FAILURE here.
      conclusion: pending ? null : state === 'ERROR' ? 'FAILURE' : state,
      completed: !pending,
      required: node.isRequired === true,
      ...(text(node.targetUrl) ? { url: node.targetUrl } : {}),
      ...(text(node.description)?.trim()
        ? { excerpt: capped(node.description.trim(), EXCERPT_CHARS) }
        : {}),
    };
  }
  return undefined;
}

function normalizeThread(node: any): PullRequestReviewThread | undefined {
  const threadId = text(node?.id);
  const path = text(node?.path);
  if (!threadId || !path || typeof node.isResolved !== 'boolean')
    return undefined;
  const comments = Array.isArray(node.comments?.nodes)
    ? node.comments.nodes.flatMap((comment: any) => {
        const commentId = id(comment?.databaseId);
        const createdAt = text(comment?.createdAt);
        if (!commentId || !createdAt) return [];
        return [
          {
            id: commentId,
            author: login(comment.author),
            body: capped(text(comment.body), BODY_CHARS) ?? '',
            ...(text(comment.url) ? { url: comment.url } : {}),
            createdAt,
          },
        ];
      })
    : [];
  const line =
    typeof node.line === 'number' && Number.isSafeInteger(node.line)
      ? node.line
      : null;
  return {
    id: threadId,
    resolved: node.isResolved,
    outdated: node.isOutdated === true,
    path,
    line,
    subject: node.subjectType === 'FILE' || line === null ? 'file' : 'line',
    totalComments:
      typeof node.comments?.totalCount === 'number'
        ? node.comments.totalCount
        : comments.length,
    comments,
  };
}

function normalizeReview(node: any): PullRequestFeedbackReview | undefined {
  const reviewId = id(node?.databaseId);
  const state = text(node?.state);
  if (!reviewId || !state) return undefined;
  return {
    id: reviewId,
    author: login(node.author),
    state: state.toUpperCase(),
    body: capped(text(node.body), BODY_CHARS) ?? '',
    ...(text(node.submittedAt) ? { submittedAt: node.submittedAt } : {}),
    ...(text(node.url) ? { url: node.url } : {}),
  };
}

function nonNegativeCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function snapshotChecks(
  rollup: any,
  contexts: readonly any[],
): LinkedPullRequestSnapshot['checks'] {
  switch (rollup?.state) {
    case 'ERROR':
    case 'FAILURE':
      return 'failing';
    case 'PENDING':
    case 'EXPECTED':
      return contexts.some(
        (node) =>
          node?.status === 'WAITING' || node?.conclusion === 'ACTION_REQUIRED',
      )
        ? 'awaiting-approval'
        : 'pending';
    case 'SUCCESS':
      return rollup.contexts?.totalCount > 0 || contexts.length > 0
        ? 'passing'
        : undefined;
    default:
      return undefined;
  }
}

function snapshotLanding(
  pr: any,
  state: string,
): LinkedPullRequestSnapshot['landing'] {
  if (state === 'MERGED') return { state: 'merged' };
  if (state !== 'OPEN') return undefined;
  if (pr.isInMergeQueue === true) {
    const position = nonNegativeCount(pr.mergeQueueEntry?.position);
    return { state: 'queued', ...(position !== undefined ? { position } : {}) };
  }
  if (pr.isInMergeQueue !== false) return undefined;
  const removal = pr.queueRemovals?.nodes?.at(-1);
  const removalId = text(removal?.id);
  const removedAt = text(removal?.createdAt);
  const armedAt = text(pr.autoMergeRequest?.enabledAt);
  if (removalId && removedAt && (!armedAt || removedAt >= armedAt)) {
    const reason = capped(text(removal.reason), EXCERPT_CHARS);
    return {
      state: 'removed',
      id: removalId,
      at: removedAt,
      ...(reason ? { reason } : {}),
    };
  }
  if (armedAt) return { state: 'armed' };
  if (pr.autoMergeRequest === null && Array.isArray(pr.queueRemovals?.nodes))
    return { state: 'not-queued' };
  return undefined;
}

/** gh's JSON for one read, as an observation; throws on an incomplete one. */
export function normalizeGitHubFeedbackObservation(
  parsed: unknown,
  identity: PullRequestLinkIdentity,
  observedAt: string,
): PullRequestFeedbackObservation | undefined {
  const data = (parsed as { data?: any } | null)?.data;
  const pr = data?.repository?.pullRequest;
  if (pr === null || data?.repository === null) return undefined;
  if (
    !pr ||
    typeof pr.url !== 'string' ||
    typeof pr.state !== 'string' ||
    typeof pr.headRefOid !== 'string' ||
    typeof pr.baseRefOid !== 'string' ||
    typeof pr.headRefName !== 'string' ||
    typeof pr.baseRefName !== 'string'
  )
    throw new Error('GitHub returned an incomplete pull request.');
  const rollup = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup;
  const contextNodes: unknown[] = Array.isArray(rollup?.contexts?.nodes)
    ? rollup.contexts.nodes
    : [];
  const threadNodes: unknown[] = Array.isArray(pr.reviewThreads?.nodes)
    ? pr.reviewThreads.nodes
    : [];
  const threads = threadNodes
    .map(normalizeThread)
    .filter((thread): thread is PullRequestReviewThread => !!thread);
  const state = pr.merged === true ? 'MERGED' : pr.state.toUpperCase();
  const headOwner = login(pr.headRepositoryOwner);
  const viewerLogin = login(data.viewer);
  const mergeable =
    pr.mergeable === 'MERGEABLE'
      ? 'mergeable'
      : pr.mergeable === 'CONFLICTING'
        ? 'conflicting'
        : 'unknown';
  const reviewDecision =
    pr.reviewDecision === 'APPROVED'
      ? 'approved'
      : pr.reviewDecision === 'CHANGES_REQUESTED'
        ? 'changes_requested'
        : pr.reviewDecision === 'REVIEW_REQUIRED'
          ? 'review_required'
          : undefined;
  const title = capped(text(pr.title), NAME_CHARS);
  return {
    ...(title
      ? {
          snapshot: {
            title,
            pullRequestState: state,
            url: pr.url,
            head: pr.headRefOid,
            observedAt,
            isDraft: typeof pr.isDraft === 'boolean' ? pr.isDraft : undefined,
            checks: snapshotChecks(rollup, contextNodes),
            reviewDecision,
            mergeability: mergeable,
            updatedAt: text(pr.updatedAt),
            mergedAt: text(pr.mergedAt),
            closedAt: text(pr.closedAt),
            additions: nonNegativeCount(pr.additions),
            deletions: nonNegativeCount(pr.deletions),
            changedFiles: nonNegativeCount(pr.changedFiles),
            landing: snapshotLanding(pr, state),
          },
        }
      : {}),
    identity: {
      provider: identity.provider,
      host: identity.host.toLowerCase(),
      repository: { ...identity.repository },
      ref: identity.ref,
    },
    url: pr.url,
    state: state === 'MERGED' || state === 'CLOSED' ? state : 'OPEN',
    draft: pr.isDraft === true,
    headSha: pr.headRefOid,
    baseSha: pr.baseRefOid,
    headRefName: pr.headRefName,
    baseRefName: pr.baseRefName,
    ...(headOwner ? { headOwner } : {}),
    mergeable,
    ...(text(pr.reviewDecision) ? { reviewDecision: pr.reviewDecision } : {}),
    checks: contextNodes
      .map(normalizeCheck)
      .filter((check): check is PullRequestFeedbackCheck => !!check),
    checksTruncated:
      typeof rollup?.contexts?.totalCount === 'number' &&
      rollup.contexts.totalCount > contextNodes.length,
    threads,
    threadsTotal:
      typeof pr.reviewThreads?.totalCount === 'number'
        ? pr.reviewThreads.totalCount
        : threads.length,
    reviews: (Array.isArray(pr.latestReviews?.nodes)
      ? pr.latestReviews.nodes
      : []
    )
      .map(normalizeReview)
      .filter(
        (review: unknown): review is PullRequestFeedbackReview => !!review,
      ),
    ...(viewerLogin ? { viewerLogin } : {}),
    observedAt,
  };
}

/** Why gh failed, from its stderr: sign-in, rate limit, or anything else. */
export function classifyGitHubFeedbackFailure(error: unknown): {
  cause: 'credentials' | 'rate-limited' | 'error';
  reason: string;
} {
  const stderr =
    typeof (error as { stderr?: unknown } | null)?.stderr === 'string'
      ? ((error as { stderr: string }).stderr as string)
      : '';
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'ENOENT')
    return {
      cause: 'credentials',
      reason: 'The GitHub CLI is not installed on this Station.',
    };
  if (/Could not resolve to a (PullRequest|Repository)/i.test(stderr))
    return {
      cause: 'error',
      reason: 'GitHub did not return this pull request.',
    };
  if (/rate limit|secondary rate|abuse detection/i.test(stderr))
    return { cause: 'rate-limited', reason: 'GitHub rate limited the read.' };
  if (
    /gh auth login|not logged in|authentication|HTTP 401|bad credentials|GH_TOKEN/i.test(
      stderr,
    )
  )
    return {
      cause: 'credentials',
      reason: 'GitHub CLI is not signed in for this host.',
    };
  return { cause: 'error', reason: 'The GitHub read failed.' };
}

/** Run the read through `gh` and normalize it. Never throws. */
export async function readGitHubFeedbackObservation(
  gh: (args: string[]) => Promise<{ stdout: string }>,
  identity: PullRequestLinkIdentity,
  now: () => Date = () => new Date(),
): Promise<PullRequestFeedbackObservationResult> {
  let args: string[];
  try {
    args = githubFeedbackArgs(identity);
  } catch (error) {
    return {
      state: 'unavailable',
      cause: 'error',
      reason: error instanceof Error ? error.message : 'Unreadable identity.',
    };
  }
  let stdout: string;
  try {
    stdout = (await gh(args)).stdout;
  } catch (error) {
    return { state: 'unavailable', ...classifyGitHubFeedbackFailure(error) };
  }
  try {
    const observation = normalizeGitHubFeedbackObservation(
      JSON.parse(stdout),
      identity,
      now().toISOString(),
    );
    if (!observation)
      return {
        state: 'unavailable',
        cause: 'not-found',
        reason: 'GitHub did not return this pull request.',
      };
    return { state: 'observed', observation };
  } catch {
    return {
      state: 'unavailable',
      cause: 'error',
      reason: 'GitHub returned an unreadable answer.',
    };
  }
}
