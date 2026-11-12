import type { AgentConnectionView } from '@kontourai/station-contracts/tool';
import type { ReactNode } from 'react';
import { Button } from '../../components/Button';
import { FactList } from '../../components/resource-hub/FactList';
import { Empty } from '../../components/state';
import type { AgentSummary } from '../../types';
import { runtimeCatalogVisibleModels } from '../../utils/execution';
import { engineCatalogSourceLabel } from './EngineModelsTab';
import { allowanceFacts, engineRouteFact, lastCheckFact } from './engine-facts';
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
  headerShowsUsageLimit,
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
  /**
   * The header reads "Usage limit reached" (and so states the current
   * account's reset); false when another status outranks it.
   */
  headerShowsUsageLimit: boolean;
}) {
  const models = runtimeCatalogVisibleModels(connection);
  const route = engineRouteFact(connection.routeObservation);
  const refusals = allowanceFacts(connection, { headerShowsUsageLimit });
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
          refusals.length > 0 && {
            label: 'Usage limit',
            value: (
              <ul className="engine-overview__refusals">
                {/* Two withheld accounts can read alike, so lines key by
                    position; the list is rebuilt whole on each read. */}
                {refusals.map((line, index) => (
                  <li key={index}>{line}</li>
                ))}
              </ul>
            ),
          },
          { label: 'Last check', value: lastCheckFact(connection) },
        ]}
      />
      <section className="engine-overview__dependents" aria-label="Used by">
        <h3>Used by</h3>
        {dependents.length === 0 ? (
          <Empty
            variant="compact"
            label="Not used by any agent yet"
            description="Agents that choose this engine appear here."
          />
        ) : (
          <ul>
            {dependents.map((agent) => (
              <li key={agent.slug}>
                <Button variant="link" onClick={() => onOpenAgent(agent.slug)}>
                  {agent.name}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
