import { isStationAgentIdentity } from '@kontourai/station-contracts/agent-identity';
import {
  type ConnectionUsedBy,
  type ConnectionUsedByAgentInput,
  type ConnectionUsedByProjectInput,
  projectConnectionUsedBy,
} from '@kontourai/station-contracts/connection-used-by';
import type { Context } from 'hono';
import { withoutReservedStationBinding } from '../../domain/agent-registry.js';
import type { AgentAudienceGateDeps } from '../../runtime/bootstrap/agent-audience-gate.js';

export interface ConnectionUsedByReaderDeps {
  /**
   * Who the request acts for: the same caller decision `GET /api/agents`
   * makes. Only the operator gets the listing, which names every Agent and
   * Project that selects a connection; a Project member gets only admitted
   * Agents from the catalog, so it gets no used-by listing.
   */
  audience: Pick<AgentAudienceGateDeps, 'caller'>;
  /**
   * The stored Agent definitions, read once. Not the Agent service listing,
   * which adds registry default Agents and the Station Agent's per-boot
   * engine binding: neither is saved configuration.
   */
  readAgentDefinitions: () => Promise<
    ReadonlyArray<{
      metadata: Omit<ConnectionUsedByAgentInput, 'tools'>;
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
    if ((await deps.audience.caller(c)).kind !== 'operator') return 'withheld';
    const definitions = await deps.readAgentDefinitions();
    const projects = deps.listProjects().flatMap(({ slug }) => {
      try {
        return [deps.getProject(slug)];
      } catch {
        return [];
      }
    });
    return projectConnectionUsedBy({
      agents: definitions.map(({ metadata, spec }) => ({
        // The Station Agent's stored engine id is reserved: the engine it runs
        // on is resolved each boot, so its file names no engine connection.
        ...(isStationAgentIdentity(metadata.slug)
          ? withoutReservedStationBinding(metadata)
          : metadata),
        tools: spec.tools,
      })),
      projects,
    });
  };
}
