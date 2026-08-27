import {
  type AgentId,
  agentId,
} from '@kontourai/station-contracts/agent-identity';

export interface RuntimeResolvedAgent {
  slug: AgentId;
  name: string;
  project?: string;
  execution?: { agentConnectionId?: string };
}

export async function resolveRuntimeAgent(
  rawSlug: string,
  deps: {
    listAgents(): Promise<
      Array<{
        slug: string;
        name: string;
        project?: string;
        execution?: { agentConnectionId?: string };
      }>
    >;
    getDefaultAgentIds(): Promise<ReadonlySet<string>>;
  },
): Promise<RuntimeResolvedAgent | null> {
  let slug: AgentId;
  try {
    slug = agentId(rawSlug);
  } catch {
    return null;
  }
  const [agents, defaults] = await Promise.all([
    deps.listAgents(),
    deps.getDefaultAgentIds(),
  ]);
  const resolved = agents.find((candidate) => candidate.slug === slug);
  if (!resolved) return null;
  // Deliberately read the registry default set alongside the catalog: a
  // default may have no authored file, while authored/project-owned entries
  // remain owned by listAgents. Both populations resolve through one seam.
  void defaults.has(slug);
  return { ...resolved, slug };
}
