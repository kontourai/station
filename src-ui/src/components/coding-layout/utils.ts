import type { ACPConnectionInfo } from '../../hooks/useACPConnections';

interface NewTerminalItem {
  key: string;
  type: 'shell' | 'agent' | 'script';
  label: string;
  hint: string;
  slug?: string;
  connectionId?: string;
  section?: 'recent' | 'scripts';
}

export function buildNewTerminalItems(
  connections: ACPConnectionInfo[],
  filter: string,
  recentAgentSlugs: string[],
  /** The Project's package scripts, run by name as command sessions. */
  scripts: readonly { name: string; command: string }[] = [],
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

  for (const script of scripts) {
    if (
      !script.name.toLowerCase().includes(normalizedFilter) &&
      !script.command.toLowerCase().includes(normalizedFilter)
    )
      continue;
    items.push({
      key: `script-${script.name}`,
      type: 'script',
      label: script.name,
      hint: script.command,
      slug: script.name,
      section: 'scripts',
    });
  }

  return items;
}
