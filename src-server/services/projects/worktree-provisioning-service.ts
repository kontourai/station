import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import type { ProviderKind } from '@kontourai/station-contracts/provider';
import type {
  WorkspaceIsolationConfig,
  WorktreeCleanupPolicy,
  WorktreeIsolationPolicy,
  WorktreeSessionMetadata,
} from '@kontourai/station-contracts/workspace-isolation';
import {
  worktreeCleanupTotal,
  worktreeConflictPreventedTotal,
  worktreeProvisionDuration,
  worktreeProvisionTotal,
} from '../../telemetry/metrics.js';
import { spawnGit } from '../../utils/git-exec.js';
import { expandTilde } from '../../utils/paths.js';

export type WorktreeTerminalState = 'completed' | 'failed' | 'cancelled';

export interface WorktreeProvisionRequest {
  repoPath: string;
  threadId: string;
  providerKind: ProviderKind;
  isolation?: WorkspaceIsolationConfig;
}

export interface WorktreeCleanupRequest {
  metadata: WorktreeSessionMetadata;
  terminalState: WorktreeTerminalState;
  /** Required by lifecycle cleanup; binds hostile metadata to its owner. */
  sessionId?: string;
}

export type GitCommandResult = {
  stdout: string;
  stderr: string;
  code: number;
};

export interface GitCommandRunner {
  run(
    args: string[],
    options?: { cwd?: string; allowCodes?: number[] },
  ): Promise<GitCommandResult>;
}

const DEFAULT_BRANCH_PREFIX = 'station/session';
const DEFAULT_BASE_REF = 'HEAD';

export function shouldUseWorktreeIsolation(
  isolation?: WorkspaceIsolationConfig,
): isolation is WorkspaceIsolationConfig & { mode: 'worktree' } {
  return isolation?.mode === 'worktree';
}

export function validateWorktreePolicy(policy: WorktreeIsolationPolicy = {}) {
  const branchPrefix = normalizeBranchPrefix(policy.branchPrefix);
  const baseRef =
    typeof policy.baseRef === 'string' && policy.baseRef.trim()
      ? policy.baseRef.trim()
      : DEFAULT_BASE_REF;

  validateGitRefSegment(baseRef, 'baseRef');

  return {
    branchPrefix,
    baseRef,
    cleanupPolicy: resolveCleanupPolicy(policy),
    preserveOnFailure: policy.preserveOnFailure !== false,
    worktreeBaseDir:
      typeof policy.worktreeBaseDir === 'string' &&
      policy.worktreeBaseDir.trim()
        ? policy.worktreeBaseDir.trim()
        : undefined,
  };
}

export function buildWorktreeBranchName(input: {
  threadId: string;
  branchPrefix?: string;
}): string {
  const branchPrefix = normalizeBranchPrefix(input.branchPrefix);
  const suffix = worktreeSessionSegment(input.threadId);
  const branch = `${branchPrefix}/${suffix}`;
  validateGitRefSegment(branch, 'branch');
  return branch;
}

/** Prove hostile persisted cleanup metadata still belongs to this session. */
export function assertWorktreeMetadataSessionBinding(
  metadata: WorktreeSessionMetadata,
  threadId: string,
): void {
  const expectedSuffix = worktreeSessionSegment(threadId);
  const branchSuffix = metadata.branch.split('/').at(-1);
  if (
    !expectedSuffix ||
    branchSuffix !== expectedSuffix ||
    basename(canonicalizePath(metadata.path)) !== expectedSuffix
  ) {
    throw new Error('Worktree cleanup metadata is not bound to its session');
  }
}

/** Preserve on any non-clean exit even if lifecycle projection says canceled. */
export function terminalWorktreeStateForExit(input: {
  lifecycleState: unknown;
  exitCode?: number;
  events: unknown[];
}): WorktreeTerminalState {
  // A clean terminal completion proves recovery succeeded even when its event
  // history contains an earlier runtime error.
  if (input.lifecycleState === 'completed' && input.exitCode === 0) {
    return 'completed';
  }
  if (
    (input.exitCode !== undefined && input.exitCode !== 0) ||
    input.events.some(
      (event) =>
        !!event &&
        typeof event === 'object' &&
        ((event as { method?: unknown }).method === 'runtime.error' ||
          (event as { lifecycleState?: unknown }).lifecycleState === 'failed'),
    )
  ) {
    return 'failed';
  }
  if (input.lifecycleState === 'failed') return 'failed';
  if (input.lifecycleState === 'completed') return 'completed';
  if (input.lifecycleState === 'canceled') return 'cancelled';
  return input.exitCode === 0 ? 'completed' : 'cancelled';
}

function resolveCleanupPolicy(
  policy: WorktreeIsolationPolicy,
): WorktreeCleanupPolicy {
  return policy.cleanupOnCompletion === false ? 'preserve' : 'cleanup';
}

function normalizeBranchPrefix(branchPrefix?: string): string {
  const value = branchPrefix?.trim() || DEFAULT_BRANCH_PREFIX;
  const normalized = value.replace(/^\/+|\/+$/g, '');
  validateGitRefSegment(normalized, 'branchPrefix');
  return normalized;
}

function sanitizeRefSegment(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  if (!sanitized) {
    throw new Error('Cannot build worktree branch for an empty session id');
  }
  return sanitized;
}

/**
 * Keep the readable prefix while binding every name to the full session id.
 * The digest is 32 hex chars (128 bits): thread ids can be caller-supplied, so
 * the binding must be collision-resistant against an ATTACKER-chosen id pair —
 * a shorter truncation (48 bits) left a practical ~2^24 birthday search that
 * could alias two sessions' worktrees and let transplanted cleanup metadata
 * delete the other session's live worktree. Segment stays ≤113 chars, within
 * git ref and filesystem component limits.
 */
function worktreeSessionSegment(threadId: string): string {
  const suffix = sanitizeRefSegment(threadId);
  const digest = createHash('sha256')
    .update(threadId)
    .digest('hex')
    .slice(0, 32);
  return `${suffix}-${digest}`;
}

function validateGitRefSegment(value: string, label: string): void {
  if (!value) {
    throw new Error(`Invalid worktree ${label}: value is required`);
  }
  if (
    value.startsWith('-') ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.includes('..') ||
    value.includes('@{') ||
    value.includes('\\') ||
    /[\s~^:?*[\\]/.test(value) ||
    hasControlCharacter(value) ||
    value.split('/').some((part) => !part || part.endsWith('.lock'))
  ) {
    throw new Error(`Invalid worktree ${label}: ${value}`);
  }
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function resolveWorktreeBaseDir(repoRoot: string, policyBaseDir?: string) {
  // EXPAND. `worktreeBaseDir` is a free-text policy field, so `~/worktrees`
  // would otherwise `resolve()` to a LITERAL `~` directory relative to the
  // process cwd — Station's own install root — and every worktree for the
  // session would be provisioned inside it. That is the exact failure
  // station#3155 shipped for knowledge namespaces, and station#3147 for file
  // previews: silent, and wrong in a place nobody looks.
  //
  // Latent rather than live today: no route, CLI command, UI surface or doc
  // sets `worktreeBaseDir` (grepped across src-server/routes, packages/cli,
  // src-ui and docs — the field is declared in the contract and read only
  // here). This is the guard being placed before the producer exists, not a
  // reachable bug being closed.
  //
  // The default branch cannot carry a tilde — it is derived from `repoRoot`,
  // itself already expanded upstream — but expanding both is simpler than a
  // conditional and cannot drift if the default ever changes.
  return resolve(
    expandTilde(
      policyBaseDir ??
        join(dirname(repoRoot), `${basename(repoRoot)}-worktrees`),
    ),
  );
}

function assertContainedPath(
  parent: string,
  child: string,
  label: string,
): void {
  const relativePath = relative(parent, child);
  if (
    relativePath === '' ||
    relativePath.startsWith('..') ||
    relativePath.includes(`..${sep}`)
  ) {
    throw new Error(`Invalid worktree ${label}: ${child}`);
  }
}

function canonicalizePath(path: string): string {
  let existingPath = resolve(path);
  const missingSegments: string[] = [];

  while (!existsSync(existingPath)) {
    const parent = dirname(existingPath);
    if (parent === existingPath) {
      return resolve(path);
    }
    missingSegments.unshift(basename(existingPath));
    existingPath = parent;
  }

  return resolve(realpathSync(existingPath), ...missingSegments);
}

function assertWorktreePathPolicy(input: {
  repoRoot: string;
  worktreeBaseDir: string;
  worktreePath: string;
}): void {
  const repoRoot = canonicalizePath(input.repoRoot);
  const worktreeBaseDir = canonicalizePath(input.worktreeBaseDir);
  const worktreePath = canonicalizePath(input.worktreePath);
  const pathRelativeToRepo = relative(repoRoot, worktreePath);

  if (worktreeBaseDir === repoRoot || worktreePath === repoRoot) {
    throw new Error('Invalid worktree path: cannot use repository root');
  }
  if (
    pathRelativeToRepo &&
    !pathRelativeToRepo.startsWith('..') &&
    !pathRelativeToRepo.includes(`..${sep}`)
  ) {
    throw new Error(
      'Invalid worktree path: cannot provision inside repository root',
    );
  }

  assertContainedPath(worktreeBaseDir, worktreePath, 'path');
}

function cleanupPolicyForTerminalState(
  metadata: WorktreeSessionMetadata,
  terminalState: WorktreeTerminalState,
): WorktreeCleanupPolicy {
  if (terminalState === 'failed' && metadata.preserveOnFailure) {
    return 'preserve';
  }
  return metadata.cleanupPolicy;
}

class SpawnGitCommandRunner implements GitCommandRunner {
  async run(
    args: string[],
    options: { cwd?: string; allowCodes?: number[] } = {},
  ): Promise<GitCommandResult> {
    const allowCodes = options.allowCodes ?? [0];
    return await new Promise((resolve, reject) => {
      const child = spawnGit(args, {
        cwd: options.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';

      // stdio is explicitly piped above, so these streams are always present.
      const childStdout = child.stdout as NonNullable<typeof child.stdout>;
      const childStderr = child.stderr as NonNullable<typeof child.stderr>;
      childStdout.setEncoding('utf8');
      childStderr.setEncoding('utf8');
      childStdout.on('data', (chunk) => {
        stdout += chunk;
      });
      childStderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', reject);
      child.on('close', (code) => {
        const exitCode = code ?? 1;
        const result = { stdout, stderr, code: exitCode };
        if (allowCodes.includes(exitCode)) {
          resolve(result);
          return;
        }
        reject(
          new Error(
            `git ${args.join(' ')} failed with code ${exitCode}: ${
              stderr.trim() || stdout.trim()
            }`,
          ),
        );
      });
    });
  }
}

export class WorktreeProvisioningService {
  constructor(
    private readonly git: GitCommandRunner = new SpawnGitCommandRunner(),
  ) {}

  async provision(
    request: WorktreeProvisionRequest,
  ): Promise<WorktreeSessionMetadata | null> {
    if (!shouldUseWorktreeIsolation(request.isolation)) {
      return null;
    }

    const startedAt = performance.now();
    try {
      const metadata = await this.createWorktree({
        ...request,
        isolation: request.isolation,
      });
      worktreeProvisionTotal.add(1, {
        outcome: 'success',
        provider_kind: request.providerKind,
        reason: 'created',
      });
      return metadata;
    } catch (error) {
      worktreeProvisionTotal.add(1, {
        outcome: 'failure',
        provider_kind: request.providerKind,
        reason: errorReason(error),
      });
      throw error;
    } finally {
      worktreeProvisionDuration.record(performance.now() - startedAt, {
        provider_kind: request.providerKind,
      });
    }
  }

  async preserve(request: WorktreeCleanupRequest): Promise<'preserved'> {
    const policy = cleanupPolicyForTerminalState(
      request.metadata,
      request.terminalState,
    );
    worktreeCleanupTotal.add(1, {
      outcome: 'preserved',
      policy,
      terminal_state: request.terminalState,
    });
    return 'preserved';
  }

  async finalize(
    request: WorktreeCleanupRequest,
  ): Promise<'removed' | 'preserved'> {
    return await this.cleanup(request);
  }

  async cleanup(
    request: WorktreeCleanupRequest,
  ): Promise<'removed' | 'preserved'> {
    if (request.sessionId) {
      assertWorktreeMetadataSessionBinding(request.metadata, request.sessionId);
    }
    const policy = cleanupPolicyForTerminalState(
      request.metadata,
      request.terminalState,
    );
    if (policy === 'preserve') {
      return await this.preserve(request);
    }

    try {
      await this.assertRegisteredCleanupTarget(request.metadata);
      await this.git.run([
        '-C',
        request.metadata.repoPath,
        'worktree',
        'remove',
        '--force',
        request.metadata.path,
      ]);
      await this.git.run(
        [
          '-C',
          request.metadata.repoPath,
          'branch',
          '-D',
          request.metadata.branch,
        ],
        { allowCodes: [0, 1] },
      );
      worktreeCleanupTotal.add(1, {
        outcome: 'success',
        policy,
        terminal_state: request.terminalState,
      });
      return 'removed';
    } catch (error) {
      worktreeCleanupTotal.add(1, {
        outcome: 'failure',
        policy,
        terminal_state: request.terminalState,
      });
      throw error;
    }
  }

  /**
   * Cleanup receives persisted data, so treat it as hostile until git confirms
   * the exact source repository owns this path and branch. This deliberately
   * repeats the creation path policy before issuing a destructive command.
   */
  private async assertRegisteredCleanupTarget(
    metadata: WorktreeSessionMetadata,
  ): Promise<void> {
    const repoRoot = (
      await this.git.run([
        '-C',
        metadata.repoPath,
        'rev-parse',
        '--show-toplevel',
      ])
    ).stdout.trim();
    if (
      !repoRoot ||
      canonicalizePath(repoRoot) !== canonicalizePath(metadata.repoPath)
    ) {
      throw new Error('Invalid worktree cleanup repository');
    }
    const expectedPath = canonicalizePath(metadata.path);
    const branchSuffix = metadata.branch.split('/').at(-1);
    if (!branchSuffix || basename(expectedPath) !== branchSuffix) {
      throw new Error('Invalid worktree cleanup path shape');
    }
    assertWorktreePathPolicy({
      repoRoot,
      worktreeBaseDir: dirname(expectedPath),
      worktreePath: expectedPath,
    });
    const registered = await this.git.run([
      '-C',
      repoRoot,
      'worktree',
      'list',
      '--porcelain',
    ]);
    const entries = parseWorktreeList(registered.stdout);
    if (
      !entries.some(
        (entry) =>
          entry.path === expectedPath && entry.branch === metadata.branch,
      )
    ) {
      throw new Error(
        'Worktree cleanup target is not registered to its session branch',
      );
    }
  }

  private async createWorktree(
    request: WorktreeProvisionRequest & {
      isolation: WorkspaceIsolationConfig & { mode: 'worktree' };
    },
  ): Promise<WorktreeSessionMetadata> {
    const policy = validateWorktreePolicy(request.isolation.policy);
    const repoRootResult = await this.git.run([
      '-C',
      request.repoPath,
      'rev-parse',
      '--show-toplevel',
    ]);
    const repoRoot = repoRootResult.stdout.trim();
    if (!repoRoot) {
      throw new Error(`Git repository root not found for ${request.repoPath}`);
    }

    const status = await this.git.run([
      '-C',
      repoRoot,
      'status',
      '--porcelain',
    ]);
    if (status.stdout.trim()) {
      worktreeConflictPreventedTotal.add(1, {
        detection_source: 'dirty_repo',
      });
      throw new Error(
        'Cannot provision isolated worktree from a dirty repository',
      );
    }

    const branch = buildWorktreeBranchName({
      threadId: request.threadId,
      branchPrefix: policy.branchPrefix,
    });
    const branchExists = await this.git.run(
      [
        '-C',
        repoRoot,
        'rev-parse',
        '--verify',
        '--quiet',
        `refs/heads/${branch}`,
      ],
      { allowCodes: [0, 1] },
    );
    if (branchExists.code === 0) {
      worktreeConflictPreventedTotal.add(1, {
        detection_source: 'branch_exists',
      });
      throw new Error(`Worktree branch already exists: ${branch}`);
    }

    const worktreeBaseDir = resolveWorktreeBaseDir(
      repoRoot,
      policy.worktreeBaseDir,
    );
    const worktreePath = join(
      worktreeBaseDir,
      worktreeSessionSegment(request.threadId),
    );
    assertWorktreePathPolicy({ repoRoot, worktreeBaseDir, worktreePath });
    if (existsSync(worktreePath)) {
      worktreeConflictPreventedTotal.add(1, {
        detection_source: 'path_exists',
      });
      throw new Error(`Worktree path already exists: ${worktreePath}`);
    }

    await mkdir(worktreeBaseDir, { recursive: true });
    try {
      await this.git.run([
        '-C',
        repoRoot,
        'worktree',
        'add',
        '-b',
        branch,
        worktreePath,
        policy.baseRef,
      ]);
    } catch (error) {
      await rm(worktreePath, { recursive: true, force: true });
      throw error;
    }

    return {
      mode: 'worktree',
      repoPath: repoRoot,
      path: worktreePath,
      branch,
      baseRef: policy.baseRef,
      cleanupPolicy: policy.cleanupPolicy,
      preserveOnFailure: policy.preserveOnFailure,
      createdAt: new Date().toISOString(),
    };
  }
}

function parseWorktreeList(
  output: string,
): Array<{ path: string; branch?: string }> {
  const entries: Array<{ path: string; branch?: string }> = [];
  for (const block of output.trim().split('\n\n').filter(Boolean)) {
    const values = new Map(
      block.split('\n').map((line) => {
        const [key, ...rest] = line.split(' ');
        return [key, rest.join(' ')];
      }),
    );
    const path = values.get('worktree');
    const branch = values.get('branch')?.replace(/^refs\/heads\//, '');
    if (path) entries.push({ path: canonicalizePath(path), branch });
  }
  return entries;
}

function errorReason(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown';
  if (error.message.includes('dirty repository')) return 'dirty_repo';
  if (error.message.includes('already exists')) return 'conflict';
  if (error.message.includes('Invalid worktree')) return 'policy_invalid';
  return 'git_error';
}
