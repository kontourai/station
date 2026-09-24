import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type {
  PullRequestRepositoryContext,
  PullRequestRepositoryIdentityContext,
  PullRequestUnavailableCause,
} from '@kontourai/station-contracts/pull-request-provider';
import type { WorkspaceIsolationMetadata } from '@kontourai/station-contracts/workspace-isolation';
import { execGit } from '../../utils/git-exec.js';
import { expandTilde } from '../../utils/paths.js';
import {
  type CheckoutRemote,
  type CheckoutRemoteReader,
  readCheckoutRemotes,
} from '../projects/checkout-remote-reader.js';

type PullRequestRepositoryContextResolution =
  | { available: true; context: PullRequestRepositoryContext }
  | {
      available: false;
      reason: string;
      /** See `PullRequestUnavailableCause` — classified here, not by prose. */
      cause?: PullRequestUnavailableCause;
    };

interface PullRequestRepositoryContextInput {
  projectWorkingDirectory?: string;
  workspaceIsolation?: WorkspaceIsolationMetadata;
  requestedWorkingDirectory?: string;
}

const PULL_REQUEST_RESOLVER_GIT_TIMEOUT_MS = 5_000;

export class PullRequestRepositoryContextResolver {
  constructor(
    private readonly deps: {
      readRemotes?: CheckoutRemoteReader;
      git?: typeof execGit;
    } = {},
  ) {}

  async resolve(
    input: PullRequestRepositoryContextInput,
  ): Promise<PullRequestRepositoryContextResolution> {
    const isolation = input.workspaceIsolation;
    const recordedWorkingDirectory =
      isolation?.mode === 'worktree'
        ? isolation.path
        : input.projectWorkingDirectory;
    if (!recordedWorkingDirectory)
      return { available: false, reason: 'No recorded checkout' };
    const git = this.deps.git ?? execGit;
    let workingDirectory = recordedWorkingDirectory;
    if (input.requestedWorkingDirectory) {
      try {
        const recordedRoot = realpathSync(recordedWorkingDirectory);
        // Expand this side too. The recorded path is expanded upstream now,
        // but the REQUESTED one arrives from a client query param that is
        // derived from the raw project record — so the panel still sent
        // `~/dev/x`, realpathSync threw, and the panel reported itself
        // unavailable exactly as before. Expanding only the recorded side
        // fixed the half nobody was hitting (archive#3155 review).
        const requestedRoot = realpathSync(
          resolve(expandTilde(input.requestedWorkingDirectory)),
        );
        const displacement = relative(recordedRoot, requestedRoot);
        if (
          displacement === '..' ||
          displacement.startsWith(`..${sep}`) ||
          isAbsolute(displacement)
        ) {
          return {
            available: false,
            reason: 'Requested repository is outside the project checkout',
          };
        }
        const repositoryRoot = realpathSync(
          (
            await git(['rev-parse', '--show-toplevel'], {
              cwd: requestedRoot,
              timeout: PULL_REQUEST_RESOLVER_GIT_TIMEOUT_MS,
            })
          ).stdout.trim(),
        );
        if (repositoryRoot !== requestedRoot) {
          return {
            available: false,
            reason: 'Requested repository is not a recorded project root',
          };
        }
        workingDirectory = requestedRoot;
      } catch {
        return {
          available: false,
          reason: 'Requested repository is not a recorded project checkout',
        };
      }
    }
    const remotes = await (this.deps.readRemotes ?? readCheckoutRemotes)(
      workingDirectory,
    );
    if (!remotes.ok || remotes.remotes.length === 0)
      return remotes.ok
        ? {
            available: false,
            reason: 'Checkout has no remote',
            // The ordinary local repository, not a failure (#1536 G5). A read
            // that could not be performed deliberately carries no cause.
            cause: 'no-remote' as PullRequestUnavailableCause,
          }
        : { available: false, reason: remotes.reason };

    // Unknown authorities remain provider candidates. The route's provider and
    // literal-host match lets the selected CLI reject a wrong self-managed forge.
    const candidates = remotes.remotes
      .map((remote) => ({ remote, repository: providerRepository(remote.url) }))
      .filter(
        (
          candidate,
        ): candidate is {
          remote: CheckoutRemote;
          repository: { owner: string; name: string };
        } => candidate.repository !== undefined,
      );
    if (
      candidates.length !== remotes.remotes.length ||
      distinctRepositories(candidates).length !== 1
    )
      return {
        available: false,
        reason: 'Checkout forge host is ambiguous or unsupported',
      };
    // Several remotes for ONE repository (an https `origin` beside an ssh
    // push remote) are one forge identity, not an ambiguity. `origin` names
    // the base branch when it is among them.
    candidates.sort(
      (a, b) =>
        Number(b.remote.name === 'origin') - Number(a.remote.name === 'origin'),
    );
    // After the collapse, not before: several remotes for one Bitbucket
    // repository are still Bitbucket.
    const unsupportedForge = knownUnsupportedForge(candidates[0]!.remote.url);
    if (unsupportedForge)
      return {
        available: false,
        reason: `Checkout uses unsupported forge ${unsupportedForge}`,
      };
    try {
      const [branch, upstream, ahead, base] = await Promise.all([
        git(['rev-parse', '--abbrev-ref', 'HEAD'], {
          cwd: workingDirectory,
          timeout: PULL_REQUEST_RESOLVER_GIT_TIMEOUT_MS,
        }),
        git(['rev-parse', '--abbrev-ref', '@{upstream}'], {
          cwd: workingDirectory,
          timeout: PULL_REQUEST_RESOLVER_GIT_TIMEOUT_MS,
        }),
        git(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], {
          cwd: workingDirectory,
          timeout: PULL_REQUEST_RESOLVER_GIT_TIMEOUT_MS,
        }),
        isolation?.mode === 'worktree'
          ? Promise.resolve({ stdout: isolation.baseRef })
          : git(
              [
                'symbolic-ref',
                '--quiet',
                '--short',
                `refs/remotes/${candidates[0].remote.name}/HEAD`,
              ],
              {
                cwd: workingDirectory,
                timeout: PULL_REQUEST_RESOLVER_GIT_TIMEOUT_MS,
              },
            ),
      ]);
      const currentBranch = branch.stdout.trim();
      const upstreamBranch = upstream.stdout.trim();
      const [aheadCount] = ahead.stdout.trim().split(/\s+/).map(Number);
      const baseRef = base.stdout.trim().replace(/^.*\//, '');
      if (currentBranch === 'HEAD')
        return { available: false, reason: 'Checkout is detached' };
      if (!upstreamBranch || !Number.isFinite(aheadCount) || aheadCount > 0)
        return {
          available: false,
          reason: 'Current branch is not pushed to its upstream',
        };
      if (!baseRef)
        return {
          available: false,
          reason: 'Checkout has no recorded base branch',
        };
      const head = await upstreamHead(
        git,
        workingDirectory,
        currentBranch,
        candidates[0].remote,
      );
      if (head === 'unknown')
        return {
          available: false,
          reason:
            'Cannot tell which repository the current branch is pushed to; open this pull request from a terminal',
        };
      return {
        available: true,
        context: {
          repository: {
            ...candidates[0].repository,
            remote: candidates[0].remote.url,
          },
          workingDirectory,
          branch: currentBranch,
          baseRef,
          ...(head ? { head } : {}),
        },
      };
    } catch {
      return {
        available: false,
        reason: 'Checkout branch state is unavailable',
      };
    }
  }

  /** Exact remote/repository resolver for point reads; never asks for branch/base. */
  async resolveExactIdentity(input: {
    workingDirectory?: string;
  }): Promise<
    | { available: true; context: PullRequestRepositoryIdentityContext }
    | { available: false; reason: string }
  > {
    if (!input.workingDirectory)
      return { available: false, reason: 'No recorded checkout' };
    let workingDirectory: string;
    try {
      workingDirectory = realpathSync(
        resolve(expandTilde(input.workingDirectory)),
      );
      const root = realpathSync(
        (
          await (this.deps.git ?? execGit)(['rev-parse', '--show-toplevel'], {
            cwd: workingDirectory,
            timeout: PULL_REQUEST_RESOLVER_GIT_TIMEOUT_MS,
          })
        ).stdout.trim(),
      );
      if (root !== workingDirectory)
        return {
          available: false,
          reason: 'Recorded workspace is not a repository root',
        };
    } catch {
      return {
        available: false,
        reason: 'Recorded workspace is not a repository checkout',
      };
    }
    const remotes = await (this.deps.readRemotes ?? readCheckoutRemotes)(
      workingDirectory,
    );
    if (!remotes.ok || remotes.remotes.length === 0)
      return {
        available: false,
        reason: remotes.ok
          ? 'Checkout forge host is ambiguous or unsupported'
          : remotes.reason,
      };
    // As in `resolve`: remotes that all name one repository are one identity.
    const identities = distinctRepositories(
      remotes.remotes.map((candidate) => ({
        remote: candidate,
        repository: providerRepository(candidate.url),
      })),
    );
    if (identities.length !== 1)
      return {
        available: false,
        reason: 'Checkout forge host is ambiguous or unsupported',
      };
    const remote =
      remotes.remotes.find((candidate) => candidate.name === 'origin') ??
      remotes.remotes[0]!;
    const repository = providerRepository(remote.url);
    if (!repository || knownUnsupportedForge(remote.url))
      return {
        available: false,
        reason: 'Checkout forge host is ambiguous or unsupported',
      };
    const host = remoteHost(remote.url);
    if (!host)
      return {
        available: false,
        reason: 'Checkout forge host is ambiguous or unsupported',
      };
    const context: PullRequestRepositoryIdentityContext = {
      host,
      repository: { ...repository },
    };
    return {
      available: true,
      context,
    };
  }

  /** Execute a point read with only its portable exact forge identity. */
  async readExactIdentity<T>(
    input: { workingDirectory?: string },
    read: (identity: PullRequestRepositoryIdentityContext) => Promise<T>,
  ): Promise<
    | {
        available: true;
        identity: PullRequestRepositoryIdentityContext;
        value: T;
      }
    | { available: false; reason: string }
  > {
    const resolved = await this.resolveExactIdentity(input);
    if (!resolved.available) return resolved;
    return {
      available: true,
      identity: resolved.context,
      value: await read(resolved.context),
    };
  }
}

/**
 * The distinct forge repositories a set of remotes names, keyed on host,
 * owner and name compared case-insensitively. A remote that does not parse
 * keeps its own key, so it can never be absorbed into a parsed one.
 */
function distinctRepositories(
  candidates: readonly {
    remote: CheckoutRemote;
    repository?: { owner: string; name: string };
  }[],
): string[] {
  return [
    ...new Set(
      candidates.map(({ remote, repository }) =>
        repository
          ? JSON.stringify([
              remoteHost(remote.url)?.toLowerCase() ?? `?${remote.url}`,
              repository.owner.toLowerCase(),
              repository.name.toLowerCase(),
            ])
          : `unparsed:${remote.url}`,
      ),
    ),
  ];
}

function knownUnsupportedForge(url: string): string | undefined {
  const host = remoteHost(url);
  return host === 'bitbucket.org' ? host : undefined;
}

function remoteHost(url: string): string | undefined {
  const match = /^(?:git@([^/:\s]+):|https?:\/\/([^/\s]+)\/)/.exec(url);
  const host = match?.[1] ?? match?.[2];
  // `https://token@github.com/o/r` names github.com: credentials are not host.
  return host
    ?.replace(/^.*@/, '')
    .toLowerCase()
    .replace(/:\d+$/, '')
    .replace(/\.$/, '');
}

/**
 * The branch a pull request opens from (#2363 round 4). The forge needs
 * the PUSHED branch, which Station names now that gh/glab no longer read
 * the checkout: the upstream's branch (`branch.<name>.merge`), which a
 * local `fx` tracking `origin/feature-x` names differently, and, when the
 * upstream's remote is not the context's repository, the fork's owner and
 * name from that remote's configured URL (same host required). `undefined`
 * when there is no upstream (the local branch applies); `'unknown'` when
 * the upstream cannot be named safely.
 */
async function upstreamHead(
  git: typeof execGit,
  cwd: string,
  branch: string,
  contextRemote: CheckoutRemote,
): Promise<PullRequestRepositoryContext['head'] | 'unknown' | undefined> {
  const read = async (key: string) => {
    try {
      const { stdout } = await git(['config', '--get', key], {
        cwd,
        timeout: PULL_REQUEST_RESOLVER_GIT_TIMEOUT_MS,
      });
      return stdout.trim() || undefined;
    } catch {
      return undefined; // unset
    }
  };
  const remoteName = await read(`branch.${branch}.remote`);
  const merge = await read(`branch.${branch}.merge`);
  if (!remoteName || !merge) return undefined;
  const upstreamBranch = merge.replace(/^refs\/heads\//, '');
  if (!upstreamBranch || upstreamBranch === merge || remoteName === '.') {
    return 'unknown';
  }
  if (remoteName === contextRemote.name) return { branch: upstreamBranch };
  const forkUrl = await read(`remote.${remoteName}.url`);
  const fork = forkUrl ? providerRepository(forkUrl) : undefined;
  if (!forkUrl || !fork || urlHost(forkUrl) !== urlHost(contextRemote.url)) {
    return 'unknown';
  }
  return { branch: upstreamBranch, owner: fork.owner, repository: fork.name };
}

/** The host of an https or scp-style remote, lowercased. */
function urlHost(url: string): string | undefined {
  const match =
    /^(?:git@([^/:\s]+):|https?:\/\/(?:[^@/\s]+@)?([^/:\s]+))/i.exec(url);
  return (match?.[1] ?? match?.[2])?.toLowerCase();
}

function providerRepository(
  url: string,
): { owner: string; name: string } | undefined {
  const match =
    /^(?:git@[^/:\s]+:|https?:\/\/[^/\s]+\/)(.+?)(?:\.git)?\/?$/.exec(url);
  const path = match?.[1]?.replace(/\/$/, '');
  const segments = path?.split('/').filter(Boolean) ?? [];
  if (segments.length < 2) return undefined;
  return {
    // GitLab namespaces may contain subgroups. Unknown/GHE hosts retain this
    // shape and gh owns any provider-specific rejection downstream.
    owner: segments.slice(0, -1).join('/'),
    name: segments.at(-1) as string,
  };
}
