/**
 * The two facts the Customize list renders about each connection-backed item
 * — how many things it holds, and whether it needs attention — derived ONCE
 * (lane design P5).
 *
 * There used to be two attention derivations: the old section rail's, and
 * the retired `/connections` resolver's, which read `/api/connections` raw
 * and ignored Knowledge entirely. So the rail could show a warn dot on
 * Knowledge while the resolver sent the user to Models. Anything that says
 * which item needs attention asks this one derivation.
 */

import {
  useEngineConnectionsQuery,
  useGlobalKnowledgeStatusQuery,
  useIntegrationsQuery,
  useModelConnectionsQuery,
} from '@kontourai/station-sdk';
import { useManagedEngineStateFor } from '../../hooks/useManagedEngines';
import type { ProviderConnection } from '../provider-settings/types';
import { filterModelProviders } from '../provider-settings/utils';
import {
  deriveConnectionHealth,
  engineHealthInput,
  modelHealthInput,
} from './connection-health';
import type { ConnectionSectionId } from './connection-sections';

interface ConnectionSectionSignals {
  /** Null where a number would not mean anything to a reader. */
  count: (id: ConnectionSectionId) => number | null;
  needsAttention: (id: ConnectionSectionId) => boolean;
}

export function useConnectionSectionSignals(): ConnectionSectionSignals {
  const { data: connections = [] } = useModelConnectionsQuery();
  const enginesQuery = useEngineConnectionsQuery();
  const toolsQuery = useIntegrationsQuery();
  const engines = enginesQuery.data ?? [];
  const tools = toolsQuery.data ?? [];
  const { data: knowledge } = useGlobalKnowledgeStatusQuery();
  const managedStateFor = useManagedEngineStateFor();

  /**
   * Live capture caught both halves of getting the counts wrong: "Models 1"
   * beside a Models section reading "No model connections yet" (the count
   * included the built-in vector store, which the Models list filters out
   * because it is neither an LLM nor an embedding provider), and "Engines 0"
   * beside a list of three engines (the count read `/api/connections`, the
   * list reads `/api/connections/agents`).
   *
   * archive#3747 closes the first half at its root: the count now reads the
   * SAME route the Models list reads (`/api/connections/models`, LLM-capable
   * by contract) instead of reading the full projection and re-deriving
   * membership with a client-side filter. `filterModelProviders` with an empty
   * search is now a no-op pass-through; it is left in place because it is the
   * one place the Models list's ORDERING and search live, and a count derived
   * from a different expression than the list is what produced this bug the
   * first time.
   */
  const models = filterModelProviders(connections as ProviderConnection[], '');

  // A count is a claim about a list, so it needs the list: while a read is
  // pending, or after it failed with nothing to show, there is no number.
  const count = (id: ConnectionSectionId): number | null => {
    if (id === 'engines') return enginesQuery.data ? engines.length : null;
    if (id === 'tools') return toolsQuery.data ? tools.length : null;
    // Providers counts model connections today, which read as "0 providers"
    // beside signed-in engines; it gets a number when the Providers slices
    // define what one is. Knowledge holds one store and one search model,
    // not a list: "2" beside it counted settings.
    return null;
  };

  const needsAttention = (id: ConnectionSectionId): boolean => {
    // A store with no embedding model is a resting state (semantic search
    // off): the Knowledge page says so.
    if (id === 'knowledge') return Boolean(knowledge && !knowledge.vectorDb);
    // CI-R3: `connected` is "an agent session currently holds a client",
    // which is false for every tool server — including the built-ins — until
    // a turn runs, so deriving attention from it put a warn dot on a healthy
    // section forever. A probe that FAILED is the observation that means
    // attention; never-probed is not a failure.
    if (id === 'tools')
      return tools.some((item) => item.probe && !item.probe.ok);
    // The same verdict its list row shows, and its own attention rule
    // (`ConnectionHealth.needsAttention`): an engine marks whenever it is not
    // dispatchable, including under managed policy; a model connection only
    // for something the reader must fix. Engines the list does not show
    // (supported, never added) claim nothing here either.
    if (id === 'providers')
      return models.some(
        (item) => deriveConnectionHealth(modelHealthInput(item)).needsAttention,
      );
    return engines
      .filter((engine) => engine.setup?.state !== 'available')
      .some(
        (engine) =>
          deriveConnectionHealth(engineHealthInput(engine), {
            policyDisallowed: managedStateFor(engine)?.disallowed === true,
          }).needsAttention,
      );
  };

  return { count, needsAttention };
}
