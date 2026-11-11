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
 * - `discarded`: a person asked; Station removed the worktree and the branch
 *   it created for that Session.
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
  /** `discarded`: whether this settlement's own Git effect removed each. */
  removedWorktree?: boolean;
  removedBranch?: boolean;
  /**
   * `discarded`: the branch gained a commit after the head was recorded, so
   * it was kept rather than deleted.
   */
  branchMoved?: boolean;
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

/** Why a settlement request was refused; nothing was recorded or removed. */
export type WorktreeOutputSettlementRefusal =
  /** The caller lost its authority over the Session while Station checked. */
  | 'authority-changed'
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
