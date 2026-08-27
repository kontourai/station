export type WorkspaceIsolationMode = 'shared' | 'worktree';

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

export interface WorktreeSessionMetadata {
  mode: 'worktree';
  repoPath: string;
  path: string;
  branch: string;
  baseRef: string;
  cleanupPolicy: WorktreeCleanupPolicy;
  preserveOnFailure: boolean;
  createdAt: string;
}

export type WorkspaceIsolationMetadata =
  | { mode: 'shared' }
  | WorktreeSessionMetadata;
