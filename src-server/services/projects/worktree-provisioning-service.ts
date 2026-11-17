import { createHash } from 'node:crypto';
import { existsSync, lstatSync, realpathSync, type Stats } from 'node:fs';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import type { EngineId } from '@kontourai/station-contracts/provider';
import {
  isSessionLifecycleState,
  sessionLifecycleOutcome,
} from '@kontourai/station-contracts/session-lifecycle';
import type {
  WorkspaceIsolationConfig,
  WorktreeCleanupPolicy,
  WorktreeIsolationPolicy,
  WorktreeSessionMetadata,
  WorktreeTaskOwner,
} from '@kontourai/station-contracts/workspace-isolation';
import {
  worktreeCleanupTotal,
  worktreeConflictPreventedTotal,
  worktreeProvisionDuration,
  worktreeProvisionTotal,
} from '../../telemetry/metrics.js';
import { spawnGit } from '../../utils/git-exec.js';
import { createKeyedSerialQueue } from '../../utils/keyed-serial-queue.js';
import { expandTilde } from '../../utils/paths.js';
import {
  type LiveRepository,
  RepositoryConfigRefusedError,
  requireLiveRepository,
} from './git-read-repository.js';

export type WorktreeTerminalState = 'completed' | 'failed' | 'cancelled';

export interface WorktreeProvisionRequest {
  repoPath: string;
  threadId: string;
  providerKind: EngineId;
  isolation?: WorkspaceIsolationConfig;
}

/** #4507: provisioning a Task-owned worktree, one per Task. */
export interface TaskWorktreeProvisionRequest {
  repoPath: string;
  taskId: string;
  providerKind: EngineId;
  isolation: WorkspaceIsolationConfig & { mode: 'worktree' };
  /** The worktree the Task already records, if any. */
  recorded?: WorktreeSessionMetadata;
}

export interface TaskWorktreeProvisionResult {
  metadata: WorktreeSessionMetadata;
  /**
   * `reused`: the Task's recorded worktree, verified. `adopted`: a worktree
   * at this Task's own path and branch that git has registered but the Task
   * did not record yet (an earlier provisioning finished after its record
   * could be written, or Station stopped in between). `created`: new.
   */
  provenance: 'reused' | 'adopted' | 'created';
}

/**
 * #4507: why a refused config keeps a Task worktree. A refused include
 * (`include.path`, `includeIf.*.path`) is reported when the configuration
 * it pulls in from another file is refused; every other refused key names
 * a program git would run.
 */
function unsafeConfigDetail(keys: readonly string[]): string {
  if (keys.length === 0)
    return "The repository's config could not be read; the worktree was not touched.";
  const includes = keys.filter((key) => /^include(if\..+)?\.path$/i.test(key));
  const programs = keys.filter((key) => !includes.includes(key));
  const parts = [
    ...(programs.length > 0
      ? [`sets ${programs.join(', ')}, which git would run`]
      : []),
    ...(includes.length > 0
      ? [
          `pulls in configuration from another file (${includes.join(', ')}) that Station refuses to run git with`,
        ]
      : []),
  ];
  return `The repository's own config ${parts.join(' and ')}; the worktree was not touched.`;
}

const FULL_COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * #4771: what is at a Session worktree's recorded place before any git
 * command touches it. `git worktree remove` deletes through a symlink, so a
 * path that is not a plain directory holding a linked worktree's `.git`
 * file is never handed to git.
 */
type SessionWorktreeShape =
  | 'directory'
  | 'missing'
  | 'not-a-directory'
  | 'replaced'
  | 'repository-missing';

type SessionWorktreeShapeRefusal = Exclude<
  SessionWorktreeShape,
  'directory' | 'missing'
>;

const SHAPE_DETAIL: Record<SessionWorktreeShapeRefusal, string> = {
  'not-a-directory':
    "The Session's worktree path is a symlink or not a directory; nothing was touched.",
  replaced:
    "The Session's worktree path now holds something other than its worktree; nothing was touched.",
  'repository-missing':
    "The Session's repository is no longer at its recorded path; nothing was touched.",
};

/** #4771: a Session worktree's state, read for a settlement. */
export type SessionWorktreeInspection =
  | {
      kind: 'present';
      head: string;
      dirty: boolean;
      /** Another checkout has the Session's branch checked out. */
      checkedOutElsewhere: boolean;
    }
  /** Not in place: its folder, its registration or its branch is gone. */
  | { kind: 'missing' }
  | {
      kind: 'refused';
      reason: 'unsafe-config' | SessionWorktreeShapeRefusal;
      detail: string;
    };

/** #4771: what discarding a Session's worktree did, or why it did nothing. */
export type SessionWorktreeDiscard =
  | {
      kind: 'discarded';
      removedWorktree: boolean;
      removedBranch: boolean;
      /** Why the branch was kept, when it was. */
      branchKept?: 'moved' | 'checked-out-elsewhere';
      hadUncommittedChanges: boolean;
      /** Ignored entries removed with the worktree (none when it was gone). */
      ignoredEntries: number;
    }
  /** A refusal happens before anything is removed. */
  | {
      kind: 'refused';
      reason:
        | 'uncommitted-changes'
        | 'branch-moved'
        | 'branch-checked-out-elsewhere'
        | 'unsafe-config'
        | SessionWorktreeShapeRefusal;
      detail: string;
    };

function lstatOrMissing(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** #4771: why a discard keeps the Session's branch, or `undefined`. */
function branchKeptReason(
  tip: string,
  expectedHead: string,
  checkouts: { elsewhere: boolean },
): 'moved' | 'checked-out-elsewhere' | undefined {
  if (tip !== expectedHead) return 'moved';
  return checkouts.elsewhere ? 'checked-out-elsewhere' : undefined;
}

function discardRefusal(
  kept: 'moved' | 'checked-out-elsewhere',
  branch: string,
): Extract<SessionWorktreeDiscard, { kind: 'refused' }> {
  return kept === 'moved'
    ? {
        kind: 'refused',
        reason: 'branch-moved',
        detail: `Branch ${branch} moved since its head was recorded.`,
      }
    : {
        kind: 'refused',
        reason: 'branch-checked-out-elsewhere',
        detail: `Branch ${branch} is checked out in another checkout; nothing was removed.`,
      };
}

const UNCOMMITTED_REFUSAL = {
  kind: 'refused',
  reason: 'uncommitted-changes',
  detail: 'The worktree has uncommitted or untracked changes.',
} as const;

/** #4507: what finalizing a Task-owned worktree did. */
export type TaskWorktreeFinalization =
  | { outcome: 'removed' | 'missing' }
  | {
      outcome: 'kept';
      reason:
        | 'policy'
        | 'uncommitted'
        | 'unpushed'
        | 'session-running'
        | 'unsafe-config'
        | 'failed';
      detail?: string;
    };

interface WorktreeCleanupRequest {
  metadata: WorktreeSessionMetadata;
  terminalState: WorktreeTerminalState;
  /** Required by lifecycle cleanup; binds hostile metadata to its owner. */
  sessionId?: string;
}

type GitCommandResult = {
  stdout: string;
  stderr: string;
  code: number;
};

export interface GitCommandRunner {
  run(
    args: string[],
    options?: {
      cwd?: string;
      allowCodes?: number[];
      env?: NodeJS.ProcessEnv;
      /** Stop the command when it runs longer than this. */
      timeoutMs?: number;
    },
  ): Promise<GitCommandResult>;
}

/**
 * #4507: how long one git command (or opening a repository) may take before
 * provisioning, adoption or finalization gives up on it. Generous, since a
 * first checkout of a large repository is slow; its purpose is that a hung
 * command cannot hold a Task's or a repository's queue forever.
 */
const DEFAULT_GIT_COMMAND_TIMEOUT_MS = 300_000;

const GIT_SUBCOMMANDS = new Set([
  'branch',
  'rev-list',
  'rev-parse',
  'status',
  'worktree',
]);

/** The subcommand a git argument list runs, for messages (never its paths). */
function gitSubcommand(args: readonly string[]): string {
  return args.find((arg) => GIT_SUBCOMMANDS.has(arg)) ?? 'command';
}

class GitCommandTimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label} did not finish within ${timeoutMs} ms`);
    this.name = 'GitCommandTimeoutError';
  }
}

/**
 * Settles with `pending`, or rejects once `timeoutMs` passes. A value that
 * arrives after the deadline is handed to `onLate` (to release it).
 */
function withinDeadline<T>(
  pending: Promise<T>,
  timeoutMs: number,
  label: string,
  onLate?: (value: T) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      reject(new GitCommandTimeoutError(label, timeoutMs));
    }, timeoutMs);
    timer.unref?.();
    pending.then(
      (value) => {
        clearTimeout(timer);
        if (expired) onLate?.(value);
        else resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        if (!expired) reject(error);
      },
    );
  });
}

const DEFAULT_BRANCH_PREFIX = 'station/session';
/** #4507: a Task-owned worktree's branch prefix unless the policy names one. */
const DEFAULT_TASK_BRANCH_PREFIX = 'station/task';

/**
 * #4507: the identity a Task-owned worktree's path and branch are derived
 * from. Prefixed so it can never equal a Session thread id's segment.
 */
function taskWorktreeOwnerKey(taskId: string): string {
  return `task-${taskId}`;
}
const DEFAULT_BASE_REF = 'HEAD';

function shouldUseWorktreeIsolation(
  isolation?: WorkspaceIsolationConfig,
): isolation is WorkspaceIsolationConfig & { mode: 'worktree' } {
  return isolation?.mode === 'worktree';
}

function validateWorktreePolicy(policy: WorktreeIsolationPolicy = {}) {
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

function buildWorktreeBranchName(input: {
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
  // #4507: a Task-owned worktree belongs to no Session, so no Session's exit
  // or continuation may claim it through this check.
  if (metadata.owner !== undefined)
    throw new Error('Worktree cleanup metadata is not bound to its session');
  assertWorktreeNameBinding(metadata, threadId);
}

/**
 * #4507: where a Task's worktree is made when no policy names a base
 * directory, which Task dispatch never does: beside the repository, named
 * for the Task.
 */
export function defaultTaskWorktreePath(repoRoot: string, taskId: string) {
  return join(
    defaultWorktreeBaseDir(repoRoot),
    worktreeSessionSegment(taskWorktreeOwnerKey(taskId)),
  );
}

/** #4507: prove hostile persisted metadata belongs to exactly this Task. */
function assertWorktreeMetadataTaskBinding(
  metadata: WorktreeSessionMetadata,
  taskId: string,
): void {
  if (
    !taskId ||
    metadata.owner?.kind !== 'task' ||
    metadata.owner.taskId !== taskId
  )
    throw new Error('Worktree metadata is not bound to its Task');
  assertWorktreeNameBinding(metadata, taskWorktreeOwnerKey(taskId));
}

function assertWorktreeNameBinding(
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

/**
 * The worktree a Session's exit finalizes: the one its own `session.started`
 * record names and that Session owns. #4507: a Task-owned worktree outlives
 * its Sessions and is finalized when the Task finishes, so none is returned
 * for it.
 */
export function sessionExitWorktreeMetadata(
  events: unknown[],
  sessionId: string,
): WorktreeSessionMetadata | undefined {
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    const sessionStart = event as {
      method?: unknown;
      sessionId?: unknown;
      metadata?: unknown;
    };
    if (
      sessionStart.method !== 'session.started' ||
      sessionStart.sessionId !== sessionId
    ) {
      continue;
    }
    const metadata = sessionStart.metadata;
    if (!metadata || typeof metadata !== 'object') continue;
    const worktree = (metadata as Record<string, unknown>).worktree;
    if (!worktree || typeof worktree !== 'object') continue;
    const candidate = worktree as Partial<WorktreeSessionMetadata>;
    if (candidate.owner !== undefined) return undefined;
    if (
      candidate.mode === 'worktree' &&
      typeof candidate.repoPath === 'string' &&
      typeof candidate.path === 'string' &&
      typeof candidate.branch === 'string' &&
      typeof candidate.baseRef === 'string' &&
      (candidate.cleanupPolicy === 'cleanup' ||
        candidate.cleanupPolicy === 'preserve') &&
      typeof candidate.preserveOnFailure === 'boolean' &&
      typeof candidate.createdAt === 'string'
    ) {
      assertWorktreeMetadataSessionBinding(
        candidate as WorktreeSessionMetadata,
        sessionId,
      );
      return candidate as WorktreeSessionMetadata;
    }
  }
  return undefined;
}

/** Preserve on any non-clean exit even if lifecycle projection says canceled. */
export function terminalWorktreeStateForExit(input: {
  lifecycleState: unknown;
  exitCode?: number;
  events: unknown[];
}): WorktreeTerminalState {
  const outcome = isSessionLifecycleState(input.lifecycleState)
    ? sessionLifecycleOutcome(input.lifecycleState)
    : undefined;
  // A clean terminal completion proves recovery succeeded even when its event
  // history contains an earlier runtime error.
  if (outcome === 'completed' && input.exitCode === 0) {
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
  if (outcome) return outcome;
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
  // archive#3155 shipped for knowledge namespaces, and archive#3147 for file
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
    expandTilde(policyBaseDir ?? defaultWorktreeBaseDir(repoRoot)),
  );
}

/**
 * Where Station puts a repository's session worktrees unless a policy says
 * otherwise: a `<repo>-worktrees` folder beside it.
 */
function defaultWorktreeBaseDir(repoRoot: string): string {
  return join(dirname(repoRoot), `${basename(repoRoot)}-worktrees`);
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

export function cleanupPolicyForTerminalState(
  metadata: WorktreeSessionMetadata,
  terminalState: WorktreeTerminalState,
): WorktreeCleanupPolicy {
  if (terminalState === 'failed' && metadata.preserveOnFailure) {
    return 'preserve';
  }
  return metadata.cleanupPolicy;
}

export class SpawnGitCommandRunner implements GitCommandRunner {
  async run(
    args: string[],
    options: {
      cwd?: string;
      allowCodes?: number[];
      env?: NodeJS.ProcessEnv;
      timeoutMs?: number;
    } = {},
  ): Promise<GitCommandResult> {
    const allowCodes = options.allowCodes ?? [0];
    return await new Promise((resolve, reject) => {
      const child = spawnGit(args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      // A command past its time is stopped, so it does not outlive the
      // caller that gave up on it.
      const timer =
        options.timeoutMs === undefined
          ? undefined
          : setTimeout(() => child.kill('SIGKILL'), options.timeoutMs);
      timer?.unref?.();
      child.on('close', () => clearTimeout(timer));
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
  /**
   * #4507: Task provisioning runs one at a time per repository in this
   * process. `worktree add` changes the repository's shared state (the first
   * one creates its `worktrees` directory), and creation refuses when the
   * repository changed while it was preparing, so two concurrent creations
   * in one repository would refuse each other.
   */
  private readonly repositoryQueue = createKeyedSerialQueue();
  private readonly git: GitCommandRunner;
  private readonly ownRepository: (
    folder: string,
    projectRoot: string,
    options: { newWorktree?: true },
  ) => Promise<LiveRepository>;

  constructor(
    git: GitCommandRunner = new SpawnGitCommandRunner(),
    /**
     * The repository a Project folder may be provisioned from, opened for
     * the checkout `worktree add` makes (`requireLiveRepository`: its own
     * git directory named, Station's judged copy of its config as the
     * common directory). Replaceable for tests that script the runner.
     */
    ownRepository: (
      folder: string,
      projectRoot: string,
      options: { newWorktree?: true },
    ) => Promise<LiveRepository> = requireLiveRepository,
    /** #4507: see {@link DEFAULT_GIT_COMMAND_TIMEOUT_MS}. */
    options: { commandTimeoutMs?: number } = {},
  ) {
    const timeoutMs =
      options.commandTimeoutMs ?? DEFAULT_GIT_COMMAND_TIMEOUT_MS;
    this.git = {
      run: (args, runOptions) =>
        withinDeadline(
          git.run(args, { ...runOptions, timeoutMs }),
          timeoutMs,
          `git ${gitSubcommand(args)}`,
        ),
    };
    this.ownRepository = (folder, projectRoot, openOptions) =>
      withinDeadline(
        ownRepository(folder, projectRoot, openOptions),
        timeoutMs,
        'Opening the repository',
        (late) => void late.dispose(),
      );
  }

  /** Read-only continuation proof, sharing cleanup's hostile-metadata checks. */
  async assertSessionWorkspace(
    metadata: WorktreeSessionMetadata,
    ownerThreadId: string,
  ): Promise<void> {
    assertWorktreeMetadataSessionBinding(metadata, ownerThreadId);
    await this.assertRegisteredCleanupTarget(metadata);
  }

  /** #4507: read-only proof that a Task's recorded worktree is still its own. */
  async assertTaskWorkspace(
    metadata: WorktreeSessionMetadata,
    taskId: string,
  ): Promise<void> {
    assertWorktreeMetadataTaskBinding(metadata, taskId);
    await this.assertRegisteredCleanupTarget(metadata);
  }

  /**
   * #4507: the one worktree a Task's Sessions run in. Idempotent per Task:
   * the recorded worktree is verified and reused; a registered worktree at
   * the Task's own derived path and branch is adopted; otherwise one is
   * created. Callers serialize calls for one Task and record the result on
   * the Task before anything else can observe it.
   */
  async provisionForTask(
    request: TaskWorktreeProvisionRequest,
  ): Promise<TaskWorktreeProvisionResult> {
    if (request.recorded) {
      assertWorktreeMetadataTaskBinding(request.recorded, request.taskId);
      // A recorded worktree removed by hand, or left behind when its
      // repository moved, is provisioned again (below) rather than leaving
      // the Task undispatchable. One that exists must still be git's own
      // registration on its branch.
      if (existsSync(request.recorded.path)) {
        await this.assertRegisteredCleanupTarget(request.recorded);
        return { metadata: request.recorded, provenance: 'reused' };
      }
    }
    return await this.inRepositoryQueue(request.repoPath, () =>
      this.provisionNewTaskWorktree(request),
    );
  }

  private async provisionNewTaskWorktree(
    request: TaskWorktreeProvisionRequest,
  ): Promise<TaskWorktreeProvisionResult> {
    const owner: WorktreeTaskOwner = { kind: 'task', taskId: request.taskId };
    const ownerKey = taskWorktreeOwnerKey(request.taskId);
    const policy = validateWorktreePolicy({
      ...request.isolation.policy,
      branchPrefix:
        request.isolation.policy?.branchPrefix ?? DEFAULT_TASK_BRANCH_PREFIX,
    });
    const found = await this.registeredTaskWorktree(
      request.repoPath,
      ownerKey,
      owner,
      policy,
    );
    if (found.kind === 'registered')
      return { metadata: found.metadata, provenance: 'adopted' };
    // The Task's own branch outlived its checkout (removed by hand, or the
    // repository moved): forget only this branch's registrations whose
    // folders are gone, then check the branch out again instead of refusing
    // it. Other worktrees' records are never touched, even when their
    // folders are missing (an unmounted volume, a move in progress).
    for (const stale of found.staleElsewhere)
      await this.forgetMissingRegistration(found.commonDir, stale);
    const startedAt = performance.now();
    try {
      const metadata = await this.createWorktree({
        repoPath: request.repoPath,
        ownerKey,
        owner,
        policy,
        reuseOwnBranch: true,
        reuseOwnMissingPath: found.staleOwnPath,
      });
      worktreeProvisionTotal.add(1, {
        outcome: 'success',
        provider_kind: request.providerKind,
        reason: 'created',
      });
      return { metadata, provenance: 'created' };
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

  /**
   * #4507: the repository and the Task's worktree, each opened through the
   * judged-config reader. A refused config is the worktree kept as
   * `unsafe-config`; any other open failure is thrown.
   */
  private async openCheckedForFinalization(
    metadata: WorktreeSessionMetadata,
  ): Promise<
    | { repository: LiveRepository; worktree: LiveRepository }
    | { kept: TaskWorktreeFinalization }
  > {
    const unsafe = (error: RepositoryConfigRefusedError) => ({
      kept: {
        outcome: 'kept' as const,
        reason: 'unsafe-config' as const,
        detail: unsafeConfigDetail(error.keys),
      },
    });
    let repository: LiveRepository;
    try {
      repository = await this.ownRepository(
        metadata.repoPath,
        metadata.repoPath,
        { newWorktree: true },
      );
    } catch (error) {
      if (error instanceof RepositoryConfigRefusedError) return unsafe(error);
      throw error;
    }
    try {
      const worktree = await this.ownRepository(
        metadata.path,
        metadata.path,
        {},
      );
      return { repository, worktree };
    } catch (error) {
      await repository.dispose();
      if (error instanceof RepositoryConfigRefusedError) return unsafe(error);
      throw error;
    }
  }

  /**
   * #4507: forgets git's record of one checkout of a Task's branch whose
   * folder is gone: the admin entry under the common directory whose
   * `gitdir` names exactly that folder, and nothing else.
   */
  private async forgetMissingRegistration(
    common: string,
    folder: string,
  ): Promise<void> {
    if (existsSync(folder)) return;
    const admin = join(common, 'worktrees');
    for (const name of await readdir(admin).catch(() => [] as string[])) {
      let gitdir: string;
      try {
        gitdir = (await readFile(join(admin, name, 'gitdir'), 'utf8')).trim();
      } catch {
        continue;
      }
      // `worktree.useRelativePaths` writes it relative to its admin folder.
      const pointer = isAbsolute(gitdir)
        ? gitdir
        : resolve(join(admin, name), gitdir);
      if (canonicalizePath(dirname(pointer)) !== folder) continue;
      await rm(join(admin, name), { recursive: true, force: true });
    }
  }

  private async inRepositoryQueue<T>(
    repoPath: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.repositoryQueue.run(canonicalizePath(repoPath), operation);
  }

  /**
   * #4507: Task-terminal finalization of a Task-owned worktree. Removal
   * deletes the checkout and its branch, so it happens only when nothing
   * would be lost: the policy allows it, no Session in the worktree has a
   * running turn, the checkout has no uncommitted or untracked change, and
   * the branch has no commit that only it holds (none that a remote-tracking
   * ref or another local branch does not also reach). A squash merge leaves
   * the branch's own commits off the base branch, so "merged" is not the
   * test; being on a remote is. Anything else keeps the worktree and branch
   * and says why.
   */
  async finalizeForTask(request: {
    metadata: WorktreeSessionMetadata;
    taskId: string;
    terminalState: WorktreeTerminalState;
    /** Whether a Session in this directory has a running turn. */
    isWorkspaceBusy?: (path: string) => boolean;
  }): Promise<TaskWorktreeFinalization> {
    const { metadata } = request;
    assertWorktreeMetadataTaskBinding(metadata, request.taskId);
    // Gone already (removed by hand, or its repository moved): nothing to
    // remove, and its branch, if any, is left alone.
    if (!existsSync(metadata.path)) return { outcome: 'missing' };
    if (
      cleanupPolicyForTerminalState(metadata, request.terminalState) ===
      'preserve'
    ) {
      await this.preserve({ metadata, terminalState: request.terminalState });
      return { outcome: 'kept', reason: 'policy' };
    }
    if (request.isWorkspaceBusy?.(metadata.path))
      return { outcome: 'kept', reason: 'session-running' };
    await this.assertRegisteredCleanupTarget(metadata);
    // Every git call below runs through Station's judged copy of the
    // repository's config, as creation does (#2411): `status` and a
    // non-forced `worktree remove` run clean filters, and the repository's
    // own config (a member-writable file) may name one. A config that
    // defines such a program keeps the worktree; nothing is run.
    const opened = await this.openCheckedForFinalization(metadata);
    if ('kept' in opened) return opened.kept;
    const { repository, worktree } = opened;
    try {
      const repo = ['-C', repository.top, ...repository.repoArgs];
      const env = repository.env;
      const changes = await this.git.run(
        [
          '-C',
          worktree.top,
          ...worktree.repoArgs,
          'status',
          '--porcelain',
          '--untracked-files=all',
        ],
        { env: worktree.env },
      );
      if (changes.stdout.trim())
        return {
          outcome: 'kept',
          reason: 'uncommitted',
          detail: 'The worktree has uncommitted or untracked changes.',
        };
      const branchRef = `refs/heads/${metadata.branch}`;
      // The tip checked here is the only one the branch may be deleted at.
      const tip = (
        await this.git.run(
          [
            ...repo,
            'rev-parse',
            '--verify',
            '--end-of-options',
            `${branchRef}^{commit}`,
          ],
          { env },
        )
      ).stdout.trim();
      // The Task's branch must be a branch, not a symbolic ref to another
      // one (something in the worktree can repoint it at `main`): every
      // check below would then judge, and the deletion reach, that other
      // branch.
      const symbolic = await this.git.run(
        [...repo, 'symbolic-ref', '-q', branchRef],
        { allowCodes: [0, 1, 128], env },
      );
      if (symbolic.code === 0)
        return {
          outcome: 'kept',
          reason: 'failed',
          detail: `Branch ${metadata.branch} is a symbolic ref to ${symbolic.stdout.trim()}; nothing was removed.`,
        };
      const unique = await this.git.run(
        [
          ...repo,
          'rev-list',
          '--max-count=1',
          tip,
          '--not',
          '--remotes',
          // `--exclude` patterns for `--branches` are branch names without
          // `refs/heads/`; a prefixed one excludes nothing, and the Task's
          // own branch would then count as another branch reaching its
          // commits.
          `--exclude=${metadata.branch}`,
          '--branches',
        ],
        { env },
      );
      if (unique.stdout.trim())
        return {
          outcome: 'kept',
          reason: 'unpushed',
          detail: `Branch ${metadata.branch} has commits no remote or other branch has.`,
        };
      // Without `--force`, so git itself refuses a worktree that gained a
      // change after the checks above (a turn starting, a terminal write):
      // the change is kept, never deleted.
      const removed = await this.git.run(
        [...repo, 'worktree', 'remove', metadata.path],
        { allowCodes: [0, 128], env },
      );
      if (removed.code !== 0) {
        if (/modified or untracked files/.test(removed.stderr))
          return {
            outcome: 'kept',
            reason: 'uncommitted',
            detail: 'The worktree gained changes while it was being finalized.',
          };
        throw new Error(
          `git worktree remove failed: ${removed.stderr.trim() || removed.stdout.trim()}`,
        );
      }
      // Deleted only if the branch still points at the tip that was
      // checked: a commit made since moves it, and git refuses. Run against
      // the repository's real git directory, never the judged copy: where
      // links need privilege the copy's `packed-refs` is a copy, and a
      // deletion there would rewrite only the copy while the branch lived
      // on. `update-ref` runs no filters; the only program it can start is
      // the `reference-transaction` hook, and the git runner already sets
      // `core.hooksPath` to the null device for every call (`spawnGit`), so
      // no hook runs. Nothing here may set `core.hooksPath` again: a later
      // `-c` would win over the runner's.
      const real = ['--git-dir', repository.commonDir];
      const deleted = await this.git.run(
        // `--no-deref`: a branch repointed after the check above is deleted
        // itself, never the branch it points to.
        [...real, 'update-ref', '--no-deref', '-d', branchRef, tip],
        { allowCodes: [0, 1, 128] },
      );
      if (deleted.code !== 0) {
        // Only "is at <new> but expected <tip>" means the branch moved; a
        // stale lock, an unknown repository extension or an ownership
        // refusal is a failure to delete, not new work.
        const moved = /but expected/.test(deleted.stderr);
        return {
          outcome: 'kept',
          reason: moved ? 'unpushed' : 'failed',
          detail: moved
            ? `The worktree was removed; branch ${metadata.branch} moved while it was being finalized and is kept.`
            : `The worktree was removed; branch ${metadata.branch} could not be deleted: ${deleted.stderr.trim() || `git exited ${deleted.code}`}`,
        };
      }
      // Never report a branch removed that still exists.
      const remaining = await this.git.run(
        [...real, 'rev-parse', '--verify', '--quiet', branchRef],
        { allowCodes: [0, 1, 128] },
      );
      if (remaining.code === 128)
        return {
          outcome: 'kept',
          reason: 'failed',
          detail: `The worktree was removed; whether branch ${metadata.branch} is gone could not be confirmed.`,
        };
      if (remaining.code === 0)
        return {
          outcome: 'kept',
          reason: 'failed',
          detail: `The worktree was removed, but branch ${metadata.branch} is still present.`,
        };
    } finally {
      await worktree.dispose();
      await repository.dispose();
    }
    worktreeCleanupTotal.add(1, {
      outcome: 'success',
      policy: 'cleanup',
      terminal_state: request.terminalState,
    });
    return { outcome: 'removed' };
  }

  /**
   * #4771: whether a Session's own worktree is untouched by any removal: its
   * folder is a plain directory holding a linked worktree and git registers
   * it on the Session's branch. Throws for metadata not bound to the Session.
   */
  async isSessionWorktreeIntact(
    metadata: WorktreeSessionMetadata,
    sessionId: string,
  ): Promise<boolean> {
    assertWorktreeMetadataSessionBinding(metadata, sessionId);
    return (
      (await this.sessionWorktreeShape(metadata)) === 'directory' &&
      (await this.cleanupTargetRegistered(metadata))
    );
  }

  /**
   * #4771: the facts a settlement of a Session's worktree is judged on: the
   * branch's head commit, whether the checkout has uncommitted or untracked
   * changes, and whether another checkout has the branch. `status` runs
   * through Station's judged copy of the repository's config, as
   * finalization does (#2411).
   */
  async inspectSessionWorktree(
    metadata: WorktreeSessionMetadata,
    sessionId: string,
  ): Promise<SessionWorktreeInspection> {
    assertWorktreeMetadataSessionBinding(metadata, sessionId);
    const shape = await this.sessionWorktreeShape(metadata);
    if (shape === 'missing') return { kind: 'missing' };
    if (shape !== 'directory')
      return { kind: 'refused', reason: shape, detail: SHAPE_DETAIL[shape] };
    const checkouts = await this.branchCheckouts(metadata);
    if (!checkouts.registered) return { kind: 'missing' };
    const opened = await this.openCheckedForFinalization(metadata);
    if ('kept' in opened)
      return {
        kind: 'refused',
        reason: 'unsafe-config',
        detail: ('detail' in opened.kept && opened.kept.detail) || '',
      };
    const { repository, worktree } = opened;
    try {
      const head = await this.ownBranchTip(repository, metadata.branch);
      if (head.kind === 'missing') return head;
      if (head.kind === 'unsafe-config')
        return {
          kind: 'refused',
          reason: 'unsafe-config',
          detail: head.detail,
        };
      return {
        kind: 'present',
        head: head.commit,
        dirty: (await this.worktreeStatus(worktree)).dirty,
        checkedOutElsewhere: checkouts.elsewhere,
      };
    } finally {
      await worktree.dispose();
      await repository.dispose();
    }
  }

  /**
   * #4771: the branch `baseRef` names now and whether its tip contains
   * `commit`, read in the worktree's repository. A base must name a local or
   * remote-tracking branch: a branch name is read as `refs/heads/<name>`, so
   * a tag of the same name cannot stand in for it; any spelling of `HEAD` is
   * the branch it has checked out, and detached when it has none. A tag or a
   * commit id names no branch to keep onto. Replacement objects are ignored,
   * so a replace ref cannot make an unrelated commit look contained.
   */
  async baseContainment(
    metadata: WorktreeSessionMetadata,
    commit: string,
  ): Promise<
    | {
        kind: 'contained' | 'not-contained';
        baseTip: string;
        baseBranch: string;
      }
    | { kind: 'unresolvable' }
    | { kind: 'detached' }
  > {
    const repo = ['-C', metadata.repoPath];
    const env = { GIT_NO_REPLACE_OBJECTS: '1' };
    const base = await this.resolveBaseBranch(metadata);
    if (base.kind !== 'branch') return base;
    const ancestor = await this.git.run(
      [...repo, 'merge-base', '--is-ancestor', commit, base.tip],
      { allowCodes: [0, 1], env },
    );
    return {
      kind: ancestor.code === 0 ? 'contained' : 'not-contained',
      baseTip: base.tip,
      baseBranch: base.name,
    };
  }

  /** #4771: see {@link baseContainment}. */
  private async resolveBaseBranch(
    metadata: WorktreeSessionMetadata,
  ): Promise<
    | { kind: 'branch'; name: string; tip: string }
    | { kind: 'unresolvable' }
    | { kind: 'detached' }
  > {
    const ref = metadata.baseRef;
    const named = ref.startsWith('refs/')
      ? undefined
      : await this.refTip(metadata, `refs/heads/${ref}`);
    if (named) return { kind: 'branch', name: ref, tip: named };
    const fullName = ref.startsWith('refs/')
      ? ref
      : await this.symbolicFullName(metadata, ref);
    const branch = /^refs\/(?:heads|remotes)\/(.+)$/.exec(fullName)?.[1];
    if (branch) {
      const tip = await this.refTip(metadata, fullName);
      return tip
        ? { kind: 'branch', name: branch, tip }
        : { kind: 'unresolvable' };
    }
    // `HEAD`, `@` or (on a case-insensitive filesystem) `head` while the
    // checkout is detached all print as `HEAD` in some case. Any other name
    // that is not a full ref (`ORIG_HEAD`, `FETCH_HEAD`) is not a checkout,
    // so it is unresolvable rather than detached.
    return fullName.toUpperCase() === 'HEAD'
      ? { kind: 'detached' }
      : { kind: 'unresolvable' };
  }

  private async symbolicFullName(
    metadata: WorktreeSessionMetadata,
    ref: string,
  ): Promise<string> {
    const named = await this.git.run(
      [
        '-C',
        metadata.repoPath,
        'rev-parse',
        '--symbolic-full-name',
        '--end-of-options',
        ref,
      ],
      { allowCodes: [0, 128], env: { GIT_NO_REPLACE_OBJECTS: '1' } },
    );
    // `--end-of-options` is echoed on its own line before the name.
    return named.code === 0
      ? (named.stdout.trim().split('\n').at(-1) ?? '').replace(
          /^--end-of-options$/,
          '',
        )
      : '';
  }

  /** The commit a full ref name points at, or `undefined`. */
  private async refTip(
    metadata: WorktreeSessionMetadata,
    fullName: string,
  ): Promise<string | undefined> {
    const tip = await this.git.run(
      [
        '-C',
        metadata.repoPath,
        'rev-parse',
        '--verify',
        '--quiet',
        '--end-of-options',
        `${fullName}^{commit}`,
      ],
      { allowCodes: [0, 1, 128], env: { GIT_NO_REPLACE_OBJECTS: '1' } },
    );
    const commit = tip.stdout.trim();
    return tip.code === 0 && FULL_COMMIT.test(commit) ? commit : undefined;
  }

  /**
   * #4771: removes exactly the worktree and branch Station created for this
   * Session, and nothing else. Converges: a worktree or branch already gone
   * is not an error. The branch is deleted only at `expectedHead`, the head
   * the decision was made on, and only while no other checkout has it; any
   * refusal happens before anything is removed. Once an earlier attempt
   * removed the worktree, a branch that moved or is checked out elsewhere is
   * kept and the result says why.
   */
  async discardSessionWorktree(request: {
    metadata: WorktreeSessionMetadata;
    sessionId: string;
    expectedHead: string;
    acceptUncommittedLoss: boolean;
  }): Promise<SessionWorktreeDiscard> {
    const { metadata } = request;
    assertWorktreeMetadataSessionBinding(metadata, request.sessionId);
    const shape = await this.sessionWorktreeShape(metadata);
    if (shape !== 'directory' && shape !== 'missing')
      return { kind: 'refused', reason: shape, detail: SHAPE_DETAIL[shape] };
    const checkouts = await this.branchCheckouts(metadata);
    const opened = await this.openOwnRepository(metadata);
    if ('refused' in opened) return opened.refused;
    const repository = opened.repository;
    try {
      const tip = await this.ownBranchTip(repository, metadata.branch);
      if (tip.kind === 'unsafe-config')
        return { kind: 'refused', reason: 'unsafe-config', detail: tip.detail };
      const kept =
        tip.kind === 'tip'
          ? branchKeptReason(tip.commit, request.expectedHead, checkouts)
          : undefined;
      // Nothing removed yet: refuse rather than leave a half discard.
      if (kept && checkouts.registered && shape === 'directory')
        return discardRefusal(kept, metadata.branch);
      let removed = { hadUncommittedChanges: false, ignoredEntries: 0 };
      if (checkouts.registered) {
        const result = await this.removeOwnWorktree(
          repository,
          metadata,
          request.acceptUncommittedLoss,
        );
        if (result.kind === 'refused') return result;
        removed = result;
      }
      const branch =
        tip.kind === 'tip' && !kept
          ? await this.deleteOwnBranch(repository, metadata.branch, tip.commit)
          : { removed: false, ...(kept ? { kept } : {}) };
      return {
        kind: 'discarded',
        removedWorktree: checkouts.registered,
        removedBranch: branch.removed,
        ...('kept' in branch && branch.kept ? { branchKept: branch.kept } : {}),
        ...removed,
      };
    } finally {
      await repository.dispose();
    }
  }

  /**
   * #4771: why Session-exit cleanup must not hand this worktree path to git
   * (a symlink, a non-directory or another repository), or `undefined`.
   * `worktree remove --force` would delete through it.
   */
  async sessionWorktreeRemovalProblem(
    metadata: WorktreeSessionMetadata,
  ): Promise<string | undefined> {
    const shape = await this.sessionWorktreeShape(metadata);
    return shape === 'not-a-directory' || shape === 'replaced'
      ? SHAPE_DETAIL[shape]
      : undefined;
  }

  /** #4771: the shape check; see {@link SessionWorktreeShape}. */
  private async sessionWorktreeShape(
    metadata: WorktreeSessionMetadata,
  ): Promise<SessionWorktreeShape> {
    const top = await this.git.run(
      ['-C', metadata.repoPath, 'rev-parse', '--show-toplevel'],
      { allowCodes: [0, 128] },
    );
    if (
      top.code !== 0 ||
      canonicalizePath(top.stdout.trim()) !==
        canonicalizePath(metadata.repoPath)
    )
      return 'repository-missing';
    const entry = lstatOrMissing(metadata.path);
    if (!entry) return 'missing';
    if (entry.isSymbolicLink() || !entry.isDirectory())
      return 'not-a-directory';
    // A linked worktree has a `.git` file; a directory there is another
    // repository, and none at all is not a worktree git can operate.
    return lstatOrMissing(join(metadata.path, '.git'))?.isFile()
      ? 'directory'
      : 'replaced';
  }

  /** #4771: the repository, opened through the judged-config reader. */
  private async openOwnRepository(
    metadata: WorktreeSessionMetadata,
  ): Promise<
    | { repository: LiveRepository }
    | { refused: Extract<SessionWorktreeDiscard, { kind: 'refused' }> }
  > {
    try {
      return {
        repository: await this.ownRepository(
          metadata.repoPath,
          metadata.repoPath,
          { newWorktree: true },
        ),
      };
    } catch (error) {
      if (!(error instanceof RepositoryConfigRefusedError)) throw error;
      return {
        refused: {
          kind: 'refused',
          reason: 'unsafe-config',
          detail: unsafeConfigDetail(error.keys),
        },
      };
    }
  }

  /** #4771: the branch's tip, refusing a branch that is a symbolic ref. */
  private async ownBranchTip(
    repository: LiveRepository,
    branch: string,
  ): Promise<
    | { kind: 'tip'; commit: string }
    | { kind: 'missing' }
    | { kind: 'unsafe-config'; detail: string }
  > {
    const repo = ['-C', repository.top, ...repository.repoArgs];
    const env = repository.env;
    const ref = `refs/heads/${branch}`;
    // A symbolic ref would make every check below, and the deletion, reach
    // the branch it points to (see `finalizeForTask`).
    const symbolic = await this.git.run([...repo, 'symbolic-ref', '-q', ref], {
      allowCodes: [0, 1, 128],
      env,
    });
    if (symbolic.code === 0)
      return {
        kind: 'unsafe-config',
        detail: `Branch ${branch} is a symbolic ref to ${symbolic.stdout.trim()}.`,
      };
    const tip = await this.git.run(
      [...repo, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`],
      { allowCodes: [0, 1, 128], env },
    );
    const commit = tip.stdout.trim();
    return tip.code === 0 && FULL_COMMIT.test(commit)
      ? { kind: 'tip', commit }
      : { kind: 'missing' };
  }

  /**
   * #4771: whether the checkout has uncommitted or untracked changes, and how
   * many ignored entries it holds. Ignored files are reported, not treated
   * as changes: build output would otherwise make every discard need
   * `acceptUncommittedLoss`.
   */
  private async worktreeStatus(
    worktree: LiveRepository,
  ): Promise<{ dirty: boolean; ignoredEntries: number }> {
    const changes = await this.git.run(
      [
        '-C',
        worktree.top,
        ...worktree.repoArgs,
        'status',
        '--porcelain',
        '--untracked-files=all',
        '--ignored=traditional',
      ],
      { env: worktree.env },
    );
    const lines = changes.stdout.split('\n').filter(Boolean);
    const ignoredEntries = lines.filter((line) =>
      line.startsWith('!! '),
    ).length;
    return { dirty: lines.length > ignoredEntries, ignoredEntries };
  }

  /**
   * #4771: `worktree remove`, forced only when the request accepted losing
   * uncommitted changes. A registration whose folder is already gone is
   * pruned by the same command.
   */
  private async removeOwnWorktree(
    repository: LiveRepository,
    metadata: WorktreeSessionMetadata,
    acceptUncommittedLoss: boolean,
  ): Promise<
    | {
        kind: 'removed';
        hadUncommittedChanges: boolean;
        ignoredEntries: number;
      }
    | Extract<SessionWorktreeDiscard, { kind: 'refused' }>
  > {
    let status = { dirty: false, ignoredEntries: 0 };
    if (existsSync(metadata.path)) {
      let worktree: LiveRepository;
      try {
        worktree = await this.ownRepository(metadata.path, metadata.path, {});
      } catch (error) {
        if (error instanceof RepositoryConfigRefusedError)
          return {
            kind: 'refused',
            reason: 'unsafe-config',
            detail: unsafeConfigDetail(error.keys),
          };
        throw error;
      }
      try {
        status = await this.worktreeStatus(worktree);
      } finally {
        await worktree.dispose();
      }
      if (status.dirty && !acceptUncommittedLoss) return UNCOMMITTED_REFUSAL;
    }
    const removed = await this.git.run(
      [
        '-C',
        repository.top,
        ...repository.repoArgs,
        'worktree',
        'remove',
        ...(acceptUncommittedLoss ? ['--force'] : []),
        metadata.path,
      ],
      { allowCodes: [0, 128], env: repository.env },
    );
    if (removed.code === 0)
      return {
        kind: 'removed',
        hadUncommittedChanges: status.dirty,
        ignoredEntries: status.ignoredEntries,
      };
    // Without `--force`, git itself refuses a worktree that gained a change
    // after the check above; the change is kept.
    if (/modified or untracked files/.test(removed.stderr))
      return UNCOMMITTED_REFUSAL;
    throw new Error(
      `git worktree remove failed: ${removed.stderr.trim() || removed.stdout.trim()}`,
    );
  }

  /**
   * #4771: deletes the branch only while it still points at `tip`, against
   * the repository's real git directory (see `finalizeForTask`).
   */
  private async deleteOwnBranch(
    repository: LiveRepository,
    branch: string,
    tip: string,
  ): Promise<{ removed: boolean; kept?: 'moved' }> {
    const deleted = await this.git.run(
      [
        '--git-dir',
        repository.commonDir,
        'update-ref',
        '--no-deref',
        '-d',
        `refs/heads/${branch}`,
        tip,
      ],
      { allowCodes: [0, 1, 128] },
    );
    if (deleted.code === 0) return { removed: true };
    if (/but expected/.test(deleted.stderr))
      return { removed: false, kept: 'moved' };
    throw new Error(
      `git update-ref failed: ${deleted.stderr.trim() || `git exited ${deleted.code}`}`,
    );
  }

  /** #4771: the branch head a Session's cleanup is about to remove, if readable. */
  async readSessionBranchHead(
    metadata: WorktreeSessionMetadata,
  ): Promise<string | undefined> {
    const head = await this.git.run(
      [
        '-C',
        metadata.repoPath,
        'rev-parse',
        '--verify',
        '--quiet',
        `refs/heads/${metadata.branch}^{commit}`,
      ],
      { allowCodes: [0, 1, 128] },
    );
    const commit = head.stdout.trim();
    return head.code === 0 && FULL_COMMIT.test(commit) ? commit : undefined;
  }

  /**
   * #4771: what is left of a Session's worktree and branch, observed now.
   * Nothing here says who removed them; `unknown` when git could not tell.
   */
  async observeSessionWorktree(metadata: WorktreeSessionMetadata): Promise<{
    worktree: 'present' | 'absent' | 'unknown';
    branch: 'present' | 'absent' | 'unknown';
  }> {
    const branch = await this.git.run(
      [
        '-C',
        metadata.repoPath,
        'rev-parse',
        '--verify',
        '--quiet',
        `refs/heads/${metadata.branch}^{commit}`,
      ],
      { allowCodes: [0, 1, 128] },
    );
    let worktree: 'present' | 'absent' | 'unknown';
    try {
      worktree =
        lstatOrMissing(metadata.path) ||
        (await this.cleanupTargetRegistered(metadata))
          ? 'present'
          : 'absent';
    } catch {
      worktree = 'unknown';
    }
    return {
      worktree,
      branch:
        branch.code === 0
          ? 'present'
          : branch.code === 1
            ? 'absent'
            : 'unknown',
    };
  }

  async provision(
    request: WorktreeProvisionRequest,
  ): Promise<WorktreeSessionMetadata | null> {
    if (!shouldUseWorktreeIsolation(request.isolation)) {
      return null;
    }

    const startedAt = performance.now();
    try {
      const metadata = await this.createWorktree({
        repoPath: request.repoPath,
        ownerKey: request.threadId,
        policy: validateWorktreePolicy(request.isolation.policy),
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
    if (!(await this.cleanupTargetRegistered(metadata))) {
      throw new Error(
        'Worktree cleanup target is not registered to its session branch',
      );
    }
  }

  /**
   * Whether git registers this exact path on this exact branch in the
   * metadata's own repository. Throws for metadata whose repository or path
   * shape is not Station's; answers `false` only for "not registered".
   */
  private async cleanupTargetRegistered(
    metadata: WorktreeSessionMetadata,
  ): Promise<boolean> {
    return (await this.branchCheckouts(metadata)).registered;
  }

  /**
   * #4771: where git has the metadata's branch checked out: at its own path
   * (`registered`), and whether at any other path too (`elsewhere`), the
   * repository's main checkout included. Same checks as cleanup.
   */
  private async branchCheckouts(
    metadata: WorktreeSessionMetadata,
  ): Promise<{ registered: boolean; elsewhere: boolean }> {
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
    const onBranch = parseWorktreeList(registered.stdout).filter(
      (entry) => entry.branch === metadata.branch,
    );
    return {
      registered: onBranch.some((entry) => entry.path === expectedPath),
      elsewhere: onBranch.some(
        (entry) => entry.path !== expectedPath && !entry.prunable,
      ),
    };
  }

  /**
   * #4507: the worktree git has registered at this owner's derived path on
   * its derived branch, if any. Only an exact path and branch match counts;
   * anything else at that path is left for creation to refuse.
   */
  private async registeredTaskWorktree(
    repoPath: string,
    ownerKey: string,
    owner: WorktreeTaskOwner,
    policy: ReturnType<typeof validateWorktreePolicy>,
  ): Promise<
    | { kind: 'registered'; metadata: WorktreeSessionMetadata }
    | {
        kind: 'absent';
        repoRoot: string;
        /** The repository's real common git directory (from the checked open). */
        commonDir: string;
        branchExists: boolean;
        /** Git still registers this branch at the derived path, now gone. */
        staleOwnPath: boolean;
        /** Gone folders git still registers this branch at, elsewhere. */
        staleElsewhere: string[];
      }
  > {
    // The folder's own repository, opened the way creation opens it, never
    // one a `.git` file in the Project folder points git at.
    let repository: LiveRepository;
    try {
      repository = await this.ownRepository(repoPath, repoPath, {
        newWorktree: true,
      });
    } catch (error) {
      if (error instanceof RepositoryConfigRefusedError)
        throw new WorktreeRepositoryConfigError(error.keys);
      throw error;
    }
    try {
      const repoRoot = repository.top;
      const repo = ['-C', repoRoot, ...repository.repoArgs];
      const env = repository.env;
      const branch = buildWorktreeBranchName({
        threadId: ownerKey,
        branchPrefix: policy.branchPrefix,
      });
      const branchExists =
        (
          await this.git.run(
            [
              ...repo,
              'rev-parse',
              '--verify',
              '--quiet',
              `refs/heads/${branch}`,
            ],
            { allowCodes: [0, 1], env },
          )
        ).code === 0;
      const worktreeBaseDir = resolveWorktreeBaseDir(
        repoRoot,
        policy.worktreeBaseDir,
      );
      const worktreePath = join(
        worktreeBaseDir,
        worktreeSessionSegment(ownerKey),
      );
      assertWorktreePathPolicy({ repoRoot, worktreeBaseDir, worktreePath });
      const registered = parseWorktreeList(
        (
          await this.git.run([...repo, 'worktree', 'list', '--porcelain'], {
            env,
          })
        ).stdout,
      );
      const expectedPath = canonicalizePath(worktreePath);
      const own = registered.filter((entry) => entry.branch === branch);
      const checkedOutElsewhere = own.some(
        (entry) => entry.path !== expectedPath && existsSync(entry.path),
      );
      const absent = {
        kind: 'absent' as const,
        repoRoot,
        commonDir: repository.commonDir,
        branchExists,
        // Reused only while no existing checkout elsewhere holds the
        // branch; then git refuses the second checkout, as it should.
        staleOwnPath:
          !checkedOutElsewhere &&
          !existsSync(worktreePath) &&
          own.some((entry) => entry.path === expectedPath),
        staleElsewhere: checkedOutElsewhere
          ? []
          : own
              .filter(
                (entry) =>
                  entry.path !== expectedPath && !existsSync(entry.path),
              )
              .map((entry) => entry.path),
      };
      if (
        !existsSync(worktreePath) ||
        !own.some((entry) => entry.path === expectedPath)
      )
        return absent;
      return {
        kind: 'registered',
        metadata: {
          mode: 'worktree',
          repoPath: repoRoot,
          path: worktreePath,
          branch,
          baseRef: policy.baseRef,
          cleanupPolicy: policy.cleanupPolicy,
          preserveOnFailure: policy.preserveOnFailure,
          createdAt: new Date().toISOString(),
          owner,
        },
      };
    } finally {
      await repository.dispose();
    }
  }

  private async createWorktree(request: {
    repoPath: string;
    /** The identity the branch and path are derived from. */
    ownerKey: string;
    owner?: WorktreeTaskOwner;
    policy: ReturnType<typeof validateWorktreePolicy>;
    /**
     * #4507: a Task-owned worktree checks out its own existing branch again
     * instead of refusing it; the branch name is derived from the owner, so
     * an existing one is that owner's.
     */
    reuseOwnBranch?: boolean;
    /**
     * #4507: git still registers the branch at this (gone) path; `add
     * --force` reuses that one registration instead of refusing it.
     */
    reuseOwnMissingPath?: boolean;
  }): Promise<WorktreeSessionMetadata> {
    const policy = request.policy;
    // The Project's folder is member-writable: a `.git` file there can name
    // any repository on this computer, and provisioning would branch and
    // check out whichever one git finds. Only the folder's own repository
    // is provisioned from, and every call below names it (`repo`) rather
    // than letting git discover it again.
    //
    // #2411: `worktree add` checks files out, which runs a smudge filter the
    // repository's own config defines, as the operator (and the `status`
    // just below runs a clean filter). Refused by the rule the coding routes
    // apply before `status`, `diff` and `checkout` (#2363), judged on
    // Station's copy of the config, which is the only config git reads
    // here (`env`).
    let repository: LiveRepository;
    try {
      repository = await this.ownRepository(
        request.repoPath,
        request.repoPath,
        { newWorktree: true },
      );
    } catch (error) {
      if (error instanceof RepositoryConfigRefusedError) {
        throw new WorktreeRepositoryConfigError(error.keys);
      }
      throw error;
    }
    try {
      const repoRoot = repository.top;
      const repo = ['-C', repoRoot, ...repository.repoArgs];
      // A recorded commit must select its own tree, even if replace refs change.
      const env = { ...repository.env, GIT_NO_REPLACE_OBJECTS: '1' };

      const status = await this.git.run([...repo, 'status', '--porcelain'], {
        env,
      });
      if (status.stdout.trim()) {
        worktreeConflictPreventedTotal.add(1, {
          detection_source: 'dirty_repo',
        });
        throw new Error(
          'Cannot provision isolated worktree from a dirty repository',
        );
      }

      const branch = buildWorktreeBranchName({
        threadId: request.ownerKey,
        branchPrefix: policy.branchPrefix,
      });
      const branchExists = await this.git.run(
        [...repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
        { allowCodes: [0, 1], env },
      );
      const reattach = branchExists.code === 0 && request.reuseOwnBranch;
      if (branchExists.code === 0 && !reattach) {
        worktreeConflictPreventedTotal.add(1, {
          detection_source: 'branch_exists',
        });
        throw new Error(`Worktree branch already exists: ${branch}`);
      }

      const baseCommit = (
        await this.git.run(
          [
            ...repo,
            'rev-parse',
            '--verify',
            '--end-of-options',
            `${policy.baseRef}^{commit}`,
          ],
          { env },
        )
      ).stdout.trim();
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(baseCommit)) {
        throw new Error(
          'Cannot resolve the worktree base to a full Git commit',
        );
      }

      const worktreeBaseDir = resolveWorktreeBaseDir(
        repoRoot,
        policy.worktreeBaseDir,
      );
      const worktreePath = join(
        worktreeBaseDir,
        worktreeSessionSegment(request.ownerKey),
      );
      assertWorktreePathPolicy({ repoRoot, worktreeBaseDir, worktreePath });
      if (existsSync(worktreePath)) {
        worktreeConflictPreventedTotal.add(1, {
          detection_source: 'path_exists',
        });
        throw new Error(`Worktree path already exists: ${worktreePath}`);
      }

      await mkdir(worktreeBaseDir, { recursive: true });
      // The checks above took several git calls; what they checked must
      // still be there when the checkout starts.
      if (!(await repository.unchanged())) {
        throw new Error(
          'The repository changed while Station was preparing the worktree',
        );
      }
      try {
        await this.git.run(
          reattach
            ? [
                ...repo,
                'worktree',
                'add',
                ...(request.reuseOwnMissingPath ? ['--force'] : []),
                worktreePath,
                branch,
              ]
            : [
                ...repo,
                'worktree',
                'add',
                '-b',
                branch,
                worktreePath,
                baseCommit,
              ],
          { env },
        );
      } catch (error) {
        await rm(worktreePath, { recursive: true, force: true });
        throw error;
      }
      try {
        await repository.settleCreatedWorktree(worktreePath);
      } catch (error) {
        throw new Error(
          `Created worktree preserved at ${worktreePath}: metadata could not be settled`,
          { cause: error },
        );
      }

      return {
        mode: 'worktree',
        repoPath: repoRoot,
        path: worktreePath,
        branch,
        baseRef: policy.baseRef,
        // A checkout of an existing branch did not start from `baseRef`.
        ...(reattach ? {} : { baseCommit }),
        cleanupPolicy: policy.cleanupPolicy,
        preserveOnFailure: policy.preserveOnFailure,
        createdAt: new Date().toISOString(),
        ...(request.owner ? { owner: request.owner } : {}),
      };
    } finally {
      await repository.dispose();
    }
  }
}

function parseWorktreeList(
  output: string,
): Array<{ path: string; branch?: string; prunable: boolean }> {
  const entries: Array<{ path: string; branch?: string; prunable: boolean }> =
    [];
  for (const block of output.trim().split('\n\n').filter(Boolean)) {
    const values = new Map(
      block.split('\n').map((line) => {
        const [key, ...rest] = line.split(' ');
        return [key, rest.join(' ')];
      }),
    );
    const path = values.get('worktree');
    const branch = values.get('branch')?.replace(/^refs\/heads\//, '');
    // `prunable`: git itself reports the checkout's folder gone. A locked
    // registration is never reported prunable, even with its folder gone.
    if (path)
      entries.push({
        path: canonicalizePath(path),
        branch,
        prunable: values.has('prunable'),
      });
  }
  return entries;
}

/**
 * #2411: provisioning refused because the repository's own config defines a
 * program that checking files out would run. The message is written for the
 * person starting the chat: what was refused, why, and what to do.
 */
export class WorktreeRepositoryConfigError extends Error {
  readonly code = 'repository-config-refused' as const;
  constructor(readonly keys: readonly string[]) {
    super(
      keys.length > 0
        ? `Station did not create an isolated worktree: this repository's own .git/config sets ${keys.join(', ')}, which git would run while checking files out. Remove them, or start the chat without worktree isolation.`
        : "Station did not create an isolated worktree: git could not read this repository's configuration.",
    );
    this.name = 'WorktreeRepositoryConfigError';
  }
}

function errorReason(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown';
  if (error instanceof WorktreeRepositoryConfigError)
    return 'repository_config_refused';
  if (error.message.includes('dirty repository')) return 'dirty_repo';
  if (error.message.includes('already exists')) return 'conflict';
  if (error.message.includes('Invalid worktree')) return 'policy_invalid';
  return 'git_error';
}
