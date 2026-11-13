/**
 * The two facts the Connections IA renders about a section — how many items
 * it holds, and whether it needs attention — derived ONCE (lane design P5;
 *).
 *
 * There used to be two attention derivations. The rail's
 * (`ConnectionsSectionFrame`) read the filtered model inventory, the agent
 * connections list, tool PROBE results and the knowledge status; the
 * `/connections` root resolver had its own, which read `/api/connections`
 * raw for both Models and Engines and ignored Knowledge entirely. So the
 * rail could show a warn dot on Knowledge while the resolver, asked which
 * section needs attention first, sent the user to Models. A redirect is a
 * claim about the same state the dots describe; two derivations of it will
 * disagree eventually, and here they already did.
 *
 * Counts have the same rule. `computers` comes from `useComputerRows`, the
 * list the Computers body itself renders, so the badge cannot count records
 * the body identity-folds into one row (or miss manual entries it shows).
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
import {
  CONNECTION_SECTIONS,
  type ConnectionSectionId,
} from './connection-sections';
import { useComputerRows } from './useComputerRows';

interface ConnectionSectionSignals {
  count: (id: ConnectionSectionId) => number;
  needsAttention: (id: ConnectionSectionId) => boolean;
  /** The section `/connections` resolves to, or undefined when none needs it. */
  firstNeedingAttention: (typeof CONNECTION_SECTIONS)[number] | undefined;
  /**
   * Every read attention depends on has answered (data or error). Before
   * that, "nothing needs attention" only means "nothing has loaded yet".
   */
  settled: boolean;
}

export function useConnectionSectionSignals(): ConnectionSectionSignals {
  const modelsQuery = useModelConnectionsQuery();
  const enginesQuery = useEngineConnectionsQuery();
  const toolsQuery = useIntegrationsQuery();
  const knowledgeQuery = useGlobalKnowledgeStatusQuery();
  const { data: connections = [] } = modelsQuery;
  const { data: engines = [] } = enginesQuery;
  const { data: tools = [] } = toolsQuery;
  const { data: knowledge } = knowledgeQuery;
  const { rows: computers } = useComputerRows();
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

  const count = (id: ConnectionSectionId): number => {
    if (id === 'models') return models.length;
    if (id === 'engines') return engines.length;
    if (id === 'tools') return tools.length;
    if (id === 'knowledge')
      return (knowledge?.vectorDb ? 1 : 0) + (knowledge?.embedding ? 1 : 0);
    return computers.length;
  };

  const needsAttention = (id: ConnectionSectionId): boolean => {
    // A store with no embedding model is a resting state (semantic search
    // off), like an unconnected computer: the Knowledge page says so.
    if (id === 'knowledge') return Boolean(knowledge && !knowledge.vectorDb);
    // CI-R3: `connected` is "an agent session currently holds a client",
    // which is false for every tool server — including the built-ins — until
    // a turn runs, so deriving attention from it put a warn dot on a healthy
    // section forever. A probe that FAILED is the observation that means
    // attention; never-probed is not a failure.
    if (id === 'tools')
      return tools.some((item) => item.probe && !item.probe.ok);
    // Computers claims nothing: this client holds no liveness evidence for a
    // paired device or a manual entry, and an SSH profile's phase is "not
    // connected" for every computer nobody has connected yet — which is a
    // resting state, not a problem to fix.
    if (id === 'computers') return false;
    // The same verdict its list row shows, and its own attention rule
    // (`ConnectionHealth.needsAttention`): an engine marks whenever it is not
    // dispatchable, including under managed policy; a model connection only
    // for something the reader must fix. Engines the list does not show
    // (supported, never added) claim nothing here either.
    if (id === 'models')
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

  return {
    count,
    needsAttention,
    // `isLoading` is a first fetch in flight. A disabled read (no Station
    // to ask) is pending but not loading, and must not hold the redirect
    // forever. Computers claims no attention, so its read is not waited on;
    // the ACP reads behind managed policy are not waited on either, and the
    // resolver's own time bound covers a slow one.
    settled: [modelsQuery, enginesQuery, toolsQuery, knowledgeQuery].every(
      (query) => !query.isLoading,
    ),
    firstNeedingAttention: CONNECTION_SECTIONS.find((section) =>
      needsAttention(section.id),
    ),
  };
}
