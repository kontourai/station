import type { AgentSpec } from '@kontourai/station-contracts/agent';
import type { ConnectionConfig } from '@kontourai/station-contracts/tool';
import type { IStorageAdapter } from '../../domain/storage-adapter.js';
import { StationAgentAdapter } from '../../providers/adapters/station-agent-adapter.js';
import type { OrchestrationService } from '../../services/orchestration/orchestration-service.js';
import { createWorkspacePaneHostActions } from '../../services/plugins/workspace-pane-host-actions.js';
import { executeExecutionTargetMessage } from '../../tools/station-control-delegation.js';

/** One production bridge, shared by runtime composition and executable proof. */
export function createRuntimeWorkspacePaneHostActions(input: {
  projectHomeDir: string;
  projects: Pick<IStorageAdapter, 'projectRevision'>;
  orchestration: OrchestrationService;
  getConnection(id: string): Promise<ConnectionConfig | null>;
  nativeAgentAvailable?(agentId: string, spec: AgentSpec): boolean;
}) {
  return createWorkspacePaneHostActions({
    projectHomeDir: input.projectHomeDir,
    projects: input.projects,
    getConnection: input.getConnection,
    nativeAgentAvailable: (agentId, spec) =>
      input.orchestration.getProviderAdapter('station-agent') instanceof
        StationAgentAdapter &&
      input.nativeAgentAvailable?.(agentId, spec) === true,
    execute: async (actor, admission) => {
      const handle = await executeExecutionTargetMessage(
        {
          target: {
            environment: { kind: 'current' },
            agent: admission.agentId,
            workspace: { kind: 'project', projectSlug: admission.project.slug },
          },
          message: admission.message,
          userId: actor.principal.id,
          principal: actor.principal,
          clientOrigin: actor.clientOrigin,
          readAuthority: actor.readAuthority,
        },
        input.orchestration,
        admission,
      );
      return {
        conversationId: handle.conversationId,
        sessionId: handle.sessionId,
        turnId: handle.providerTurnId,
      };
    },
  });
}
