import type { AgentConnectionView } from '@kontourai/station-contracts/tool';
import type { ReactNode } from 'react';
import { FactList } from '../../components/resource-hub/FactList';
import { UsedByList } from '../../components/resource-hub/UsedByList';
import type { AgentSummary } from '../../types';
import { runtimeCatalogVisibleModels } from '../../utils/execution';
import { engineCatalogSourceLabel } from './EngineModelsTab';
import { engineRouteFact, lastCheckFact } from './engine-facts';
import './engine-detail.css';

/**
 * Can I use it, where does it send work, and what depends on it. The verdict
 * and its one fix are in the header above; this states the facts behind it
 * once each.
 */
export function EngineOverviewTab({
  connection,
  defaultModel,
  managedFact,
  dependents,
  onOpenAgent,
  notices,
}: {
  connection: AgentConnectionView;
  /** The saved default (the draft's, when unsaved, is on Models). */
  defaultModel: string;
  managedFact: string | null;
  /** Agents bound to this engine connection. */
  dependents: readonly AgentSummary[];
  onOpenAgent: (slug: string) => void;
  /** Readiness instructions, sign-in and policy notices, when they apply. */
  notices?: ReactNode;
}) {
  const models = runtimeCatalogVisibleModels(connection);
  const route = engineRouteFact(connection.routeObservation);
  const defaultName =
    models.find((model) => model.id === defaultModel)?.name ?? defaultModel;
  return (
    <>
      {notices}
      <FactList
        label="Engine facts"
        facts={[
          route !== null && {
            label: 'Route',
            value: route.note ? (
              <>
                {route.value}
                <small className="engine-overview__note">{route.note}</small>
              </>
            ) : (
              route.value
            ),
          },
          {
            label: 'Default model',
            value: defaultName || 'Engine chooses',
          },
          {
            label: 'Model catalog',
            value: engineCatalogSourceLabel(connection),
          },
          managedFact !== null && { label: 'Policy', value: managedFact },
          { label: 'Last check', value: lastCheckFact(connection) },
        ]}
      />
      <UsedByList
        state={{
          kind: 'ready',
          entries: dependents.map((agent) => ({
            key: agent.slug,
            name: agent.name,
            onOpen: () => onOpenAgent(agent.slug),
          })),
        }}
        emptyDescription="Agents that choose this engine appear here."
      />
    </>
  );
}
