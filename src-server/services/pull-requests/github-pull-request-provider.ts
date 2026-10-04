import type {
  IPullRequestProvider,
  PullRequest,
  PullRequestAvailability,
  PullRequestBranchMergeability,
  PullRequestCapabilities,
  PullRequestMergeInput,
  PullRequestMergeMethod,
  PullRequestMergeResult,
  PullRequestRepositoryContext,
  PullRequestRepositoryIdentityContext,
  PullRequestResult,
  PullRequestReviewInput,
  PullRequestWriteAdmission,
} from '@kontourai/station-contracts/pull-request-provider';
import { execGitContextCommand } from '../../utils/git-exec.js';
import {
  readPullRequestReview,
  writePullRequestReview,
} from './pull-request-review.js';

type PullRequestProviderRequestContext =
  | PullRequestRepositoryContext
  | PullRequestRepositoryIdentityContext;

/**
 * gh runs in a fresh empty directory, never the checkout (#2363): every
 * call names `--repo`, and `pr create` names `--head`, so gh has nothing to
 * read from a Project folder, whose config a member can write.
 */
const defaultGitHubTransport = (
  args: string[],
  _context: PullRequestProviderRequestContext,
) =>
  execGitContextCommand('gh', args, {
    timeout: 10_000,
    encoding: 'utf8',
    windowsHide: true,
  });

const offeredCapabilities: PullRequestCapabilities = {
  list: true,
  detail: true,
  open: true,
  comment: true,
  approve: true,
  merge: true,
  autoMerge: true,
};
const noCapabilities: PullRequestCapabilities = {
  list: false,
  detail: false,
  open: false,
  comment: false,
  approve: false,
  merge: false,
  autoMerge: false,
};
const offeredMergeMethods: PullRequestMergeMethod[] = [
  'merge',
  'squash',
  'rebase',
];
const unavailable = (reason: string): PullRequestResult<any> => ({
  available: false,
  reason,
  effectiveCapabilities: { ...noCapabilities },
  effectiveMergeMethods: [],
  mergeMethodsSource: 'provider-default',
});
const reason = (error: unknown, fallback: string) => {
  // gh's own stderr, trimmed. A runner failure (it carries `cmd`) with an
  // empty stderr, such as a timeout, gets the fallback: its message is
  // "Command failed: <argv>", which is for logs, not the pane.
  const failure =
    typeof error === 'object' && error
      ? (error as { stderr?: unknown; cmd?: unknown })
      : undefined;
  if (typeof failure?.stderr === 'string' && failure.stderr.trim())
    return failure.stderr.trim();
  if (typeof failure?.cmd === 'string') return fallback;
  return error instanceof Error && error.message ? error.message : fallback;
};
/**
 * How long a successful forge read is reused (#2937). Every visible Sessions
 * row observes its repository's open pull requests every 30 s, so without
 * this the cost of the Sessions view scaled with rows, not repositories, and
 * exhausted the operator's GitHub GraphQL quota.
 */
export const GITHUB_READ_CACHE_TTL_MS = 20_000;

export interface GitHubPullRequestProviderOptions {
  /** 0 keeps single-flight coalescing but retains nothing once settled. */
  readCacheTtlMs?: number;
  now?: () => number;
}

interface ForgeReadEntry {
  repository: string;
  promise: Promise<unknown>;
  settledAt?: number;
}

/**
 * Single-flight plus a short TTL for idempotent `gh` reads. It stores only
 * the forge's answer: callers reach it after the route has already made the
 * request's own principal and repository decision (#2563), so a hit never
 * stands in for admission. A rejected or unretainable read is shared only
 * with callers that joined it while it was in flight, then forgotten.
 */
class ForgeReadCache {
  private readonly entries = new Map<string, ForgeReadEntry>();
  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number,
  ) {}
  read<T>(
    key: string,
    repository: string,
    load: () => Promise<T>,
    retain: (value: T) => boolean = () => true,
  ): Promise<T> {
    const now = this.now();
    for (const [candidateKey, candidate] of this.entries)
      if (
        candidate.settledAt !== undefined &&
        now - candidate.settledAt >= this.ttlMs
      )
        this.entries.delete(candidateKey);
    const hit = this.entries.get(key);
    if (hit) return hit.promise as Promise<T>;
    const entry: ForgeReadEntry = { repository, promise: Promise.resolve() };
    const promise = Promise.resolve()
      .then(load)
      .then(
        (value) => {
          if (this.entries.get(key) === entry) {
            if (this.ttlMs > 0 && retain(value)) entry.settledAt = this.now();
            else this.entries.delete(key);
          }
          return value;
        },
        (error: unknown) => {
          if (this.entries.get(key) === entry) this.entries.delete(key);
          throw error;
        },
      );
    entry.promise = promise;
    this.entries.set(key, entry);
    return promise;
  }
  /** Forget every read of a repository, including one still in flight. */
  invalidate(repository: string) {
    for (const [key, entry] of this.entries)
      if (entry.repository === repository) this.entries.delete(key);
  }
}

/**
 * gh's default of 30 would hide a session's pull request behind thirty newer
 * ones; the narrow fields keep a longer page cheap. One more row than this is
 * requested so a longer list is refused as truncated, never served partially.
 */
const GITHUB_MERGEABILITY_LIST_LIMIT = 100;
const githubMergeability = (value: unknown): PullRequest['mergeability'] =>
  value === 'MERGEABLE'
    ? 'mergeable'
    : value === 'CONFLICTING'
      ? 'conflicting'
      : 'unknown';

const canonicalHost = (host: string) =>
  host.toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');

export function normalizeGitHubPullRequest(
  value: any,
  host: string,
): PullRequest {
  if (
    !Number.isInteger(value?.number) ||
    typeof value.url !== 'string' ||
    typeof value.title !== 'string' ||
    typeof value.state !== 'string' ||
    typeof value.headRefName !== 'string' ||
    typeof value.baseRefName !== 'string'
  )
    throw new Error('GitHub CLI returned an incomplete pull request');
  return {
    provider: 'github',
    host,
    ref: String(value.number),
    url: value.url,
    repository: { owner: '', name: '' },
    title: value.title,
    body: value.body ?? null,
    state: value.state,
    author: { login: value.author?.login ?? '', url: value.author?.url },
    sourceBranch: value.headRefName,
    targetBranch: value.baseRefName,
    ...(typeof value.headRefOid === 'string'
      ? { headSha: value.headRefOid }
      : {}),
    ...(typeof value.baseRefOid === 'string'
      ? { baseSha: value.baseRefOid }
      : {}),
    commits: Array.isArray(value.commits) ? value.commits.length : 0,
    reviewStatus: Array.isArray(value.reviews)
      ? (value.reviews.at(-1)?.state ?? 'NONE')
      : 'NONE',
    comments: Array.isArray(value.comments) ? value.comments.length : 0,
    nativeId: String(value.number),
    mergeability: githubMergeability(value.mergeable),
  };
}

function normalizeGitHubBranchMergeability(
  value: any,
): PullRequestBranchMergeability {
  if (!Number.isInteger(value?.number) || typeof value.headRefName !== 'string')
    throw new Error('GitHub CLI returned an incomplete pull request');
  return {
    ref: String(value.number),
    sourceBranch: value.headRefName,
    ...(typeof value.headRepositoryOwner?.login === 'string' &&
    value.headRepositoryOwner.login
      ? { sourceOwner: value.headRepositoryOwner.login }
      : {}),
    mergeability: githubMergeability(value.mergeable),
  };
}

/** GitHub transport deliberately delegates auth to gh; it never reads or stores a token. */
export class GitHubPullRequestProvider implements IPullRequestProvider {
  readonly id = 'github';
  readonly displayName = 'GitHub';
  readonly offeredCapabilities = offeredCapabilities;
  readonly offeredMergeMethods = offeredMergeMethods;
  canServeHost(host: string) {
    return canonicalHost(host) !== 'gitlab.com';
  }
  constructor(
    private readonly transport: (
      args: string[],
      context: PullRequestProviderRequestContext,
    ) => Promise<{ stdout: string }> = defaultGitHubTransport,
    private readonly repositorySettingsTransport:
      | ((
          args: string[],
          context: PullRequestRepositoryContext,
        ) => Promise<{ stdout: string }>)
      | undefined = transport === defaultGitHubTransport
      ? defaultGitHubTransport
      : undefined,
    options: GitHubPullRequestProviderOptions = {},
  ) {
    this.reads = new ForgeReadCache(
      options.readCacheTtlMs ?? GITHUB_READ_CACHE_TTL_MS,
      options.now ?? Date.now,
    );
  }
  private readonly reads: ForgeReadCache;
  /**
   * The cache key's repository. Sharing an answer across checkouts is sound
   * because gh never reads the checkout (#2363): every read is fully named
   * by host, owner and repository.
   */
  private repositoryKey(context: PullRequestRepositoryContext) {
    return `${this.getHost(context)}/${context.repository.owner}/${context.repository.name}`.toLowerCase();
  }
  private gh(args: string[], context: PullRequestProviderRequestContext) {
    return this.transport(args, context);
  }
  getHost(context: PullRequestRepositoryContext) {
    const match = /^(?:git@([^/:\s]+):|https?:\/\/([^/\s]+)\/)/.exec(
      context.repository.remote,
    );
    const host = match?.[1] ?? match?.[2];
    if (!host) throw new Error('GitHub remote URL has no host');
    return host.toLowerCase();
  }
  /** Reads share one probe per repository; see {@link ForgeReadCache}. */
  async getAvailability(
    context: PullRequestRepositoryContext,
  ): Promise<PullRequestAvailability> {
    const repository = this.repositoryKey(context);
    const result = await this.reads.read(
      `availability ${repository}`,
      repository,
      () => this.probeAvailability(context),
      // Neither an unavailable answer nor one whose optional merge-method
      // narrowing failed is retained: both are shared only in flight.
      (value) =>
        value.available &&
        (!this.repositorySettingsTransport ||
          value.mergeMethodsSource === 'repository'),
    );
    return {
      ...result,
      effectiveCapabilities: { ...result.effectiveCapabilities },
      effectiveMergeMethods: [...result.effectiveMergeMethods],
    };
  }
  /** Writes decide on a fresh probe and never populate the read cache. */
  private async probeAvailability(
    context: PullRequestRepositoryContext,
  ): Promise<PullRequestAvailability> {
    const host = this.getHost(context);
    try {
      await this.gh(['auth', 'status', '--hostname', host], context);
      let effectiveMergeMethods = [...this.offeredMergeMethods];
      let mergeMethodsSource: 'provider-default' | 'repository' =
        'provider-default';
      if (this.repositorySettingsTransport)
        try {
          const { stdout } = await this.repositorySettingsTransport(
            [
              'repo',
              'view',
              `${host}/${context.repository.owner}/${context.repository.name}`,
              '--json',
              'mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed',
            ],
            context,
          );
          const x = JSON.parse(stdout);
          effectiveMergeMethods = this.offeredMergeMethods.filter((m) =>
            m === 'merge'
              ? x.mergeCommitAllowed === true
              : m === 'squash'
                ? x.squashMergeAllowed === true
                : x.rebaseMergeAllowed === true,
          );
          mergeMethodsSource = 'repository';
        } catch {
          /* optional narrowing read */
        }
      return {
        available: true,
        effectiveCapabilities: { ...offeredCapabilities },
        effectiveMergeMethods,
        mergeMethodsSource,
      };
    } catch {
      return {
        ...unavailable(
          `GitHub CLI is unavailable or not authenticated for host ${host}`,
        ),
      };
    }
  }
  private call(
    context: PullRequestRepositoryContext,
    args: string[],
    { shared = false }: { shared?: boolean } = {},
  ): Promise<PullRequestResult<any>> {
    const normalize = (v: any) => ({
      ...normalizeGitHubPullRequest(v, this.getHost(context)),
      repository: {
        owner: context.repository.owner,
        name: context.repository.name,
      },
    });
    return this.read(context, args, shared, (parsed) =>
      Array.isArray(parsed) ? parsed.map(normalize) : normalize(parsed),
    );
  }
  private async read<T>(
    context: PullRequestRepositoryContext,
    args: string[],
    shared: boolean,
    normalize: (parsed: unknown) => T,
  ): Promise<PullRequestResult<T>> {
    const a = await this.getAvailability(context);
    if (!a.available) return a;
    const read = async () =>
      normalize(JSON.parse((await this.gh(args, context)).stdout));
    try {
      // The key is the exact argv, so each query shape (state, limit) is its
      // own read. Normalizing inside the read keeps malformed output a
      // rejection, which is never retained.
      const data = shared
        ? structuredClone(
            await this.reads.read(
              `read ${JSON.stringify(args)}`,
              this.repositoryKey(context),
              read,
            ),
          )
        : await read();
      return { ...a, data };
    } catch {
      return unavailable('GitHub CLI request failed');
    }
  }
  /**
   * Runs a forge write on a fresh availability decision and then forgets the
   * repository's cached reads, so the next observation sees the write.
   */
  private async write<T>(
    context: PullRequestRepositoryContext,
    run: (availability: PullRequestAvailability) => Promise<T>,
  ): Promise<T> {
    try {
      return await run(await this.probeAvailability(context));
    } finally {
      this.reads.invalidate(this.repositoryKey(context));
    }
  }
  /**
   * Exact declared-output reads carry only forge identity. They deliberately
   * do not authenticate availability, derive a branch/base, or need a local
   * checkout: `gh pr view --repo` is already fully repository-qualified.
   */
  private async callByIdentity(
    context: PullRequestRepositoryIdentityContext,
    args: string[],
  ): Promise<PullRequestResult<any>> {
    try {
      const parsed = JSON.parse((await this.gh(args, context)).stdout);
      const normalize = (value: any) => ({
        ...normalizeGitHubPullRequest(value, context.host),
        repository: {
          owner: context.repository.owner,
          name: context.repository.name,
        },
      });
      return {
        available: true,
        effectiveCapabilities: { ...offeredCapabilities },
        effectiveMergeMethods: [...offeredMergeMethods],
        mergeMethodsSource: 'provider-default',
        data: Array.isArray(parsed) ? parsed.map(normalize) : normalize(parsed),
      };
    } catch {
      return unavailable('GitHub CLI request failed');
    }
  }
  private async mutation(
    context: PullRequestRepositoryContext,
    args: string[],
    ref?: string,
  ): Promise<PullRequestResult<any>> {
    const outcome = await this.write(context, async (a) => {
      if (!a.available) return { result: a };
      try {
        const stdout = (await this.gh(args, context)).stdout;
        return {
          result: a,
          resolvedRef: ref ?? /\/pull\/(\d+)(?:\b|#)/.exec(stdout)?.[1],
        };
      } catch {
        return { result: unavailable('GitHub CLI request failed') };
      }
    });
    // Read back after the write has invalidated the repository's reads.
    if (!outcome.result.available || !outcome.resolvedRef)
      return { ...outcome.result };
    const detail = await this.getPullRequest(context, outcome.resolvedRef);
    return detail.available ? detail : { ...outcome.result };
  }
  async getReviewSnapshot(c: PullRequestRepositoryContext, ref: string) {
    const availability = await this.getAvailability(c);
    if (!availability.available) return { ...availability, available: false };
    try {
      const data = await readPullRequestReview(
        'github',
        this.getHost(c),
        c,
        ref,
        (args) => this.gh(args, c),
        normalizeGitHubPullRequest,
      );
      return { ...availability, data };
    } catch (error) {
      return {
        ...availability,
        available: false,
        reason: reason(error, 'The review could not be read from GitHub.'),
      };
    }
  }
  async submitReview(
    c: PullRequestRepositoryContext,
    ref: string,
    input: PullRequestReviewInput,
    admission?: PullRequestWriteAdmission,
  ) {
    return this.write(c, async (availability) => {
      if (
        !availability.available ||
        !availability.effectiveCapabilities[input.action]
      )
        return {
          ...availability,
          available: false,
          reason: 'This review capability is unavailable.',
        };
      return {
        ...availability,
        data: await writePullRequestReview(
          'github',
          this.getHost(c),
          c,
          ref,
          input,
          (args) => this.gh(args, c),
          admission,
        ),
      };
    });
  }
  listPullRequests(c: PullRequestRepositoryContext, q: any) {
    const host = this.getHost(c);
    return this.call(
      c,
      [
        'pr',
        'list',
        '--repo',
        `${host}/${c.repository.owner}/${c.repository.name}`,
        '--json',
        'number,url,title,body,state,author,headRefName,baseRefName,headRefOid,baseRefOid,commits,reviews,comments,mergeable,mergeStateStatus',
        ...(q.state ? ['--state', q.state.toLowerCase()] : []),
        ...(q.limit ? ['--limit', String(q.limit)] : []),
      ],
      { shared: true },
    );
  }
  /**
   * One narrow list per repository for conflict indicators (#2937): only the
   * three fields they read, so it costs the forge a fraction of the review
   * list and shares nothing with it but the availability probe.
   */
  async listOpenPullRequestMergeability(
    c: PullRequestRepositoryContext,
  ): Promise<PullRequestResult<PullRequestBranchMergeability[]>> {
    const host = this.getHost(c);
    const result = await this.read(
      c,
      [
        'pr',
        'list',
        '--repo',
        `${host}/${c.repository.owner}/${c.repository.name}`,
        '--state',
        'open',
        '--limit',
        String(GITHUB_MERGEABILITY_LIST_LIMIT + 1),
        '--json',
        'number,headRefName,mergeable,headRepositoryOwner',
      ],
      true,
      (parsed) => {
        if (!Array.isArray(parsed))
          throw new Error('GitHub CLI returned no pull request list');
        return parsed.map(normalizeGitHubBranchMergeability);
      },
    );
    if (
      result.available &&
      (result.data?.length ?? 0) > GITHUB_MERGEABILITY_LIST_LIMIT
    )
      return unavailable(
        `More than ${GITHUB_MERGEABILITY_LIST_LIMIT} open pull requests; branch mergeability is not observed`,
      );
    return result;
  }
  getPullRequest(c: PullRequestRepositoryContext, ref: string) {
    const host = this.getHost(c);
    return this.call(c, [
      'pr',
      'view',
      ref,
      '--repo',
      `${host}/${c.repository.owner}/${c.repository.name}`,
      '--json',
      'number,url,title,body,state,author,headRefName,baseRefName,headRefOid,baseRefOid,commits,reviews,comments,mergeable,mergeStateStatus',
    ]);
  }
  getPullRequestByIdentity(
    c: PullRequestRepositoryIdentityContext,
    ref: string,
  ) {
    return this.callByIdentity(c, [
      'pr',
      'view',
      ref,
      '--repo',
      `${c.host}/${c.repository.owner}/${c.repository.name}`,
      '--json',
      'number,url,title,body,state,author,headRefName,baseRefName,headRefOid,baseRefOid,commits,reviews,comments,mergeable,mergeStateStatus',
    ]);
  }
  openPullRequest(c: PullRequestRepositoryContext, input: any) {
    const host = this.getHost(c);
    return this.mutation(c, [
      'pr',
      'create',
      '--repo',
      `${host}/${c.repository.owner}/${c.repository.name}`,
      '--title',
      input.title,
      ...(input.body ? ['--body', input.body] : []),
      ...(input.base ? ['--base', input.base] : []),
      // The pushed branch Station resolved with its own hardened git (the
      // upstream's name, `owner:branch` for a fork); without it gh would
      // run `git status` in its cwd to find one.
      '--head',
      input.head ??
        (c.head
          ? c.head.owner
            ? `${c.head.owner}:${c.head.branch}`
            : c.head.branch
          : c.branch),
    ]);
  }
  createComment(c: PullRequestRepositoryContext, ref: string, input: any) {
    const host = this.getHost(c);
    return this.mutation(
      c,
      [
        'pr',
        'comment',
        ref,
        '--repo',
        `${host}/${c.repository.owner}/${c.repository.name}`,
        '--body',
        input.body,
      ],
      ref,
    );
  }
  approvePullRequest(
    c: PullRequestRepositoryContext,
    ref: string,
    input?: any,
  ) {
    const host = this.getHost(c);
    return this.mutation(
      c,
      [
        'pr',
        'review',
        ref,
        '--repo',
        `${host}/${c.repository.owner}/${c.repository.name}`,
        '--approve',
        ...(input?.body ? ['--body', input.body] : []),
      ],
      ref,
    );
  }
  mergePullRequest(
    c: PullRequestRepositoryContext,
    ref: string,
    input: PullRequestMergeInput,
    admission?: PullRequestWriteAdmission,
  ): Promise<PullRequestResult<PullRequestMergeResult>> {
    return this.write(c, (a) => this.merge(c, ref, input, a, admission));
  }
  private async merge(
    c: PullRequestRepositoryContext,
    ref: string,
    input: PullRequestMergeInput,
    a: PullRequestAvailability,
    admission?: PullRequestWriteAdmission,
  ): Promise<PullRequestResult<PullRequestMergeResult>> {
    if (!a.available) return a;
    if (!a.effectiveMergeMethods.includes(input.method))
      return {
        ...a,
        data: {
          status: 'refused',
          reason: `Merge method ${input.method} is not enabled for this repository`,
        },
      };
    if (admission?.isCurrent() === false)
      return {
        ...a,
        data: {
          status: 'refused',
          reason: 'Station access changed before merge admission.',
        },
      };
    try {
      const host = this.getHost(c);
      await this.gh(
        [
          'pr',
          'merge',
          ref,
          '--repo',
          `${host}/${c.repository.owner}/${c.repository.name}`,
          `--${input.method}`,
          ...(input.autoMerge ? ['--auto'] : []),
          ...(input.expectedHeadSha
            ? ['--match-head-commit', input.expectedHeadSha]
            : []),
        ],
        c,
      );
      if (input.autoMerge || input.expectedHeadSha) {
        let observation: any;
        try {
          observation = JSON.parse(
            (
              await this.gh(
                [
                  'pr',
                  'view',
                  ref,
                  '--repo',
                  `${host}/${c.repository.owner}/${c.repository.name}`,
                  '--json',
                  'state,autoMergeRequest',
                ],
                c,
              )
            ).stdout,
          );
        } catch (error) {
          return {
            ...a,
            data: {
              status: 'indeterminate',
              reason: 'GitHub accepted auto-merge but observation failed',
              observed: { error: reason(error, 'GitHub observation failed') },
            },
          };
        }
        if (observation?.state === 'MERGED')
          return { ...a, data: { status: 'merged' } };
        if (observation?.autoMergeRequest != null)
          return { ...a, data: { status: 'queued-auto-merge' } };
        return {
          ...a,
          data: {
            status: 'indeterminate',
            reason:
              'GitHub accepted auto-merge but neither merged state nor an auto-merge request was observed',
            observed: {
              state: observation?.state ?? null,
              autoMergeRequest: observation?.autoMergeRequest ?? null,
            },
          },
        };
      }
      return {
        ...a,
        data: { status: 'merged' },
      };
    } catch (error) {
      return {
        ...a,
        data: input.expectedHeadSha
          ? {
              status: 'indeterminate',
              reason: reason(
                error,
                'GitHub merge acknowledgement could not be verified',
              ),
              observed: null,
            }
          : {
              status: 'refused',
              reason: reason(error, 'GitHub refused the merge'),
            },
      };
    }
  }
}
