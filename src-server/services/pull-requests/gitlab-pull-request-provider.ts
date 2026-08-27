import { resolve } from 'node:path';
import type {
  IPullRequestProvider,
  PullRequest,
  PullRequestAvailability,
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

const defaultGitLabTransport = (
  args: string[],
  context: PullRequestProviderRequestContext,
) =>
  execGitContextCommand('glab', args, {
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
const offeredMergeMethods: PullRequestMergeMethod[] = [
  'merge',
  'squash',
  'rebase',
];
const noCapabilities: PullRequestCapabilities = {
  list: false,
  detail: false,
  open: false,
  comment: false,
  approve: false,
  merge: false,
  autoMerge: false,
};
const effectiveCapabilities = (): PullRequestCapabilities => ({
  ...offeredCapabilities,
});
const unavailable = (reason: string): PullRequestResult<any> => ({
  available: false,
  reason,
  effectiveCapabilities: { ...noCapabilities },
  effectiveMergeMethods: [],
  mergeMethodsSource: 'provider-default',
});

export class UnsupportedGitLabPullRequestStateError extends TypeError {
  constructor(state: string) {
    super(`Unsupported GitLab pull request state: ${state}`);
    this.name = 'UnsupportedGitLabPullRequestStateError';
  }
}

function canonicalHost(host: string): string {
  return host.toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
}

function listStateArgs(state?: string): string[] {
  switch (state) {
    case undefined:
    case 'opened':
    case 'OPEN':
      return [];
    case 'closed':
    case 'CLOSED':
      return ['--closed'];
    case 'merged':
    case 'MERGED':
      return ['--merged'];
    case 'all':
    case 'ALL':
      return ['--all'];
    default:
      throw new UnsupportedGitLabPullRequestStateError(state);
  }
}

function normalizeState(state: string): string {
  return state === 'opened' ? 'OPEN' : state.toUpperCase();
}

export function normalizeGitLabMergeRequest(
  value: any,
  host: string,
): PullRequest {
  if (
    !Number.isInteger(value?.iid) ||
    typeof value.web_url !== 'string' ||
    typeof value.title !== 'string' ||
    typeof value.state !== 'string' ||
    typeof value.source_branch !== 'string' ||
    typeof value.target_branch !== 'string'
  ) {
    throw new Error('GitLab CLI returned an incomplete merge request');
  }
  return {
    provider: 'gitlab',
    host,
    ref: String(value.iid),
    url: value.web_url,
    repository: { owner: '', name: '' },
    title: value.title,
    body: value.description ?? null,
    state: normalizeState(value.state),
    author: {
      login: value.author?.username ?? '',
      url: value.author?.web_url,
    },
    sourceBranch: value.source_branch,
    targetBranch: value.target_branch,
    commits: Number(value.commits_count ?? value.commits?.length ?? 0),
    reviewStatus: value.detailed_merge_status ?? 'NONE',
    comments: Number(value.user_notes_count ?? value.notes?.length ?? 0),
    nativeId: String(value.iid),
    mergeability: ['mergeable', 'can_be_merged'].includes(
      value.detailed_merge_status ?? value.merge_status,
    )
      ? 'mergeable'
      : ['conflict', 'conflicts', 'cannot_be_merged'].includes(
            value.detailed_merge_status ?? value.merge_status,
          )
        ? 'conflicting'
        : 'unknown',
  };
}

/** GitLab transport delegates authentication to glab and retains no credentials. */
export class GitLabPullRequestProvider implements IPullRequestProvider {
  readonly id = 'gitlab';
  readonly displayName = 'GitLab';
  readonly offeredCapabilities = offeredCapabilities;
  readonly offeredMergeMethods = offeredMergeMethods;

  /** v1 intentionally does not auto-claim self-managed GitLab hosts. */
  canServeHost(host: string): boolean {
    return canonicalHost(host) === 'gitlab.com';
  }

  constructor(
    private readonly transport: (
      args: string[],
      context: PullRequestProviderRequestContext,
    ) => Promise<{ stdout: string }> = defaultGitLabTransport,
    private readonly repositorySettingsTransport:
      | ((
          args: string[],
          context: PullRequestRepositoryContext,
        ) => Promise<{ stdout: string }>)
      | undefined = transport === defaultGitLabTransport
      ? defaultGitLabTransport
      : undefined,
  ) {}

  private async glab(
    args: string[],
    context: PullRequestProviderRequestContext,
  ) {
    return this.transport(args, context);
  }

  getHost(context: PullRequestRepositoryContext): string {
    const remote = context.repository.remote;
    const match = /^(?:git@([^/:\s]+):|https?:\/\/([^/\s]+)\/)/.exec(remote);
    const host = match?.[1] ?? match?.[2];
    if (!host) throw new Error('GitLab remote URL has no host');
    return host.toLowerCase();
  }

  async getAvailability(
    context: PullRequestRepositoryContext,
  ): Promise<PullRequestAvailability> {
    const host = this.getHost(context);
    try {
      await this.glab(['auth', 'status', '--hostname', host], context);
      let effectiveMergeMethods: PullRequestMergeMethod[] = [
        ...this.offeredMergeMethods,
      ];
      let mergeMethodsSource: 'provider-default' | 'repository' =
        'provider-default';
      if (this.repositorySettingsTransport) {
        try {
          const path = encodeURIComponent(
            `${context.repository.owner}/${context.repository.name}`,
          );
          const { stdout } = await this.repositorySettingsTransport(
            ['api', `projects/${path}`, '--hostname', host],
            context,
          );
          const settings = JSON.parse(stdout);
          if (
            !['merge', 'rebase_merge', 'ff'].includes(settings.merge_method) ||
            typeof settings.squash_option !== 'string'
          )
            throw new Error('Incomplete GitLab repository settings');
          effectiveMergeMethods = [
            ...(settings.merge_method === 'merge' ? (['merge'] as const) : []),
            ...(settings.merge_method === 'rebase_merge' ||
            settings.merge_method === 'ff'
              ? (['rebase'] as const)
              : []),
            ...(settings.squash_option === 'never'
              ? []
              : (['squash'] as const)),
          ];
          mergeMethodsSource = 'repository';
        } catch {
          // Repository settings are an optional narrowing read.
        }
      }
      return {
        available: true,
        effectiveCapabilities: effectiveCapabilities(),
        effectiveMergeMethods,
        mergeMethodsSource,
      };
    } catch {
      return {
        available: false,
        reason: `glab CLI is unavailable or not authenticated for host ${host}`,
        effectiveCapabilities: { ...noCapabilities },
        effectiveMergeMethods: [],
        mergeMethodsSource: 'provider-default' as const,
      };
    }
  }

  private repositoryArg(context: PullRequestRepositoryContext): string {
    // Full-URL form, verified against glab 1.113.0: a bare
    // `host/owner/name` is parsed as GROUP/NAMESPACE/REPO — the host would
    // be read as a GROUP on the DEFAULT instance, silently targeting the
    // wrong forge (the same wrong-target class the host dimension exists
    // to prevent). The URL form is the only shape that carries the host.
    return `https://${this.getHost(context)}/${context.repository.owner}/${context.repository.name}`;
  }

  private repositoryIdentityArg(
    context: PullRequestRepositoryIdentityContext,
  ): string {
    return `https://${context.host}/${context.repository.owner}/${context.repository.name}`;
  }

  private async call(
    context: PullRequestRepositoryContext,
    args: string[],
  ): Promise<PullRequestResult<any>> {
    const availability = await this.getAvailability(context);
    if (!availability.available) return availability;
    try {
      const { stdout } = await this.glab(args, context);
      const parsed = JSON.parse(stdout);
      const normalize = (value: any) => ({
        ...normalizeGitLabMergeRequest(value, this.getHost(context)),
        repository: {
          owner: context.repository.owner,
          name: context.repository.name,
        },
      });
      return {
        available: true,
        data: Array.isArray(parsed) ? parsed.map(normalize) : normalize(parsed),
        effectiveCapabilities: availability.effectiveCapabilities,
        effectiveMergeMethods: availability.effectiveMergeMethods,
        mergeMethodsSource: availability.mergeMethodsSource,
      };
    } catch {
      return unavailable('glab CLI request failed');
    }
  }

  /**
   * A declared-output detail read is fully named by host/owner/repository/ref.
   * Do not turn its portable identity into a checkout context merely to reuse
   * availability or branch-oriented request plumbing.
   */
  private async callByIdentity(
    context: PullRequestRepositoryIdentityContext,
    args: string[],
  ): Promise<PullRequestResult<any>> {
    try {
      const { stdout } = await this.glab(args, context);
      const parsed = JSON.parse(stdout);
      const normalize = (value: any) => ({
        ...normalizeGitLabMergeRequest(value, context.host),
        repository: {
          owner: context.repository.owner,
          name: context.repository.name,
        },
      });
      return {
        available: true,
        data: Array.isArray(parsed) ? parsed.map(normalize) : normalize(parsed),
        effectiveCapabilities: effectiveCapabilities(),
        effectiveMergeMethods: [...offeredMergeMethods],
        mergeMethodsSource: 'provider-default',
      };
    } catch {
      return unavailable('glab CLI request failed');
    }
  }

  private async mutation(
    context: PullRequestRepositoryContext,
    args: string[],
    ref?: string,
  ): Promise<PullRequestResult<any>> {
    const availability = await this.getAvailability(context);
    if (!availability.available) return availability;
    try {
      const { stdout } = await this.glab(args, context);
      const urlRef = /\/merge_requests\/(\d+)(?:\b|#)/.exec(stdout)?.[1];
      const resolvedRef = ref ?? urlRef;
      if (!resolvedRef)
        return {
          available: true,
          effectiveCapabilities: availability.effectiveCapabilities,
          effectiveMergeMethods: availability.effectiveMergeMethods,
          mergeMethodsSource: availability.mergeMethodsSource,
        };
      const detail = await this.getPullRequest(context, resolvedRef);
      return detail.available
        ? detail
        : {
            available: true,
            effectiveCapabilities: availability.effectiveCapabilities,
            effectiveMergeMethods: availability.effectiveMergeMethods,
            mergeMethodsSource: availability.mergeMethodsSource,
          };
    } catch {
      return unavailable('glab CLI request failed');
    }
  }

  async listPullRequests(c: PullRequestRepositoryContext, q: any) {
    return this.call(c, [
      'mr',
      'list',
      '--repo',
      this.repositoryArg(c),
      '--output',
      'json',
      ...listStateArgs(q.state),
      ...(q.limit ? ['--per-page', String(q.limit)] : []),
    ]);
  }

  async getPullRequest(c: PullRequestRepositoryContext, ref: string) {
    return this.call(c, [
      'mr',
      'view',
      ref,
      '--repo',
      this.repositoryArg(c),
      '--output',
      'json',
    ]);
  }
  async getPullRequestByIdentity(
    c: PullRequestRepositoryIdentityContext,
    ref: string,
  ) {
    return this.callByIdentity(c, [
      'mr',
      'view',
      ref,
      '--repo',
      this.repositoryIdentityArg(c),
      '--output',
      'json',
    ]);
  }

  async openPullRequest(c: PullRequestRepositoryContext, input: any) {
    return this.mutation(c, [
      'mr',
      'create',
      '--repo',
      this.repositoryArg(c),
      '--title',
      input.title,
      ...(input.body ? ['--description', input.body] : []),
      ...(input.base ? ['--target-branch', input.base] : []),
      ...(input.head ? ['--source-branch', input.head] : []),
      '--yes',
    ]);
  }

  async createComment(
    c: PullRequestRepositoryContext,
    ref: string,
    input: any,
  ) {
    return this.mutation(
      c,
      [
        'mr',
        'note',
        // Explicit subcommand: `mr note` is a command group in current glab
        // (create/delete/list/...); bare dispatch "creates by default" but
        // the -m flag is declared on `create` — explicit routing is the
        // deterministic form (verified against glab 1.113.0).
        'create',
        ref,
        '--repo',
        this.repositoryArg(c),
        '--message',
        input.body,
      ],
      ref,
    );
  }

  async approvePullRequest(
    c: PullRequestRepositoryContext,
    ref: string,
    _input?: any,
  ) {
    return this.mutation(
      c,
      ['mr', 'approve', ref, '--repo', this.repositoryArg(c)],
      ref,
    );
  }

  async mergePullRequest(
    c: PullRequestRepositoryContext,
    ref: string,
    input: PullRequestMergeInput,
  ): Promise<PullRequestResult<PullRequestMergeResult>> {
    const availability = await this.getAvailability(c);
    if (!availability.available) return availability;
    if (!availability.effectiveMergeMethods.includes(input.method)) {
      return {
        ...availability,
        data: {
          status: 'refused',
          reason: `Merge method ${input.method} is not enabled for this repository`,
        },
      };
    }
    try {
      await this.glab(
        [
          'mr',
          'merge',
          ref,
          '--repo',
          this.repositoryArg(c),
          ...(input.method === 'squash' ? ['--squash'] : []),
          ...(input.method === 'rebase' ? ['--rebase'] : []),
          ...(input.autoMerge ? ['--auto-merge'] : ['--auto-merge=false']),
          '--yes',
        ],
        c,
      );
      if (input.autoMerge) {
        let observation: any;
        try {
          observation = JSON.parse(
            (
              await this.glab(
                [
                  'mr',
                  'view',
                  ref,
                  '--repo',
                  this.repositoryArg(c),
                  '--output',
                  'json',
                ],
                c,
              )
            ).stdout,
          );
        } catch (error) {
          const stderr =
            typeof error === 'object' && error
              ? (error as { stderr?: unknown }).stderr
              : undefined;
          return {
            ...availability,
            data: {
              status: 'indeterminate',
              reason: 'GitLab accepted auto-merge but observation failed',
              observed: {
                error:
                  typeof stderr === 'string' && stderr.trim()
                    ? stderr.trim()
                    : error instanceof Error
                      ? error.message
                      : 'GitLab observation failed',
              },
            },
          };
        }
        if (observation?.state === 'merged')
          return { ...availability, data: { status: 'merged' } };
        if (
          observation?.merge_when_pipeline_succeeds === true ||
          observation?.auto_merge_enabled === true
        )
          return {
            ...availability,
            data: { status: 'queued-auto-merge' },
          };
        return {
          ...availability,
          data: {
            status: 'indeterminate',
            reason:
              'GitLab accepted auto-merge but neither merged state nor an armed auto-merge setting was observed',
            observed: {
              state: observation?.state ?? null,
              merge_when_pipeline_succeeds:
                observation?.merge_when_pipeline_succeeds ?? null,
              auto_merge_enabled: observation?.auto_merge_enabled ?? null,
            },
          },
        };
      }
      return {
        ...availability,
        data: { status: 'merged' },
      };
    } catch (error) {
      const stderr =
        typeof error === 'object' && error
          ? (error as { stderr?: unknown }).stderr
          : undefined;
      const reason =
        typeof stderr === 'string' && stderr.trim()
          ? stderr.trim()
          : error instanceof Error && error.message
            ? error.message
            : 'GitLab refused the merge';
      return {
        ...availability,
        data: { status: 'refused', reason },
      };
    }
  }
}
