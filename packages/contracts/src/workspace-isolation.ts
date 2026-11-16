export type WorkspaceIsolationMode = 'shared' | 'worktree';

/**
 * The workspace mode a new project chat starts in, resolved once:
 * the project record's own choice, then the Station default
 * (`AppConfig.defaultWorkspaceIsolation`), then `'shared'`.
 *
 * Exported rather than inlined because more than one seam has to reach the
 * SAME answer. The execution-target resolver decides the mode, and the
 * plugin foreground-invocation admission separately re-checks it as a
 * provisioning precondition — if those two disagree, a Station whose default
 * is `worktree` resolves a worktree for a project that names no mode and is
 * then refused admission to provision it. A second reader of a resolution is
 * a second chance to get the resolution wrong; there is one function, and
 * every reader calls it.
 */
export function resolveWorkspaceIsolationMode(
  projectDefault: WorkspaceIsolationMode | undefined,
  stationDefault: WorkspaceIsolationMode | undefined,
): WorkspaceIsolationMode {
  return projectDefault ?? stationDefault ?? 'shared';
}

export type WorktreeCleanupPolicy = 'cleanup' | 'preserve';

export interface WorktreeIsolationPolicy {
  branchPrefix?: string;
  cleanupOnCompletion?: boolean;
  preserveOnFailure?: boolean;
  baseRef?: string;
  worktreeBaseDir?: string;
}

export interface WorkspaceIsolationConfig {
  mode: WorkspaceIsolationMode;
  policy?: WorktreeIsolationPolicy;
}

/**
 * #4507: who owns a provisioned worktree when it is not the Session that
 * started in it. A Task-owned worktree is shared by every Session of that
 * Task and is finalized when the Task reaches `done` or `canceled`, never
 * when one of its Sessions exits. Absent: the starting Session owns it.
 */
export interface WorktreeTaskOwner {
  kind: 'task';
  taskId: string;
}

export interface WorktreeSessionMetadata {
  mode: 'worktree';
  repoPath: string;
  path: string;
  branch: string;
  baseRef: string;
  /** Resolved commit used to create this worktree; absent on older records. */
  baseCommit?: string;
  cleanupPolicy: WorktreeCleanupPolicy;
  preserveOnFailure: boolean;
  createdAt: string;
  /** #4507: set only for a Task-owned worktree; see {@link WorktreeTaskOwner}. */
  owner?: WorktreeTaskOwner;
}

export type WorkspaceIsolationMetadata =
  | { mode: 'shared' }
  | WorktreeSessionMetadata;

/**
 * #4771: what became of a worktree Session's output, recorded at most once.
 *
 * - `discarded`: a person asked; Station removed the worktree it created for
 *   that Session and its branch. A discard is refused, before anything is
 *   removed, while the branch has moved on or another checkout has it. Only
 *   when completing an earlier discard whose worktree is already gone is the
 *   branch kept in those cases, and the evidence says why (`branchKept`).
 *   Files the repository ignores are removed with the worktree without
 *   needing `acceptUncommittedLoss`; the evidence counts them.
 * - `kept`: derived, never asserted. The base's current tip contained the
 *   worktree branch's head commit when it was recorded. A squash merge does
 *   not contain the head commit, so it is never `kept`; see `released`.
 * - `released`: a pull request whose head branch and head commit match the
 *   worktree branch was open or merged when it was recorded.
 * - `cleaned-up-without-decision`: the Session's cleanup policy removed the
 *   worktree and no decision had been recorded.
 */
export type WorktreeOutputOutcome =
  | 'discarded'
  | 'kept'
  | 'released'
  | 'cleaned-up-without-decision';

/**
 * Who settled it, derived by Station from the request's authenticated
 * principal (or Station's own cleanup policy), never named by the caller.
 */
export type WorktreeOutputSettlementActor =
  | { kind: 'person'; id: string }
  | { kind: 'station'; id: 'worktree-cleanup-policy' };

/** The forge's own answer about the pull request a `released` names. */
export interface WorktreeOutputPullRequestEvidence {
  provider: string;
  host: string;
  repository: { owner: string; name: string };
  ref: string;
  url: string;
  /** The forge's state when recorded: `OPEN` or `MERGED`. */
  state: string;
  sourceBranch: string;
  targetBranch: string;
  headSha: string;
}

/** What Station checked or did; which fields appear depends on the outcome. */
export interface WorktreeOutputSettlementEvidence {
  /** `kept`: the base ref's tip that contained the head commit. */
  containingCommit?: string;
  /** `released`: the pull request read from the forge. */
  pullRequest?: WorktreeOutputPullRequestEvidence;
  /** `discarded`: the worktree had uncommitted or untracked changes. */
  hadUncommittedChanges?: boolean;
  /** `discarded`: the request accepted losing those changes. */
  acceptedUncommittedLoss?: boolean;
  /**
   * `discarded`: how many ignored paths `git status` listed in the worktree
   * when it was removed. Every untracked path is listed, so an ignored
   * directory counts each file in it. Ignored files are removed without
   * `acceptUncommittedLoss`.
   */
  ignoredEntries?: number;
  /**
   * `discarded`: whether this settlement's own Git effect removed the
   * worktree registration and deleted the branch (`false` when it was
   * already gone, or kept).
   */
  removedWorktree?: boolean;
  removedBranch?: boolean;
  /**
   * `cleaned-up-without-decision`: what was observed after the cleanup
   * policy ran. It says what is gone, not who removed it; `unknown` when git
   * could not tell.
   */
  afterCleanup?: {
    worktree: 'present' | 'absent' | 'unknown';
    branch: 'present' | 'absent' | 'unknown';
  };
  /**
   * `discarded`: why the branch was kept: it gained a commit after the head
   * was recorded (`moved`), or another checkout has it checked out
   * (`checked-out-elsewhere`).
   */
  branchKept?: 'moved' | 'checked-out-elsewhere';
  /** `kept`: the branch the base ref named when it was checked. */
  baseBranch?: string;
  /** `cleaned-up-without-decision`: the Session's terminal state. */
  terminalState?: 'completed' | 'failed' | 'cancelled';
}

/**
 * One worktree Session's settlement. `pending` exists only for a discard
 * whose Git effect may have started; it is never a decided outcome.
 */
export interface WorktreeOutputSettlement {
  sessionId: string;
  state: 'pending' | 'settled';
  outcome: WorktreeOutputOutcome;
  actor: WorktreeOutputSettlementActor;
  requestKey: string;
  repoPath: string;
  worktreePath: string;
  branch: string;
  baseRef: string;
  /** The commit the worktree started from; absent on older records. */
  baseCommit?: string;
  /** The worktree branch's head commit the decision was made on. */
  headCommit?: string;
  evidence: WorktreeOutputSettlementEvidence;
  requestedAt: string;
  settledAt?: string;
}

/** The body a person sends to settle; Station derives everything else. */
export type WorktreeOutputSettlementRequest =
  | {
      requestKey: string;
      outcome: 'discarded';
      /** Required to discard a worktree with uncommitted or untracked changes. */
      acceptUncommittedLoss?: boolean;
    }
  | { requestKey: string; outcome: 'kept' }
  | {
      requestKey: string;
      outcome: 'released';
      pullRequest: {
        provider: string;
        host: string;
        repository: { owner: string; name: string };
        ref: string;
      };
    };

/**
 * Why a settlement request was refused. A refusal records nothing and
 * removes nothing. (`settlement-pending` reports an earlier discard whose
 * removal may already have happened; that discard, not this request, did
 * it.)
 */
export type WorktreeOutputSettlementRefusal =
  /** The caller lost its authority over the Session while Station checked. */
  | 'authority-changed'
  /** A turn is running in the Session's worktree. */
  | 'session-running'
  /** Another checkout has the Session's branch checked out. */
  | 'branch-checked-out-elsewhere'
  /** The worktree path is a symlink or not a directory. */
  | 'worktree-path-not-a-directory'
  /** The worktree path now holds a different repository. */
  | 'worktree-replaced'
  /** The Session's repository is no longer at its recorded path. */
  | 'repository-missing'
  /** `kept` with base `HEAD` while the base checkout's HEAD is detached. */
  | 'base-detached'
  /** `kept` with a base that names the Session's own branch. */
  | 'base-is-session-branch'
  | 'already-settled'
  | 'request-key-mismatch'
  | 'settlement-pending'
  | 'not-a-worktree-session'
  | 'task-owned-worktree'
  | 'worktree-missing'
  | 'unsafe-repository-config'
  | 'uncommitted-changes'
  | 'branch-moved'
  | 'no-new-commits'
  | 'base-unresolvable'
  | 'base-does-not-contain-head'
  | 'pull-request-unavailable'
  | 'pull-request-not-open-or-merged'
  | 'pull-request-mismatch';
