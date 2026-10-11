import type { AgentSpec } from '@kontourai/station-contracts/agent';
import type { ProjectConfig } from '@kontourai/station-contracts/project';

export function projectMcpServers(
  project: ProjectConfig,
  hasKnowledgeStore: boolean,
): string[] {
  return [
    ...new Set([
      ...(project.toolDefaults?.mcpServers ?? []).filter(
        (id) =>
          id !== 'station-knowledge' ||
          project.toolDefaults?.knowledge !== false,
      ),
      ...(hasKnowledgeStore && project.toolDefaults?.knowledge !== false
        ? ['station-knowledge']
        : []),
    ]),
  ];
}

/** Project defaults add delivery; the Agent's selected tools and approval policy stay authoritative. */
export function withProjectToolDefaults(
  spec: AgentSpec,
  servers: readonly string[],
): AgentSpec {
  if (!servers.length) return spec;
  return {
    ...spec,
    tools: {
      ...spec.tools,
      ...(spec.tools?.mcpServers === undefined &&
      spec.tools?.mcpMode === undefined
        ? { mcpMode: 'add' as const }
        : {}),
      mcpServers: [...new Set([...(spec.tools?.mcpServers ?? []), ...servers])],
    },
  };
}
