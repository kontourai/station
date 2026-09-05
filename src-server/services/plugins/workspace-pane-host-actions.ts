import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { AgentSpec } from '@kontourai/station-contracts/agent';
import type { ClientOrigin } from '@kontourai/station-contracts/client-origin';
import type { PrincipalRef } from '@kontourai/station-contracts/principal';
import { agentAvailableInProject } from '@kontourai/station-contracts/project-reference-integrity';
import type { SessionReadAuthority } from '@kontourai/station-contracts/tenancy';
import type { ConnectionConfig } from '@kontourai/station-contracts/tool';
import type {
  WorkspacePaneHostActionCatalog,
  WorkspacePaneHostActionExecution,
  WorkspacePaneHostActionPreparation,
  WorkspacePaneHostActionPrepareRequest,
  WorkspacePaneHostAgentResolution,
  WorkspacePaneHostCompositionProjection,
} from '@kontourai/station-contracts/workspace-pane-host-contribution';
import { capturePluginAgentInvocation } from '../../domain/config-loader-agents.js';
import type { IStorageAdapter } from '../../domain/storage-adapter.js';
import { assertConnectionReady } from '../execution-target/execution-target-resolver.js';
import type { ForegroundInvocationAdmission } from '../orchestration/foreground-invocation-admission.js';
import { ForegroundInvocationUnavailableError } from '../orchestration/foreground-invocation-admission.js';
import { scanInstalledPluginInventory } from './installed-plugin-inventory.js';
import { computePluginContentDigest } from './plugin-content-integrity.js';
import {
  hasGrant,
  withPluginPermissionInvocation,
} from './plugin-permissions.js';
import { createWorkspacePaneHostAdmission } from './workspace-pane-host-admission.js';
import { createWorkspacePaneHostContribution } from './workspace-pane-host-contributions.js';

export interface WorkspacePaneHostActionActor {
  principal: PrincipalRef;
  readAuthority: SessionReadAuthority;
  clientOrigin?: ClientOrigin;
  /** Fresh request credential/currentness, supplied by verified ingress only. */
  isCurrent(): boolean;
}

const MAX_TICKETS = 128;
const TICKET_LIFETIME_MS = 60_000;
class HostActionActorUnavailableError extends Error {}

/**
 * The ticket map transports already captured one-shot admission capabilities.
 * It is not run truth: existing Session commands/events own execution receipts.
 * Restart/expiration/spent-ticket replay never recreate admission or an effect.
 */
export function createWorkspacePaneHostActions(input: {
  projectHomeDir: string;
  projects: Pick<IStorageAdapter, 'projectRevision'>;
  getConnection(id: string): Promise<ConnectionConfig | null>;
  nativeAgentAvailable?(agentId: string, spec: AgentSpec): boolean;
  execute(
    actor: WorkspacePaneHostActionActor,
    admission: ForegroundInvocationAdmission,
  ): Promise<{
    conversationId: string;
    sessionId: string;
    turnId: string;
  }>;
  now?: () => number;
}) {
  const now = input.now ?? Date.now;
  const pluginsDir = join(input.projectHomeDir, 'plugins');
  const admission = createWorkspacePaneHostAdmission({
    projectHomeDir: input.projectHomeDir,
    projects: input.projects,
    nativeAgentAvailable: input.nativeAgentAvailable,
    withInvocationPermission: (pluginId, invoke) =>
      withPluginPermissionInvocation(
        input.projectHomeDir,
        pluginId,
        'agents.invoke',
        invoke,
      ),
  });
  type Prepared = Awaited<ReturnType<typeof admission.prepare>>;
  const tickets = new Map<
    string,
    {
      owner: string;
      projectSlug: string;
      expiresAt: number;
      prepared: Prepared;
    }
  >();
  const actorKey = (actor: WorkspacePaneHostActionActor) =>
    JSON.stringify([
      actor.principal.id,
      actor.readAuthority.userId,
      actor.readAuthority.mode,
      actor.readAuthority.tenantExecutionContext?.tenantId,
    ]);
  const permission = (id: string) =>
    hasGrant(input.projectHomeDir, id, 'agents.invoke');

  async function catalog(
    projectSlug: string,
  ): Promise<WorkspacePaneHostActionCatalog> {
    const project = input.projects.projectRevision(projectSlug).value;
    const contributions: WorkspacePaneHostActionCatalog['contributions'][number][] =
      [];
    const inventory = scanInstalledPluginInventory(pluginsDir);
    for (const installed of inventory.slice(0, 128)) {
      if (
        installed.state !== 'valid' ||
        !installed.manifest.workspacePaneHost ||
        installed.manifest.name !== installed.directoryName
      )
        continue;
      const pluginId = installed.directoryName;
      const installationGeneration = computePluginContentDigest(
        pluginsDir,
        pluginId,
      );
      if (!installationGeneration) continue;
      const granted = permission(pluginId);
      const owner = { pluginId, installationGeneration };
      const source = createWorkspacePaneHostContribution({
        declaration: installed.manifest.workspacePaneHost,
        owner,
        projectId: project.id,
        authority: {
          current: () => ({
            state:
              computePluginContentDigest(pluginsDir, pluginId) ===
              installationGeneration
                ? 'current'
                : 'retired',
          }),
        },
        agents: {
          resolveStationAgent: async () => ({ state: 'unavailable' }),
          resolveOwnPluginAgent: async ({
            agentId,
          }): Promise<WorkspacePaneHostAgentResolution> => {
            if (!granted) return { state: 'unavailable' };
            try {
              const spec = (
                await capturePluginAgentInvocation(
                  input.projectHomeDir,
                  agentId,
                  pluginId,
                )
              ).read();
              if (
                !agentAvailableInProject(projectSlug, project.agents, {
                  slug: agentId,
                  project: spec.project,
                })
              )
                return { state: 'restricted' };
              if (spec.execution?.agentConnectionId) {
                const connection = await input.getConnection(
                  spec.execution.agentConnectionId,
                );
                if (!connection) return { state: 'unavailable' };
                assertConnectionReady(connection);
              } else if (!input.nativeAgentAvailable?.(agentId, spec))
                return { state: 'unavailable' };
              return {
                state: 'available',
                agent: { kind: 'plugin-agent', ...owner, agentId },
              };
            } catch {
              return { state: 'unavailable' };
            }
          },
        },
        // Projection only. Production launch is exclusively captured admission below.
        launcher: { launch: async () => ({ state: 'unavailable' }) },
      });
      const projected = await source.project();
      if (projected.state !== 'available') continue;
      contributions.push({
        displayName:
          typeof installed.manifest.displayName === 'string' &&
          installed.manifest.displayName.trim()
            ? installed.manifest.displayName.trim().slice(0, 160)
            : pluginId,
        projection: projected.projection,
        ...(!granted
          ? { reason: 'permission-required' as const }
          : projected.projection.agentSelection.availableAgents.every(
                (agent) => agent.resolution.state !== 'available',
              )
            ? { reason: 'agent-unavailable' as const }
            : {}),
      });
    }
    return {
      projectSlug,
      support: 'supported',
      contributions,
      complete:
        inventory.length <= 128 &&
        inventory.every((entry) => entry.state === 'valid'),
    };
  }

  function actionId(
    projection: WorkspacePaneHostCompositionProjection,
    key: string,
  ) {
    return projection.actions.find((action) => action.key === key)?.id;
  }

  return Object.freeze({
    catalog,
    async prepare(
      actor: WorkspacePaneHostActionActor,
      projectSlug: string,
      request: WorkspacePaneHostActionPrepareRequest,
    ): Promise<WorkspacePaneHostActionPreparation> {
      if (!actor.isCurrent())
        return { state: 'unavailable', reason: 'authorization-changed' };
      for (const [key, value] of tickets)
        if (value.expiresAt <= now()) tickets.delete(key);
      if (tickets.size >= MAX_TICKETS)
        return { state: 'unavailable', reason: 'host-unavailable' };
      try {
        const current = (await catalog(projectSlug)).contributions.find(
          ({ projection }) =>
            projection.owner.pluginId === request.pluginId &&
            projection.owner.installationGeneration ===
              request.installationGeneration,
        );
        if (!current)
          return { state: 'unavailable', reason: 'installation-changed' };
        if (current.reason)
          return { state: 'unavailable', reason: current.reason };
        const id = actionId(current.projection, request.actionKey);
        if (!id)
          return { state: 'unavailable', reason: 'installation-changed' };
        const prepared = await admission.prepare({
          pluginId: request.pluginId,
          projectSlug,
          actionId: id,
          installationGeneration: request.installationGeneration,
          selectedAgent: request.selectedAgent,
        });
        // Recheck capacity after awaited preparation; never evict a live capability.
        if (tickets.size >= MAX_TICKETS)
          return { state: 'unavailable', reason: 'host-unavailable' };
        const ticket = randomBytes(32).toString('base64url');
        tickets.set(ticket, {
          owner: actorKey(actor),
          projectSlug,
          expiresAt: now() + TICKET_LIFETIME_MS,
          prepared,
        });
        return { state: 'prepared', ticket };
      } catch {
        return { state: 'unavailable', reason: 'agent-unavailable' };
      }
    },
    async execute(
      actor: WorkspacePaneHostActionActor,
      projectSlug: string,
      ticket: string,
    ): Promise<WorkspacePaneHostActionExecution> {
      const value = tickets.get(ticket);
      if (
        !value ||
        value.owner !== actorKey(actor) ||
        value.projectSlug !== projectSlug
      )
        return { state: 'indeterminate' };
      tickets.delete(ticket); // Consume synchronously before the first await.
      if (value.expiresAt <= now()) return { state: 'indeterminate' };
      let effectStarted = false;
      try {
        const handle = await value.prepared.run((captured) =>
          input.execute(actor, {
            ...captured,
            get provisionedWorkspace() {
              return captured.provisionedWorkspace;
            },
            invoke: (phase, actual, effect) =>
              captured.invoke(phase, actual, () => {
                if (!actor.isCurrent())
                  throw new HostActionActorUnavailableError();
                effectStarted = true;
                return effect();
              }),
          }),
        );
        if (!handle.conversationId || !handle.sessionId || !handle.turnId)
          return { state: 'indeterminate' };
        return {
          state: 'accepted',
          conversationId: handle.conversationId,
          sessionId: handle.sessionId,
          turnId: handle.turnId,
        };
      } catch (error) {
        if (effectStarted) return { state: 'indeterminate' };
        if (error instanceof HostActionActorUnavailableError)
          return { state: 'unavailable', reason: 'authorization-changed' };
        return {
          state: 'unavailable',
          reason:
            error instanceof ForegroundInvocationUnavailableError
              ? 'installation-changed'
              : 'host-unavailable',
        };
      }
    },
  });
}
