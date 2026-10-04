import {
  type AgentSpec,
  BUILTIN_STATION_AGENT_MCP_SERVER_IDS,
} from '@kontourai/station-contracts/agent';
import type { KnowledgeStoreRoot } from '@kontourai/station-contracts/knowledge-store';
import type { ProjectConfig } from '@kontourai/station-contracts/project';
import type { ITool } from '../../runtime/types.js';
import { runtimeAgentKey } from '../agents/runtime-agent-identity.js';
import { projectMcpServers } from './project-tools.js';

export function createProjectNativeToolLoader(deps: {
  agentSpecs: Map<string, AgentSpec>;
  getProject: (slug: string) => ProjectConfig;
  listRoots: () => Promise<KnowledgeStoreRoot[]>;
  loadTools: (slug: string, spec: AgentSpec) => Promise<ITool[]>;
}) {
  return async (
    publicSlug: string,
    projectSlug: string,
  ): Promise<ITool[] | undefined> => {
    const slug = runtimeAgentKey(publicSlug);
    const original: AgentSpec | undefined =
      deps.agentSpecs.get(slug) ??
      (slug === 'default'
        ? {
            name: 'Station',
            prompt: '',
            tools: {
              mcpServers: [...BUILTIN_STATION_AGENT_MCP_SERVER_IDS],
            },
          }
        : undefined);
    const project = deps.getProject(projectSlug);
    const roots = await deps.listRoots();
    const servers = projectMcpServers(
      project,
      roots.some(
        (root) =>
          root.scope.kind === 'project' &&
          root.scope.projectSlug === projectSlug,
      ),
    );
    if (!servers.length) return undefined;
    if (!original) throw new Error('Agent tool configuration is unavailable.');
    const additions = servers.filter(
      (id) => !original.tools?.mcpServers?.includes(id),
    );
    if (!additions.length) return undefined;
    const loaded = await deps.loadTools(slug, {
      ...original,
      tools: { ...original.tools, mcpServers: additions },
    });
    return loaded;
  };
}
