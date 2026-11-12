/**
 * What the Connections IA says about each section — how many items it holds,
 * and which of them need attention — derived ONCE (lane design P5).
 *
 * There used to be two attention derivations. The rail's
 * (`ConnectionsSectionFrame`) read the filtered model inventory, the agent
 * connections list, tool PROBE results and the knowledge status; the old
 * `/connections` resolver had its own, which read `/api/connections` raw for
 * both Models and Engines and ignored Knowledge entirely, so the two
 * disagreed. The rail's marks, the Overview's section tiles and its
 * attention list now all read the `attention` entries below.
 *
 * Counts have the same rule. `computers` comes from `useComputerRows`, the
 * list the Computers body itself renders, so the badge cannot count records
 * the body identity-folds into one row (or miss manual entries it shows).
 */

import type { AgentConnectionView } from '@kontourai/station-contracts/tool';
import {
  useEngineConnectionsQuery,
  useGlobalKnowledgeStatusQuery,
  useIntegrationsQuery,
  useModelConnectionsQuery,
} from '@kontourai/station-sdk';
import { getPathForView } from '../../app-shell/routing';
import { connectionVerdictTone } from '../../components/kontour/station-tones';
import type { ResourceStatus } from '../../components/resource-hub/resource-status';
import { useManagedEngineStateFor } from '../../hooks/useManagedEngines';
import type { ProviderConnection } from '../provider-settings/types';
import {
  describeProvider,
  filterModelProviders,
} from '../provider-settings/utils';
import {
  type ConnectionHealth,
  deriveConnectionHealth,
  engineHealthInput,
  modelHealthInput,
} from './connection-health';
import type { ConnectionSectionId } from './connection-sections';
import { useComputerRows } from './useComputerRows';

/**
 * One connection the reader can fix, in the words its own page uses. The
 * rail's marks and the Overview's attention list are both read from these,
 * so a section is marked exactly when it lists something here.
 */
export interface ConnectionAttention {
  /** Unique across sections: `<section>:<connection id>`. */
  id: string;
  section: ConnectionSectionId;
  title: string;
  status: ResourceStatus;
  sentence: string;
  /** The fix the status names, performed on the page at `path`. */
  action?: { label: string; path: string };
}

interface ConnectionSectionSignals {
  count: (id: ConnectionSectionId) => number;
  needsAttention: (id: ConnectionSectionId) => boolean;
  /** Every connection needing attention, in section order. */
  attention: ConnectionAttention[];
  /**
   * Every read attention depends on has answered (data or error). Before
   * that, "nothing needs attention" only means "nothing has loaded yet".
   */
  settled: boolean;
  /** Sections whose read failed: their count and attention are unknown. */
  unread: ConnectionSectionId[];
  /** Fetches the failed reads again. */
  retry: () => void;
}

/** Claude Code and Codex sign in on their Accounts tab; others on Overview. */
function enginePath(engine: AgentConnectionView, health: ConnectionHealth) {
  const accounts =
    health.action?.id === 'sign-in' &&
    (engine.type === 'claude' || engine.type === 'codex');
  return getPathForView({
    type: 'connections-engine-edit',
    id: engine.id,
    ...(accounts ? { tab: 'accounts' as const } : {}),
  })!;
}

function healthAttention(
  section: 'models' | 'engines',
  id: string,
  title: string,
  health: ConnectionHealth,
  path: string,
): ConnectionAttention {
  return {
    id: `${section}:${id}`,
    section,
    title,
    status: { label: health.label, tone: health.tone },
    sentence: health.reason ?? '',
    ...(health.action ? { action: { label: health.action.label, path } } : {}),
  };
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

  // Engines the list does not show (supported, never added) claim nothing.
  const listedEngines = engines.filter(
    (engine) => engine.setup?.state !== 'available',
  );
  const attention: ConnectionAttention[] = [
    // The same verdict its list row shows, and its own attention rule
    // (`ConnectionHealth.needsAttention`): an engine whenever it is not
    // dispatchable, except under managed policy; a model connection only
    // for something the reader must fix.
    ...models.flatMap((item) => {
      const health = deriveConnectionHealth(modelHealthInput(item));
      return health.needsAttention
        ? [
            healthAttention(
              'models',
              item.id,
              describeProvider(item).name,
              health,
              getPathForView({ type: 'connections-model-edit', id: item.id })!,
            ),
          ]
        : [];
    }),
    ...listedEngines.flatMap((engine) => {
      const health = deriveConnectionHealth(engineHealthInput(engine), {
        policyDisallowed: managedStateFor(engine)?.disallowed === true,
      });
      return health.needsAttention
        ? [
            healthAttention(
              'engines',
              engine.id,
              engine.name,
              health,
              enginePath(engine, health),
            ),
          ]
        : [];
    }),
    // CI-R3: `connected` is "an agent session currently holds a client",
    // which is false for every tool server — including the built-ins — until
    // a turn runs, so deriving attention from it put a warn dot on a healthy
    // section forever. A probe that FAILED is the observation that means
    // attention; never-probed is not a failure.
    ...tools.flatMap((tool) =>
      tool.probe && !tool.probe.ok
        ? [
            {
              id: `tools:${tool.id}`,
              section: 'tools' as const,
              title: tool.displayName || tool.id,
              status: {
                label: 'Check failed',
                tone: connectionVerdictTone('failing'),
              },
              sentence: tool.probe.error || 'The last check failed.',
              action: {
                label: 'Details',
                path: getPathForView({
                  type: 'connections-tool-edit',
                  id: tool.id,
                })!,
              },
            },
          ]
        : [],
    ),
    // A store with no embedding model is a resting state (semantic search
    // off), like an unconnected computer: the Knowledge page says so. No
    // store at all is not.
    ...(knowledge && !knowledge.vectorDb
      ? [
          {
            id: 'knowledge:vector-store',
            section: 'knowledge' as const,
            title: 'Knowledge store',
            status: {
              label: 'Setup required',
              tone: connectionVerdictTone('setup'),
            },
            sentence: 'No vector store is set up.',
            action: { label: 'Set up', path: '/connections/knowledge' },
          },
        ]
      : []),
    // Computers claims nothing: this client holds no liveness evidence for
    // a paired device or a manual entry, and an SSH profile's phase is "not
    // connected" for every computer nobody has connected yet — which is a
    // resting state, not a problem to fix.
  ];

  const needsAttention = (id: ConnectionSectionId): boolean =>
    attention.some((item) => item.section === id);

  const reads = {
    models: modelsQuery,
    engines: enginesQuery,
    tools: toolsQuery,
    knowledge: knowledgeQuery,
  } as const;
  const unread = (Object.keys(reads) as Array<keyof typeof reads>).filter(
    (id) => reads[id].isError,
  );

  return {
    count,
    needsAttention,
    attention,
    // `isLoading` is a first fetch in flight. A disabled read (no Station
    // to ask) is pending but not loading, and must not hold the page's
    // loading state forever. Computers claims no attention, so its read is
    // not waited on; nor are the ACP reads behind managed policy.
    settled: Object.values(reads).every((query) => !query.isLoading),
    unread,
    retry: () => {
      for (const id of unread) void reads[id].refetch();
    },
  };
}
