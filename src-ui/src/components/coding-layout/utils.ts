import type { ACPConnectionInfo } from '../../hooks/useACPConnections';

export interface NewTerminalItem {
  key: string;
  type: 'shell' | 'agent';
  label: string;
  hint: string;
  slug?: string;
  connectionId?: string;
  section?: 'recent';
}

export function buildNewTerminalItems(
  connections: ACPConnectionInfo[],
  filter: string,
  recentAgentSlugs: string[],
): NewTerminalItem[] {
  const connectedAgents = connections
    .filter((connection) => connection.status === 'available')
    .flatMap((connection) =>
      connection.modes.map((mode) => ({
        id: `${connection.id}-${mode}`,
        label: mode,
        connection: connection.name || connection.id,
        connectionId: connection.id,
        slug: `${connection.id}-${mode}`,
      })),
    );

  const normalizedFilter = filter.toLowerCase();
  const recentSlugs = new Set(recentAgentSlugs);
  const items: NewTerminalItem[] = [];

  if (!filter || 'shell'.includes(normalizedFilter)) {
    items.push({
      key: 'shell',
      type: 'shell',
      label: 'Shell',
      hint: 'Default terminal',
    });
  }

  if (!filter) {
    for (const agent of connectedAgents) {
      if (recentSlugs.has(agent.slug)) {
        items.push({
          key: `recent-${agent.id}`,
          type: 'agent',
          label: agent.label,
          hint: `${agent.connection} · Recent`,
          slug: agent.slug,
          connectionId: agent.connectionId,
          section: 'recent',
        });
      }
    }
  }

  for (const agent of connectedAgents) {
    if (
      !agent.label.toLowerCase().includes(normalizedFilter) &&
      !agent.connection.toLowerCase().includes(normalizedFilter)
    ) {
      continue;
    }
    if (!filter && recentSlugs.has(agent.slug)) {
      continue;
    }
    items.push({
      key: agent.id,
      type: 'agent',
      label: agent.label,
      hint: agent.connection,
      slug: agent.slug,
      connectionId: agent.connectionId,
    });
  }

  return items;
}
