import {
  type ConnectionUsedBy,
  type ConnectionUsedByAgentInput,
  type ConnectionUsedByProjectInput,
  projectConnectionUsedBy,
} from '@kontourai/station-contracts/connection-used-by';
import type { Context } from 'hono';

export interface ConnectionUsedByReaderDeps {
  /**
   * Whether this caller receives the operator Agent catalog. A Project member
   * gets only admitted Agents from `GET /api/agents`, so it gets no used-by
   * listing, which names every Agent and Project that selects a connection.
   */
  receivesOperatorCatalog: (c: Context) => Promise<boolean>;
  /** The Agent catalog with each saved `execution` binding. */
  listAgents: () => Promise<
    ReadonlyArray<Omit<ConnectionUsedByAgentInput, 'tools'>>
  >;
  /** Saved Agent specs, for their tool servers (the catalog omits them). */
  readAgentSpecs: () => Promise<
    ReadonlyArray<{
      metadata: { slug: string };
      spec: { tools?: ConnectionUsedByAgentInput['tools'] };
    }>
  >;
  listProjects: () => ReadonlyArray<{ slug: string }>;
  /** Throws for a Project removed since it was listed. */
  getProject: (slug: string) => ConnectionUsedByProjectInput;
}

/** `GET /api/connections/used-by` for one caller. */
export function createConnectionUsedByReader(deps: ConnectionUsedByReaderDeps) {
  return async (c: Context): Promise<ConnectionUsedBy | 'withheld'> => {
    if (!(await deps.receivesOperatorCatalog(c))) return 'withheld';
    const [agents, specs] = await Promise.all([
      deps.listAgents(),
      deps.readAgentSpecs(),
    ]);
    const tools = new Map(
      specs.map(({ metadata, spec }) => [metadata.slug, spec.tools]),
    );
    const projects = deps.listProjects().flatMap(({ slug }) => {
      try {
        return [deps.getProject(slug)];
      } catch {
        return [];
      }
    });
    return projectConnectionUsedBy({
      agents: agents.map((agent) => ({
        ...agent,
        tools: tools.get(agent.slug),
      })),
      projects,
    });
  };
}
