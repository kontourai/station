import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type {
  PullRequestRepositoryContext,
  PullRequestRepositoryIdentityContext,
} from '@kontourai/station-contracts/pull-request-provider';
import type { WorkspaceIsolationMetadata } from '@kontourai/station-contracts/workspace-isolation';
import { execGit } from '../../utils/git-exec.js';
import { expandTilde } from '../../utils/paths.js';
import {
  type CheckoutRemote,
  type CheckoutRemoteReader,
  readCheckoutRemotes,
} from '../projects/checkout-remote-reader.js';

export type PullRequestRepositoryContextResolution =
  | { available: true; context: PullRequestRepositoryContext }
  | { available: false; reason: string };

export interface PullRequestRepositoryContextInput {
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
        // fixed the half nobody was hitting (station#3155 review).
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
      return {
        available: false,
        reason: remotes.ok ? 'Checkout has no remote' : remotes.reason,
      };
    if (remotes.remotes.length === 1) {
      const unsupportedForge = knownUnsupportedForge(remotes.remotes[0].url);
      if (unsupportedForge)
        return {
          available: false,
          reason: `Checkout uses unsupported forge ${unsupportedForge}`,
        };
    }
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
    if (candidates.length !== 1 || candidates.length !== remotes.remotes.length)
      return {
        available: false,
        reason: 'Checkout forge host is ambiguous or unsupported',
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
    if (!remotes.ok || remotes.remotes.length !== 1)
      return {
        available: false,
        reason: remotes.ok
          ? 'Checkout forge host is ambiguous or unsupported'
          : remotes.reason,
      };
    const remote = remotes.remotes[0]!;
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

function knownUnsupportedForge(url: string): string | undefined {
  const match = /^(?:git@([^/:\s]+):|https?:\/\/([^/\s]+)\/)/.exec(url);
  const host = (match?.[1] ?? match?.[2])
    ?.toLowerCase()
    .replace(/:\d+$/, '')
    .replace(/\.$/, '');
  return host === 'bitbucket.org' ? host : undefined;
}

function remoteHost(url: string): string | undefined {
  const match = /^(?:git@([^/:\s]+):|https?:\/\/([^/\s]+)\/)/.exec(url);
  const host = match?.[1] ?? match?.[2];
  return host?.toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
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
