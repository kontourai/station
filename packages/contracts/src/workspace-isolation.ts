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
