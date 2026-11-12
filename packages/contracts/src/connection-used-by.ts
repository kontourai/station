/**
 * What depends on a connection: the Agents and Projects whose saved
 * configuration names it. Each entry carries the dependent's slug, so a
 * surface can link to it, and how it selects the connection.
 *
 * Only explicit bindings count. An Agent's slug or display name says nothing
 * about which connection it uses, so nothing here is matched by name. A
 * scheduled job names an Agent, not a connection, so it is not listed: it
 * depends on the connection through that Agent.
 */

/** How a dependent selects the connection. */
export type ConnectionDependentVia =
  /** `AgentExecutionConfig.agentConnectionId` */
  | 'engine'
  /** `AgentExecutionConfig.modelConnectionId` */
  | 'model'
  /** `AgentTools.mcpServers` */
  | 'tool-server'
  /** `ProjectConfig.defaultProviderId` with `defaultModel` set */
  | 'project-default-model'
  /** `ProjectConfig.defaultEmbeddingProviderId` */
  | 'project-embedding'
  /** `ProjectToolDefaults.mcpServers` */
  | 'project-tools';

export interface ConnectionDependent {
  /** The engine connection, model connection or tool server id it names. */
  connectionId: string;
  kind: 'agent' | 'project';
  /** The Agent or Project slug, for navigation. */
  slug: string;
  name: string;
  via: ConnectionDependentVia;
}

/** `GET /api/connections/used-by`. */
export interface ConnectionUsedBy {
  dependents: ConnectionDependent[];
}

/** The saved fields the projection reads from one Agent. */
export interface ConnectionUsedByAgentInput {
  slug: string;
  name?: string;
  execution?: {
    agentConnectionId?: string | null;
    modelConnectionId?: string | null;
  } | null;
  tools?: { mcpServers?: readonly string[] | null } | null;
}

/** The saved fields the projection reads from one Project. */
export interface ConnectionUsedByProjectInput {
  slug: string;
  name?: string;
  defaultProviderId?: string | null;
  defaultModel?: string | null;
  defaultEmbeddingProviderId?: string | null;
  toolDefaults?: { mcpServers?: readonly string[] | null } | null;
}

function named(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Projects saved Agent and Project configuration onto the connections it
 * names. One entry per (connection, dependent, via); a list that names the
 * same tool server twice yields one entry. Order: Agents, then Projects, each
 * in input order.
 */
export function projectConnectionUsedBy(input: {
  agents: readonly ConnectionUsedByAgentInput[];
  projects: readonly ConnectionUsedByProjectInput[];
}): ConnectionUsedBy {
  const dependents: ConnectionDependent[] = [];
  const seen = new Set<string>();
  const add = (
    connectionId: string | null | undefined,
    dependent: Omit<ConnectionDependent, 'connectionId'>,
  ) => {
    const id = named(connectionId);
    if (!id) return;
    const key = JSON.stringify([
      id,
      dependent.kind,
      dependent.slug,
      dependent.via,
    ]);
    if (seen.has(key)) return;
    seen.add(key);
    dependents.push({ connectionId: id, ...dependent });
  };
  for (const agent of input.agents) {
    const base = {
      kind: 'agent' as const,
      slug: agent.slug,
      name: named(agent.name) ?? agent.slug,
    };
    add(agent.execution?.agentConnectionId, { ...base, via: 'engine' });
    add(agent.execution?.modelConnectionId, { ...base, via: 'model' });
    for (const server of agent.tools?.mcpServers ?? [])
      add(server, { ...base, via: 'tool-server' });
  }
  for (const project of input.projects) {
    const base = {
      kind: 'project' as const,
      slug: project.slug,
      name: named(project.name) ?? project.slug,
    };
    // The chat default applies only with a model beside it
    // (`ProviderService` reads the pair), so a lone provider id selects nothing.
    if (named(project.defaultModel))
      add(project.defaultProviderId, {
        ...base,
        via: 'project-default-model',
      });
    add(project.defaultEmbeddingProviderId, {
      ...base,
      via: 'project-embedding',
    });
    for (const server of project.toolDefaults?.mcpServers ?? [])
      add(server, { ...base, via: 'project-tools' });
  }
  return { dependents };
}

/** The dependents of one connection, in projection order. */
export function dependentsOfConnection(
  usedBy: ConnectionUsedBy | undefined,
  connectionId: string,
): ConnectionDependent[] {
  return (usedBy?.dependents ?? []).filter(
    (dependent) => dependent.connectionId === connectionId,
  );
}
