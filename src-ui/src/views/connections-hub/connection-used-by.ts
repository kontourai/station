import {
  type ConnectionDependent,
  type ConnectionDependentVia,
  type ConnectionUsedBy,
  dependentsOfConnection,
} from '@kontourai/station-contracts/connection-used-by';
import { ConnectionUsedByWithheldError } from '@kontourai/station-sdk';
import type { UsedByState } from '../../components/resource-hub/UsedByList';
import type { NavigationView } from '../../types';

const VIA_DETAIL: Record<ConnectionDependentVia, string> = {
  engine: 'Agent',
  model: 'Agent',
  'tool-server': 'Agent',
  'project-default-model': 'Project · chat default',
  'project-embedding': 'Project · embeddings',
  'project-tools': 'Project · tool defaults',
};

/** Where a dependent opens. */
export function dependentView(dependent: ConnectionDependent): NavigationView {
  return dependent.kind === 'agent'
    ? { type: 'agent-edit', slug: dependent.slug }
    : { type: 'project-edit', slug: dependent.slug };
}

/**
 * The used-by list for one connection from the used-by read, named by the
 * explicit bindings the server projected, never by slug or name.
 */
export function connectionUsedByState(
  query: {
    data?: ConnectionUsedBy;
    error: unknown;
    isError: boolean;
    refetch: () => unknown;
  },
  connectionId: string,
  onNavigate: (view: NavigationView) => void,
): UsedByState {
  if (query.isError)
    return query.error instanceof ConnectionUsedByWithheldError
      ? { kind: 'withheld' }
      : { kind: 'error', onRetry: () => void query.refetch() };
  if (!query.data) return { kind: 'loading' };
  return {
    kind: 'ready',
    entries: dependentsOfConnection(query.data, connectionId).map(
      (dependent) => ({
        key: `${dependent.kind}:${dependent.slug}:${dependent.via}`,
        name: dependent.name,
        detail: VIA_DETAIL[dependent.via],
        onOpen: () => onNavigate(dependentView(dependent)),
      }),
    ),
  };
}

/**
 * How many distinct Agents and Projects name a connection, for a row fact;
 * `null` while unknown (loading, failed or withheld), so no row claims zero.
 */
export function connectionDependentCount(
  usedBy: ConnectionUsedBy | undefined,
  connectionId: string,
): number | null {
  if (!usedBy) return null;
  return new Set(
    dependentsOfConnection(usedBy, connectionId).map(
      (dependent) => `${dependent.kind}:${dependent.slug}`,
    ),
  ).size;
}
