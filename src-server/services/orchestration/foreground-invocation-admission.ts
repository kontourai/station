import type { AgentSpec } from '@kontourai/station-contracts/agent';
import type { AgentId } from '@kontourai/station-contracts/agent-identity';
import type { ProjectConfig } from '@kontourai/station-contracts/project';
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
