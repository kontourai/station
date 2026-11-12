import { useConnectionUsedByQuery } from '@kontourai/station-sdk';
import { FactList } from '../../components/resource-hub/FactList';
import { UsedByList } from '../../components/resource-hub/UsedByList';
import type { NavigationView } from '../../types';
import { modelProviderDisplayLabel } from '../../utils/modelProviderDisplay';
import { connectionUsedByState } from '../connections-hub/connection-used-by';
import type { ProviderConnection } from '../provider-settings/types';

const CAPABILITY_LABEL: Record<string, string> = {
  llm: 'Chat',
  embedding: 'Embeddings',
};

/**
 * What the connection is and what depends on it. Its status, reason and one
 * fix are in the header above; this states the facts behind them once.
 */
export function ModelOverviewTab({
  connection,
  onNavigate,
}: {
  /** The saved connection, not the unsaved draft. */
  connection: ProviderConnection;
  onNavigate: (view: NavigationView) => void;
}) {
  const usedBy = useConnectionUsedByQuery({ staleTime: 30_000, retry: false });
  const models = Array.isArray(connection.config.modelOptions)
    ? connection.config.modelOptions.length
    : 0;
  const defaultModel =
    typeof connection.config.defaultModel === 'string'
      ? connection.config.defaultModel
      : '';
  const uses = connection.capabilities
    .map((capability) => CAPABILITY_LABEL[capability])
    .filter(Boolean)
    .join(', ');
  return (
    <>
      <FactList
        label="Model connection facts"
        facts={[
          {
            label: 'Service',
            value: modelProviderDisplayLabel(connection.type),
          },
          uses ? { label: 'Used for', value: uses } : false,
          { label: 'Default model', value: defaultModel || 'Not set' },
          {
            label: 'Models listed',
            value: models > 0 ? String(models) : 'Not loaded',
          },
          {
            label: 'Last check',
            value: connection.lastCheckedAt
              ? new Date(connection.lastCheckedAt).toLocaleString(undefined, {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })
              : 'Not checked yet',
          },
        ]}
      />
      <UsedByList
        state={connectionUsedByState(usedBy, connection.id, onNavigate)}
        emptyDescription="Agents and Projects that choose this connection appear here."
      />
    </>
  );
}
