import type { AgentSpec } from '@kontourai/station-contracts/agent';
import type { AgentId } from '@kontourai/station-contracts/agent-identity';
import type { ProjectConfig } from '@kontourai/station-contracts/project';
import type { WorkspaceIsolationMode } from '@kontourai/station-contracts/workspace-isolation';
import type { WorkspacePaneHostActionProvenance } from '@kontourai/station-contracts/workspace-pane-host-contribution';

/**
 * Server-only capability. Public command JSON cannot supply it. Its owner
 * captures authored inputs once and guards the irreversible provider call,
 * never reinterpreting a later policy change as cancellation of an effect.
 */
export interface ForegroundInvocationAdmission {
  readonly agentId: AgentId;
  readonly agentSpec: AgentSpec;
  readonly project: ProjectConfig;
  /**
   * The workspace mode this invocation will start in, resolved ONCE when the
   * admission is captured: the project's own choice, then this Station's
   * `defaultWorkspaceIsolation`, then shared (#2144 slice 2).
   *
   * Captured rather than re-read because the execution-target resolver
   * answers the same question for the same invocation, and a precondition
   * that re-derived it from `project.defaultWorkspaceIsolation` alone would
   * refuse to provision exactly the worktrees a Station-level default
   * produces. `resolveWorkspaceIsolationMode` is the one derivation; this is
   * its captured result.
   */
  readonly workspaceIsolationMode: WorkspaceIsolationMode;
  readonly message: string;
  /** Minted only by canonical worktree provisioning, never public metadata. */
  readonly provisionedWorkspace?: {
    readonly threadId: string;
    readonly projectSlug: string;
    readonly cwd: string;
  };
  readonly source?: WorkspacePaneHostActionProvenance;
  invoke<R>(
    phase: 'provision' | 'start' | 'turn' | 'native-relay',
    actual: {
      threadId: string;
      agentId: unknown;
      projectSlug: unknown;
      message?: string;
      cwd?: string;
    },
    effect: () => Promise<R>,
  ): Promise<R>;
}

export class ForegroundInvocationUnavailableError extends Error {
  readonly code = 'foreground_invocation_unavailable';

  constructor() {
    super(
      'The captured Workspace Pane action is unavailable or changed before invocation.',
    );
  }
}
