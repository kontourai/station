import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { AgentSpec } from '@kontourai/station-contracts/agent';
import { engineConnectionId } from '@kontourai/station-contracts/agent-identity';
import { resolveEngineCapabilityMatrix } from '@kontourai/station-contracts/engine-capability-matrix';
import type { OwnAccessView } from '@kontourai/station-contracts/tool-library';
import { mcpToolDisabled } from '@kontourai/station-shared/mcp-tool-selection';
import type { Context } from 'hono';
import { getIntegrationRegistryProvider } from '../../providers/registries/registry.js';
import { isNonPersonCaller } from '../../routes/plugins/plugin-person-approval.js';
import { captureConfigurationMutation } from '../../routes/system/configuration-activation.js';
import {
  type ToolLibraryActor,
  type ToolLibraryRouteDeps,
} from '../../routes/tool-library.js';
import { refuseUngrantedCommandChoice } from '../../routes/working-directory-authority.js';
import { runtimeRequestPrincipalMayAccessHttpRoute } from '../../security/runtime-request-security.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../services/identity/principal-resolver.js';
import { installRegistryIntegration } from '../../services/plugins/install-registry-integration.js';
import { toolLibraryCatalog } from '../../services/plugins/tool-library-catalog.js';
import {
  ToolLibraryRefusal,
  ToolLibraryService,
} from '../../services/plugins/tool-library-service.js';
import type { ProjectMembershipAuthority } from '../../services/projects/project-membership-service.js';
import type { ConfigureRuntimeRoutesContext } from './runtime-routes.js';

export function runtimeToolLibraryDependencies(
  context: ConfigureRuntimeRoutesContext,
  authority: (request: Request) => ProjectMembershipAuthority,
): ToolLibraryRouteDeps {
  const service = new ToolLibraryService(
    context.configLoader.getProjectHomeDir(),
  );
  const heldProjects = new WeakMap<
    Request,
    { projectId: string; principalId: string }
  >();
  async function guarded<T>(
    c: Context,
    captured: ToolLibraryActor,
    operation: () => Promise<T>,
  ): Promise<T> {
    heldProjects.set(c.req.raw, {
      projectId: captured.project!.id,
      principalId: captured.access.principalId,
    });
    try {
      return await operation();
    } finally {
      heldProjects.delete(c.req.raw);
    }
  }
  async function actor(
    c: Context,
    projectSlug?: string,
    projectAlreadyGuarded = false,
  ): Promise<ToolLibraryActor> {
    if (isNonPersonCaller(c.req.raw))
      throw new ToolLibraryRefusal('forbidden', 'Open Tools as a person.');
    const access = authority(c.req.raw);
    const current = await access.current();
    let operator = false;
    try {
      await access.operator();
      operator = current.principal.id === LOCAL_OPERATOR_PRINCIPAL_ID;
    } catch {
      /* Project authority is checked independently below. */
    }
    const admissions = operator
      ? []
      : projectAlreadyGuarded
        ? (context.projectMembership?.admissionsForResolvedPrincipal(
            current.principal.id,
          ) ?? [])
        : ((await context.projectMembership?.readableProjectAdmissions(
            access,
          )) ?? []);
    const mayChange = runtimeRequestPrincipalMayAccessHttpRoute(
      c.req.raw,
      context.environmentSecurityService,
      { method: 'POST', path: '/api/tool-library/requests' },
    );
    const projects: OwnAccessView['projects'] = operator
      ? context.projectService.listProjects().map((project) => ({
          id: project.id,
          slug: project.slug,
          name: project.name,
          role: 'operator',
          canManageAgents: mayChange,
          canManageTools: mayChange,
          canExecute: true,
        }))
      : admissions.map(({ scope, member }) => ({
          id: scope.localProjectId,
          slug: scope.localProjectSlug,
          name: context.projectService.getProject(scope.localProjectSlug).name,
          role: member.role,
          canManageAgents:
            mayChange && (member.role === 'admin' || member.role === 'owner'),
          canManageTools: mayChange && member.role === 'owner',
          canExecute: false,
        }));
    const project = projectSlug
      ? projects.find((row) => row.slug === projectSlug)
      : undefined;
    if (projectSlug && !project)
      throw new ToolLibraryRefusal(
        'forbidden',
        'Project access is unavailable.',
      );
    return {
      access: {
        principalId: current.principal.id,
        name: current.principal.display,
        station: {
          name: hostname(),
          operator,
          canInstallTools: operator && !refuseUngrantedCommandChoice(c),
        },
        projects,
      },
      project: project
        ? { id: project.id, slug: project.slug, name: project.name }
        : undefined,
      canManageAgents: project
        ? project.canManageAgents
        : operator && mayChange,
      canManagePolicy: project ? project.canManageTools : operator,
    };
  }
  const sources = () =>
    toolLibraryCatalog(
      context.configLoader.getProjectHomeDir(),
      context.mcpService,
    );
  return {
    service,
    actor,
    revalidate: (c, captured) =>
      actor(
        c,
        captured.project?.slug,
        heldProjects.get(c.req.raw)?.projectId === captured.project?.id &&
          heldProjects.get(c.req.raw)?.principalId ===
            captured.access.principalId,
      ),
    sources,
    async discover(actor, source) {
      if (source.origin?.kind === 'station') return source;
      const current = await context.mcpService.getIntegration(source.id);
      if (current.enabled === false)
        throw new ToolLibraryRefusal('forbidden', 'This source is disabled.');
      const checked = await context.mcpService.probeIntegration(source.id, {
        principalId: actor.access.principalId,
        projectSlug: actor.project?.slug,
      });
      if (!checked.probe?.ok)
        throw new ToolLibraryRefusal(
          'unavailable',
          'Could not refresh actions. Check the connection.',
        );
      return {
        ...source,
        tools: (checked.probe.tools ?? []).map((tool) => ({
          ...tool,
          classificationSource: 'publisher' as const,
          disabled: mcpToolDisabled(
            source.id,
            tool.name,
            checked.disabledTools ?? [],
          ),
        })),
      };
    },
    engines: async () => [
      { id: 'station', name: 'Station', engineId: 'station' },
      ...(await context.connectionService.listRuntimeConnections())
        .filter((row) => row.enabled !== false && row.id !== 'station')
        .map((row) => ({
          id: row.id,
          name: row.name || row.id,
          engineId: resolveEngineCapabilityMatrix(row.id, row).engineId,
        })),
    ],
    async withinProject(c, captured, operation) {
      if (!captured.project)
        throw new ToolLibraryRefusal('forbidden', 'Choose a Project.');
      if (!captured.access.station.operator) {
        if (!context.projectMembership)
          throw new ToolLibraryRefusal(
            'unavailable',
            'Project sharing is unavailable.',
          );
        return context.projectMembership.withAgentAdministration(
          captured.project.slug,
          captured.project.id,
          captured.access.principalId,
          authority(c.req.raw),
          () => guarded(c, captured, operation),
        );
      }
      const revision = context.storageAdapter.projectRevision(
        captured.project.slug,
      );
      if (!revision.withCurrentRead)
        throw new ToolLibraryRefusal(
          'unavailable',
          'Project state is unavailable.',
        );
      return revision.withCurrentRead(async (project) => {
        const fresh = await actor(c, captured.project!.slug);
        if (
          project.id !== captured.project!.id ||
          fresh.access.principalId !== captured.access.principalId
        )
          throw new ToolLibraryRefusal('conflict', 'Project access changed.');
        return guarded(c, captured, operation);
      });
    },
    async install(c, source) {
      const current = await actor(c);
      if (!current.access.station.canInstallTools)
        throw new ToolLibraryRefusal(
          'forbidden',
          'Only the Station operator can add sources.',
        );
      if (source.kind === 'plugin')
        throw new ToolLibraryRefusal(
          'conflict',
          'Review the plugin permissions before adding it.',
        );
      if (!source.installed) {
        const result = await installRegistryIntegration(
          getIntegrationRegistryProvider(),
          context.configLoader,
          source.id,
          source.origin?.registryId,
        );
        if (!result.success)
          throw new ToolLibraryRefusal(
            'unavailable',
            result.message || 'Installation did not finish.',
          );
      }
      // Enabling a local command is an operator decision. Account sign-in is separate.
      const fresh = await actor(c);
      if (!fresh.access.station.canInstallTools)
        throw new ToolLibraryRefusal('forbidden', 'Operator access changed.');
      await context.mcpService.setEnabled(source.id, true);
      const checked = await context.mcpService.probeIntegration(source.id, {
        principalId: current.access.principalId,
      });
      if (checked.probe?.ok === false) return;
      await context.reloadAgents();
    },
    listAgents: () => context.agentService.listAgents(),
    getAgent: (slug) => context.agentService.getAgent(slug),
    async saveAgent(slug, draft, project, authorize) {
      const engines = await context.connectionService.listRuntimeConnections();
      if (
        draft.engineId !== 'station' &&
        !engines.some(
          (engine) => engine.id === draft.engineId && engine.enabled !== false,
        )
      )
        throw new ToolLibraryRefusal(
          'forbidden',
          'Choose an available engine.',
        );
      const chosenEngine =
        draft.engineId === 'station'
          ? 'station'
          : resolveEngineCapabilityMatrix(
              draft.engineId,
              engines.find((row) => row.id === draft.engineId),
            ).engineId;
      if (chosenEngine !== 'station') {
        const selected = await sources();
        if (
          selected.some(
            (source) =>
              source.personalAccount &&
              draft.tools.mcpServers.includes(source.id),
          )
        )
          throw new ToolLibraryRefusal(
            'conflict',
            'Personal tool accounts require the Station engine.',
          );
      }
      if (
        draft.tools.askBeforeUse?.length &&
        !['station', 'claude'].includes(chosenEngine)
      )
        throw new ToolLibraryRefusal(
          'conflict',
          'This engine cannot enforce Ask me rules. Choose Station or Claude.',
        );
      const publicSlug = slug ?? `project-agent-${randomUUID()}`;
      const spec = {
        slug: publicSlug,
        name: draft.name,
        description: draft.description,
        prompt: draft.prompt,
        project: project.slug,
        audience: {
          version: 'station.agent-audience/v1',
          kind: 'project-permission',
          permission: 'view',
        },
        execution: {
          ...(chosenEngine === 'station'
            ? {}
            : { agentConnectionId: engineConnectionId(draft.engineId) }),
          approvalMode: 'ask',
        },
        tools: { ...draft.tools, mcpMode: 'replace', browser: false },
        skills: [],
        commands: {},
      } satisfies AgentSpec & { slug: string };
      await captureConfigurationMutation(
        context.applyAgentConfigurationMutation,
        async (begin) => {
          await authorize();
          service.assertSources(project.id, draft.tools.mcpServers);
          begin();
          const exists = (await context.agentService.listAgents()).some(
            (row) => row.slug === publicSlug,
          );
          if (exists) await context.agentService.updateAgent(publicSlug, spec);
          else await context.agentService.createAgent(spec);
        },
        { resolveAgentSlug: () => publicSlug, activationMode: 'defer' },
      );
      return publicSlug;
    },
    async account(_c, actor, sourceId, action, callbackUrl) {
      const owner = {
        principalId: actor.access.principalId,
        projectSlug: actor.project!.slug,
      };
      if (action === 'status')
        return context.mcpService.getAccountStatus(sourceId, owner);
      if (action === 'authorize')
        return context.mcpService.startOAuth(sourceId, 'remote', owner);
      if (!callbackUrl)
        throw new ToolLibraryRefusal(
          'conflict',
          'Provide the returned sign-in URL.',
        );
      await context.mcpService.finishOAuth(sourceId, callbackUrl, owner);
      await context.reloadAgents();
      return { connected: true };
    },
    changed: () => context.reloadAgents(),
  };
}
