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
  useAgentConnectionsQuery,
  useGlobalKnowledgeStatusQuery,
  useIntegrationsQuery,
  useModelConnectionsQuery,
} from '@kontourai/station-sdk';
import type { ProviderConnection } from '../provider-settings/types';
import { filterModelProviders } from '../provider-settings/utils';
import {
  CONNECTION_SECTIONS,
  type ConnectionSectionId,
} from './connection-sections';
import { useComputerRows } from './useComputerRows';

export interface ConnectionSectionSignals {
  count: (id: ConnectionSectionId) => number;
  needsAttention: (id: ConnectionSectionId) => boolean;
/** The section `/connections` resolves to, or undefined when none needs it. */
  firstNeedingAttention: (typeof CONNECTION_SECTIONS)[number] | undefined;
}

export function useConnectionSectionSignals(): ConnectionSectionSignals {
  const { data: connections = [] } = useModelConnectionsQuery();
  const { data: engines = [] } = useAgentConnectionsQuery();
  const { data: tools = [] } = useIntegrationsQuery();
  const { data: knowledge } = useGlobalKnowledgeStatusQuery();
  const { rows: computers } = useComputerRows();

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
    if (id === 'knowledge') return Boolean(knowledge && !knowledge.vectorDb);
// `connected` is "an agent session currently holds a client",
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
    const list = id === 'models' ? models : engines;
    return list.some(
      (item) => !item.enabled || item.status === 'missing_prerequisites',
    );
  };

  return {
    count,
    needsAttention,
    firstNeedingAttention: CONNECTION_SECTIONS.find((section) =>
      needsAttention(section.id),
    ),
  };
}
