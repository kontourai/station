import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, realpath, rm } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { normalizeGitOrigin } from '@kontourai/station-contracts/git-remote-identity';
import type {
  IndependentReviewRequest,
  ReviewFindingLocation,
  ReviewGitTarget,
} from '@kontourai/station-contracts/review-evidence';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import { execGit } from '../../utils/git-exec.js';
import type {
  ReadOnlyReviewWorkspace,
  ReviewWorkspaceSource,
} from './review-evidence-module.js';

const GIT_SHA = /^[0-9a-f]{40}$/;
const MAX_REVIEWED_FILE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_REVIEW_WORKSPACES = 8;
const GIT_INSPECTION_TIMEOUT_MS = 2 * 60_000;
const GIT_MUTATION_TIMEOUT_MS = 30_000;

export interface GitReviewProjectResolver {
  workspace(projectSlug: string): string | undefined;
}

export interface GitReviewWorkspaceSourceOptions {
  maxWorkspaces?: number;
}

export interface GitReviewRangeChange {
  status: string;
  oldPath?: string;
  newPath?: string;
}

export interface GitReviewRangeInspection {
  repositoryRoot: string;
  target: ReviewGitTarget;
  changes: GitReviewRangeChange[];
}

export class GitReviewWorkspaceSource implements ReviewWorkspaceSource {
  readonly #maxWorkspaces: number;

  constructor(
    private readonly projects: GitReviewProjectResolver,
    private readonly workspaceBaseDir: string,
    options: GitReviewWorkspaceSourceOptions = {},
  ) {
    this.#maxWorkspaces =
      options.maxWorkspaces ?? DEFAULT_MAX_REVIEW_WORKSPACES;
    if (
      !Number.isInteger(this.#maxWorkspaces) ||
      this.#maxWorkspaces < 1 ||
      this.#maxWorkspaces > 64
    ) {
      throw new Error('Review workspace capacity is invalid.');
    }
  }

  async open(
    input: IndependentReviewRequest['target'],
  ): Promise<ReadOnlyReviewWorkspace> {
    const configuredWorkspace = this.projects.workspace(input.projectSlug);
    if (!configuredWorkspace) {
      throw new Error(`Project workspace not found: ${input.projectSlug}`);
    }
    const repoRoot = (
      await execGit(
        ['-C', configuredWorkspace, 'rev-parse', '--show-toplevel'],
        { timeout: GIT_INSPECTION_TIMEOUT_MS },
      )
    ).stdout.trim();
    if (!repoRoot) throw new Error('Review target is not a Git repository.');
    const canonicalRepoRoot = await realpath(repoRoot);
    const inspection = await inspectGitReviewRange(canonicalRepoRoot, input);
    const { target } = inspection;

    const canonicalBase = resolve(this.workspaceBaseDir);
    await mkdir(canonicalBase, { recursive: true, mode: 0o700 });
    const workspaceRoot = join(canonicalBase, `review-${randomUUID()}`);
    assertContained(canonicalBase, workspaceRoot);
    const lockPath = join(canonicalBase, '.workspaces.mutation');
    const releaseAdmission = await acquireFileMutationLockAsync(lockPath);
    try {
      const retained = (await readdir(canonicalBase)).filter((name) =>
        name.startsWith('review-'),
      );
      if (retained.length >= this.#maxWorkspaces) {
        throw new Error(
          'Review workspace capacity is exhausted by protected workspaces.',
        );
      }
      try {
        await execGit(
          [
            '-C',
            canonicalRepoRoot,
            'worktree',
            'add',
            '--detach',
            workspaceRoot,
            target.headSha,
          ],
          { timeout: GIT_MUTATION_TIMEOUT_MS },
        );
      } catch (error) {
        await rm(workspaceRoot, { recursive: true, force: true });
        throw error;
      }
    } finally {
      await releaseAdmission();
    }
    let closed = false;
    return {
      root: workspaceRoot,
      target,
      validateLocation: (location) =>
        validateLocation(canonicalRepoRoot, target.headSha, location),
      close: async () => {
        if (closed) return;
        const releaseCleanup = await acquireFileMutationLockAsync(lockPath);
        try {
          if (closed) return;
          let removalError: unknown;
          try {
            await execGit(
              [
                '-C',
                canonicalRepoRoot,
                'worktree',
                'remove',
                '--force',
                workspaceRoot,
              ],
              { timeout: GIT_MUTATION_TIMEOUT_MS },
            );
          } catch (error) {
            removalError = error;
          }
          await rm(workspaceRoot, { recursive: true, force: true });
          if (removalError !== undefined) throw removalError;
          closed = true;
        } finally {
          await releaseCleanup();
        }
      },
    };
  }
}

/** Frozen range inspection shared by workspace materialization and routing. */
export async function inspectGitReviewRange(
  repositoryRoot: string,
  input: IndependentReviewRequest['target'],
): Promise<GitReviewRangeInspection> {
  const baseSha = await resolveCommit(repositoryRoot, input.baseRevision);
  const headSha = await resolveCommit(repositoryRoot, input.headRevision);
  if (baseSha === headSha)
    throw new Error('Review target range has no revision change.');
  const diff = (
    await execGit(
      [
        '-C',
        repositoryRoot,
        'diff',
        '--no-ext-diff',
        '--binary',
        baseSha,
        headSha,
        '--',
      ],
      { maxBuffer: 64 * 1024 * 1024, timeout: GIT_INSPECTION_TIMEOUT_MS },
    )
  ).stdout;
  const nameStatus = (
    await execGit(
      [
        '-C',
        repositoryRoot,
        'diff',
        '--name-status',
        '-z',
        '--find-renames',
        baseSha,
        headSha,
        '--',
      ],
      { maxBuffer: 4 * 1024 * 1024, timeout: GIT_INSPECTION_TIMEOUT_MS },
    )
  ).stdout;
  const origin = await execGit(
    ['-C', repositoryRoot, 'config', '--get', 'remote.origin.url'],
    { encoding: 'utf8', timeout: GIT_INSPECTION_TIMEOUT_MS },
  ).catch(() => ({ stdout: '', stderr: '' }));
  return {
    repositoryRoot,
    target: {
      ...input,
      repositoryId:
        normalizeGitOrigin(origin.stdout.trim()) ||
        `local:${createHash('sha256').update(repositoryRoot).digest('hex')}`,
      baseSha,
      headSha,
      diffSha256: createHash('sha256').update(diff).digest('hex'),
    },
    changes: parseNameStatus(nameStatus),
  };
}

async function resolveCommit(
  repoRoot: string,
  revision: string,
): Promise<string> {
  const value = (
    await execGit(
      ['-C', repoRoot, 'rev-parse', '--verify', `${revision}^{commit}`],
      { timeout: GIT_INSPECTION_TIMEOUT_MS },
    )
  ).stdout.trim();
  if (!GIT_SHA.test(value)) throw new Error('Review revision is invalid.');
  return value;
}

async function validateLocation(
  repoRoot: string,
  headSha: string,
  location: ReviewFindingLocation,
): Promise<void> {
  const treeEntry = (
    await execGit(
      ['-C', repoRoot, 'ls-tree', '-z', headSha, '--', location.file],
      { timeout: GIT_INSPECTION_TIMEOUT_MS, maxBuffer: 64 * 1024 },
    )
  ).stdout;
  const match = /^(100644|100755) blob [0-9a-f]{40}\t([^\0]+)\0$/.exec(
    treeEntry,
  );
  if (!match || match[2] !== location.file) {
    throw new Error(
      'Review finding location is absent from the reviewed head.',
    );
  }
  const content = (
    await execGit(['-C', repoRoot, 'show', `${headSha}:${location.file}`], {
      encoding: 'utf8',
      timeout: GIT_INSPECTION_TIMEOUT_MS,
      maxBuffer: MAX_REVIEWED_FILE_BYTES + 1,
    })
  ).stdout;
  if (Buffer.byteLength(content) > MAX_REVIEWED_FILE_BYTES) {
    throw new Error('Review finding file exceeds the byte limit.');
  }
  const lineCount = content.length === 0 ? 0 : content.split(/\r?\n/).length;
  if (location.line > lineCount) {
    throw new Error('Review finding line is absent from the reviewed head.');
  }
}

function assertContained(root: string, target: string): void {
  const rel = relative(resolve(root), resolve(target));
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error('Review workspace path is outside its coordination root.');
  }
}

function parseNameStatus(value: string): GitReviewRangeChange[] {
  const parts = value.split('\0');
  parts.pop();
  const changes: GitReviewRangeChange[] = [];
  for (let index = 0; index < parts.length; ) {
    const status = parts[index++];
    if (!status || !/^[ACDMRTUXB][0-9]*$/.test(status)) {
      throw new Error('Review range contains a malformed name-status record.');
    }
    const oldPath = parts[index++];
    const newPath =
      status.startsWith('R') || status.startsWith('C')
        ? parts[index++]
        : undefined;
    if (!safePath(oldPath) || (newPath !== undefined && !safePath(newPath))) {
      throw new Error('Review range contains a malformed path.');
    }
    changes.push(
      newPath === undefined
        ? status.startsWith('D')
          ? { status, oldPath }
          : { status, newPath: oldPath }
        : { status, oldPath, newPath },
    );
  }
  return changes;
}

function safePath(path: string | undefined): path is string {
  return Boolean(
    path && /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\).+$/.test(path),
  );
}
