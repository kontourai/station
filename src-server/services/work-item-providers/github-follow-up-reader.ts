/**
 * Reads what happened on one followed GitHub issue or pull request since a
 * Task last looked (#4508, docs/decisions/task-tracker-followups.md): issue
 * and pull request comments, reviews with their inline review comments, and
 * the conclusions of the pull request head commit's completed check runs.
 *
 * Same process discipline as `GitHubWorkItemObserver`: the host's `gh` login,
 * started from a fresh empty directory, never prompting, bounded by a
 * deadline and an output limit, always `--hostname github.com`.
 *
 * Cursor (the reason this reads GraphQL, not REST). GitHub's REST lists page
 * by number, so an item deleted between two page reads shifts the next page
 * and one item at the boundary is never seen; a `since` timestamp filter
 * loses items that share the boundary's second. GraphQL connection cursors
 * are keysets: a comment's is its database id (`cursor:v2:[id]`), a review's
 * is `(submitted at, created at, id)` (decoded from github.com answers,
 * 2026-11). Asking for `after: <cursor of the last item recorded>` returns
 * exactly the items after it, however many were added or deleted around it.
 * Each page is returned with the cursor of its last edge, and the caller
 * stores that cursor with the page's items, so a stopped walk resumes after
 * the last item it kept and never past one it did not.
 *
 * Bounds: a comment or review body is cut to `FOLLOW_UP_EXCERPT_CHARS`
 * before it leaves this module; a review carries at most its first
 * `INLINE_COMMENTS_PER_REVIEW` inline comments (GitHub's page maximum) and
 * says how many more it has; check runs are read from at most
 * `CHECK_SUITES_MAX` suites of `CHECK_RUNS_PER_SUITE` runs each.
 */
import { execGitContextCommand } from '../../utils/git-exec.js';

/** About a thousand characters of any one author's text (decision 3). */
const FOLLOW_UP_EXCERPT_CHARS = 1000;
const INLINE_COMMENTS_PER_REVIEW = 100;
const CHECK_SUITES_MAX = 20;
const CHECK_RUNS_PER_SUITE = 50;
/** Items per connection page. */
const FOLLOW_UP_PAGE_SIZE = 50;
const GITHUB_HOST = 'github.com';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const REASON_CHARS = 300;

/**
 * Who wrote it, as decision 2 sorts people: `member` is an author whose
 * `authorAssociation` is OWNER, MEMBER or COLLABORATOR; `bot` is a GitHub App
 * or a `[bot]` login, whatever its association; `ci` is a check run; every
 * other author is `other`.
 */
export type FollowUpActorClass = 'member' | 'bot' | 'other' | 'ci';
export type FollowUpKind =
  | 'comment'
  | 'review'
  | 'review_comment'
  | 'check_run';

export interface FollowUpItem {
  kind: FollowUpKind;
  /** GitHub's database id: the item's identity, unique within its kind. */
  githubId: string;
  /** A GitHub login, or `ghost` for a deleted account. */
  author: string;
  actorClass: FollowUpActorClass;
  /** GitHub's `authorAssociation` word, when GitHub gave one. */
  association?: string;
  occurredAt: string;
  url?: string;
  /** At most `FOLLOW_UP_EXCERPT_CHARS` of the author's text. */
  excerpt: string;
  truncated: boolean;
  /** Reviews: APPROVED, CHANGES_REQUESTED, COMMENTED or DISMISSED. */
  reviewState?: string;
  /** Check runs: the run's name and its conclusion word. */
  checkName?: string;
  conclusion?: string;
}

export type FollowUpStream = 'comments' | 'reviews';

export interface FollowUpStreamPage {
  items: FollowUpItem[];
  /** The last edge's cursor; absent when the page had no edges. */
  lastCursor?: string;
  hasNextPage: boolean;
}

export interface FollowUpPage {
  typename: 'Issue' | 'PullRequest';
  comments: FollowUpStreamPage;
  /** Pull requests only. */
  reviews?: FollowUpStreamPage;
  /** Pull requests, on a read that asked for them. */
  checks?: FollowUpItem[];
}

export type FollowUpReadResult =
  | { status: 'read'; page: FollowUpPage }
  | {
      status: 'not-found' | 'unauthenticated' | 'unavailable';
      reason: string;
    };

export interface FollowUpPageRequest {
  owner: string;
  repo: string;
  number: number;
  /** Read after these cursors; absent reads from the beginning. */
  after: Partial<Record<FollowUpStream, string>>;
  /** Also read the head commit's completed check runs. */
  withChecks: boolean;
  signal?: AbortSignal;
}

export interface GitHubFollowUpReader {
  readPage(request: FollowUpPageRequest): Promise<FollowUpReadResult>;
}

export interface GitHubFollowUpReaderOptions {
  /** The gh executable. Tests point this at a fake at the process seam. */
  command?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Extra environment for gh (tests only). */
  env?: NodeJS.ProcessEnv;
}

const AUTHOR = 'author { __typename login } authorAssociation';
const COMMENTS = `comments(first: $first, after: $commentsAfter) {
  pageInfo { hasNextPage endCursor }
  edges { cursor node { databaseId url body createdAt ${AUTHOR} } }
}`;
const FOLLOW_UP_QUERY = `query($owner: String!, $name: String!, $number: Int!, $first: Int!, $commentsAfter: String, $reviewsAfter: String, $withChecks: Boolean!) {
  repository(owner: $owner, name: $name) {
    issueOrPullRequest(number: $number) {
      __typename
      ... on Issue { ${COMMENTS} }
      ... on PullRequest {
        ${COMMENTS}
        reviews(first: $first, after: $reviewsAfter) {
          pageInfo { hasNextPage endCursor }
          edges { cursor node { databaseId url body state submittedAt ${AUTHOR}
            comments(first: ${INLINE_COMMENTS_PER_REVIEW}) { totalCount nodes { databaseId url body createdAt path ${AUTHOR} } } } }
        }
        commits(last: 1) @include(if: $withChecks) {
          nodes { commit { oid checkSuites(first: ${CHECK_SUITES_MAX}) { nodes { app { slug } checkRuns(first: ${CHECK_RUNS_PER_SUITE}, filterBy: {status: COMPLETED}) { nodes { databaseId name conclusion completedAt detailsUrl } } } } } }
        }
      }
    }
  }
}`;

const MEMBER_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
/** GitHub's login alphabet; a GitHub App's is shown with `[bot]`. */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/;
const ASSOCIATION = /^[A-Z_]{1,32}$/;
const CHECK_CONCLUSIONS = new Set([
  'ACTION_REQUIRED',
  'CANCELLED',
  'FAILURE',
  'NEUTRAL',
  'SKIPPED',
  'STALE',
  'STARTUP_FAILURE',
  'SUCCESS',
  'TIMED_OUT',
]);
const REVIEW_STATES = new Set([
  'APPROVED',
  'CHANGES_REQUESTED',
  'COMMENTED',
  'DISMISSED',
]);

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isIso = (value: unknown): value is string =>
  typeof value === 'string' && !Number.isNaN(Date.parse(value));

class Unreadable extends Error {}

/** Cut to `limit` code units without splitting a surrogate pair. */
function cut(text: string, limit: number): { text: string; cut: boolean } {
  if (text.length <= limit) return { text, cut: false };
  let end = limit;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: text.slice(0, end).trimEnd(), cut: true };
}

/**
 * Decision 2's sorting. GraphQL names a GitHub App's account `Bot` and gives
 * its login without the `[bot]` suffix REST shows; the suffix is added so
 * both read the same. A login outside GitHub's alphabet is not shown.
 */
function classifyGitHubAuthor(
  author: unknown,
  association: unknown,
): {
  author: string;
  actorClass: Exclude<FollowUpActorClass, 'ci'>;
  association?: string;
} {
  const words =
    typeof association === 'string' && ASSOCIATION.test(association)
      ? { association }
      : {};
  if (!isRecord(author) || typeof author.login !== 'string')
    return { author: 'ghost', actorClass: 'other', ...words };
  const isApp = author.__typename === 'Bot';
  const raw =
    isApp && !author.login.endsWith('[bot]')
      ? `${author.login}[bot]`
      : author.login;
  const login = LOGIN.test(raw) ? raw : 'unknown';
  if (isApp || raw.endsWith('[bot]'))
    return { author: login, actorClass: 'bot', ...words };
  return {
    author: login,
    actorClass:
      typeof association === 'string' && MEMBER_ASSOCIATIONS.has(association)
        ? 'member'
        : 'other',
    ...words,
  };
}

function httpsGitHubUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === GITHUB_HOST
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function databaseId(value: unknown): string {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
    throw new Unreadable('GitHub returned an item without its id.');
  return String(value);
}

function textItem(
  kind: 'comment' | 'review_comment',
  node: Json,
): FollowUpItem {
  if (!isIso(node.createdAt))
    throw new Unreadable('GitHub returned a comment without its time.');
  const body = cut(
    typeof node.body === 'string' ? node.body : '',
    FOLLOW_UP_EXCERPT_CHARS,
  );
  const url = httpsGitHubUrl(node.url);
  return {
    kind,
    githubId: databaseId(node.databaseId),
    ...classifyGitHubAuthor(node.author, node.authorAssociation),
    occurredAt: node.createdAt,
    ...(url ? { url } : {}),
    excerpt: body.text,
    truncated: body.cut,
  };
}

function connection(value: unknown): {
  edges: { cursor: string; node: Json }[];
  hasNextPage: boolean;
} {
  if (!isRecord(value) || !Array.isArray(value.edges))
    throw new Unreadable('GitHub returned an unreadable list.');
  const pageInfo = isRecord(value.pageInfo) ? value.pageInfo : {};
  return {
    edges: value.edges.map((edge) => {
      if (
        !isRecord(edge) ||
        typeof edge.cursor !== 'string' ||
        !edge.cursor ||
        !isRecord(edge.node)
      )
        throw new Unreadable('GitHub returned a list item without a cursor.');
      return { cursor: edge.cursor, node: edge.node };
    }),
    hasNextPage: pageInfo.hasNextPage === true,
  };
}

/** The cursor of the last edge: never `pageInfo.endCursor`, which is null on an empty page. */
const lastCursor = (edges: readonly { cursor: string }[]) =>
  edges.length ? { lastCursor: edges[edges.length - 1]!.cursor } : {};

function readComments(value: unknown): FollowUpStreamPage {
  const page = connection(value);
  return {
    items: page.edges.map(({ node }) => textItem('comment', node)),
    ...lastCursor(page.edges),
    hasNextPage: page.hasNextPage,
  };
}

function readReviews(value: unknown): FollowUpStreamPage {
  const page = connection(value);
  const items: FollowUpItem[] = [];
  for (const { node } of page.edges) {
    // A PENDING review is the gh login's own unsubmitted draft. It is not
    // recorded. Submitting it sets its submitted time, which sorts it after
    // any cursor kept now, so passing it here loses nothing.
    if (node.state === 'PENDING') continue;
    if (!isIso(node.submittedAt))
      throw new Unreadable('GitHub returned a review without its time.');
    const inline = isRecord(node.comments) ? node.comments : {};
    const nodes = Array.isArray(inline.nodes) ? inline.nodes : [];
    const more =
      typeof inline.totalCount === 'number' && inline.totalCount > nodes.length
        ? inline.totalCount - nodes.length
        : 0;
    const body = cut(
      `${typeof node.body === 'string' ? node.body : ''}${more ? `\n\n(${more} more inline comments on GitHub)` : ''}`,
      FOLLOW_UP_EXCERPT_CHARS,
    );
    const url = httpsGitHubUrl(node.url);
    const state =
      typeof node.state === 'string' && REVIEW_STATES.has(node.state)
        ? node.state
        : 'COMMENTED';
    // A review that only carries inline comments (a reply, or a review with
    // no summary) is its comments; it is not recorded twice.
    if (body.text.trim() || state !== 'COMMENTED')
      items.push({
        kind: 'review',
        githubId: databaseId(node.databaseId),
        ...classifyGitHubAuthor(node.author, node.authorAssociation),
        occurredAt: node.submittedAt,
        ...(url ? { url } : {}),
        excerpt: body.text,
        truncated: body.cut,
        reviewState: state,
      });
    for (const comment of nodes)
      if (isRecord(comment)) items.push(textItem('review_comment', comment));
  }
  return {
    items,
    ...lastCursor(page.edges),
    hasNextPage: page.hasNextPage,
  };
}

function readChecks(value: unknown): FollowUpItem[] {
  const commit =
    isRecord(value) && Array.isArray(value.nodes) && isRecord(value.nodes[0])
      ? value.nodes[0].commit
      : undefined;
  const suites =
    isRecord(commit) &&
    isRecord(commit.checkSuites) &&
    Array.isArray(commit.checkSuites.nodes)
      ? commit.checkSuites.nodes
      : [];
  const items: FollowUpItem[] = [];
  for (const suite of suites) {
    if (!isRecord(suite) || !isRecord(suite.checkRuns)) continue;
    const runs = Array.isArray(suite.checkRuns.nodes)
      ? suite.checkRuns.nodes
      : [];
    for (const run of runs) {
      if (!isRecord(run) || !isIso(run.completedAt)) continue;
      const name = cut(typeof run.name === 'string' ? run.name : '', 200);
      const url = httpsGitHubUrl(run.detailsUrl);
      items.push({
        kind: 'check_run',
        githubId: databaseId(run.databaseId),
        author:
          isRecord(suite.app) &&
          typeof suite.app.slug === 'string' &&
          LOGIN.test(suite.app.slug)
            ? suite.app.slug
            : 'unknown',
        actorClass: 'ci',
        occurredAt: run.completedAt,
        ...(url ? { url } : {}),
        excerpt: '',
        truncated: false,
        checkName: name.text,
        conclusion:
          typeof run.conclusion === 'string' &&
          CHECK_CONCLUSIONS.has(run.conclusion)
            ? run.conclusion
            : 'UNKNOWN',
      });
    }
  }
  return items;
}

function parseFollowUpAnswer(
  answer: unknown,
  withChecks: boolean,
): FollowUpReadResult {
  if (!isRecord(answer))
    return { status: 'unavailable', reason: 'GitHub returned no answer.' };
  const errors = Array.isArray(answer.errors) ? answer.errors : [];
  const data = isRecord(answer.data) ? answer.data : undefined;
  const repository =
    data && isRecord(data.repository) ? data.repository : undefined;
  const item =
    repository && isRecord(repository.issueOrPullRequest)
      ? repository.issueOrPullRequest
      : undefined;
  if (!item) {
    const notFound =
      errors.some((error) => isRecord(error) && error.type === 'NOT_FOUND') ||
      (data !== undefined && errors.length === 0);
    return notFound
      ? {
          status: 'not-found',
          reason:
            'GitHub has no such issue or pull request, or the gh login cannot see it.',
        }
      : {
          status: 'unavailable',
          reason: 'GitHub could not answer the follow-up read.',
        };
  }
  try {
    if (item.__typename === 'Issue')
      return {
        status: 'read',
        page: { typename: 'Issue', comments: readComments(item.comments) },
      };
    if (item.__typename !== 'PullRequest')
      throw new Unreadable('GitHub returned an unknown item type.');
    return {
      status: 'read',
      page: {
        typename: 'PullRequest',
        comments: readComments(item.comments),
        reviews: readReviews(item.reviews),
        ...(withChecks ? { checks: readChecks(item.commits) } : {}),
      },
    };
  } catch (error) {
    if (error instanceof Unreadable)
      return { status: 'unavailable', reason: error.message };
    throw error;
  }
}

export class GhGitHubFollowUpReader implements GitHubFollowUpReader {
  private readonly command: string;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: GitHubFollowUpReaderOptions = {}) {
    this.command = options.command ?? 'gh';
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.env = options.env ?? {};
  }

  async readPage(request: FollowUpPageRequest): Promise<FollowUpReadResult> {
    const args = [
      'api',
      'graphql',
      '--hostname',
      GITHUB_HOST,
      // `-f` keeps a value a string: an owner named `123` is not a number.
      '-f',
      `owner=${request.owner}`,
      '-f',
      `name=${request.repo}`,
      '-F',
      `number=${request.number}`,
      '-F',
      `first=${FOLLOW_UP_PAGE_SIZE}`,
      '-F',
      `withChecks=${request.withChecks}`,
      ...(request.after.comments
        ? ['-f', `commentsAfter=${request.after.comments}`]
        : []),
      ...(request.after.reviews
        ? ['-f', `reviewsAfter=${request.after.reviews}`]
        : []),
      '-f',
      `query=${FOLLOW_UP_QUERY}`,
    ];
    let stdout: string;
    try {
      ({ stdout } = await execGitContextCommand(this.command, args, {
        timeout: this.timeoutMs,
        maxBuffer: this.maxOutputBytes,
        ...(request.signal ? { signal: request.signal } : {}),
        encoding: 'utf8',
        windowsHide: true,
        env: {
          ...this.env,
          GH_PROMPT_DISABLED: '1',
          GH_NO_UPDATE_NOTIFIER: '1',
          GH_PAGER: '',
          NO_COLOR: '1',
        },
      }));
    } catch (error) {
      // gh exits 1 on a GraphQL error but still prints the answer; a
      // NOT_FOUND answer is a fact about the item, not a transport failure.
      const run = isRecord(error)
        ? (error as {
            stdout?: unknown;
            stderr?: unknown;
            code?: unknown;
            killed?: unknown;
          })
        : {};
      if (typeof run.stdout === 'string' && run.stdout.trim()) {
        try {
          const parsed = parseFollowUpAnswer(
            JSON.parse(run.stdout),
            request.withChecks,
          );
          if (parsed.status === 'not-found') return parsed;
        } catch {
          // Fall through to the process failure.
        }
      }
      return this.classify(run);
    }
    try {
      return parseFollowUpAnswer(JSON.parse(stdout), request.withChecks);
    } catch {
      return {
        status: 'unavailable',
        reason: 'GitHub CLI returned malformed JSON.',
      };
    }
  }

  private classify(run: {
    code?: unknown;
    killed?: unknown;
    stderr?: unknown;
  }): FollowUpReadResult {
    if (run.code === 'ENOENT')
      return {
        status: 'unavailable',
        reason: 'The GitHub CLI (gh) is not installed or not on PATH.',
      };
    if (run.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
      return {
        status: 'unavailable',
        reason: `GitHub's answer exceeded ${this.maxOutputBytes} bytes.`,
      };
    if (run.killed === true)
      return {
        status: 'unavailable',
        reason: `GitHub did not answer within ${this.timeoutMs} ms.`,
      };
    const stderr = typeof run.stderr === 'string' ? run.stderr.trim() : '';
    if (run.code === 4 || /\(HTTP 401\)|gh auth login/.test(stderr))
      return {
        status: 'unauthenticated',
        reason:
          'The GitHub CLI is not signed in to github.com. Run `gh auth login` on the Station host.',
      };
    return {
      status: 'unavailable',
      reason: stderr
        ? cut(stderr, REASON_CHARS).text
        : 'The GitHub CLI failed without a message.',
    };
  }
}
