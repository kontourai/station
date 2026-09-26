import type { AgentSpec } from '@kontourai/station-contracts/agent';
import type { ClientOrigin } from '@kontourai/station-contracts/client-origin';
import type { PrincipalRef } from '@kontourai/station-contracts/principal';
import type { SessionReadAuthority } from '@kontourai/station-contracts/tenancy';
import type { ConnectionConfig } from '@kontourai/station-contracts/tool';
import type { IStorageAdapter } from '../../domain/storage-adapter.js';
import { StationAgentAdapter } from '../../providers/adapters/station-agent-adapter.js';
import type { FullAccessGrant } from '../../security/coding-authority.js';
import { runAsStationServer } from '../../security/station-server-scope.js';
import type { ForegroundInvocationAdmission } from '../../services/orchestration/foreground-invocation-admission.js';
import type { OrchestrationService } from '../../services/orchestration/orchestration-service.js';
import type { PackageMcpAdmissionJournal } from '../../services/plugins/package-mcp-admission.js';
import {
  createWorkspacePaneHostActions,
  type WorkspacePaneHostActionActor,
} from '../../services/plugins/workspace-pane-host-actions.js';
import { executeExecutionTargetMessage } from '../../tools/station-control-delegation.js';

/** One production bridge, shared by runtime composition and executable proof. */
export function createRuntimeWorkspacePaneHostActions(input: {
  projectHomeDir: string;
  journal?: PackageMcpAdmissionJournal;
  projects: Pick<IStorageAdapter, 'projectRevision'>;
  orchestration: OrchestrationService;
  getConnection(id: string): Promise<ConnectionConfig | null>;
  nativeAgentAvailable?(agentId: string, spec: AgentSpec): boolean;
}) {
  return createWorkspacePaneHostActions({
    projectHomeDir: input.projectHomeDir,
    journal: input.journal,
    projects: input.projects,
    getConnection: input.getConnection,
    stationDefaultWorkspaceIsolation: async () =>
      await input.orchestration.resolveStationDefaultWorkspaceIsolation?.(),
    nativeAgentAvailable: (agentId, spec) =>
      input.orchestration.getProviderAdapter('station-agent') instanceof
        StationAgentAdapter &&
      input.nativeAgentAvailable?.(agentId, spec) === true,
    execute: (actor, admission) =>
      executeWorkspacePaneHostAction(input.orchestration, actor, admission),
  });
}

/**
 * The runtime bridge from an admitted Pane action to a foreground turn. A
 * named export so a test can drive it from the real route.
 */
export async function executeWorkspacePaneHostAction(
  orchestration: OrchestrationService,
  actor: WorkspacePaneHostActionActor,
  admission: ForegroundInvocationAdmission,
) {
  // #2377: an admitted Pane action is a person's turn Station drives itself;
  // its loopback calls run as server code.
  const handle = await runAsStationServer(() =>
    executeExecutionTargetMessage(
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
        ...(actor.ownerAttribution
          ? { ownerAttribution: actor.ownerAttribution }
          : {}),
        ...(actor.fullAccessGrant
          ? { fullAccessGrant: actor.fullAccessGrant }
          : {}),
      },
      orchestration,
      admission,
    ),
  );
  return {
    conversationId: handle.conversationId,
    sessionId: handle.sessionId,
    turnId: handle.providerTurnId,
  };
}

/**
 * Station #90 lane D (R1/S3): the Pane host route's actor. An internal-token
 * request (agent-capable, whatever headers it carries) triggers an
 * unattributed session, even a verified one: this path acts as the ingress
 * principal, which for the internal token is the operator.
 */
export function createWorkspacePaneHostActorFor(deps: {
  resolvePrincipal: (c: PaneHostRequestContext) => PrincipalRef;
  readAuthorityFor: (principalId: string) => SessionReadAuthority;
  resolveClientOrigin: (request: Request) => ClientOrigin;
  isRequestPrincipalCurrent: (request: Request) => boolean;
  resolveAgentDispatchActor: (request: Request) => unknown;
  /**
   * #2493: this request's full-access grant (`fullAccessGrantForRequest`).
   * Not consulted for an agent-capable request, which starts confined.
   */
  fullAccessGrantFor: (c: PaneHostRequestContext) => FullAccessGrant | null;
}): (c: PaneHostRequestContext) => WorkspacePaneHostActionActor {
  return (c) => {
    const principal = deps.resolvePrincipal(c);
    const agent = deps.resolveAgentDispatchActor(c.req.raw);
    const fullAccessGrant = agent ? null : deps.fullAccessGrantFor(c);
    return {
      principal,
      readAuthority: deps.readAuthorityFor(principal.id),
      clientOrigin: deps.resolveClientOrigin(c.req.raw),
      isCurrent: () => deps.isRequestPrincipalCurrent(c.req.raw),
      ...(agent ? { ownerAttribution: 'unattributed-agent' as const } : {}),
      ...(fullAccessGrant ? { fullAccessGrant } : {}),
    };
  };
}

type PaneHostRequestContext = {
  env: unknown;
  req: { raw: Request; header(name: string): string | undefined };
};
