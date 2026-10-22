/**
 * Exact-identity read of one GitHub issue (epic #4003,
 * docs/design/tracker-backed-tasks.md "Reading the tracker").
 *
 * Station stores no tracker token: the read goes through the host's `gh`
 * login, with the same process discipline as the pull request provider
 * (`github-pull-request-provider.ts`): gh starts in a fresh empty directory
 * (`execGitContextCommand`), never prompts, and is bounded by a deadline and
 * an output limit.
 *
 * Scope of this slice:
 * - github.com only. Every call names `--hostname github.com`, so neither
 *   `GH_HOST` nor a GitHub Enterprise login can redirect the host's
 *   credentials elsewhere. GitHub Enterprise is not supported yet: its refs
 *   do not parse (`parseGitHubWorkItemRef`) and are `unsupported`.
 * - Issues only. GitHub's issues API also answers for a pull request number;
 *   such an item is `unsupported`.
 * - This class reads whatever ref it is given. Its callers limit that: Start
 *   Task observes a ref only after the Project's board offered it, and the
 *   Task header, dispatch and `get_task_brief` observe a Task's ref only when
 *   `TaskRecord.workItemProvenance` says it entered through such a board
 *   check (Start Task, or `POST /api/tasks` with a `github:` ref). A board
 *   check is membership in the board's listing at that moment; it does not
 *   prove what the requester may see on GitHub.
 * - Bounded cost (review F8): a caller's `signal` stops the gh process, and
 *   an observed answer is kept in process for `cacheTtlMs` (30 s), keyed by
 *   the ref's `workItemRefKey` and `commentsSince`, so a Session calling
 *   `get_task_brief` in a loop does not spend the host's GitHub quota. A
 *   failure is never kept: a person who signs gh in sees it at once. An
 *   aborted signal starts no gh process. Concurrent reads of one key are not
 *   shared: each runs its own gh calls, since one caller's abort must not
 *   stop another's read.
 */
import {
  formatGitHubWorkItemRef,
  gitHubIssueUrlFromWorkItemRef,
  parseGitHubWorkItemRef,
  WORK_ITEM_OBSERVATION_LIMITS,
  type WorkItemObservation,
  type WorkItemObservationResult,
  type WorkItemObservedComment,
  workItemRefFromGitHubIssueUrl,
  workItemRefKey,
} from '@kontourai/station-contracts/work-item-provider';
import { execGitContextCommand } from '../../utils/git-exec.js';

export interface WorkItemObserveOptions {
  /** Return only comments created after this instant (ISO 8601). */
  commentsSince?: string;
  /** Aborting stops the read and its gh process. */
  signal?: AbortSignal;
}

/** The one server seam for reading a tracker item by its exact identity. */
export interface WorkItemObserver {
  observeWorkItem(
    workItemRef: string,
    options?: WorkItemObserveOptions,
  ): Promise<WorkItemObservationResult>;
}

export interface GitHubWorkItemObserverOptions {
  /** The gh executable. Tests point this at a fake at the process seam. */
  command?: string;
  timeoutMs?: number;
  /** Bytes, per stream, per gh call. */
  maxOutputBytes?: number;
  /** Extra environment for gh (tests only). */
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** How long an observed answer is reused; 0 turns the cache off. */
  cacheTtlMs?: number;
}

const GITHUB_HOST = 'github.com';
/** Comments are read in pages of this size, newest pages only. */
const COMMENT_PAGE_SIZE = WORK_ITEM_OBSERVATION_LIMITS.comments;
const DEFAULT_TIMEOUT_MS = 10_000;
/** A page of 30 comments at GitHub's 65,536-character body limit, plus the
 * JSON around them, fits; anything larger is refused, not cut. */
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const REASON_CHARS = 300;
const DEFAULT_CACHE_TTL_MS = 30_000;
/** Distinct reads kept at once; the oldest is dropped past it. */
const CACHE_MAX_ENTRIES = 100;

type Failure = Exclude<WorkItemObservationResult, { status: 'observed' }>;

class ObservationFailure extends Error {
  constructor(readonly result: Failure) {
    super(result.reason);
  }
}

const failure = (status: Failure['status'], reason: string): Failure => ({
  status,
  reason,
});

/** Cut `text` to `limit` characters without splitting a surrogate pair. */
function cut(text: string, limit: number, marker: string): string {
  if (text.length <= limit) return text;
  let end = limit;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end).trimEnd()}${marker}`;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isIsoTimestamp = (value: unknown): value is string =>
  typeof value === 'string' && !Number.isNaN(Date.parse(value));

export class GitHubWorkItemObserver implements WorkItemObserver {
  private readonly command: string;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => Date;
  private readonly cacheTtlMs: number;
  private readonly cache = new Map<
    string,
    { readonly at: number; readonly result: WorkItemObservationResult }
  >();

  constructor(options: GitHubWorkItemObserverOptions = {}) {
    this.command = options.command ?? 'gh';
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.env = options.env ?? {};
    this.now = options.now ?? (() => new Date());
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  }

  async observeWorkItem(
    workItemRef: string,
    options: WorkItemObserveOptions = {},
  ): Promise<WorkItemObservationResult> {
    // One item, one entry, however its ref is spelled (review round 2,
    // P3-5); a kept answer names the ref this caller asked for.
    const key = `${workItemRefKey(workItemRef)}\u0000${options.commentsSince ?? ''}`;
    const at = this.now().getTime();
    const kept = this.cache.get(key);
    if (kept && at - kept.at < this.cacheTtlMs && at >= kept.at)
      return kept.result.status === 'observed'
        ? {
            ...kept.result,
            observation: { ...kept.result.observation, workItemRef },
          }
        : kept.result;
    if (options.signal?.aborted)
      return failure('unavailable', 'The read was stopped before it started.');
    this.cache.delete(key);
    const result = await this.read(workItemRef, options);
    if (result.status === 'observed' && this.cacheTtlMs > 0) {
      this.cache.set(key, { at, result });
      if (this.cache.size > CACHE_MAX_ENTRIES)
        this.cache.delete(this.cache.keys().next().value!);
    }
    return result;
  }

  private async read(
    workItemRef: string,
    options: WorkItemObserveOptions,
  ): Promise<WorkItemObservationResult> {
    const identity = parseGitHubWorkItemRef(workItemRef);
    if (!identity)
      return failure(
        'unsupported',
        'Only GitHub issues on github.com (github:owner/repo#N) can be read.',
      );
    if (
      options.commentsSince !== undefined &&
      !isIsoTimestamp(options.commentsSince)
    )
      return failure('unsupported', 'commentsSince must be an ISO timestamp.');
    const issuePath = `repos/${identity.owner}/${identity.repo}/issues/${identity.number}`;
    try {
      const issue = await this.api(issuePath, options.signal);
      if (!isRecord(issue))
        throw new ObservationFailure(
          failure('unavailable', 'GitHub returned an unreadable issue.'),
        );
      if (issue.pull_request !== undefined)
        return failure(
          'unsupported',
          `${workItemRef} is a pull request, not an issue.`,
        );
      const observation = this.toObservation(workItemRef, identity, issue);
      const commentCount =
        typeof issue.comments === 'number' &&
        Number.isSafeInteger(issue.comments) &&
        issue.comments >= 0
          ? issue.comments
          : 0;
      const comments = await this.readNewestComments(
        issuePath,
        commentCount,
        options.commentsSince,
        options.signal,
      );
      return {
        status: 'observed',
        observation: { ...observation, ...(comments ? { comments } : {}) },
      };
    } catch (error) {
      if (error instanceof ObservationFailure) return error.result;
      return this.classify(error);
    }
  }

  private toObservation(
    workItemRef: string,
    identity: { owner: string; repo: string; number: number },
    issue: Record<string, unknown>,
  ): WorkItemObservation {
    const { number, title, state, labels, updated_at: updatedAt } = issue;
    if (
      number !== identity.number ||
      typeof title !== 'string' ||
      (state !== 'open' && state !== 'closed') ||
      !Array.isArray(labels) ||
      !isIsoTimestamp(updatedAt)
    )
      throw new ObservationFailure(
        failure('unavailable', 'GitHub returned an incomplete issue.'),
      );
    // A transferred or renamed repository answers through a redirect with
    // its new address. Keep that address only when it parses as an issue
    // URL on github.com; otherwise link the address the ref names.
    const htmlUrl =
      typeof issue.html_url === 'string' &&
      workItemRefFromGitHubIssueUrl(issue.html_url)
        ? issue.html_url
        : gitHubIssueUrlFromWorkItemRef(formatGitHubWorkItemRef(identity))!;
    const body =
      typeof issue.body === 'string' && issue.body.trim()
        ? cut(
            issue.body,
            WORK_ITEM_OBSERVATION_LIMITS.bodyChars,
            '\n\n[truncated]',
          )
        : undefined;
    return {
      workItemRef,
      url: htmlUrl,
      title,
      state,
      ...(typeof issue.state_reason === 'string' && issue.state_reason
        ? { stateReason: issue.state_reason }
        : {}),
      labels: labels.flatMap((label) =>
        isRecord(label) && typeof label.name === 'string' ? [label.name] : [],
      ),
      updatedAt,
      observedAt: this.now().toISOString(),
      ...(body ? { body } : {}),
    };
  }

  /**
   * GitHub lists an issue's comments oldest first, so the newest are on the
   * last page. Read it, and the page before it when the last page alone is
   * short, then keep the newest `COMMENT_PAGE_SIZE`.
   */
  private async readNewestComments(
    issuePath: string,
    count: number,
    since: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<WorkItemObservedComment[] | undefined> {
    if (count === 0) return since === undefined ? undefined : [];
    const lastPage = Math.ceil(count / COMMENT_PAGE_SIZE);
    const pages = [lastPage];
    if (lastPage > 1 && count % COMMENT_PAGE_SIZE !== 0)
      pages.unshift(lastPage - 1);
    const raw: unknown[] = [];
    for (const page of pages) {
      const listed = await this.api(
        `${issuePath}/comments?per_page=${COMMENT_PAGE_SIZE}&page=${page}`,
        signal,
      );
      if (!Array.isArray(listed))
        throw new ObservationFailure(
          failure('unavailable', 'GitHub returned an unreadable comment list.'),
        );
      raw.push(...listed);
    }
    const sinceMs = since === undefined ? undefined : Date.parse(since);
    return raw
      .flatMap((comment): WorkItemObservedComment[] => {
        if (!isRecord(comment) || !isIsoTimestamp(comment.created_at))
          return [];
        if (sinceMs !== undefined && Date.parse(comment.created_at) <= sinceMs)
          return [];
        const author =
          isRecord(comment.user) && typeof comment.user.login === 'string'
            ? comment.user.login
            : 'ghost';
        return [
          {
            author,
            createdAt: comment.created_at,
            excerpt: cut(
              typeof comment.body === 'string' ? comment.body : '',
              WORK_ITEM_OBSERVATION_LIMITS.commentExcerptChars,
              '…',
            ),
          },
        ];
      })
      .slice(-COMMENT_PAGE_SIZE);
  }

  private async api(path: string, signal?: AbortSignal): Promise<unknown> {
    const { stdout } = await execGitContextCommand(
      this.command,
      [
        'api',
        '--hostname',
        GITHUB_HOST,
        '-H',
        'Accept: application/vnd.github+json',
        path,
      ],
      {
        timeout: this.timeoutMs,
        maxBuffer: this.maxOutputBytes,
        ...(signal ? { signal } : {}),
        encoding: 'utf8',
        windowsHide: true,
        env: {
          ...this.env,
          GH_PROMPT_DISABLED: '1',
          GH_NO_UPDATE_NOTIFIER: '1',
          GH_PAGER: '',
          NO_COLOR: '1',
        },
      },
    );
    try {
      return JSON.parse(stdout);
    } catch {
      throw new ObservationFailure(
        failure('unavailable', 'GitHub CLI returned malformed JSON.'),
      );
    }
  }

  private classify(error: unknown): Failure {
    const run = isRecord(error)
      ? (error as { code?: unknown; killed?: unknown; stderr?: unknown })
      : {};
    if (run.code === 'ENOENT')
      return failure(
        'unavailable',
        'The GitHub CLI (gh) is not installed or not on PATH.',
      );
    if (run.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
      return failure(
        'unavailable',
        `GitHub's answer exceeded ${this.maxOutputBytes} bytes.`,
      );
    if (run.killed === true)
      return failure(
        'unavailable',
        `GitHub did not answer within ${this.timeoutMs} ms.`,
      );
    const stderr = typeof run.stderr === 'string' ? run.stderr.trim() : '';
    // gh exits 4 when it has no login at all; a revoked or invalid token is
    // an HTTP 401 from the API.
    if (run.code === 4 || /\(HTTP 401\)|gh auth login/.test(stderr))
      return failure(
        'unauthenticated',
        'The GitHub CLI is not signed in to github.com. Run `gh auth login` on the Station host, then try again.',
      );
    if (/\(HTTP 404\)/.test(stderr))
      return failure(
        'not-found',
        'GitHub has no such issue, or the gh login cannot see it.',
      );
    if (/\(HTTP 410\)/.test(stderr))
      return failure('not-found', 'This issue was deleted on GitHub.');
    return failure(
      'unavailable',
      stderr
        ? cut(stderr, REASON_CHARS, '…')
        : 'The GitHub CLI failed without a message.',
    );
  }
}
