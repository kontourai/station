import { resolve } from 'node:path';
import type {
  IPullRequestProvider,
  PullRequest,
  PullRequestCapabilities,
  PullRequestMergeInput,
  PullRequestMergeMethod,
  PullRequestMergeResult,
  PullRequestRepositoryContext,
  PullRequestRepositoryIdentityContext,
  PullRequestResult,
} from '@kontourai/station-contracts/pull-request-provider';
import { execGitContextCommand } from '../../utils/git-exec.js';
import { expandTilde } from '../../utils/paths.js';

type PullRequestProviderRequestContext =
  | PullRequestRepositoryContext
  | PullRequestRepositoryIdentityContext;

function hasWorkingDirectory(
  context: PullRequestProviderRequestContext,
): context is PullRequestRepositoryContext {
  return Object.hasOwn(context, 'workingDirectory');
}

const defaultGitHubTransport = (
  args: string[],
  context: PullRequestProviderRequestContext,
) =>
  execGitContextCommand('gh', args, {
    ...(hasWorkingDirectory(context)
      ? { cwd: resolve(expandTilde(context.workingDirectory)) }
      : {}),
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
  const stderr =
    typeof error === 'object' && error
      ? (error as { stderr?: unknown }).stderr
      : undefined;
  return typeof stderr === 'string' && stderr.trim()
    ? stderr.trim()
    : error instanceof Error && error.message
      ? error.message
      : fallback;
};
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
    commits: Array.isArray(value.commits) ? value.commits.length : 0,
    reviewStatus: Array.isArray(value.reviews)
      ? (value.reviews.at(-1)?.state ?? 'NONE')
      : 'NONE',
    comments: Array.isArray(value.comments) ? value.comments.length : 0,
    nativeId: String(value.number),
    mergeability:
      value.mergeable === 'MERGEABLE'
        ? 'mergeable'
        : value.mergeable === 'CONFLICTING'
          ? 'conflicting'
          : 'unknown',
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
  ) {}
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
  async getAvailability(context: PullRequestRepositoryContext) {
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
  private async call(
    context: PullRequestRepositoryContext,
    args: string[],
  ): Promise<PullRequestResult<any>> {
    const a = await this.getAvailability(context);
    if (!a.available) return a;
    try {
      const parsed = JSON.parse((await this.gh(args, context)).stdout);
      const normalize = (v: any) => ({
        ...normalizeGitHubPullRequest(v, this.getHost(context)),
        repository: {
          owner: context.repository.owner,
          name: context.repository.name,
        },
      });
      return {
        ...a,
        data: Array.isArray(parsed) ? parsed.map(normalize) : normalize(parsed),
      };
    } catch {
      return unavailable('GitHub CLI request failed');
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
    const a = await this.getAvailability(context);
    if (!a.available) return a;
    try {
      const stdout = (await this.gh(args, context)).stdout;
      const resolvedRef = ref ?? /\/pull\/(\d+)(?:\b|#)/.exec(stdout)?.[1];
      if (!resolvedRef) return { ...a };
      const detail = await this.getPullRequest(context, resolvedRef);
      return detail.available ? detail : { ...a };
    } catch {
      return unavailable('GitHub CLI request failed');
    }
  }
  listPullRequests(c: PullRequestRepositoryContext, q: any) {
    const host = this.getHost(c);
    return this.call(c, [
      'pr',
      'list',
      '--repo',
      `${host}/${c.repository.owner}/${c.repository.name}`,
      '--json',
      'number,url,title,body,state,author,headRefName,baseRefName,commits,reviews,comments,mergeable,mergeStateStatus',
      ...(q.state ? ['--state', q.state.toLowerCase()] : []),
      ...(q.limit ? ['--limit', String(q.limit)] : []),
    ]);
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
      'number,url,title,body,state,author,headRefName,baseRefName,commits,reviews,comments,mergeable,mergeStateStatus',
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
      'number,url,title,body,state,author,headRefName,baseRefName,commits,reviews,comments,mergeable,mergeStateStatus',
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
  async mergePullRequest(
    c: PullRequestRepositoryContext,
    ref: string,
    input: PullRequestMergeInput,
  ): Promise<PullRequestResult<PullRequestMergeResult>> {
    const a = await this.getAvailability(c);
    if (!a.available) return a;
    if (!a.effectiveMergeMethods.includes(input.method))
      return {
        ...a,
        data: {
          status: 'refused',
          reason: `Merge method ${input.method} is not enabled for this repository`,
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
        ],
        c,
      );
      if (input.autoMerge) {
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
        data: {
          status: 'refused',
          reason: reason(error, 'GitHub refused the merge'),
        },
      };
    }
  }
}
